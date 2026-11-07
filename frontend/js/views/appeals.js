// Апелляции: вкладки по статусу со счётчиками и таблица.

import { api } from '../api.js';
import { h, clear, prefs, fmt, emptyState, errorState, skeleton, pageHeader, shortValue } from '../ui.js';

const TABS = [
  { value: 'open', label: 'Открытые' },
  { value: 'decided', label: 'Решённые' },
  { value: 'all', label: 'Все' },
];

function decisionText(a) {
  if (a.status === 'open') return { text: 'На рассмотрении', cls: 't-warn strong' };
  if (a.decision === 'changed') return { text: `Изменено на «${shortValue(a.decision_value)}»`, cls: '' };
  return { text: 'Подтверждено', cls: 't-2' };
}

export async function mount(root, { ctx }) {
  ctx.setTitle('Апелляции');
  let tab = prefs.get('appeals.tab', 'open');
  let items = [];
  let destroyed = false;

  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Статус апелляций' });
  const box = h('div', { class: 'tbl-wrap' }, skeleton(6));
  root.append(
    pageHeader({ title: 'Апелляции' }),
    h('div', { class: 'content' }, tabs, box));

  function renderTabs() {
    clear(tabs);
    const n = { open: items.filter((a) => a.status === 'open').length, decided: items.filter((a) => a.status === 'decided').length, all: items.length };
    for (const t of TABS) {
      tabs.append(h('button', {
        type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(t.value === tab),
        onclick: () => { tab = t.value; prefs.set('appeals.tab', tab); renderTabs(); renderTable(); },
      }, t.label, h('span', { class: ['count', t.value === 'open' && n.open && 'count--warn'] }, String(n[t.value]))));
    }
  }

  function renderTable() {
    clear(box);
    const rows = items.filter((a) => tab === 'all' || a.status === tab)
      .sort((a, b) => (a.status === b.status ? b.id - a.id : a.status === 'open' ? -1 : 1));
    if (!rows.length) {
      box.append(emptyState({
        title: tab === 'open' ? 'Открытых апелляций нет' : 'Апелляций нет',
        text: 'Апелляцию подают в карточке диалога: раскройте критерий и опишите, почему оценка неверна.',
      }));
      return;
    }
    const tbody = h('tbody');
    for (const a of rows) {
      const href = `#/appeal/${a.id}`;
      const d = decisionText(a);
      const orig = a.original && a.original.value;
      tbody.append(h('tr', { class: 'is-link', onclick: (e) => { if (!e.target.closest('a')) ctx.navigate(href); } },
        h('td', null, h('a', { class: 'id', href }, `№${a.id}`)),
        h('td', { class: 'nowrap' }, h('a', { href: `#/dialog/${encodeURIComponent(a.dialog_id)}?eval=${a.evaluation_id}` }, a.dialog_id),
          h('span', { class: 'sub' }, [a.dialog_language, a.dialog_channel && (/call|voice/i.test(a.dialog_channel) ? 'звонок' : 'чат')].filter(Boolean).join(', '))),
        h('td', { class: 'wrap' }, a.criterion_name || a.criterion_id,
          a.comment ? h('span', { class: 'sub', style: { maxWidth: '230px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: a.comment }, a.comment) : null),
        h('td', null, shortValue(orig)),
        h('td', { class: [d.cls, 'nowrap'] }, d.text,
          a.status === 'decided' && a.decision === 'changed' && Number.isFinite(a.total_after)
            ? h('span', { class: 'sub' }, `итог ${fmt.n2(a.total_before)}, стал ${fmt.n2(a.total_after)}`) : null,
          a.status === 'open' && a.ai_opinion
            ? h('span', { class: 'sub' }, a.ai_opinion.appeal_valid ? 'ИИ: обоснована' : 'ИИ: не обоснована') : null),
        h('td', { class: 'nowrap' }, a.author || ''),
        h('td', { class: 'nowrap' }, a.reviewer || ''),
        h('td', { class: 't-2 nowrap' }, fmt.dateShort(a.decided_at || a.created_at))));
    }
    box.append(h('table', { class: 'tbl' },
      h('thead', null, h('tr', null,
        h('th', null, '№'), h('th', null, 'Диалог'), h('th', null, 'Критерий'), h('th', null, 'Было'),
        h('th', null, 'Решение'), h('th', null, 'Автор'), h('th', null, 'Проверяющий'), h('th', null, 'Дата'))),
      tbody));
  }

  async function load() {
    try {
      items = (await api.appeals('all')).items || [];
    } catch (e) {
      clear(box).append(errorState(e, load));
      return;
    }
    if (destroyed) return;
    if (tab === 'open' && !items.some((a) => a.status === 'open') && items.length) tab = 'all';
    renderTabs();
    renderTable();
  }

  renderTabs();
  await load();
  return () => { destroyed = true; };
}
