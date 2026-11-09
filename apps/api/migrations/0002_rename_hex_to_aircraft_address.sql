-- The aircraft's 24-bit address, prefixed with `~` when it is not a real ICAO
-- address.
ALTER TABLE aircraft_positions RENAME COLUMN hex TO aircraft_address;
ALTER INDEX aircraft_positions_hex_observed_at_idx
    RENAME TO aircraft_positions_aircraft_address_observed_at_idx;
