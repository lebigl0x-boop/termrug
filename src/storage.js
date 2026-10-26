import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const configsPath = path.join(dataDirectory, 'configs.json');
const statePath = path.join(dataDirectory, 'state.json');

// How much recent history is mirrored in memory for the live UI. Postgres keeps
// every row; these caps only bound the working set, not the stored history.
export const HOT_EVENTS = 400;
export const HOT_ALERTS = 200;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

// Serialises writes so concurrent webhook and stream events cannot interleave.
function writeQueue() {
  let chain = Promise.resolve();
  return (operation) => {
    chain = chain.then(operation, operation);
    return chain;
  };
}

/**
 * File-backed storage. Used when DATABASE_URL is absent — local development and
 * any deployment with a persistent disk. Every mutation rewrites the snapshot,
 * which is why the hot caps double as hard limits here.
 */
class JsonStorage {
  constructor() {
    this.label = 'json';
    this.queue = writeQueue();
    this.snapshot = { configs: [], state: null };
  }

  async init() {
    await mkdir(dataDirectory, { recursive: true });
  }

  async load() {
    const configs = await readJson(configsPath, []);
    const state = await readJson(statePath, {});
    return {
      configs: Array.isArray(configs) ? configs : [],
      state: {
        watchedWallets: Array.isArray(state.watchedWallets) ? state.watchedWallets : [],
        launches: Array.isArray(state.launches) ? state.launches : [],
        alerts: Array.isArray(state.alerts) ? state.alerts : [],
        events: Array.isArray(state.events) ? state.events : [],
        heliusWebhookId: state.heliusWebhookId ?? null
      }
    };
  }

  track(configs, state) {
    this.snapshot = { configs, state };
  }

  flushConfigs() { return this.queue(() => writeJson(configsPath, this.snapshot.configs)); }
  flushState() { return this.queue(() => writeJson(statePath, this.snapshot.state)); }
  flushAll() {
    return this.queue(async () => {
      await writeJson(configsPath, this.snapshot.configs);
      await writeJson(statePath, this.snapshot.state);
    });
  }

  saveConfig() { return this.flushConfigs(); }
  removeConfig() { return this.flushAll(); }
  saveEvent() { return this.flushState(); }
  saveAlert() { return this.flushState(); }
  saveWatch() { return this.flushState(); }
  updateWatch() { return this.flushState(); }
  saveLaunch() { return this.flushState(); }
  setMeta() { return this.flushState(); }
  pruneExpired() { return this.flushState(); }

  // Without SQL there is no history beyond the hot window, so the live counters
  // are the best available answer. ConfigStore falls back to counting in memory.
  async statsByConfig() { return null; }

  async close() {}
}

const SCHEMA = `
create table if not exists configs (
  id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists events (
  id text primary key,
  config_id text,
  at timestamptz not null,
  type text not null,
  severity text,
  payload jsonb not null
);
create index if not exists events_config_at_idx on events (config_id, at desc);
create index if not exists events_type_idx on events (type);

create table if not exists alerts (
  id text primary key,
  config_id text,
  at timestamptz not null,
  payload jsonb not null
);
create index if not exists alerts_config_at_idx on alerts (config_id, at desc);

create table if not exists watched_wallets (
  id text primary key,
  config_id text not null,
  wallet text not null,
  funding_signature text not null default '',
  expires_at timestamptz not null,
  alert_sent boolean not null default false,
  payload jsonb not null,
  unique (config_id, wallet, funding_signature)
);
create index if not exists watched_expiry_idx on watched_wallets (expires_at);

create table if not exists launches (
  id text primary key,
  config_id text not null,
  creator text not null,
  mint text not null,
  expires_at timestamptz not null,
  payload jsonb not null,
  unique (config_id, creator, mint)
);
create index if not exists launches_expiry_idx on launches (expires_at);

create table if not exists app_meta (
  key text primary key,
  value jsonb
);
`;

/**
 * Postgres-backed storage. Rows are the source of truth and survive redeploys;
 * the in-memory mirror is rebuilt from them at startup.
 */
class PostgresStorage {
  constructor(pool) {
    this.label = 'postgres';
    this.pool = pool;
  }

  async init() {
    await this.pool.query(SCHEMA);
  }

  async load() {
    const [configs, events, alerts, watches, launches, meta] = await Promise.all([
      this.pool.query('select payload from configs order by created_at desc'),
      this.pool.query('select payload from events order by at desc limit $1', [HOT_EVENTS]),
      this.pool.query('select payload from alerts order by at desc limit $1', [HOT_ALERTS]),
      this.pool.query('select payload from watched_wallets where alert_sent = false and expires_at > now() order by expires_at desc'),
      this.pool.query('select payload from launches where expires_at > now() order by expires_at desc'),
      this.pool.query("select value from app_meta where key = 'heliusWebhookId'")
    ]);
    return {
      configs: configs.rows.map((row) => row.payload),
      state: {
        watchedWallets: watches.rows.map((row) => row.payload),
        launches: launches.rows.map((row) => row.payload),
        alerts: alerts.rows.map((row) => row.payload),
        events: events.rows.map((row) => row.payload),
        heliusWebhookId: meta.rows[0]?.value ?? null
      }
    };
  }

  track() {}

  async saveConfig(config) {
    await this.pool.query(
      `insert into configs (id, payload, created_at, updated_at) values ($1, $2, $3, $4)
       on conflict (id) do update set payload = excluded.payload, updated_at = excluded.updated_at`,
      [config.id, config, config.createdAt, config.updatedAt]
    );
  }

  async removeConfig(id) {
    // Watches and launches are rule-scoped; alerts and events are kept as history.
    await this.pool.query('delete from watched_wallets where config_id = $1', [id]);
    await this.pool.query('delete from launches where config_id = $1', [id]);
    await this.pool.query('delete from configs where id = $1', [id]);
  }

  async saveEvent(event) {
    await this.pool.query(
      `insert into events (id, config_id, at, type, severity, payload) values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do nothing`,
      [event.id, event.configId ?? null, event.at, event.type, event.severity ?? null, event]
    );
  }

  async saveAlert(alert) {
    await this.pool.query(
      `insert into alerts (id, config_id, at, payload) values ($1, $2, $3, $4)
       on conflict (id) do nothing`,
      [alert.id, alert.configId ?? null, alert.at, alert]
    );
  }

  async saveWatch(watch) {
    await this.pool.query(
      `insert into watched_wallets (id, config_id, wallet, funding_signature, expires_at, alert_sent, payload)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (config_id, wallet, funding_signature) do nothing`,
      [watch.id, watch.configId, watch.wallet, watch.fundingSignature ?? '', watch.expiresAt, Boolean(watch.alertSent), watch]
    );
  }

  async updateWatch(watch) {
    await this.pool.query(
      'update watched_wallets set alert_sent = $2, payload = $3 where id = $1',
      [watch.id, Boolean(watch.alertSent), watch]
    );
  }

  async saveLaunch(launch) {
    await this.pool.query(
      `insert into launches (id, config_id, creator, mint, expires_at, payload) values ($1, $2, $3, $4, $5, $6)
       on conflict (config_id, creator, mint) do nothing`,
      [launch.id, launch.configId, launch.creator, launch.mint, launch.expiresAt, launch]
    );
  }

  async setMeta(key, value) {
    await this.pool.query(
      `insert into app_meta (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value`,
      [key, JSON.stringify(value ?? null)]
    );
  }

  async pruneExpired(now = Date.now()) {
    const cutoff = new Date(now).toISOString();
    await this.pool.query('delete from watched_wallets where expires_at <= $1 or alert_sent = true', [cutoff]);
    await this.pool.query('delete from launches where expires_at <= $1', [cutoff]);
  }

  // Full-history counters, independent of the in-memory window.
  async statsByConfig(since = null) {
    const params = since ? [new Date(since).toISOString()] : [];
    const filter = since ? 'and at >= $1' : '';
    const { rows } = await this.pool.query(`
      with counters as (
        select config_id,
               count(*) filter (where type = 'FUNDING_MATCH') as funding,
               count(*) filter (where type = 'TOKEN_CREATE') as launches,
               max(at) as last_at
        from events where config_id is not null ${filter}
        group by config_id
      ), signals as (
        select config_id, count(*) as signals
        from alerts where config_id is not null ${filter}
        group by config_id
      )
      select coalesce(counters.config_id, signals.config_id) as config_id,
             coalesce(counters.funding, 0) as funding,
             coalesce(counters.launches, 0) as launches,
             coalesce(signals.signals, 0) as signals,
             counters.last_at
      from counters full outer join signals on counters.config_id = signals.config_id
    `, params);
    return Object.fromEntries(rows.map((row) => [row.config_id, {
      funding: Number(row.funding),
      launches: Number(row.launches),
      signals: Number(row.signals),
      lastAt: row.last_at ? new Date(row.last_at).toISOString() : null
    }]));
  }

  async close() {
    await this.pool.end();
  }
}

export async function createStorage(url = process.env.DATABASE_URL) {
  if (!url) return new JsonStorage();
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: url,
    max: 4,
    // Railway and Supabase both terminate TLS with their own chain.
    ssl: /\blocalhost\b|\b127\.0\.0\.1\b/.test(url) ? false : { rejectUnauthorized: false }
  });
  return new PostgresStorage(pool);
}
