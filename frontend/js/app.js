/*
 * CQA — оболочка приложения: hash-роутер, шапка, роль, баннеры.
 *
 * Каждое представление (js/views/*.js) экспортирует
 *     mount(container, { params, query, ctx }) → cleanup | undefined | Promise<cleanup>
 * и ничего не знает о шапке и роутере: оно рисует себя только внутри переданного контейнера.
 * Поэтому любое представление можно встроить отдельно (например, как HTML web resource в
 * Dynamics 365: одна страница = config.js + css/app.css + нужный view, вызов mount(div, {...})).
 * Навигация между представлениями идёт через ctx.navigate(hash); в Dynamics её можно подменить
 * на Xrm.Navigation, передав свой ctx.
 */

import { api } from './api.js';
import { h, clear, getRole, prefs, installTooltips, errorState, skeleton, confirmDialog } from './ui.js';

const routes = [
  { rx: /^\/dialogs$/, nav: 'dialogs', load: () => import('./views/dialogs.js') },
  { rx: /^\/dialog\/(.+)$/, nav: 'dialogs', keys: ['id'], load: () => import('./views/dialog.js') },
  { rx: /^\/appeals$/, nav: 'appeals', load: () => import('./views/appeals.js') },
  { rx: /^\/appeal\/(.+)$/, nav: 'appeals', keys: ['id'], load: () => import('./views/appeal.js') },
  { rx: /^\/checklists$/, nav: 'checklists', load: () => import('./views/checklists.js') },
  { rx: /^\/calibration$/, nav: 'calibration', load: () => import('./views/calibration.js') },
  { rx: /^\/settings$/, nav: 'settings', load: () => import('./views/settings.js') },
];

const view = document.getElementById('view');
let cleanup = null;
let renderSeq = 0;
/** Охрана ухода со страницы: представление регистрирует () => true|false (можно ли уйти без вопроса). */
let leaveGuard = null;
let currentHash = location.hash;
let guardPrompting = false;

export const ctx = {
  api,
  navigate(hash) {
    const target = hash.startsWith('#') ? hash : `#${hash}`;
    if (location.hash === target) render();
    else location.hash = target;
  },
  /** заменить query в текущем hash без перерисовки представления */
  replaceQuery(query) {
    const [path] = location.hash.replace(/^#/, '').split('?');
    const q = new URLSearchParams(query).toString();
    history.replaceState(null, '', `#${path}${q ? `?${q}` : ''}`);
    currentHash = location.hash;
  },
  /** fn() → true, если можно уйти без подтверждения (нет несохранённых изменений); null — снять */
  setLeaveGuard(fn) { leaveGuard = typeof fn === 'function' ? fn : null; },
  role: () => getRole(),
  refreshBadges: () => refreshBadges(),
  refreshHealth: () => refreshHealth(),
  setTitle(t) { document.title = t ? `${t} — CQA` : 'CQA — оценка качества диалогов'; },
};

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/dialogs';
  const [path, q = ''] = raw.split('?');
  return { path: path || '/dialogs', query: Object.fromEntries(new URLSearchParams(q)) };
}

async function onHashChange() {
  const target = location.hash;
  let ok = true;
  try { ok = !leaveGuard || leaveGuard(); } catch { ok = true; }
  if (!ok) {
    history.replaceState(null, '', currentHash || '#/dialogs'); // остаёмся, пока пользователь не решит
    if (guardPrompting) return;
    guardPrompting = true;
    const leave = await confirmDialog({
      title: 'Несохранённые изменения',
      message: 'Изменения чек-листа не сохранены и будут потеряны. Уйти со страницы?',
      confirmLabel: 'Уйти без сохранения',
      danger: true,
    });
    guardPrompting = false;
    if (!leave) return;
    leaveGuard = null;
    currentHash = target;
    history.replaceState(null, '', target);
  }
  currentHash = target;
  render();
}

async function render() {
  const seq = ++renderSeq;
  currentHash = location.hash;
  const { path, query } = parseHash();
  const route = routes.find((r) => r.rx.test(path));
  if (!route) { location.replace('#/dialogs'); return; }
  const m = path.match(route.rx);
  const params = {};
  (route.keys || []).forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

  for (const a of document.querySelectorAll('[data-nav]')) {
    const on = a.dataset.nav === route.nav;
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }

  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  leaveGuard = null;
  clear(view);
  const container = h('div', { class: 'view view--enter' });
  container.append(skeleton(6));
  view.append(container);
  window.scrollTo(0, 0);

  try {
    const mod = await route.load();
    if (seq !== renderSeq) return;
    clear(container);
    const c = await mod.mount(container, { params, query, ctx });
    if (seq !== renderSeq) { if (typeof c === 'function') c(); return; }
    cleanup = c;
  } catch (e) {
    if (seq !== renderSeq) return;
    console.error(e);
    clear(container);
    container.append(errorState(e, render));
  }
}

/* ---------- роль ---------- */

function applyRole(role) {
  document.body.dataset.role = role;
  for (const b of document.querySelectorAll('[data-role-value]')) {
    b.setAttribute('aria-checked', String(b.dataset.roleValue === role));
  }
}

function initRoleSwitch() {
  applyRole(getRole());
  const box = document.getElementById('role-switch');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-role-value]');
    if (!b) return;
    prefs.set('role', b.dataset.roleValue);
    applyRole(b.dataset.roleValue);
    window.dispatchEvent(new CustomEvent('cqa:role', { detail: b.dataset.roleValue }));
  });
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = getRole() === 'supervisor' ? 'reviewer' : 'supervisor';
    prefs.set('role', next);
    applyRole(next);
    box.querySelector(`[data-role-value="${next}"]`).focus();
  });
}

/* ---------- баннеры и бейджи ---------- */

async function refreshHealth() {
  try {
    const hlt = await api.health();
    // баннер - только если сервер модели недоступен или модели на нём нет
    const m = (hlt && hlt.model) || {};
    const problem = m.error || (m.reachable === false ? 'сервер модели недоступен' : '');
    const banner = document.getElementById('key-banner');
    banner.hidden = !problem;
    if (problem) document.getElementById('key-banner-text').textContent = `Модель ${m.model || ''} (${m.base_url || ''}): ${problem} - оценка диалогов недоступна.`;
  } catch {
    // офлайн-баннер показывает обработчик cqa:offline
  }
}

async function refreshBadges() {
  const badge = document.getElementById('nav-appeals-badge');
  try {
    const r = await api.appeals('open');
    const n = (r && r.items ? r.items.length : 0);
    badge.textContent = String(n);
    badge.hidden = n === 0;
    badge.setAttribute('aria-label', `открытых апелляций: ${n}`);
  } catch {
    badge.hidden = true;
  }
}

window.addEventListener('cqa:offline', () => { document.getElementById('offline-banner').hidden = false; });
window.addEventListener('cqa:online', () => { document.getElementById('offline-banner').hidden = true; });

/* ---------- встраивание (Dynamics 365 web resource, iframe) ----------
 * Query-параметры страницы (не hash):
 *   ?dialog=<conversation_id> | ?appeal=<id> | ?view=appeals|checklists|...  - открыть нужный экран
 *   ?data=<...>   - так Dynamics 365 передаёт параметр в веб-ресурс: «p1-ru-001», «dialog=p1-ru-001»
 *                   или «appeal=12» (можно несколько через &, значение URL-кодируется)
 *   ?embed=1      - без шапки и навигации, для карточки на форме CRM
 *   ?role=reviewer|supervisor, ?user=<имя> - роль и имя для журнала действий
 */
function applyEmbedParams() {
  const qs = new URLSearchParams(location.search);
  const data = qs.get('data');
  if (data) {
    const inner = data.includes('=') ? new URLSearchParams(data) : new URLSearchParams({ dialog: data });
    for (const [k, v] of inner) if (!qs.has(k)) qs.set(k, v);
  }
  if (qs.get('embed') === '1' || qs.get('embed') === 'true') document.body.classList.add('is-embed');
  const role = qs.get('role');
  if (role === 'reviewer' || role === 'supervisor') prefs.set('role', role);
  const user = qs.get('user');
  if (user) window.CQA_CONFIG = { ...(window.CQA_CONFIG || {}), user };
  if (location.hash && location.hash !== '#' && location.hash !== '#/') return; // явный маршрут важнее
  if (qs.get('dialog')) history.replaceState(null, '', `${location.pathname}${location.search}#/dialog/${encodeURIComponent(qs.get('dialog'))}`);
  else if (qs.get('appeal')) history.replaceState(null, '', `${location.pathname}${location.search}#/appeal/${encodeURIComponent(qs.get('appeal'))}`);
  else if (qs.get('view') && /^[a-z]+$/.test(qs.get('view'))) history.replaceState(null, '', `${location.pathname}${location.search}#/${qs.get('view')}`);
}

applyEmbedParams();
installTooltips();
initRoleSwitch();
window.addEventListener('hashchange', onHashChange);
render();
refreshHealth();
refreshBadges();
setInterval(refreshBadges, 30000);
setInterval(refreshHealth, 60000);
