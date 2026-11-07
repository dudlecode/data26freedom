// Вход: фирменный тёмно-зелёный экран, по центру выбор роли. Один клик (или клавиша с номером роли) входит
// через /api/auth/quick, пароль не нужен. Роли для быстрого входа задаёт сервер (CQA_QUICK_LOGIN_ROLES).
// Оператор выбирает себя из операторов, найденных в диалогах: дальше он видит только свои диалоги.

import { api } from '../api.js';
import { h, clear, icon, withBusy, emptyState, initials, prefs, plural, fold } from '../ui.js';
import { ROLES } from '../session.js';

const NAMES = { supervisor: 'Айгерим Сапарова', reviewer: 'Дамир Ахметов' };
const LANG = { RU: 'RU', KZ: 'KZ', EN: 'EN' };


export function mount(root, { ctx, onLogin, quick = null }) {
  clear(root);
  const error = h('div', { class: 'login__error', role: 'alert', 'aria-live': 'assertive' });
  const list = h('div', { class: 'roles', role: 'list' }, ROLES.map(() => h('div', { class: 'role role--skel', 'aria-hidden': 'true' })));
  const title = h('h1', { class: 'login__title' }, 'Выберите роль');
  const sub = h('p', { class: 'login__sub' }, 'Роль можно сменить в любой момент в меню пользователя.');
  let buttons = [];
  let info = { roles: [], operators: [] };
  let mode = 'roles';
  const keysHint = h('span', { class: 'login__keys' }, '');
  let opButtons = [];

  async function go(r, btn, operatorKey) {
    error.textContent = '';
    for (const b of [...buttons, ...opButtons]) if (b !== btn) b.disabled = true;
    await withBusy(btn, async () => {
      try {
        const res = await api.quickLogin(r.id, operatorKey);
        if (operatorKey) prefs.set('login.operator', operatorKey);
        onLogin(res.user, quickInfo());
      } catch (err) {
        error.textContent = err.status === 403 ? 'Вход этой ролью выключен на сервере.' : (err.message || 'Вход не выполнен.');
        for (const b of [...buttons, ...opButtons]) b.disabled = false;
        btn.focus();
      }
    });
  }

  const quickInfo = () => info;

  function renderRoles() {
    mode = 'roles';
    title.textContent = 'Выберите роль';
    sub.textContent = 'Роль можно сменить в любой момент в меню пользователя.';
    clear(list);
    list.className = 'roles';
    const roles = ROLES.filter((r) => (info.roles || []).includes(r.id));
    if (!roles.length) {
      list.append(emptyState({ title: 'Быстрый вход выключен на сервере', text: 'Роли для входа задаёт CQA_QUICK_LOGIN_ROLES.' }));
      keysHint.textContent = '';
      return;
    }
    const ops = info.operators || [];
    buttons = roles.map((r, i) => {
      const who = r.id === 'operator' ? (ops.length ? `Выберите себя: ${ops.length} ${plural(ops.length, 'оператор', 'оператора', 'операторов')} в данных` : 'Руслан Ибраев') : NAMES[r.id] || '';
      const b = h('button', { type: 'button', class: 'role', role: 'listitem', 'aria-label': `Войти как ${r.label}. ${r.duty}`, 'aria-keyshortcuts': String(i + 1) },
        h('span', { class: `role__avatar avatar--${r.id}`, 'aria-hidden': 'true' }, icon('user', 16)),
        h('span', { class: 'role__text' },
          h('span', { class: 'role__name' }, r.label),
          h('span', { class: 'role__duty' }, r.duty),
          h('span', { class: 'role__user' }, who)),
        h('kbd', { class: 'role__key', 'aria-hidden': 'true' }, String(i + 1)));
      b.addEventListener('click', () => (r.id === 'operator' && ops.length ? renderOperators(r) : go(r, b)));
      return b;
    });
    list.append(...buttons);
    keysHint.textContent = buttons.length > 1 ? `Клавиши 1-${buttons.length}` : 'Клавиша 1';
    setTimeout(() => { if (buttons[0] && !document.activeElement.closest('.role')) buttons[0].focus(); }, 0);
  }

  /** Оператор выбирает себя: поиск по имени, стрелки, Enter. Esc возвращает к ролям. */
  function renderOperators(role) {
    mode = 'operators';
    keysHint.textContent = 'Стрелки и Enter, Esc назад';
    title.textContent = 'Кто вы?';
    sub.textContent = 'Оператор видит только свои диалоги и оспаривает их оценки.';
    clear(list);
    list.className = 'opick';
    const ops = info.operators || [];
    const last = prefs.get('login.operator', '');
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Имя оператора', 'aria-label': 'Поиск оператора', autocomplete: 'off', spellcheck: 'false' });
    const box = h('div', { class: 'opick__list', role: 'listbox', 'aria-label': 'Операторы' });
    const back = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => { renderRoles(); setTimeout(() => buttons[0] && buttons[0].focus(), 0); } }, 'Другая роль');
    let cursor = 0;
    let shown = [];
    const paint = () => opButtons.forEach((b, i) => {
      b.classList.toggle('is-cursor', i === cursor);
      b.setAttribute('aria-selected', String(i === cursor));
    });
    const fill = () => {
      const q = fold(search.value.trim());
      shown = ops.filter((o) => !q || fold(o.name).includes(q))
        .sort((a, b) => (b.evaluated > 0) - (a.evaluated > 0) || a.name.localeCompare(b.name, 'ru'));
      if (!q && last) shown.sort((a, b) => (b.key === last) - (a.key === last));
      clear(box);
      opButtons = shown.map((o) => {
        const langs = (o.languages || []).map((l) => LANG[l] || l).join('/');
        const meta = `${o.evaluated || 0} ${plural(o.evaluated || 0, 'оценка', 'оценки', 'оценок')}${langs ? ` · ${langs}` : ''}`;
        const b = h('button', { type: 'button', class: 'opick__item', role: 'option', tabindex: '-1' },
          h('span', { class: 'avatar avatar--operator', 'aria-hidden': 'true' }, initials(o.name)),
          h('span', { class: 'opick__name' }, o.name, o.key === last ? h('span', { class: 'opick__last' }, 'в прошлый раз') : null),
          h('span', { class: 'opick__meta' }, meta));
        b.addEventListener('click', () => go(role, b, o.key));
        return b;
      });
      if (!opButtons.length) box.append(h('div', { class: 'opick__empty' }, 'Никого не нашли'));
      box.append(...opButtons);
      cursor = 0;
      paint();
    };
    search.addEventListener('input', fill);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!opButtons.length) return;
        cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + opButtons.length) % opButtons.length;
        paint();
        opButtons[cursor].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (opButtons[cursor] && !opButtons[cursor].disabled) opButtons[cursor].click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        back.click();
      }
    });
    list.append(h('div', { class: 'opick__bar' }, search, back), box);
    fill();
    setTimeout(() => search.focus(), 0);
  }

  const onKey = (e) => {
    if (!root.isConnected || root.hidden) { document.removeEventListener('keydown', onKey); return; }
    if (mode !== 'roles' || e.metaKey || e.ctrlKey || e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= buttons.length && !buttons[n - 1].disabled) { e.preventDefault(); buttons[n - 1].click(); }
  };
  document.addEventListener('keydown', onKey);

  const start = (r) => { info = { roles: r.roles || [], operators: r.operators || [] }; renderRoles(); };
  if (quick && Array.isArray(quick.roles)) start(quick);
  else {
    api.quickRoles()
      .then(start)
      .catch((e) => {
        clear(list).append(emptyState({ title: 'Сервер не ответил', text: e.message }));
      });
  }

  root.append(h('div', { class: 'login' },
    h('img', { class: 'login__mark', src: 'assets/freedom-mark.svg', alt: '', 'aria-hidden': 'true', width: 97, height: 112 }),
    h('header', { class: 'login__top' },
      h('img', { class: 'login__logo', src: 'assets/freedom-logo-light.svg', alt: 'Freedom Broker', width: 125, height: 28 }),
      h('span', { class: 'login__tag' }, 'Контроль качества диалогов')),
    h('main', { class: 'login__center' },
      h('div', { class: 'login__card' },
        title,
        sub,
        list,
        error)),
    h('footer', { class: 'login__bottom' }, h('span', null, '© 2026 Freedom Broker'), keysHint)));

  ctx.setTitle('Вход');
}
