use axum::{
    Json,
    extract::{Query, State},
};
use chrono::{TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::{
    error::ApiError,
    store::{self, Aircraft, BoundingBox},
};

/// The longest trace a client can request.
const MAX_TRACE_SECONDS: u32 = 60 * 60;

#[derive(Deserialize)]
pub struct Params {
    /// `west,south,east,north` in degrees.
    bbox: String,
    trace_seconds: u32,
}

#[derive(Serialize)]
pub struct AircraftResponse {
    /// Server time in milliseconds since the Unix epoch.
    now: i64,
    aircraft: Vec<Aircraft>,
}

/// `GET /aircraft?bbox=west,south,east,north&trace_seconds=N`
///
/// Returns the aircraft whose latest position in the last N seconds is inside
/// `bbox`, each with its positions from those N seconds.
pub async fn list(
    State(pool): State<PgPool>,
    Query(params): Query<Params>,
) -> Result<Json<AircraftResponse>, ApiError> {
    let area = parse_bbox(&params.bbox)?;
    if !(1..=MAX_TRACE_SECONDS).contains(&params.trace_seconds) {
        return Err(ApiError::BadRequest(format!(
            "trace_seconds must be between 1 and {MAX_TRACE_SECONDS}"
        )));
    }
    let now = Utc::now();
    let since = now - TimeDelta::seconds(params.trace_seconds.into());
    let aircraft = store::aircraft_in(&pool, &area, since).await?;
    Ok(Json(AircraftResponse {
        now: now.timestamp_millis(),
        aircraft,
    }))
}

fn parse_bbox(bbox: &str) -> Result<BoundingBox, ApiError> {
    let invalid = || {
        ApiError::BadRequest(format!(
            "bbox must be `west,south,east,north` with longitudes in [-180, 180], \
             latitudes in [-90, 90] and south <= north; got `{bbox}`"
        ))
    };
    let values = bbox
        .split(',')
        .map(|part| part.trim().parse::<f64>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid())?;
    let [west, south, east, north] = values[..] else {
        return Err(invalid());
    };
    let longitude = -180.0..=180.0;
    let latitude = -90.0..=90.0;
    if !(longitude.contains(&west)
        && longitude.contains(&east)
        && latitude.contains(&south)
        && latitude.contains(&north)
        && south <= north)
    {
        return Err(invalid());
    }
    Ok(BoundingBox {
        west,
        south,
        east,
        north,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_bbox;

    #[test]
    fn parses_valid_bbox() {
        let bbox = parse_bbox("-123.5, 46.5,-121,48.25").ok().unwrap();
        assert_eq!(
            (bbox.west, bbox.south, bbox.east, bbox.north),
            (-123.5, 46.5, -121.0, 48.25)
        );
    }

    #[test]
    fn accepts_antimeridian_crossing() {
        assert!(parse_bbox("170,-10,-170,10").is_ok());
    }

    #[test]
    fn rejects_invalid_bbox() {
        for bbox in [
            "",
            "1,2,3",
            "1,2,3,4,5",
            "a,2,3,4",
            "NaN,0,1,1",
            "-181,0,0,1",
            "0,-91,1,0",
            "0,10,1,5",
        ] {
            assert!(parse_bbox(bbox).is_err(), "accepted `{bbox}`");
        }
    }
}
