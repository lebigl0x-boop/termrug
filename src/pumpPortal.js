import WebSocket from 'ws';

const DEFAULT_URL = 'wss://pumpportal.fun/api/data';

/**
 * Streams every pump.fun token creation from PumpPortal.
 *
 * `subscribeNewToken` is free and needs no API key, which is the whole point:
 * the same coverage through Helius means subscribing to the entire pump.fun
 * program and paying a credit per delivered transaction. Creation events already
 * carry the dev buy (`solAmount`), so a bundle rule can filter candidates here
 * and only pay for the few mints worth following.
 *
 * `subscribeTokenTrade` is deliberately not used: it is metered and requires a
 * funded API key, while the Helius subscription can already be filtered down to
 * a candidate mint with the `accounts` filter.
 */
export class PumpPortalStream {
  constructor({ url, apiKey, onCreation, onStatus, onError } = {}) {
    this.url = url || (apiKey ? `${DEFAULT_URL}?api-key=${encodeURIComponent(apiKey)}` : DEFAULT_URL);
    this.onCreation = onCreation;
    this.onStatus = onStatus;
    this.onError = onError;
    this.socket = null;
    this.retry = null;
    this.stopped = true;
    this.retryDelay = 1000;
  }

  get running() {
    return !this.stopped;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    this.onStatus?.({ connected: false, configured: true, label: 'Connecting' });
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on('open', () => {
      this.retryDelay = 1000;
      socket.send(JSON.stringify({ method: 'subscribeNewToken' }));
      this.onStatus?.({ connected: true, configured: true, label: 'Live' });
    });

    socket.on('message', (payload) => {
      try {
        const event = JSON.parse(payload.toString());
        // Subscription acknowledgements and quota notices arrive as { message }.
        if (event.message) return;
        if (event.txType !== 'create' || !event.mint) return;
        this.onCreation?.({
          mint: event.mint,
          creator: event.traderPublicKey,
          signature: event.signature,
          devBuySol: Number(event.solAmount) || 0,
          devBuyTokens: Number(event.initialBuy) || 0,
          marketCapSol: Number(event.marketCapSol) || 0,
          name: event.name ?? '',
          symbol: event.symbol ?? '',
          pool: event.pool ?? 'pump'
        });
      } catch (error) {
        this.onError?.(error);
      }
    });

    socket.on('error', (error) => this.onError?.(error));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    clearTimeout(this.retry);
    this.onStatus?.({ connected: false, configured: true, label: 'Reconnecting' });
    this.retry = setTimeout(() => this.connect(), this.retryDelay);
    // PumpPortal bans clients that reconnect in a tight loop, so back off hard.
    this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
  }

  stop(label = 'Offline') {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close();
    this.socket = null;
    this.onStatus?.({ connected: false, configured: true, label, idle: label === 'Standby' });
  }
}
