mod adsb;
mod globe_history;
mod import;
mod store;

use std::{path::PathBuf, time::Duration};

use anyhow::Context;
use chrono::{TimeDelta, Utc};
use sqlx::postgres::PgPoolOptions;
use tokio::time::MissedTickBehavior;
use tracing_subscriber::EnvFilter;

/// Seattle-Tacoma International Airport.
const CENTER_LAT: f64 = 47.4502;
const CENTER_LON: f64 = -122.3088;
const RADIUS_NM: u32 = 50;
const POLL_INTERVAL: Duration = Duration::from_secs(10);
/// How long positions are kept.
const RETENTION: TimeDelta = TimeDelta::days(1);
const PRUNE_INTERVAL: Duration = Duration::from_secs(60);

const USAGE: &str = "usage: ingest [import <globe history dir>]";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let import_dir = match std::env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [] => None,
        [command, dir] if command == "import" => Some(PathBuf::from(dir)),
        _ => anyhow::bail!(USAGE),
    };

    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL must be set")?;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&database_url)
        .await
        .context("connecting to the database")?;
    sqlx::migrate!("../migrations")
        .run(&pool)
        .await
        .context("running migrations")?;

    if let Some(dir) = import_dir {
        let area = import::Area {
            lat: CENTER_LAT,
            lon: CENTER_LON,
            radius_nm: RADIUS_NM.into(),
        };
        return import::run(&pool, &dir, area).await;
    }

    let client = adsb::Client::new()?;
    tokio::select! {
        () = poll(&client, &pool) => {},
        () = prune(&pool) => {},
        result = tokio::signal::ctrl_c() => result?,
    }
    tracing::info!("shutting down");
    Ok(())
}

/// Fetches and stores positions every `POLL_INTERVAL`. Failures are logged
/// and retried on the next tick.
async fn poll(client: &adsb::Client, pool: &sqlx::PgPool) {
    let mut interval = tokio::time::interval(POLL_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let snapshot = match client.point(CENTER_LAT, CENTER_LON, RADIUS_NM).await {
            Ok(snapshot) => snapshot,
            Err(err) => {
                tracing::warn!("fetching aircraft: {err:#}");
                continue;
            }
        };
        let aircraft = snapshot.aircraft.len();
        match store::insert_positions(pool, snapshot.into_positions()).await {
            Ok(inserted) => tracing::info!(aircraft, inserted, "stored positions"),
            Err(err) => tracing::error!("storing positions: {err:#}"),
        }
    }
}

/// Deletes positions older than `RETENTION` every `PRUNE_INTERVAL`.
async fn prune(pool: &sqlx::PgPool) {
    let mut interval = tokio::time::interval(PRUNE_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        match store::delete_positions_before(pool, Utc::now() - RETENTION).await {
            Ok(0) => {}
            Ok(deleted) => tracing::info!(deleted, "pruned positions"),
            Err(err) => tracing::error!("pruning positions: {err:#}"),
        }
    }
}
