import WebSocket from 'ws';

export const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const INSTRUCTIONS = ['create', 'create_v2', 'buy', 'buy_v2'];

export class HeliusParsedStream {
  constructor({ apiKey, url, onTransaction, onStatus, onError }) {
    this.apiKey = apiKey;
    this.url = url || `wss://beta.helius-rpc.com/?api-key=${encodeURIComponent(apiKey || '')}`;
    this.onTransaction = onTransaction;
    this.onStatus = onStatus;
    this.onError = onError;
    this.socket = null;
    this.retry = null;
    this.stopped = true;
    this.retryDelay = 1000;
  }

  // True between start() and stop(), regardless of socket state, so callers can
  // decide whether the subscription needs opening or closing.
  get running() {
    return !this.stopped;
  }

  start() {
    this.stopped = false;
    if (!this.apiKey) {
      this.onStatus?.({ connected: false, configured: false, label: 'API key missing' });
      return;
    }
    this.connect();
  }

  connect() {
    if (this.stopped || !this.apiKey) return;
    this.onStatus?.({ connected: false, configured: true, label: 'Connecting' });
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on('open', () => {
      this.retryDelay = 1000;
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'parsedTransactionSubscribe',
        params: [{
          programs: [PUMP_FUN_PROGRAM],
          instructionNames: INSTRUCTIONS,
          includeCpi: true,
          includeFailed: false
        }]
      }));
      this.onStatus?.({ connected: true, configured: true, label: 'Live' });
    });

    socket.on('message', (payload) => {
      try {
        const parsed = JSON.parse(payload.toString());
        if (parsed.error) throw new Error(parsed.error.message || 'Helius subscription error');
        // The subscription ack carries a numeric `result`; only notifications
        // carry a transaction, nested as params.result.value.
        if (parsed.method !== 'parsedTransactionNotification') return;
        const value = parsed?.params?.result?.value ?? parsed?.params?.result;
        if (value && typeof value === 'object') this.onTransaction?.(value);
      } catch (error) {
        this.onError?.(error);
      }
    });

    socket.on('error', (error) => this.onError?.(error));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    clearTimeout(this.retry);
    this.onStatus?.({ connected: false, configured: true, label: 'Reconnecting' });
    this.retry = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
  }

  stop(label = 'Offline') {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close();
    this.onStatus?.({ connected: false, configured: Boolean(this.apiKey), label, idle: label === 'Standby' });
  }
}

export function solFromLamports(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number / 1_000_000_000 : null;
}

export function extractInstructions(transaction) {
  return transaction?.instructions ?? transaction?.transaction?.instructions ?? transaction?.data?.instructions ?? [];
}

export function accountsToObject(instruction = {}) {
  const source = instruction.decoded?.accounts ?? instruction.accounts ?? instruction.parsed?.accounts ?? [];
  if (Array.isArray(source)) {
    return Object.fromEntries(source
      .filter((account) => account?.name && (account.pubkey || account.address))
      .map((account) => [account.name, account.pubkey || account.address]));
  }
  return source || {};
}

export function instructionArgs(instruction = {}) {
  return instruction.decoded?.args ?? instruction.args ?? instruction.parsed?.args ?? {};
}

export function transactionSignature(transaction = {}) {
  return transaction.signature ?? transaction.transaction?.signature ?? transaction.transactionSignature ?? 'unknown';
}

export function transactionTimestamp(transaction = {}) {
  const value = transaction.timestamp ?? transaction.blockTime ?? transaction.transaction?.blockTime ?? transaction.transaction?.timestamp;
  if (!value) return new Date().toISOString();
  const milliseconds = Number(value) < 10_000_000_000 ? Number(value) * 1000 : Number(value);
  return new Date(milliseconds).toISOString();
}

export function nativeTransfers(transaction = {}) {
  return transaction.nativeTransfers ?? transaction.native_transfers ?? transaction.transaction?.nativeTransfers ?? [];
}

export function getInstructionName(instruction = {}) {
  return instruction.instructionName ?? instruction.name ?? instruction.parsed?.instructionName ?? '';
}

export function calculateBuySol(transaction, buyer, args = {}) {
  const transfers = nativeTransfers(transaction)
    .filter((transfer) => (transfer.fromUserAccount ?? transfer.from) === buyer)
    .map((transfer) => solFromLamports(transfer.amount ?? transfer.lamports))
    .filter((amount) => amount !== null);
  if (transfers.length) return Math.max(...transfers);

  const amount = args.sol_amount ?? args.solAmount ?? args.max_sol_cost ?? args.maxSolCost ??
    args.max_quote_amount_in ?? args.maxQuoteAmountIn ?? args.spendable_quote_in ?? args.quote_amount_in;
  return solFromLamports(amount);
}

const WEBHOOK_API = 'https://api.helius.xyz/v0/webhooks';
export const WEBHOOK_PATH = '/webhook/helius';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];

export function isPubliclyReachable(url) {
  try {
    const { hostname } = new URL(url);
    return !LOCAL_HOSTS.includes(hostname) && !hostname.endsWith('.local');
  } catch {
    return false;
  }
}

async function webhookRequest(method, suffix, apiKey, body) {
  const response = await fetch(`${WEBHOOK_API}${suffix}?api-key=${encodeURIComponent(apiKey)}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let payload = text;
  try { payload = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
  if (!response.ok) {
    const detail = typeof payload === 'string' ? payload : payload?.error ?? JSON.stringify(payload);
    const error = new Error(`Helius webhook API ${response.status}: ${detail}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

// Owns exactly one webhook, tracked by the id stored in state.json. Any other
// webhook on the account (other projects) is never read, updated or deleted.
export async function syncHeliusWebhook({ apiKey, publicUrl, addresses, webhookId }) {
  if (!apiKey) return { status: 'skipped', reason: 'HELIUS_API_KEY is missing.' };
  if (!isPubliclyReachable(publicUrl)) {
    return { status: 'skipped', reason: `PUBLIC_URL (${publicUrl}) is not reachable from the internet, so Helius cannot deliver funding transfers.` };
  }

  const accountAddresses = [...new Set(addresses.filter(Boolean))];
  const webhookURL = `${publicUrl}${WEBHOOK_PATH}`;
  if (!accountAddresses.length) {
    return { status: 'skipped', reason: 'No enabled rule declares a source wallet.' };
  }

  let existing = null;
  if (webhookId) {
    try {
      existing = await webhookRequest('GET', `/${webhookId}`, apiKey);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  const desired = { webhookURL, webhookType: 'enhanced', transactionTypes: ['TRANSFER'], accountAddresses };

  if (!existing) {
    const created = await webhookRequest('POST', '', apiKey, desired);
    return { status: 'created', id: created.webhookID ?? created.webhookId, webhookURL, accountAddresses };
  }

  const sameUrl = existing.webhookURL === webhookURL;
  const sameAddresses = [...(existing.accountAddresses ?? [])].sort().join() === [...accountAddresses].sort().join();
  if (sameUrl && sameAddresses) {
    return { status: 'unchanged', id: webhookId, webhookURL, accountAddresses };
  }

  await webhookRequest('PUT', `/${webhookId}`, apiKey, desired);
  return { status: 'updated', id: webhookId, webhookURL, accountAddresses };
}
