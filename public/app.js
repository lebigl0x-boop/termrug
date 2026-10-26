const state = { configs: [], watchedWallets: [], alerts: [], events: [], streamStatus: {}, webhookStatus: {}, webhookUrl: '' };
let selectedConfigId = null;
const $ = (selector) => document.querySelector(selector);
const short = (value = '') => value.length > 13 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
const sol = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(4)} SOL` : '—';
const time = (value) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(value));
const typeLabels = { FUNDING_MATCH: 'FUNDING', TOKEN_CREATE: 'TOKEN CREATE', DEV_BUY_MATCH: 'DEV BUY', TELEGRAM_ERROR: 'TELEGRAM', STREAM_ERROR: 'STREAM', CONFIG_CREATED: 'RULE', CONFIG_UPDATED: 'RULE', CONFIG_DELETED: 'RULE', WEBHOOK_SYNCED: 'WEBHOOK', WEBHOOK_SKIPPED: 'WEBHOOK', WEBHOOK_ERROR: 'WEBHOOK' };
const webhookLabels = { created: 'Registered', updated: 'Registered', unchanged: 'Registered', skipped: 'Inactive', error: 'Error', pending: 'Checking' };
const els = { configList: $('#config-list'), configsEmpty: $('#configs-empty'), dashboardEmpty: $('#dashboard-empty'), dashboard: $('#dashboard-content'), eventRows: $('#event-rows'), eventsEmpty: $('#events-empty'), watched: $('#watched-wallets'), walletsEmpty: $('#wallets-empty'), alerts: $('#alert-list'), alertsEmpty: $('#alerts-empty'), modal: $('#config-modal'), form: $('#config-form'), formError: $('#form-error'), walletFields: $('#wallet-fields'), fundingFields: $('#funding-fields'), devBuyFields: $('#devbuy-fields'), webhookBanner: $('#webhook-banner'), webhookState: $('#webhook-state') };

const rangeList = (config, key, legacyMin, legacyMax) => Array.isArray(config?.[key]) && config[key].length ? config[key] : [{ min: config?.[legacyMin], max: config?.[legacyMax] }];
const configRanges = (config, key) => key === 'fundingRanges' ? rangeList(config, key, 'minSol', 'maxSol') : rangeList(config, key, 'minDevBuy', 'maxDevBuy');
const rangeText = (ranges) => ranges.map((range) => `${Number(range.min).toFixed(2)}–${Number(range.max).toFixed(2)}`).join(' · ');
const selectedConfig = () => state.configs.find((config) => config.id === selectedConfigId) || null;
const byConfig = (items) => items.filter((item) => item.configId === selectedConfigId);
const create = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };

function applySnapshot(data) {
  Object.assign(state, data);
  if (!state.configs.some((config) => config.id === selectedConfigId)) selectedConfigId = state.configs[0]?.id || null;
  render();
}

function render() {
  const config = selectedConfig();
  $('#config-count').textContent = state.configs.length;
  $('#alert-count').textContent = state.alerts.length;
  $('#webhook-url').textContent = state.webhookUrl || 'Set PUBLIC_URL first';
  $('#crumb-name').textContent = config?.name || 'Select a configuration';
  renderStreamStatus(); renderWebhookStatus(); renderConfigNav();
  els.configsEmpty.hidden = state.configs.length > 0;
  els.dashboardEmpty.hidden = Boolean(config); els.dashboard.hidden = !config;
  if (config) renderDashboard(config);
}

function renderStreamStatus() {
  const item = $('#stream-status'); const stream = state.streamStatus || {};
  item.className = `stream-state ${stream.connected ? 'live' : stream.configured ? '' : 'error'}`;
  item.querySelector('span').textContent = (stream.label || 'Offline').toUpperCase();
}

function renderWebhookStatus() {
  const hook = state.webhookStatus || {};
  const broken = hook.state === 'skipped' || hook.state === 'error';
  els.webhookBanner.hidden = !broken;
  if (broken) $('#webhook-banner-reason').textContent = hook.reason || 'Helius cannot deliver funding transfers.';
  const count = hook.addresses ? ` · ${hook.addresses} address${hook.addresses > 1 ? 'es' : ''}` : '';
  els.webhookState.textContent = `${webhookLabels[hook.state] || 'Unknown'}${broken ? '' : count}`;
  els.webhookState.className = `webhook-state ${broken ? 'bad' : hook.state === 'pending' ? '' : 'good'}`;
}

function renderConfigNav() {
  els.configList.replaceChildren();
  for (const config of state.configs) {
    const item = create('button', `config-nav-item ${config.id === selectedConfigId ? 'selected' : ''} ${config.enabled ? 'active' : 'disabled'}`);
    item.type = 'button';
    item.append(create('i', 'config-marker'));
    const copy = create('div'); copy.append(create('div', 'config-nav-name', config.name), create('div', 'config-nav-meta', `${config.watchAddresses.length} wallets · ${config.timeWindowMinutes}m`));
    item.append(copy, create('span', 'config-count', `${state.alerts.filter((alert) => alert.configId === config.id).length}`));
    item.addEventListener('click', () => { selectedConfigId = config.id; render(); });
    els.configList.append(item);
  }
}

function renderDashboard(config) {
  const watches = byConfig(state.watchedWallets).filter((watch) => new Date(watch.expiresAt).getTime() > Date.now());
  const alerts = byConfig(state.alerts); const events = byConfig(state.events); const funding = configRanges(config, 'fundingRanges'); const devBuys = configRanges(config, 'devBuyRanges');
  $('#selected-name').textContent = config.name; $('#selected-status').textContent = config.enabled ? 'ACTIVE' : 'PAUSED'; $('#selected-window').textContent = `${config.timeWindowMinutes} MIN WINDOW`;
  $('#selected-summary').textContent = `${config.watchAddresses.length} source wallets  •  ${funding.length} funding range${funding.length === 1 ? '' : 's'}  •  ${devBuys.length} dev-buy range${devBuys.length === 1 ? '' : 's'}`;
  $('#selected-toggle').checked = config.enabled;
  $('#metric-watched').textContent = watches.length; $('#metric-funding').textContent = funding.length; $('#metric-devbuy').textContent = devBuys.length; $('#metric-alerts').textContent = alerts.length;
  $('#metric-funding-value').textContent = rangeText(funding); $('#metric-devbuy-value').textContent = rangeText(devBuys);
  $('#pipe-funding').textContent = events.filter((event) => event.type === 'FUNDING_MATCH').length; $('#pipe-launches').textContent = events.filter((event) => event.type === 'TOKEN_CREATE').length; $('#pipe-alerts').textContent = alerts.length;
  $('#pipe-funding-detail').textContent = `${funding.length} configured range${funding.length === 1 ? '' : 's'}`; $('#pipe-devbuy-detail').textContent = `${devBuys.length} configured range${devBuys.length === 1 ? '' : 's'}`;
  const chips = $('#selected-wallet-chips'); chips.replaceChildren(); const chipsWrap = create('div', 'wallet-chips'); config.watchAddresses.forEach((wallet) => chipsWrap.append(create('span', 'wallet-chip', short(wallet)))); chips.append(chipsWrap);
  renderEvents(events); renderWatches(watches); renderAlerts(alerts);
}

function renderEvents(events) {
  els.eventRows.replaceChildren(); els.eventsEmpty.hidden = events.length > 0;
  events.slice(0, 30).forEach((event) => {
    const row = document.createElement('tr'); const severity = event.severity || 'info';
    const cells = [create('td', 'time', time(event.at)), create('td'), create('td', 'amount', event.amount === undefined ? '—' : sol(event.amount)), create('td', 'mono', short(event.mint || event.wallet || '—')), create('td', 'detail', event.message || '—'), create('td')];
    cells[1].append(create('span', `event-label ${severity}`, typeLabels[event.type] || event.type));
    if (event.signature) { const link = create('a', 'view-link', 'VIEW'); link.href = `https://solscan.io/tx/${encodeURIComponent(event.signature)}`; link.target = '_blank'; link.rel = 'noreferrer'; cells[5].append(link); }
    row.append(...cells); els.eventRows.append(row);
  });
}

function remaining(expiresAt) { const milliseconds = Math.max(0, new Date(expiresAt).getTime() - Date.now()); return `${Math.floor(milliseconds / 60_000)}:${String(Math.floor(milliseconds % 60_000 / 1_000)).padStart(2, '0')}`; }
function renderWatches(watches) {
  els.watched.replaceChildren(); els.walletsEmpty.hidden = watches.length > 0; $('#watched-count').textContent = watches.length;
  watches.forEach((watch) => {
    const row = create('article', 'watch-row');
    const wallet = create('a', 'watch-address', watch.wallet); wallet.href = `https://solscan.io/account/${encodeURIComponent(watch.wallet)}`; wallet.target = '_blank'; wallet.rel = 'noreferrer';
    const funded = create('div'); funded.append(create('div', 'watch-label', 'FUNDING'), create('div', 'watch-value', sol(watch.fundingAmount)));
    const timer = create('div'); timer.append(create('div', 'watch-label', 'REMAINING'), create('div', 'watch-value timer', remaining(watch.expiresAt)));
    const source = create('div'); source.append(create('div', 'watch-label', 'SOURCE'), create('div', 'watch-value', short(watch.fundingWallet)));
    row.append(wallet, funded, timer, source); els.watched.append(row);
  });
}

function renderAlerts(alerts) {
  els.alerts.replaceChildren(); els.alertsEmpty.hidden = alerts.length > 0;
  alerts.slice(0, 20).forEach((alert) => {
    const row = create('article', 'alert-row'); const token = create('div'); token.append(create('div', 'alert-name', `${alert.tokenName || 'Untitled token'}${alert.tokenSymbol ? ` · $${alert.tokenSymbol}` : ''}`), create('div', 'alert-mint', short(alert.mint)));
    const buy = create('div'); buy.append(create('div', 'alert-label', 'DEV BUY'), create('div', 'alert-value green', sol(alert.devBuyAmount)));
    const fund = create('div'); fund.append(create('div', 'alert-label', 'FUNDING'), create('div', 'alert-value', sol(alert.fundingAmount)));
    const elapsed = create('div'); elapsed.append(create('div', 'alert-label', 'ELAPSED'), create('div', 'alert-value', alert.elapsedLabel));
    const links = create('div'); const pump = create('a', 'view-link', 'PUMP ↗'); pump.href = `https://pump.fun/coin/${encodeURIComponent(alert.mint)}`; pump.target = '_blank'; pump.rel = 'noreferrer'; links.append(pump, create('div', `alert-delivery ${alert.telegram}`, `TG ${alert.telegram || 'PENDING'}`));
    row.append(token, buy, fund, elapsed, links); els.alerts.append(row);
  });
}

function clearRepeaters() { els.walletFields.replaceChildren(); els.fundingFields.replaceChildren(); els.devBuyFields.replaceChildren(); }
function addWalletRow(value = '') { const row = $('#wallet-row-template').content.firstElementChild.cloneNode(true); row.querySelector('[data-wallet]').value = value; bindRemove(row); els.walletFields.append(row); }
function addRangeRow(target, range = {}) { const row = $('#range-row-template').content.firstElementChild.cloneNode(true); row.querySelector('[data-min]').value = range.min ?? ''; row.querySelector('[data-max]').value = range.max ?? ''; bindRemove(row); target.append(row); }
function bindRemove(row) { row.querySelector('.remove-row').addEventListener('click', () => row.remove()); }

function openModal(config = null) {
  els.form.reset(); els.formError.textContent = ''; clearRepeaters();
  $('#modal-title').textContent = config ? 'Edit configuration' : 'New configuration';
  const fields = els.form.elements; fields.id.value = config?.id || ''; fields.name.value = config?.name || ''; fields.timeWindowMinutes.value = config?.timeWindowMinutes ?? 60; fields.telegramChatId.value = config?.telegramChatId || ''; fields.enabled.checked = config?.enabled ?? true;
  (config?.watchAddresses?.length ? config.watchAddresses : ['']).forEach(addWalletRow);
  configRanges(config || {}, 'fundingRanges').forEach((range) => addRangeRow(els.fundingFields, range));
  configRanges(config || {}, 'devBuyRanges').forEach((range) => addRangeRow(els.devBuyFields, range));
  els.modal.showModal(); fields.name.focus();
}

function values(selector, key) { return [...document.querySelectorAll(selector)].map((input) => input.value.trim()).filter(Boolean); }
function ranges(container) { return [...container.querySelectorAll('.range-row')].map((row) => ({ min: Number(row.querySelector('[data-min]').value), max: Number(row.querySelector('[data-max]').value) })); }
function formPayload() { const fields = els.form.elements; return { name: fields.name.value, watchAddresses: values('[data-wallet]', 'wallet'), fundingRanges: ranges(els.fundingFields), devBuyRanges: ranges(els.devBuyFields), timeWindowMinutes: Number(fields.timeWindowMinutes.value), telegramChatId: fields.telegramChatId.value.trim(), enabled: fields.enabled.checked }; }

async function request(url, options = {}) { const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options }); const body = response.status === 204 ? null : await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || 'Request failed.'); return body; }
async function refresh() { const response = await fetch('/api/bootstrap'); applySnapshot(await response.json()); }
async function saveConfig(payload, id = null) { await request(id ? `/api/configs/${id}` : '/api/configs', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); await refresh(); }

['#new-config', '#new-config-empty', '#new-config-main'].forEach((selector) => $(selector).addEventListener('click', () => openModal()));
$('#edit-selected').addEventListener('click', () => openModal(selectedConfig()));
$('#selected-toggle').addEventListener('change', async (event) => { const config = selectedConfig(); if (!config) return; try { await saveConfig({ ...config, enabled: event.target.checked }, config.id); } catch (error) { alert(error.message); render(); } });
$('#delete-selected').addEventListener('click', async () => { const config = selectedConfig(); if (!config || !confirm(`Delete “${config.name}”? Watches for this rule are removed as well.`)) return; try { await request(`/api/configs/${config.id}`, { method: 'DELETE' }); selectedConfigId = state.configs.find((item) => item.id !== config.id)?.id || null; await refresh(); } catch (error) { alert(error.message); } });
document.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => { if (button.dataset.add === 'wallet') addWalletRow(); else addRangeRow(button.dataset.add === 'funding' ? els.fundingFields : els.devBuyFields); }));
els.form.addEventListener('submit', async (event) => { event.preventDefault(); els.formError.textContent = ''; const id = els.form.elements.id.value || null; try { await saveConfig(formPayload(), id); if (!id) selectedConfigId = state.configs[0]?.id || selectedConfigId; els.modal.close(); render(); } catch (error) { els.formError.textContent = error.message; } });
$('#close-modal').addEventListener('click', () => els.modal.close()); $('#cancel-modal').addEventListener('click', () => els.modal.close());
async function copyWebhook() { try { await navigator.clipboard.writeText(state.webhookUrl); } catch { alert('Clipboard access was blocked.'); } }
$('#copy-webhook').addEventListener('click', copyWebhook); $('#copy-webhook-side').addEventListener('click', copyWebhook);

function connect() { const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; const socket = new WebSocket(`${protocol}//${location.host}/ws`); socket.addEventListener('message', (event) => { try { const data = JSON.parse(event.data); if (data.type === 'snapshot') applySnapshot(data); } catch (error) { console.warn('Invalid WebSocket data', error); } }); socket.addEventListener('close', () => setTimeout(connect, 1_500)); }
setInterval(() => { $('#utc-clock').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()); if (selectedConfig()) renderDashboard(selectedConfig()); }, 1_000);
refresh().catch((error) => console.error('Bootstrap failed', error)); connect();
