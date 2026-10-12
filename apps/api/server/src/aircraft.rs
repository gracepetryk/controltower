use aide::transform::TransformOperation;
use axum::{
    Json,
    extract::{Query, State},
};
use chrono::TimeDelta;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::{
    clock::Clock,
    error::ApiError,
    store::{self, Aircraft, BoundingBox},
};

/// The longest trace a client can request.
const MAX_TRACE_SECONDS: u32 = 5 * 60;
/// The widest and tallest `bbox` a client can request, in degrees.
const MAX_BBOX_DEGREES: f64 = 10.0;

#[derive(Deserialize, JsonSchema)]
pub struct Params {
    /// `west,south,east,north` in degrees. Longitudes are in [-180, 180] and
    /// latitudes in [-90, 90]. `west > east` crosses the antimeridian. It
    /// can span at most 10 degrees of longitude and of latitude.
    #[schemars(example = "-123.5,46.5,-121,48.5")]
    bbox: String,
    /// How many seconds of positions to return.
    #[schemars(range(min = 1, max = MAX_TRACE_SECONDS))]
    trace_seconds: u32,
}

#[derive(Serialize, JsonSchema)]
pub struct AircraftResponse {
    /// Server time in milliseconds since the Unix epoch. When the server is
    /// replaying recorded positions, this is the replayed time.
    now: i64,
    aircraft: Vec<Aircraft>,
}

/// `GET /api/aircraft?bbox=west,south,east,north&trace_seconds=N`
pub async fn list(
    State(pool): State<PgPool>,
    State(clock): State<Clock>,
    Query(params): Query<Params>,
) -> Result<Json<AircraftResponse>, ApiError> {
    let area = parse_bbox(&params.bbox)?;
    if !(1..=MAX_TRACE_SECONDS).contains(&params.trace_seconds) {
        return Err(ApiError::BadRequest(format!(
            "trace_seconds must be between 1 and {MAX_TRACE_SECONDS}"
        )));
    }
    let now = clock.now();
    let since = now - TimeDelta::seconds(params.trace_seconds.into());
    let aircraft = store::aircraft_in(&pool, &area, since, now).await?;
    Ok(Json(AircraftResponse {
        now: now.timestamp_millis(),
        aircraft,
    }))
}

pub fn list_docs(op: TransformOperation) -> TransformOperation {
    op.summary("Aircraft in an area, with traces")
        .description(
            "Returns the aircraft whose latest position in the last `trace_seconds` is inside \
         `bbox`, each with all of its positions from that window, oldest first. Traces may \
         extend outside `bbox`.",
        )
        .response_with::<200, Json<AircraftResponse>, _>(|res| {
            res.description("The matching aircraft.")
        })
}

fn parse_bbox(bbox: &str) -> Result<BoundingBox, ApiError> {
    let invalid = || {
        ApiError::BadRequest(format!(
            "bbox must be `west,south,east,north` with longitudes in [-180, 180], \
             latitudes in [-90, 90], south <= north and each side at most \
             {MAX_BBOX_DEGREES} degrees; got `{bbox}`"
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
    let width = if west <= east {
        east - west
    } else {
        east + 360.0 - west
    };
    if !(longitude.contains(&west)
        && longitude.contains(&east)
        && latitude.contains(&south)
        && latitude.contains(&north)
        && south <= north
        && width <= MAX_BBOX_DEGREES
        && north - south <= MAX_BBOX_DEGREES)
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
    fn accepts_largest_bbox() {
        assert!(parse_bbox("-130,40,-120,50").is_ok());
    }

    #[test]
    fn accepts_antimeridian_crossing() {
        assert!(parse_bbox("175,-5,-175,5").is_ok());
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
            "-130,40,-119.9,41",
            "0,40,1,50.1",
            "170,0,-179.9,1",
        ] {
            assert!(parse_bbox(bbox).is_err(), "accepted `{bbox}`");
        }
    }
}
