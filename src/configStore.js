import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const configsPath = path.join(dataDirectory, 'configs.json');
const statePath = path.join(dataDirectory, 'state.json');
const DEFAULT_STATE = { watchedWallets: [], launches: [], alerts: [], events: [], heliusWebhookId: null };

function cloneDefaultState() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

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

function number(value, field, { min = 0, strictPositive = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (strictPositive ? parsed <= min : parsed < min)) {
    throw new Error(`${field} must be a valid ${strictPositive ? 'positive' : 'non-negative'} number.`);
  }
  return parsed;
}

function normaliseRanges(values, label, fallbackMin, fallbackMax) {
  const source = Array.isArray(values) && values.length ? values : [{ min: fallbackMin, max: fallbackMax }];
  return source.map((range, index) => {
    const min = number(range?.min, `${label}[${index}].min`);
    const max = number(range?.max, `${label}[${index}].max`);
    if (min > max) throw new Error(`${label} range ${index + 1}: min cannot exceed max.`);
    return { id: String(range?.id || randomUUID()), min, max };
  });
}

export function normaliseConfig(input = {}, existing = {}) {
  const name = String(input.name ?? existing.name ?? '').trim();
  const watchAddresses = Array.isArray(input.watchAddresses ?? existing.watchAddresses)
    ? [...new Set((input.watchAddresses ?? existing.watchAddresses).map((address) => String(address).trim()).filter(Boolean))]
    : [];
  const fundingRanges = normaliseRanges(
    input.fundingRanges ?? existing.fundingRanges,
    'fundingRanges',
    input.minSol ?? existing.minSol,
    input.maxSol ?? existing.maxSol
  );
  const devBuyRanges = normaliseRanges(
    input.devBuyRanges ?? existing.devBuyRanges,
    'devBuyRanges',
    input.minDevBuy ?? existing.minDevBuy,
    input.maxDevBuy ?? existing.maxDevBuy
  );
  const timeWindowMinutes = number(input.timeWindowMinutes ?? existing.timeWindowMinutes, 'timeWindowMinutes', { min: 0, strictPositive: true });

  if (!name) throw new Error('A config name is required.');
  if (!watchAddresses.length) throw new Error('Add at least one exchange wallet address.');

  return {
    id: existing.id ?? randomUUID(),
    name,
    watchAddresses,
    fundingRanges,
    devBuyRanges,
    // Kept for backward compatibility with existing JSON and third-party clients.
    minSol: fundingRanges[0].min,
    maxSol: fundingRanges[0].max,
    minDevBuy: devBuyRanges[0].min,
    maxDevBuy: devBuyRanges[0].max,
    timeWindowMinutes,
    telegramChatId: String(input.telegramChatId ?? existing.telegramChatId ?? '').trim(),
    enabled: Boolean(input.enabled ?? existing.enabled ?? true),
    createdAt: existing.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export class ConfigStore {
  constructor() {
    this.configs = [];
    this.state = cloneDefaultState();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(dataDirectory, { recursive: true });
    this.configs = await readJson(configsPath, []);
    this.state = { ...cloneDefaultState(), ...(await readJson(statePath, cloneDefaultState())) };
    this.state.watchedWallets = Array.isArray(this.state.watchedWallets) ? this.state.watchedWallets : [];
    this.state.launches = Array.isArray(this.state.launches) ? this.state.launches : [];
    this.state.alerts = Array.isArray(this.state.alerts) ? this.state.alerts : [];
    this.state.events = Array.isArray(this.state.events) ? this.state.events : [];
    await this.persistAll();
  }

  queueWrite(operation) {
    this.writeQueue = this.writeQueue.then(operation, operation);
    return this.writeQueue;
  }

  persistConfigs() {
    return this.queueWrite(() => writeJson(configsPath, this.configs));
  }

  persistState() {
    return this.queueWrite(() => writeJson(statePath, this.state));
  }

  persistAll() {
    return this.queueWrite(async () => {
      await writeJson(configsPath, this.configs);
      await writeJson(statePath, this.state);
    });
  }

  async createConfig(input) {
    const config = normaliseConfig(input);
    this.configs.unshift(config);
    await this.persistConfigs();
    return config;
  }

  async updateConfig(id, input) {
    const index = this.configs.findIndex((config) => config.id === id);
    if (index === -1) return null;
    const config = normaliseConfig(input, this.configs[index]);
    this.configs[index] = config;
    await this.persistConfigs();
    return config;
  }

  async deleteConfig(id) {
    const before = this.configs.length;
    this.configs = this.configs.filter((config) => config.id !== id);
    if (this.configs.length === before) return false;
    this.state.watchedWallets = this.state.watchedWallets.filter((entry) => entry.configId !== id);
    this.state.launches = this.state.launches.filter((entry) => entry.configId !== id);
    await this.persistAll();
    return true;
  }

  getConfig(id) {
    return this.configs.find((config) => config.id === id);
  }

  activeConfigsForAddress(address) {
    return this.configs.filter((config) => config.enabled && config.watchAddresses.includes(address));
  }

  enabledWatchAddresses() {
    return [...new Set(this.configs.filter((config) => config.enabled).flatMap((config) => config.watchAddresses))];
  }

  async setHeliusWebhookId(id) {
    this.state.heliusWebhookId = id;
    await this.persistState();
  }

  async addEvent(event) {
    this.state.events.unshift({ id: randomUUID(), at: new Date().toISOString(), ...event });
    this.state.events = this.state.events.slice(0, 400);
    await this.persistState();
    return this.state.events[0];
  }

  async addWatchedWallet(entry) {
    const existing = this.state.watchedWallets.find((wallet) =>
      wallet.configId === entry.configId && wallet.wallet === entry.wallet && wallet.fundingSignature === entry.fundingSignature
    );
    if (existing) return { entry: existing, created: false };
    const watched = { id: randomUUID(), createdAt: new Date().toISOString(), alertSent: false, ...entry };
    this.state.watchedWallets.unshift(watched);
    await this.persistState();
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
    this.state.launches = this.state.launches.slice(0, 300);
    await this.persistState();
    return saved;
  }

  getLaunch(configId, creator, mint, now = Date.now()) {
    return this.state.launches.find((launch) =>
      launch.configId === configId && launch.creator === creator && launch.mint === mint && new Date(launch.expiresAt).getTime() > now
    );
  }

  async addAlert(alert) {
    this.state.alerts.unshift({ id: randomUUID(), at: new Date().toISOString(), ...alert });
    this.state.alerts = this.state.alerts.slice(0, 200);
    await this.persistState();
    return this.state.alerts[0];
  }

  async markAlertSent(watchId) {
    const watch = this.state.watchedWallets.find((item) => item.id === watchId);
    if (!watch) return null;
    watch.alertSent = true;
    watch.alertedAt = new Date().toISOString();
    await this.persistState();
    return watch;
  }

  async cleanup(now = Date.now()) {
    const before = this.state.watchedWallets.length + this.state.launches.length;
    this.state.watchedWallets = this.state.watchedWallets.filter((watch) => new Date(watch.expiresAt).getTime() > now && !watch.alertSent);
    this.state.launches = this.state.launches.filter((launch) => new Date(launch.expiresAt).getTime() > now);
    if (before !== this.state.watchedWallets.length + this.state.launches.length) await this.persistState();
  }
}
