-- ServerCase Worker schema.
--
-- The cloud side stays deliberately thin: it stores user accounts, one
-- secret-free config snapshot per user, the latest probe snapshot (plus
-- optional history) per host, and registered push devices. SSH credentials
-- and the Bitwarden vault never reach here.

-- ── Accounts ────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  -- PBKDF2-SHA256, encoded as "pbkdf2$<iterations>$<saltB64>$<hashB64>".
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_users_email ON users (email);

-- ── Config sync ─────────────────────────────────────────────────────────────
-- One row per user: the latest secret-free SyncPayload. `version` increases on
-- every successful write so clients can do last-write-wins with detection of a
-- stale base (HTTP 409).
CREATE TABLE sync_state (
  user_id    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── Probe hosts ─────────────────────────────────────────────────────────────
-- A named host owned by a user, authenticated by a per-host bearer token. We
-- only store the SHA-256 of the token; the raw value is shown once at creation.
CREATE TABLE probe_hosts (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER,
  -- Most recent servercase.probe.v1 JSON, for fast reads by the clients.
  latest_snapshot TEXT
);
CREATE INDEX idx_probe_hosts_user ON probe_hosts (user_id);
CREATE UNIQUE INDEX idx_probe_hosts_token ON probe_hosts (token_hash);

-- Optional rolling history, trimmed to PROBE_HISTORY_LIMIT rows per host.
CREATE TABLE probe_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id      TEXT NOT NULL REFERENCES probe_hosts (id) ON DELETE CASCADE,
  collected_at INTEGER NOT NULL,
  received_at  INTEGER NOT NULL,
  snapshot     TEXT NOT NULL
);
CREATE INDEX idx_probe_snapshots_host ON probe_snapshots (host_id, id);

-- ── Push devices (future-prep) ──────────────────────────────────────────────
-- Registered client push tokens. Stored now so the apps can register; the
-- worker does not deliver notifications yet (see src/push/).
CREATE TABLE push_devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  platform     TEXT NOT NULL, -- 'apns' | 'fcm' | 'webpush'
  token        TEXT NOT NULL,
  label        TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX idx_push_devices_user ON push_devices (user_id);
CREATE UNIQUE INDEX idx_push_devices_token ON push_devices (user_id, platform, token);
