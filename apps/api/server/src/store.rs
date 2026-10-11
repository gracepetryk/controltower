use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;

/// A longitude/latitude box in degrees. `west > east` means the box crosses
/// the antimeridian.
pub struct BoundingBox {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

/// An aircraft and its positions, oldest first. The descriptive fields are
/// the most recent non-null values in the trace.
#[derive(Serialize)]
pub struct Aircraft {
    pub hex: String,
    pub flight: Option<String>,
    pub registration: Option<String>,
    pub aircraft_type: Option<String>,
    pub category: Option<String>,
    pub squawk: Option<String>,
    pub trace: Vec<TracePoint>,
}

/// One position report. Units match `aircraft_positions`: feet, knots,
/// degrees and feet per minute.
#[derive(Serialize)]
pub struct TracePoint {
    /// Milliseconds since the Unix epoch.
    pub observed_at: i64,
    pub lat: f64,
    pub lon: f64,
    pub on_ground: bool,
    pub alt_baro: Option<i32>,
    pub alt_geom: Option<i32>,
    pub ground_speed: Option<f32>,
    pub track: Option<f32>,
    pub true_heading: Option<f32>,
    pub baro_rate: Option<i32>,
    pub geom_rate: Option<i32>,
}

#[derive(sqlx::FromRow)]
struct PositionRow {
    hex: String,
    observed_at: DateTime<Utc>,
    flight: Option<String>,
    registration: Option<String>,
    aircraft_type: Option<String>,
    category: Option<String>,
    squawk: Option<String>,
    lat: f64,
    lon: f64,
    on_ground: bool,
    alt_baro: Option<i32>,
    alt_geom: Option<i32>,
    ground_speed: Option<f32>,
    track: Option<f32>,
    true_heading: Option<f32>,
    baro_rate: Option<i32>,
    geom_rate: Option<i32>,
}

/// Returns the aircraft whose latest position since `since` is inside
/// `area`, each with every position since `since`. Traces may extend outside
/// `area`.
pub async fn aircraft_in(
    pool: &PgPool,
    area: &BoundingBox,
    since: DateTime<Utc>,
) -> sqlx::Result<Vec<Aircraft>> {
    let rows: Vec<PositionRow> = sqlx::query_as(
        r#"
        WITH recent AS (
            SELECT
                hex, observed_at, flight, registration, aircraft_type, category, squawk,
                ST_Y(position::geometry) AS lat, ST_X(position::geometry) AS lon,
                on_ground, alt_baro, alt_geom, ground_speed, track, true_heading,
                baro_rate, geom_rate
            FROM aircraft_positions
            WHERE observed_at >= $5
        ),
        in_area AS (
            SELECT hex
            FROM (
                SELECT DISTINCT ON (hex) hex, lat, lon
                FROM recent
                ORDER BY hex, observed_at DESC
            ) latest
            WHERE lat BETWEEN $2::float8 AND $4::float8
              AND CASE
                  WHEN $1::float8 <= $3::float8 THEN lon BETWEEN $1 AND $3
                  ELSE lon >= $1 OR lon <= $3
              END
        )
        SELECT
            hex, observed_at, flight, registration, aircraft_type, category, squawk,
            lat, lon, on_ground, alt_baro, alt_geom, ground_speed, track, true_heading,
            baro_rate, geom_rate
        FROM recent
        JOIN in_area USING (hex)
        ORDER BY hex, observed_at
        "#,
    )
    .bind(area.west)
    .bind(area.south)
    .bind(area.east)
    .bind(area.north)
    .bind(since)
    .fetch_all(pool)
    .await?;
    Ok(group_by_aircraft(rows))
}

/// Groups rows sorted by `(hex, observed_at)` into one `Aircraft` per hex.
fn group_by_aircraft(rows: Vec<PositionRow>) -> Vec<Aircraft> {
    let mut aircraft: Vec<Aircraft> = Vec::new();
    for row in rows {
        let current = match aircraft.last_mut() {
            Some(last) if last.hex == row.hex => last,
            _ => {
                aircraft.push(Aircraft {
                    hex: row.hex,
                    flight: None,
                    registration: None,
                    aircraft_type: None,
                    category: None,
                    squawk: None,
                    trace: Vec::new(),
                });
                aircraft.last_mut().expect("just pushed")
            }
        };
        current.flight = row.flight.or(current.flight.take());
        current.registration = row.registration.or(current.registration.take());
        current.aircraft_type = row.aircraft_type.or(current.aircraft_type.take());
        current.category = row.category.or(current.category.take());
        current.squawk = row.squawk.or(current.squawk.take());
        current.trace.push(TracePoint {
            observed_at: row.observed_at.timestamp_millis(),
            lat: row.lat,
            lon: row.lon,
            on_ground: row.on_ground,
            alt_baro: row.alt_baro,
            alt_geom: row.alt_geom,
            ground_speed: row.ground_speed,
            track: row.track,
            true_heading: row.true_heading,
            baro_rate: row.baro_rate,
            geom_rate: row.geom_rate,
        });
    }
    aircraft
}
