import { useEffect, useState } from 'react';

import type { AircraftFeed } from './AircraftFeed';
import {
  AreaTooLargeError,
  type BoundingBox,
  fetchAircraft,
  padBoundingBox,
} from './aircraftApi';

const POLL_INTERVAL_MS = 5_000;
// Faster than airliners fly over the ground, even with a strong tailwind. The fetched area is padded
// by how far this goes in the feed's history, so trails and interpolation don't stop at the edge of
// the view.
const MAX_GROUND_SPEED_MPS = 350;
// Positions are stored some time after they were observed, so each poll fetches again from this
// long before where the previous one ended, to pick up positions stored since.
const POSITION_SETTLE_MS = 40_000;

// Polls `GET /aircraft` into `feed` every POLL_INTERVAL_MS, for the area set with the returned
// `setBounds`. Nothing is polled until it is set. Each poll fetches positions up to now. The first
// poll for an area fetches the feed's whole history, and later polls fetch from POSITION_SETTLE_MS
// before where the previous one ended.
// A new area cancels the request in flight and polls right away. `setPaused(true)` stops polling
// and cancels the request in flight, and `setPaused(false)` polls right away. Polling also pauses
// while the page is hidden and polls right away when it is shown again, so trails cover the time
// away with recorded positions. When the server refuses the area as too large, `feed` is cleared and
// polling stops until the area changes.
export function useAircraftPolling(feed: AircraftFeed) {
  const [bounds, setBounds] = useState<BoundingBox | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!bounds || paused) {
      return;
    }
    const controller = new AbortController();
    // The fetched history has to cover the feed's history until the next poll.
    const historySeconds = Math.ceil((feed.historyMs + POLL_INTERVAL_MS) / 1000);
    const area = padBoundingBox(bounds, MAX_GROUND_SPEED_MPS * historySeconds);
    let timer: number | undefined;
    // While a poll is in flight, it schedules the next one.
    let polling = false;
    // The end of the last fetched span, exclusive, in seconds since the Unix epoch, or null before the
    // first.
    let fetchedUntil: number | null = null;

    const poll = async () => {
      clearTimeout(timer);
      if (polling || document.hidden) {
        return;
      }
      polling = true;
      try {
        const until = Math.floor(Date.now() / 1000) + 1;
        const oldest = until - historySeconds;
        // Fetches the whole history for the first poll, after the page was hidden for longer than
        // the history, and if the clock went back.
        const full = fetchedUntil === null || fetchedUntil < oldest || fetchedUntil > until;
        const since = full ? oldest : Math.max(oldest, fetchedUntil! - POSITION_SETTLE_MS / 1000);
        const aircraft = await fetchAircraft(area, since, until, controller.signal);
        // Replaced by a newer effect while the response was read.
        if (controller.signal.aborted) {
          return;
        }
        if (full) {
          feed.setAircraft(aircraft);
        } else {
          feed.addAircraft(aircraft);
        }
        fetchedUntil = until;
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (error instanceof AreaTooLargeError) {
          // Zoomed out too far for the server, so no aircraft are shown.
          feed.clear();
          return;
        }
        console.error('Polling aircraft failed; retrying', error);
      } finally {
        polling = false;
      }
      timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    document.addEventListener('visibilitychange', () => void poll(), { signal: controller.signal });
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [feed, bounds, paused]);

  return { setBounds, setPaused };
}
