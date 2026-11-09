use chrono::{DateTime, Utc};
use schemars::JsonSchema;
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

impl BoundingBox {
    /// Degrees of longitude the box spans, in [0, 360].
    fn lng_span(&self) -> f64 {
        if self.west <= self.east {
            self.east - self.west
        } else {
            self.east - self.west + 360.0
        }
    }

    /// Lengths in meters of the south, north and west (or east) edges. The
    /// south and north edges follow their parallels.
    fn edge_lengths_meters(&self) -> [f64; 3] {
        let along_parallel =
            |lat: f64| self.lng_span() * METERS_PER_DEGREE * lat.to_radians().cos();
        [
            along_parallel(self.south),
            along_parallel(self.north),
            (self.north - self.south) * METERS_PER_DEGREE,
        ]
    }
}

/// Meters in a degree of latitude, and in a degree of longitude at the equator.
const METERS_PER_DEGREE: f64 = 111_320.0;

/// The longest edge of an area `aircraft_in` searches, about a metro area plus
/// its surroundings. Geography edges are great circles, which bow toward the
/// pole by a few km at this length.
pub const MAX_AREA_EDGE_METERS: f64 = 400_000.0;

pub enum AircraftInError {
    /// An edge of `area` is longer than `MAX_AREA_EDGE_METERS`.
    AreaTooLarge {
        longest_edge_meters: f64,
    },
    Database(sqlx::Error),
}

impl From<sqlx::Error> for AircraftInError {
    fn from(err: sqlx::Error) -> Self {
        Self::Database(err)
    }
}

/// An aircraft and its positions, oldest first. The descriptive fields are
/// the most recent non-null values in the trace.
#[derive(Serialize, JsonSchema)]
pub struct Aircraft {
    pub aircraft_address: String,
    pub flight: Option<String>,
    pub registration: Option<String>,
    pub aircraft_type: Option<String>,
    pub category: Option<String>,
    pub squawk: Option<String>,
    pub trace: Vec<TracePoint>,
}

/// One position report. Units match `aircraft_positions`: feet, knots,
/// degrees and feet per minute.
#[derive(Serialize, JsonSchema)]
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

struct PositionRow {
    aircraft_address: String,
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

/// Returns the positions in `[since, until]` inside `area`, grouped by
/// aircraft, oldest first.
pub async fn aircraft_in(
    pool: &PgPool,
    area: &BoundingBox,
    since: DateTime<Utc>,
    until: DateTime<Utc>,
) -> Result<Vec<Aircraft>, AircraftInError> {
    let longest_edge_meters = area.edge_lengths_meters().into_iter().fold(0.0, f64::max);
    if longest_edge_meters > MAX_AREA_EDGE_METERS {
        return Err(AircraftInError::AreaTooLarge {
            longest_edge_meters,
        });
    }
    let rows = sqlx::query_as!(
        PositionRow,
        r#"
        SELECT
            aircraft_address, observed_at, flight, registration, aircraft_type, category,
            squawk, ST_Y(position::geometry) AS "lat!", ST_X(position::geometry) AS "lon!",
            on_ground, alt_baro, alt_geom, ground_speed, track, true_heading,
            baro_rate, geom_rate
        FROM aircraft_positions
        WHERE observed_at BETWEEN $5 AND $6
          -- Geography edges take the shorter way around, so west > east
          -- crosses the antimeridian.
          AND ST_Intersects(position, ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography)
        ORDER BY aircraft_address, observed_at
        "#,
        area.west,
        area.south,
        area.east,
        area.north,
        since,
        until,
    )
    .fetch_all(pool)
    .await?;
    Ok(group_by_aircraft(rows))
}

/// Groups rows sorted by `(aircraft_address, observed_at)` into one `Aircraft` per aircraft.
fn group_by_aircraft(rows: Vec<PositionRow>) -> Vec<Aircraft> {
    let mut aircraft: Vec<Aircraft> = Vec::new();
    for row in rows {
        let current = match aircraft.last_mut() {
            Some(last) if last.aircraft_address == row.aircraft_address => last,
            _ => {
                aircraft.push(Aircraft {
                    aircraft_address: row.aircraft_address,
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

#[cfg(test)]
mod tests {
    use super::BoundingBox;

    fn lng_span(west: f64, east: f64) -> f64 {
        BoundingBox {
            west,
            south: 0.0,
            east,
            north: 1.0,
        }
        .lng_span()
    }

    fn edge_lengths_km(west: f64, south: f64, east: f64, north: f64) -> [f64; 3] {
        BoundingBox {
            west,
            south,
            east,
            north,
        }
        .edge_lengths_meters()
        .map(|meters| (meters / 1000.0).round())
    }

    #[test]
    fn measures_lng_span() {
        assert_eq!(lng_span(-123.0, -121.5), 1.5);
        assert_eq!(lng_span(-180.0, 180.0), 360.0);
    }

    #[test]
    fn measures_lng_span_across_antimeridian() {
        assert_eq!(lng_span(179.0, -179.0), 2.0);
    }

    #[test]
    fn measures_edges_along_parallels() {
        // A degree of longitude is half as long at 60° as at the equator.
        assert_eq!(edge_lengths_km(0.0, 0.0, 2.0, 60.0), [223.0, 111.0, 6679.0]);
    }

    #[test]
    fn measures_edges_across_antimeridian() {
        assert_eq!(
            edge_lengths_km(179.0, -1.0, -179.0, 1.0),
            [223.0, 223.0, 223.0]
        );
    }
}
