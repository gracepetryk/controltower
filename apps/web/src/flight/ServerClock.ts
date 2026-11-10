// The estimate is replaced only when a response disagrees with it by more than this, so that the
// `Date` header's whole-second resolution doesn't shift the time every response.
const MAX_DRIFT_MS = 2_000;

// The API server's clock, estimated from the `Date` headers of its responses. Until the first
// response with one, it is the local clock.
export class ServerClock {
  // Server time minus local time.
  private offsetMs: number | null = null;
  private warnedMissing = false;

  // Milliseconds since the Unix epoch on the server's clock.
  now(): number {
    return Date.now() + (this.offsetMs ?? 0);
  }

  // Updates the estimate from `response`, which was requested at `requestedMs` and arrived at
  // `receivedMs`, both on the local clock.
  sync(response: Response, requestedMs: number, receivedMs: number) {
    const dateMs = Date.parse(response.headers.get('Date') ?? '');
    if (Number.isNaN(dateMs)) {
      if (!this.warnedMissing) {
        console.warn('API response has no valid Date header; using the local clock');
        this.warnedMissing = true;
      }
      return;
    }
    // The server read its clock about halfway through the request, and `Date` drops the fraction
    // of a second.
    const offsetMs = dateMs + 500 - (requestedMs + receivedMs) / 2;
    if (this.offsetMs === null || Math.abs(offsetMs - this.offsetMs) > MAX_DRIFT_MS) {
      this.offsetMs = offsetMs;
    }
  }
}
