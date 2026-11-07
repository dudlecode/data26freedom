// Помощники интерфейса: построитель DOM, кнопки, поля, подсказки, тосты, небольшой диалог подтверждения,
// всплывающие меню, форматтеры и значения критериев. Данные выводятся только через textContent.

import { icon } from './icons.js';

export { icon };

/* ---------- DOM ---------- */

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv === undefined || sv === null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, String(sv)); else el.style[sk] = sv;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'value' && 'value' in el) el.value = v;
      else if (['checked', 'disabled', 'selected', 'hidden', 'open', 'required', 'multiple', 'readOnly'].includes(k)) el[k] = !!v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of [children].flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Строка с разделителем «·» между непустыми частями. */
export function dotted(parts, cls = 'sep') {
  const out = [];
  for (const p of parts.filter((x) => x !== null && x !== undefined && x !== false && x !== '')) {
    if (out.length) out.push(h('span', { class: cls, 'aria-hidden': 'true' }, '·'), '\u200B');
    out.push(typeof p === 'string' ? h('span', { class: 'nowrap' }, p) : p);
  }
  return out;
}

/* ---------- кнопки ---------- */

export function button(label, { kind = 'secondary', iconName, trailing, onClick, size, type = 'button', disabled, cls, tip, ariaLabel } = {}) {
  return h('button', {
    type,
    class: ['btn', `btn--${kind}`, size && `btn--${size}`, cls],
    onclick: onClick,
    disabled,
    'data-tip': tip,
    'aria-label': ariaLabel,
  }, iconName ? icon(iconName, 16) : null, label ? h('span', null, label) : null, trailing ? icon(trailing, 16) : null);
}

export function iconButton(name, label, onClick, { danger, disabled, tip } = {}) {
  return h('button', {
    type: 'button', class: ['icon-btn', danger && 'icon-btn--danger'], 'aria-label': label, 'data-tip': tip || label, disabled, onclick: onClick,
  }, icon(name, 16));
}

/** Блокирует кнопку на время асинхронного действия; повторные нажатия игнорируются. */
export async function withBusy(btn, fn) {
  if (btn && btn.classList.contains('is-busy')) return undefined;
  const was = btn ? btn.disabled : false;
  if (btn) { btn.disabled = true; btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true'); }
  try { return await fn(); } finally {
    if (btn) { btn.disabled = was; btn.classList.remove('is-busy'); btn.removeAttribute('aria-busy'); }
  }
}

/* ---------- поля ---------- */

export function field(label, control, { hint, cls } = {}) {
  return h('label', { class: ['field', cls] },
    h('span', { class: 'field__label' }, label),
    control,
    hint ? h('span', { class: 'field__hint' }, hint) : null);
}

export function select(options, value, props = {}) {
  const el = h('select', { class: 'input', ...props });
  for (const o of options) {
    const opt = typeof o === 'object' ? o : { value: o, label: o };
    el.append(h('option', { value: opt.value, selected: String(opt.value) === String(value), disabled: opt.disabled }, opt.label));
  }
  return el;
}

/** Сегментированный переключатель. options: [{value,label}] */
export function segmented(options, value, onChange, { label, disabled } = {}) {
  const box = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  let cur = value;
  const render = () => {
    clear(box);
    for (const o of options) {
      box.append(h('button', {
        type: 'button', 'aria-pressed': String(String(o.value) === String(cur)), disabled,
        onclick: () => { if (String(o.value) === String(cur)) return; cur = o.value; render(); onChange(o.value); },
      }, o.label));
    }
  };
  render();
  box.setValue = (v) => { cur = v; render(); };
  return box;
}

/* ---------- prefs ---------- */

export const prefs = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`cqa.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`cqa.${key}`, JSON.stringify(value)); } catch { /* приватный режим */ }
  },
};

/* ---------- тосты ---------- */

export function toast(message, kind = 'info', timeout) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const ms = timeout ?? (kind === 'error' ? 7000 : 3500);
  const el = h('div', { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? 'alert' : 'check', 16),
    h('div', { class: 'toast__msg' }, String(message)),
    h('button', { class: 'toast__close', type: 'button', 'aria-label': 'Закрыть', onclick: () => dismiss() }, icon('close', 14)));
  box.append(el);
  void el.offsetWidth;
  el.classList.add('is-in');
  let timer = setTimeout(dismiss, ms);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 2000); });
  function dismiss() {
    clearTimeout(timer);
    if (el.classList.contains('is-out')) return;
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 180);
  }
}

export function toastError(e, prefix) {
  if (e && e.name === 'AbortError') return;
  const msg = (e && e.message) || String(e);
  toast(prefix ? `${prefix}. ${msg}` : msg, 'error');
}

/* ---------- подтверждение (небольшой нативный диалог) ---------- */

export function confirmDialog({ title, message, confirmLabel = 'Подтвердить', cancelLabel = 'Отмена', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const ok = button(confirmLabel, { kind: danger ? 'danger' : 'primary', onClick: () => { result = true; dlg.close(); } });
    const dlg = h('dialog', { class: 'dlg', 'aria-labelledby': 'dlg-title' },
      h('div', { class: 'dlg__body' },
        h('h2', { class: 'dlg__title', id: 'dlg-title' }, title || ''),
        message ? h('p', { class: 'dlg__text' }, message) : null),
      h('div', { class: 'dlg__foot' },
        button(cancelLabel, { kind: 'secondary', onClick: () => dlg.close() }),
        ok));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    document.body.append(dlg);
    dlg.showModal();
    ok.focus();
  });
}

/* ---------- всплывающее окно у кнопки (меню, короткая форма) ---------- */

let openPop = null;

export function closePopover() {
  if (openPop) { const p = openPop; openPop = null; p.close(); }
}

/** popover(anchor, content, {cls, align}) -> {el, close}. Закрывается по Esc, клику вне и прокрутке. */
export function popover(anchor, content, { cls = '', align = 'end', onClose } = {}) {
  closePopover();
  const el = h('div', { class: ['pop', cls], role: 'dialog' }, content);
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    let above = false;
    if (top + el.offsetHeight > window.innerHeight - 8) { top = Math.max(8, r.top - el.offsetHeight - 6); above = true; }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    // масштаб от якоря: угол попапа, ближайший к кнопке
    const ox = Math.max(0, Math.min(w, r.left + r.width / 2 - left));
    el.style.transformOrigin = `${Math.round(ox)}px ${above ? '100%' : '0'}`;
  };
  place();
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) api.close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); api.close(); anchor.focus(); } };
  const onScroll = (e) => { if (!el.contains(e.target)) api.close(); };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', api.close);
  }, 0);
  anchor.setAttribute('aria-expanded', 'true');
  const api = {
    el,
    close() {
      if (!el.isConnected) return;
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', api.close);
      anchor.setAttribute('aria-expanded', 'false');
      el.remove();
      if (openPop === api) openPop = null;
      if (onClose) onClose();
    },
  };
  openPop = api;
  const first = el.querySelector('select, textarea, input, button');
  if (first) setTimeout(() => first.focus(), 0);
  return api;
}

/** Меню действий: items [{label, icon, onClick}] */
export function menu(anchor, items) {
  const list = h('div', { role: 'menu' }, items.map((it) => h('button', {
    type: 'button', class: 'menu-item', role: 'menuitem',
    onclick: () => { closePopover(); it.onClick(); },
  }, it.icon ? icon(it.icon, 16) : null, it.label)));
  return popover(anchor, list, { align: 'end' });
}

/* ---------- подсказки (data-tip, data-kbd) ---------- */

let tipEl = null;
let tipTarget = null;
let tipTimer = 0;
let tipHiddenAt = 0;
const TIP_DELAY = 320;

function showTip(target, instant) {
  const text = target.dataset.tip;
  if (!text || !target.isConnected) return;
  if (!tipEl) {
    tipEl = h('div', { class: 'tip', role: 'tooltip' });
    document.body.append(tipEl);
  }
  tipTarget = target;
  tipEl.textContent = text;
  if (target.dataset.kbd) tipEl.append(h('kbd', { class: 'tip__kbd' }, target.dataset.kbd));
  tipEl.classList.toggle('is-instant', !!instant);
  const r = target.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  let top = r.top - t.height - 6;
  let below = false;
  if (top < 8) { top = r.bottom + 6; below = true; }
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
  tipEl.style.top = `${top + window.scrollY}px`;
  tipEl.style.left = `${left + window.scrollX}px`;
  tipEl.style.transformOrigin = `${Math.round(r.left + r.width / 2 - left)}px ${below ? '0' : '100%'}`;
  tipEl.classList.add('is-in');
}

function hideTip() {
  clearTimeout(tipTimer);
  if (tipEl && tipEl.classList.contains('is-in')) tipHiddenAt = Date.now();
  tipTarget = null;
  if (tipEl) tipEl.classList.remove('is-in');
}

/** Подсказка после короткой задержки; если подсказка только что была открыта, следующая без задержки. */
function scheduleTip(target) {
  clearTimeout(tipTimer);
  const warm = (tipEl && tipEl.classList.contains('is-in')) || Date.now() - tipHiddenAt < 400;
  if (tipEl && tipEl.classList.contains('is-in')) tipEl.classList.remove('is-in');
  tipTarget = target;
  if (warm) { showTip(target, true); return; }
  tipTimer = setTimeout(() => { if (tipTarget === target) showTip(target, false); }, TIP_DELAY);
}

export function installTooltips() {
  // у disabled-кнопки нет событий мыши, поэтому подсказку роли вешаем на обёртку (см. gate)
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t && t !== tipTarget) scheduleTip(t);
    else if (!t && tipTarget) hideTip();
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t && e.target.matches(':focus-visible')) { clearTimeout(tipTimer); showTip(t, true); } else hideTip();
  });
  document.addEventListener('focusout', hideTip);
  window.addEventListener('scroll', hideTip, true);
  document.addEventListener('mousedown', hideTip, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); }, true);
}

/* ---------- движение ---------- */

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Перезапускает CSS-анимацию класса на элементе (и снимает класс по её окончании). */
export function replay(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

/** Счёт от 0 до значения за ms (ease-out), ширина фиксируется по итоговому тексту. */
export function countUp(el, value, format, ms = 400) {
  if (!el || !isNum(value) || reducedMotion()) return;
  const final = format(value);
  el.textContent = final;
  el.style.display = 'inline-block';
  el.style.minWidth = `${el.getBoundingClientRect().width}px`;
  const t0 = performance.now();
  const ease = (t) => 1 - (1 - t) ** 3;
  const step = (now) => {
    if (!el.isConnected) return;
    const t = Math.min(1, (now - t0) / ms);
    el.textContent = t < 1 ? format(value * ease(t)) : final;
    if (t < 1) requestAnimationFrame(step);
  };
  el.textContent = format(0);
  requestAnimationFrame(step);
}

/* ---------- клавиатура ---------- */

/** true, если пользователь печатает или открыт попап: горячие клавиши не перехватываем. */
export function keysBlocked(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return true;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return true;
  return !!document.querySelector('dialog[open], .pop');
}

/**
 * Клавиша по физическому положению (e.code) с запасным сравнением по символу для латинской
 * и русской раскладки: «]» и «ъ», «j» и «о».
 */
const KEYMAP = {
  next: { code: 'BracketRight', keys: [']', 'ъ', 'Ъ'] },
  prev: { code: 'BracketLeft', keys: ['[', 'х', 'Х'] },
  down: { code: 'KeyJ', keys: ['j', 'J', 'о', 'О'] },
  up: { code: 'KeyK', keys: ['k', 'K', 'л', 'Л'] },
  select: { code: 'KeyX', keys: ['x', 'X', 'ч', 'Ч'] },
  search: { code: 'Slash', keys: ['/'] },
};
export function isKey(e, name) {
  const k = KEYMAP[name];
  return !!k && (e.code === k.code || k.keys.includes(e.key));
}

/* ---------- порядок диалогов для перехода «предыдущий / следующий» ---------- */

const NAV_KEY = 'cqa.navList';

export function saveNavList(list) {
  try { sessionStorage.setItem(NAV_KEY, JSON.stringify(list)); } catch { /* приватный режим */ }
}

export function loadNavList() {
  try {
    const v = JSON.parse(sessionStorage.getItem(NAV_KEY) || 'null');
    return v && Array.isArray(v.ids) ? v : null;
  } catch { return null; }
}

/* ---------- форматтеры ---------- */

const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf3 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const dtf = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dtfShort = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export const fmt = {
  n2: (x) => (isNum(x) ? nf2.format(x) : ''),
  n1: (x) => (isNum(x) ? nf1.format(x) : ''),
  int: (x) => (isNum(x) ? nf0.format(x) : ''),
  pct: (x) => (isNum(x) ? `${nf1.format(x)} %` : ''),
  share: (x) => (isNum(x) ? `${nf1.format(x <= 1 ? x * 100 : x)} %` : ''),
  money: (x) => {
    if (!isNum(x)) return '';
    if (x === 0) return '$0,00';
    if (x < 1) return `$${nf3.format(x)}`;
    return `$${nf2.format(x)}`;
  },
  date: (s) => {
    if (!s) return '';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? String(s) : dtf.format(d);
  },
  dateShort: (s) => {
    if (!s) return '';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? String(s) : dtfShort.format(d).replace(',', '');
  },
  duration: (ms) => {
    if (!isNum(ms)) return '';
    const s = ms / 1000;
    if (s < 60) return `${nf1.format(s)} с`;
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    return `${m} мин ${String(r).padStart(2, '0')} с`;
  },
  seconds: (s) => {
    if (!isNum(s)) return '';
    if (s < 60) return `${Math.round(s)} с`;
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    return r ? `${m} мин ${r} с` : `${m} мин`;
  },
  tokens: (x) => (isNum(x) ? nf0.format(x) : ''),
};

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export const nDialogs = (n) => `${fmt.int(n)} ${plural(n, 'диалог', 'диалога', 'диалогов')}`;
export const nTurns = (n) => `${fmt.int(n)} ${plural(n, 'реплика', 'реплики', 'реплик')}`;
export const nRuns = (n) => `${fmt.int(n)} ${plural(n, 'прогон', 'прогона', 'прогонов')}`;

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

/* ---------- стоимость ---------- */

export const COST_PER_RUN = { 'claude-opus-5-5': 0.08, 'claude-sonnet-5-5': 0.04, 'claude-haiku-5-5': 0.002 };

export function estimateCost(settings, n = 1) {
  const st = settings || {};
  const votes = Number(st.votes) || 3;
  if (st.provider === 'openai_compat') return { votes, cost: 0, local: true, model: st.local_model || 'локальная модель' };
  const per = COST_PER_RUN[st.model] ?? 0.08;
  return { votes, cost: n * votes * per, local: false, model: st.model || '' };
}

export function costText(est) {
  return est.local
    ? `${nRuns(est.votes)} на диалог, локальная модель без затрат на API`
    : `${nRuns(est.votes)} на диалог, около ${fmt.money(est.cost)}`;
}

/* ---------- каналы, роли, значения ---------- */

export const TYPE_LABELS = { binary: 'Да/Нет', scale: 'Шкала', flag: 'Флаг' };
export const LANG_LABELS = { RU: 'Русский', KZ: 'Казахский', EN: 'Английский' };
export const SPEAKERS = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };
export const ENDED_BY = { operator_closed: 'оператор закрыл чат', client_or_connection: 'клиент ушёл' };

export function isCall(channel) {
  return /call|voice|звон/i.test(String(channel || ''));
}
export const channelLabel = (ch) => (isCall(ch) ? 'Звонок' : 'Чат');

export function scaleSteps(c) {
  return [...(c.scale || [])].sort((a, b) => Number(b.value) - Number(a.value));
}

export function allowedValues(c) {
  if (!c) return [];
  const vals = c.type === 'scale' ? scaleSteps(c).map((s) => String(Math.trunc(Number(s.value)))) : ['YES', 'NO'];
  if (c.na_allowed && c.type !== 'flag') vals.push('NA');
  return vals;
}

export function normValue(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim().toUpperCase();
  const syn = { 'ДА': 'YES', TRUE: 'YES', 'НЕТ': 'NO', FALSE: 'NO', 'N/A': 'NA', 'Н/П': 'NA' };
  if (syn[s]) return syn[s];
  if (/^-?\d+(\.0+)?$/.test(s)) return String(Math.trunc(Number(s)));
  return s;
}

export function scaleMax(c) {
  const vals = (c.scale || []).map((s) => Number(s.value));
  return vals.length ? Math.max(...vals) : 1;
}

/** Короткая подпись значения без контекста критерия. */
export function shortValue(v) {
  const n = normValue(v);
  if (!n) return '';
  return n === 'YES' ? 'Да' : n === 'NO' ? 'Нет' : n === 'NA' ? 'Н/П' : n;
}

export function valueLabel(c, v) {
  const n = normValue(v);
  if (!n) return '';
  if (n === 'NA') return 'Н/П';
  if (c && c.type === 'scale') return `${n} из ${scaleMax(c)}`;
  return n === 'YES' ? 'Да' : n === 'NO' ? 'Нет' : n;
}

/** Тон значения: yes | no | partial | na | none */
export function valueTone(c, v) {
  const n = normValue(v);
  if (!n) return 'none';
  if (n === 'NA') return 'na';
  if (c && c.type === 'flag') return n === 'YES' ? 'no' : 'yes';
  if (c && c.type === 'scale') {
    const x = Number(n);
    const mx = scaleMax(c);
    if (x >= mx) return 'yes';
    if (x <= 0) return 'no';
    return 'partial';
  }
  return n === 'YES' ? 'yes' : n === 'NO' ? 'no' : 'na';
}

export function valueBadge(c, v) {
  const tone = valueTone(c, v);
  const step = c && c.type === 'scale' ? scaleSteps(c).find((s) => normValue(s.value) === normValue(v)) : null;
  return h('span', { class: `badge badge--${tone}`, 'data-tip': step && step.label ? step.label : null }, valueLabel(c, v) || 'нет');
}

export function scoreTone(x) {
  if (!isNum(x)) return '';
  if (x >= 85) return 'good';
  if (x < 60) return 'low';
  return 'mid';
}

/** Итог в ячейке: финальный, а если апелляция его изменила, то «исходный / финальный». */
export function scoreCell(total, finalTotal) {
  const fin = isNum(finalTotal) ? finalTotal : total;
  if (!isNum(fin)) return h('span', { class: 't-2' }, 'Н/П');
  const changed = isNum(total) && Math.abs(total - fin) > 0.004;
  return h('span', { class: 'nowrap', 'data-tip': changed ? `Исходно ${fmt.n2(total)}, после апелляции ${fmt.n2(fin)}` : null },
    changed ? h('span', { class: 'score__orig' }, `${fmt.n2(total)} /`) : null,
    h('span', { class: `score score--${scoreTone(fin)}` }, fmt.n2(fin)));
}

/** Доля 0..1 в виде «2 из 3» (знаменатель до 9). */
export function fraction(x, votes) {
  if (!isNum(x)) return null;
  if (isNum(votes) && votes > 0) return { k: Math.round(x * votes), n: votes };
  for (let d = 1; d <= 9; d += 1) {
    const k = x * d;
    if (Math.abs(k - Math.round(k)) < 0.02) return { k: Math.round(k), n: d };
  }
  return null;
}

export function bar(pct, tone, { grow = false } = {}) {
  const p = Math.max(0, Math.min(100, isNum(pct) ? pct : 0));
  return h('div', { class: ['bar', tone && `bar--${tone}`, grow && 'bar--grow'], role: 'presentation' }, h('span', { style: { width: `${p}%` } }));
}

/* ---------- ссылки на реплики в тексте ---------- */

const TURN_RX = /(?<![\p{L}\d])[TТ]\s?(\d{1,4})(?:\s*(?:[\u2013\u2014-]|\.\.)\s*[TТ]?\s?(\d{1,4}))?/gu;

/**
 * «T12» и «T12-T15» в тексте становятся ссылками; onTurn(from, to).
 * Скобки и знаки препинания вплотную к ссылке не отрываются от неё переносом строки.
 */
export function linkifyTurns(text, { onTurn, preview } = {}) {
  const frag = document.createDocumentFragment();
  const s = String(text || '');
  let last = 0;
  for (const m of s.matchAll(TURN_RX)) {
    if (m.index < last) continue;
    let start = m.index;
    let lead = '';
    const prev = s.slice(last, start);
    const lm = /[(«"\[]+$/.exec(prev);
    if (lm) { lead = lm[0]; start -= lead.length; }
    if (start > last) frag.append(document.createTextNode(s.slice(last, start)));
    // В тексте номера реплик с 1 (как у организаторов), внутри индексы с 0.
    const a = Number(m[1]) - 1;
    const b = m[2] !== undefined ? Number(m[2]) - 1 : a;
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    const link = h('button', {
      type: 'button', class: 'tlink',
      'data-tip': preview ? (from === to ? preview(from) : `${preview(from)}\n\n${preview(to)}`) : null,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); if (onTurn) onTurn(from, to); },
    }, m[0]);
    let end = m.index + m[0].length;
    const tm = /^[),.;:!?»"\]]+/.exec(s.slice(end));
    const trail = tm ? tm[0] : '';
    end += trail.length;
    frag.append(lead || trail ? h('span', { class: 'nowrap' }, lead, link, trail) : link);
    last = end;
  }
  if (last < s.length) frag.append(document.createTextNode(s.slice(last)));
  return frag;
}

export function rangeLabel(from, to) {
  return from === to ? `T${from + 1}` : `T${from + 1}-T${to + 1}`;
}

/* ---------- состояния ---------- */

export function skeleton(lines = 5) {
  const box = h('div', { class: 'skel', 'aria-busy': 'true', 'aria-label': 'Загрузка' });
  for (let i = 0; i < lines; i += 1) box.append(h('span', { style: { width: `${92 - ((i * 23) % 40)}%` } }));
  return box;
}

export function emptyState({ title, text, actions }) {
  return h('div', { class: 'empty' },
    h('h3', { class: 'empty__title' }, title),
    text ? h('p', { class: 'empty__text' }, text) : null,
    actions ? h('div', { class: 'empty__actions' }, actions) : null);
}

export function errorState(err, onRetry) {
  return h('div', { class: 'empty empty--error' },
    h('h3', { class: 'empty__title' }, 'Данные не загрузились'),
    h('p', { class: 'empty__text' }, (err && err.message) || String(err)),
    onRetry ? h('div', { class: 'empty__actions' }, button('Повторить', { kind: 'secondary', onClick: onRetry })) : null);
}

/** Шапка страницы. */
export function pageHeader({ title, meta, back, actions, extra, progress }) {
  return h('header', { class: 'ph' },
    h('div', { class: 'ph__main' },
      back ? h('a', { class: 'ph__back', href: back.href, 'data-tip': back.kbd ? 'Вернуться к списку' : null, 'data-kbd': back.kbd || null }, icon('chevronLeft', 16), back.label) : null,
      h('h1', { class: 'ph__title' }, title),
      meta ? h('div', { class: 'ph__meta' }, meta) : null,
      extra || null),
    actions ? h('div', { class: 'ph__actions' }, actions) : null,
    progress || null);
}

/** Тонкая полоса прогресса под шапкой: неопределённая (бегущий отрезок) или с долей готового. */
export function progressLine(label) {
  const fill = h('span', { class: 'progress-line__fill' });
  const el = h('div', { class: 'progress-line', hidden: true, role: 'progressbar', 'aria-label': label || 'Прогресс' }, fill);
  return {
    el,
    set(done, total) {
      el.hidden = false;
      const indet = !isNum(done) || !isNum(total) || total <= 0;
      el.classList.toggle('is-indeterminate', indet);
      if (indet) { el.removeAttribute('aria-valuenow'); fill.style.transform = ''; return; }
      el.setAttribute('aria-valuenow', String(done));
      el.setAttribute('aria-valuemax', String(total));
      fill.style.transform = `scaleX(${Math.max(0.03, done / total)})`;
    },
    hide() { el.hidden = true; },
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
