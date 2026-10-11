use chrono::{DateTime, NaiveDate, Utc};

/// The time the server treats as now.
#[derive(Clone, Copy)]
pub enum Clock {
    Live,
    /// The current UTC time of day on `date`, for serving recorded positions
    /// in place of live ones.
    Replay(NaiveDate),
}

impl Clock {
    /// `Replay` if `REPLAY_DATE` (`YYYY-MM-DD`) is set, otherwise `Live`.
    pub fn from_env() -> anyhow::Result<Self> {
        match std::env::var("REPLAY_DATE") {
            Ok(date) => {
                let date = date.parse().map_err(|err| {
                    anyhow::anyhow!("REPLAY_DATE must be YYYY-MM-DD, got `{date}`: {err}")
                })?;
                Ok(Self::Replay(date))
            }
            Err(std::env::VarError::NotPresent) => Ok(Self::Live),
            Err(err) => Err(anyhow::anyhow!("reading REPLAY_DATE: {err}")),
        }
    }

    pub fn now(self) -> DateTime<Utc> {
        let now = Utc::now();
        match self {
            Self::Live => now,
            Self::Replay(date) => date.and_time(now.time()).and_utc(),
        }
    }
}
