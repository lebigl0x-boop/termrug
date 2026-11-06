import { randomUUID } from 'node:crypto';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { heliusRpcUrl } from './helius.js';

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TRADE_LOCAL_URL = 'https://pumpportal.fun/api/trade-local';
const LAMPORTS_PER_SOL = 1_000_000_000;
// Every pump.fun mint is created with 6 decimals.
const TOKEN_UNITS = 1_000_000;

const POLL_INTERVAL_MS = 2_500;
const CONFIRM_ATTEMPTS = 40;
const CONFIRM_DELAY_MS = 750;
const FILL_ATTEMPTS = 6;
// A curve that cannot be read is usually a mint that just migrated and had its
// account closed. Exiting on the first miss would churn on a transient RPC
// hiccup, so a position is only force-closed once reads fail consistently.
const MAX_PRICE_FAILURES = 6;
const MAX_SELL_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const curveAddresses = new Map();

export function bondingCurveAddress(mint) {
  let address = curveAddresses.get(mint);
  if (!address) {
    [address] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP_PROGRAM);
    curveAddresses.set(mint, address);
  }
  return address;
}

/**
 * Price straight from the bonding curve account.
 *
 * The curve is the market for a pre-migration pump.fun token, so its virtual
 * reserves are the price — no quote endpoint, no indexing delay, readable the
 * second the mint exists. Once `complete` flips the curve is frozen and the real
 * market has moved to a pool, which is why that flag forces an exit rather than
 * being read as a flat price.
 *
 * Layout: 8 discriminator, virtualTokenReserves u64, virtualSolReserves u64,
 * realTokenReserves u64, realSolReserves u64, tokenTotalSupply u64, complete u8.
 */
export function decodeBondingCurve(data) {
  if (!data || data.length < 49) return null;
  const buffer = Buffer.from(data);
  const virtualTokenReserves = Number(buffer.readBigUInt64LE(8));
  const virtualSolReserves = Number(buffer.readBigUInt64LE(16));
  const complete = buffer.readUInt8(48) === 1;
  if (!virtualTokenReserves || !virtualSolReserves) return { priceSol: null, complete };
  return {
    priceSol: (virtualSolReserves / LAMPORTS_PER_SOL) / (virtualTokenReserves / TOKEN_UNITS),
    complete
  };
}

async function requestTradeTransaction(payload) {
  const response = await fetch(TRADE_LOCAL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`PumpPortal answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (!body.length) throw new Error('PumpPortal returned an empty transaction.');
  return VersionedTransaction.deserialize(body);
}

/**
 * The engine owns every order and every open position.
 *
 * Nothing here trusts a rule blindly: the per-rule buy amount is clamped by a
 * server-side ceiling, a mint is never bought twice at once, and until the
 * deployment is explicitly armed each order is simulated against the live curve
 * instead of signed — which makes a misconfigured rule visible before it costs
 * anything.
 */
export class TradeEngine {
  constructor({
    apiKey = process.env.HELIUS_API_KEY,
    wallet = { keypair: null, publicKey: null, reason: '' },
    dryRun = true,
    maxBuySol = 0.5,
    maxOpenPositions = 5,
    onUpdate = () => {},
    onEvent = async () => {}
  } = {}) {
    this.wallet = wallet;
    this.dryRun = dryRun;
    this.maxBuySol = maxBuySol;
    this.maxOpenPositions = maxOpenPositions;
    this.onUpdate = onUpdate;
    this.onEvent = onEvent;
    this.positions = [];
    this.timer = null;
    this.ticking = false;
    this.connection = apiKey ? new Connection(heliusRpcUrl(apiKey), { commitment: 'confirmed' }) : null;
    this.reason = apiKey ? wallet.reason : 'HELIUS_API_KEY is not set.';
  }

  get configured() {
    return Boolean(this.connection && this.wallet.keypair);
  }

  // Armed means orders are signed and broadcast. Everything else is a dry run.
  get armed() {
    return this.configured && !this.dryRun;
  }

  status() {
    return {
      configured: this.configured,
      armed: this.armed,
      dryRun: this.dryRun,
      publicKey: this.wallet.publicKey,
      reason: this.reason,
      maxBuySol: this.maxBuySol,
      maxOpenPositions: this.maxOpenPositions,
      open: this.openPositions().length
    };
  }

  openPositions() {
    return this.positions.filter((position) => position.status === 'open' || position.status === 'opening' || position.status === 'closing');
  }

  /**
   * Positions reloaded from storage keep being managed. An order caught
   * mid-flight by a restart cannot be resumed — its on-chain outcome is
   * unknown — so it is retired explicitly rather than left to look open.
   * Entries are mutated in place because storage mirrors the same objects —
   * the arrays are independent, the records inside them are not.
   */
  adopt(positions = []) {
    this.positions = [...positions];
    for (const position of positions) {
      if (position.status !== 'opening' && position.status !== 'closing') continue;
      const leg = position.status === 'opening' ? 'buying' : 'selling';
      position.status = 'failed';
      position.error = `Interrupted by a restart while ${leg} — check the wallet on chain.`;
      this.onUpdate(position);
    }
    if (this.positions.some((position) => position.status === 'open')) this.start();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch((error) => console.error('Trade engine tick failed:', error.message)); }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // Settled positions are kept only as a short visible history; live ones never
  // age out, however long they stay open.
  prune(keepSettled = 100) {
    const settled = (position) => position.status === 'closed' || position.status === 'failed';
    this.positions = [...this.positions.filter((position) => !settled(position)), ...this.positions.filter(settled).slice(0, keepSettled)];
  }

  holdsMint(mint) {
    return this.positions.some((position) => position.mint === mint && (position.status === 'open' || position.status === 'opening' || position.status === 'closing'));
  }

  async readCurve(mint) {
    const info = await this.connection.getAccountInfo(bondingCurveAddress(mint), 'processed');
    return info ? decodeBondingCurve(info.data) : null;
  }

  async confirm(signature) {
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
      await sleep(CONFIRM_DELAY_MS);
      const { value } = await this.connection.getSignatureStatuses([signature]);
      const status = value?.[0];
      if (!status) continue;
      if (status.err) throw new Error(`Transaction failed on chain: ${JSON.stringify(status.err).slice(0, 120)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return;
    }
    throw new Error('Transaction was not confirmed in time.');
  }

  /**
   * What the order actually filled at, read back from the confirmed
   * transaction. The network and priority fees are removed from the SOL leg so
   * the cost basis is the swap itself — otherwise a fixed fee would distort the
   * entry price of a small buy enough to move the take-profit by several points.
   */
  async readFill(signature, mint) {
    const owner = this.wallet.publicKey;
    for (let attempt = 0; attempt < FILL_ATTEMPTS; attempt += 1) {
      if (attempt) await sleep(CONFIRM_DELAY_MS);
      const transaction = await this.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
      const meta = transaction?.meta;
      if (!meta) continue;
      const balance = (list) => (list ?? []).find((entry) => entry.mint === mint && entry.owner === owner);
      const before = Number(balance(meta.preTokenBalances)?.uiTokenAmount?.amount ?? 0);
      const after = Number(balance(meta.postTokenBalances)?.uiTokenAmount?.amount ?? 0);
      const feeLamports = Number(meta.fee ?? 0);
      // The signer always pays, so it is the first account in the message.
      const lamportsDelta = Number(meta.postBalances?.[0] ?? 0) - Number(meta.preBalances?.[0] ?? 0);
      return {
        tokens: (after - before) / TOKEN_UNITS,
        solDelta: (lamportsDelta + feeLamports) / LAMPORTS_PER_SOL
      };
    }
    return null;
  }

  async submit(payload) {
    const transaction = await requestTradeTransaction({ ...payload, publicKey: this.wallet.publicKey, pool: 'auto' });
    transaction.sign([this.wallet.keypair]);
    const signature = await this.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 3 });
    await this.confirm(signature);
    return signature;
  }

  /**
   * Turns a confirmed signal into a position. Returns null — without raising —
   * whenever a guard declines the order, because a declined buy is a normal
   * outcome of a running scanner, not an error in the detection path.
   */
  async open({ config, mint, tokenName = '', tokenSymbol = '', alertId = null, trigger = '' }) {
    const rule = config.autoBuy;
    if (!rule?.enabled) return null;
    if (!this.connection) { await this.decline(config, mint, 'HELIUS_API_KEY is not set.'); return null; }
    if (!this.dryRun && !this.wallet.keypair) { await this.decline(config, mint, this.wallet.reason || 'No trading key is configured.'); return null; }
    if (this.holdsMint(mint)) return null;
    if (this.openPositions().length >= this.maxOpenPositions) {
      await this.decline(config, mint, `Position limit reached (${this.maxOpenPositions} open).`);
      return null;
    }

    const amountSol = Math.min(rule.amountSol, this.maxBuySol);
    const position = {
      id: randomUUID(),
      configId: config.id,
      configName: config.name,
      mint,
      tokenName,
      tokenSymbol,
      trigger,
      alertId,
      status: 'opening',
      dryRun: !this.armed,
      amountSol,
      clamped: amountSol < rule.amountSol,
      slippagePercent: rule.slippagePercent,
      priorityFeeSol: rule.priorityFeeSol,
      takeProfitPercent: rule.takeProfitPercent,
      stopLossPercent: rule.stopLossPercent,
      maxHoldMinutes: rule.maxHoldMinutes,
      openedAt: new Date().toISOString(),
      entryPriceSol: null,
      tokenAmount: 0,
      costSol: 0,
      buySignature: '',
      lastPriceSol: null,
      lastPriceAt: null,
      pnlPercent: 0,
      priceFailures: 0,
      sellAttempts: 0,
      closedAt: null,
      exitPriceSol: null,
      exitReason: '',
      sellSignature: '',
      proceedsSol: 0,
      realisedPnlPercent: 0,
      error: ''
    };
    this.positions.unshift(position);
    this.prune();
    this.onUpdate(position);

    try {
      if (position.dryRun) {
        const curve = await this.readCurve(mint);
        if (!curve?.priceSol) throw new Error('No bonding curve price is available for this mint.');
        position.entryPriceSol = curve.priceSol;
        position.tokenAmount = amountSol / curve.priceSol;
        position.costSol = amountSol;
      } else {
        position.buySignature = await this.submit({
          action: 'buy',
          mint,
          amount: amountSol,
          denominatedInSol: 'true',
          slippage: position.slippagePercent,
          priorityFee: position.priorityFeeSol
        });
        const fill = await this.readFill(position.buySignature, mint);
        if (!fill || fill.tokens <= 0) throw new Error('The buy confirmed but no token balance change could be read.');
        position.tokenAmount = fill.tokens;
        position.costSol = Math.abs(fill.solDelta);
        position.entryPriceSol = position.costSol / fill.tokens;
      }
      position.status = 'open';
      position.lastPriceSol = position.entryPriceSol;
      position.lastPriceAt = new Date().toISOString();
      this.onUpdate(position);
      await this.onEvent('AUTO_BUY_FILLED', {
        configId: config.id,
        configName: config.name,
        mint,
        wallet: this.wallet.publicKey ?? '',
        amount: position.costSol,
        signature: position.buySignature,
        message: `${position.dryRun ? 'Simulated buy' : 'Bought'} ${tokenSymbol || mint.slice(0, 6)} for ${position.costSol.toFixed(4)} SOL`,
        severity: position.dryRun ? 'info' : 'success'
      });
      this.start();
      return position;
    } catch (error) {
      position.status = 'failed';
      position.error = error.message;
      this.onUpdate(position);
      await this.onEvent('AUTO_BUY_FAILED', {
        configId: config.id,
        configName: config.name,
        mint,
        message: `Auto buy failed on ${tokenSymbol || mint.slice(0, 6)}: ${error.message}`,
        severity: 'error'
      });
      return null;
    }
  }

  async decline(config, mint, reason) {
    await this.onEvent('AUTO_BUY_SKIPPED', {
      configId: config.id,
      configName: config.name,
      mint,
      message: `Auto buy skipped: ${reason}`,
      severity: 'warning'
    });
  }

  async close(position, reason) {
    if (position.status !== 'open') return null;
    position.status = 'closing';
    position.sellAttempts += 1;
    this.onUpdate(position);

    try {
      if (position.dryRun) {
        position.exitPriceSol = position.lastPriceSol ?? position.entryPriceSol;
        position.proceedsSol = position.tokenAmount * position.exitPriceSol;
      } else {
        // Selling the whole balance by percentage avoids any decimal rounding
        // between what was recorded and what the wallet actually holds.
        position.sellSignature = await this.submit({
          action: 'sell',
          mint: position.mint,
          amount: '100%',
          denominatedInSol: 'false',
          slippage: position.slippagePercent,
          priorityFee: position.priorityFeeSol
        });
        const fill = await this.readFill(position.sellSignature, position.mint);
        position.proceedsSol = fill ? Math.abs(fill.solDelta) : position.tokenAmount * (position.lastPriceSol ?? position.entryPriceSol);
        position.exitPriceSol = position.tokenAmount ? position.proceedsSol / position.tokenAmount : null;
      }
      position.status = 'closed';
      position.closedAt = new Date().toISOString();
      position.exitReason = reason;
      position.realisedPnlPercent = position.costSol ? (position.proceedsSol - position.costSol) / position.costSol * 100 : 0;
      this.onUpdate(position);
      await this.onEvent('AUTO_SELL_FILLED', {
        configId: position.configId,
        configName: position.configName,
        mint: position.mint,
        wallet: this.wallet.publicKey ?? '',
        amount: position.proceedsSol,
        signature: position.sellSignature,
        message: `${position.dryRun ? 'Simulated exit' : 'Exited'} ${position.tokenSymbol || position.mint.slice(0, 6)} on ${reason} — ${position.realisedPnlPercent >= 0 ? '+' : ''}${position.realisedPnlPercent.toFixed(1)}%`,
        severity: position.realisedPnlPercent >= 0 ? 'success' : 'warning'
      });
      return position;
    } catch (error) {
      position.error = error.message;
      // A sell that keeps failing is money stuck on chain, so it stops being
      // retried silently and is surfaced for a manual exit instead.
      const exhausted = position.sellAttempts >= MAX_SELL_ATTEMPTS;
      position.status = exhausted ? 'failed' : 'open';
      this.onUpdate(position);
      await this.onEvent('AUTO_SELL_FAILED', {
        configId: position.configId,
        configName: position.configName,
        mint: position.mint,
        message: exhausted
          ? `Exit failed ${position.sellAttempts}× on ${position.tokenSymbol || position.mint.slice(0, 6)} — sell it manually: ${error.message}`
          : `Exit attempt ${position.sellAttempts} failed on ${position.tokenSymbol || position.mint.slice(0, 6)}: ${error.message}`,
        severity: 'error'
      });
      return null;
    }
  }

  exitReason(position, curve, now) {
    if (!curve || curve.priceSol === null) return position.priceFailures >= MAX_PRICE_FAILURES ? 'price-unavailable' : null;
    if (curve.complete) return 'migrated';
    if (position.takeProfitPercent > 0 && position.pnlPercent >= position.takeProfitPercent) return 'take-profit';
    if (position.stopLossPercent > 0 && position.pnlPercent <= -position.stopLossPercent) return 'stop-loss';
    if (position.maxHoldMinutes > 0 && now - new Date(position.openedAt).getTime() >= position.maxHoldMinutes * 60_000) return 'max-hold';
    return null;
  }

  async tick() {
    if (this.ticking) return;
    const open = this.positions.filter((position) => position.status === 'open');
    if (!open.length) { this.stop(); return; }
    this.ticking = true;
    const now = Date.now();
    try {
      // One read per mint, however many rules hold it.
      const curves = new Map();
      for (const mint of new Set(open.map((position) => position.mint))) {
        curves.set(mint, await this.readCurve(mint).catch(() => null));
      }
      let changed = false;
      for (const position of open) {
        const curve = curves.get(position.mint);
        if (curve?.priceSol) {
          position.priceFailures = 0;
          position.lastPriceSol = curve.priceSol;
          position.lastPriceAt = new Date(now).toISOString();
          position.pnlPercent = position.entryPriceSol ? (curve.priceSol - position.entryPriceSol) / position.entryPriceSol * 100 : 0;
          changed = true;
        } else {
          position.priceFailures += 1;
        }
        const reason = this.exitReason(position, curve, now);
        if (reason) await this.close(position, reason);
      }
      if (changed) this.onUpdate(null);
    } finally {
      this.ticking = false;
    }
  }
}
