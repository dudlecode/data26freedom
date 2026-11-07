// Грубые ошибки: диалоги, где последняя оценка (с учётом решений по апелляциям) нашла грубое нарушение.
// Один список с разделителями: диалог и итог слева, справа вид нарушения, обоснование ИИ со ссылками T#
// (открывают карточку на этой реплике) и сами слова из диалога.

import { api } from '../api.js';
import {
  h, clear, fmt, prefs, emptyState, errorState, skeleton, pageHeader, linkifyTurns, fraction,
  dotted, channelLabel, nDialogs, plural, SPEAKERS, LANG_LABELS, saveNavList, button, segmented,
} from '../ui.js';

export { violationType, reasonBody } from '../violations.js';
import { violationType, reasonBody, TYPES, FALLBACK } from '../violations.js';

export async function mount(root, { ctx, query = {} }) {
  ctx.setTitle('Грубые ошибки');
  let destroyed = false;
  let group = prefs.get('gross.group', '');
  let tab = query.tab || 'all';
  let lang = query.lang || '';
  let channel = query.channel || '';
  let langs = [];
  let chans = [];
  let items = [];
  let totalDialogs = null;
  let groups = [];

  const meta = h('span', null, 'Загрузка');
  const groupSel = h('select', { class: 'input input--sm', 'aria-label': 'Группа', onchange: () => { group = groupSel.value; prefs.set('gross.group', group); load(); } });
  const filtersBox = h('div', { class: 'ov__filters' });
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Вид нарушения' });
  const box = h('div', { class: 'glist-wrap' }, skeleton(8));
  root.append(
    pageHeader({ title: 'Грубые ошибки', meta, actions: [filtersBox, groupSel] }),
    h('div', { class: 'content' }, tabs, box));

  function renderGroups() {
    const list = [...new Set([...groups, group].filter(Boolean))];
    clear(groupSel).append(h('option', { value: '' }, 'Все группы'));
    for (const g of list) groupSel.append(h('option', { value: g, selected: g === group }, `Группа ${g}`));
    groupSel.value = group;
    groupSel.hidden = list.length < 2 && !group;
  }

  const syncUrl = () => ctx.replaceQuery({ tab: tab === 'all' ? '' : tab, lang, channel });

  /** Язык и канал как на Обзоре: сервер фильтрует /api/gross-errors теми же параметрами. */
  function renderFilters() {
    clear(filtersBox);
    const ORDER = ['RU', 'KZ', 'EN'];
    const ls = [...new Set([...langs, lang].filter(Boolean))].sort((a, b) => ((ORDER.indexOf(a) + 9) % 9) - ((ORDER.indexOf(b) + 9) % 9));
    if (ls.length > 1 || lang) {
      filtersBox.append(segmented([{ value: '', label: 'Все' }, ...ls.map((l) => ({ value: l, label: l }))], lang,
        (v) => { lang = v; syncUrl(); load(); }, { label: 'Язык' }));
    }
    const cs = [...new Set([...chans, channel].filter(Boolean))];
    if (cs.length > 1 || channel) {
      filtersBox.append(segmented([{ value: '', label: 'Все каналы' }, ...cs.map((c) => ({ value: c, label: channelLabel(c) === 'Звонок' ? 'Звонки' : 'Чаты' }))], channel,
        (v) => { channel = v; syncUrl(); load(); }, { label: 'Канал' }));
    }
  }

  function typed() {
    return items.map((it) => ({ ...it, types: it.criteria.map((c) => violationType(c.reasoning)) }));
  }

  function renderMeta() {
    clear(meta).append(...dotted([
      totalDialogs !== null ? `${nDialogs(items.length)} из ${fmt.int(totalDialogs)} оценённых` : nDialogs(items.length),
      'последняя оценка с учётом апелляций',
    ]));
  }

  function renderTabs(rows) {
    clear(tabs);
    const count = (id) => rows.filter((r) => r.types.some((t) => t.id === id)).length;
    const defs = [{ id: 'all', label: 'Все', n: rows.length }, ...TYPES.map((t) => ({ id: t.id, label: t.label, n: count(t.id) }))];
    const other = count('other');
    if (other) defs.push({ id: 'other', label: FALLBACK.label, n: other });
    if (!defs.some((d) => d.id === tab)) tab = 'all';
    for (const d of defs) {
      tabs.append(h('button', {
        type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(d.id === tab), disabled: d.id !== 'all' && !d.n,
        onclick: () => { tab = d.id; syncUrl(); renderTabs(rows); renderList(rows); },
      }, d.label, h('span', { class: ['count', d.id !== 'all' && d.n && 'count--danger'] }, String(d.n))));
    }
  }

  function cardHref(it, extra = '') {
    return `#/dialog/${encodeURIComponent(it.dialog_id)}?eval=${it.evaluation_id}${extra}`;
  }

  function renderList(rows) {
    clear(box);
    const shown = rows.filter((r) => tab === 'all' || r.types.some((t) => t.id === tab));
    saveNavList({ ids: shown.map((r) => r.dialog_id), back: location.hash.startsWith('#/gross') ? location.hash : '#/gross', label: 'Грубые ошибки' });
    if (!items.length) {
      box.append(h('div', { class: 'panel' }, emptyState({
        title: 'Грубых ошибок нет',
        text: 'Здесь появятся диалоги, где последняя оценка нашла оскорбление клиента, услугу в обход компании или раскрытие конфиденциальной информации.',
        actions: [h('a', { class: 'btn btn--secondary', href: '#/dialogs' }, h('span', null, 'К диалогам'))],
      })));
      return;
    }
    if (!shown.length) {
      box.append(h('div', { class: 'panel' }, emptyState({ title: 'Нет диалогов этого вида', actions: [button('Показать все', { onClick: () => { tab = 'all'; renderTabs(rows); renderList(rows); } })] })));
      return;
    }
    box.append(h('ul', { class: 'glist' }, shown.map(itemEl)));
  }

  function itemEl(it) {
    const href = cardHref(it);
    const li = h('li', {
      class: 'gitem',
      onclick: (e) => { if (!e.target.closest('a, button') && !String(window.getSelection() || '')) ctx.navigate(href); },
    },
    h('div', { class: 'gitem__side' },
      h('a', { class: 'gitem__id', href }, it.dialog_id),
      h('div', { class: 'gitem__meta' }, dotted([channelLabel(it.channel), h('span', { 'data-tip': LANG_LABELS[it.language] || null }, it.language || '')])),
      h('div', { class: 'gitem__score' }, 'Итог ', totalText(it))),
    h('div', { class: 'gitem__main' }, it.criteria.map((c, i) => violation(it, c, it.types[i]))));
    return li;
  }

  /** Итог без цветовой оценки: при грубой ошибке зелёный «хороший» балл вводил бы в заблуждение. */
  function totalText(it) {
    const fin = Number.isFinite(it.final_total) ? it.final_total : it.total;
    if (!Number.isFinite(fin)) return h('b', null, 'Н/П');
    const changed = Number.isFinite(it.total) && Math.abs(it.total - fin) > 0.004;
    return h('span', { 'data-tip': changed ? `Исходно ${fmt.n2(it.total)}, после апелляции ${fmt.n2(fin)}` : null },
      changed ? h('span', { class: 'score__orig' }, `${fmt.n2(it.total)} / `) : null, h('b', null, fmt.n2(fin)), h('span', { class: 't-2' }, ' из 100'));
  }

  function violation(it, c, type) {
    const byIdx = new Map((c.evidence || []).map((e) => [e.idx, e]));
    const goTurn = (from) => ctx.navigate(cardHref(it, `&turn=${from}&crit=${encodeURIComponent(c.criterion_id)}`));
    const preview = (i) => {
      const e = byIdx.get(i);
      if (!e) return `T${i + 1}: открыть в карточке диалога`;
      const txt = String(e.text || '').replace(/\s+/g, ' ');
      return `T${i + 1} ${SPEAKERS[e.speaker] || e.speaker || ''}: ${txt.length > 180 ? `${txt.slice(0, 180)}…` : txt}`;
    };
    const votes = Array.isArray(c.votes) ? c.votes : [];
    const fr = fraction(c.agreement, votes.length || undefined);
    const full = fr && fr.k === fr.n;
    const quotes = (c.evidence || []).filter((e) => e && e.text);
    return h('section', { class: 'gviol' },
      h('h2', { class: 'gviol__type' }, type.label),
      c.reasoning ? h('p', { class: 'reason' }, linkifyTurns(reasonBody(c.reasoning, type), { onTurn: goTurn, preview })) : null,
      quotes.length ? h('div', { class: 'gquotes' }, quotes.map((e) => h('figure', { class: ['gquote', e.speaker === 'operator' && 'gquote--operator'] },
        h('figcaption', { class: 'gquote__head' },
          h('button', { type: 'button', class: 'tlink', 'data-tip': 'Открыть карточку на этой реплике', onclick: () => goTurn(e.idx) }, `T${e.idx + 1}`),
          h('span', null, SPEAKERS[e.speaker] || e.speaker || '')),
        h('blockquote', { class: 'gquote__text' }, e.text)))) : null,
      h('p', { class: 'gviol__foot' }, dotted([
        h('a', { href: cardHref(it, `&crit=${encodeURIComponent(c.criterion_id)}`), 'data-tip': 'Открыть критерий в карточке диалога' }, c.code ? `Критерий ${c.code}` : c.name),
        it.operator && it.operator !== 'Не указано' ? `оператор ${typeof it.operator === 'string' ? it.operator : it.operator.name}` : null,
        fr ? h('span', { class: full ? null : 't-warn strong', 'data-tip': full ? null : 'Прогоны модели разошлись, решение стоит перепроверить' }, `${fr.k} из ${fr.n} ${plural(fr.n, 'прогона', 'прогонов', 'прогонов')}`) : null,
        c.overridden ? h('span', { class: 't-warn' }, 'значение изменено решением по апелляции') : null,
      ])));
  }

  async function load() {
    clear(box).append(skeleton(8));
    let g;
    let d;
    try {
      const f = { language: lang || undefined, channel: channel || undefined };
      [g, d] = await Promise.all([api.grossErrors(group || undefined, f), api.dialogs({ group_id: group || undefined, ...f }).catch(() => null)]);
      // варианты фильтров берём из всех диалогов, а не только отфильтрованных, иначе выбранный язык прячет остальные
      if (!langs.length || !chans.length) {
        const all = lang || channel ? await api.dialogs(group ? { group_id: group } : undefined).catch(() => null) : d;
        if (all && all.items) {
          langs = [...new Set(all.items.map((x) => x.language).filter(Boolean))];
          chans = [...new Set(all.items.map((x) => x.channel).filter(Boolean))];
        }
      }
    } catch (e) {
      if (destroyed) return;
      clear(box).append(h('div', { class: 'panel' }, errorState(e, load)));
      clear(meta);
      return;
    }
    if (destroyed) return;
    items = (g.items || []).slice().sort((a, b) => a.dialog_id.localeCompare(b.dialog_id, 'ru', { numeric: true }));
    // знаменатель как на Обзоре: оценённые диалоги (неоценённый ручной импорт не в счёт)
    totalDialogs = d && d.items ? d.items.filter((x) => x.latest && x.latest.status === 'done').length : null;
    groups = (d && d.groups) || groups;
    renderGroups();
    renderFilters();
    renderMeta();
    const rows = typed();
    renderTabs(rows);
    renderList(rows);
  }

  renderGroups();
  await load();
  return () => { destroyed = true; };
}
