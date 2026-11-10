use aide::transform::TransformOperation;
use axum::{
    Json,
    extract::{Query, State},
};
use chrono::{DateTime, TimeDelta, Utc};
use schemars::JsonSchema;
use serde::Deserialize;
use sqlx::PgPool;

use crate::{
    clock::Clock,
    error::ApiError,
    store::{self, Aircraft, BoundingBox},
};

/// The longest time span a client can request, since the API is public.
const MAX_SPAN: TimeDelta = TimeDelta::minutes(5);

#[derive(Deserialize, JsonSchema)]
pub struct Params {
    /// `west,south,east,north` in degrees. Longitudes are in [-180, 180] and
    /// latitudes in [-90, 90]. `west > east` crosses the antimeridian. At most
    /// 400 km along each edge.
    #[schemars(example = "-123.5,46.5,-121,48.5")]
    bbox: String,
    /// Start of the time span, inclusive, in seconds since the Unix epoch.
    since: i64,
    /// End of the time span, exclusive, in seconds since the Unix epoch. At
    /// most 5 minutes after `since`.
    until: i64,
}

/// `GET /api/aircraft?bbox=west,south,east,north&since=S&until=S`
pub async fn list(
    State(pool): State<PgPool>,
    State(clock): State<Clock>,
    Query(params): Query<Params>,
) -> Result<Json<Vec<Aircraft>>, ApiError> {
    let area = parse_bbox(&params.bbox)?;
    let (since, until) = parse_span(params.since, params.until)?;
    // When replaying, the span is served from the same times of day on the
    // replayed date, and the positions are reported as if they were today.
    let offset = clock.replay_offset(until);
    let mut aircraft = store::aircraft_in(&pool, &area, since + offset, until + offset).await?;
    let offset_ms = offset.num_milliseconds();
    for point in aircraft.iter_mut().flat_map(|aircraft| &mut aircraft.trace) {
        point.observed_at -= offset_ms;
    }
    Ok(Json(aircraft))
}

pub fn list_docs(op: TransformOperation) -> TransformOperation {
    op.summary("Aircraft in an area, with traces")
        .description(
            "Returns the positions observed in `[since, until)` inside `bbox`, grouped by \
             aircraft, oldest first. `bbox` can be at most 400 km along each edge, or the \
             response is 413. When the server replays a recorded day, the span is served \
             from the same times of day on that day, and `observed_at` is reported as if \
             it were the day of `until`.",
        )
        .response_with::<200, Json<Vec<Aircraft>>, _>(|res| {
            res.description("The matching aircraft.")
        })
}

fn parse_span(since: i64, until: i64) -> Result<(DateTime<Utc>, DateTime<Utc>), ApiError> {
    let invalid = || {
        ApiError::BadRequest(format!(
            "since and until must be seconds since the Unix epoch with since <= until \
             and at most {} s apart; got {since} and {until}",
            MAX_SPAN.num_seconds()
        ))
    };
    let since = DateTime::from_timestamp(since, 0).ok_or_else(invalid)?;
    let until = DateTime::from_timestamp(until, 0).ok_or_else(invalid)?;
    if since > until || until - since > MAX_SPAN {
        return Err(invalid());
    }
    Ok((since, until))
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
    use super::{parse_bbox, parse_span};

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
        assert!(parse_bbox("175,-5,-175,5").is_ok());
    }

    #[test]
    fn accepts_span_up_to_max() {
        assert!(parse_span(0, 0).is_ok());
        assert!(parse_span(1, 301).is_ok());
    }

    #[test]
    fn rejects_invalid_span() {
        assert!(parse_span(2, 1).is_err());
        assert!(parse_span(0, 301).is_err());
        assert!(parse_span(i64::MAX, i64::MAX).is_err());
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
