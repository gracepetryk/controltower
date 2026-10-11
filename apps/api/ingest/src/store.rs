use sqlx::PgPool;

use crate::adsb::{BaroAltitude, Snapshot};

/// Inserts every aircraft in the snapshot that has a position, skipping
/// positions already stored. Returns the number of rows inserted.
pub async fn insert_positions(pool: &PgPool, snapshot: &Snapshot) -> sqlx::Result<u64> {
    let mut rows = Rows::default();
    for aircraft in &snapshot.aircraft {
        let (Some(lat), Some(lon), Some(observed_at)) =
            (aircraft.lat, aircraft.lon, aircraft.observed_at(snapshot.now))
        else {
            continue;
        };
        let on_ground = matches!(aircraft.alt_baro, Some(BaroAltitude::Ground));
        rows.observed_at.push(observed_at);
        rows.hex.push(aircraft.hex.clone());
        rows.flight.push(aircraft.callsign().map(str::to_owned));
        rows.registration.push(aircraft.registration.clone());
        rows.aircraft_type.push(aircraft.aircraft_type.clone());
        rows.category.push(aircraft.category.clone());
        rows.source.push(aircraft.source.clone());
        rows.lat.push(lat);
        rows.lon.push(lon);
        rows.on_ground.push(on_ground);
        rows.alt_baro.push(match aircraft.alt_baro {
            Some(BaroAltitude::Feet(feet)) => Some(feet),
            _ => None,
        });
        rows.alt_geom.push(aircraft.alt_geom);
        rows.ground_speed.push(aircraft.gs);
        rows.track.push(aircraft.track);
        rows.true_heading.push(aircraft.true_heading);
        rows.baro_rate.push(aircraft.baro_rate);
        rows.geom_rate.push(aircraft.geom_rate);
        rows.squawk.push(aircraft.squawk.clone());
    }
    if rows.hex.is_empty() {
        return Ok(0);
    }

    let result = sqlx::query(
        r#"
        INSERT INTO aircraft_positions (
            observed_at, hex, flight, registration, aircraft_type, category, source,
            position, on_ground, alt_baro, alt_geom, ground_speed, track, true_heading,
            baro_rate, geom_rate, squawk
        )
        SELECT
            observed_at, hex, flight, registration, aircraft_type, category, source,
            ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography, on_ground, alt_baro,
            alt_geom, ground_speed, track, true_heading, baro_rate, geom_rate, squawk
        FROM UNNEST(
            $1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
            $7::text[], $8::float8[], $9::float8[], $10::boolean[], $11::integer[],
            $12::integer[], $13::real[], $14::real[], $15::real[], $16::integer[],
            $17::integer[], $18::text[]
        ) AS rows (
            observed_at, hex, flight, registration, aircraft_type, category, source,
            lat, lon, on_ground, alt_baro, alt_geom, ground_speed, track, true_heading,
            baro_rate, geom_rate, squawk
        )
        ON CONFLICT (hex, observed_at) DO NOTHING
        "#,
    )
    .bind(rows.observed_at)
    .bind(rows.hex)
    .bind(rows.flight)
    .bind(rows.registration)
    .bind(rows.aircraft_type)
    .bind(rows.category)
    .bind(rows.source)
    .bind(rows.lat)
    .bind(rows.lon)
    .bind(rows.on_ground)
    .bind(rows.alt_baro)
    .bind(rows.alt_geom)
    .bind(rows.ground_speed)
    .bind(rows.track)
    .bind(rows.true_heading)
    .bind(rows.baro_rate)
    .bind(rows.geom_rate)
    .bind(rows.squawk)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Column-oriented rows, bound as one array per column.
#[derive(Default)]
struct Rows {
    observed_at: Vec<chrono::DateTime<chrono::Utc>>,
    hex: Vec<String>,
    flight: Vec<Option<String>>,
    registration: Vec<Option<String>>,
    aircraft_type: Vec<Option<String>>,
    category: Vec<Option<String>>,
    source: Vec<String>,
    lat: Vec<f64>,
    lon: Vec<f64>,
    on_ground: Vec<bool>,
    alt_baro: Vec<Option<i32>>,
    alt_geom: Vec<Option<i32>>,
    ground_speed: Vec<Option<f32>>,
    track: Vec<Option<f32>>,
    true_heading: Vec<Option<f32>>,
    baro_rate: Vec<Option<i32>>,
    geom_rate: Vec<Option<i32>>,
    squawk: Vec<Option<String>>,
}

/// Deletes positions observed before `cutoff`. Returns the number of rows
/// deleted.
pub async fn delete_positions_before(
    pool: &PgPool,
    cutoff: chrono::DateTime<chrono::Utc>,
) -> sqlx::Result<u64> {
    let result = sqlx::query("DELETE FROM aircraft_positions WHERE observed_at < $1")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}
