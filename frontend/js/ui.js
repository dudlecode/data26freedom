// Небольшие помощники интерфейса: построитель элементов, иконки, тосты, модальные окна,
// подсказки, форматтеры, бейджи значений. Все данные выводятся только через textContent.

/* ---------- построитель DOM ---------- */

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'value' && ('value' in el)) el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'open' || k === 'required' || k === 'multiple') el[k] = !!v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/* ---------- иконки (статичные пути, не данные) ---------- */

const ICONS = {
  chat: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z',
  phone: 'M6.6 3.5l2.6-.4c.6-.1 1.1.2 1.3.8l1 2.9c.2.5 0 1.1-.4 1.4L9.6 9.4a11 11 0 0 0 5 5l1.2-1.5c.3-.4.9-.6 1.4-.4l2.9 1c.6.2.9.7.8 1.3l-.4 2.6c-.1.7-.7 1.1-1.4 1.1C10.4 18.4 5.6 13.6 5.5 4.9c0-.7.4-1.3 1.1-1.4z',
  play: 'M8 5.6v12.8c0 .8.9 1.3 1.6.8l10-6.4c.6-.4.6-1.2 0-1.6l-10-6.4C8.9 4.3 8 4.8 8 5.6z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 3.5l9.5 16.5h-19zM12 10v4.5M12 17.2v.3',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.8v.3',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  upload: 'M12 15.5V4M7.5 8.5L12 4l4.5 4.5M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3',
  download: 'M12 4v11.5M7.5 11L12 15.5l4.5-4.5M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3',
  cloud: 'M7 18.5h10.5a4 4 0 0 0 .6-8A6 6 0 0 0 6.6 9.6 4.5 4.5 0 0 0 7 18.5z',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L20 20',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7',
  copy: 'M8 8h11v11H8zM5 15.5V5h10.5',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  chevron: 'M9 6l6 6-6 6',
  gavel: 'M14 4.5l5.5 5.5M11.5 7l5.5 5.5M12.8 5.7l-5 5 4.5 4.5 5-5zM9.5 13.5L4 19',
  scale: 'M12 4v16M6 20h12M5 8h14M7.5 8l-3 6.5a3 3 0 0 0 6 0zM16.5 8l-3 6.5a3 3 0 0 0 6 0z',
  spark: 'M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  compare: 'M8 4v16M16 4v16M4 8h4M16 16h4M4 16h4M16 8h4',
  list: 'M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.5M4 12h.5M4 17.5h.5',
  key: 'M14.5 13.5a5 5 0 1 0-4.6-3L3.5 17v3.5H7v-2h2v-2h2l1.2-1.2c.7.2 1.5.2 2.3.2zM16 7.5h.3',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 12.2v-.4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0',
  bot: 'M6 9h12v9H6zM12 9V5.5M12 5.5h.1M9.5 13h.1M14.5 13h.1M3.5 12.5v3M20.5 12.5v3',
  headset: 'M4.5 14v-2a7.5 7.5 0 0 1 15 0v2M4.5 14h3v5h-3zM16.5 14h3v5h-3zM19.5 19c0 1.2-2 2-4.5 2h-2',
  cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-1.7 1L15 20.5h-4l-.4-2.1a7 7 0 0 1-1.7-1l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-3L5 9.3l2-3.4 1.9.7a7 7 0 0 1 1.7-1L11 3.5h4l.4 2.1a7 7 0 0 1 1.7 1l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 3z',
};

export function icon(name, size = 16, cls = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon ${cls}`.trim());
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.info);
  const filled = name === 'play' || name === 'pause';
  path.setAttribute('fill', filled ? 'currentColor' : 'none');
  path.setAttribute('stroke', filled ? 'none' : 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/* ---------- кнопки ---------- */

export function button(label, { kind = 'secondary', iconName, onClick, size, title, type = 'button', disabled, cls, tip } = {}) {
  return h('button', {
    type,
    class: ['btn', `btn--${kind}`, size && `btn--${size}`, cls],
    onclick: onClick,
    title,
    disabled,
    'data-tip': tip,
  }, iconName ? icon(iconName, size === 'sm' ? 14 : 16) : null, label ? h('span', null, label) : null);
}

/** Помечает действие роли: при другой активной роли оно визуально приглушено и снабжено подсказкой. */
export function roleAction(el, role) {
  el.classList.add('role-action');
  el.dataset.forRole = role;
  const hint = role === 'supervisor' ? 'Действие супервайзера' : 'Действие проверяющего';
  if (!el.dataset.tip) el.dataset.tip = hint;
  el.dataset.roleHint = hint;
  return el;
}

/* ---------- состояние в localStorage ---------- */

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

export function getRole() {
  const r = prefs.get('role', 'supervisor');
  return r === 'reviewer' ? 'reviewer' : 'supervisor';
}

/* ---------- тосты ---------- */

export function toast(message, kind = 'info', timeout) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const ms = timeout ?? (kind === 'error' ? 7000 : 3800);
  const el = h('div', { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info', 16),
    h('div', { class: 'toast__msg' }, String(message)),
    h('button', { class: 'toast__close', type: 'button', 'aria-label': 'Закрыть', onclick: () => dismiss() }, icon('x', 14)));
  box.append(el);
  void el.offsetWidth; // запуск CSS-перехода без requestAnimationFrame (работает и в фоновой вкладке)
  el.classList.add('is-in');
  let timer = setTimeout(dismiss, ms);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 2000); });
  function dismiss() {
    clearTimeout(timer);
    el.classList.remove('is-in');
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 220);
  }
}

export function toastError(e, prefix) {
  if (e && e.name === 'AbortError') return;
  const msg = (e && e.message) || String(e);
  toast(prefix ? `${prefix}: ${msg}` : msg, 'error');
}

/* ---------- модальные окна ---------- */

let modalStack = 0;

/**
 * openModal({title, body, actions:[{label, kind, onClick, close:false}], size:'md'|'lg'|'xl', onClose})
 * onClick может вернуть false (не закрывать) или Promise (кнопка блокируется на время выполнения).
 */
export function openModal({ title, subtitle, body, actions = [], size = 'md', onClose, initialFocus } = {}) {
  const prevFocus = document.activeElement;
  const titleId = `modal-title-${Date.now()}`;
  const footer = h('div', { class: 'modal__footer' });
  const dialog = h('div', { class: `modal modal--${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'modal__header' },
      h('div', null,
        h('h2', { class: 'modal__title', id: titleId }, title || ''),
        subtitle ? h('p', { class: 'modal__subtitle' }, subtitle) : null),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Закрыть', onclick: () => close() }, icon('x', 18))),
    h('div', { class: 'modal__body' }, body),
    actions.length ? footer : null);
  const overlay = h('div', { class: 'modal-overlay' }, dialog);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

  for (const a of actions) {
    const b = button(a.label, { kind: a.kind || 'secondary', iconName: a.icon, disabled: a.disabled });
    if (a.id) b.dataset.action = a.id;
    b.addEventListener('click', async () => {
      if (!a.onClick) { close(); return; }
      b.disabled = true;
      b.classList.add('is-busy');
      try {
        const r = await a.onClick({ close, button: b });
        if (r !== false) close();
      } catch (e) {
        toastError(e);
      } finally {
        b.disabled = false;
        b.classList.remove('is-busy');
      }
    });
    footer.append(b);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      const f = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  overlay.addEventListener('keydown', onKey);
  document.body.append(overlay);
  modalStack += 1;
  document.body.classList.add('has-modal');
  void overlay.offsetWidth;
  overlay.classList.add('is-in');
  setTimeout(() => {
    const target = (initialFocus && dialog.querySelector(initialFocus))
      || dialog.querySelector('textarea, input:not([type=hidden]), select')
      || footer.querySelector('.btn--primary') || dialog.querySelector('.icon-btn');
    if (target) target.focus();
  }, 30);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    overlay.classList.remove('is-in');
    setTimeout(() => overlay.remove(), 180);
    modalStack -= 1;
    if (modalStack <= 0) { modalStack = 0; document.body.classList.remove('has-modal'); }
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    if (onClose) onClose();
  }
  return { close, el: dialog, footer };
}

export function confirmDialog({ title = 'Подтвердите действие', message, confirmLabel = 'Подтвердить', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    openModal({
      title,
      size: 'sm',
      body: h('p', { class: 'modal__text' }, message || ''),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

/* ---------- подсказки (data-tip) ---------- */

let tipEl = null;
let tipTarget = null;

function showTip(target) {
  const text = target.dataset.tip;
  if (!text) return;
  if (!tipEl) {
    tipEl = h('div', { class: 'tooltip', role: 'tooltip' });
    document.body.append(tipEl);
  }
  tipTarget = target;
  tipEl.textContent = text;
  tipEl.classList.toggle('tooltip--wide', text.length > 90);
  tipEl.classList.add('is-in');
  const r = target.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  let top = r.top - t.height - 8;
  let below = false;
  if (top < 8) { top = r.bottom + 8; below = true; }
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
  tipEl.style.top = `${top + window.scrollY}px`;
  tipEl.style.left = `${left + window.scrollX}px`;
  tipEl.classList.toggle('is-below', below);
}

function hideTip() {
  tipTarget = null;
  if (tipEl) tipEl.classList.remove('is-in');
}

export function installTooltips() {
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t && t !== tipTarget) showTip(t);
    else if (!t && tipTarget) hideTip();
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (t) showTip(t); else hideTip();
  });
  document.addEventListener('focusout', hideTip);
  window.addEventListener('scroll', hideTip, true);
  document.addEventListener('click', hideTip, true);
}

/* ---------- форматтеры ---------- */

const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf3 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const dtf = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dtfShort = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** Модель в нашем контуре: localhost / частная сеть (как config.is_local на сервере). */
export function isLocalUrl(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  return ['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(host) || host.endsWith('.local')
    || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/** Типичный прогон оценки: чек-лист + факты + транскрипт на входе, JSON по 8 критериям на выходе (токены). */
export const TYPICAL_RUN_TOKENS = { input: 9000, output: 1500 };

/** estimateCost(settings, nDialogs) → {votes, cost|null, local, model}. cost = null - цена провайдера не задана. */
export function estimateCost(settings, n = 1) {
  const st = settings || {};
  const votes = Number(st.votes) || 3;
  const local = isLocalUrl(st.base_url || '');
  const pin = Number(st.price_input_per_mtok) || 0;
  const pout = Number(st.price_output_per_mtok) || 0;
  const perRun = (TYPICAL_RUN_TOKENS.input * pin + TYPICAL_RUN_TOKENS.output * pout) / 1e6;
  return { votes, cost: pin || pout ? n * votes * perRun : null, local, model: st.model || '' };
}

/** Подсказка о затратах перед запуском оценки. */
export function costHint(est) {
  if (est.cost != null) return `Ориентировочно ${fmt.money(est.cost)}${est.model ? ` (${est.model})` : ''}.`;
  return est.local ? 'Модель в контуре компании - без оплаты за токены.' : 'Цена провайдера не задана (Настройки) - стоимость не считается.';
}

export const fmt = {
  n2: (x) => (isNum(x) ? nf2.format(x) : '—'),
  n1: (x) => (isNum(x) ? nf1.format(x) : '—'),
  int: (x) => (isNum(x) ? nf0.format(x) : '—'),
  pct: (x) => (isNum(x) ? `${nf1.format(x)} %` : '—'),
  /** доля 0..1 или процент 0..100 → «87,5 %» */
  share: (x) => (isNum(x) ? `${nf1.format(x <= 1 ? x * 100 : x)} %` : '—'),
  money: (x) => {
    if (!isNum(x)) return '—';
    if (x === 0) return '$0,00';
    if (x < 1) return `$${nf3.format(x)}`;
    return `$${nf2.format(x)}`;
  },
  date: (s) => {
    if (!s) return '—';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? String(s) : dtf.format(d);
  },
  dateShort: (s) => {
    if (!s) return '—';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? String(s) : dtfShort.format(d);
  },
  duration: (ms) => {
    if (!isNum(ms)) return '—';
    const s = ms / 1000;
    if (s < 60) return `${nf1.format(s)} с`;
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    return `${m} мин ${String(r).padStart(2, '0')} с`;
  },
  tokens: (x) => (isNum(x) ? nf0.format(x) : '—'),
};

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------- критерии и значения ---------- */

export const TYPE_LABELS = { binary: 'Да/Нет', scale: 'Шкала', flag: 'Флаг без баллов' };
export const CHANNEL_LABELS = { 'agent chat': 'Чат', chat: 'Чат', 'voice call': 'Звонок', call: 'Звонок' };
export const LANG_LABELS = { RU: 'Русский', KZ: 'Казахский', EN: 'Английский' };
export const SPEAKERS = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };

export function isCall(channel) {
  return /call|voice|звон/i.test(String(channel || ''));
}

export function channelCell(channel) {
  const call = isCall(channel);
  return h('span', { class: 'channel', 'data-tip': String(channel || '') },
    icon(call ? 'phone' : 'chat', 15), h('span', null, call ? 'Звонок' : 'Чат'));
}

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
  const syn = { 'ДА': 'YES', TRUE: 'YES', 'НЕТ': 'NO', FALSE: 'NO', 'N/A': 'NA' };
  if (syn[s]) return syn[s];
  if (/^-?\d+(\.0+)?$/.test(s)) return String(Math.trunc(Number(s)));
  return s;
}

export function scaleMax(c) {
  const vals = (c.scale || []).map((s) => Number(s.value));
  return vals.length ? Math.max(...vals) : 1;
}

/** Человекочитаемое значение критерия. */
export function valueLabel(c, v) {
  const n = normValue(v);
  if (!n) return '—';
  if (n === 'NA') return 'N/A';
  if (c && c.type === 'scale') return `${n} из ${scaleMax(c)}`;
  if (c && c.type === 'flag') return n === 'YES' ? 'Да, выявлено' : 'Нет';
  return n === 'YES' ? 'Да' : n === 'NO' ? 'Нет' : n;
}

/** Тон значения: yes | no | na | partial | flag */
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

export function valueBadge(c, v, { size } = {}) {
  const tone = valueTone(c, v);
  const step = c && c.type === 'scale' ? scaleSteps(c).find((s) => normValue(s.value) === normValue(v)) : null;
  return h('span', { class: ['vbadge', `vbadge--${tone}`, size && `vbadge--${size}`], 'data-tip': step && step.label ? step.label : null }, valueLabel(c, v));
}

export function scoreTone(x) {
  if (!isNum(x)) return 'none';
  if (x >= 85) return 'great';
  if (x >= 70) return 'good';
  if (x >= 50) return 'mid';
  return 'low';
}

/** Пилюля итога: если final отличается от исходного, исходный показан зачёркнутым. */
export function scorePill(total, finalTotal) {
  const fin = isNum(finalTotal) ? finalTotal : total;
  const changed = isNum(total) && isNum(finalTotal) && Math.abs(total - finalTotal) > 0.004;
  return h('span', { class: 'score-cell' },
    changed ? h('s', { class: 'score-orig', 'data-tip': 'Исходная оценка ИИ до решения по апелляции' }, fmt.n2(total)) : null,
    h('span', { class: ['score-pill', `score-pill--${scoreTone(fin)}`] }, isNum(fin) ? fmt.n2(fin) : '—'));
}

export function agreementMeter(x, { showHint = true } = {}) {
  if (!isNum(x)) return h('span', { class: 'muted' }, '—');
  const pct = Math.round(x * 100);
  const tone = x >= 0.999 ? 'full' : x >= 0.66 ? 'mid' : 'low';
  return h('span', { class: `agree agree--${tone}`, 'data-tip': `Минимальная согласованность прогонов по критериям: ${pct} %` },
    h('span', { class: 'agree__track' }, h('span', { class: 'agree__fill', style: { width: `${pct}%` } })),
    showHint && x < 0.999 ? h('span', { class: 'agree__hint' }, 'проверить') : null);
}

export function statusChip(status, error) {
  const map = {
    queued: ['В очереди', 'queued'],
    running: ['Оценивается', 'running'],
    done: ['Готово', 'done'],
    error: ['Ошибка', 'error'],
  };
  const [label, tone] = map[status] || ['Не оценён', 'none'];
  return h('span', { class: `status status--${tone}`, 'data-tip': status === 'error' && error ? String(error) : null },
    status === 'running' || status === 'queued' ? h('span', { class: 'spinner spinner--xs', 'aria-hidden': 'true' }) : h('span', { class: 'status__dot' }),
    label);
}

/* ---------- ссылки на реплики в тексте ---------- */

const TURN_RX = /(?<![\p{L}\d])[TТ]\s?(\d{1,4})(?:\s*(?:[–—-]|\.\.)\s*[TТ]?\s?(\d{1,4}))?/gu;

/**
 * Превращает «T12» и «T12–T15» в кнопки-ссылки. onTurn(from, to) вызывается по клику.
 * preview(idx) → строка для подсказки.
 */
export function linkifyTurns(text, { onTurn, preview } = {}) {
  const frag = document.createDocumentFragment();
  const s = String(text || '');
  let last = 0;
  for (const m of s.matchAll(TURN_RX)) {
    if (m.index > last) frag.append(document.createTextNode(s.slice(last, m.index)));
    const from = Number(m[1]);
    const to = m[2] !== undefined ? Number(m[2]) : from;
    const a = h('button', {
      type: 'button',
      class: 'turn-link',
      'data-tip': preview ? (from === to ? preview(from) : `${preview(from)}\n…\n${preview(to)}`) : null,
      onclick: (e) => { e.preventDefault(); if (onTurn) onTurn(Math.min(from, to), Math.max(from, to)); },
    }, m[0]);
    frag.append(a);
    last = m.index + m[0].length;
  }
  if (last < s.length) frag.append(document.createTextNode(s.slice(last)));
  return frag;
}

/* ---------- состояния ---------- */

export function spinner(label) {
  return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), label ? h('span', null, label) : null);
}

export function skeleton(lines = 4, { tall = false } = {}) {
  const box = h('div', { class: 'skeleton-group', 'aria-busy': 'true', 'aria-label': 'Загрузка' });
  for (let i = 0; i < lines; i += 1) {
    box.append(h('div', { class: ['skeleton', tall && 'skeleton--tall'], style: { width: `${100 - ((i * 17) % 35)}%` } }));
  }
  return box;
}

export function emptyState({ title, text, action, iconName = 'list' }) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty__icon' }, icon(iconName, 26)),
    h('h3', { class: 'empty__title' }, title),
    text ? h('p', { class: 'empty__text' }, text) : null,
    action || null);
}

export function errorState(err, onRetry) {
  return h('div', { class: 'empty empty--error' },
    h('div', { class: 'empty__icon' }, icon('alert', 26)),
    h('h3', { class: 'empty__title' }, 'Не удалось загрузить данные'),
    h('p', { class: 'empty__text' }, (err && err.message) || String(err)),
    onRetry ? button('Повторить', { kind: 'secondary', iconName: 'refresh', onClick: onRetry }) : null);
}

/* ---------- поля форм ---------- */

export function field(label, control, { hint, cls, htmlFor } = {}) {
  return h('label', { class: ['field', cls], for: htmlFor },
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

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
