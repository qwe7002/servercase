/**
 * Drizzle schema for the worker's D1 database. This is the single source of
 * truth: migrations are generated from it with `npm run db:generate`, and the
 * query layer is typed against it. Column names keep the snake_case the SQL
 * used; the TS field names are camelCase.
 *
 * Design unchanged from the thin-cloud model: accounts, one secret-free config
 * snapshot per user, latest + bounded probe history per host, and registered
 * push devices. No SSH credentials or vault data ever land here.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ── Accounts ────────────────────────────────────────────────────────────────
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    // PBKDF2-SHA256, encoded as "pbkdf2$<iterations>$<saltB64>$<hashB64>".
    passwordHash: text('password_hash').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('idx_users_email').on(t.email)],
);

// ── Config sync ─────────────────────────────────────────────────────────────
// One row per user: the latest secret-free SyncPayload. `version` increases on
// every successful write for last-write-wins with stale-base detection (409).
export const syncState = sqliteTable('sync_state', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  payload: text('payload').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// ── Probe hosts ─────────────────────────────────────────────────────────────
// A named host owned by a user, authenticated by a per-host bearer token. Only
// the SHA-256 of the token is stored; the raw value is shown once at creation.
export const probeHosts = sqliteTable(
  'probe_hosts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at'),
    // Most recent servercase.probe.v1 JSON, for fast reads by the clients.
    latestSnapshot: text('latest_snapshot'),
    // JSON array of currently-breaching alert keys, for push transition detection.
    alertState: text('alert_state'),
  },
  (t) => [
    index('idx_probe_hosts_user').on(t.userId),
    uniqueIndex('idx_probe_hosts_token').on(t.tokenHash),
  ],
);

// Optional rolling history, trimmed to PROBE_HISTORY_LIMIT rows per host.
export const probeSnapshots = sqliteTable(
  'probe_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    hostId: text('host_id')
      .notNull()
      .references(() => probeHosts.id, { onDelete: 'cascade' }),
    collectedAt: integer('collected_at').notNull(),
    receivedAt: integer('received_at').notNull(),
    snapshot: text('snapshot').notNull(),
  },
  (t) => [index('idx_probe_snapshots_host').on(t.hostId, t.id)],
);

// ── Push devices (future-prep) ──────────────────────────────────────────────
// Registered client push tokens. Stored now so the apps can register; the
// worker does not deliver notifications yet (see src/push/).
export const pushDevices = sqliteTable(
  'push_devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(), // 'apns' | 'fcm' | 'webpush'
    token: text('token').notNull(),
    label: text('label'),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at'),
  },
  (t) => [
    index('idx_push_devices_user').on(t.userId),
    uniqueIndex('idx_push_devices_token').on(t.userId, t.platform, t.token),
  ],
);
