-- Xylocopa telemetry events.
-- All columns are client-supplied EXCEPT received_at (server time).
-- install_id is NOT considered PII — it's a random UUID generated on first boot,
-- not tied to any user account, device fingerprint, IP, or hostname.

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event       TEXT NOT NULL,
    install_id  TEXT NOT NULL,
    version     TEXT NOT NULL,
    platform    TEXT NOT NULL,
    ts          TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Covers "events of type X over time" queries (DAU, funnel counts).
CREATE INDEX IF NOT EXISTS idx_events_event_ts ON events(event, ts);

-- Covers per-install funnel and dedup lookups.
CREATE INDEX IF NOT EXISTS idx_events_install ON events(install_id);
