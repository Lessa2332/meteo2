'use strict';
/*
  WeatherLab 2.0 — метеощоденник географа.
  Без залежностей і без збірки. Залежить лише від i18n.js.
  Усі дані лишаються в localStorage цього браузера.
  Назовні йдуть тільки запити до Open-Meteo (координати місця, округлені до ~1 км).
  Жодних innerHTML: увесь вміст створюється через textContent, тому імпортований файл
  не може вставити розмітку чи скрипт.
*/

const APP_VERSION = '2.0.0';
const STORE_KEY = 'weatherlab.v2';
const MAX_RECORDS = 4000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,40}$/;
const RECENT_DAYS = 85; // Open-Meteo forecast API дає минулі дні до 92; лишаємо запас

const API = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  archive: 'https://archive-api.open-meteo.com/v1/archive',
  geocode: 'https://geocoding-api.open-meteo.com/v1/search'
};

const SKY = [
  { k: 'clear', e: '☀️' }, { k: 'partly', e: '🌤️' }, { k: 'cloudy', e: '☁️' },
  { k: 'rain', e: '🌧️' }, { k: 'storm', e: '⛈️' }, { k: 'snow', e: '❄️' }, { k: 'fog', e: '🌫️' }
];
const MOOD = [
  { k: 'joy', e: '😀' }, { k: 'ok', e: '😐' }, { k: 'sad', e: '😢' }, { k: 'wow', e: '🤩' }, { k: 'sleepy', e: '😴' }
];
const AVATARS = ['🦊', '🐱', '🐶', '🐼', '🦄', '🚀', '🌈', '🦉', '🐢', '🌻'];
const SKY_KEYS = SKY.map(s => s.k);
const MOOD_KEYS = MOOD.map(s => s.k);
const WET_SKY = new Set(['rain', 'storm', 'snow']);

const DEFAULT_CITY = { name: 'Київ', admin: '', country: 'Україна', lat: 50.45, lon: 30.52, tz: 'Europe/Kyiv' };

// Шкала кольорів температури (°C → RGB). Та сама шкала — у клітинках, легенді й графіку.
const TEMP_STOPS = [
  [-25, [42, 63, 154]], [-15, [59, 111, 196]], [-5, [111, 168, 220]], [0, [169, 211, 235]],
  [5, [189, 227, 208]], [10, [220, 235, 160]], [15, [243, 226, 123]], [20, [247, 190, 91]],
  [25, [242, 144, 63]], [30, [224, 96, 58]], [35, [178, 58, 72]]
];
// Текст на кольорових клітинках: чорний або білий. З чорним обидва варіанти дають контраст ≥ 4,5:1
// на всій шкалі (з темно-синім між ними лишалася зона, де не вистачало обох).
const CELL_DARK_RGB = [0, 0, 0];
const WHITE_RGB = [255, 255, 255];

/* ───────────── допоміжне ───────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

function svgEl(tag, attrs, ...kids) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

const pad = n => String(n).padStart(2, '0');
const round = (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f; };
const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function num(v, min, max) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
function cleanStr(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ').trim().slice(0, max) : '';
}

/* ───────────── мова ───────────── */

const state = {
  store: null,
  view: { y: 2000, m: 0 },
  activeKey: null,
  storageOk: true,
  busy: false,
  toastTimer: null,
  chartW: 0,
  resizeTimer: null
};

const lang = () => state.store.lang;
const P = () => state.store.profiles.find(p => p.id === state.store.active);
const imperial = () => state.store.units === 'imperial';

function pluralIndex(l, n) {
  n = Math.abs(Number(n));
  if (l === 'uk') {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 0;
    if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return 1;
    return 2;
  }
  return n === 1 ? 0 : 1;
}

function t(key, params = {}) {
  let v = I18N[lang()][key];
  if (v === undefined) v = I18N.uk[key];
  if (v === undefined) return key;
  if (Array.isArray(v)) v = v[Math.min(pluralIndex(lang(), params.n !== undefined ? params.n : params.m), v.length - 1)];
  return v.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
}

/* ───────────── одиниці й формати ───────────── */

const toDispT = c => (imperial() ? c * 9 / 5 + 32 : c);
const fromDispT = v => (imperial() ? (v - 32) * 5 / 9 : v);
const toDispDelta = d => (imperial() ? d * 9 / 5 : d);
const toDispW = ms => (imperial() ? ms * 2.2369363 : ms);
const fromDispW = v => (imperial() ? v / 2.2369363 : v);
const tempUnit = () => t(imperial() ? 'unit.f' : 'unit.c');
const windUnit = () => t(imperial() ? 'unit.mph' : 'unit.ms');

function fmtNum(x, digits = 1) {
  let v = round(x, digits);
  if (Object.is(v, -0)) v = 0;
  return new Intl.NumberFormat(lang(), { maximumFractionDigits: digits }).format(v);
}
const fmtTemp = c => `${fmtNum(toDispT(c))} ${tempUnit()}`;
const fmtWind = ms => `${fmtNum(toDispW(ms))} ${windUnit()}`;
const signed = x => (x > 0 ? '+' : '') + fmtNum(x);
const dirName = i => t('dir.' + i);
const dirFromDeg = deg => Math.round((((deg % 360) + 360) % 360) / 45) % 8;

function fmtCoord(lat, lon) {
  return `${fmtNum(Math.abs(lat), 2)}° ${t(lat >= 0 ? 'coord.N' : 'coord.S')}, ${fmtNum(Math.abs(lon), 2)}° ${t(lon >= 0 ? 'coord.E' : 'coord.W')}`;
}

/* ───────────── кольори температури ───────────── */

function tempRGB(c) {
  const first = TEMP_STOPS[0], last = TEMP_STOPS[TEMP_STOPS.length - 1];
  if (c <= first[0]) return first[1].slice();
  if (c >= last[0]) return last[1].slice();
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const [c1, rgb1] = TEMP_STOPS[i];
    if (c <= c1) {
      const [c0, rgb0] = TEMP_STOPS[i - 1];
      const f = (c - c0) / (c1 - c0);
      return rgb0.map((v, j) => Math.round(v + (rgb1[j] - v) * f));
    }
  }
  return last[1].slice();
}
const rgbCss = rgb => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
function luminance(rgb) {
  const lin = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function readableOn(rgb) {
  return contrastRatio(rgb, CELL_DARK_RGB) >= contrastRatio(rgb, WHITE_RGB) ? CELL_DARK_RGB : WHITE_RGB;
}

/* ───────────── дати ───────────── */

const keyOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
function todayParts() { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth(), d: n.getDate() }; }
const todayKey = () => { const n = todayParts(); return keyOf(n.y, n.m, n.d); };
function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return { y, m: m - 1, d }; }
function validDate(k) {
  if (!DATE_RE.test(k)) return false;
  const { y, m, d } = parseKey(k);
  return y >= 1990 && y <= 2100 && m >= 0 && m <= 11 && d >= 1 && d <= daysIn(y, m);
}
function addDays(k, n) { const { y, m, d } = parseKey(k); const x = new Date(y, m, d + n); return keyOf(x.getFullYear(), x.getMonth(), x.getDate()); }
function longDate(k) {
  // Власні шаблони замість Intl: у Chromium українська «неділя» в повній даті виходить як «неділю».
  const { y, m, d } = parseKey(k), L = L10N[lang()];
  return L.dateLong
    .replace('{wd}', L.weekdaysLong[new Date(y, m, d).getDay()])
    .replace('{d}', d).replace('{mg}', L.monthsGen[m]).replace('{mn}', L.months[m]).replace('{y}', y);
}
function shortDate(k) {
  const { y, m, d } = parseKey(k);
  return new Intl.DateTimeFormat(lang(), { day: 'numeric', month: 'short' }).format(new Date(y, m, d));
}
const monthTitle = (y, m) => `${L10N[lang()].months[m]} ${y}`;
function nowHHMM() { const n = new Date(); return `${pad(n.getHours())}:${pad(n.getMinutes())}`; }

/* ───────────── дані: перевірка й міграція ───────────── */

function sanitizeCity(c) {
  if (!c || typeof c !== 'object') return null;
  const name = cleanStr(c.name, 60);
  if (!name) return null;
  let lat = num(c.lat, -90, 90), lon = num(c.lon, -180, 180);
  if (lat === null || lon === null) { lat = null; lon = null; } else { lat = round(lat, 2); lon = round(lon, 2); }
  return {
    name, admin: cleanStr(c.admin, 60), country: cleanStr(c.country, 60), lat, lon,
    tz: typeof c.tz === 'string' && TZ_RE.test(c.tz) ? c.tz : null
  };
}

function sanitizeReal(r) {
  if (!r || typeof r !== 'object') return null;
  const temp = num(r.temp, -90, 60);
  if (temp === null) return null;
  return {
    temp: round(temp, 1),
    hum: num(r.hum, 0, 100),
    wind: num(r.wind, 0, 100),
    dir: Number.isInteger(r.dir) && r.dir >= 0 && r.dir <= 7 ? r.dir : null,
    sky: SKY_KEYS.includes(r.sky) ? r.sky : null,
    at: cleanStr(r.at, 30)
  };
}

function sanitizeRecord(v) {
  if (!v || typeof v !== 'object') return null;
  const temp = num(v.temp, -90, 60);
  const sky = SKY_KEYS.includes(v.sky) ? v.sky : null;
  if (temp === null || !sky) return null;
  const r = {
    temp: round(temp, 2),
    sky,
    t: typeof v.t === 'string' && TIME_RE.test(v.t) ? v.t : null,
    hum: num(v.hum, 0, 100),
    wind: num(v.wind, 0, 100) === null ? null : round(num(v.wind, 0, 100), 2),
    dir: Number.isInteger(v.dir) && v.dir >= 0 && v.dir <= 7 ? v.dir : null,
    mood: MOOD_KEYS.includes(v.mood) ? v.mood : null,
    notes: cleanText(v.notes, 500)
  };
  const real = sanitizeReal(v.real);
  if (real) r.real = real;
  return r;
}

function sanitizeProfile(p, keepId) {
  if (!p || typeof p !== 'object') return null;
  const records = {};
  let count = 0;
  if (p.records && typeof p.records === 'object') {
    for (const [k, v] of Object.entries(p.records)) {
      if (count >= MAX_RECORDS) break;
      if (!validDate(k)) continue;
      const r = sanitizeRecord(v);
      if (r) { records[k] = r; count++; }
    }
  }
  return {
    id: keepId && typeof p.id === 'string' && /^[\w-]{1,40}$/.test(p.id) ? p.id : uid(),
    name: cleanStr(p.name, 40),
    cls: cleanStr(p.cls, 10),
    avatar: AVATARS.includes(p.avatar) ? p.avatar : AVATARS[0],
    city: sanitizeCity(p.city) || Object.assign({}, DEFAULT_CITY),
    records
  };
}

function sanitizeA11y(a) {
  a = a && typeof a === 'object' ? a : {};
  return { hc: a.hc === true, large: a.large === true, readable: a.readable === true, simple: a.simple === true };
}

function defaultStore() {
  const prof = sanitizeProfile({ name: '', cls: '', avatar: AVATARS[0], city: DEFAULT_CITY, records: {} });
  return { v: 2, lang: 'uk', units: 'metric', a11y: sanitizeA11y(), active: prof.id, profiles: [prof] };
}

function sanitizeStore(x) {
  if (!x || typeof x !== 'object' || x.v !== 2 || !Array.isArray(x.profiles)) return null;
  const profiles = x.profiles.map(p => sanitizeProfile(p, true)).filter(Boolean);
  if (!profiles.length) return null;
  return {
    v: 2,
    lang: I18N[x.lang] ? x.lang : 'uk',
    units: x.units === 'imperial' ? 'imperial' : 'metric',
    a11y: sanitizeA11y(x.a11y),
    active: profiles.some(p => p.id === x.active) ? x.active : profiles[0].id,
    profiles
  };
}

// Формат першої версії застосунку (ключі wl_*): емодзі замість кодів, дати без нулів.
const V1_SKY = { '☀️': 'clear', '🌤️': 'partly', '☁️': 'cloudy', '🌧️': 'rain', '⛈️': 'storm', '❄️': 'snow', '🌫️': 'fog' };
const V1_MOOD = { '😀': 'joy', '😐': 'ok', '😢': 'sad', '🤩': 'wow', '😴': 'sleepy' };
const V1_DIR = { 'Пн': 0, 'Сх': 2, 'Пд': 4, 'Зх': 6 };

function convertV1({ records, meta }) {
  meta = meta && typeof meta === 'object' ? meta : {};
  const out = {};
  if (records && typeof records === 'object') {
    for (const [k, r] of Object.entries(records)) {
      const mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(k);
      if (!mt || !r || typeof r !== 'object') continue;
      const key = `${mt[1]}-${pad(Number(mt[2]))}-${pad(Number(mt[3]))}`;
      out[key] = {
        temp: r.temp, sky: V1_SKY[r.sky], t: null, hum: r.hum, wind: r.wind,
        dir: V1_DIR[r.dir] === undefined ? null : V1_DIR[r.dir], mood: V1_MOOD[r.mood] || null, notes: r.notes
      };
    }
  }
  const cityName = cleanStr(meta.city, 60);
  const city = !cityName || cityName === 'Київ' ? DEFAULT_CITY : { name: cityName, lat: null, lon: null };
  return sanitizeProfile({ name: meta.name, cls: meta.class, avatar: meta.avatar, city, records: out }, false);
}

function migrateV1() {
  try {
    const rawR = localStorage.getItem('wl_records');
    const rawM = localStorage.getItem('wl_meta');
    if (!rawR && !rawM) return null;
    const prof = convertV1({ records: rawR ? JSON.parse(rawR) : {}, meta: rawM ? JSON.parse(rawM) : {} });
    if (!prof) return null;
    const s = defaultStore();
    s.profiles = [prof];
    s.active = prof.id;
    const l = localStorage.getItem('wl_lang');
    if (l && I18N[l]) s.lang = l;
    try {
      const a = JSON.parse(localStorage.getItem('wl_a11y') || 'null');
      if (a) s.a11y = sanitizeA11y({ hc: a.highContrast, large: a.largeText, readable: a.dyslexicFont, simple: a.simplified });
    } catch (e) { /* стара доступність — не критично */ }
    return s;
  } catch (e) {
    return null;
  }
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = sanitizeStore(JSON.parse(raw));
      if (s) return s;
    }
  } catch (e) { /* пошкоджені дані — починаємо з чистого */ }
  return migrateV1() || defaultStore();
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.store));
    state.storageOk = true;
  } catch (e) {
    state.storageOk = false;
  }
  $('#banner').hidden = state.storageOk;
}

/* ───────────── обчислення за місяць ───────────── */

function monthRecords(p, y, m) {
  const prefix = `${y}-${pad(m + 1)}-`;
  return Object.keys(p.records)
    .filter(k => k.startsWith(prefix))
    .sort()
    .map(k => Object.assign({ key: k, day: Number(k.slice(8)) }, p.records[k]));
}

function computeStats(list) {
  const temps = list.map(r => r.temp);
  const sum = temps.reduce((a, b) => a + b, 0);
  let max = list[0], min = list[0];
  for (const r of list) { if (r.temp > max.temp) max = r; if (r.temp < min.temp) min = r; }
  const wind = new Array(8).fill(0);
  for (const r of list) if (r.dir !== null) wind[r.dir]++;
  const windMax = Math.max(...wind);
  const cmp = list.filter(r => r.real && r.real.temp !== null);
  return {
    n: list.length,
    mean: sum / list.length,
    max: { v: max.temp, key: max.key },
    min: { v: min.temp, key: min.key },
    amp: max.temp - min.temp,
    wet: list.filter(r => WET_SKY.has(r.sky)).length,
    wind,
    windTop: windMax > 0 ? wind.indexOf(windMax) : null,
    mae: cmp.length ? cmp.reduce((a, r) => a + Math.abs(r.temp - r.real.temp), 0) / cmp.length : null,
    cmpN: cmp.length
  };
}

/* ───────────── діалоги, тости, підтвердження ───────────── */

function openDialog(d) {
  if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
}
function closeDialog(d) {
  if (typeof d.close === 'function') d.close();
  else { d.removeAttribute('open'); d.dispatchEvent(new Event('close')); }
}

function toast(msg) {
  const box = $('#toast');
  box.textContent = msg;
  box.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => box.classList.remove('show'), 5000);
}

function askConfirm(title, text, okLabel) {
  return new Promise(resolve => {
    const d = $('#dlg-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okLabel || t('ui.ok');
    let done = false;
    const okBtn = $('#confirm-ok'), cancelBtn = $('#confirm-cancel');
    const finish = v => {
      if (done) return;
      done = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      d.removeEventListener('close', onCancel);
      if (d.hasAttribute('open')) closeDialog(d);
      resolve(v);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    d.addEventListener('close', onCancel);
    openDialog(d);
    cancelBtn.focus();
  });
}

/* ───────────── застосування мови й режимів ───────────── */

function applyStatic() {
  const l = lang();
  document.documentElement.lang = l;
  document.title = t('app.title');
  for (const n of $$('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of $$('[data-i18n-attr]')) {
    for (const pair of n.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':');
      if (attr && key) n.setAttribute(attr.trim(), t(key.trim()));
    }
  }
  for (const b of $$('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === l));
  $('#foot-text').textContent = t('foot.text', { v: APP_VERSION });
}

function applyA11y() {
  const a = state.store.a11y, root = document.documentElement;
  root.classList.toggle('hc', a.hc);
  root.classList.toggle('lg', a.large);
  root.classList.toggle('rf', a.readable);
  root.classList.toggle('simple', a.simple);
}

function buildChips() {
  const chipGroup = (box, name, items, labelKey, required) => {
    box.replaceChildren(...items.map(it => el('label', { class: 'chip' },
      el('input', { type: 'radio', name, value: it.k, required: required }),
      el('span', { class: 'chip-face' },
        el('span', { class: 'emo', 'aria-hidden': 'true', text: it.e }),
        el('span', { class: 'lbl', text: t(labelKey + it.k) })))));
  };
  chipGroup($('#sky-chips'), 'sky', SKY, 'sky.', true);
  chipGroup($('#mood-chips'), 'mood', MOOD, 'mood.', false);

  const dir = $('#f-dir');
  dir.replaceChildren(el('option', { value: '', text: t('day.dirNone') }),
    ...Array.from({ length: 8 }, (_, i) => el('option', { value: String(i), text: dirName(i) })));

  $('#avatar-chips').replaceChildren(...AVATARS.map(a => el('label', { class: 'chip' },
    el('input', { type: 'radio', name: 'avatar', value: a, 'aria-label': a }),
    el('span', { class: 'chip-face' }, el('span', { class: 'emo', 'aria-hidden': 'true', text: a })))));
}

/* ───────────── відмальовування ───────────── */

function renderHeader() {
  const p = P();
  const name = p.name || t('profile.default');
  $('#profile-avatar').textContent = p.avatar;
  $('#profile-name').textContent = name;
  $('#btn-profile').setAttribute('aria-label', t('profile.btnLabel', { name }));
}

function renderPlace() {
  const c = P().city;
  $('#place-name').textContent = c.name;
  $('#place-sub').textContent = [c.admin, c.country].filter(Boolean).join(', ');
  $('#place-coords').textContent = c.lat === null ? t('place.noCoords') : fmtCoord(c.lat, c.lon);
}

function renderLegend() {
  $('#legend-caption').textContent = t('legend.caption', { unit: tempUnit() });
  const bar = $('#legend-bar');
  const lo = TEMP_STOPS[0][0], hi = TEMP_STOPS[TEMP_STOPS.length - 1][0];
  const stops = TEMP_STOPS.map(([c, rgb]) => `${rgbCss(rgb)} ${round((c - lo) / (hi - lo) * 100, 1)}%`);
  bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
  const ticks = $('#legend-ticks');
  ticks.replaceChildren();
  for (const c of [-20, -10, 0, 10, 20, 30]) {
    const s = el('span', { text: fmtNum(toDispT(c), 0) });
    s.style.left = `${(c - lo) / (hi - lo) * 100}%`;
    ticks.append(s);
  }
}

function renderMonth() {
  const p = P(), { y, m } = state.view, L = L10N[lang()];
  const dim = daysIn(y, m), today = todayParts(), tk = keyOf(today.y, today.m, today.d);
  const title = monthTitle(y, m);
  $('#month-title').textContent = title;
  $('#cal-caption').textContent = t('cal.caption', { month: title.toLowerCase() });

  const headRow = $('#cal-head-row');
  headRow.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const idx = (L.weekStart + i) % 7;
    headRow.append(el('th', { scope: 'col' }, el('abbr', { title: L.weekdaysLong[idx], text: L.weekdaysShort[idx] })));
  }

  const offset = (new Date(y, m, 1).getDay() - L.weekStart + 7) % 7;
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(el('td', { 'aria-hidden': 'true' }));
  for (let d = 1; d <= dim; d++) {
    const key = keyOf(y, m, d), rec = p.records[key], future = key > tk;
    const btn = el('button', {
      type: 'button', class: 'day', dataset: { date: key }, disabled: future,
      'aria-current': key === tk ? 'date' : null,
      'aria-label': future ? t('cal.cellFuture', { date: longDate(key) })
        : rec ? t('cal.cellFilled', { date: longDate(key), temp: fmtTemp(rec.temp), sky: t('sky.' + rec.sky) })
          : t('cal.cellEmpty', { date: longDate(key) })
    }, el('span', { class: 'd', 'aria-hidden': 'true', text: d }));
    if (key === tk) btn.classList.add('today');
    if (rec) {
      const rgb = tempRGB(rec.temp);
      btn.classList.add('has');
      btn.style.setProperty('--bg', rgbCss(rgb));
      btn.style.setProperty('--fg', rgbCss(readableOn(rgb)));
      btn.append(el('span', { class: 's', 'aria-hidden': 'true', text: SKY.find(s => s.k === rec.sky).e }),
        el('span', { class: 'v', 'aria-hidden': 'true', text: `${fmtNum(toDispT(rec.temp))}°` }));
    }
    cells.push(el('td', null, btn));
  }
  while (cells.length % 7) cells.push(el('td', { 'aria-hidden': 'true' }));
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(el('tr', null, cells.slice(i, i + 7)));
  $('#cal-body').replaceChildren(...rows);

  const isCurrent = y > today.y || (y === today.y && m >= today.m);
  $('#btn-next').disabled = isCurrent;
  const n = monthRecords(p, y, m).length;
  $('#cal-hint').textContent = n ? t('cal.hintSome', { n }) : t('cal.hintEmpty');
}

function niceStep(range) {
  const raw = range / 4;
  for (const s of [1, 2, 5, 10, 20, 50]) if (s >= raw) return s;
  return 100;
}

function renderChart() {
  const p = P(), { y, m } = state.view;
  const list = monthRecords(p, y, m), dim = daysIn(y, m);
  const box = $('#chart');
  box.replaceChildren();
  $('#chart-empty').hidden = list.length > 0;
  $('#chart-legend').replaceChildren();
  $('#chart-table').replaceChildren();
  $('#chart-data').hidden = list.length === 0;
  if (!list.length) return;

  const vals = [];
  for (const r of list) { vals.push(toDispT(r.temp)); if (r.real) vals.push(toDispT(r.real.temp)); }
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const step = niceStep(hi - lo || 10);
  lo = Math.floor((lo - 1) / step) * step;
  hi = Math.ceil((hi + 1) / step) * step;

  // Ширина полотна = ширина контейнера, щоб на телефоні підписи осей не зменшувались разом із SVG.
  const avail = Math.round(box.clientWidth);
  state.chartW = avail;
  const W = avail > 0 ? Math.max(300, Math.min(640, avail)) : 640;
  const H = Math.round(Math.max(200, Math.min(270, W * 0.45)));
  const ML = 42, MR = 12, MT = 14, MB = 32;
  const X = d => ML + (dim > 1 ? (d - 1) / (dim - 1) : 0.5) * (W - ML - MR);
  const Y = v => MT + (hi - v) / (hi - lo) * (H - MT - MB);

  const min = fmtTemp(Math.min(...list.map(r => r.temp))), max = fmtTemp(Math.max(...list.map(r => r.temp)));
  const s = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`, role: 'img', class: 'chart-svg',
    'aria-label': t('chart.alt', { month: monthTitle(y, m).toLowerCase(), n: list.length, min, max })
  });

  const grid = svgEl('g', { class: 'ch-grid' });
  for (let v = lo; v <= hi + 1e-9; v += step) {
    grid.append(svgEl('line', { x1: ML, x2: W - MR, y1: Y(v), y2: Y(v) }),
      svgEl('text', { x: ML - 8, y: Y(v), class: 'ch-y', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, fmtNum(v, 0)));
  }
  s.append(grid);

  const fz = imperial() ? 32 : 0;
  if (fz > lo && fz < hi) {
    s.append(svgEl('line', { x1: ML, x2: W - MR, y1: Y(fz), y2: Y(fz), class: 'ch-freeze' }));
  }

  const xs = svgEl('g', { class: 'ch-x' });
  for (let d = 1; d <= dim; d++) {
    if (d === 1 || d % 5 === 0) xs.append(svgEl('text', { x: X(d), y: H - 12, 'text-anchor': 'middle' }, d));
  }
  s.append(xs);

  const line = pts => pts.map(([d, v]) => `${round(X(d), 1)},${round(Y(v), 1)}`).join(' ');
  const real = list.filter(r => r.real);
  if (real.length > 1) s.append(svgEl('polyline', { points: line(real.map(r => [r.day, toDispT(r.real.temp)])), class: 'ch-real' }));
  for (const r of real) s.append(svgEl('circle', { cx: round(X(r.day), 1), cy: round(Y(toDispT(r.real.temp)), 1), r: 3.5, class: 'ch-real-dot' }));
  if (list.length > 1) s.append(svgEl('polyline', { points: line(list.map(r => [r.day, toDispT(r.temp)])), class: 'ch-mine' }));
  for (const r of list) {
    s.append(svgEl('circle', {
      cx: round(X(r.day), 1), cy: round(Y(toDispT(r.temp)), 1), r: 5.5, class: 'ch-dot', fill: rgbCss(tempRGB(r.temp))
    }, svgEl('title', null, `${shortDate(r.key)}: ${fmtTemp(r.temp)}`)));
  }
  box.append(s);

  const lg = $('#chart-legend');
  lg.append(el('li', null, el('span', { class: 'lg-line', 'aria-hidden': 'true' }), t('chart.mine')));
  if (real.length) lg.append(el('li', null, el('span', { class: 'lg-dash', 'aria-hidden': 'true' }), t('chart.real')));
  if (fz > lo && fz < hi) lg.append(el('li', null, el('span', { class: 'lg-freeze', 'aria-hidden': 'true' }), t('chart.freeze')));

  $('#chart-table').append(buildRecordsTable(list, false));
}

function buildRecordsTable(list, withNotes) {
  const hasReal = list.some(r => r.real);
  const head = [t('th.day'), t('th.time'), t('th.temp'), t('th.sky'), t('th.hum'), t('th.wind')];
  if (hasReal) head.push(t('th.real'));
  if (withNotes) head.push(t('th.notes'));
  const rows = list.map(r => {
    const cells = [
      shortDate(r.key), r.t || '—', fmtTemp(r.temp),
      `${SKY.find(s => s.k === r.sky).e} ${t('sky.' + r.sky)}`,
      r.hum === null ? '—' : `${fmtNum(r.hum, 0)} %`,
      r.wind === null && r.dir === null ? '—' : [r.dir === null ? '' : dirName(r.dir), r.wind === null ? '' : fmtWind(r.wind)].filter(Boolean).join(', ')
    ];
    if (hasReal) cells.push(r.real ? fmtTemp(r.real.temp) : '—');
    if (withNotes) cells.push(r.notes || '');
    return el('tr', null, cells.map(c => el('td', { text: c })));
  });
  return el('table', { class: 'data' },
    el('thead', null, el('tr', null, head.map(h => el('th', { scope: 'col', text: h })))),
    el('tbody', null, rows));
}

function buildStatsList(s) {
  const dl = el('dl', { class: 'stats' });
  const row = (label, value) => dl.append(el('dt', { text: label }), el('dd', { text: value }));
  row(t('stats.records'), String(s.n));
  row(t('stats.max'), `${fmtTemp(s.max.v)}, ${shortDate(s.max.key)}`);
  row(t('stats.min'), `${fmtTemp(s.min.v)}, ${shortDate(s.min.key)}`);
  row(t('stats.amp'), `${fmtNum(toDispDelta(s.amp))} ${tempUnit()}`);
  row(t('stats.wet'), String(s.wet));
  if (s.windTop !== null) row(t('stats.wind'), dirName(s.windTop));
  if (s.mae !== null) row(t('stats.mae'), `${fmtNum(toDispDelta(s.mae))} ${tempUnit()}`);
  return dl;
}

function renderStats() {
  const p = P(), { y, m } = state.view;
  const list = monthRecords(p, y, m), box = $('#stats');
  box.replaceChildren();
  if (!list.length) { box.append(el('p', { class: 'hint', text: t('stats.empty') })); return; }
  const s = computeStats(list), rgb = tempRGB(s.mean);
  const mean = el('div', { class: 'mean' },
    el('span', { class: 'mean-num', text: fmtTemp(s.mean) }),
    el('span', { class: 'mean-lbl', text: t('stats.mean') }));
  mean.style.setProperty('--bg', rgbCss(rgb));
  mean.style.setProperty('--fg', rgbCss(readableOn(rgb)));
  box.append(mean, buildStatsList(s));
}

function renderRose() {
  const p = P(), { y, m } = state.view;
  const list = monthRecords(p, y, m), box = $('#rose');
  box.replaceChildren();
  const counts = new Array(8).fill(0);
  for (const r of list) if (r.dir !== null) counts[r.dir]++;
  const max = Math.max(...counts);
  if (max === 0) { $('#rose-hint').textContent = t('rose.empty'); return; }
  $('#rose-hint').textContent = t('rose.hint');

  const C = 110, R = 72;
  const pt = (i, r) => { const a = i * Math.PI / 4; return [round(C + r * Math.sin(a), 1), round(C - r * Math.cos(a), 1)]; };
  const listText = counts.map((c, i) => (c ? `${dirName(i)}: ${c}` : null)).filter(Boolean).join(', ');
  const s = svgEl('svg', { viewBox: '0 0 220 220', role: 'img', class: 'rose-svg', 'aria-label': t('rose.alt', { list: listText }) });
  for (const f of [0.5, 1]) s.append(svgEl('circle', { cx: C, cy: C, r: R * f, class: 'rose-ring' }));
  for (let i = 0; i < 8; i++) {
    const [x, yy] = pt(i, R), [lx, ly] = pt(i, R + 17);
    s.append(svgEl('line', { x1: C, y1: C, x2: x, y2: yy, class: 'rose-axis' }),
      svgEl('text', { x: lx, y: ly, class: i % 2 ? 'rose-lbl minor' : 'rose-lbl', 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, dirName(i)));
  }
  s.append(svgEl('polygon', { points: counts.map((c, i) => pt(i, R * c / max).join(',')).join(' '), class: 'rose-shape' }));
  box.append(s);
}

const BADGES = [{ n: 1, e: '🌱', k: 'badge.b1' }, { n: 7, e: '⭐', k: 'badge.b7' }, { n: 20, e: '👑', k: 'badge.b20' }];

function renderBadges() {
  const total = Object.keys(P().records).length;
  $('#badges').replaceChildren(...BADGES.map(b => {
    const got = total >= b.n;
    return el('li', { class: got ? 'badge got' : 'badge' },
      el('span', { class: 'b-emo', 'aria-hidden': 'true', text: b.e }),
      el('span', { class: 'b-txt' }, t(b.k), got ? '' : el('small', { text: t('badge.locked') })));
  }));
  const next = BADGES.find(b => total < b.n);
  $('#badges-next').textContent = next ? t('badge.next', { n: next.n - total }) : t('badge.done');
}

function renderAll() {
  renderHeader();
  renderPlace();
  renderLegend();
  renderMonth();
  renderChart();
  renderStats();
  renderRose();
  renderBadges();
  renderSettingsState();
}

/* ───────────── запис за день ───────────── */

function fillDayLabels() {
  $('#lbl-temp').textContent = t('day.temp', { unit: tempUnit() });
  $('#lbl-wind').textContent = t('day.wind', { unit: windUnit() });
  const temp = $('#f-temp'), wind = $('#f-wind');
  temp.min = String(round(toDispT(-60), 1));
  temp.max = String(round(toDispT(60), 1));
  wind.max = String(Math.floor(toDispW(60) * 10) / 10);
}

function setRadio(name, value) {
  for (const r of $$(`input[name="${name}"]`, $('#day-form'))) r.checked = r.value === value;
}

function renderRealTable(rec) {
  const box = $('#real-box');
  if (!rec || !rec.real) { box.hidden = true; return; }
  const re = rec.real, tb = $('#real-table');
  const rows = [];
  const add = (label, mine, model, diff) => rows.push(el('tr', null,
    el('th', { scope: 'row', text: label }), el('td', { text: mine }), el('td', { text: model }), el('td', { text: diff })));
  add(t('real.temp'), fmtTemp(rec.temp), fmtTemp(re.temp), signed(toDispDelta(rec.temp - re.temp)));
  if (re.hum !== null) add(t('real.hum'), rec.hum === null ? '—' : `${fmtNum(rec.hum, 0)} %`, `${fmtNum(re.hum, 0)} %`,
    rec.hum === null ? '—' : signed(rec.hum - re.hum));
  if (re.wind !== null) add(t('real.wind'), rec.wind === null ? '—' : fmtWind(rec.wind), fmtWind(re.wind),
    rec.wind === null ? '—' : signed(toDispW(rec.wind) - toDispW(re.wind)));
  if (re.dir !== null) add(t('real.dir'), rec.dir === null ? '—' : dirName(rec.dir), dirName(re.dir), '');
  if (re.sky) add(t('real.sky'), t('sky.' + rec.sky), t('sky.' + re.sky), '');
  tb.replaceChildren(
    el('thead', null, el('tr', null, el('th', { scope: 'col', text: t('real.param') }), el('th', { scope: 'col', text: t('real.mine') }),
      el('th', { scope: 'col', text: t('real.model') }), el('th', { scope: 'col', text: t('real.diff') }))),
    el('tbody', null, rows));
  box.hidden = false;
}

function openDay(key) {
  const rec = P().records[key] || null;
  state.activeKey = key;
  $('#day-title').textContent = longDate(key);
  fillDayLabels();
  $('#f-temp').value = rec ? String(round(toDispT(rec.temp), 1)) : '';
  $('#f-time').value = rec ? (rec.t || '') : (key === todayKey() ? nowHHMM() : '09:00');
  $('#f-hum').value = rec && rec.hum !== null ? String(rec.hum) : '';
  $('#f-wind').value = rec && rec.wind !== null ? String(round(toDispW(rec.wind), 1)) : '';
  $('#f-dir').value = rec && rec.dir !== null ? String(rec.dir) : '';
  $('#f-notes').value = rec ? rec.notes : '';
  setRadio('sky', rec ? rec.sky : '');
  setRadio('mood', rec && rec.mood ? rec.mood : '');
  $('#btn-day-delete').hidden = !rec;
  renderRealTable(rec);
  openDialog($('#dlg-day'));
}

function readDayForm() {
  const p = P(), key = state.activeKey, prev = p.records[key] || null;
  const tempDisp = parseFloat($('#f-temp').value);
  if (!Number.isFinite(tempDisp)) return null;
  const skyEl = $('input[name="sky"]:checked', $('#day-form'));
  if (!skyEl) return null;
  const moodEl = $('input[name="mood"]:checked', $('#day-form'));
  const humRaw = $('#f-hum').value.trim(), windRaw = $('#f-wind').value.trim(), dirRaw = $('#f-dir').value;
  const time = $('#f-time').value;
  // Поле показує округлене значення. Якщо його не змінили — лишаємо точне збережене,
  // інакше перехід °C ↔ °F і назад поступово зсував би дані.
  const tempSame = prev && round(toDispT(prev.temp), 1) === tempDisp;
  const windSame = prev && prev.wind !== null && windRaw !== '' && round(toDispW(prev.wind), 1) === Number(windRaw);
  const rec = sanitizeRecord({
    temp: tempSame ? prev.temp : fromDispT(tempDisp),
    sky: skyEl.value,
    t: TIME_RE.test(time) ? time : null,
    hum: humRaw === '' ? null : Number(humRaw),
    wind: windRaw === '' ? null : (windSame ? prev.wind : fromDispW(Number(windRaw))),
    dir: dirRaw === '' ? null : Number(dirRaw),
    mood: moodEl ? moodEl.value : null,
    notes: $('#f-notes').value
  });
  if (!rec) return null;
  if (prev && prev.real && prev.t === rec.t) rec.real = prev.real; // час змінився — порівняння застаріло
  return rec;
}

function saveDay(e) {
  e.preventDefault();
  const form = $('#day-form');
  if (typeof form.reportValidity === 'function' && !form.reportValidity()) return;
  const rec = readDayForm();
  if (!rec) return;
  P().records[state.activeKey] = rec;
  saveStore();
  closeDialog($('#dlg-day'));
  renderAll();
  toast(t('toast.saved'));
}

async function deleteDay() {
  const key = state.activeKey;
  const ok = await askConfirm(t('day.deleteTitle'), t('day.deleteText', { date: longDate(key) }), t('ui.ok'));
  if (!ok) return;
  delete P().records[key];
  saveStore();
  closeDialog($('#dlg-day'));
  renderAll();
  toast(t('toast.deleted'));
}

function focusDay(key) {
  const b = key && $(`.day[data-date="${key}"]`);
  if (b && !b.disabled) b.focus();
}

/* ───────────── Open-Meteo ───────────── */

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function skyFromCode(c) {
  if (c === 0) return 'clear';
  if (c === 1 || c === 2) return 'partly';
  if (c === 3) return 'cloudy';
  if (c === 45 || c === 48) return 'fog';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 95 && c <= 99) return 'storm';
  return null;
}

async function fetchHourly(city, keys) {
  const cutoff = addDays(todayKey(), -RECENT_DAYS);
  const groups = [
    [API.archive, keys.filter(k => k < cutoff)],
    [API.forecast, keys.filter(k => k >= cutoff)]
  ];
  const hourly = {};
  for (const [base, ks] of groups) {
    if (!ks.length) continue;
    const params = new URLSearchParams({
      latitude: String(city.lat), longitude: String(city.lon),
      hourly: 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m',
      wind_speed_unit: 'ms', timezone: 'auto', start_date: ks[0], end_date: ks[ks.length - 1]
    });
    const data = await getJson(`${base}?${params}`);
    const h = data && data.hourly;
    if (!h || !Array.isArray(h.time)) throw new Error('bad response');
    h.time.forEach((tm, i) => {
      hourly[tm] = {
        temp: h.temperature_2m ? h.temperature_2m[i] : null,
        hum: h.relative_humidity_2m ? h.relative_humidity_2m[i] : null,
        wind: h.wind_speed_10m ? h.wind_speed_10m[i] : null,
        deg: h.wind_direction_10m ? h.wind_direction_10m[i] : null,
        code: h.weather_code ? h.weather_code[i] : null
      };
    });
  }
  return hourly;
}

function hourSlot(key, time) {
  let [h, mi] = (time || '09:00').split(':').map(Number);
  if (mi >= 30) h += 1;
  if (h > 23) h = 23;
  return `${key}T${pad(h)}:00`;
}

function pickReal(hourly, rec) {
  const v = hourly[hourSlot(rec.key, rec.t)];
  if (!v || typeof v.temp !== 'number') return null;
  const wind = typeof v.wind === 'number' ? round(v.wind, 1) : null;
  return sanitizeReal({
    temp: v.temp,
    hum: typeof v.hum === 'number' ? Math.round(v.hum) : null,
    wind,
    dir: typeof v.deg === 'number' && wind !== null && wind >= 0.3 ? dirFromDeg(v.deg) : null,
    sky: typeof v.code === 'number' ? skyFromCode(v.code) : null,
    at: new Date().toISOString()
  });
}

function setBusy(on) {
  state.busy = on;
  const b = $('#btn-compare');
  b.disabled = on;
  b.setAttribute('aria-busy', String(on));
}

async function compareMonth() {
  if (state.busy) return;
  const p = P(), { y, m } = state.view, tk = todayKey();
  if (p.city.lat === null) { toast(t('cmp.noCoords')); openPlace(); return; }
  const list = monthRecords(p, y, m).filter(r => r.key <= tk);
  if (!list.length) { toast(t('cmp.none')); return; }
  setBusy(true);
  toast(t('cmp.running'));
  try {
    const hourly = await fetchHourly(p.city, list.map(r => r.key));
    let ok = 0;
    for (const r of list) {
      const real = pickReal(hourly, r);
      if (real) { p.records[r.key].real = real; ok++; }
    }
    saveStore();
    renderAll();
    const missing = list.length - ok;
    toast(ok ? t('cmp.done', { n: ok }) + (missing ? ' ' + t('cmp.missing', { m: missing }) : '') : t('cmp.err'));
  } catch (e) {
    toast(t('cmp.err'));
  } finally {
    setBusy(false);
  }
}

/* ───────────── місце ───────────── */

function openPlace() {
  $('#place-q').value = '';
  $('#place-status').textContent = '';
  $('#place-results').replaceChildren();
  openDialog($('#dlg-place'));
}

function setCity(raw) {
  const city = sanitizeCity(raw);
  if (!city) return;
  P().city = city;
  saveStore();
  closeDialog($('#dlg-place'));
  renderAll();
  toast(t('place.set', { name: city.name }));
}

async function searchPlaces(e) {
  e.preventDefault();
  const q = $('#place-q').value.trim(), status = $('#place-status'), list = $('#place-results');
  list.replaceChildren();
  if (q.length < 2) { status.textContent = t('place.short'); return; }
  status.textContent = t('place.searching');
  try {
    const params = new URLSearchParams({ name: q, count: '8', language: lang(), format: 'json' });
    const data = await getJson(`${API.geocode}?${params}`);
    const found = (data && Array.isArray(data.results) ? data.results : [])
      .map(r => ({ name: r.name, admin: r.admin1, country: r.country, lat: r.latitude, lon: r.longitude, tz: r.timezone }))
      .map(sanitizeCity).filter(c => c && c.lat !== null);
    if (!found.length) { status.textContent = t('place.none'); return; }
    status.textContent = t('place.choose');
    list.replaceChildren(...found.map(c => el('li', null,
      el('button', { type: 'button', class: 'result', onclick: () => setCity(c) },
        el('strong', { text: c.name }),
        el('span', { text: [c.admin, c.country].filter(Boolean).join(', ') }),
        el('small', { text: fmtCoord(c.lat, c.lon) })))));
  } catch (err) {
    status.textContent = t('place.err');
  }
}

function useGeolocation() {
  const status = $('#place-status');
  if (!navigator.geolocation) { status.textContent = t('place.geoErr'); return; }
  status.textContent = t('place.geoWait');
  navigator.geolocation.getCurrentPosition(
    pos => setCity({ name: t('place.myLoc'), admin: '', country: '', lat: pos.coords.latitude, lon: pos.coords.longitude, tz: null }),
    () => { status.textContent = t('place.geoErr'); },
    { timeout: 12000, maximumAge: 600000 });
}

/* ───────────── профілі ───────────── */

const profileLabel = p => p.name || t('profile.default');

function renderProfileList() {
  const ul = $('#profile-list');
  ul.replaceChildren(...state.store.profiles.map(p => {
    const active = p.id === state.store.active;
    const meta = [p.cls ? t('profile.classLbl', { cls: p.cls }) : '', t('profile.records', { n: Object.keys(p.records).length })].filter(Boolean).join(', ');
    return el('li', { class: active ? 'prow on' : 'prow' },
      el('span', { class: 'av', 'aria-hidden': 'true', text: p.avatar }),
      el('span', { class: 'pname' }, el('strong', { text: profileLabel(p) }), el('small', { text: meta })),
      el('button', {
        type: 'button', class: 'btn btn-small', disabled: active, text: active ? t('profile.active') : t('profile.switch'),
        onclick: () => { state.store.active = p.id; saveStore(); closeDialog($('#dlg-profile')); renderAll(); }
      }),
      el('button', { type: 'button', class: 'btn btn-small', text: t('profile.edit'), onclick: () => showProfileForm(p.id) }));
  }));
}

function showProfileForm(id) {
  const p = id ? state.store.profiles.find(x => x.id === id) : null;
  state.editingProfile = p ? p.id : null;
  $('#profile-form-title').textContent = t(p ? 'profile.editTitle' : 'profile.newTitle');
  $('#p-name').value = p ? p.name : '';
  $('#p-class').value = p ? p.cls : '';
  for (const r of $$('input[name="avatar"]', $('#profile-form'))) r.checked = r.value === (p ? p.avatar : AVATARS[0]);
  $('#btn-profile-delete').hidden = !p;
  $('#profile-form').hidden = false;
  $('#p-name').focus();
}

function saveProfile(e) {
  e.preventDefault();
  const av = $('input[name="avatar"]:checked', $('#profile-form'));
  const fields = { name: $('#p-name').value, cls: $('#p-class').value, avatar: av ? av.value : AVATARS[0] };
  if (state.editingProfile) {
    const p = state.store.profiles.find(x => x.id === state.editingProfile);
    Object.assign(p, sanitizeProfile(Object.assign({}, p, fields), true));
  } else {
    const np = sanitizeProfile(Object.assign({ city: P().city, records: {} }, fields), false);
    state.store.profiles.push(np);
    state.store.active = np.id;
  }
  saveStore();
  $('#profile-form').hidden = true;
  renderProfileList();
  renderAll();
}

async function deleteProfile() {
  const p = state.store.profiles.find(x => x.id === state.editingProfile);
  if (!p) return;
  const ok = await askConfirm(t('profile.deleteTitle'), t('profile.deleteText', { name: profileLabel(p) }), t('ui.ok'));
  if (!ok) return;
  state.store.profiles = state.store.profiles.filter(x => x.id !== p.id);
  if (!state.store.profiles.length) state.store.profiles.push(defaultStore().profiles[0]);
  if (!state.store.profiles.some(x => x.id === state.store.active)) state.store.active = state.store.profiles[0].id;
  saveStore();
  $('#profile-form').hidden = true;
  renderProfileList();
  renderAll();
}

/* ───────────── налаштування ───────────── */

function renderSettingsState() {
  for (const r of $$('input[name="units"]')) r.checked = r.value === state.store.units;
  const a = state.store.a11y;
  $('#set-hc').checked = a.hc;
  $('#set-large').checked = a.large;
  $('#set-readable').checked = a.readable;
  $('#set-simple').checked = a.simple;
}

async function wipeAll() {
  const ok = await askConfirm(t('set.wipeTitle'), t('set.wipeText'), t('ui.ok'));
  if (!ok) return;
  try {
    for (const k of [STORE_KEY, 'wl_records', 'wl_meta', 'wl_lang', 'wl_a11y']) localStorage.removeItem(k);
  } catch (e) { /* немає доступу — нічого видаляти */ }
  const keep = state.store.lang;
  state.store = defaultStore();
  state.store.lang = keep;
  saveStore();
  closeDialog($('#dlg-settings'));
  applyA11y();
  applyStatic();
  buildChips();
  renderAll();
  toast(t('toast.wiped'));
}

/* ───────────── файли: збереження, відкриття, друк ───────────── */

const slug = s => s.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '');

function exportProfile() {
  const p = P();
  const payload = {
    app: 'WeatherLab', schema: 2, version: APP_VERSION, exported: new Date().toISOString(),
    profile: { name: p.name, cls: p.cls, avatar: p.avatar, city: p.city, records: p.records }
  };
  const name = `WeatherLab_${slug(p.name) || 'journal'}_${todayKey()}.weather`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(t('io.exported', { name }));
}

function readFile(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(f);
  });
}

function profileFromFile(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.app === 'WeatherLab' && data.profile) return sanitizeProfile(data.profile, false);
  if (data.records && data.meta) return convertV1(data);
  return null;
}

async function importFiles(files) {
  const messages = [];
  for (const f of files) {
    try {
      if (f.size > MAX_FILE_BYTES) { messages.push(t('io.fail', { file: f.name, reason: t('io.tooBig') })); continue; }
      let data;
      try { data = JSON.parse(await readFile(f)); } catch (e) { messages.push(t('io.fail', { file: f.name, reason: t('io.notWl') })); continue; }
      const prof = profileFromFile(data);
      if (!prof) { messages.push(t('io.fail', { file: f.name, reason: t('io.notWl') })); continue; }
      const n = Object.keys(prof.records).length;
      if (!n) { messages.push(t('io.fail', { file: f.name, reason: t('io.empty') })); continue; }
      state.store.profiles.push(prof);
      state.store.active = prof.id;
      messages.push(t('io.imported', { name: profileLabel(prof), n }));
    } catch (e) {
      messages.push(t('io.fail', { file: f.name, reason: t('io.readErr') }));
    }
  }
  saveStore();
  renderAll();
  if (messages.length) toast(messages.join(' '));
}

function renderPrint() {
  const box = $('#print-report'), p = P(), { y, m } = state.view;
  box.replaceChildren();
  const list = monthRecords(p, y, m);
  const meta = [`${t('print.student')}: ${profileLabel(p)}`];
  if (p.cls) meta.push(`${t('print.class')}: ${p.cls}`);
  meta.push(`${t('print.place')}: ${p.city.name}${p.city.lat === null ? '' : ` (${fmtCoord(p.city.lat, p.city.lon)})`}`);
  box.append(el('h1', { text: `${t('print.title')}: ${monthTitle(y, m)}` }), el('p', { class: 'pmeta', text: meta.join('. ') }));
  if (!list.length) { box.append(el('p', { text: t('chart.empty') })); return; }
  const chart = $('#chart svg');
  if (chart) box.append(chart.cloneNode(true));
  box.append(buildRecordsTable(list, true), buildStatsList(computeStats(list)),
    el('p', { class: 'pmeta', text: t('print.made', { date: longDate(todayKey()) }) }));
}

/* ───────────── події ───────────── */

function setLang(l) {
  if (!I18N[l]) return;
  state.store.lang = l;
  saveStore();
  applyStatic();
  buildChips();
  renderAll();
}

function changeMonth(delta) {
  let { y, m } = state.view;
  m += delta;
  while (m < 0) { m += 12; y--; }
  while (m > 11) { m -= 12; y++; }
  state.view = { y, m };
  renderAll();
}

function bindEvents() {
  for (const b of $$('[data-close]')) b.addEventListener('click', () => closeDialog(b.closest('dialog')));
  for (const id of ['dlg-place', 'dlg-profile', 'dlg-settings']) {
    const d = $('#' + id);
    d.addEventListener('click', e => { if (e.target === d) closeDialog(d); });
  }
  $('#dlg-day').addEventListener('close', () => { const k = state.activeKey; setTimeout(() => focusDay(k), 0); });

  $('#btn-prev').addEventListener('click', () => changeMonth(-1));
  $('#btn-next').addEventListener('click', () => changeMonth(1));
  $('#btn-today').addEventListener('click', () => { const n = todayParts(); state.view = { y: n.y, m: n.m }; renderAll(); });
  $('#cal-body').addEventListener('click', e => {
    const b = e.target.closest('.day');
    if (b && !b.disabled) openDay(b.dataset.date);
  });

  $('#day-form').addEventListener('submit', saveDay);
  $('#btn-day-delete').addEventListener('click', deleteDay);

  $('#btn-compare').addEventListener('click', compareMonth);
  $('#btn-export').addEventListener('click', exportProfile);
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', e => { const fs = Array.from(e.target.files); e.target.value = ''; importFiles(fs); });
  $('#btn-print').addEventListener('click', () => { renderPrint(); window.print(); });
  window.addEventListener('beforeprint', renderPrint);

  $('#btn-place').addEventListener('click', openPlace);
  $('#place-form').addEventListener('submit', searchPlaces);
  $('#btn-geo').addEventListener('click', useGeolocation);

  $('#btn-profile').addEventListener('click', () => { renderProfileList(); $('#profile-form').hidden = true; openDialog($('#dlg-profile')); });
  $('#btn-profile-new').addEventListener('click', () => showProfileForm(null));
  $('#btn-profile-cancel').addEventListener('click', () => { $('#profile-form').hidden = true; });
  $('#profile-form').addEventListener('submit', saveProfile);
  $('#btn-profile-delete').addEventListener('click', deleteProfile);

  $('#btn-settings').addEventListener('click', () => { renderSettingsState(); openDialog($('#dlg-settings')); });
  for (const r of $$('input[name="units"]')) r.addEventListener('change', () => { state.store.units = r.value; saveStore(); renderAll(); });
  const toggles = { 'set-hc': 'hc', 'set-large': 'large', 'set-readable': 'readable', 'set-simple': 'simple' };
  for (const [id, key] of Object.entries(toggles)) {
    $('#' + id).addEventListener('change', e => { state.store.a11y[key] = e.target.checked; saveStore(); applyA11y(); });
  }
  $('#btn-wipe').addEventListener('click', wipeAll);

  for (const b of $$('[data-lang]')) b.addEventListener('click', () => setLang(b.dataset.lang));

  window.addEventListener('resize', () => {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      const w = Math.round($('#chart').clientWidth);
      if (w > 0 && Math.abs(w - state.chartW) > 24) renderChart();
    }, 150);
  });
}

function init() {
  state.store = loadStore();
  const n = todayParts();
  state.view = { y: n.y, m: n.m };
  bindEvents();
  applyA11y();
  applyStatic();
  buildChips();
  saveStore();
  renderAll();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* офлайн-режим недоступний — застосунок працює й без нього */ });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
