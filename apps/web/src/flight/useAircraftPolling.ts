import { useEffect, useState } from 'react';

import type { AircraftFeed } from './AircraftFeed';
import { AreaTooLargeError, type BoundingBox, fetchAircraft, padBoundingBox } from './aircraftApi';

const POLL_INTERVAL_MS = 5_000;
// Faster than airliners fly over the ground, even with a strong tailwind. The fetched area is padded
// by how far this goes in the trace, so trails and interpolation don't stop at the edge of the view.
const MAX_GROUND_SPEED_MPS = 350;

// Polls `GET /aircraft` into `feed` every POLL_INTERVAL_MS, for the area set with the returned
// `setBounds`. Nothing is polled until it is set. A new area cancels the request in flight and polls
// right away. `setPaused(true)` stops polling and cancels the request in flight, and
// `setPaused(false)` polls right away. Polling also pauses while the page is hidden and polls right
// away when it is shown again, so trails cover the time away with recorded positions. When the
// server refuses the area as too large, `feed` is cleared and polling stops until the area changes.
export function useAircraftPolling(feed: AircraftFeed) {
  const [bounds, setBounds] = useState<BoundingBox | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!bounds || paused) {
      return;
    }
    const controller = new AbortController();
    // The trace has to cover the feed's history until the next poll.
    const traceSeconds = Math.ceil((feed.historyMs + POLL_INTERVAL_MS) / 1000);
    const area = padBoundingBox(bounds, MAX_GROUND_SPEED_MPS * traceSeconds);
    let timer: number | undefined;
    // While a poll is in flight, it schedules the next one.
    let polling = false;

    const poll = async () => {
      clearTimeout(timer);
      if (polling || document.hidden) {
        return;
      }
      polling = true;
      try {
        const requestedMs = Date.now();
        const response = await fetchAircraft(area, traceSeconds, controller.signal);
        // Replaced by a newer effect while the response was read.
        if (controller.signal.aborted) {
          return;
        }
        feed.setAircraft(response, requestedMs, Date.now());
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
