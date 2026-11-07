/*
 * Оболочка приложения: вход, hash-роутер, сайдбар со счётчиками, системные баннеры.
 *
 * Каждое представление (js/views/*.js) экспортирует
 *     mount(container, { params, query, ctx }) -> cleanup | undefined | Promise<cleanup>
 * и рисует себя только внутри переданного контейнера, поэтому любое из них можно встроить
 * отдельно (HTML web resource в Dynamics 365: config.js + css/app.css + нужный view).
 * Навигация идёт через ctx.navigate(hash); в Dynamics её можно подменить своим ctx.
 */

import { api } from './api.js';
import { h, clear, icon, installTooltips, errorState, skeleton, confirmDialog, closePopover, initials, fmt } from './ui.js';
import { setUser, getUser, can } from './session.js';

const NAV = [
  { id: 'dialogs', href: '#/dialogs', label: 'Диалоги', icon: 'dialogs' },
  { id: 'appeals', href: '#/appeals', label: 'Апелляции', icon: 'appeals' },
  { id: 'gross', href: '#/gross', label: 'Грубые ошибки', icon: 'gross' },
  { id: 'checklists', href: '#/checklists', label: 'Чек-листы', icon: 'checklists' },
  { id: 'calibration', href: '#/calibration', label: 'Калибровка', icon: 'calibration' },
  { id: 'settings', href: '#/settings', label: 'Настройки', icon: 'settings' },
];

const routes = [
  { rx: /^\/dialogs$/, nav: 'dialogs', load: () => import('./views/dialogs.js'), fill: true },
  { rx: /^\/dialog\/(.+)$/, nav: 'dialogs', keys: ['id'], load: () => import('./views/dialog.js'), fill: true },
  { rx: /^\/appeals$/, nav: 'appeals', load: () => import('./views/appeals.js') },
  { rx: /^\/appeal\/(.+)$/, nav: 'appeals', keys: ['id'], load: () => import('./views/appeal.js'), fill: true },
  { rx: /^\/gross$/, nav: 'gross', load: () => import('./views/gross.js') },
  { rx: /^\/checklists$/, nav: 'checklists', load: () => import('./views/checklists.js'), fill: true },
  { rx: /^\/calibration$/, nav: 'calibration', load: () => import('./views/calibration.js') },
  { rx: /^\/settings$/, nav: 'settings', load: () => import('./views/settings.js') },
];

const shell = document.getElementById('shell');
const loginRoot = document.getElementById('login-root');
const view = document.getElementById('view');
const navBox = document.getElementById('nav');
const userBox = document.getElementById('user-box');

let cleanup = null;
let renderSeq = 0;
let leaveGuard = null;
let currentHash = location.hash;
let guardPrompting = false;
let booted = false;
const counts = { dialogs: null, appeals: null, gross: null };
let skipEnter = false;

export const ctx = {
  api,
  /** instant: переход с клавиатуры, без анимации появления экрана. */
  navigate(hash, { instant = false } = {}) {
    const target = hash.startsWith('#') ? hash : `#${hash}`;
    skipEnter = !!instant;
    if (location.hash === target) render();
    else location.hash = target;
  },
  replaceQuery(query) {
    const [path] = location.hash.replace(/^#/, '').split('?');
    const q = new URLSearchParams(query).toString();
    history.replaceState(null, '', `#${path}${q ? `?${q}` : ''}`);
    currentHash = location.hash;
  },
  setLeaveGuard(fn) { leaveGuard = typeof fn === 'function' ? fn : null; },
  user: () => getUser(),
  can: (a) => can(a),
  refreshBadges: () => refreshCounts(),
  refreshHealth: () => refreshHealth(),
  setTitle(t) { document.title = t ? `${t}: контроль качества` : 'Контроль качества диалогов'; },
};

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/dialogs';
  const [path, q = ''] = raw.split('?');
  return { path: path || '/dialogs', query: Object.fromEntries(new URLSearchParams(q)) };
}

/* ---------- вход ---------- */

function rememberNext() {
  const { path } = parseHash();
  if (path !== '/login') {
    try { sessionStorage.setItem('cqa.next', location.hash || '#/dialogs'); } catch { /* ignore */ }
  }
}

function takeNext() {
  let n = null;
  try { n = sessionStorage.getItem('cqa.next'); sessionStorage.removeItem('cqa.next'); } catch { /* ignore */ }
  return n && !n.startsWith('#/login') ? n : '#/dialogs';
}

async function showLogin() {
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  leaveGuard = null;
  closePopover();
  setUser(null);
  shell.hidden = true;
  loginRoot.hidden = false;
  clear(loginRoot);
  ctx.setTitle('Вход');
  const mod = await import('./views/login.js');
  mod.mount(loginRoot, {
    ctx,
    onLogin(user) {
      setUser(user);
      enterApp(takeNext(), { intro: true });
    },
  });
}

/** Вход в оболочку. intro: показать заставку с логотипом (js/intro.js, один раз за сессию браузера). */
function enterApp(hash, { intro = false } = {}) {
  if (!intro) { showShell(hash); return; }
  import('./intro.js')
    .then((m) => {
      if (!m.shouldPlayIntro()) { showShell(hash); return; }
      m.playIntro({ onCovered: () => showShell(hash) }).then(() => {
        const a = document.activeElement;
        if (!a || a === document.body) view.focus({ preventScroll: true });
      });
    })
    .catch(() => showShell(hash));
}

function showShell(hash) {
  loginRoot.hidden = true;
  clear(loginRoot);
  shell.hidden = false;
  renderNav();
  renderUser();
  if (hash && location.hash !== hash) {
    history.replaceState(null, '', hash);
  }
  render();
  refreshHealth();
  refreshCounts();
}

window.addEventListener('cqa:unauthorized', () => {
  if (!booted || !loginRoot.hidden) return;
  rememberNext();
  history.replaceState(null, '', '#/login');
  showLogin();
});

async function logout() {
  try { await api.logout(); } catch { /* сессия всё равно закончится */ }
  try { sessionStorage.removeItem('cqa.next'); } catch { /* ignore */ }
  history.replaceState(null, '', '#/login');
  showLogin();
}

/* ---------- сайдбар ---------- */

function renderNav() {
  clear(navBox);
  for (const n of NAV) {
    const c = counts[n.id];
    navBox.append(h('a', { class: 'sb__item', href: n.href, dataset: { nav: n.id } },
      icon(n.icon, 16),
      h('span', null, n.label),
      c ? h('span', {
        class: ['count', n.id === 'appeals' && 'count--warn', n.id === 'gross' && 'count--danger'],
        'aria-label': n.id === 'appeals' ? `открытых: ${c}` : n.id === 'gross' ? `диалогов: ${c}` : `всего: ${c}`,
      }, fmt.int(c)) : null));
  }
  markNav();
}

function markNav() {
  const { path } = parseHash();
  const route = routes.find((r) => r.rx.test(path));
  for (const a of navBox.querySelectorAll('[data-nav]')) {
    if (route && a.dataset.nav === route.nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function renderUser() {
  const u = getUser();
  clear(userBox);
  if (!u) return;
  userBox.append(
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(u.display_name)),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'sb__name', title: u.display_name }, u.display_name),
      h('div', { class: 'sb__role' }, u.role_label || u.role)),
    h('button', { type: 'button', class: 'sb__logout', onclick: logout }, icon('logout', 16), h('span', null, 'Выйти')));
}

async function refreshCounts() {
  if (!getUser()) return;
  try {
    const [d, a, g] = await Promise.all([
      api.dialogs().catch(() => null), api.appeals('open').catch(() => null), api.grossErrors().catch(() => null)]);
    counts.dialogs = d && d.items ? d.items.length : null;
    counts.appeals = a && a.items ? a.items.length : null;
    counts.gross = g && g.items ? g.items.length : null;
    renderNav();
  } catch { /* счётчики необязательны */ }
}

async function refreshHealth() {
  try {
    const hlt = await api.health();
    document.getElementById('key-bar').hidden = !!(hlt && hlt.has_anthropic_key);
  } catch { /* офлайн-баннер показывает обработчик cqa:offline */ }
}

/* ---------- роутер ---------- */

async function onHashChange() {
  const target = location.hash;
  if (parseHash().path === '/login') {
    if (getUser()) { history.replaceState(null, '', currentHash || '#/dialogs'); return; }
    showLogin();
    return;
  }
  if (!getUser()) { rememberNext(); history.replaceState(null, '', '#/login'); showLogin(); return; }
  let ok = true;
  try { ok = !leaveGuard || leaveGuard(); } catch { ok = true; }
  if (!ok) {
    history.replaceState(null, '', currentHash || '#/dialogs');
    if (guardPrompting) return;
    guardPrompting = true;
    const leave = await confirmDialog({
      title: 'Изменения не сохранены',
      message: 'Изменения чек-листа будут потеряны.',
      confirmLabel: 'Уйти без сохранения',
      cancelLabel: 'Остаться',
      danger: true,
    });
    guardPrompting = false;
    if (!leave) return;
    leaveGuard = null;
    history.replaceState(null, '', target);
  }
  render();
}

async function render() {
  const seq = ++renderSeq;
  currentHash = location.hash;
  closePopover();
  const { path, query } = parseHash();
  const route = routes.find((r) => r.rx.test(path));
  if (!route) { location.replace('#/dialogs'); return; }
  const m = path.match(route.rx);
  const params = {};
  (route.keys || []).forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
  markNav();

  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  leaveGuard = null;
  const instant = skipEnter;
  skipEnter = false;
  clear(view);
  view.classList.remove('is-entering');
  view.className = route.fill ? 'view view--fill' : 'view';
  // Экран монтируется в пустой контейнер. Как только в нём появляется содержимое, оно проявляется
  // за 180 мс; скелетон показывается, только если загрузка дольше 160 мс.
  const container = h('div', { class: 'view-inner', style: { display: 'contents' } });
  const skel = h('div', { class: 'content', style: { paddingTop: '24px' } }, h('div', { class: 'panel' }, skeleton(6)));
  view.append(container);
  document.getElementById('main').scrollTop = 0;
  let revealed = false;
  const skelTimer = setTimeout(() => { if (!revealed && seq === renderSeq) view.append(skel); }, 160);
  const reveal = () => {
    if (revealed || seq !== renderSeq) return;
    revealed = true;
    clearTimeout(skelTimer);
    mo.disconnect();
    skel.remove();
    if (!instant) {
      void view.offsetWidth;
      view.classList.add('is-entering');
    }
  };
  const mo = new MutationObserver(() => { if (container.firstChild) reveal(); });
  mo.observe(container, { childList: true });

  try {
    const mod = await route.load();
    if (seq !== renderSeq) return;
    const c = await mod.mount(container, { params, query, ctx });
    if (seq !== renderSeq) { if (typeof c === 'function') c(); return; }
    cleanup = c;
    reveal();
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e && e.status === 401) return;
    console.error(e);
    clear(container);
    container.append(h('div', { class: 'content', style: { paddingTop: '24px' } }, h('div', { class: 'panel' }, errorState(e, render))));
    reveal();
  }
}

view.addEventListener('animationend', (e) => { if (e.target === view) view.classList.remove('is-entering'); });

window.addEventListener('cqa:offline', () => { document.getElementById('offline-bar').hidden = false; });
window.addEventListener('cqa:online', () => { document.getElementById('offline-bar').hidden = true; });

/* ---------- старт ---------- */

async function boot() {
  installTooltips();
  window.addEventListener('hashchange', onHashChange);
  let user = null;
  try {
    const r = await api.me();
    user = r && r.user;
  } catch {
    user = null;
  }
  booted = true;
  if (!user) {
    rememberNext();
    history.replaceState(null, '', '#/login');
    showLogin();
  } else {
    setUser(user);
    const { path } = parseHash();
    enterApp(path === '/login' ? takeNext() : (location.hash || '#/dialogs'), { intro: true });
  }
  setInterval(refreshCounts, 30000);
  setInterval(refreshHealth, 60000);
}

boot();
