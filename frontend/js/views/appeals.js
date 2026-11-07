// Апелляции: список с фильтром по статусу.

import { api } from '../api.js';
import { h, clear, icon, fmt, isNum, prefs, emptyState, errorState, skeleton, channelCell, normValue } from '../ui.js';

const FILTERS = [
  { value: 'open', label: 'Открытые' },
  { value: 'decided', label: 'Рассмотренные' },
  { value: 'all', label: 'Все' },
];

function shortValue(v) {
  const n = normValue(v);
  if (!n) return '—';
  return n === 'YES' ? 'Да' : n === 'NO' ? 'Нет' : n === 'NA' ? 'N/A' : n;
}

export async function mount(root, { ctx }) {
  ctx.setTitle('Апелляции');
  let status = prefs.get('appeals.filter', 'open');
  let destroyed = false;

  const seg = h('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Статус апелляций' });
  const box = h('div', { class: 'table-wrap' });
  root.append(
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title' }, 'Апелляции'),
        h('p', { class: 'page-sub' }, 'Супервайзер оспаривает оценку критерия, проверяющий подтверждает или меняет её с обоснованием. Итог диалога пересчитывается.')),
      h('div', { class: 'page-head__actions' }, seg)),
    box);

  function renderSeg() {
    clear(seg);
    for (const f of FILTERS) {
      seg.append(h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(f.value === status), class: f.value === status ? 'is-on' : '',
        onclick: () => { status = f.value; prefs.set('appeals.filter', status); renderSeg(); load(); },
      }, f.label));
    }
  }

  async function load() {
    clear(box).append(h('div', { class: 'card pad' }, skeleton(6)));
    let items;
    try {
      items = (await api.appeals(status)).items || [];
    } catch (e) {
      clear(box).append(errorState(e, load));
      return;
    }
    if (destroyed) return;
    clear(box);
    if (!items.length) {
      box.append(emptyState({
        title: status === 'open' ? 'Открытых апелляций нет' : 'Апелляций пока нет',
        text: 'Апелляцию подают из карточки диалога кнопкой «Оспорить» у нужного критерия.',
        iconName: 'gavel',
      }));
      return;
    }
    items.sort((a, b) => (a.status === b.status ? b.id - a.id : a.status === 'open' ? -1 : 1));
    const tbody = h('tbody');
    for (const a of items) {
      const href = `#/appeal/${a.id}`;
      const delta = isNum(a.total_before) && isNum(a.total_after) ? a.total_after - a.total_before : null;
      tbody.append(h('tr', { class: 'row-link', onclick: (e) => { if (!e.target.closest('a')) ctx.navigate(href); } },
        h('td', null, h('a', { class: 'id-link', href }, `№${a.id}`)),
        h('td', null, h('a', { class: 'id-link id-link--muted', href: `#/dialog/${encodeURIComponent(a.dialog_id)}?eval=${a.evaluation_id}` }, a.dialog_id),
          h('div', { class: 'cell-sub' }, a.dialog_channel ? channelCell(a.dialog_channel) : null, a.dialog_language ? h('span', { class: 'lang' }, a.dialog_language) : null)),
        h('td', null, h('div', { class: 'cell-strong' }, a.criterion_name || a.criterion_id)),
        h('td', { class: 'cell-comment' }, h('div', { class: 'clamp-2' }, a.comment || ''), h('div', { class: 'cell-sub muted' }, a.author || 'автор не указан')),
        h('td', null, a.status === 'open'
          ? h('span', { class: 'chip chip--warn' }, icon('clock', 12), 'На рассмотрении')
          : h('span', { class: ['chip', a.decision === 'changed' ? 'chip--info' : 'chip--ok'] }, icon(a.decision === 'changed' ? 'edit' : 'check', 12), a.decision === 'changed' ? 'Изменена' : 'Подтверждена')),
        h('td', null, a.status === 'decided'
          ? h('span', { class: 'value-move' }, shortValue(a.original && a.original.value), a.decision === 'changed' ? ` → ${shortValue(a.decision_value)}` : '')
          : h('span', null, shortValue(a.original && a.original.value))),
        h('td', { class: 'num' }, a.status === 'decided' && isNum(a.total_after)
          ? h('span', { class: 'value-move' }, `${fmt.n2(a.total_before)} → ${fmt.n2(a.total_after)}`, delta && Math.abs(delta) > 0.004 ? h('span', { class: delta > 0 ? 'delta-up' : 'delta-down' }, ` (${delta > 0 ? '+' : ''}${fmt.n2(delta)})`) : null)
          : h('span', { class: 'muted' }, '—')),
        h('td', null, a.ai_opinion ? h('span', { class: ['chip', a.ai_opinion.appeal_valid ? 'chip--info' : 'chip--muted'], 'data-tip': a.ai_opinion.recommendation || '' }, icon('spark', 12), a.ai_opinion.appeal_valid ? 'ИИ: обоснована' : 'ИИ: не обоснована') : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'cell-date' }, fmt.dateShort(a.decided_at || a.created_at))));
    }
    box.append(h('table', { class: 'table' },
      h('thead', null, h('tr', null,
        h('th', null, 'Номер'), h('th', null, 'Диалог'), h('th', null, 'Критерий'), h('th', null, 'Комментарий'),
        h('th', null, 'Статус'), h('th', null, 'Значение'), h('th', { class: 'num' }, 'Итог диалога'), h('th', null, 'Второе мнение'), h('th', null, 'Дата'))),
      tbody));
  }

  renderSeg();
  await load();
  return () => { destroyed = true; };
}
