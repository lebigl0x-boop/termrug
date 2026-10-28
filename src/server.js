import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { ConfigStore } from './configStore.js';
import {
  HeliusParsedStream,
  accountsToObject,
  calculateBuySol,
  extractInstructions,
  getInstructionName,
  instructionArgs,
  nativeTransfers,
  solFromLamports,
  syncHeliusWebhook,
  transactionSignature,
  transactionTimestamp
} from './helius.js';
import { PumpPortalStream } from './pumpPortal.js';
import { sendTelegramAlert } from './telegram.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
const publicUrl = (process.env.PUBLIC_URL || (railwayDomain ? `https://${railwayDomain}` : `http://localhost:${port}`)).replace(/\/$/, '');
const store = new ConfigStore();
const streamStatus = { connected: false, configured: Boolean(process.env.HELIUS_API_KEY), label: 'Standby', idle: true };
const webhookStatus = { state: 'pending', reason: '', addresses: 0, url: '' };
let statsCache = {};
const pumpPortalStatus = { connected: false, configured: true, label: 'Standby', idle: true };
// Candidate launches being followed for a bundle fingerprint, keyed configId:mint.
// Short-lived by design — a few minutes each — so they stay out of storage.
const candidates = new Map();

const storageLabel = await store.init();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json({ limit: '2mb' }));

function snapshot() {
  return {
    type: 'snapshot',
    configs: store.configs,
    watchedWallets: store.state.watchedWallets,
    alerts: store.state.alerts,
    events: store.state.events,
    streamStatus,
    pumpPortalStatus,
    candidates: activeCandidates().map(({ key, ...rest }) => rest),
    webhookStatus,
    stats: statsCache,
    webhookUrl: `${publicUrl}/webhook/helius`,
    serverTime: new Date().toISOString()
  };
}

function broadcast(payload = snapshot()) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

async function event(type, payload) {
  const item = await store.addEvent({ type, ...payload });
  broadcast();
  return item;
}

function compact(address = '') {
  return address.length > 13 ? `${address.slice(0, 6)}…${address.slice(-5)}` : address;
}

function accountValue(accounts, names) {
  return names.map((name) => accounts[name]).find(Boolean) || null;
}

function inRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function matchesAnyRange(value, ranges, legacyMin, legacyMax) {
  const source = Array.isArray(ranges) && ranges.length ? ranges : [{ min: legacyMin, max: legacyMax }];
  return source.some((range) => inRange(value, range.min, range.max));
}

function heliusTransfers(transaction) {
  return nativeTransfers(transaction).map((transfer) => ({
    from: transfer.fromUserAccount ?? transfer.from ?? transfer.source,
    to: transfer.toUserAccount ?? transfer.to ?? transfer.destination,
    amount: solFromLamports(transfer.amount ?? transfer.lamports)
  })).filter((transfer) => transfer.from && transfer.to && transfer.amount !== null);
}

async function processFundingTransaction(transaction) {
  const signature = transaction.signature ?? transaction.transactionSignature ?? 'unknown';
  const transfers = heliusTransfers(transaction);
  for (const transfer of transfers) {
    for (const config of store.activeConfigsForAddress(transfer.from)) {
      if (!matchesAnyRange(transfer.amount, config.fundingRanges, config.minSol, config.maxSol)) continue;
      const now = Date.now();
      const { entry: watch, created } = await store.addWatchedWallet({
        configId: config.id,
        wallet: transfer.to,
        fundingWallet: transfer.from,
        fundingAmount: transfer.amount,
        fundingSignature: signature,
        fundedAt: transactionTimestamp(transaction),
        expiresAt: new Date(now + config.timeWindowMinutes * 60_000).toISOString()
      });
      if (!created) continue;
      syncStream('funding match');
      await event('FUNDING_MATCH', {
        configId: config.id,
        configName: config.name,
        amount: transfer.amount,
        wallet: transfer.to,
        fundingWallet: transfer.from,
        signature,
        message: `${compact(transfer.from)} funded ${compact(transfer.to)} with ${transfer.amount.toFixed(4)} SOL`,
        severity: 'info'
      });
      // `watch` is deliberately retained: a matching transfer starts a fresh independent watch.
      void watch;
    }
  }
}

async function processParsedTransaction(transaction) {
  const signature = transactionSignature(transaction);
  const transactionAt = transactionTimestamp(transaction);
  const now = Date.now();
  for (const instruction of extractInstructions(transaction)) {
    const name = getInstructionName(instruction).toLowerCase();
    if (!['create', 'create_v2', 'buy', 'buy_v2'].includes(name)) continue;
    const accounts = accountsToObject(instruction);
    const args = instructionArgs(instruction);

    if (name === 'create' || name === 'create_v2') {
      // create_v2 names the funded wallet in its args; the `user` account is the
      // same wallet but the mint keypair is the instruction signer.
      const creator = (typeof args.creator === 'string' && args.creator)
        || accountValue(accounts, ['user', 'creator', 'payer', 'authority']);
      const mint = accountValue(accounts, ['mint', 'base_mint', 'token_mint']);
      if (!creator || !mint) continue;
      for (const config of store.configs.filter((item) => item.enabled)) {
        const watch = store.getActiveWatch(config.id, creator, now);
        if (!watch) continue;
        const launch = await store.addLaunch({
          configId: config.id,
          creator,
          mint,
          tokenName: args.name ?? args.token_name ?? '',
          tokenSymbol: args.symbol ?? args.token_symbol ?? '',
          createSignature: signature,
          createdOnChainAt: transactionAt,
          expiresAt: watch.expiresAt
        });
        if (launch) {
          await event('TOKEN_CREATE', {
            configId: config.id,
            configName: config.name,
            wallet: creator,
            mint,
            signature,
            message: `${compact(creator)} created ${launch.tokenSymbol || compact(mint)}`,
            severity: 'warning'
          });
        }
      }
    }

    if (name === 'buy' || name === 'buy_v2') {
      const buyer = accountValue(accounts, ['user', 'buyer', 'payer', 'authority']);
      const mint = accountValue(accounts, ['mint', 'base_mint', 'token_mint']);
      if (!buyer || !mint) continue;
      const amount = calculateBuySol(transaction, buyer, args);
      if (amount === null) continue;
      await recordBundleBuy({ mint, amount, buyer, signature, now });

      for (const config of store.configs.filter((item) => item.enabled && item.mode !== 'bundle' && matchesAnyRange(amount, item.devBuyRanges, item.minDevBuy, item.maxDevBuy))) {
        const watch = store.getActiveWatch(config.id, buyer, now);
        const launch = store.getLaunch(config.id, buyer, mint, now);
        if (!watch || !launch) continue;

        const elapsedMs = Math.max(0, now - new Date(watch.fundedAt).getTime());
        const elapsedMinutes = Math.floor(elapsedMs / 60_000);
        const elapsedSeconds = Math.floor((elapsedMs % 60_000) / 1_000);
        const alert = await store.addAlert({
          configId: config.id,
          configName: config.name,
          wallet: buyer,
          fundingWallet: watch.fundingWallet,
          fundingAmount: watch.fundingAmount,
          fundingSignature: watch.fundingSignature,
          mint,
          tokenName: launch.tokenName,
          tokenSymbol: launch.tokenSymbol,
          devBuyAmount: amount,
          buySignature: signature,
          elapsedMs,
          elapsedLabel: `${elapsedMinutes}m ${elapsedSeconds}s`,
          telegram: 'pending'
        });

        try {
          const chatId = config.telegramChatId || process.env.TELEGRAM_CHAT_ID;
          const result = await sendTelegramAlert({ token: process.env.TELEGRAM_BOT_TOKEN, chatId, alert });
          alert.telegram = result.skipped ? 'skipped' : 'sent';
        } catch (error) {
          alert.telegram = 'failed';
          alert.telegramError = error.message;
          await event('TELEGRAM_ERROR', {
            configId: config.id,
            configName: config.name,
            wallet: buyer,
            mint,
            message: `Telegram delivery failed: ${error.message}`,
            severity: 'error'
          });
        }
        await store.markAlertSent(watch.id);
        await event('DEV_BUY_MATCH', {
          configId: config.id,
          configName: config.name,
          amount,
          wallet: buyer,
          mint,
          signature,
          message: `${launch.tokenSymbol || compact(mint)} dev buy matched at ${amount.toFixed(4)} SOL`,
          severity: 'success'
        });
      }
    }
  }
}

/**
 * The pump.fun subscription is program-wide: every create and buy on the whole
 * program is billed, and all of it is discarded unless a funded wallet is under
 * watch. Since watch windows are rare and short, the subscription is opened only
 * while at least one is open, which is where nearly all the credit spend went.
 */
function bundleWindowMs(config) {
  return Math.max(1, config.timeWindowMinutes) * 60_000;
}

/**
 * A pump.fun launch enters the funnel when its dev buy matches the rule. From
 * there the rule is an ordered fingerprint: the nth buy after the launch must
 * land inside the nth window. A single position missing its window kills the
 * candidate immediately — there is no point following a launch that already
 * broke the pattern.
 */
function handleCreation(creation) {
  const now = Date.now();
  let added = 0;
  for (const config of store.enabledBundleConfigs()) {
    if (config.devBuyRanges.length && !matchesAnyRange(creation.devBuySol, config.devBuyRanges)) continue;
    const key = `${config.id}:${creation.mint}`;
    if (candidates.has(key)) continue;
    candidates.set(key, {
      key,
      configId: config.id,
      configName: config.name,
      mint: creation.mint,
      creator: creation.creator,
      devBuySol: creation.devBuySol,
      tokenName: creation.name,
      tokenSymbol: creation.symbol,
      createSignature: creation.signature,
      expected: config.bundleBuys.length,
      startedAt: now,
      expiresAt: now + bundleWindowMs(config),
      buys: []
    });
    added += 1;
  }
  // Following a candidate means adding its mint to the Helius filter.
  if (added) syncStream('bundle candidate');
}

async function recordBundleBuy({ mint, amount, buyer, signature, now }) {
  let dropped = 0;
  for (const candidate of [...candidates.values()]) {
    if (candidate.mint !== mint) continue;
    // The dev buy rides in the creation transaction and is filtered separately.
    if (signature && signature === candidate.createSignature) continue;
    if (candidate.buys.length >= candidate.expected) continue;

    const config = store.getConfig(candidate.configId);
    if (!config || !config.enabled) { candidates.delete(candidate.key); dropped += 1; continue; }

    const position = candidate.buys.length;
    const window = config.bundleBuys[position];
    if (!inRange(amount, window.min, window.max)) {
      candidates.delete(candidate.key);
      dropped += 1;
      continue;
    }
    candidate.buys.push({ amount, buyer, signature, at: new Date(now).toISOString() });
    if (candidate.buys.length === candidate.expected) {
      candidates.delete(candidate.key);
      dropped += 1;
      await raiseBundleAlert(config, candidate, now);
    }
  }
  if (dropped) syncStream('bundle resolved');
}

async function raiseBundleAlert(config, candidate, now) {
  const elapsedMs = Math.max(0, now - candidate.startedAt);
  const amounts = candidate.buys.map((buy) => buy.amount);
  const alert = await store.addAlert({
    configId: config.id,
    configName: config.name,
    mode: 'bundle',
    wallet: candidate.creator,
    mint: candidate.mint,
    tokenName: candidate.tokenName,
    tokenSymbol: candidate.tokenSymbol,
    devBuyAmount: candidate.devBuySol,
    bundleBuys: amounts,
    bundleWallets: candidate.buys.map((buy) => buy.buyer),
    buySignature: candidate.buys[candidate.buys.length - 1]?.signature ?? '',
    fundingSignature: candidate.createSignature,
    elapsedMs,
    elapsedLabel: `${Math.floor(elapsedMs / 60_000)}m ${Math.floor((elapsedMs % 60_000) / 1_000)}s`,
    telegram: 'pending'
  });

  try {
    const chatId = config.telegramChatId || process.env.TELEGRAM_CHAT_ID;
    const result = await sendTelegramAlert({ token: process.env.TELEGRAM_BOT_TOKEN, chatId, alert });
    alert.telegram = result.skipped ? 'skipped' : 'sent';
  } catch (error) {
    alert.telegram = 'failed';
    alert.telegramError = error.message;
    await event('TELEGRAM_ERROR', { configId: config.id, configName: config.name, mint: candidate.mint, message: `Telegram delivery failed: ${error.message}`, severity: 'error' });
  }

  await event('BUNDLE_MATCH', {
    configId: config.id,
    configName: config.name,
    mint: candidate.mint,
    wallet: candidate.creator,
    amount: amounts.reduce((sum, value) => sum + value, 0),
    signature: alert.buySignature,
    message: `${candidate.tokenSymbol || compact(candidate.mint)} bundle matched — ${amounts.map((value) => value.toFixed(3)).join(' · ')} SOL`,
    severity: 'success'
  });
}

function activeCandidates(now = Date.now()) {
  return [...candidates.values()].filter((candidate) => candidate.expiresAt > now);
}

function pruneCandidates(now = Date.now()) {
  let removed = 0;
  for (const [key, candidate] of candidates) {
    if (candidate.expiresAt <= now) { candidates.delete(key); removed += 1; }
  }
  return removed;
}

// Watches belonging to a paused rule are dead weight: they would keep the
// subscription open for launches no alert could ever come from.
function activeWatchWallets(now = Date.now()) {
  const enabled = new Set(store.configs.filter((config) => config.enabled).map((config) => config.id));
  return [...new Set(store.state.watchedWallets
    .filter((watch) => !watch.alertSent && enabled.has(watch.configId) && new Date(watch.expiresAt).getTime() > now)
    .map((watch) => watch.wallet))];
}

// Both legs ride the same subscription: funded wallets for the exchange chain,
// candidate mints for bundle fingerprints.
function activeStreamAccounts(now = Date.now()) {
  return [...new Set([...activeWatchWallets(now), ...activeCandidates(now).map((candidate) => candidate.mint)])];
}

function syncStream(reason) {
  const wallets = activeStreamAccounts();
  if (!wallets.length) {
    if (!helius.running) return;
    console.log(`Parsed Stream closing (${reason}) — no wallet under watch`);
    helius.stop('Standby');
    broadcast();
    return;
  }
  if (!helius.applyAccounts(wallets)) return;
  console.log(`Parsed Stream subscribed (${reason}) — filtering on ${wallets.length} account(s)`);
  broadcast();
}

// Per-rule counters come from storage, which may hold more history than the
// in-memory window. Cached because snapshot() is synchronous and hot.
async function refreshStats() {
  try {
    statsCache = await store.stats();
  } catch (error) {
    console.error('Stats refresh failed:', error.message);
  }
}

// Keeps the account's FlowWatch webhook aligned with the enabled rules' source wallets.
async function syncWebhook(trigger) {
  try {
    const result = await syncHeliusWebhook({
      apiKey: process.env.HELIUS_API_KEY,
      publicUrl,
      addresses: store.enabledWatchAddresses(),
      webhookId: store.state.heliusWebhookId
    });
    if ((result.id ?? null) !== store.state.heliusWebhookId) await store.setHeliusWebhookId(result.id ?? null);
    Object.assign(webhookStatus, {
      state: result.status,
      reason: result.reason ?? '',
      addresses: result.accountAddresses?.length ?? 0,
      url: result.webhookURL ?? `${publicUrl}${'/webhook/helius'}`
    });
    const dropped = result.removed ? ` (${result.removed} duplicate webhook(s) removed)` : '';
    if (result.status === 'skipped') {
      console.warn(`Helius webhook not synced (${trigger}): ${result.reason}${dropped}`);
      await event('WEBHOOK_SKIPPED', { message: `Webhook inactive — ${result.reason}${dropped}`, severity: 'error' });
    } else if (result.status !== 'unchanged' || result.removed) {
      console.log(`Helius webhook ${result.status} (${trigger}): ${result.webhookURL} — ${result.accountAddresses.length} address(es)${dropped}`);
      await event('WEBHOOK_SYNCED', { message: `Webhook ${result.status} — watching ${result.accountAddresses.length} address(es)${dropped}`, severity: 'info' });
    }
  } catch (error) {
    Object.assign(webhookStatus, { state: 'error', reason: error.message });
    console.error(`Helius webhook sync failed (${trigger}):`, error.message);
    await event('WEBHOOK_ERROR', { message: `Webhook sync failed — ${error.message}`, severity: 'error' }).catch(console.error);
  }
  broadcast();
}

app.get('/api/bootstrap', (_request, response) => response.json(snapshot()));
app.get('/api/status', (_request, response) => response.json({ streamStatus, webhookUrl: `${publicUrl}/webhook/helius` }));

app.post('/api/configs', async (request, response, next) => {
  try {
    const config = await store.createConfig(request.body);
    await event('CONFIG_CREATED', { configId: config.id, configName: config.name, message: `Config “${config.name}” created`, severity: 'info' });
    await refreshStats();
    await syncWebhook('config created');
    syncPumpPortal('config created');
    response.status(201).json(config);
  } catch (error) { next(error); }
});

app.put('/api/configs/:id', async (request, response, next) => {
  try {
    const config = await store.updateConfig(request.params.id, request.body);
    if (!config) return response.status(404).json({ error: 'Config not found.' });
    await event('CONFIG_UPDATED', { configId: config.id, configName: config.name, message: `Config “${config.name}” updated`, severity: 'info' });
    await refreshStats();
    await syncWebhook('config updated');
    syncStream('config updated');
    syncPumpPortal('config updated');
    response.json(config);
  } catch (error) { next(error); }
});

app.delete('/api/configs/:id', async (request, response, next) => {
  try {
    const config = store.getConfig(request.params.id);
    if (!await store.deleteConfig(request.params.id)) return response.status(404).json({ error: 'Config not found.' });
    await event('CONFIG_DELETED', { configId: request.params.id, configName: config?.name || 'Deleted config', message: `Config “${config?.name || ''}” deleted`, severity: 'info' });
    await refreshStats();
    await syncWebhook('config deleted');
    syncStream('config deleted');
    syncPumpPortal('config deleted');
    response.status(204).end();
  } catch (error) { next(error); }
});

// Configure this exact URL as an Enhanced transaction webhook in the Helius dashboard.
app.post('/webhook/helius', async (request, response, next) => {
  try {
    const transactions = Array.isArray(request.body) ? request.body : [request.body];
    for (const transaction of transactions) await processFundingTransaction(transaction);
    response.status(200).json({ ok: true, received: transactions.length });
  } catch (error) { next(error); }
});

app.use(express.static(path.join(root, 'public')));
app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(400).json({ error: error.message || 'Unexpected server error.' });
});

wss.on('connection', (socket) => socket.send(JSON.stringify(snapshot())));

const pumpPortal = new PumpPortalStream({
  url: process.env.PUMPPORTAL_URL,
  apiKey: process.env.PUMPPORTAL_API_KEY,
  onCreation: (creation) => {
    try { handleCreation(creation); } catch (error) { console.error('Creation handling failed:', error.message); }
  },
  onStatus: (status) => { Object.assign(pumpPortalStatus, status); broadcast(); },
  onError: (error) => console.error('PumpPortal:', error.message)
});

function syncPumpPortal(reason) {
  const needed = store.enabledBundleConfigs().length > 0;
  if (needed === pumpPortal.running) return;
  if (needed) {
    console.log(`PumpPortal opening (${reason})`);
    pumpPortal.start();
  } else {
    console.log(`PumpPortal closing (${reason}) — no bundle rule enabled`);
    candidates.clear();
    pumpPortal.stop('Standby');
  }
  broadcast();
}

const helius = new HeliusParsedStream({
  apiKey: process.env.HELIUS_API_KEY,
  url: process.env.PARSED_STREAM_URL,
  onTransaction: (transaction) => processParsedTransaction(transaction).catch((error) => event('STREAM_ERROR', { message: error.message, severity: 'error' })),
  onStatus: (status) => { Object.assign(streamStatus, status); broadcast(); },
  onError: (error) => event('STREAM_ERROR', { message: `Parsed Stream: ${error.message}`, severity: 'error' }).catch(console.error)
});

setInterval(() => store.cleanup().then(() => { if (pruneCandidates()) syncStream('candidate expiry'); syncStream('cleanup'); broadcast(); }).catch(console.error), 30_000).unref();
setInterval(() => refreshStats().then(() => broadcast()).catch(console.error), 15_000).unref();
syncStream('startup');
syncPumpPortal('startup');

server.listen(port, () => {
  console.log(`Solana Exchange Scanner listening on ${publicUrl}`);
  console.log(`Helius webhook: ${publicUrl}/webhook/helius`);
  console.log(`Storage: ${storageLabel}`);
  refreshStats().catch(console.error);
  syncWebhook('startup').catch(console.error);
});

function shutdown() {
  helius.stop();
  pumpPortal.stop();
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
