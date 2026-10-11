//! Loads a day of adsb.lol globe history into `aircraft_positions`.

use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
    thread,
};

use anyhow::Context;
use sqlx::PgPool;
use tokio::{sync::mpsc, task::JoinSet};

use crate::{globe_history, store};

/// Rows per `INSERT`.
const BATCH_SIZE: usize = 5_000;
/// Inserts in flight at once. Each holds a pool connection.
const MAX_CONCURRENT_INSERTS: usize = 2;
/// Threads parsing trace files. Inserting is the bottleneck, so more don't
/// help, and each holds a whole file's positions in memory.
const PARSE_WORKERS: usize = 2;

/// Mean Earth radius in nautical miles.
const EARTH_RADIUS_NM: f64 = 3440.065;

/// A circle on the Earth's surface.
#[derive(Clone, Copy)]
pub struct Area {
    pub lat: f64,
    pub lon: f64,
    pub radius_nm: f64,
}

impl Area {
    /// Whether the great-circle distance to the center is within the radius.
    fn contains(self, lat: f64, lon: f64) -> bool {
        let (lat1, lat2) = (self.lat.to_radians(), lat.to_radians());
        let half_dlat = (lat2 - lat1) / 2.0;
        let half_dlon = (lon - self.lon).to_radians() / 2.0;
        let a = half_dlat.sin().powi(2) + lat1.cos() * lat2.cos() * half_dlon.sin().powi(2);
        2.0 * EARTH_RADIUS_NM * a.sqrt().asin() <= self.radius_nm
    }
}

/// Inserts every position in `dir/traces` that is inside `area`. Unreadable
/// files are logged and skipped.
pub async fn run(pool: &PgPool, dir: &Path, area: Area) -> anyhow::Result<()> {
    let paths = trace_paths(&dir.join("traces"))?;
    let file_count = paths.len();
    tracing::info!(files = file_count, "importing traces");

    // Parsed files wait here for the inserter. A busy aircraft's day is tens
    // of thousands of positions, so this is kept short to bound memory.
    let (sender, mut receiver) = mpsc::channel(PARSE_WORKERS);
    let reader = tokio::task::spawn_blocking(move || read_all(&paths, area, &sender));

    let mut inserts = JoinSet::new();
    let mut batch = Vec::with_capacity(BATCH_SIZE);
    let mut inserted = 0;
    let mut read = 0;
    while let Some(positions) = receiver.recv().await {
        read += 1;
        if read % 1000 == 0 {
            tracing::info!(read, files = file_count, "importing traces");
        }
        batch.extend(positions);
        if batch.len() < BATCH_SIZE {
            continue;
        }
        if inserts.len() >= MAX_CONCURRENT_INSERTS {
            inserted += join_next(&mut inserts).await?;
        }
        let pool = pool.clone();
        let full = std::mem::replace(&mut batch, Vec::with_capacity(BATCH_SIZE));
        inserts.spawn(async move { store::insert_positions(&pool, full).await });
    }
    inserted += store::insert_positions(pool, batch).await?;
    while !inserts.is_empty() {
        inserted += join_next(&mut inserts).await?;
    }
    let failed = reader.await?;
    tracing::info!(read, failed, inserted, "imported traces");
    Ok(())
}

async fn join_next(inserts: &mut JoinSet<sqlx::Result<u64>>) -> anyhow::Result<u64> {
    let result = inserts.join_next().await.expect("checked non-empty")?;
    result.context("inserting positions")
}

/// Every `trace_full_*.json` file under `dir`, sorted.
fn trace_paths(dir: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut pending = vec![dir.to_owned()];
    while let Some(dir) = pending.pop() {
        for entry in
            std::fs::read_dir(&dir).with_context(|| format!("reading {}", dir.display()))?
        {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                pending.push(path);
            } else if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("trace_full_") && name.ends_with(".json"))
            {
                paths.push(path);
            }
        }
    }
    paths.sort();
    Ok(paths)
}

/// Reads `paths` on `PARSE_WORKERS` threads and sends each file's positions
/// inside `area`. Returns the number of files that couldn't be read.
fn read_all(paths: &[PathBuf], area: Area, sender: &mpsc::Sender<Vec<store::Position>>) -> usize {
    let next = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    thread::scope(|scope| {
        for _ in 0..PARSE_WORKERS {
            scope.spawn(|| {
                while let Some(path) = paths.get(next.fetch_add(1, Ordering::Relaxed)) {
                    match globe_history::read_trace(path) {
                        Ok(mut positions) => {
                            positions.retain(|p| area.contains(p.lat, p.lon));
                            if sender.blocking_send(positions).is_err() {
                                // The receiver stopped after an insert failed.
                                return;
                            }
                        }
                        Err(err) => {
                            tracing::warn!("skipping trace: {err:#}");
                            failed.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
            });
        }
    });
    failed.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn area_contains_points_within_radius() {
        let sea = Area {
            lat: 47.4502,
            lon: -122.3088,
            radius_nm: 50.0,
        };
        assert!(sea.contains(47.4502, -122.3088));
        // Downtown Seattle, about 7 nm north.
        assert!(sea.contains(47.6062, -122.3321));
        // 49.8 nm and 50.4 nm due north.
        assert!(sea.contains(48.28, -122.3088));
        assert!(!sea.contains(48.29, -122.3088));
        // Portland, about 110 nm south.
        assert!(!sea.contains(45.5152, -122.6784));
    }
}
