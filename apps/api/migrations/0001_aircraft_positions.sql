CREATE EXTENSION IF NOT EXISTS postgis;

-- One row per position report. An aircraft whose position hasn't updated
-- between polls produces the same (hex, observed_at), which the unique index
-- deduplicates.
CREATE TABLE aircraft_positions (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- When the position was received: the response's `now` minus `seen_pos`.
    observed_at   timestamptz NOT NULL,
    -- 24-bit ICAO address. Prefixed with `~` when it is not a real ICAO address.
    hex           text NOT NULL,
    -- Callsign, trimmed. Missing until the aircraft broadcasts it.
    flight        text,
    registration  text,
    aircraft_type text,
    category      text,
    -- Where the position came from, e.g. `adsb_icao` or `mlat`.
    source        text NOT NULL,
    position      geography(Point, 4326) NOT NULL,
    on_ground     boolean NOT NULL,
    -- Feet. `alt_baro` is null when the aircraft is on the ground.
    alt_baro      integer,
    alt_geom      integer,
    -- Knots and degrees.
    ground_speed  real,
    track         real,
    true_heading  real,
    -- Feet per minute.
    baro_rate     integer,
    geom_rate     integer,
    squawk        text
);

CREATE UNIQUE INDEX aircraft_positions_hex_observed_at_idx
    ON aircraft_positions (hex, observed_at);
CREATE INDEX aircraft_positions_flight_observed_at_idx
    ON aircraft_positions (flight, observed_at) WHERE flight IS NOT NULL;
CREATE INDEX aircraft_positions_observed_at_idx
    ON aircraft_positions USING brin (observed_at);
CREATE INDEX aircraft_positions_position_idx
    ON aircraft_positions USING gist (position);
