const state = { configs: [], watchedWallets: [], alerts: [], events: [], candidates: [], streamStatus: {}, webhookStatus: {}, stats: {}, webhookUrl: '' };
let selectedConfigId = null;
let activeTab = 'feed';
let view = 'overview';
let activeRange = 'all';
let formMode = 'funding';
// Deep link: ?config=<id> opens that scanner directly, and navigating keeps the
// URL in step so a view can be shared or reloaded.
const requestedConfigId = new URLSearchParams(location.search).get('config');
if (requestedConfigId) { selectedConfigId = requestedConfigId; view = 'detail'; }

function syncLocation() {
  const next = view === 'detail' && selectedConfigId ? `?config=${encodeURIComponent(selectedConfigId)}` : location.pathname;
  if (location.search !== (next.startsWith('?') ? next : '')) history.replaceState(null, '', next);
}

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
  walletFields: $('#wallet-fields'), fundingFields: $('#funding-fields'), devBuyFields: $('#devbuy-fields'), bundleFields: $('#bundle-fields'),
  webhookBanner: $('#webhook-banner'), webhookState: $('#webhook-state'), funnel: $('#funnel'), funnelSplit: $('#funnel-split'),
  fundingRows: $('#funding-rows'), devBuyRows: $('#devbuy-rows'), fingerprint: $('#fingerprint'),
  overview: $('#overview'), overviewGrid: $('#overview-grid')
};

const rangeList = (config, key, legacyMin, legacyMax) => Array.isArray(config?.[key]) && config[key].length ? config[key] : [{ min: config?.[legacyMin], max: config?.[legacyMax] }];
const configRanges = (config, key) => key === 'fundingRanges' ? rangeList(config, key, 'minSol', 'maxSol') : rangeList(config, key, 'minDevBuy', 'maxDevBuy');
const selectedConfig = () => state.configs.find((config) => config.id === selectedConfigId) || null;
const byConfig = (items) => items.filter((item) => item.configId === selectedConfigId);
const isBundle = (config) => config?.mode === 'bundle';
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
  syncLocation();
  if (onDetail) renderDashboard(config);
  else if (hasConfigs) renderOverview();
}

function renderStreamStatus() {
  const pill = $('#stream-status'); const stream = state.streamStatus || {};
  // Standby is deliberate, not a failure: the pump.fun subscription is only open
  // while a funded wallet is inside its watch window.
  pill.className = `pill ${stream.connected ? 'live' : stream.idle ? 'idle' : stream.configured ? '' : 'bad'}`;
  pill.querySelector('span').textContent = (stream.label || 'Offline').toUpperCase();
  pill.title = stream.idle
    ? 'Standby — the pump.fun stream opens only while a wallet is under watch, to avoid burning Helius credits.'
    : 'pump.fun Parsed Stream';
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
  $('#dock-stream').className = `dock-item ${stream.connected ? 'is-on' : stream.idle ? 'is-idle' : 'is-off'}`;
  $('#dock-stream').lastChild.textContent = `Stream ${stream.connected ? 'live' : stream.idle ? 'standby' : 'down'}`;
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
    const subtitle = isBundle(config)
      ? `${config.bundleBuys?.length ?? 0} buy fingerprint · ${config.timeWindowMinutes} min window`
      : `${config.watchAddresses.length} source${config.watchAddresses.length === 1 ? '' : 's'} · ${config.timeWindowMinutes} min window`;
    copy.append(create('strong', null, config.name), create('div', 'ov-meta', subtitle));
    title.append(create('i'), copy);
    const badges = create('div', 'ov-badges');
    badges.append(
      create('span', 'pill', isBundle(config) ? 'Bundle' : 'Funding'),
      create('span', `pill ${config.enabled ? 'good' : ''}`, config.enabled ? 'Active' : 'Paused')
    );
    head.append(title, badges);

    const grid = create('div', 'ov-stats');
    const liveCandidates = isBundle(config) ? (state.candidates || []).filter((item) => item.configId === config.id).length : stats.watched;
    const columns = isBundle(config)
      ? [['Candidates', liveCandidates, ''], ['Buys', config.bundleBuys?.length ?? 0, ''], ['Signals', stats.signals, 'green']]
      : [['Watched', stats.watched, ''], ['Launches', stats.launches, ''], ['Signals', stats.signals, 'green']];
    columns.forEach(([label, value, tone]) => {
      const box = create('div');
      box.append(create('span', 'stat-label', label), create('b', tone, String(value)));
      grid.append(box);
    });

    const ranges = create('div', 'ov-ranges');
    const rows = isBundle(config)
      ? [['Dev buy', config.devBuyRanges ?? []], ['Bundle', config.bundleBuys ?? []]]
      : [['Funding', configRanges(config, 'fundingRanges')], ['Dev buy', configRanges(config, 'devBuyRanges')]];
    rows.forEach(([label, list]) => {
      const row = create('div', 'ov-range');
      const text = list.length
        ? list.map((range) => Number(range.target ?? range.min).toFixed(range.target != null ? 3 : 2)).join('  ·  ')
        : 'any';
      row.append(create('span', null, label), create('span', null, text));
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

  const bundle = isBundle(config);
  const candidates = bundle ? byConfig(state.candidates || []) : [];
  $('#card2-title').textContent = bundle ? 'Bundle fingerprint' : 'Signal funnel';
  $('#card3-title').textContent = bundle ? 'Dev buy filter' : 'Thresholds';
  $('#detail-watched-label').textContent = bundle ? 'Live candidates' : 'Watched wallets';
  $('#detail-sources-label').textContent = bundle ? 'Bundle buys' : 'Sources';
  $('#foot-watched').textContent = bundle ? 'launches being followed' : 'inside the active window';
  $('#label-funding').hidden = bundle;
  $('#tab-wallets-label').textContent = bundle ? 'Candidates' : 'Watched wallets';
  els.funnel.hidden = bundle;
  $('#funnel-split').hidden = bundle;
  document.querySelector('.legend').hidden = bundle;
  els.fingerprint.hidden = !bundle;

  if (bundle) {
    $('#metric-watched').textContent = candidates.length;
    $('#tab-wallets-count').textContent = candidates.length;
    $('#metric-sources').textContent = config.bundleBuys?.length ?? 0;
    renderFingerprint(config);
    renderCandidates(candidates, config);
  } else {
    renderFunnel(events, alerts);
    renderWatches(watches);
  }
  renderThresholds(funding, devBuys, bundle);
  renderEvents(events);
  renderAlerts(alerts, bundle);
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

function renderFingerprint(config) {
  els.fingerprint.replaceChildren();
  (config.bundleBuys ?? []).forEach((range, index) => {
    const row = create('div', 'fingerprint-row');
    const label = range.target != null
      ? `${Number(range.target).toFixed(3)} ± ${range.tolerance}${range.toleranceMode === 'absolute' ? ' SOL' : ' %'}`
      : `${Number(range.min).toFixed(3)} – ${Number(range.max).toFixed(3)}`;
    row.append(
      create('b', null, String(index + 1).padStart(2, '0')),
      create('span', null, label),
      create('small', null, `[${Number(range.min).toFixed(3)} , ${Number(range.max).toFixed(3)}]`)
    );
    els.fingerprint.append(row);
  });
}

function renderCandidates(candidates, config) {
  els.watched.replaceChildren();
  els.walletsEmpty.hidden = candidates.length > 0;
  els.walletsEmpty.textContent = 'No launch is currently being followed for this rule.';
  const head = $('#wallets-head');
  head.replaceChildren(
    create('th', null, 'Token'), create('th', 'num', 'Dev buy'),
    create('th', null, 'Progress'), create('th', 'num', 'Remaining'), create('th')
  );
  candidates.forEach((candidate) => {
    const row = document.createElement('tr');
    const token = cell();
    const holder = create('div');
    holder.append(
      create('div', 't-strong', `${candidate.tokenName || 'Untitled'}${candidate.tokenSymbol ? ` · $${candidate.tokenSymbol}` : ''}`),
      create('div', 't-mono', short(candidate.mint))
    );
    token.append(holder);
    const done = candidate.buys?.length ?? 0;
    const progress = cell('t-mono', `${done}/${candidate.expected}  ${(candidate.buys ?? []).map((buy) => buy.amount.toFixed(3)).join(' · ') || '—'}`);
    const action = cell();
    action.append(link('ext', 'PUMP ↗', `https://pump.fun/coin/${encodeURIComponent(candidate.mint)}`));
    row.append(token, cell('t-amount num', sol(candidate.devBuySol)), progress, cell('t-amount num timer', remaining(candidate.expiresAt)), action);
    els.watched.append(row);
  });
}

function renderThresholds(funding, devBuys, bundle = false) {
  const fill = (target, ranges, unit) => {
    target.replaceChildren();
    ranges.forEach((range) => {
      const row = create('div', 'range-pill');
      row.append(create('span', null, `${Number(range.min).toFixed(2)} – ${Number(range.max).toFixed(2)}`), create('small', null, unit));
      target.append(row);
    });
  };
  fill(els.fundingRows, bundle ? [] : funding, 'SOL in');
  fill(els.devBuyRows, devBuys, bundle ? 'SOL dev buy' : 'SOL buy');
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
  els.walletsEmpty.textContent = 'No wallet has entered this scanner’s watch window.';
  $('#wallets-head').replaceChildren(
    create('th', null, 'Funded wallet'), create('th', 'num', 'Funding'),
    create('th', null, 'Source'), create('th', 'num', 'Remaining'), create('th')
  );
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

function renderAlerts(alerts, bundle = false) {
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
      cell(bundle ? 't-mono' : 't-amount num', bundle
        ? (alert.bundleBuys ?? []).map((value) => Number(value).toFixed(3)).join(' · ')
        : sol(alert.fundingAmount)),
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

function clearRepeaters() { [els.walletFields, els.fundingFields, els.devBuyFields, els.bundleFields].forEach((node) => node.replaceChildren()); }

// Bundle amounts are positional, so their rows carry their rank.
function renumber(container) {
  [...container.querySelectorAll('.row-index')].forEach((node, index) => { node.textContent = `${index + 1}.`; });
}

function setRowMode(row, mode) {
  row.dataset.mode = mode;
  const live = row.querySelector(`.range-fields.${mode} input`);
  live?.focus({ preventScroll: true });
}
function addWalletRow(value = '') { const row = $('#wallet-row-template').content.firstElementChild.cloneNode(true); row.querySelector('[data-wallet]').value = value; bindRemove(row); els.walletFields.append(row); }
function addRangeRow(container, range = {}) {
  const row = $('#range-row-template').content.firstElementChild.cloneNode(true);
  const authored = range.target !== undefined && range.target !== null;
  row.dataset.mode = authored || range.min === undefined ? 'target' : 'bounds';
  row.querySelector('[data-min]').value = range.min ?? '';
  row.querySelector('[data-max]').value = range.max ?? '';
  row.querySelector('[data-target]').value = range.target ?? '';
  row.querySelector('[data-tolerance]').value = range.tolerance ?? 0.5;
  row.querySelector('[data-tolerance-mode]').value = range.toleranceMode ?? 'percent';
  row.querySelector('.row-mode').addEventListener('click', () => setRowMode(row, row.dataset.mode === 'target' ? 'bounds' : 'target'));
  bindRemove(row, container);
  container.append(row);
  renumber(container);
}
function bindRemove(row, container = null) { row.querySelector('.remove-row').addEventListener('click', () => { row.remove(); if (container) renumber(container); }); }

// `seed` only applies when the author switches mode by hand: openModal fills the
// sections itself, and seeding there would double every row.
function setFormMode(mode, { seed = false } = {}) {
  formMode = mode;
  if (seed && mode === 'funding' && !els.devBuyFields.children.length) addRangeRow(els.devBuyFields);
  if (seed && mode === 'bundle' && !els.bundleFields.children.length) [0, 1, 2, 3].forEach(() => addRangeRow(els.bundleFields));
  document.querySelectorAll('#mode-picker button').forEach((button) => button.classList.toggle('is-active', button.dataset.mode === mode));
  document.querySelectorAll('[data-for]').forEach((node) => {
    const visible = node.dataset.for === mode;
    node.hidden = !visible;
    // A hidden `required` field still blocks submission, and the browser cannot
    // report it because it cannot focus it — disable them instead.
    node.querySelectorAll?.('input, select').forEach((field) => { field.disabled = !visible; });
  });
}

function openModal(config = null) {
  els.form.reset(); els.formError.textContent = ''; clearRepeaters();
  $('#modal-title').textContent = config ? 'Edit configuration' : 'New configuration';
  const fields = els.form.elements;
  fields.id.value = config?.id || ''; fields.name.value = config?.name || '';
  fields.timeWindowMinutes.value = config?.timeWindowMinutes ?? 60;
  fields.telegramChatId.value = config?.telegramChatId || '';
  fields.enabled.checked = config?.enabled ?? true;
  setFormMode(config?.mode === 'bundle' ? 'bundle' : 'funding');
  (config?.watchAddresses?.length ? config.watchAddresses : ['']).forEach(addWalletRow);
  (config?.fundingRanges?.length ? config.fundingRanges : [{}]).forEach((range) => addRangeRow(els.fundingFields, range));
  const devBuySeed = config?.devBuyRanges?.length
    ? config.devBuyRanges
    : (config?.mode === 'bundle' ? [] : [{}]);
  devBuySeed.forEach((range) => addRangeRow(els.devBuyFields, range));
  (config?.bundleBuys?.length ? config.bundleBuys : [{}, {}, {}, {}]).forEach((range) => addRangeRow(els.bundleFields, range));
  // Rows are added after the first call, so re-apply the enabled/disabled split.
  setFormMode(formMode);
  els.modal.showModal(); fields.name.focus();
}

function values(selector) { return [...document.querySelectorAll(selector)].map((input) => input.value.trim()).filter(Boolean); }
function ranges(container) {
  return [...container.querySelectorAll('.range-row')].map((row) => {
    if (row.dataset.mode === 'target') {
      return {
        target: Number(row.querySelector('[data-target]').value),
        tolerance: Number(row.querySelector('[data-tolerance]').value || 0),
        toleranceMode: row.querySelector('[data-tolerance-mode]').value
      };
    }
    return { min: Number(row.querySelector('[data-min]').value), max: Number(row.querySelector('[data-max]').value) };
  });
}
function formPayload() {
  const fields = els.form.elements;
  const payload = {
    name: fields.name.value,
    mode: formMode,
    devBuyRanges: ranges(els.devBuyFields),
    timeWindowMinutes: Number(fields.timeWindowMinutes.value),
    telegramChatId: fields.telegramChatId.value.trim(),
    enabled: fields.enabled.checked
  };
  if (formMode === 'bundle') return { ...payload, watchAddresses: [], bundleBuys: ranges(els.bundleFields) };
  return { ...payload, watchAddresses: values('[data-wallet]'), fundingRanges: ranges(els.fundingFields) };
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
  if (button.dataset.add === 'wallet') return addWalletRow();
  const target = { funding: els.fundingFields, devbuy: els.devBuyFields, bundle: els.bundleFields }[button.dataset.add];
  addRangeRow(target);
}));
els.form.addEventListener('submit', async (event) => {
  event.preventDefault(); els.formError.textContent = '';
  const id = els.form.elements.id.value || null;
  try { await saveConfig(formPayload(), id); if (!id) selectedConfigId = state.configs[0]?.id || selectedConfigId; els.modal.close(); render(); } catch (error) { els.formError.textContent = error.message; }
});
document.querySelectorAll('#mode-picker button').forEach((button) => button.addEventListener('click', () => setFormMode(button.dataset.mode, { seed: true })));
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
