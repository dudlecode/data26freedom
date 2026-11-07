// Апелляции: вкладки по статусу со счётчиками и таблица. Проверяющему открытые идут старыми вперёд
// со временем ожидания, оператору показываются только его апелляции.

import { api } from '../api.js';
import { h, clear, prefs, fmt, isNum, emptyState, errorState, skeleton, pageHeader, shortValue, normValue, channelLabel, saveNavList } from '../ui.js';
import { hasRole, getUser } from '../session.js';

const TABS = [
  { value: 'open', label: 'Открытые' },
  { value: 'decided', label: 'Решённые' },
  { value: 'all', label: 'Все' },
];

function valBadge(v, label) {
  const n = normValue(v);
  if (!n) return h('span', { class: 't-2' }, 'нет');
  const tone = n === 'YES' ? 'yes' : n === 'NO' ? 'no' : n === 'NA' ? 'na' : 'none';
  return h('span', { class: `badge badge--${tone}` }, label || shortValue(v));
}


export async function mount(root, { ctx, query = {} }) {
  const operator = hasRole('operator');
  const reviewer = hasRole('reviewer');
  const me = getUser();
  ctx.setTitle(operator ? 'Мои апелляции' : 'Апелляции');
  // оператору важнее решения по его апелляциям: по умолчанию «Все», новые решения отмечены
  let tab = query.status || (operator ? 'all' : prefs.get('appeals.tab', 'open'));
  if (!TABS.some((t) => t.value === tab)) tab = 'open';
  const SEEN_KEY = `appeals.seen.${(me && (me.operator_key || me.display_name)) || 'me'}`;
  const seen = new Set(operator ? (prefs.get(SEEN_KEY, null) || []) : []);
  const firstVisit = operator && prefs.get(SEEN_KEY, null) === null;
  let items = [];
  let destroyed = false;

  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Статус апелляций' });
  const box = h('div', { class: 'tbl-wrap' }, skeleton(6));
  root.append(
    pageHeader({ title: operator ? 'Мои апелляции' : 'Апелляции', meta: operator ? (me && me.operator_key ? 'Апелляции по вашим диалогам' : 'Апелляции, которые подали вы') : reviewer ? 'Открытые идут по очереди: дольше всех ждущие сверху' : null }),
    h('div', { class: 'content' }, tabs, box));

  function renderTabs() {
    clear(tabs);
    const n = { open: items.filter((a) => a.status === 'open').length, decided: items.filter((a) => a.status === 'decided').length, all: items.length };
    for (const t of TABS) {
      tabs.append(h('button', {
        type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(t.value === tab),
        onclick: () => { tab = t.value; prefs.set('appeals.tab', tab); ctx.replaceQuery({ status: tab }); renderTabs(); renderTable(); },
      }, t.label, h('span', { class: ['count', t.value === 'open' && n.open && 'count--warn'] }, String(n[t.value]))));
    }
  }

  function renderTable() {
    clear(box);
    const rows = items.filter((a) => tab === 'all' || a.status === tab)
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
        if (a.status === 'open') return a.id - b.id;
        return b.id - a.id;
      });
    if (!rows.length) {
      box.append(emptyState({
        title: tab === 'open' ? 'Открытых апелляций нет' : 'Апелляций нет',
        text: operator ? 'Оспорить оценку можно в карточке диалога: кнопка «Оспорить оценку» в шапке или на критерии.' : 'Апелляцию подают в карточке диалога: раскройте критерий и нажмите «Подать апелляцию».',
      }));
      return;
    }
    const tbody = h('tbody');
    saveNavList({ ids: [...new Set(rows.map((a) => a.dialog_id).filter(Boolean))], back: tab === 'open' ? '#/appeals' : `#/appeals?status=${tab}`, label: operator ? 'Мои апелляции' : 'Апелляции' });
    for (const a of rows) {
      const href = `#/appeal/${a.id}`;
      const orig = a.original && a.original.value;
      const after = a.status === 'decided' ? (a.decision === 'changed' ? a.decision_value : orig) : null;
      const delta = a.status === 'decided' && isNum(a.total_after) && isNum(a.total_before) ? a.total_after - a.total_before : null;
      const fresh = operator && !firstVisit && a.status === 'decided' && !seen.has(a.id);
      const status = a.status === 'open'
        ? h('span', null, h('span', { class: 'sig sig--warn' }, 'На рассмотрении'),
          a.ai_opinion ? h('span', { class: 'sub' }, a.ai_opinion.appeal_valid ? 'ИИ: обоснована' : 'ИИ: не обоснована') : null)
        : h('span', null, h('span', { class: ['sig', a.decision === 'changed' ? 'sig--ok' : 'sig--neutral'] }, a.decision === 'changed' ? 'Изменено' : 'Подтверждено'),
          fresh ? h('span', { class: 'new-tag', 'data-tip': 'Решение пришло после вашего прошлого визита' }, 'новое') : null);
      const openTab = tab === 'open';
      tbody.append(h('tr', { class: 'is-link', onclick: (e) => { if (!e.target.closest('a')) ctx.navigate(href); } },
        h('td', { class: 'a-id' }, h('a', { class: 'id', href }, `№${a.id}`)),
        h('td', { class: 'nowrap a-dialog' }, h('a', { href: `#/dialog/${encodeURIComponent(a.dialog_id)}?eval=${a.evaluation_id}&crit=${encodeURIComponent(a.criterion_id)}` }, a.dialog_id),
          h('span', { class: 'sub' }, [a.dialog_language, a.dialog_channel && channelLabel(a.dialog_channel).toLowerCase()].filter(Boolean).join(', '))),
        h('td', { class: 'wrap appeal-crit a-crit' }, a.criterion_name || a.criterion_id,
          a.comment ? h('span', { class: 'sub appeal-comment', title: a.comment }, a.comment) : null),
        h('td', { class: 'a-val', 'data-label': openTab ? 'Оценка' : 'Было' }, valBadge(orig, a.original_value_label)),
        openTab ? null : h('td', { class: ['a-val', after === null && 'is-empty'], 'data-label': 'Стало' }, after !== null ? valBadge(after, a.decision === 'changed' ? a.decision_value_label : a.original_value_label) : h('span', { class: 't-2' }, '')),
        openTab ? null : h('td', { 'data-label': 'Итог', class: ['num', 'nowrap', 'a-val', 'a-delta', delta === null && 'is-empty', delta > 0.004 && 'delta-up', delta < -0.004 && 'delta-down'], 'data-tip': delta !== null ? `Итог диалога: было ${fmt.n2(a.total_before)}, стало ${fmt.n2(a.total_after)}` : null },
          delta === null ? '' : Math.abs(delta) < 0.005 ? h('span', { class: 't-2' }, '0') : `${delta > 0 ? '+' : ''}${fmt.n2(delta)}`),
        h('td', { class: 'nowrap a-status' }, status),
        operator ? null : h('td', { class: 'nowrap a-who', 'data-label': 'Автор' }, a.author || ''),
        openTab ? null : h('td', { class: ['nowrap', 'a-who', !a.reviewer && 'is-empty'], 'data-label': 'Проверяющий' }, a.reviewer || h('span', { class: 't-2' }, '')),
        h('td', { class: 't-2 nowrap a-when', 'data-tip': fmt.date(a.decided_at || a.created_at) },
          a.status === 'open' ? h('span', { class: Date.now() - new Date(a.created_at).getTime() > 864e5 ? 't-warn strong' : null }, `ждёт ${fmt.waited(a.created_at)}`) : fmt.when(a.decided_at || a.created_at))));
    }
    box.append(h('table', { class: 'tbl tbl--cards ap-cards' },
      h('thead', null, h('tr', null,
        h('th', null, '№'), h('th', null, 'Диалог'), h('th', null, 'Критерий и комментарий'), h('th', null, tab === 'open' ? 'Оценка' : 'Было'),
        tab === 'open' ? null : h('th', null, 'Стало'), tab === 'open' ? null : h('th', { class: 'num' }, 'Итог'),
        h('th', null, 'Статус'), operator ? null : h('th', null, 'Автор'), tab === 'open' ? null : h('th', null, 'Проверяющий'), h('th', null, 'Когда'))),
      tbody));
    // отмеченные «новое» решения считаются просмотренными со следующего визита
    if (operator) prefs.set(SEEN_KEY, items.filter((a) => a.status === 'decided').map((a) => a.id));
  }

  async function load() {
    try {
      // оператор, привязанный к своим диалогам, получает с сервера апелляции по ним; без привязки только поданные им
      const params = operator ? (me && me.operator_key ? {} : { mine: 1 }) : reviewer ? { sort: 'oldest' } : {};
      items = (await api.appeals('all', params)).items || [];
    } catch (e) {
      clear(box).append(errorState(e, load));
      return;
    }
    if (destroyed) return;
    if (tab === 'open' && !items.some((a) => a.status === 'open') && items.length && !query.status) tab = 'all';
    renderTabs();
    renderTable();
  }

  renderTabs();
  await load();
  return () => { destroyed = true; };
}
