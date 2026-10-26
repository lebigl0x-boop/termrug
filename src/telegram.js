const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const short = (address) => `${address.slice(0, 6)}…${address.slice(-6)}`;

export function buildAlertMessage(alert) {
  const fundingUrl = `https://solscan.io/tx/${encodeURIComponent(alert.fundingSignature)}`;
  const walletUrl = `https://solscan.io/account/${encodeURIComponent(alert.wallet)}`;
  const mintUrl = `https://solscan.io/token/${encodeURIComponent(alert.mint)}`;
  const pumpUrl = `https://pump.fun/coin/${encodeURIComponent(alert.mint)}`;

  return [
    '🚨 <b>PUMP.FUN DEV BUY MATCH</b>',
    '',
    `<b>Config</b>  ${escapeHtml(alert.configName)}`,
    `<b>Funded wallet</b>  <a href="${walletUrl}">${escapeHtml(short(alert.wallet))}</a>`,
    `<b>Funding</b>  ${Number(alert.fundingAmount).toFixed(4)} SOL  ·  <a href="${fundingUrl}">Solscan tx</a>`,
    '',
    `<b>Token</b>  ${escapeHtml(alert.tokenName || 'Unknown')} ${alert.tokenSymbol ? `(${escapeHtml(alert.tokenSymbol)})` : ''}`.trim(),
    `<b>Mint</b>  <a href="${mintUrl}">${escapeHtml(short(alert.mint))}</a>`,
    `<b>Dev buy</b>  ${Number(alert.devBuyAmount).toFixed(4)} SOL`,
    `<b>Elapsed</b>  ${escapeHtml(alert.elapsedLabel)}`,
    '',
    `<a href="${pumpUrl}">Open pump.fun</a>  ·  <a href="${mintUrl}">Open Solscan</a>`
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
