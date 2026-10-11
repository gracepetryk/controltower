//! Reader for readsb `trace_full_*.json` files, as published daily by adsb.lol
//! in https://github.com/adsblol/globe_history_2026. The trace format is
//! documented at https://github.com/wiedehopf/readsb/blob/dev/README-json.md.

use std::{fmt, fs::File, io::BufReader, path::Path};

use anyhow::Context;
use chrono::{DateTime, TimeDelta};
use flate2::read::GzDecoder;
use serde::{
    Deserialize, Deserializer,
    de::{self, IgnoredAny, SeqAccess, Visitor},
};

use crate::{
    adsb::{self, BaroAltitude},
    store::Position,
};

/// Set on the first point of a new leg.
const FLAG_NEW_LEG: u8 = 2;
/// Set when the vertical rate is geometric instead of barometric.
const FLAG_GEOM_RATE: u8 = 4;
/// Set when the altitude is geometric instead of barometric.
const FLAG_GEOM_ALT: u8 = 8;
/// readsb's type for positions of unknown origin.
const UNKNOWN_SOURCE: &str = "other";

/// One aircraft's positions over a day.
#[derive(Deserialize)]
struct Trace {
    icao: String,
    r: Option<String>,
    t: Option<String>,
    /// Seconds since the Unix epoch that point offsets are relative to.
    timestamp: f64,
    trace: Vec<TracePoint>,
}

/// One element of `trace`, a JSON array whose meaning is positional.
struct TracePoint {
    seconds: f64,
    lat: f64,
    lon: f64,
    altitude: Option<BaroAltitude>,
    ground_speed: Option<f32>,
    track: Option<f32>,
    flags: u8,
    vertical_rate: Option<i32>,
    details: Option<Details>,
    source: Option<String>,
    alt_geom: Option<i32>,
    geom_rate: Option<i32>,
}

/// The aircraft fields readsb attaches to some points. They apply until the
/// next point that has them.
#[derive(Deserialize)]
struct Details {
    flight: Option<String>,
    category: Option<String>,
    squawk: Option<String>,
    true_heading: Option<f32>,
}

/// Reads a gzipped trace file into positions, oldest first.
pub fn read_trace(path: &Path) -> anyhow::Result<Vec<Position>> {
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let trace: Trace = serde_json::from_reader(BufReader::new(GzDecoder::new(file)))
        .with_context(|| format!("decoding {}", path.display()))?;
    trace.into_positions()
}

impl Trace {
    fn into_positions(self) -> anyhow::Result<Vec<Position>> {
        let start = DateTime::from_timestamp_millis((self.timestamp * 1000.0).round() as i64)
            .with_context(|| format!("`timestamp` out of range: {}", self.timestamp))?;
        let hex = self.icao;
        let mut flight = None;
        let mut category = None;
        let mut squawk = None;
        let mut positions = Vec::with_capacity(self.trace.len());
        for point in self.trace {
            if point.flags & FLAG_NEW_LEG != 0 {
                flight = None;
                squawk = None;
            }
            let mut true_heading = None;
            if let Some(details) = point.details {
                flight = details
                    .flight
                    .as_deref()
                    .and_then(adsb::trim_callsign)
                    .map(str::to_owned);
                category = details.category.or(category);
                squawk = details.squawk;
                true_heading = details.true_heading;
            }
            let Some(observed_at) =
                TimeDelta::try_milliseconds((point.seconds * 1000.0).round() as i64)
                    .and_then(|offset| start.checked_add_signed(offset))
            else {
                continue;
            };

            let (on_ground, altitude) = BaroAltitude::split(point.altitude);
            let (alt_baro, alt_geom) = if point.flags & FLAG_GEOM_ALT != 0 {
                (None, point.alt_geom.or(altitude))
            } else {
                (altitude, point.alt_geom)
            };
            let (baro_rate, geom_rate) = if point.flags & FLAG_GEOM_RATE != 0 {
                (None, point.geom_rate.or(point.vertical_rate))
            } else {
                (point.vertical_rate, point.geom_rate)
            };
            positions.push(Position {
                observed_at,
                hex: hex.clone(),
                flight: flight.clone(),
                registration: self.r.clone(),
                aircraft_type: self.t.clone(),
                category: category.clone(),
                source: point.source.unwrap_or_else(|| UNKNOWN_SOURCE.to_owned()),
                lat: point.lat,
                lon: point.lon,
                on_ground,
                alt_baro,
                alt_geom,
                ground_speed: point.ground_speed,
                track: point.track,
                true_heading,
                baro_rate,
                geom_rate,
                squawk: squawk.clone(),
            });
        }
        Ok(positions)
    }
}

impl<'de> Deserialize<'de> for TracePoint {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_seq(TracePointVisitor)
    }
}

struct TracePointVisitor;

impl<'de> Visitor<'de> for TracePointVisitor {
    type Value = TracePoint;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a readsb trace point array")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<TracePoint, A::Error> {
        // Points from older readsb versions are shorter, so every element
        // after the vertical rate is optional.
        let seconds = required(&mut seq, 0)?;
        let lat = required(&mut seq, 1)?;
        let lon = required(&mut seq, 2)?;
        let altitude = required(&mut seq, 3)?;
        let ground_speed = required(&mut seq, 4)?;
        let track = required(&mut seq, 5)?;
        let flags = required(&mut seq, 6)?;
        let vertical_rate = required(&mut seq, 7)?;
        let point = TracePoint {
            seconds,
            lat,
            lon,
            altitude,
            ground_speed,
            track,
            flags,
            vertical_rate,
            details: seq.next_element()?.flatten(),
            source: seq.next_element()?.flatten(),
            alt_geom: seq.next_element()?.flatten(),
            geom_rate: seq.next_element()?.flatten(),
        };
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(point)
    }
}

fn required<'de, T: Deserialize<'de>, A: SeqAccess<'de>>(
    seq: &mut A,
    index: usize,
) -> Result<T, A::Error> {
    seq.next_element()?
        .ok_or_else(|| de::Error::invalid_length(index, &TracePointVisitor))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn positions(json: &str) -> Vec<Position> {
        serde_json::from_str::<Trace>(json)
            .unwrap()
            .into_positions()
            .unwrap()
    }

    #[test]
    fn reads_points_relative_to_timestamp() {
        let positions = positions(
            r#"{"icao":"ab24b7","r":"N817PW","t":"B350","timestamp":1791590400.000,"trace":[
                [1.5,30.04,-90.02,1200,108.0,359.5,0,128,null,"adsb_icao",1175,null,null,null]
            ]}"#,
        );
        let [position] = positions.as_slice() else {
            panic!("expected one position");
        };
        assert_eq!(position.observed_at.timestamp_millis(), 1_791_590_401_500);
        assert_eq!(position.hex, "ab24b7");
        assert_eq!(position.registration.as_deref(), Some("N817PW"));
        assert_eq!(position.aircraft_type.as_deref(), Some("B350"));
        assert_eq!(position.source, "adsb_icao");
        assert_eq!((position.lat, position.lon), (30.04, -90.02));
        assert!(!position.on_ground);
        assert_eq!(position.alt_baro, Some(1200));
        assert_eq!(position.alt_geom, Some(1175));
        assert_eq!(position.baro_rate, Some(128));
        assert_eq!(position.geom_rate, None);
    }

    #[test]
    fn carries_details_forward_until_a_new_leg() {
        let positions = positions(
            r#"{"icao":"ab24b7","timestamp":0,"trace":[
                [0,1,1,"ground",0,0,0,null,{"flight":"N817PW  ","category":"A1","squawk":"1200","true_heading":90.5},"adsb_icao"],
                [1,1,1,100,0,0,0,null,null,"adsb_icao"],
                [2,1,1,100,0,0,2,null,null,"adsb_icao"]
            ]}"#,
        );
        let details: Vec<_> = positions
            .iter()
            .map(|p| {
                (
                    p.flight.as_deref(),
                    p.category.as_deref(),
                    p.squawk.as_deref(),
                    p.true_heading,
                )
            })
            .collect();
        assert_eq!(
            details,
            [
                (Some("N817PW"), Some("A1"), Some("1200"), Some(90.5)),
                (Some("N817PW"), Some("A1"), Some("1200"), None),
                (None, Some("A1"), None, None),
            ]
        );
        assert!(positions[0].on_ground);
        assert_eq!(positions[0].alt_baro, None);
    }

    #[test]
    fn reads_geometric_altitude_and_rate_from_flags() {
        let positions = positions(
            r#"{"icao":"ab24b7","timestamp":0,"trace":[
                [0,1,1,1000,null,null,12,-640,null,null,null,null]
            ]}"#,
        );
        assert_eq!(positions[0].alt_baro, None);
        assert_eq!(positions[0].alt_geom, Some(1000));
        assert_eq!(positions[0].baro_rate, None);
        assert_eq!(positions[0].geom_rate, Some(-640));
        assert_eq!(positions[0].source, UNKNOWN_SOURCE);
    }

    #[test]
    fn accepts_short_points() {
        let positions =
            positions(r#"{"icao":"ab24b7","timestamp":0,"trace":[[0,1,1,null,null,null,0,null]]}"#);
        assert_eq!(positions.len(), 1);
    }
}
