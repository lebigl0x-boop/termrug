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
    this.accounts = [];
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
          // One group, OR semantics: deliver only transactions touching a watched
          // wallet. Without it the whole pump.fun firehose is delivered and billed.
          ...(this.accounts.length ? { accounts: [this.accounts] } : {}),
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
      // A socket replaced by resubscribe() is no longer ours: ignore its close.
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    clearTimeout(this.retry);
    this.onStatus?.({ connected: false, configured: true, label: 'Reconnecting' });
    this.retry = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
  }

  /**
   * Points the subscription at `accounts`, starting or re-subscribing as needed.
   * Returns true when something actually changed.
   */
  applyAccounts(accounts) {
    const next = [...new Set(accounts)].sort();
    const unchanged = this.running
      && next.length === this.accounts.length
      && next.every((account, index) => account === this.accounts[index]);
    if (unchanged) return false;
    this.accounts = next;
    if (this.running) this.resubscribe();
    else this.start();
    return true;
  }

  // The filter is fixed at subscribe time, so a changed account set means a new
  // connection rather than a second subscription on the same socket.
  resubscribe() {
    clearTimeout(this.retry);
    this.retryDelay = 1000;
    const previous = this.socket;
    this.socket = null;
    previous?.close();
    this.connect();
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

// Reconciles the Helius account against the enabled rules. Every webhook whose
// URL is this app's own endpoint is treated as ours — that is what makes the
// sync idempotent after the stored id is lost, instead of creating a duplicate
// that silently doubles delivery billing. Webhooks pointing anywhere else
// (other projects on the same Helius account) are never read or touched.
export async function syncHeliusWebhook({ apiKey, publicUrl, addresses, webhookId, needed = true }) {
  // Checked before anything else: a setup with no exchange-funding rule is not
  // broken for lacking a webhook, whatever the key or the URL look like.
  if (!needed) {
    let removed = 0;
    if (apiKey && isPubliclyReachable(publicUrl)) {
      const webhookURL = `${publicUrl}${WEBHOOK_PATH}`;
      const all = await webhookRequest('GET', '', apiKey);
      const ours = (Array.isArray(all) ? all : []).filter((hook) => hook.webhookURL === webhookURL);
      for (const hook of ours) await webhookRequest('DELETE', `/${hook.webhookID}`, apiKey);
      removed = ours.length;
    }
    return { status: 'skipped', needed: false, id: null, removed, reason: 'No exchange-funding rule is enabled, so no webhook is needed.' };
  }
  if (!apiKey) return { status: 'skipped', reason: 'HELIUS_API_KEY is missing.' };
  if (!isPubliclyReachable(publicUrl)) {
    return { status: 'skipped', reason: `PUBLIC_URL (${publicUrl}) is not reachable from the internet, so Helius cannot deliver funding transfers.` };
  }

  const webhookURL = `${publicUrl}${WEBHOOK_PATH}`;
  const accountAddresses = [...new Set(addresses.filter(Boolean))];
  const all = await webhookRequest('GET', '', apiKey);
  const ours = (Array.isArray(all) ? all : []).filter((hook) => hook.webhookURL === webhookURL);

  // No enabled rule means no address to watch. Leaving the webhook registered
  // would keep Helius delivering — and billing — transfers nothing can act on.
  if (!accountAddresses.length) {
    for (const hook of ours) await webhookRequest('DELETE', `/${hook.webhookID}`, apiKey);
    // `needed` tells apart a rule that wants a webhook and cannot have one from
    // a setup that simply does not use webhooks — bundle rules never do.
    return { status: 'skipped', id: null, removed: ours.length, reason: 'No enabled rule declares a source wallet.' };
  }

  const keep = ours.find((hook) => hook.webhookID === webhookId) ?? ours[0] ?? null;
  for (const hook of ours) {
    if (hook.webhookID !== keep?.webhookID) await webhookRequest('DELETE', `/${hook.webhookID}`, apiKey);
  }
  const removed = Math.max(0, ours.length - 1);
  const desired = { webhookURL, webhookType: 'enhanced', transactionTypes: ['TRANSFER'], accountAddresses };

  if (!keep) {
    const created = await webhookRequest('POST', '', apiKey, desired);
    return { status: 'created', id: created.webhookID ?? created.webhookId, webhookURL, accountAddresses, removed };
  }

  // The list endpoint omits accountAddresses, so the comparison needs a read by id.
  const current = await webhookRequest('GET', `/${keep.webhookID}`, apiKey);
  const sameAddresses = [...(current.accountAddresses ?? [])].sort().join() === [...accountAddresses].sort().join();
  if (sameAddresses && !removed) {
    return { status: 'unchanged', id: keep.webhookID, webhookURL, accountAddresses, removed };
  }
  await webhookRequest('PUT', `/${keep.webhookID}`, apiKey, desired);
  return { status: 'updated', id: keep.webhookID, webhookURL, accountAddresses, removed };
}
