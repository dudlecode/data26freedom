/*
 * Оболочка приложения: вход выбором роли, hash-роутер, сайдбар со счётчиками, смена роли,
 * палитра команд (Ctrl+K), справка по клавишам (?), системные баннеры.
 *
 * Каждое представление (js/views/*.js) экспортирует
 *     mount(container, { params, query, ctx }) -> cleanup | undefined | Promise<cleanup>
 * и рисует себя только внутри переданного контейнера, поэтому любое из них можно встроить
 * отдельно (HTML web resource в Dynamics 365: config.js + css/app.css + нужный view).
 * Навигация идёт через ctx.navigate(hash); в Dynamics её можно подменить своим ctx.
 */

import { api } from './api.js';
import {
  h, clear, icon, installTooltips, errorState, skeleton, confirmDialog, closePopover, popover, initials, fmt, prefs,
  keysBlocked, toastError, cardList, navOrigin, sheet, closeSheet, isPhone, phoneMQ,
} from './ui.js';
import { setUser, getUser, can, landing, ROLES } from './session.js';

const TEAM = ['supervisor', 'reviewer'];

/* Пункты навигации. roles: кому показывать (по умолчанию всем); count: тон счётчика;
   primary: вкладка нижней панели на телефоне, остальные в листе «Ещё»; short: подпись вкладки. */
const NAV = [
  { id: 'overview', href: '#/overview', label: 'Обзор', icon: 'overview', roles: TEAM, primary: true },
  { id: 'dialogs', href: '#/dialogs', label: 'Диалоги', operatorLabel: 'Мои диалоги', icon: 'dialogs', primary: true },
  { id: 'gross', href: '#/gross', label: 'Грубые ошибки', short: 'Ошибки', icon: 'gross', roles: TEAM, count: 'danger', primary: true },
  { id: 'appeals', href: '#/appeals', label: 'Апелляции', operatorLabel: 'Мои апелляции', icon: 'appeals', count: 'warn', primary: true },
  { divider: true },
  { id: 'checklists', href: '#/checklists', label: 'Чек-листы', icon: 'checklists' },
  { id: 'calibration', href: '#/calibration', label: 'Калибровка', icon: 'calibration', roles: TEAM },
  { id: 'settings', href: '#/settings', label: 'Настройки', icon: 'settings', roles: ['supervisor'] },
];

/** Карточка диалога подсвечивает тот раздел, из списка которого её открыли (как крошка в шапке). */
function navFromList() {
  const m = parseHash().path.match(/^\/dialog\/([^/]+)/);
  const nav = m ? cardList(decodeURIComponent(m[1]), prevPath) : null;
  return (nav && navOrigin(nav.back)) || 'dialogs';
}

/* top: экран раздела; на телефоне его название стоит в верхней панели, заголовок страницы не повторяется */
const routes = [
  { rx: /^\/overview$/, nav: 'overview', roles: TEAM, top: true, load: () => import('./views/overview.js') },
  { rx: /^\/operator\/(.+)$/, nav: 'overview', roles: TEAM, keys: ['key'], load: () => import('./views/operator.js') },
  { rx: /^\/dialogs$/, nav: 'dialogs', top: true, load: () => import('./views/dialogs.js'), fill: true },
  { rx: /^\/dialog\/(.+)\/coaching$/, nav: navFromList, keys: ['id'], load: () => import('./views/coaching.js') },
  { rx: /^\/dialog\/(.+)$/, nav: navFromList, keys: ['id'], load: () => import('./views/dialog.js'), fill: true },
  { rx: /^\/appeals$/, nav: 'appeals', top: true, load: () => import('./views/appeals.js') },
  { rx: /^\/appeal\/(.+)$/, nav: 'appeals', keys: ['id'], load: () => import('./views/appeal.js'), fill: true },
  { rx: /^\/gross$/, nav: 'gross', roles: TEAM, top: true, load: () => import('./views/gross.js') },
  { rx: /^\/checklists$/, nav: 'checklists', top: true, load: () => import('./views/checklists.js'), fill: true },
  { rx: /^\/calibration$/, nav: 'calibration', roles: TEAM, top: true, load: () => import('./views/calibration.js') },
  { rx: /^\/settings$/, nav: 'settings', roles: ['supervisor'], top: true, load: () => import('./views/settings.js') },
];

const shell = document.getElementById('shell');
const loginRoot = document.getElementById('login-root');
const view = document.getElementById('view');
const navBox = document.getElementById('nav');
const userBox = document.getElementById('user-box');
const searchBtn = document.getElementById('sb-search');
const collapseBtn = document.getElementById('sb-collapse');
const tabbar = document.getElementById('tabbar');
const tbTitle = document.getElementById('tb-title');
const tbUser = document.getElementById('tb-user');
const tbSearch = document.getElementById('tb-search');
const sbScrim = document.getElementById('sb-scrim');
/* планшет: узкая полоса с иконками, кнопка раскрывает панель поверх экрана */
const railMQ = matchMedia('(min-width: 768px) and (max-width: 1100px)');

let cleanup = null;
let renderSeq = 0;
let leaveGuard = null;
let currentHash = location.hash;
let guardPrompting = false;
let booted = false;
const counts = { appeals: null, gross: null };
let skipEnter = false;
let quickRoles = null;
let quickOperators = [];
let contextOperator = null;
const commandSets = new Set();
let palette = null;
let prevPath = '';
let curPath = '';

const AUTH_HINT = 'cqa.auth';
const setAuthHint = (on) => { try { if (on) localStorage.setItem(AUTH_HINT, '1'); else localStorage.removeItem(AUTH_HINT); } catch { /* ignore */ } };
const hasAuthHint = () => { try { return localStorage.getItem(AUTH_HINT) === '1'; } catch { return true; } };

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
    const clean = Object.fromEntries(Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const q = new URLSearchParams(clean).toString();
    history.replaceState(null, '', `#${path}${q ? `?${q}` : ''}`);
    currentHash = location.hash;
  },
  setLeaveGuard(fn) { leaveGuard = typeof fn === 'function' ? fn : null; },
  user: () => getUser(),
  can: (a) => can(a),
  refreshBadges: () => refreshCounts(),
  refreshHealth: () => refreshHealth(),
  setTitle(t) { document.title = t ? `${t}: контроль качества` : 'Контроль качества диалогов'; },
  /** Команды экрана для палитры (Ctrl+K): [{id, label, icon, hint, run}] или функция, возвращающая список. */
  registerCommands(list) {
    const entry = { list };
    commandSets.add(entry);
    return () => commandSets.delete(entry);
  },
  commands() {
    const out = [];
    for (const e of commandSets) {
      const l = typeof e.list === 'function' ? e.list() : e.list;
      if (Array.isArray(l)) out.push(...l.filter(Boolean));
    }
    return out;
  },
  openPalette: (q) => openPalette(q),
  switchRole: (role) => switchRole(role),
  quickRoles: () => quickRoles || [],
  /** Экран сообщает оператора, чей диалог открыт: смена роли на «Оператор» войдёт за него. */
  setOperatorContext(key) { contextOperator = key && key !== '_unknown' ? key : null; },
  showShortcuts: () => showShortcuts(),
  logout: () => logout(),
  navItems: () => visibleNav().filter((n) => !n.divider),
  /** Путь предыдущего экрана: список центрируется на диалоге только при возврате из карточки. */
  prevPath: () => prevPath,
};

function parseHash() {
  const fallback = landing(getUser()).slice(1);
  const raw = location.hash.replace(/^#/, '') || fallback;
  const [path, q = ''] = raw.split('?');
  return { path: path || fallback, query: Object.fromEntries(new URLSearchParams(q)) };
}

/* ---------- уход со страницы с несохранёнными изменениями ---------- */

async function confirmLeave() {
  let ok = true;
  try { ok = !leaveGuard || leaveGuard(); } catch { ok = true; }
  if (ok) return true;
  if (guardPrompting) return false;
  guardPrompting = true;
  const leave = await confirmDialog({
    title: 'Изменения не сохранены',
    message: 'Несохранённые изменения на этой странице будут потеряны.',
    confirmLabel: 'Уйти без сохранения',
    cancelLabel: 'Остаться',
    danger: true,
  });
  guardPrompting = false;
  if (leave) leaveGuard = null;
  return leave;
}

/* ---------- вход ---------- */

function rememberNext() {
  const { path } = parseHash();
  if (path !== '/login' && location.hash && location.hash !== '#/login') {
    try { sessionStorage.setItem('cqa.next', location.hash); } catch { /* ignore */ }
  }
}

function takeNext(user) {
  let n = null;
  try { n = sessionStorage.getItem('cqa.next'); sessionStorage.removeItem('cqa.next'); } catch { /* ignore */ }
  return n && !n.startsWith('#/login') ? n : landing(user);
}

async function showLogin() {
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  leaveGuard = null;
  commandSets.clear();
  closePopover();
  if (palette) { palette.close(); palette = null; }
  setUser(null);
  setAuthHint(false);
  clear(view); // экран прежнего пользователя не остаётся в DOM под окном входа
  counts.appeals = null;
  counts.gross = null;
  shell.hidden = true;
  loginRoot.hidden = false;
  clear(loginRoot);
  ctx.setTitle('Вход');
  const mod = await import('./views/login.js');
  mod.mount(loginRoot, {
    ctx,
    quick: quickRoles ? { roles: quickRoles, operators: quickOperators } : null,
    onLogin(user, info) {
      if (info) { quickRoles = info.roles || []; quickOperators = info.operators || []; }
      setUser(user);
      setAuthHint(true);
      enterApp(takeNext(user), { intro: true });
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
  if (hash && location.hash !== hash) history.replaceState(null, '', hash);
  render();
  refreshHealth();
  refreshCounts();
  if (!quickRoles) api.quickRoles().then(setQuick).catch(() => { quickRoles = []; });
}

window.addEventListener('cqa:unauthorized', () => {
  if (!booted || !loginRoot.hidden) return;
  rememberNext();
  history.replaceState(null, '', '#/login');
  showLogin();
});

function setQuick(r) {
  quickRoles = (r && r.roles) || [];
  quickOperators = (r && r.operators) || [];
  renderUser();
}

async function logout() {
  if (!(await confirmLeave())) return;
  try { await api.logout(); } catch { /* сессия всё равно закончится */ }
  try { sessionStorage.removeItem('cqa.next'); } catch { /* ignore */ }
  history.replaceState(null, '', '#/login');
  showLogin();
}

/** Смена роли без выхода: быстрый вход другой ролью, текущий экран остаётся. */
async function switchRole(role) {
  const u = getUser();
  if (u && u.role === role) return;
  if (!(await confirmLeave())) return;
  try {
    // оператором входим за оператора открытого диалога, иначе за выбранного в прошлый раз
    let key;
    if (role === 'operator' && quickOperators.length) {
      const last = prefs.get('login.operator', '');
      const known = (k) => k && quickOperators.some((o) => o.key === k);
      key = known(contextOperator) ? contextOperator : known(last) ? last : quickOperators[0].key;
    }
    const r = await api.quickLogin(role, key);
    if (key) prefs.set('login.operator', key);
    // оператор видит только свои диалоги: чужая карточка или апелляция дала бы 403, открываем «Мои диалоги»
    const { path } = parseHash();
    if (role === 'operator' && /^\/(dialog|appeal)\//.test(path) && !(key && key === contextOperator)) {
      history.replaceState(null, '', '#/dialogs');
    }
    if (palette) { palette.close(); palette = null; } // кэш диалогов палитры зависит от роли
    setUser(r.user);
    setAuthHint(true);
    renderNav();
    renderUser();
    render();
    refreshCounts();
    refreshHealth();
    import('./ui.js').then((m) => m.toast(`Вы вошли как ${r.user.role_label || r.user.role}: ${r.user.display_name}`, 'success'));
  } catch (e) {
    toastError(e, 'Роль не сменилась');
  }
}

/* ---------- сайдбар ---------- */

function visibleNav() {
  const u = getUser();
  const role = u && u.role;
  const items = NAV.filter((n) => n.divider || !n.roles || n.roles.includes(role));
  // без разделителя в начале, в конце и двух подряд
  return items.filter((n, i, a) => !n.divider || (i > 0 && i < a.length - 1 && !a[i - 1].divider));
}

function renderNav() {
  clear(navBox);
  const u = getUser();
  const operator = u && u.role === 'operator';
  for (const n of visibleNav()) {
    if (n.divider) { navBox.append(h('div', { class: 'sb__divider', role: 'separator' })); continue; }
    const c = counts[n.id];
    const label = operator && n.operatorLabel ? n.operatorLabel : n.label;
    // клик мышью не оставляет фокус на пункте: иначе после перехода по ссылке или клавишами два пункта выглядят активными
    navBox.append(h('a', { class: 'sb__item', href: n.href, dataset: { nav: n.id, tip: label }, 'aria-label': label, onclick: (e) => { if (e.detail > 0) e.currentTarget.blur(); } },
      icon(n.icon, 16),
      h('span', { class: 'sb__label' }, label),
      c ? h('span', {
        class: ['count', n.count && `count--${n.count}`],
        'aria-label': n.id === 'appeals' ? `открытых: ${c}` : `диалогов: ${c}`,
      }, fmt.int(c)) : null));
  }
  renderTabbar();
  markNav();
}

/* ---------- телефон: нижние вкладки и лист «Ещё» ---------- */

function navLabel(n) {
  const u = getUser();
  return u && u.role === 'operator' && n.operatorLabel ? n.operatorLabel : n.label;
}

/** Вкладки телефона: основные разделы роли и «Ещё» для остальных (одна лишняя вкладка встаёт сама). */
function tabItems() {
  const items = visibleNav().filter((n) => !n.divider);
  const primary = items.filter((n) => n.primary);
  const rest = items.filter((n) => !n.primary);
  return rest.length > 1 ? { tabs: primary, more: rest } : { tabs: [...primary, ...rest], more: [] };
}

function countBadge(n, cls) {
  const c = counts[n.id];
  return c ? h('span', { class: ['count', n.count && `count--${n.count}`, cls], 'aria-label': n.id === 'appeals' ? `открытых: ${c}` : `диалогов: ${c}` }, fmt.int(c)) : null;
}

function renderTabbar() {
  clear(tabbar);
  const { tabs, more } = tabItems();
  for (const n of tabs) {
    tabbar.append(h('a', { class: 'tabbar__item', href: n.href, dataset: { nav: n.id }, 'aria-label': navLabel(n) },
      h('span', { class: 'tabbar__ico' }, icon(n.icon, 20), countBadge(n, 'tabbar__count')),
      h('span', { class: 'tabbar__label' }, n.short || n.label)));
  }
  if (more.length) {
    const any = more.some((n) => counts[n.id]);
    const b = h('button', { type: 'button', class: 'tabbar__item', dataset: { more: '1' }, 'aria-haspopup': 'dialog', onclick: () => openMore() },
      h('span', { class: 'tabbar__ico' }, icon('more', 20), any ? h('span', { class: 'tabbar__dot', 'aria-hidden': 'true' }) : null),
      h('span', { class: 'tabbar__label' }, 'Ещё'));
    tabbar.append(b);
  }
}

function openMore() {
  const { more } = tabItems();
  const cur = currentNav();
  const list = h('div', { class: 'msheet' }, more.map((n) => h('a', {
    class: 'msheet__item', href: n.href, 'aria-current': n.id === cur ? 'page' : null, onclick: () => closeSheet(),
  }, icon(n.icon, 20), h('span', { class: 'msheet__label' }, navLabel(n)), countBadge(n))));
  sheet({ title: 'Разделы', content: list });
}

function currentNav() {
  const { path } = parseHash();
  const route = routes.find((r) => r.rx.test(path));
  return route ? (typeof route.nav === 'function' ? route.nav() : route.nav) : null;
}

function markNav() {
  const { path } = parseHash();
  const route = routes.find((r) => r.rx.test(path));
  const id = currentNav();
  for (const a of [...navBox.querySelectorAll('[data-nav]'), ...tabbar.querySelectorAll('[data-nav]')]) {
    if (a.dataset.nav === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const moreBtn = tabbar.querySelector('[data-more]');
  if (moreBtn) moreBtn.classList.toggle('is-current', tabItems().more.some((n) => n.id === id));
  const item = NAV.find((n) => n.id === id);
  tbTitle.textContent = item ? navLabel(item) : '';
  document.body.classList.toggle('is-top', !!(route && route.top));
  for (const logo of document.querySelectorAll('.sb__logo, .tb__logo')) logo.setAttribute('href', landing(getUser()));
}

function renderUser() {
  const u = getUser();
  clear(userBox);
  if (!u) return;
  const btn = h('button', { type: 'button', class: 'sb__userbtn', 'aria-haspopup': 'menu', 'aria-label': `${u.display_name}, ${u.role_label || u.role}. Меню пользователя` },
    h('span', { class: `avatar avatar--${u.role}`, 'aria-hidden': 'true' }, initials(u.display_name)),
    h('span', { class: 'sb__who' },
      h('span', { class: 'sb__name' }, u.display_name),
      h('span', { class: 'sb__role' }, u.role_label || u.role)),
    icon('chevronUp', 16, 'sb__userchev'));
  btn.addEventListener('click', () => openUserMenu(btn));
  userBox.append(btn);
  clear(tbUser);
  const tb = h('button', { type: 'button', class: 'tb__btn tb__avatar', 'aria-haspopup': 'dialog', 'aria-label': `${u.display_name}, ${u.role_label || u.role}. Меню пользователя` },
    h('span', { class: `avatar avatar--${u.role}`, 'aria-hidden': 'true' }, initials(u.display_name)));
  tb.addEventListener('click', () => openUserMenu(tb));
  tbUser.append(tb);
}

function openUserMenu(anchor) {
  const u = getUser();
  const roles = (quickRoles || []).length ? ROLES.filter((r) => quickRoles.includes(r.id)) : [];
  const phone = isPhone();
  const done = () => (phone ? closeSheet() : closePopover());
  const item = (label, ico, onClick, extra = {}) => h('button', {
    type: 'button', class: ['menu-item', extra.current && 'is-current'], role: 'menuitem', 'aria-current': extra.current ? 'true' : null,
    onclick: () => { done(); onClick(); },
  }, ico ? icon(ico, 16) : null, h('span', { class: 'menu-item__label' }, label), extra.hint && !phone ? h('span', { class: 'menu-item__hint' }, extra.hint) : null);
  const list = h('div', { role: 'menu', class: 'umenu' },
    roles.length ? h('div', { class: 'menu-group' }, 'Сменить роль') : null,
    roles.map((r, i) => item(r.label, r.id === u.role ? 'check' : 'user', () => switchRole(r.id), { current: r.id === u.role, hint: String(i + 1) })),
    roles.length ? h('div', { class: 'menu-sep', role: 'separator' }) : null,
    phone ? null : item('Горячие клавиши', 'keyboard', () => showShortcuts(), { hint: '?' }),
    item('Выйти', 'logout', () => logout()));
  if (phone) {
    // телефон: меню пользователя в нижнем листе, под большой палец
    sheet({ title: `${u.display_name}, ${u.role_label || u.role}`, content: list, cls: 'bsheet--menu' });
    return;
  }
  const pop = popover(anchor, list, { align: 'start', cls: 'pop--menu pop--up' });
  // меню над кнопкой: в нижнем углу сайдбара места снизу нет
  const r = anchor.getBoundingClientRect();
  pop.el.style.top = `${Math.max(8, r.top - pop.el.offsetHeight - 6)}px`;
  pop.el.style.left = `${Math.max(8, r.left)}px`;
  pop.el.style.transformOrigin = '24px 100%';
  list.addEventListener('keydown', (e) => {
    const n = Number(e.key);
    if (n >= 1 && n <= roles.length) { e.preventDefault(); closePopover(); switchRole(roles[n - 1].id); }
  });
}

/* свёрнутый сайдбар: узкая полоса с иконками, выбор запоминается */
function applyCollapsed(on) {
  document.body.classList.toggle('sb-collapsed', on);
  clear(collapseBtn).append(icon('panel', 16));
  const label = on ? 'Развернуть панель' : 'Свернуть панель';
  collapseBtn.setAttribute('aria-label', label);
  collapseBtn.dataset.tip = label;
  collapseBtn.setAttribute('aria-expanded', String(!on));
}
collapseBtn.addEventListener('click', () => {
  if (railMQ.matches) { setRailOpen(!document.body.classList.contains('sb-open')); return; }
  const on = !document.body.classList.contains('sb-collapsed');
  prefs.set('sb.collapsed', on);
  applyCollapsed(on);
});

/* планшет: полоса раскрывается поверх экрана и сворачивается после перехода, по фону и Esc */
function setRailOpen(on) {
  const open = !!on && railMQ.matches;
  document.body.classList.toggle('sb-open', open);
  sbScrim.hidden = !open;
  if (railMQ.matches) {
    clear(collapseBtn).append(icon('panel', 16));
    const label = open ? 'Свернуть панель' : 'Развернуть панель';
    collapseBtn.setAttribute('aria-label', label);
    collapseBtn.dataset.tip = label;
    collapseBtn.setAttribute('aria-expanded', String(open));
  } else applyCollapsed(!!prefs.get('sb.collapsed', false));
}
sbScrim.addEventListener('click', () => setRailOpen(false));
railMQ.addEventListener('change', () => setRailOpen(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('sb-open')) { e.preventDefault(); setRailOpen(false); collapseBtn.focus(); } });
navBox.addEventListener('click', (e) => { if (e.target.closest('a')) setRailOpen(false); });
phoneMQ.addEventListener('change', () => { closeSheet(); closePopover(); });

function renderSearch() {
  const mac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
  clear(searchBtn).append(icon('search', 16), h('span', { class: 'sb__search-label' }, 'Поиск'), h('kbd', { class: 'sb__kbd' }, mac ? '⌘ K' : 'Ctrl K'));
  searchBtn.setAttribute('aria-label', 'Поиск диалогов, операторов и команд');
  searchBtn.dataset.tip = 'Поиск';
  searchBtn.dataset.kbd = mac ? '⌘ K' : 'Ctrl K';
}
searchBtn.addEventListener('click', () => openPalette());
tbSearch.append(icon('search', 20));
tbSearch.addEventListener('click', () => openPalette());

async function refreshCounts() {
  const u = getUser();
  if (!u) return;
  try {
    const showGross = NAV.find((n) => n.id === 'gross').roles.includes(u.role);
    const mine = u.role === 'operator' && !u.operator_key ? { mine: 1 } : {};
    // лёгкий /api/nav-counts; старый сервер без него: прежние полные списки
    const c = await api.navCounts(mine).catch(() => null);
    if (c && typeof c.open_appeals === 'number') {
      counts.appeals = c.open_appeals;
      counts.gross = showGross && typeof c.gross === 'number' ? c.gross : null;
    } else {
      const [a, g] = await Promise.all([
        api.appeals('open', mine).catch(() => null),
        showGross ? api.grossErrors().catch(() => null) : null]);
      counts.appeals = a && a.items ? a.items.length : null;
      counts.gross = g && g.items ? g.items.length : null;
    }
    if (u !== getUser()) return;
    renderNav();
  } catch { /* счётчики необязательны */ }
}

async function refreshHealth() {
  try {
    const hlt = await api.health();
    document.getElementById('key-bar').hidden = !!(hlt && hlt.has_anthropic_key) || !can('manage');
  } catch { /* офлайн-баннер показывает обработчик cqa:offline */ }
}

/* ---------- палитра и справка ---------- */

async function openPalette(q) {
  if (!getUser()) return;
  if (!palette) {
    const m = await import('./palette.js');
    palette = m.createPalette(ctx);
  }
  palette.open(q);
}

async function showShortcuts() {
  const m = await import('./palette.js');
  m.showShortcuts();
}

document.addEventListener('keydown', (e) => {
  if (!getUser() || shell.hidden) return;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.code === 'KeyK' || e.key === 'k' || e.key === 'л')) {
    e.preventDefault();
    openPalette();
    return;
  }
  if (keysBlocked(e)) return;
  if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) { e.preventDefault(); showShortcuts(); }
});

/* ---------- роутер ---------- */

async function onHashChange() {
  const target = location.hash;
  if (palette) palette.close({ restore: false });
  if (parseHash().path === '/login') {
    if (getUser()) { history.replaceState(null, '', currentHash || landing(getUser())); return; }
    showLogin();
    return;
  }
  if (!getUser()) { rememberNext(); history.replaceState(null, '', '#/login'); showLogin(); return; }
  if (leaveGuard) {
    let ok = true;
    try { ok = leaveGuard(); } catch { ok = true; }
    if (!ok) {
      history.replaceState(null, '', currentHash || landing(getUser()));
      if (!(await confirmLeave())) return;
      history.replaceState(null, '', target);
    }
  }
  render();
}

async function render() {
  const seq = ++renderSeq;
  currentHash = location.hash;
  closePopover();
  const { path, query } = parseHash();
  const route = routes.find((r) => r.rx.test(path));
  if (!route) { location.replace(landing(getUser())); return; }
  if (route.roles && !route.roles.includes((getUser() || {}).role)) { history.replaceState(null, '', landing(getUser())); render(); return; }
  if (path !== curPath) { prevPath = curPath; curPath = path; }
  const m = path.match(route.rx);
  const params = {};
  (route.keys || []).forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  leaveGuard = null;
  contextOperator = null;
  commandSets.clear();
  closeSheet();
  // «Назад» в браузере и смена адреса закрывают палитру, как и нижние листы
  if (palette) palette.close({ restore: false });
  if (document.body.classList.contains('sb-open')) setRailOpen(false);
  markNav();
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
    markNav();
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
  applyCollapsed(!!prefs.get('sb.collapsed', false));
  if (railMQ.matches) setRailOpen(false);
  renderSearch();
  window.addEventListener('hashchange', onHashChange);
  let user = null;
  // публичный /api/auth/session: пользователь по cookie или токену и роли быстрого входа, без 401 в консоли
  try {
    const r = await api.session();
    user = r && r.user;
    if (r && r.quick) { quickRoles = r.quick.roles || []; quickOperators = r.quick.operators || []; }
  } catch (e) {
    // старый сервер без /api/auth/session
    const token = window.CQA_CONFIG && window.CQA_CONFIG.token;
    if (e && e.status === 404 && (hasAuthHint() || token)) {
      try { const r = await api.me(); user = r && r.user; } catch { user = null; }
    }
  }
  booted = true;
  if (!user) {
    rememberNext();
    history.replaceState(null, '', '#/login');
    showLogin();
  } else {
    setUser(user);
    setAuthHint(true);
    const { path } = parseHash();
    enterApp(path === '/login' || !location.hash ? takeNext(user) : location.hash, { intro: true });
  }
  setInterval(refreshCounts, 30000);
  setInterval(refreshHealth, 60000);
}

boot();
