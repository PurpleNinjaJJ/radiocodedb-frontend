/* Radio Code DB frontend: plain static JS, no build step needed. */
'use strict';

/* ================= CONFIG ================= */
// Single place to change the API location.
const API_BASE = 'https://dbapi.radiocodeglobal.de';
const REQUEST_TIMEOUT_MS = 20000;
/* ========================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const fmt = new Intl.NumberFormat('en-GB');
const META_KEYS = new Set(['database', 'display_name', 'code_status', 'origin', 'matched_key', 'row_id']);

const state = {
  databases: null,          // array from /databases
  dbByName: {},
  dbPromise: null,
  lastSearchKey: null,
  browseReq: 0,
  searchReq: 0,
};

/* ---------- small DOM helper (never uses innerHTML for data) ---------- */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
const normKey = (s) => String(s || '').toUpperCase().replace(/[\s\-]+/g, '');
const humanCol = (c) => c.replace(/_/g, ' ');

/* ---------- API ---------- */
class ApiError extends Error {
  constructor(message, kind, status) { super(message); this.kind = kind; this.status = status; }
}

async function api(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_BASE + path, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new ApiError(
      e.name === 'AbortError' ? 'The database API took too long to answer.' : 'The database API can\u2019t be reached right now.',
      'network');
  } finally { clearTimeout(timer); }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || (body && body.ok === false)) {
    const msg = (body && body.error && (body.error.message || body.error)) || `The API returned an error (HTTP ${res.status}).`;
    throw new ApiError(String(msg), res.status >= 500 ? 'server' : 'client', res.status);
  }
  if (body == null) throw new ApiError('The API returned an unexpected response.', 'server', res.status);
  return body;
}

function setApiStatus(up, text) {
  const el = $('#api-status');
  el.classList.toggle('up', up === true);
  el.classList.toggle('down', up === false);
  $('.label', el).textContent = text;
}

async function checkHealth() {
  try {
    const r = await api('/health');
    if (r && r.ok) { setApiStatus(true, 'API online'); hideGlobalAlert(); return true; }
    throw new Error();
  } catch {
    setApiStatus(false, 'API offline');
    showGlobalAlert('The database API isn\u2019t reachable at the moment. It may still be starting up. Searches and the browser will work as soon as it\u2019s online. We\u2019ll keep checking.');
    return false;
  }
}

function showGlobalAlert(msg) {
  const box = $('#global-alert');
  clear(box).append(h('div', { class: 'alert', role: 'status' }, msg));
  box.hidden = false;
}
function hideGlobalAlert() { $('#global-alert').hidden = true; }

function loadDatabases(force = false) {
  if (state.dbPromise && !force) return state.dbPromise;
  state.dbPromise = api('/databases').then((list) => {
    if (!Array.isArray(list)) throw new ApiError('Unexpected /databases response.', 'server');
    state.databases = list;
    state.dbByName = Object.fromEntries(list.map((d) => [d.name, d]));
    return list;
  }).catch((e) => { state.dbPromise = null; throw e; });
  return state.dbPromise;
}

/* ---------- shared rendering bits ---------- */
function loadingState(text) {
  return h('div', { class: 'state' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), text);
}
function errorState(err, retry) {
  const offline = err && err.kind === 'network';
  return h('div', { class: 'state error', role: 'alert' },
    h('h3', { text: offline ? 'Can\u2019t reach the database API' : 'Something went wrong' }),
    h('p', { text: offline
      ? 'The API may still be starting up or temporarily unavailable. Please try again in a moment.'
      : (err && err.message) || 'Unknown error.' }),
    retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, 'Try again') : null);
}
function isEncoded(status) { return status === 'unverified_encoded'; }
function statusBadge(status) {
  return isEncoded(status)
    ? h('span', { class: 'badge badge-warn', title: 'Raw vendor value, not a decoded radio code' }, '\u26A0 Encoded / unverified')
    : h('span', { class: 'badge badge-ok', title: 'Stored value is a readable code' }, '\u2713 Plain code');
}
function originBadge(origin) {
  if (!origin) return null;
  const o = String(origin);
  const label = /^generated/i.test(o) ? 'Algorithm-generated' : /^collected/i.test(o) ? 'Collected' : o;
  return h('span', { class: 'badge badge-muted', title: o }, label);
}

/* ================= SEARCH VIEW ================= */
function initSearch() {
  const form = $('#search-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#q').value;
    const prefix = $('#prefix-mode').checked;
    const params = new URLSearchParams({ q: normKey(q) });
    if (prefix) params.set('mode', 'prefix');
    const target = '#search?' + params.toString();
    if (location.hash === target) runSearch(normKey(q), prefix); else location.hash = target;
  });
  document.querySelectorAll('[data-example]').forEach((b) => b.addEventListener('click', () => {
    $('#q').value = b.dataset.example;
    $('#prefix-mode').checked = false;
    form.requestSubmit();
  }));
}

async function runSearch(rawQ, prefix) {
  const out = $('#search-results');
  const q = normKey(rawQ);
  $('#q').value = q;
  $('#prefix-mode').checked = !!prefix;
  if (!q) { clear(out); return; }
  if (!/^[A-Z0-9]{3,40}$/.test(q)) {
    clear(out).append(h('div', { class: 'state error' },
      h('h3', { text: 'Check your search' }),
      h('p', { text: 'Enter 3\u201340 letters or digits, such as a radio serial, a Renault/Dacia precode or a VIN. Spaces and dashes are ignored.' })));
    return;
  }
  const reqId = ++state.searchReq;
  $('#search-btn').disabled = true;
  clear(out).append(loadingState(`Searching all databases for ${q}\u2026`));
  try {
    const params = new URLSearchParams({ q });
    if (prefix) params.set('mode', 'prefix');
    const [res] = await Promise.all([api('/search?' + params), loadDatabases().catch(() => null)]);
    if (reqId !== state.searchReq) return;
    renderSearch(res, out);
  } catch (err) {
    if (reqId !== state.searchReq) return;
    clear(out).append(errorState(err, () => runSearch(q, prefix)));
  } finally {
    if (reqId === state.searchReq) $('#search-btn').disabled = false;
  }
}

function renderSearch(res, out) {
  clear(out);
  const results = Array.isArray(res.results) ? res.results : [];
  if (!results.length) {
    out.append(h('div', { class: 'state' },
      h('h3', { text: 'No match found' }),
      h('p', null, 'No database contains ', h('code', { text: res.normalized || res.query }),
        res.mode === 'prefix' ? ' as a prefix.' : '. Try fewer characters with \u201CPrefix match\u201D turned on, or check the serial on the radio label.'),
      h('p', { class: 'small', text: 'Coverage is partial. See \u201CAbout the data\u201D for the brands and series included.' })));
    return;
  }

  // Group rows by the key they matched (same key in different databases = one group).
  const groups = new Map();
  for (const r of results) {
    const k = normKey(r.matched_key || res.normalized);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const dbCount = (rows) => new Set(rows.map((r) => r.database)).size;
  const ordered = [...groups.entries()].sort((a, b) => {
    if (a[0] === res.normalized) return -1;
    if (b[0] === res.normalized) return 1;
    return (dbCount(b[1]) > 1) - (dbCount(a[1]) > 1) || a[0].localeCompare(b[0]);
  });
  const crossGroups = ordered.filter(([, rows]) => dbCount(rows) > 1).length;
  const matchedDbs = res.databases_matched || [...new Set(results.map((r) => r.database))];

  const summary = h('div', { class: 'summary-bar' },
    h('strong', null, `${fmt.format(res.total ?? results.length)} result${(res.total ?? results.length) === 1 ? '' : 's'}`),
    h('span', { class: 'muted' }, `for `, h('code', { text: res.normalized }), ` in ${matchedDbs.length} database${matchedDbs.length === 1 ? '' : 's'}`),
    res.mode === 'prefix' ? h('span', { class: 'badge badge-muted', title: 'Keys starting with your query' }, 'Prefix match') : h('span', { class: 'badge badge-muted' }, 'Exact match'),
    crossGroups ? h('span', { class: 'badge badge-cross' }, `${crossGroups} key${crossGroups === 1 ? '' : 's'} found in several databases`) : null,
    res.returned != null && res.total > res.returned ? h('span', { class: 'small muted' }, `showing the first ${fmt.format(res.returned)}; type more characters to narrow it down`) : null);
  out.append(summary);
  if (res.mode === 'prefix' && !$('#prefix-mode').checked) {
    out.append(h('p', { class: 'small muted', text: 'No exact match was found, so these are keys that start with your search.' }));
  }

  // Keys found in several databases (and the exact searched key) get their own group;
  // remaining single-database prefix matches are listed together in one compact section.
  const singles = [];
  for (const [key, rows] of ordered) {
    if (dbCount(rows) > 1 || key === res.normalized || res.mode !== 'prefix') out.append(renderGroup(key, rows));
    else singles.push(...rows);
  }
  if (singles.length) {
    out.append(h('section', { class: 'group' },
      h('div', { class: 'group-head' },
        h('span', { class: 'group-key', text: `${res.normalized}\u2026` }),
        h('span', { class: 'badge badge-muted' }, `${singles.length} other matching key${singles.length === 1 ? '' : 's'} \u00B7 each in 1 database`)),
      h('div', { class: 'group-body' }, singles.map((r) => renderResultCard(r, true)))));
  }
}

function renderGroup(key, rows) {
  const n = new Set(rows.map((r) => r.database)).size;
  const cross = n > 1;
  return h('section', { class: 'group' + (cross ? ' cross' : '') },
    h('div', { class: 'group-head' },
      h('span', { class: 'group-key', text: key }),
      cross
        ? h('span', { class: 'badge badge-cross' }, `Found in ${n} databases`)
        : h('span', { class: 'badge badge-muted' }, `${rows.length} row${rows.length === 1 ? '' : 's'} \u00B7 1 database`),
      cross ? h('span', { class: 'small muted', text: 'The same key appears in more than one source. Compare them below; values can differ.' }) : null),
    h('div', { class: 'group-body' }, rows.map(renderResultCard)));
}

function renderResultCard(r, showKey = false) {
  const meta = state.dbByName[r.database] || {};
  const status = r.code_status || meta.code_status;
  const encoded = isEncoded(status);
  const origin = r.origin || meta.origin;
  const cols = Object.keys(r).filter((k) => !META_KEYS.has(k));

  let codeBlock = null;
  if (encoded && r.code_or_hex != null) {
    codeBlock = h('div', null,
      h('div', { class: 'code-line' },
        h('span', { class: 'small muted', text: 'Stored value (hex):' }),
        h('span', { class: 'code-hex', text: String(r.code_or_hex) })),
      h('div', { class: 'note note-warn' },
        h('strong', null, 'Not a usable radio code. '),
        'This is a raw encoded value from a vendor file. It hasn\u2019t been decoded or verified, so don\u2019t enter it into the radio.'));
  } else if (r.code != null && r.code !== '') {
    const c = String(r.code);
    const placeholder = /^0+$/.test(c);
    codeBlock = h('div', null,
      h('div', { class: 'code-line' }, h('span', { class: 'small muted', text: 'Code:' }), h('span', { class: 'code-big', text: c })),
      placeholder ? h('div', { class: 'note note-warn', text: 'A code of all zeros is probably a placeholder or invalid entry.' }) : null,
      /^generated/i.test(origin || '') ? h('div', { class: 'note note-info', text: 'Calculated by a public algorithm, not tested on this radio.' }) : null);
  }

  return h('article', { class: 'card' + (encoded ? ' warn' : '') },
    showKey ? h('div', { class: 'card-key', text: r.matched_key }) : null,
    h('div', { class: 'card-head' },
      h('span', { class: 'badge badge-db', title: r.database }, r.display_name || meta.display_name || r.database),
      h('span', null, statusBadge(status), ' ', originBadge(origin))),
    codeBlock,
    h('table', { class: 'kv' }, h('tbody', null,
      cols.map((c) => h('tr', null, h('th', { text: humanCol(c) }), h('td', { text: r[c] == null ? '\u2014' : String(r[c]) }))),
      h('tr', null, h('th', { text: 'database' }), h('td', { text: r.database })),
      r.row_id != null ? h('tr', null, h('th', { text: 'row id' }), h('td', { text: String(r.row_id) })) : null)),
    h('div', { class: 'small' }, h('a', { href: browseHash(r.database, r.row_id ? Math.ceil(r.row_id / 50) : 1, 50) }, 'Open this database in the browser \u2192')));
}

/* ================= BROWSER VIEW ================= */
function browseHash(db, page = 1, size = 50) {
  return '#browse?' + new URLSearchParams({ db, page: String(page), size: String(size) });
}

function initBrowse() {
  $('#db-select').addEventListener('change', (e) => { if (e.target.value) location.hash = browseHash(e.target.value, 1, $('#page-size').value); });
  $('#page-size').addEventListener('change', (e) => { const db = $('#db-select').value; if (db) location.hash = browseHash(db, 1, e.target.value); });
  const go = (fn) => () => { const s = currentBrowse(); if (!s) return; const p = fn(s); if (p) location.hash = browseHash(s.db, p, s.size); };
  $('#first-page').addEventListener('click', go(() => 1));
  $('#prev-page').addEventListener('click', go((s) => Math.max(1, s.page - 1)));
  $('#next-page').addEventListener('click', go((s) => Math.min(s.totalPages || s.page + 1, s.page + 1)));
  $('#last-page').addEventListener('click', go((s) => s.totalPages));
  $('#jump-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const s = currentBrowse(); if (!s) return;
    let p = parseInt($('#page-input').value, 10);
    if (!Number.isFinite(p) || p < 1) p = 1;
    if (s.totalPages) p = Math.min(p, s.totalPages);
    location.hash = browseHash(s.db, p, s.size);
  });
}

let browseView = null; // {db,page,size,totalPages}
const currentBrowse = () => browseView;

async function populateDbSelect(selected) {
  const sel = $('#db-select');
  try {
    const list = await loadDatabases();
    clear(sel).append(h('option', { value: '' }, 'Choose a database\u2026'),
      ...list.map((d) => h('option', { value: d.name }, `${d.display_name} (${fmt.format(d.row_count)} rows)`)));
    sel.value = selected && state.dbByName[selected] ? selected : '';
    return list;
  } catch (err) {
    clear(sel).append(h('option', { value: '' }, 'Unavailable'));
    throw err;
  }
}

async function showBrowse(params) {
  const tableBox = $('#browse-table');
  const metaBox = $('#db-meta');
  let db = params.get('db') || '';
  let page = Math.max(1, parseInt(params.get('page'), 10) || 1);
  let size = parseInt(params.get('size'), 10) || 50;
  size = Math.min(200, Math.max(1, size));
  if (![...$('#page-size').options].some((o) => +o.value === size)) $('#page-size').append(h('option', { value: String(size) }, String(size)));
  $('#page-size').value = String(size);

  const reqId = ++state.browseReq;
  try {
    if (!state.databases) { clear(tableBox).append(loadingState('Loading the list of databases\u2026')); }
    await populateDbSelect(db);
  } catch (err) {
    if (reqId !== state.browseReq) return;
    clear(metaBox); $('#pager').hidden = true;
    clear(tableBox).append(errorState(err, () => showBrowse(params)));
    return;
  }
  if (reqId !== state.browseReq) return;

  if (!db || !state.dbByName[db]) {
    browseView = null; $('#pager').hidden = true; clear(metaBox);
    clear(tableBox).append(h('div', { class: 'state' },
      h('h3', { text: db ? 'Unknown database' : 'Pick a database' }),
      h('p', { text: 'Choose a database from the list above to see its rows page by page.' })),
      h('div', { class: 'db-grid mt' }, state.databases.map(dbCard)));
    return;
  }

  renderDbMeta(state.dbByName[db], metaBox);
  clear(tableBox).append(loadingState(`Loading page ${fmt.format(page)}\u2026`));
  setPagerDisabled(true);
  try {
    const res = await api('/browse?' + new URLSearchParams({ db, page: String(page), pageSize: String(size) }));
    if (reqId !== state.browseReq) return;
    browseView = { db, page: res.page || page, size: res.pageSize || size, totalPages: res.totalPages || 1, total: res.total };
    if (browseView.totalPages && browseView.page > browseView.totalPages && browseView.totalPages > 0) {
      location.hash = browseHash(db, browseView.totalPages, size); return;
    }
    renderTable(res, tableBox);
    updatePager();
  } catch (err) {
    if (reqId !== state.browseReq) return;
    $('#pager').hidden = true;
    clear(tableBox).append(errorState(err, () => showBrowse(params)));
  }
}

function renderDbMeta(d, box) {
  const encoded = isEncoded(d.code_status);
  clear(box).append(h('div', { class: 'meta-panel' },
    h('div', { class: 'meta-top' }, h('h2', { text: d.display_name }), statusBadge(d.code_status), originBadge(d.origin)),
    h('dl', { class: 'meta-grid' },
      metaItem('Rows', fmt.format(d.row_count)),
      metaItem('Search key', d.key_column),
      metaItem('Columns', (d.columns || []).join(', ')),
      metaItem('Origin', d.origin),
      d.source_url ? h('div', null, h('dt', { text: 'Source' }), h('dd', null, h('a', { href: d.source_url, target: '_blank', rel: 'noopener noreferrer' }, shortUrl(d.source_url)))) : null),
    encoded ? h('div', { class: 'note note-warn' }, h('strong', null, 'Heads up: '), 'the code_or_hex column holds raw encoded vendor values, not working radio codes.') : null,
    d.notes ? h('details', null, h('summary', { class: 'small' }, 'Notes about this data'), h('p', { class: 'small', text: d.notes })) : null));
}
const metaItem = (k, v) => h('div', null, h('dt', { text: k }), h('dd', { text: v == null || v === '' ? '\u2014' : String(v) }));
function shortUrl(u) { try { const x = new URL(u); return x.host + x.pathname.replace(/\/$/, ''); } catch { return u; } }

function renderTable(res, box) {
  const rows = res.rows || [];
  const cols = (res.columns && res.columns.length) ? res.columns : (rows[0] ? Object.keys(rows[0]) : []);
  if (!rows.length) {
    clear(box).append(h('div', { class: 'state' }, h('h3', { text: 'No rows on this page' }), h('p', { text: 'Try an earlier page.' })));
    return;
  }
  const encoded = isEncoded(res.code_status);
  clear(box).append(h('div', { class: 'table-wrap' },
    h('table', { class: 'data' },
      h('thead', null, h('tr', null, cols.map((c) => h('th', { scope: 'col', text: humanCol(c) + (c === 'code_or_hex' ? ' \u26A0' : ''), title: c === 'code_or_hex' ? 'Encoded vendor value, not a verified code' : null })))),
      h('tbody', null, rows.map((r) => h('tr', null, cols.map((c) => h('td', {
        class: c === 'code_or_hex' && encoded ? 'hex' : (c === 'code' ? 'code' : null),
        text: r[c] == null ? '\u2014' : String(r[c]),
      }))))))));
}

function setPagerDisabled(dis) {
  ['#first-page', '#prev-page', '#next-page', '#last-page', '#page-input'].forEach((s) => { $(s).disabled = dis; });
}
function updatePager() {
  const s = browseView; const pager = $('#pager');
  pager.hidden = false;
  setPagerDisabled(false);
  $('#first-page').disabled = $('#prev-page').disabled = s.page <= 1;
  $('#next-page').disabled = $('#last-page').disabled = s.page >= s.totalPages;
  $('#page-input').value = String(s.page);
  $('#page-input').max = String(s.totalPages);
  $('#total-pages').textContent = fmt.format(s.totalPages);
  const from = (s.page - 1) * s.size + 1, to = Math.min(s.total, s.page * s.size);
  $('#page-summary').textContent = s.total ? `Rows ${fmt.format(from)}\u2013${fmt.format(to)} of ${fmt.format(s.total)}` : '';
}

/* ================= ABOUT VIEW ================= */
function dbCard(d) {
  return h('article', { class: 'db-card' },
    h('div', { class: 'card-head' }, h('strong', { text: d.display_name })),
    h('div', null, statusBadge(d.code_status), ' ', originBadge(d.origin), ' ', h('span', { class: 'badge badge-db' }, `${fmt.format(d.row_count)} rows`)),
    h('p', null, h('span', { class: 'muted' }, 'Columns: '), h('code', { text: (d.columns || []).join(', ') })),
    h('p', null, h('span', { class: 'muted' }, 'Search key: '), h('code', { text: d.key_column || '\u2014' })),
    d.source_url ? h('p', null, h('span', { class: 'muted' }, 'Source: '), h('a', { href: d.source_url, target: '_blank', rel: 'noopener noreferrer' }, shortUrl(d.source_url))) : null,
    d.notes ? h('p', { class: 'small', text: d.notes }) : null,
    h('div', { class: 'actions' }, h('a', { class: 'btn', href: browseHash(d.name, 1, 50) }, 'Browse rows \u2192')));
}

async function showAbout() {
  const list = $('#about-list'); const sum = $('#about-summary');
  if (!state.databases) clear(list).append(loadingState('Loading database details\u2026'));
  try {
    const dbs = await loadDatabases();
    const total = dbs.reduce((a, d) => a + (Number(d.row_count) || 0), 0);
    const plain = dbs.filter((d) => !isEncoded(d.code_status));
    clear(sum).append(
      h('div', { class: 'stat' }, h('b', { text: String(dbs.length) }), h('span', { class: 'muted small' }, 'databases')),
      h('div', { class: 'stat' }, h('b', { text: fmt.format(total) }), h('span', { class: 'muted small' }, 'rows in total')),
      h('div', { class: 'stat' }, h('b', { text: fmt.format(plain.reduce((a, d) => a + (Number(d.row_count) || 0), 0)) }), h('span', { class: 'muted small' }, 'rows with plain codes')));
    clear(list).append(...dbs.map(dbCard));
  } catch (err) {
    clear(sum);
    clear(list).append(errorState(err, showAbout));
  }
}

/* ================= ROUTER ================= */
function route() {
  const raw = location.hash.replace(/^#/, '') || 'search';
  const [view0, qs = ''] = raw.split('?');
  const view = ['search', 'browse', 'about'].includes(view0) ? view0 : 'search';
  const params = new URLSearchParams(qs);
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === view;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (view === 'search') {
    document.title = 'Radio Code DB: search car radio serials, precodes and VINs';
    const q = params.get('q');
    const key = q ? normKey(q) + '|' + params.get('mode') : null;
    if (q && key !== state.lastSearchKey) { state.lastSearchKey = key; runSearch(q, params.get('mode') === 'prefix'); }
    else if (!q) { state.lastSearchKey = null; clear($('#search-results')); }
    if (!q) $('#q').focus({ preventScroll: true });
  } else if (view === 'browse') {
    document.title = 'Database browser \u00B7 Radio Code DB';
    showBrowse(params);
  } else {
    document.title = 'About the data \u00B7 Radio Code DB';
    showAbout();
  }
  window.scrollTo({ top: 0 });
}

/* ================= BOOT ================= */
function boot() {
  $('#api-base-label').textContent = API_BASE.replace(/^https?:\/\//, '');
  initSearch();
  initBrowse();
  window.addEventListener('hashchange', route);
  route();
  checkHealth().then((ok) => {
    // Keep polling while offline so the UI recovers once the API comes up.
    if (!ok) {
      const t = setInterval(async () => {
        if (await checkHealth()) {
          clearInterval(t);
          state.dbPromise = null;
          state.lastSearchKey = null;
          route();
        }
      }, 15000);
    }
  });
}
boot();
