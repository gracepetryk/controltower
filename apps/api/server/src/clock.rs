use chrono::{DateTime, NaiveDate, TimeDelta, Utc};

/// Which day's positions the server serves as the current ones.
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

    /// What to add to a time on the day of `at` to get the same time of day
    /// on the date whose positions are served. Zero when live.
    pub fn replay_offset(self, at: DateTime<Utc>) -> TimeDelta {
        match self {
            Self::Live => TimeDelta::zero(),
            Self::Replay(date) => date.signed_duration_since(at.date_naive()),
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::{NaiveDate, TimeDelta};

    use super::Clock;

    #[test]
    fn replay_offset_moves_to_replayed_date() {
        let date = NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
        let at = NaiveDate::from_ymd_opt(2026, 3, 4)
            .unwrap()
            .and_hms_opt(23, 59, 0)
            .unwrap()
            .and_utc();
        assert_eq!(Clock::Replay(date).replay_offset(at), TimeDelta::days(-3));
        assert_eq!(Clock::Live.replay_offset(at), TimeDelta::zero());
    }
}
