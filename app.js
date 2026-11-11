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

/* ================= BRAND DETECTION ================= */
// Logos that exist in assets/logos/. becker/rover/unknown are plain text wordmarks.
const LOGO_FILES = new Set(['alfaromeo', 'alpine', 'audi', 'becker', 'blaupunkt', 'bmw', 'chrysler', 'citroen', 'clarion',
  'continental', 'dacia', 'dodge', 'fiat', 'ford', 'grundig', 'harman', 'honda', 'jaguar', 'jeep', 'mercedes', 'mitsubishi',
  'nissan', 'opel', 'panasonic', 'peugeot', 'philips', 'renault', 'rover', 'saab', 'seat', 'skoda', 'smart', 'sony', 'subaru',
  'technisat', 'toyota', 'unknown', 'vauxhall', 'visteon', 'volkswagen', 'volvo']);
const TEXT_LOGOS = new Set(['becker', 'rover', 'unknown']);
const RADIO_MAKERS = new Set(['Blaupunkt', 'Grundig', 'Philips', 'Continental', 'Becker', 'Panasonic', 'Alpine', 'Clarion',
  'TechniSat', 'Harman', 'Visteon', 'Sony', 'Delphi']);
const NAME_ALIASES = { 'alfa romeo': 'alfaromeo', 'citroën': 'citroen', 'mercedes-benz': 'mercedes', vw: 'volkswagen', mini: null, porsche: null };

// Rules whose serial format is shared by several car makes: never assert one make.
// Candidate lists follow the public format guides; a radio maker's prefix does not encode the car.
const SHARED = {
  'Blaupunkt': { cars: ['Ford', 'Nissan', 'Fiat', 'Alfa Romeo', 'Peugeot', 'Mercedes', 'Renault', 'Vauxhall'], why: 'Blaupunkt (BP) serials are used across many car makes.' },
  'Continental': { cars: ['Fiat', 'Alfa Romeo', 'Chrysler', 'Jeep', 'Peugeot', 'Citroën'], why: 'Continental (A2C/A3C) units are fitted by several car makes.' },
  'Becker': { cars: ['Mercedes', 'Porsche', 'BMW'], why: 'Becker (BE) units are fitted by several car makes.' },
  'Chrysler / Jeep / Dodge': { cars: ['Chrysler', 'Jeep', 'Dodge'], why: 'Chrysler, Jeep and Dodge share these radios.' },
  'Renault / Dacia': { cars: ['Renault', 'Dacia'], why: 'Renault and Dacia share this radio-code scheme.' },
  'Opel / Vauxhall': { cars: ['Opel', 'Vauxhall'], why: 'Opel and Vauxhall share these radios.' },
  'Rover / MINI': { cars: ['Rover', 'MINI'], why: 'Rover and MINI share these Philips radios.' },
};
const SHARED_BY_PREFIX = {
  '2811': { cars: ['Renault', 'Dacia', 'Opel', 'Vauxhall', 'Mercedes'], why: 'Renault-made units with this part number are also fitted to Opel/Vauxhall and Mercedes vans.' },
  '8200': { cars: ['Renault', 'Dacia', 'Opel', 'Vauxhall'], why: 'Renault-made units with this part number are also fitted to Opel/Vauxhall vans.' },
  '7700': { cars: ['Renault', 'Dacia', 'Opel', 'Vauxhall'], why: 'Renault-made units with this part number are also fitted to Opel/Vauxhall vans.' },
};
// Generic radio-maker serials where the car make is not part of the serial.
const MAKER_ONLY = new Set(['Philips', 'Grundig']);

const brandState = { rules: null, promise: null };

function cleanName(n) { return String(n || '').replace(/\s*\(.*\)\s*$/, '').trim(); }
function logoFor(name) {
  const k = String(name || '').trim().toLowerCase();
  const alias = Object.prototype.hasOwnProperty.call(NAME_ALIASES, k) ? NAME_ALIASES[k] : k.replace(/[^a-z]/g, '');
  return alias && LOGO_FILES.has(alias) ? alias + '.svg' : null;
}
const logoUrl = (file) => 'assets/logos/' + file;

function loadBrands() {
  if (brandState.promise) return brandState.promise;
  brandState.promise = fetch('assets/brands.json', { headers: { Accept: 'application/json' } })
    .then((r) => { if (!r.ok) throw new Error('brands.json HTTP ' + r.status); return r.json(); })
    .then((rules) => {
      brandState.rules = rules.map((r) => {
        let re = null;
        if (r.pattern) { try { re = new RegExp(r.pattern); } catch { re = null; } }
        return Object.assign({}, r, { prefix: String(r.prefix || '').toUpperCase(), re });
      });
      return brandState.rules;
    })
    .catch((e) => { brandState.promise = null; console.warn('Brand rules unavailable:', e.message); return []; });
  return brandState.promise;
}

function matchRule(s) {
  for (const r of brandState.rules || []) {
    if (r.re) { if (r.re.test(s)) return r; continue; }
    if (r.pattern) continue; // unparsable pattern: skip rather than guess
    if (r.prefix === '') { if (r.brand !== 'Unknown') return r; continue; }
    if (s.startsWith(r.prefix)) return r;
  }
  return null;
}

/* Returns {state, s, rule, brand:{name,logo}|null, cars:[{name,logo}], maker:{name,logo}|null, series, why}
   state: empty | confident | tentative | shared | maker | partial | unknown */
function detectBrand(raw) {
  const s = normKey(raw);
  if (!s) return { state: 'empty', s };
  if (!brandState.rules) return { state: 'loading', s };
  const rule = matchRule(s);
  if (!rule) {
    // A pattern-based rule whose literal prefix fits what was typed so far: keep typing.
    const partial = (brandState.rules || []).find((r) => r.re && r.prefix && (s.startsWith(r.prefix) || r.prefix.startsWith(s)) && s.length <= 17);
    if (partial && s.length >= 1) return { state: 'partial', s, rule: partial, brand: { name: cleanName(partial.brand), logo: partial.logo } };
    return { state: 'unknown', s };
  }
  const name = cleanName(rule.brand);
  // radio maker
  let maker = null; let series = null;
  if (rule.maker) {
    const m = rule.maker;
    const firstWord = name.split(/[\s/]+/)[0];
    if (rule.maker_logo) maker = { name: m, logo: rule.maker_logo };
    else if (/sony/i.test(m)) maker = { name: 'Sony', logo: 'sony.svg' };
    else if (m.toLowerCase().includes(firstWord.toLowerCase())) series = m;
    else maker = { name: m, logo: logoFor(m.split(/[\s/]+/)[0]) };
  }
  const shared = SHARED_BY_PREFIX[rule.prefix] || SHARED[name];
  const toCar = (n) => ({ name: n, logo: logoFor(n) });
  if (MAKER_ONLY.has(name)) {
    return { state: 'maker', s, rule, maker: { name, logo: rule.logo }, cars: [], why: rule.note || 'The car make is not encoded in this serial.' };
  }
  if (shared) {
    const isMaker = RADIO_MAKERS.has(name);
    return { state: 'shared', s, rule, cars: shared.cars.map(toCar), why: shared.why,
      maker: isMaker ? { name, logo: rule.logo } : maker, series };
  }
  const conf = rule.confidence || 'medium';
  return { state: conf === 'high' ? 'confident' : 'tentative', s, rule, brand: { name, logo: rule.logo }, maker, series };
}

function logoImg(file, alt, cls) {
  if (!file) return h('span', { class: (cls || '') + ' logo-text', 'aria-hidden': alt ? null : 'true' }, alt ? alt.slice(0, 2).toUpperCase() : '?');
  return h('img', { class: cls || 'brand-logo', src: logoUrl(file), alt: alt || '', decoding: 'async', width: '40', height: '40' });
}
const CHECK_SVG = () => { const t = document.createElement('template'); t.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" class="ico"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; return t.content.firstChild; };
const INFO_SVG = () => { const t = document.createElement('template'); t.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" class="ico"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v5M12 7.5v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'; return t.content.firstChild; };

function makerBadge(d) {
  if (d.maker) return h('span', { class: 'maker-badge' }, d.maker.logo && !TEXT_LOGOS.has(d.maker.logo.replace('.svg', '')) ? h('img', { src: logoUrl(d.maker.logo), alt: '', class: 'maker-logo', width: '60', height: '16' }) : null, `${d.maker.name} radio`);
  if (d.series) return h('span', { class: 'maker-badge series' }, d.series);
  return null;
}

/* Renders the detection strip. compact=true for result cards. */
function renderDetection(d, compact = false) {
  const wrap = h('div', { class: `detect-inner det-${d.state}` + (compact ? ' compact' : '') });
  const add = (...xs) => wrap.append(...xs.filter((x) => x != null && x !== false));
  switch (d.state) {
    case 'empty':
      add(h('span', { class: 'detect-placeholder' }, 'Start typing: we’ll recognise the brand from the serial.'));
      break;
    case 'loading':
      add(h('span', { class: 'detect-placeholder' }, 'Loading brand rules…'));
      break;
    case 'confident':
      add(h('span', { class: 'det-icon ok' }, CHECK_SVG()), logoImg(d.brand.logo, `${d.brand.name} logo`, 'det-logo'),
        h('span', { class: 'det-text' }, compact ? null : h('span', { class: 'det-kicker' }, 'Recognised'), h('strong', null, d.brand.name)),
        makerBadge(d));
      break;
    case 'tentative':
      add(h('span', { class: 'det-icon maybe' }, INFO_SVG()), logoImg(d.brand.logo, `${d.brand.name} logo`, 'det-logo'),
        h('span', { class: 'det-text' }, h('span', { class: 'det-kicker' }, 'Probably'), h('strong', null, d.brand.name)),
        makerBadge(d), h('span', { class: 'tag-tentative', title: d.rule.note || 'This prefix is a likely but not certain match' }, 'tentative'));
      break;
    case 'shared':
      add(h('span', { class: 'det-icon maybe' }, INFO_SVG()),
        h('span', { class: 'det-text' }, h('span', { class: 'det-kicker' }, 'Shared format'), h('strong', null, compact ? 'Several possible car makes' : 'More than one car make uses this serial')),
        makerBadge(d),
        h('div', { class: 'det-cands', role: 'list', 'aria-label': 'Possible car makes' },
          d.cars.map((c) => h('span', { class: 'cand', role: 'listitem' }, c.logo && !TEXT_LOGOS.has(c.logo.replace('.svg', '')) ? h('img', { src: logoUrl(c.logo), alt: '', width: '20', height: '20' }) : null, c.name))),
        compact ? null : h('p', { class: 'det-why' }, d.why + ' We search every database either way.'));
      break;
    case 'maker':
      add(h('span', { class: 'det-icon maybe' }, INFO_SVG()), logoImg(d.maker.logo, `${d.maker.name} logo`, 'det-logo wide'),
        h('span', { class: 'det-text' }, h('span', { class: 'det-kicker' }, 'Radio maker'), h('strong', null, `${d.maker.name} radio`)),
        compact ? null : h('p', { class: 'det-why' }, 'This serial identifies the radio manufacturer; the car make isn’t part of it.'));
      break;
    case 'partial':
      add(h('span', { class: 'det-icon idle' }, INFO_SVG()), logoImg(d.brand.logo, '', 'det-logo faded'),
        h('span', { class: 'det-text' }, h('span', { class: 'det-kicker' }, 'Keep typing'), h('span', null, `Could be ${d.brand.name}${d.rule.maker ? ' (' + d.rule.maker + ')' : ''}`)));
      break;
    default:
      if (!compact && d.s && d.s.length < 3) { add(h('span', { class: 'detect-placeholder' }, 'Keep typing…')); break; }
      add(h('span', { class: 'det-icon idle' }, INFO_SVG()),
        h('span', { class: 'det-text' }, h('span', { class: 'det-kicker' }, 'Not recognised'), h('span', null, compact ? 'Brand unknown' : 'We don’t recognise this format, but we’ll still search every database.')));
  }
  return wrap;
}

let detectTimer = null;
function updateLiveDetection(immediate = false) {
  clearTimeout(detectTimer);
  const run = () => {
    const d = detectBrand($('#q').value);
    const box = $('#detect');
    box.className = 'detect' + (d.state === 'empty' ? ' is-empty' : '');
    clear(box).append(renderDetection(d));
    const recognised = ['confident', 'tentative', 'shared', 'maker'].includes(d.state);
    $('#search-btn .btn-label').textContent = recognised ? 'Get my code' : 'Find my code';
  };
  if (immediate) run(); else detectTimer = setTimeout(run, 160);
}

/* Brand wall + marquee, derived from brands.json */
function brandCatalog() {
  const cars = new Map(); const makers = new Map();
  const addCar = (name, logo, rows) => {
    name = cleanName(name); if (!name || name === 'Unknown') return;
    if (RADIO_MAKERS.has(name)) { addMaker(name, logo); return; }
    const file = logo || logoFor(name); if (!file || TEXT_LOGOS.has(file.replace('.svg', ''))) return;
    const cur = cars.get(file);
    if (cur) { cur.rules++; cur.rows += rows; } else cars.set(file, { name, logo: file, rules: 1, rows });
  };
  const addMaker = (name, logo) => {
    name = cleanName(name).split(' / ')[0];
    const file = logo || logoFor(name); if (!file || TEXT_LOGOS.has(file.replace('.svg', ''))) return;
    if (!makers.has(file)) makers.set(file, { name, logo: file });
  };
  for (const r of brandState.rules || []) {
    const rows = r.db_rows ? Object.values(r.db_rows).reduce((a, b) => a + (Number(b) || 0), 0) : 0;
    const name = cleanName(r.brand);
    if (SHARED[name] && !RADIO_MAKERS.has(name)) SHARED[name].cars.forEach((c) => addCar(c, null, rows));
    else addCar(name, r.logo, rows);
    if (r.maker_logo) addMaker(r.maker, r.maker_logo);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { cars: [...cars.values()].sort(byName), makers: [...makers.values()].sort(byName) };
}

function renderBrandWalls() {
  const { cars, makers } = brandCatalog();
  const tile = (b) => h('div', { class: 'brand-tile', role: 'listitem' },
    h('span', { class: 'brand-tile-logo' }, h('img', { src: logoUrl(b.logo), alt: `${b.name} logo`, loading: 'lazy', decoding: 'async', width: '64', height: '48' })),
    h('span', { class: 'brand-tile-name' }, b.name),
    b.rows ? h('span', { class: 'brand-tile-meta' }, `${fmtShort(b.rows)} records`) : h('span', { class: 'brand-tile-meta' }, 'Serial recognised'));
  const carsBox = $('#brand-wall-cars'); const makersBox = $('#brand-wall-makers');
  carsBox.setAttribute('role', 'list'); makersBox.setAttribute('role', 'list');
  clear(carsBox).append(...cars.map(tile));
  clear(makersBox).append(...makers.map(tile));
  const st = $('#stat-brands'); if (st) st.textContent = String(cars.length + makers.length);
  const mq = $('#marquee');
  if (mq) {
    const imgs = () => cars.map((b) => h('img', { src: logoUrl(b.logo), alt: '', loading: 'lazy', width: '36', height: '36' }));
    clear(mq).append(h('div', { class: 'marquee-set' }, imgs()), h('div', { class: 'marquee-set' }, imgs()));
  }
}
function fmtShort(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

/* Database → logo (for the browser and about cards) */
function dbLogo(d) {
  const n = String(d.name || '').toLowerCase();
  const first = n.split(/[_\-]/)[0];
  const direct = logoFor(first === 'vw' ? 'volkswagen' : first);
  if (direct && !TEXT_LOGOS.has(direct.replace('.svg', ''))) return direct;
  const disp = String(d.display_name || '').toLowerCase();
  for (const f of LOGO_FILES) if (!TEXT_LOGOS.has(f) && disp.includes(f)) return f + '.svg';
  if (/\bvw\b/.test(disp)) return 'volkswagen.svg';
  return null;
}

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
    updateLiveDetection(true);
    form.requestSubmit();
  }));
  const q = $('#q');
  q.addEventListener('input', () => {
    // Show it uppercased as the user types, keeping the caret in place.
    const pos = q.selectionStart; const up = q.value.toUpperCase();
    if (up !== q.value) { q.value = up; try { q.setSelectionRange(pos, pos); } catch { /* ignore */ } }
    updateLiveDetection();
  });
  // Rotating example placeholder (pauses while focused or filled).
  const samples = ['VWZ1Z2S4292662', 'AUZ2Z3S1445929', 'M813402', 'B200', 'V536284', 'SKZ1Z2F1234567', 'BP738376741038', 'T00BE309752008'];
  let i = 0;
  setInterval(() => {
    if (document.activeElement === q || q.value) return;
    i = (i + 1) % samples.length; q.placeholder = 'Try ' + samples[i];
  }, 2600);
}

async function runSearch(rawQ, prefix) {
  const out = $('#search-results');
  const q = normKey(rawQ);
  $('#q').value = q;
  $('#prefix-mode').checked = !!prefix;
  updateLiveDetection(true);
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
    state.lastRes = res;
    renderSearch(res, out);
    if (window.matchMedia('(max-width: 860px)').matches) out.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      renderDetection(detectBrand(key), true),
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

  const det = detectBrand(r.matched_key || r.serial || '');
  return h('article', { class: 'card' + (encoded ? ' warn' : '') },
    showKey ? h('div', { class: 'card-key', text: r.matched_key }) : null,
    showKey ? renderDetection(det, true) : cardBrandLine(det),
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

function cardBrandLine(d) {
  if (d.state === 'confident' || d.state === 'tentative') {
    return h('div', { class: 'card-brand' }, logoImg(d.brand.logo, `${d.brand.name} logo`, 'card-logo'),
      h('span', null, h('strong', null, d.brand.name), d.state === 'tentative' ? ' (probably)' : ''), makerBadge(d));
  }
  if (d.state === 'maker') return h('div', { class: 'card-brand' }, logoImg(d.maker.logo, `${d.maker.name} logo`, 'card-logo wide'), h('span', null, `${d.maker.name} radio`));
  if (d.state === 'shared') return h('div', { class: 'card-brand' }, h('span', { class: 'muted' }, 'Shared format: ' + d.cars.map((c) => c.name).join(', ')), makerBadge(d));
  return null;
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
    h('div', { class: 'meta-top' }, dbLogo(d) ? h('span', { class: 'db-logo' }, h('img', { src: logoUrl(dbLogo(d)), alt: '', width: '40', height: '40' })) : null,
      h('h2', { text: d.display_name }), statusBadge(d.code_status), originBadge(d.origin)),
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
    h('div', { class: 'db-card-head' }, dbLogo(d) ? h('span', { class: 'db-logo' }, h('img', { src: logoUrl(dbLogo(d)), alt: '', width: '40', height: '40' })) : h('span', { class: 'db-logo db-logo-empty', 'aria-hidden': 'true' }, 'DB'), h('strong', { text: d.display_name })),
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
  const anchor = ['brands', 'how'].includes(view0) ? view0 : null;
  const view = ['search', 'browse', 'about'].includes(view0) ? view0 : 'search';
  const params = new URLSearchParams(qs);
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
  document.querySelectorAll('.nav-link').forEach((t) => {
    const on = t.dataset.view === view && (t.dataset.anchor || null) === anchor;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  if (view === 'search') {
    document.title = 'Radio Code DB: search car radio serials, precodes and VINs';
    const q = params.get('q');
    const key = q ? normKey(q) + '|' + params.get('mode') : null;
    if (q && key !== state.lastSearchKey) { state.lastSearchKey = key; runSearch(q, params.get('mode') === 'prefix'); }
    else if (!q && !anchor) { state.lastSearchKey = null; state.lastRes = null; clear($('#search-results')); }
    if (!q && !anchor && window.matchMedia('(min-width: 861px)').matches) $('#q').focus({ preventScroll: true });
  } else if (view === 'browse') {
    document.title = 'Database browser \u00B7 Radio Code DB';
    showBrowse(params);
  } else {
    document.title = 'About the data \u00B7 Radio Code DB';
    showAbout();
  }
  if (anchor) { const el = document.getElementById(anchor); if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' })); }
  else window.scrollTo({ top: 0 });
}

/* Hero + stats numbers from /databases */
async function renderStats() {
  try {
    const dbs = await loadDatabases();
    const total = dbs.reduce((a, d) => a + (Number(d.row_count) || 0), 0);
    const plain = dbs.filter((d) => !isEncoded(d.code_status)).reduce((a, d) => a + (Number(d.row_count) || 0), 0);
    $('#stat-rows').textContent = fmtShort(total) + '+';
    $('#stat-dbs').textContent = String(dbs.length);
    clear($('#stats')).append(
      h('div', { class: 'stat' }, h('b', { text: fmt.format(total) }), h('span', null, 'records searched on every lookup')),
      h('div', { class: 'stat' }, h('b', { text: fmt.format(plain) }), h('span', null, 'rows with plain, readable codes')),
      h('div', { class: 'stat' }, h('b', { text: String(dbs.length) }), h('span', null, 'public databases combined')));
  } catch { /* hero keeps its defaults */ }
}

/* ================= BOOT ================= */
function boot() {
  $('#api-base-label').textContent = API_BASE.replace(/^https?:\/\//, '');
  initSearch();
  initBrowse();
  loadBrands().then(() => {
    renderBrandWalls();
    updateLiveDetection(true);
    // Re-render search results so cards get brand logos if results arrived first.
    if (state.lastRes && !$('#view-search').hidden) renderSearch(state.lastRes, $('#search-results'));
  });
  renderStats();
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
