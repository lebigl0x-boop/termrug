import { randomUUID } from 'node:crypto';
import { createStorage, HOT_ALERTS, HOT_EVENTS } from './storage.js';

const DEFAULT_STATE = { watchedWallets: [], launches: [], alerts: [], events: [], heliusWebhookId: null };

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function number(value, field, { min = 0, strictPositive = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (strictPositive ? parsed <= min : parsed < min)) {
    throw new Error(`${field} must be a valid ${strictPositive ? 'positive' : 'non-negative'} number.`);
  }
  return parsed;
}

/**
 * A range is authored either as explicit bounds, or as a target with a
 * tolerance — the form that matters in practice, because the amounts being
 * matched are never round. Writing 0.029 to 0.029 demands an exact lamport hit
 * and effectively never fires; 0.029 ± 2% does what the author meant. Both
 * shapes normalise to the min/max the matcher already works in, and the
 * authored fields are kept so the UI can show them back.
 */
function resolveBounds(range, label, index) {
  const authored = range?.target ?? null;
  if (authored === null || authored === '') {
    const min = number(range?.min, `${label}[${index}].min`);
    const max = number(range?.max, `${label}[${index}].max`);
    return { min, max };
  }
  const target = number(authored, `${label}[${index}].target`);
  const toleranceMode = range.toleranceMode === 'absolute' ? 'absolute' : 'percent';
  const tolerance = number(range.tolerance ?? 0, `${label}[${index}].tolerance`);
  const spread = toleranceMode === 'percent' ? target * tolerance / 100 : tolerance;
  return {
    min: Math.max(0, target - spread),
    max: target + spread,
    target,
    tolerance,
    toleranceMode
  };
}

function normaliseRanges(values, label, fallbackMin, fallbackMax) {
  const source = Array.isArray(values) && values.length ? values : [{ min: fallbackMin, max: fallbackMax }];
  return source.map((range, index) => {
    const bounds = resolveBounds(range, label, index);
    if (bounds.min > bounds.max) throw new Error(`${label} range ${index + 1}: min cannot exceed max.`);
    return { id: String(range?.id || randomUUID()), ...bounds };
  });
}

export const RULE_MODES = ['funding', 'bundle'];

export function normaliseConfig(input = {}, existing = {}) {
  const name = String(input.name ?? existing.name ?? '').trim();
  // Rules written before bundle detection existed carry no mode.
  const mode = RULE_MODES.includes(input.mode ?? existing.mode) ? (input.mode ?? existing.mode) : 'funding';
  const watchAddresses = Array.isArray(input.watchAddresses ?? existing.watchAddresses)
    ? [...new Set((input.watchAddresses ?? existing.watchAddresses).map((address) => String(address).trim()).filter(Boolean))]
    : [];
  // A bundle rule has no exchange leg, so funding ranges are meaningless there;
  // its dev buy range is an optional pre-filter rather than the alert condition.
  const optional = (values, label, fallbackMin, fallbackMax) => {
    const provided = Array.isArray(values) && values.length;
    if (!provided && (fallbackMin === undefined || fallbackMin === null)) return [];
    return normaliseRanges(values, label, fallbackMin, fallbackMax);
  };
  const fundingRanges = mode === 'bundle'
    ? optional(input.fundingRanges ?? existing.fundingRanges, 'fundingRanges', input.minSol ?? existing.minSol, input.maxSol ?? existing.maxSol)
    : normaliseRanges(input.fundingRanges ?? existing.fundingRanges, 'fundingRanges', input.minSol ?? existing.minSol, input.maxSol ?? existing.maxSol);
  const devBuyRanges = mode === 'bundle'
    ? optional(input.devBuyRanges ?? existing.devBuyRanges, 'devBuyRanges', input.minDevBuy ?? existing.minDevBuy, input.maxDevBuy ?? existing.maxDevBuy)
    : normaliseRanges(input.devBuyRanges ?? existing.devBuyRanges, 'devBuyRanges', input.minDevBuy ?? existing.minDevBuy, input.maxDevBuy ?? existing.maxDevBuy);
  const timeWindowMinutes = number(input.timeWindowMinutes ?? existing.timeWindowMinutes, 'timeWindowMinutes', { min: 0, strictPositive: true });
  // Ordered: the nth entry is matched against the nth buy that follows the launch.
  const bundleSource = input.bundleBuys ?? existing.bundleBuys ?? [];
  const bundleBuys = Array.isArray(bundleSource) && bundleSource.length
    ? normaliseRanges(bundleSource, 'bundleBuys')
    : [];

  if (!name) throw new Error('A config name is required.');
  if (mode === 'funding' && !watchAddresses.length) {
    throw new Error('Add at least one exchange wallet address.');
  }
  if (mode === 'bundle' && !bundleBuys.length) {
    throw new Error('A bundle rule needs at least one bundle buy amount.');
  }

  return {
    id: existing.id ?? randomUUID(),
    name,
    mode,
    watchAddresses,
    bundleBuys,
    fundingRanges,
    devBuyRanges,
    // Kept for backward compatibility with existing JSON and third-party clients.
    minSol: fundingRanges[0]?.min ?? null,
    maxSol: fundingRanges[0]?.max ?? null,
    minDevBuy: devBuyRanges[0]?.min ?? null,
    maxDevBuy: devBuyRanges[0]?.max ?? null,
    timeWindowMinutes,
    telegramChatId: String(input.telegramChatId ?? existing.telegramChatId ?? '').trim(),
    enabled: Boolean(input.enabled ?? existing.enabled ?? true),
    createdAt: existing.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export class ConfigStore {
  constructor(storage = null) {
    this.configs = [];
    this.state = cloneDefaultState();
    this.storage = storage;
  }

  async init() {
    this.storage ??= await createStorage();
    await this.storage.init();
    const loaded = await this.storage.load();
    this.configs = loaded.configs;
    this.state = { ...cloneDefaultState(), ...loaded.state };
    this.sync();
    return this.storage.label;
  }

  // Keeps the file-backed adapter pointed at the current arrays, which are
  // replaced wholesale by the filtering operations below.
  sync() {
    this.storage.track(this.configs, this.state);
  }

  async createConfig(input) {
    const config = normaliseConfig(input);
    this.configs.unshift(config);
    this.sync();
    await this.storage.saveConfig(config);
    return config;
  }

  async updateConfig(id, input) {
    const index = this.configs.findIndex((config) => config.id === id);
    if (index === -1) return null;
    const config = normaliseConfig(input, this.configs[index]);
    this.configs[index] = config;
    this.sync();
    await this.storage.saveConfig(config);
    return config;
  }

  async deleteConfig(id) {
    const before = this.configs.length;
    this.configs = this.configs.filter((config) => config.id !== id);
    if (this.configs.length === before) return false;
    this.state.watchedWallets = this.state.watchedWallets.filter((entry) => entry.configId !== id);
    this.state.launches = this.state.launches.filter((entry) => entry.configId !== id);
    this.sync();
    await this.storage.removeConfig(id);
    return true;
  }

  getConfig(id) {
    return this.configs.find((config) => config.id === id);
  }

  activeConfigsForAddress(address) {
    return this.configs.filter((config) => config.enabled && config.mode !== 'bundle' && config.watchAddresses.includes(address));
  }

  // Bundle rules watch pump.fun launches, not exchange wallets: they must not
  // put an address into the Helius webhook, which bills per delivery.
  enabledWatchAddresses() {
    return [...new Set(this.configs
      .filter((config) => config.enabled && config.mode !== 'bundle')
      .flatMap((config) => config.watchAddresses))];
  }

  enabledBundleConfigs() {
    return this.configs.filter((config) => config.enabled && config.mode === 'bundle');
  }

  async setHeliusWebhookId(id) {
    this.state.heliusWebhookId = id;
    this.sync();
    await this.storage.setMeta('heliusWebhookId', id);
  }

  async addEvent(event) {
    const saved = { id: randomUUID(), at: new Date().toISOString(), ...event };
    this.state.events.unshift(saved);
    this.state.events = this.state.events.slice(0, HOT_EVENTS);
    this.sync();
    await this.storage.saveEvent(saved);
    return saved;
  }

  async addWatchedWallet(entry) {
    const existing = this.state.watchedWallets.find((wallet) =>
      wallet.configId === entry.configId && wallet.wallet === entry.wallet && wallet.fundingSignature === entry.fundingSignature
    );
    if (existing) return { entry: existing, created: false };
    const watched = { id: randomUUID(), createdAt: new Date().toISOString(), alertSent: false, ...entry };
    this.state.watchedWallets.unshift(watched);
    this.sync();
    await this.storage.saveWatch(watched);
    return { entry: watched, created: true };
  }

  getActiveWatch(configId, wallet, now = Date.now()) {
    return this.state.watchedWallets.find((watch) =>
      watch.configId === configId && watch.wallet === wallet && new Date(watch.expiresAt).getTime() > now && !watch.alertSent
    );
  }

  async addLaunch(launch) {
    const exists = this.state.launches.some((entry) => entry.configId === launch.configId && entry.mint === launch.mint && entry.creator === launch.creator);
    if (exists) return null;
    const saved = { id: randomUUID(), createdAt: new Date().toISOString(), ...launch };
    this.state.launches.unshift(saved);
    this.sync();
    await this.storage.saveLaunch(saved);
    return saved;
  }

  getLaunch(configId, creator, mint, now = Date.now()) {
    return this.state.launches.find((launch) =>
      launch.configId === configId && launch.creator === creator && launch.mint === mint && new Date(launch.expiresAt).getTime() > now
    );
  }

  async addAlert(alert) {
    const saved = { id: randomUUID(), at: new Date().toISOString(), ...alert };
    this.state.alerts.unshift(saved);
    this.state.alerts = this.state.alerts.slice(0, HOT_ALERTS);
    this.sync();
    await this.storage.saveAlert(saved);
    return saved;
  }

  async markAlertSent(watchId) {
    const watch = this.state.watchedWallets.find((item) => item.id === watchId);
    if (!watch) return null;
    watch.alertSent = true;
    watch.alertedAt = new Date().toISOString();
    this.sync();
    await this.storage.updateWatch(watch);
    return watch;
  }

  /**
   * Per-rule counters. Postgres answers from the full history; the file-backed
   * adapter has none, so the in-memory window is counted instead.
   */
  async stats(since = null) {
    const fromStorage = await this.storage.statsByConfig(since);
    if (fromStorage) return fromStorage;
    const floor = since ? new Date(since).getTime() : null;
    const within = (item) => !floor || new Date(item.at).getTime() >= floor;
    return Object.fromEntries(this.configs.map((config) => {
      const events = this.state.events.filter((event) => event.configId === config.id && within(event));
      return [config.id, {
        funding: events.filter((event) => event.type === 'FUNDING_MATCH').length,
        launches: events.filter((event) => event.type === 'TOKEN_CREATE').length,
        signals: this.state.alerts.filter((alert) => alert.configId === config.id && within(alert)).length,
        lastAt: events[0]?.at ?? null
      }];
    }));
  }

  async cleanup(now = Date.now()) {
    const before = this.state.watchedWallets.length + this.state.launches.length;
    this.state.watchedWallets = this.state.watchedWallets.filter((watch) => new Date(watch.expiresAt).getTime() > now && !watch.alertSent);
    this.state.launches = this.state.launches.filter((launch) => new Date(launch.expiresAt).getTime() > now);
    this.sync();
    if (before !== this.state.watchedWallets.length + this.state.launches.length) await this.storage.pruneExpired(now);
  }
}
