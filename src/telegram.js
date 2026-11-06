const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const short = (address) => `${address.slice(0, 6)}…${address.slice(-6)}`;

const padreUrl = (mint) => `https://trade.padre.gg/trade/solana/${encodeURIComponent(mint)}`;

function buildBundleMessage(alert) {
  const mintUrl = `https://solscan.io/token/${encodeURIComponent(alert.mint)}`;
  const tradeUrl = padreUrl(alert.mint);
  const creatorUrl = `https://solscan.io/account/${encodeURIComponent(alert.wallet)}`;
  const amounts = (alert.bundleBuys ?? []).map((value, index) => `  ${index + 1}. ${Number(value).toFixed(3)} SOL`);
  const total = (alert.bundleBuys ?? []).reduce((sum, value) => sum + Number(value), 0);

  return [
    '🎯 <b>PUMP.FUN BUNDLE MATCH</b>',
    '',
    `<b>Rule</b>  ${escapeHtml(alert.configName)}`,
    `<b>Token</b>  ${escapeHtml(alert.tokenName || 'Unknown')} ${alert.tokenSymbol ? `(${escapeHtml(alert.tokenSymbol)})` : ''}`.trim(),
    `<b>Mint</b>  <a href="${tradeUrl}">${escapeHtml(short(alert.mint))}</a>`,
    `<b>Creator</b>  <a href="${creatorUrl}">${escapeHtml(short(alert.wallet))}</a>`,
    '',
    `<b>Dev buy</b>  ${Number(alert.devBuyAmount).toFixed(4)} SOL`,
    `<b>Bundle buys</b>  ${total.toFixed(3)} SOL total`,
    ...amounts,
    `<b>Elapsed</b>  ${escapeHtml(alert.elapsedLabel)}`,
    '',
    `<a href="${tradeUrl}">Open Padre</a>  ·  <a href="${mintUrl}">Open Solscan</a>`
  ].join('\n');
}

/**
 * A tracked wallet's buy is read off an existing mint, so there is no launch to
 * name it from: the mint address is the identity, and the links are what makes
 * the signal actionable.
 */
function buildWalletMessage(alert) {
  const mintUrl = `https://solscan.io/token/${encodeURIComponent(alert.mint)}`;
  const tradeUrl = padreUrl(alert.mint);
  const walletUrl = `https://solscan.io/account/${encodeURIComponent(alert.wallet)}`;
  const buyUrl = `https://solscan.io/tx/${encodeURIComponent(alert.buySignature)}`;

  return [
    '👤 <b>TRACKED WALLET BUY</b>',
    '',
    `<b>Rule</b>  ${escapeHtml(alert.configName)}`,
    `<b>Wallet</b>  <a href="${walletUrl}">${escapeHtml(short(alert.wallet))}</a>`,
    `<b>Mint</b>  <a href="${tradeUrl}">${escapeHtml(short(alert.mint))}</a>`,
    `<b>Buy</b>  ${Number(alert.devBuyAmount).toFixed(4)} SOL  ·  <a href="${buyUrl}">Solscan tx</a>`,
    '',
    `<a href="${tradeUrl}">Open Padre</a>  ·  <a href="${mintUrl}">Open Solscan</a>`
  ].join('\n');
}

export function buildAlertMessage(alert) {
  if (alert.mode === 'bundle') return buildBundleMessage(alert);
  if (alert.mode === 'wallet') return buildWalletMessage(alert);
  const fundingUrl = `https://solscan.io/tx/${encodeURIComponent(alert.fundingSignature)}`;
  const walletUrl = `https://solscan.io/account/${encodeURIComponent(alert.wallet)}`;
  const mintUrl = `https://solscan.io/token/${encodeURIComponent(alert.mint)}`;
  const tradeUrl = padreUrl(alert.mint);

  return [
    '🚨 <b>PUMP.FUN DEV BUY MATCH</b>',
    '',
    `<b>Config</b>  ${escapeHtml(alert.configName)}`,
    `<b>Funded wallet</b>  <a href="${walletUrl}">${escapeHtml(short(alert.wallet))}</a>`,
    `<b>Funding</b>  ${Number(alert.fundingAmount).toFixed(4)} SOL  ·  <a href="${fundingUrl}">Solscan tx</a>`,
    '',
    `<b>Token</b>  ${escapeHtml(alert.tokenName || 'Unknown')} ${alert.tokenSymbol ? `(${escapeHtml(alert.tokenSymbol)})` : ''}`.trim(),
    `<b>Mint</b>  <a href="${tradeUrl}">${escapeHtml(short(alert.mint))}</a>`,
    `<b>Dev buy</b>  ${Number(alert.devBuyAmount).toFixed(4)} SOL`,
    `<b>Elapsed</b>  ${escapeHtml(alert.elapsedLabel)}`,
    '',
    `<a href="${tradeUrl}">Open Padre</a>  ·  <a href="${mintUrl}">Open Solscan</a>`
  ].join('\n');
}

export async function sendTelegramAlert({ token, chatId, alert }) {
  if (!token || !chatId) return { skipped: true, reason: 'Telegram credentials are not configured.' };
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: buildAlertMessage(alert),
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.description || `Telegram returned HTTP ${response.status}`);
  return body.result;
}
