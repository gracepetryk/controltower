//! Client for the adsb.lol v2 API: https://api.adsb.lol/docs

use std::time::Duration;

use anyhow::Context;
use chrono::{DateTime, TimeDelta, Utc};
use serde::Deserialize;

const BASE_URL: &str = "https://api.adsb.lol/v2";

pub struct Client {
    http: reqwest::Client,
}

/// An aircraft position report, as returned by the API.
#[derive(Debug, Deserialize)]
pub struct Aircraft {
    pub hex: String,
    #[serde(rename = "type")]
    pub source: String,
    pub flight: Option<String>,
    #[serde(rename = "r")]
    pub registration: Option<String>,
    #[serde(rename = "t")]
    pub aircraft_type: Option<String>,
    pub category: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    /// Seconds between the response's `now` and the last position update.
    pub seen_pos: Option<f64>,
    pub alt_baro: Option<BaroAltitude>,
    pub alt_geom: Option<i32>,
    pub gs: Option<f32>,
    pub track: Option<f32>,
    pub true_heading: Option<f32>,
    pub baro_rate: Option<i32>,
    pub geom_rate: Option<i32>,
    pub squawk: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(untagged)]
pub enum BaroAltitude {
    Feet(i32),
    #[serde(deserialize_with = "deserialize_ground")]
    Ground,
}

/// The aircraft in a response, with the server time they are relative to.
pub struct Snapshot {
    pub now: DateTime<Utc>,
    pub aircraft: Vec<Aircraft>,
}

#[derive(Deserialize)]
struct PointResponse {
    /// Milliseconds since the Unix epoch.
    now: i64,
    ac: Vec<serde_json::Value>,
}

impl Client {
    pub fn new() -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("controltower/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self { http })
    }

    /// Fetches all aircraft within `radius_nm` nautical miles of a point.
    pub async fn point(&self, lat: f64, lon: f64, radius_nm: u32) -> anyhow::Result<Snapshot> {
        let url = format!("{BASE_URL}/point/{lat}/{lon}/{radius_nm}");
        let response: PointResponse = self
            .http
            .get(&url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
            .with_context(|| format!("decoding response from {url}"))?;

        let now = DateTime::from_timestamp_millis(response.now)
            .with_context(|| format!("`now` out of range: {}", response.now))?;
        // Parse each aircraft separately so one malformed record doesn't drop
        // the whole snapshot.
        let aircraft = response
            .ac
            .into_iter()
            .filter_map(|value| match serde_json::from_value::<Aircraft>(value) {
                Ok(aircraft) => Some(aircraft),
                Err(err) => {
                    tracing::warn!(%err, "skipping malformed aircraft");
                    None
                }
            })
            .collect();
        Ok(Snapshot { now, aircraft })
    }
}

impl Aircraft {
    /// When the aircraft's position was last updated, or `None` if it has no
    /// position or `seen_pos` is out of range.
    pub fn observed_at(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let seen_pos = self.seen_pos?;
        let age = TimeDelta::try_milliseconds((seen_pos * 1000.0).round() as i64)?;
        now.checked_sub_signed(age)
    }

    /// The callsign without its trailing padding, if it is non-empty.
    pub fn callsign(&self) -> Option<&str> {
        self.flight.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }
}

fn deserialize_ground<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<(), D::Error> {
    let value = String::deserialize(deserializer)?;
    if value == "ground" {
        Ok(())
    } else {
        Err(serde::de::Error::invalid_value(
            serde::de::Unexpected::Str(&value),
            &"\"ground\"",
        ))
    }
}
