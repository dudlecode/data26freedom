// Вход: фирменный тёмно-зелёный экран с водяным знаком щита, по центру карточка с формой и демо-доступом
// (клик по строке заполняет форму, Enter входит).

import { api } from '../api.js';
import { h, clear, field, icon, withBusy, replay } from '../ui.js';

const DEMO = [
  { username: 'operator', role: 'Оператор' },
  { username: 'supervisor', role: 'Супервайзер' },
  { username: 'reviewer', role: 'Проверяющий' },
  { username: 'admin', role: 'Администратор' },
];
// Пароль демо-доступа показывается только локально. На публичном сервере config.js
// задаёт demoPassword: null, и форма подставляет только логин.
const CFG = window.CQA_CONFIG || {};
const DEMO_PASSWORD = 'demoPassword' in CFG ? CFG.demoPassword : 'freedom2026';

export function mount(root, { ctx, onLogin }) {
  clear(root);
  const userIn = h('input', { class: 'input', id: 'login-user', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const passIn = h('input', { class: 'input', id: 'login-pass', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const error = h('div', { class: 'login__error', role: 'alert', 'aria-live': 'assertive' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, h('span', null, 'Войти'));

  const eye = h('button', {
    type: 'button', class: 'pw__toggle', 'aria-label': 'Показать пароль', 'aria-pressed': 'false', 'aria-controls': 'login-pass',
    onclick: () => {
      const show = passIn.type === 'password';
      passIn.type = show ? 'text' : 'password';
      eye.setAttribute('aria-pressed', String(show));
      eye.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
      eye.replaceChildren(icon(show ? 'eyeOff' : 'eye', 16));
      passIn.focus();
    },
  }, icon('eye', 16));

  const fields = h('div', { class: 'fstack login__fields' },
    field('Логин', userIn),
    field('Пароль', h('div', { class: 'pw' }, passIn, eye)));
  const form = h('form', { class: 'fstack', novalidate: true }, fields, error, submit);

  const fail = (msg, focusEl) => {
    error.textContent = msg;
    replay(fields, 'is-shake');
    if (focusEl) { focusEl.focus(); if (focusEl.select) focusEl.select(); }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    error.textContent = '';
    const username = userIn.value.trim();
    const password = passIn.value;
    if (!username || !password) {
      fail('Введите логин и пароль.', username ? passIn : userIn);
      return;
    }
    withBusy(submit, async () => {
      try {
        const r = await api.login(username, password);
        onLogin(r.user);
      } catch (err) {
        fail(err.status === 401 ? 'Неверный логин или пароль.' : (err.message || 'Вход не выполнен.'), passIn);
      }
    });
  });

  const fill = (u) => {
    userIn.value = u.username;
    error.textContent = '';
    if (DEMO_PASSWORD) { passIn.value = DEMO_PASSWORD; submit.focus(); } else { passIn.value = ''; passIn.focus(); }
  };

  const demoRows = DEMO.map((u) => h('tr', {
    tabindex: 0,
    'aria-label': `Заполнить форму: ${u.username}, ${u.role}`,
    onclick: () => fill(u),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fill(u); } },
  }, h('td', { class: 'id' }, u.username), h('td', null, u.role)));

  root.append(h('div', { class: 'login' },
    h('img', { class: 'login__mark', src: 'assets/freedom-mark.svg', alt: '', 'aria-hidden': 'true', width: 97, height: 112 }),
    h('header', { class: 'login__top' },
      h('img', { class: 'login__logo', src: 'assets/freedom-logo-light.svg', alt: 'Freedom Broker', width: 125, height: 28 }),
      h('span', { class: 'login__tag' }, 'Контроль качества')),
    h('main', { class: 'login__center' },
      h('div', { class: 'login__card' },
        h('h1', { class: 'login__title' }, 'Вход'),
        form,
        h('div', { class: 'demo' },
          h('h2', { class: 'demo__title' }, 'Демо-доступ'),
          h('div', { class: 'tbl-wrap' },
            h('table', { class: 'tbl' },
              h('thead', null, h('tr', null, h('th', null, 'Логин'), h('th', null, 'Роль'))),
              h('tbody', null, demoRows))),
          DEMO_PASSWORD ? h('p', { class: 'demo__note' }, `Пароль: ${DEMO_PASSWORD}`) : null))),
    h('footer', { class: 'login__bottom' }, h('span', null, '© 2026 Freedom Broker'))));

  setTimeout(() => userIn.focus(), 0);
  ctx.setTitle('Вход');
}
