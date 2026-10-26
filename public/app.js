const state = { configs: [], watchedWallets: [], alerts: [], events: [], streamStatus: {}, webhookStatus: {}, stats: {}, webhookUrl: '' };
let selectedConfigId = null;
let activeTab = 'feed';
let view = 'overview';
let activeRange = 'all';

const $ = (selector) => document.querySelector(selector);
const short = (value = '') => value.length > 13 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
const sol = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(4)}` : '—';
const time = (value) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(value));
const typeLabels = { FUNDING_MATCH: 'FUNDING', TOKEN_CREATE: 'TOKEN CREATE', DEV_BUY_MATCH: 'DEV BUY', TELEGRAM_ERROR: 'TELEGRAM', STREAM_ERROR: 'STREAM', CONFIG_CREATED: 'RULE', CONFIG_UPDATED: 'RULE', CONFIG_DELETED: 'RULE', WEBHOOK_SYNCED: 'WEBHOOK', WEBHOOK_SKIPPED: 'WEBHOOK', WEBHOOK_ERROR: 'WEBHOOK' };
const webhookLabels = { created: 'Registered', updated: 'Registered', unchanged: 'Registered', skipped: 'Inactive', error: 'Error', pending: 'Checking' };
const rangeWindows = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000, all: Infinity };
const rangeNotes = { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days', all: 'All time' };

const els = {
  dashboardEmpty: $('#dashboard-empty'), dashboard: $('#dashboard-content'),
  eventRows: $('#event-rows'), eventsEmpty: $('#events-empty'), watched: $('#watched-wallets'), walletsEmpty: $('#wallets-empty'),
  alerts: $('#alert-list'), alertsEmpty: $('#alerts-empty'), modal: $('#config-modal'), form: $('#config-form'), formError: $('#form-error'),
  walletFields: $('#wallet-fields'), fundingFields: $('#funding-fields'), devBuyFields: $('#devbuy-fields'),
  webhookBanner: $('#webhook-banner'), webhookState: $('#webhook-state'), funnel: $('#funnel'), funnelSplit: $('#funnel-split'),
  fundingRows: $('#funding-rows'), devBuyRows: $('#devbuy-rows'),
  overview: $('#overview'), overviewGrid: $('#overview-grid')
};

const rangeList = (config, key, legacyMin, legacyMax) => Array.isArray(config?.[key]) && config[key].length ? config[key] : [{ min: config?.[legacyMin], max: config?.[legacyMax] }];
const configRanges = (config, key) => key === 'fundingRanges' ? rangeList(config, key, 'minSol', 'maxSol') : rangeList(config, key, 'minDevBuy', 'maxDevBuy');
const selectedConfig = () => state.configs.find((config) => config.id === selectedConfigId) || null;
const byConfig = (items) => items.filter((item) => item.configId === selectedConfigId);
const inRange = (items) => { const span = rangeWindows[activeRange]; if (span === Infinity) return items; const floor = Date.now() - span; return items.filter((item) => new Date(item.at).getTime() >= floor); };
const statsFor = (configId) => {
  const events = inRange(state.events.filter((event) => event.configId === configId));
  const live = {
    watched: state.watchedWallets.filter((watch) => watch.configId === configId && new Date(watch.expiresAt).getTime() > Date.now()).length,
    funding: events.filter((event) => event.type === 'FUNDING_MATCH').length,
    launches: events.filter((event) => event.type === 'TOKEN_CREATE').length,
    signals: inRange(state.alerts.filter((alert) => alert.configId === configId)).length,
    lastAt: events[0]?.at ?? null
  };
  // Server counters cover the whole stored history; they only line up with the
  // "Max" range, so narrower ranges keep counting the in-memory window.
  const stored = activeRange === 'all' ? state.stats?.[configId] : null;
  return stored ? { ...live, funding: stored.funding, launches: stored.launches, signals: stored.signals, lastAt: stored.lastAt ?? live.lastAt } : live;
};
const create = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
const cell = (className, text) => create('td', className, text);
const link = (className, text, href) => { const item = create('a', className, text); item.href = href; item.target = '_blank'; item.rel = 'noreferrer'; return item; };

function applySnapshot(data) {
  Object.assign(state, data);
  if (!state.configs.some((config) => config.id === selectedConfigId)) selectedConfigId = state.configs[0]?.id || null;
  render();
}

function render() {
  const config = selectedConfig();
  const hasConfigs = state.configs.length > 0;
  const onDetail = view === 'detail' && Boolean(config);
  $('#copy-webhook').title = state.webhookUrl || 'Set PUBLIC_URL first';
  $('#crumb-name').textContent = onDetail ? config.name : 'All scanners';
  $('#range-note').textContent = rangeNotes[activeRange];
  $('#ov-range').textContent = rangeNotes[activeRange];
  renderStreamStatus(); renderWebhookStatus(); renderDock();
  els.dashboardEmpty.hidden = hasConfigs;
  els.overview.hidden = !hasConfigs || onDetail;
  els.dashboard.hidden = !onDetail;
  if (onDetail) renderDashboard(config);
  else if (hasConfigs) renderOverview();
}

function renderStreamStatus() {
  const pill = $('#stream-status'); const stream = state.streamStatus || {};
  pill.className = `pill ${stream.connected ? 'live' : stream.configured ? '' : 'bad'}`;
  pill.querySelector('span').textContent = (stream.label || 'Offline').toUpperCase();
}

function renderWebhookStatus() {
  const hook = state.webhookStatus || {};
  const broken = hook.state === 'skipped' || hook.state === 'error';
  els.webhookBanner.hidden = !broken;
  if (broken) $('#webhook-banner-reason').textContent = hook.reason || 'Helius cannot deliver funding transfers.';
  const count = hook.addresses ? ` · ${hook.addresses}` : '';
  els.webhookState.textContent = `${webhookLabels[hook.state] || 'Unknown'}${broken ? '' : count}`;
  els.webhookState.className = `pill ${broken ? 'bad' : hook.state === 'pending' ? '' : 'good'}`;
}

function renderDock() {
  const stream = state.streamStatus || {};
  const hook = state.webhookStatus || {};
  const hookOk = hook.state && hook.state !== 'skipped' && hook.state !== 'error' && hook.state !== 'pending';
  $('#dock-stream').className = `dock-item ${stream.connected ? 'is-on' : 'is-off'}`;
  $('#dock-stream').lastChild.textContent = `Stream ${stream.connected ? 'live' : 'down'}`;
  $('#dock-webhook').className = `dock-item ${hookOk ? 'is-on' : 'is-off'}`;
  $('#dock-webhook').lastChild.textContent = `Webhook ${hookOk ? 'registered' : 'inactive'}`;
  $('#dock-configs').textContent = state.configs.length;
  $('#dock-watched').textContent = state.watchedWallets.filter((watch) => new Date(watch.expiresAt).getTime() > Date.now()).length;
  $('#dock-launches').textContent = state.events.filter((event) => event.type === 'TOKEN_CREATE').length;
  $('#dock-alerts').textContent = state.alerts.length;
}

function renderOverview() {
  const totals = state.configs.map((config) => statsFor(config.id));
  $('#ov-configs').textContent = state.configs.length;
  $('#ov-active').textContent = `${state.configs.filter((config) => config.enabled).length} active`.toUpperCase();
  $('#ov-watched').textContent = totals.reduce((sum, item) => sum + item.watched, 0);
  $('#ov-launches').textContent = totals.reduce((sum, item) => sum + item.launches, 0);
  $('#ov-signals').textContent = totals.reduce((sum, item) => sum + item.signals, 0);

  els.overviewGrid.replaceChildren();
  state.configs.forEach((config) => {
    const stats = statsFor(config.id);
    const card = create('button', `ov-card ${config.enabled ? 'is-on' : ''}`);
    card.type = 'button';

    const head = create('div', 'ov-head');
    const title = create('div', 'ov-title');
    const copy = create('div');
    copy.append(create('strong', null, config.name), create('div', 'ov-meta', `${config.watchAddresses.length} source${config.watchAddresses.length === 1 ? '' : 's'} · ${config.timeWindowMinutes} min window`));
    title.append(create('i'), copy);
    head.append(title, create('span', `pill ${config.enabled ? 'good' : ''}`, config.enabled ? 'Active' : 'Paused'));

    const grid = create('div', 'ov-stats');
    [['Watched', stats.watched, ''], ['Launches', stats.launches, ''], ['Signals', stats.signals, 'green']].forEach(([label, value, tone]) => {
      const box = create('div');
      box.append(create('span', 'stat-label', label), create('b', tone, String(value)));
      grid.append(box);
    });

    const ranges = create('div', 'ov-ranges');
    [['Funding', configRanges(config, 'fundingRanges')], ['Dev buy', configRanges(config, 'devBuyRanges')]].forEach(([label, list]) => {
      const row = create('div', 'ov-range');
      row.append(create('span', null, label), create('span', null, list.map((range) => `${Number(range.min).toFixed(2)}–${Number(range.max).toFixed(2)}`).join('  ·  ')));
      ranges.append(row);
    });

    const foot = create('div', 'ov-foot');
    foot.append(create('small', null, stats.lastAt ? `Last activity ${time(stats.lastAt)} UTC` : 'No activity yet'), create('span', 'ov-enter', 'Open →'));

    card.append(head, grid, ranges, foot);
    card.addEventListener('click', () => { selectedConfigId = config.id; view = 'detail'; render(); });
    els.overviewGrid.append(card);
  });
}

function renderDashboard(config) {
  const watches = byConfig(state.watchedWallets).filter((watch) => new Date(watch.expiresAt).getTime() > Date.now());
  const events = inRange(byConfig(state.events));
  const alerts = inRange(byConfig(state.alerts));
  const funding = configRanges(config, 'fundingRanges');
  const devBuys = configRanges(config, 'devBuyRanges');

  $('#selected-name').textContent = config.name;
  $('#selected-status').textContent = config.enabled ? 'Active' : 'Paused';
  $('#selected-window').textContent = `${config.timeWindowMinutes} min window`;
  $('#selected-dot').className = `dot ${config.enabled ? '' : 'off'}`;
  $('#selected-toggle').checked = config.enabled;
  $('#card-window').textContent = `${config.timeWindowMinutes} min`;
  $('#metric-watched').textContent = watches.length;
  $('#metric-alerts').textContent = alerts.length;
  $('#metric-sources').textContent = config.watchAddresses.length;
  $('#metric-funding').textContent = funding.length;
  $('#metric-devbuy').textContent = devBuys.length;
  $('#tab-feed-count').textContent = events.length;
  $('#tab-wallets-count').textContent = watches.length;
  $('#tab-alerts-count').textContent = alerts.length;

  const chips = $('#selected-wallet-chips');
  chips.replaceChildren();
  config.watchAddresses.forEach((wallet) => chips.append(create('span', 'chip-addr', short(wallet))));

  renderFunnel(events, alerts);
  renderThresholds(funding, devBuys);
  renderEvents(events);
  renderWatches(watches);
  renderAlerts(alerts);
}

function renderFunnel(events, alerts) {
  const steps = [
    { kind: 'funding', label: 'Exchange funding', count: events.filter((event) => event.type === 'FUNDING_MATCH').length },
    { kind: 'create', label: 'Token creation', count: events.filter((event) => event.type === 'TOKEN_CREATE').length },
    { kind: 'buy', label: 'Dev buy match', count: alerts.length }
  ];
  const peak = Math.max(1, ...steps.map((step) => step.count));
  els.funnel.replaceChildren();
  steps.forEach((step, index) => {
    const row = create('div', 'funnel-step');
    row.dataset.kind = step.kind;
    const copy = create('div', 'funnel-copy');
    const track = create('div', 'funnel-track');
    const fill = create('span', 'funnel-fill');
    fill.style.width = `${Math.round(step.count / peak * 100)}%`;
    track.append(fill);
    copy.append(create('strong', null, step.label), track);
    row.append(create('span', 'funnel-idx', String(index + 1).padStart(2, '0')), copy, create('b', 'funnel-count', String(step.count)));
    els.funnel.append(row);
  });

  const total = steps.reduce((sum, step) => sum + step.count, 0) || 1;
  els.funnelSplit.replaceChildren();
  [['sg-blue', steps[0].count], ['sg-amber', steps[1].count], ['sg-green', steps[2].count]].forEach(([className, count]) => {
    const segment = create('span', className);
    segment.style.width = `${count / total * 100}%`;
    els.funnelSplit.append(segment);
  });
}

function renderThresholds(funding, devBuys) {
  const fill = (target, ranges, unit) => {
    target.replaceChildren();
    ranges.forEach((range) => {
      const row = create('div', 'range-pill');
      row.append(create('span', null, `${Number(range.min).toFixed(2)} – ${Number(range.max).toFixed(2)}`), create('small', null, unit));
      target.append(row);
    });
  };
  fill(els.fundingRows, funding, 'SOL in');
  fill(els.devBuyRows, devBuys, 'SOL buy');
}

function renderEvents(events) {
  els.eventRows.replaceChildren();
  els.eventsEmpty.hidden = events.length > 0;
  events.slice(0, 40).forEach((event) => {
    const row = document.createElement('tr');
    const tag = cell();
    tag.append(create('span', `tag ${event.severity || 'info'}`, typeLabels[event.type] || event.type));
    const action = cell();
    if (event.signature) action.append(link('ext', 'VIEW ↗', `https://solscan.io/tx/${encodeURIComponent(event.signature)}`));
    row.append(
      cell('t-time', time(event.at)),
      tag,
      cell('t-amount num', event.amount === undefined ? '—' : sol(event.amount)),
      cell('t-mono', short(event.mint || event.wallet || '—')),
      cell('t-detail', event.message || '—'),
      action
    );
    els.eventRows.append(row);
  });
}

function remaining(expiresAt) {
  const milliseconds = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  return `${Math.floor(milliseconds / 60_000)}:${String(Math.floor(milliseconds % 60_000 / 1_000)).padStart(2, '0')}`;
}

function renderWatches(watches) {
  els.watched.replaceChildren();
  els.walletsEmpty.hidden = watches.length > 0;
  watches.forEach((watch) => {
    const row = document.createElement('tr');
    const wallet = cell();
    const holder = create('span', 'wallet-cell');
    holder.append(create('span', 'wallet-dot'), link('t-mono', short(watch.wallet), `https://solscan.io/account/${encodeURIComponent(watch.wallet)}`));
    wallet.append(holder);
    const action = cell();
    if (watch.fundingSignature) action.append(link('ext', 'TX ↗', `https://solscan.io/tx/${encodeURIComponent(watch.fundingSignature)}`));
    row.append(
      wallet,
      cell('t-amount num', sol(watch.fundingAmount)),
      cell('t-mono', short(watch.fundingWallet)),
      cell('t-amount num timer', remaining(watch.expiresAt)),
      action
    );
    els.watched.append(row);
  });
}

function renderAlerts(alerts) {
  els.alerts.replaceChildren();
  els.alertsEmpty.hidden = alerts.length > 0;
  alerts.slice(0, 40).forEach((alert) => {
    const row = document.createElement('tr');
    const token = cell();
    const holder = create('div');
    holder.append(create('div', 't-strong', `${alert.tokenName || 'Untitled token'}${alert.tokenSymbol ? ` · $${alert.tokenSymbol}` : ''}`), create('div', 't-mono', short(alert.mint)));
    token.append(holder);
    const delivery = cell();
    delivery.append(create('span', `tag ${alert.telegram === 'sent' ? 'success' : alert.telegram === 'failed' ? 'error' : ''}`, `TG ${(alert.telegram || 'pending').toUpperCase()}`));
    const action = cell();
    action.append(link('ext', 'PUMP ↗', `https://pump.fun/coin/${encodeURIComponent(alert.mint)}`));
    row.append(
      token,
      cell('t-amount num green', sol(alert.devBuyAmount)),
      cell('t-amount num', sol(alert.fundingAmount)),
      cell('t-amount num', alert.elapsedLabel || '—'),
      delivery,
      action
    );
    els.alerts.append(row);
  });
}

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('is-active', button.dataset.tab === tab));
  document.querySelectorAll('.topnav-item').forEach((button) => button.classList.toggle('is-active', button.dataset.tab === tab));
  document.querySelectorAll('.panel-body').forEach((panel) => { panel.hidden = panel.dataset.panel !== tab; });
}

function setRange(range) {
  activeRange = range;
  document.querySelectorAll('#range-picker button').forEach((button) => button.classList.toggle('is-active', button.dataset.range === range));
  render();
}

function clearRepeaters() { els.walletFields.replaceChildren(); els.fundingFields.replaceChildren(); els.devBuyFields.replaceChildren(); }
function addWalletRow(value = '') { const row = $('#wallet-row-template').content.firstElementChild.cloneNode(true); row.querySelector('[data-wallet]').value = value; bindRemove(row); els.walletFields.append(row); }
function addRangeRow(target, range = {}) { const row = $('#range-row-template').content.firstElementChild.cloneNode(true); row.querySelector('[data-min]').value = range.min ?? ''; row.querySelector('[data-max]').value = range.max ?? ''; bindRemove(row); target.append(row); }
function bindRemove(row) { row.querySelector('.remove-row').addEventListener('click', () => row.remove()); }

function openModal(config = null) {
  els.form.reset(); els.formError.textContent = ''; clearRepeaters();
  $('#modal-title').textContent = config ? 'Edit configuration' : 'New configuration';
  const fields = els.form.elements;
  fields.id.value = config?.id || ''; fields.name.value = config?.name || '';
  fields.timeWindowMinutes.value = config?.timeWindowMinutes ?? 60;
  fields.telegramChatId.value = config?.telegramChatId || '';
  fields.enabled.checked = config?.enabled ?? true;
  (config?.watchAddresses?.length ? config.watchAddresses : ['']).forEach(addWalletRow);
  configRanges(config || {}, 'fundingRanges').forEach((range) => addRangeRow(els.fundingFields, range));
  configRanges(config || {}, 'devBuyRanges').forEach((range) => addRangeRow(els.devBuyFields, range));
  els.modal.showModal(); fields.name.focus();
}

function values(selector) { return [...document.querySelectorAll(selector)].map((input) => input.value.trim()).filter(Boolean); }
function ranges(container) { return [...container.querySelectorAll('.range-row')].map((row) => ({ min: Number(row.querySelector('[data-min]').value), max: Number(row.querySelector('[data-max]').value) })); }
function formPayload() {
  const fields = els.form.elements;
  return { name: fields.name.value, watchAddresses: values('[data-wallet]'), fundingRanges: ranges(els.fundingFields), devBuyRanges: ranges(els.devBuyFields), timeWindowMinutes: Number(fields.timeWindowMinutes.value), telegramChatId: fields.telegramChatId.value.trim(), enabled: fields.enabled.checked };
}

async function request(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}
async function refresh() { const response = await fetch('/api/bootstrap'); applySnapshot(await response.json()); }
async function saveConfig(payload, id = null) { await request(id ? `/api/configs/${id}` : '/api/configs', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); await refresh(); }

['#new-config', '#new-config-main', '#new-config-overview'].forEach((selector) => $(selector).addEventListener('click', () => openModal()));
$('#edit-selected').addEventListener('click', () => openModal(selectedConfig()));
$('#selected-toggle').addEventListener('change', async (event) => { const config = selectedConfig(); if (!config) return; try { await saveConfig({ ...config, enabled: event.target.checked }, config.id); } catch (error) { alert(error.message); render(); } });
$('#delete-selected').addEventListener('click', async () => {
  const config = selectedConfig();
  if (!config || !confirm(`Delete “${config.name}”? Watches for this rule are removed as well.`)) return;
  try { await request(`/api/configs/${config.id}`, { method: 'DELETE' }); selectedConfigId = state.configs.find((item) => item.id !== config.id)?.id || null; await refresh(); } catch (error) { alert(error.message); }
});
document.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.add === 'wallet') addWalletRow();
  else addRangeRow(button.dataset.add === 'funding' ? els.fundingFields : els.devBuyFields);
}));
els.form.addEventListener('submit', async (event) => {
  event.preventDefault(); els.formError.textContent = '';
  const id = els.form.elements.id.value || null;
  try { await saveConfig(formPayload(), id); if (!id) selectedConfigId = state.configs[0]?.id || selectedConfigId; els.modal.close(); render(); } catch (error) { els.formError.textContent = error.message; }
});
$('#crumb-root').addEventListener('click', () => { view = 'overview'; render(); });
$('#close-modal').addEventListener('click', () => els.modal.close());
$('#cancel-modal').addEventListener('click', () => els.modal.close());
document.querySelectorAll('.tab, .topnav-item').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));
document.querySelectorAll('#range-picker button').forEach((button) => button.addEventListener('click', () => setRange(button.dataset.range)));

async function copyWebhook() { try { await navigator.clipboard.writeText(state.webhookUrl); } catch { alert('Clipboard access was blocked.'); } }
$('#copy-webhook').addEventListener('click', copyWebhook);

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener('message', (event) => {
    try { const data = JSON.parse(event.data); if (data.type === 'snapshot') applySnapshot(data); } catch (error) { console.warn('Invalid WebSocket data', error); }
  });
  socket.addEventListener('close', () => setTimeout(connect, 1_500));
}

setInterval(() => {
  $('#utc-clock').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
  const config = selectedConfig();
  if (view === 'detail' && config) renderDashboard(config);
  else if (state.configs.length) renderOverview();
}, 1_000);

setTab(activeTab);
refresh().catch((error) => console.error('Bootstrap failed', error));
connect();
