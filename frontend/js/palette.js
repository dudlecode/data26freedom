// Палитра команд (Ctrl+K или ⌘K): диалог по ID, оператор, экран или действие за пару нажатий.
// Нечёткий поиск по подпоследовательности; если ничего не нашлось, запрос пробуется в другой раскладке
// («lbfkjub» находит «Диалоги»). Экраны регистрируют свои команды через ctx.registerCommands.
// Здесь же справка по горячим клавишам (?).

import { h, clear, icon, fmt, isNum, fold, channelLabel, button, reducedMotion, isTouch, isPhone } from './ui.js';
import { operatorKey } from './operators.js';
import { opName } from './api.js';
import { ROLE_LABEL } from './session.js';

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const swapLayout = (s) => {
  const ru = /[а-яё]/i.test(s);
  const [from, to] = ru ? [RU, EN] : [EN, RU];
  return [...s].map((ch) => {
    const low = ch.toLowerCase();
    const i = from.indexOf(low);
    return i < 0 ? ch : to[i];
  }).join('');
};

/** Нечёткое совпадение: подстрока лучше всего, затем подпоследовательность с бонусами за начало слова и серии. */
export function fuzzy(query, text) {
  const q = fold(query).trim();
  const t = fold(text);
  if (!q) return { score: 0, idx: [] };
  const pos = t.indexOf(q);
  if (pos >= 0) {
    const boundary = pos === 0 || /[\s\-_./·]/.test(t[pos - 1]);
    return { score: 200 + (pos === 0 ? 80 : boundary ? 40 : 0) - pos - t.length * 0.1, idx: [...Array(q.length).keys()].map((k) => pos + k) };
  }
  let score = 0;
  let ti = 0;
  let prev = -2;
  const idx = [];
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    let s = 1;
    if (found === prev + 1) s += 6;
    if (found === 0 || /[\s\-_./·]/.test(t[found - 1])) s += 8;
    score += s;
    idx.push(found);
    prev = found;
    ti = found + 1;
  }
  return { score: score - (idx[idx.length - 1] - idx[0]) * 0.3 - t.length * 0.05, idx };
}

function marked(text, idx) {
  if (!idx || !idx.length) return [text];
  const set = new Set(idx);
  const out = [];
  let buf = '';
  let on = false;
  [...text].forEach((ch, i) => {
    const m = set.has(i);
    if (m !== on) { if (buf) out.push(on ? h('b', null, buf) : buf); buf = ''; on = m; }
    buf += ch;
  });
  if (buf) out.push(on ? h('b', null, buf) : buf);
  return out;
}

const RECENT_KEY = 'cqa.recent';
function loadRecent() {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function pushRecent(item) {
  if (!item.recent) return;
  const list = loadRecent().filter((x) => x.key !== item.recent.key);
  list.unshift(item.recent);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 6))); } catch { /* ignore */ }
}

export function createPalette(ctx) {
  let dialogs = null;
  let loadedAt = 0;
  let loading = null;
  let items = [];
  let active = 0;
  let lastFocus = null;
  let fixedLayout = false;

  const input = h('input', {
    class: 'palette__input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list',
    'aria-autocomplete': 'list', 'aria-label': 'Поиск', placeholder: 'Диалог, оператор, экран или действие', spellcheck: 'false', autocomplete: 'off',
  });
  const list = h('div', { class: 'palette__list', id: 'palette-list', role: 'listbox', 'aria-label': 'Результаты' });
  const note = h('div', { class: 'palette__note', hidden: true });
  const foot = h('div', { class: 'palette__foot', 'aria-hidden': 'true' },
    h('span', null, h('kbd', null, icon('chevronUp', 12)), h('kbd', null, icon('chevronDown', 12)), ' выбор'),
    h('span', null, h('kbd', null, 'Enter'), ' открыть'),
    h('span', null, h('kbd', null, 'Esc'), ' закрыть'));
  const box = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Поиск и команды' },
    h('div', { class: 'palette__bar' }, icon('search', 16), input, h('kbd', { class: 'palette__esc' }, 'Esc'),
      h('button', { type: 'button', class: 'icon-btn palette__close', 'aria-label': 'Закрыть поиск', onclick: () => close() }, icon('close', 16))),
    note, list, foot);
  const backdrop = h('div', { class: 'palette-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } }, box);

  async function ensureDialogs() {
    if (dialogs && Date.now() - loadedAt < 30000) return dialogs;
    if (!loading) {
      loading = ctx.api.dialogs().then((r) => {
        dialogs = (r.items || []).map((d) => ({
          id: d.id, operator: opName(d.operator), language: d.language, channel: d.channel, group: d.group_id,
          score: d.latest && d.latest.status === 'done' ? (isNum(d.latest.final_total) ? d.latest.final_total : d.latest.total) : null,
          gross: !!(d.latest && d.latest.gross),
        }));
        loadedAt = Date.now();
        return dialogs;
      }).catch(() => dialogs || []).finally(() => { loading = null; });
    }
    return loading;
  }

  function staticActions() {
    const u = ctx.user();
    const acts = [];
    if (ctx.can('appeal') || ctx.can('review')) acts.push({ label: 'Открытые апелляции', icon: 'appeals', run: () => ctx.navigate('#/appeals?status=open') });
    if (ctx.can('analytics')) acts.push({ label: 'Грубые ошибки', icon: 'gross', run: () => ctx.navigate('#/gross'), hint: 'список' });
    if (ctx.can('manage')) acts.push({ label: 'Новая версия чек-листа', icon: 'plus', run: () => ctx.navigate('#/checklists?new=1') });
    for (const r of ctx.quickRoles()) {
      if (u && r === u.role) continue;
      const label = ROLE_LABEL[r] || r;
      acts.push({ label: `Сменить роль: ${label}`, icon: 'user', run: () => ctx.switchRole(r), keywords: 'войти как роль' });
    }
    if (!isTouch()) acts.push({ label: 'Горячие клавиши', icon: 'keyboard', run: () => showShortcuts(), hint: '?' });
    acts.push({ label: 'Выйти', icon: 'logout', run: () => ctx.logout() });
    return acts;
  }

  function screens() {
    const op = (ctx.user() || {}).role === 'operator';
    return ctx.navItems().map((n) => ({ ...n, label: op && n.operatorLabel ? n.operatorLabel : n.label })).map((n) => ({ label: n.label, icon: n.icon, run: () => ctx.navigate(n.href), recent: { key: `s:${n.id}`, kind: 'screen', label: n.label, href: n.href, icon: n.icon } }));
  }

  function dialogItem(d, m) {
    const href = `#/dialog/${encodeURIComponent(d.id)}`;
    return {
      label: d.id, icon: 'dialogs', idx: m && m.field === 'id' ? m.idx : null,
      meta: [d.operator && d.operator !== 'Не указано' ? d.operator : null, d.language, channelLabel(d.channel), isNum(d.score) ? fmt.n2(d.score) : 'не оценён'].filter(Boolean).join(' · '),
      danger: d.gross,
      run: () => ctx.navigate(href),
      recent: { key: `d:${d.id}`, kind: 'dialog', label: d.id, href, icon: 'dialogs', meta: d.language },
    };
  }

  function operatorsOf(ds) {
    const map = new Map();
    for (const d of ds) {
      if (!d.operator || d.operator === 'Не указано') continue;
      const k = operatorKey(d.operator);
      if (!map.has(k)) map.set(k, { key: k, name: d.operator, n: 0, langs: new Set() });
      const o = map.get(k);
      o.n += 1;
      if (d.language) o.langs.add(d.language);
    }
    return [...map.values()];
  }

  function build(qRaw) {
    const q = qRaw.trim();
    const groups = [];
    const ctxCmds = ctx.commands().map((c) => ({ ...c, icon: c.icon || 'spark' }));
    if (!q) {
      const rec = loadRecent().map((r) => ({ label: r.label, icon: r.icon || 'dialogs', meta: r.meta || '', run: () => ctx.navigate(r.href), recent: r }));
      if (rec.length) groups.push({ title: 'Недавние', items: rec });
      groups.push({ title: 'Действия', items: [...ctxCmds, ...staticActions()].slice(0, 7) });
      groups.push({ title: 'Экраны', items: screens() });
      return groups;
    }
    const scoreAll = (arr, fields) => arr.map((it) => {
      let best = null;
      for (const f of fields) {
        const v = typeof f === 'function' ? f(it) : it[f];
        if (!v) continue;
        const m = fuzzy(q, v);
        if (m && (!best || m.score > best.score)) best = { ...m, field: typeof f === 'string' ? f : 'other' };
      }
      return best ? { it, m: best } : null;
    }).filter(Boolean).sort((a, b) => b.m.score - a.m.score);

    const acts = scoreAll([...ctxCmds, ...staticActions()], ['label', 'keywords']).slice(0, 5).map(({ it, m }) => ({ ...it, idx: m.field === 'label' ? m.idx : null }));
    const scr = scoreAll(screens(), ['label']).slice(0, 4).map(({ it, m }) => ({ ...it, idx: m.idx }));
    const ds = dialogs || [];
    const dl = scoreAll(ds, ['id', 'operator']).filter((x) => x.m.score > (q.length > 2 ? 2 : 0)).slice(0, 8).map(({ it, m }) => dialogItem(it, m));
    const ops = (ctx.can('analytics') ? scoreAll(operatorsOf(ds), ['name']) : []).slice(0, 5).map(({ it, m }) => ({
      label: it.name, icon: 'user', idx: m.idx, meta: `${it.n} ${it.n === 1 ? 'диалог' : it.n < 5 ? 'диалога' : 'диалогов'} · ${[...it.langs].join(', ')}`,
      run: () => ctx.navigate(`#/operator/${encodeURIComponent(it.key)}`),
      recent: { key: `o:${it.key}`, kind: 'operator', label: it.name, href: `#/operator/${encodeURIComponent(it.key)}`, icon: 'user' },
    }));
    // точный ID диалога всегда первым
    const exact = ds.find((d) => fold(d.id) === fold(q));
    if (exact) groups.push({ title: 'Диалог', items: [dialogItem(exact, { field: 'id', idx: [...Array(exact.id.length).keys()] })] });
    if (acts.length) groups.push({ title: 'Действия', items: acts });
    if (scr.length) groups.push({ title: 'Экраны', items: scr });
    const dlRest = exact ? dl.filter((x) => x.label !== exact.id) : dl;
    if (dlRest.length) groups.push({ title: 'Диалоги', items: dlRest });
    if (ops.length) groups.push({ title: 'Операторы', items: ops });
    return groups;
  }

  function render() {
    const raw = input.value;
    let groups = build(raw);
    fixedLayout = false;
    if (raw.trim() && !groups.some((g) => g.items.length)) {
      const swapped = swapLayout(raw);
      if (swapped !== raw) {
        const alt = build(swapped);
        if (alt.some((g) => g.items.length)) { groups = alt; fixedLayout = swapped; }
      }
    }
    note.hidden = !fixedLayout;
    if (fixedLayout) clear(note).append('Раскладка исправлена: ', h('b', null, fixedLayout));
    clear(list);
    items = [];
    for (const g of groups) {
      if (!g.items.length) continue;
      const gid = `pg-${items.length}`;
      list.append(h('div', { class: 'palette__group', id: gid, role: 'presentation' }, g.title));
      for (const it of g.items) {
        const i = items.length;
        items.push(it);
        list.append(h('div', {
          class: ['palette__item', it.danger && 'is-danger'], role: 'option', id: `po-${i}`, 'aria-selected': 'false', dataset: { i },
        },
        h('span', { class: 'palette__icon' }, icon(it.icon || 'spark', 16)),
        h('span', { class: 'palette__label' }, ...marked(it.label, it.idx)),
        it.meta ? h('span', { class: 'palette__meta' }, it.meta) : null,
        it.hint ? h('kbd', { class: 'palette__hint' }, it.hint) : null));
      }
    }
    if (!items.length) {
      list.append(h('div', { class: 'palette__empty' }, loading ? 'Загрузка' : 'Ничего не найдено'));
    }
    setActive(0, false);
  }

  function setActive(i, scroll = true) {
    if (!items.length) { input.removeAttribute('aria-activedescendant'); return; }
    active = (i + items.length) % items.length;
    for (const el of list.querySelectorAll('.palette__item')) {
      const on = Number(el.dataset.i) === active;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-selected', String(on));
      if (on && scroll) el.scrollIntoView({ block: 'nearest' });
    }
    input.setAttribute('aria-activedescendant', `po-${active}`);
  }

  function runActive(i = active) {
    const it = items[i];
    if (!it) return;
    pushRecent(it);
    close({ restore: false });
    try { it.run(); } catch (e) { console.error(e); }
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); runActive(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); setActive(active + (e.shiftKey ? -1 : 1)); }
  });
  list.addEventListener('mousemove', (e) => {
    const el = e.target.closest('.palette__item');
    if (el && Number(el.dataset.i) !== active) setActive(Number(el.dataset.i), false);
  });
  list.addEventListener('click', (e) => {
    const el = e.target.closest('.palette__item');
    if (el) runActive(Number(el.dataset.i));
  });

  function open(q = '') {
    const op = (ctx.user() || {}).role === 'operator';
    input.placeholder = isPhone() ? (op ? 'Диалог или экран' : 'Диалог, оператор, экран') : op ? 'Диалог, экран или действие' : 'Диалог, оператор, экран или действие';
    if (backdrop.isConnected) { input.focus(); input.select(); return; }
    lastFocus = document.activeElement;
    document.body.append(backdrop);
    backdrop.classList.toggle('is-instant', reducedMotion());
    input.value = q || '';
    render();
    setTimeout(() => { input.focus(); input.select(); }, 0);
    ensureDialogs().then(() => { if (backdrop.isConnected) render(); });
  }

  function close({ restore = true } = {}) {
    if (!backdrop.isConnected) return;
    backdrop.parentNode.removeChild(backdrop);
    if (restore && lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
  }

  return { open, close, refresh: () => { loadedAt = 0; } };
}

/* ---------- справка по клавишам ---------- */

const KEYS = [
  ['Везде', [[['Ctrl', 'K'], 'Поиск диалога, оператора, команды'], [['?'], 'Эта справка']]],
  ['Обзор', [[['Стрелки'], 'Ячейки тепловой карты'], [['Enter'], 'Открыть критерий в карточке']]],
  ['Диалоги', [[['J', 'K'], 'Следующая и предыдущая строка'], [['Enter'], 'Открыть диалог'], [['X'], 'Выбрать строку'], [['/'], 'Поиск'], [['Esc'], 'Снять выбор']]],
  ['Карточка диалога', [[['[', ']'], 'Предыдущий и следующий диалог списка'], [['J', 'K'], 'Следующий и предыдущий критерий'], [['Enter'], 'Раскрыть критерий'], [['A'], 'Оспорить оценку критерия'], [['Esc'], 'Назад к списку']]],
  ['Формы', [[['Ctrl', 'Enter'], 'Отправить апелляцию или решение']]],
];

export function showShortcuts() {
  if (document.querySelector('dialog.dlg--keys')) return;
  const mac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
  const dlg = h('dialog', { class: 'dlg dlg--keys', 'aria-labelledby': 'keys-title' },
    h('div', { class: 'dlg__body' },
      h('h2', { class: 'dlg__title', id: 'keys-title' }, 'Горячие клавиши'),
      h('div', { class: 'keys' }, KEYS.map(([group, rows]) => h('section', { class: 'keys__group' },
        h('h3', { class: 'keys__title' }, group),
        h('dl', { class: 'keys__list' }, rows.map(([ks, text]) => [
          h('dt', null, ks.map((k) => h('kbd', null, mac && k === 'Ctrl' ? '⌘' : k))),
          h('dd', null, text)])))))),
    h('div', { class: 'dlg__foot' }, button('Закрыть', { kind: 'secondary', onClick: () => dlg.close() })));
  dlg.addEventListener('close', () => dlg.parentNode && dlg.parentNode.removeChild(dlg));
  document.body.append(dlg);
  dlg.showModal();
}
