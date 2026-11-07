// Калибровка: совпадение последних оценок ИИ с независимой разметкой DEV (eval/reference_dev.json).

import { api } from '../api.js';
import { h, clear, fmt, isNum, prefs, emptyState, errorState, skeleton, pageHeader, bar, shortValue, normValue, dotted, nDialogs, saveNavList } from '../ui.js';

const asPct = (x) => (isNum(x) ? (x <= 1 ? x * 100 : x) : null);
const codeOf = (cid) => String(cid).replace(/^c/, '');

export async function mount(root, { ctx }) {
  ctx.setTitle('Калибровка');
  let group = prefs.get('calibration.group', '');
  let onlyDiffs = prefs.get('calibration.onlyDiffs', true);
  const groupSel = h('select', { class: 'input input--sm', 'aria-label': 'Группа', hidden: true, onchange: () => { group = groupSel.value; prefs.set('calibration.group', group); load(); } });
  const body = h('div', { class: 'content' }, h('div', { class: 'panel' }, skeleton(8)));
  api.dialogs().then((r) => {
    const groups = [...new Set([...(r.groups || []), group].filter(Boolean))];
    clear(groupSel).append(h('option', { value: '' }, 'Все группы'), groups.map((g) => h('option', { value: g, selected: g === group }, `Группа ${g}`)));
    groupSel.value = group;
    groupSel.hidden = groups.length < 2 && !group;
  }).catch(() => {});

  root.append(
    pageHeader({
      title: 'Калибровка',
      meta: 'Сравнение с независимой разметкой DEV, не с эталоном организаторов',
      actions: [groupSel],
    }),
    body);

  async function load() {
    clear(body).append(h('div', { class: 'panel' }, skeleton(8)));
    let d;
    try {
      d = await api.calibration(group || undefined);
    } catch (e) {
      clear(body).append(h('div', { class: 'panel' }, errorState(e, load)));
      return;
    }
    clear(body);
    if (!d || !d.available) {
      body.append(h('div', { class: 'panel' }, emptyState({
        title: 'Калибровка недоступна',
        text: 'Нужны контрольная разметка на сервере и хотя бы одна завершённая оценка размеченного диалога.',
        actions: [h('a', { class: 'btn btn--primary', href: '#/dialogs' }, h('span', null, 'К диалогам'))],
      })));
      return;
    }
    if (!d.n_dialogs) {
      body.append(h('div', { class: 'panel' }, emptyState({ title: 'Нет оценённых диалогов с разметкой', text: 'Оцените диалоги группы DEV.' })));
      return;
    }

    /* сводка одной строкой */
    body.append(h('div', { class: 'headline' }, ...dotted([
      h('span', null, h('b', null, fmt.pct(asPct(d.overall_exact))), 'точное совпадение значений'),
      h('span', null, h('b', null, fmt.n2(d.total_mae)), 'средняя ошибка итога, баллов'),
      h('span', null, h('b', null, fmt.int(d.n_dialogs)), `${nDialogs(d.n_dialogs).replace(/^\S+\s/, '')} в сравнении`),
    ])));

    /* по критериям */
    const crits = Object.entries(d.by_criterion || {});
    const ctb = h('tbody');
    for (const [cid, c] of crits) {
      const p = asPct(c.exact);
      const conf = Object.entries(c.confusion || {}).map(([k, n]) => {
        const [ref, pred] = k.split(/\u2192|->/);
        return { ref, pred, n, same: normValue(ref) === normValue(pred) };
      });
      const hits = conf.filter((x) => x.same).reduce((s, x) => s + x.n, 0);
      const misses = conf.filter((x) => !x.same).sort((a, b) => b.n - a.n);
      ctb.append(h('tr', null,
        h('td', { class: 'strong q-code', style: { width: '40px' } }, codeOf(cid)),
        h('td', { class: 'q-name' }, c.name || cid),
        h('td', { class: 'q-acc' }, h('div', { class: 'acc' }, bar(p, p >= 90 ? null : p < 70 ? 'low' : 'mid'), h('span', null, fmt.pct(p)))),
        h('td', { class: 'num nowrap q-hits' }, `${fmt.int(hits)} из ${fmt.int(c.n)}`),
        h('td', { class: 'wrap q-miss' }, misses.length
          ? misses.map((x, i) => [i ? [h('span', { class: 'sep' }, '·'), '\u200B'] : null, h('span', { class: 'nowrap' }, `ИИ ${shortValue(x.pred)} вместо ${shortValue(x.ref)}: `, h('b', null, String(x.n)))])
          : h('span', { class: 't-2' }, 'Расхождений нет'))));
    }
    body.append(h('section', { class: 'tbl-wrap' },
      h('table', { class: 'tbl tbl--cards cal-cards' },
        h('thead', null, h('tr', null, h('th', null, 'Код'), h('th', null, 'Критерий'), h('th', null, 'Точность'), h('th', { class: 'num' }, 'Совпало'), h('th', null, 'Расхождения'))),
        ctb)));

    /* по диалогам */
    const all = [...(d.dialogs || [])].sort((a, b) => Math.abs((b.pred_total ?? 0) - (b.ref_total ?? 0)) - Math.abs((a.pred_total ?? 0) - (a.ref_total ?? 0)) || a.id.localeCompare(b.id));
    const withDiffs = all.filter((r) => (r.diffs || []).length || (isNum(r.pred_total) && isNum(r.ref_total) && Math.abs(r.pred_total - r.ref_total) > 0.004));
    const tableBox = h('div');
    const toggle = h('input', { type: 'checkbox', checked: onlyDiffs });
    toggle.addEventListener('change', () => { onlyDiffs = toggle.checked; prefs.set('calibration.onlyDiffs', onlyDiffs); renderDialogs(); });
    function renderDialogs() {
      clear(tableBox);
      const rows = onlyDiffs ? withDiffs : all;
      saveNavList({ ids: rows.map((r) => r.id), back: '#/calibration', label: 'Калибровка' });
      if (!rows.length) { tableBox.append(emptyState({ title: 'Расхождений нет' })); return; }
      const tbody = h('tbody');
      for (const r of rows) {
        const delta = isNum(r.pred_total) && isNum(r.ref_total) ? r.pred_total - r.ref_total : null;
        const href = `#/dialog/${encodeURIComponent(r.id)}`;
        tbody.append(h('tr', { class: 'is-link', onclick: (e) => { if (!e.target.closest('a')) ctx.navigate(href); } },
          h('td', { class: 'q-id' }, h('a', { class: 'id', href }, r.id)),
          h('td', { class: 'num q-ref', 'data-label': 'Разметка' }, fmt.n2(r.ref_total)),
          h('td', { class: 'num q-pred', 'data-label': 'ИИ' }, fmt.n2(r.pred_total)),
          // расхождение плохо в обе стороны: цвет по величине, а не по знаку
          h('td', { class: ['num', 'q-delta', delta !== null && Math.abs(delta) >= 10 && 't-danger strong', delta !== null && Math.abs(delta) >= 3 && Math.abs(delta) < 10 && 't-warn'], 'data-tip': delta === null || Math.abs(delta) < 0.005 ? null : delta > 0 ? 'ИИ выше разметки' : 'ИИ ниже разметки' }, delta === null || Math.abs(delta) < 0.005 ? '' : `${delta > 0 ? '+' : ''}${fmt.n2(delta)}`),
          h('td', { class: 'wrap q-miss' }, (r.diffs || []).length
            ? r.diffs.map((x, i) => [i ? [h('span', { class: 'sep' }, '·'), '\u200B'] : null, h('span', { class: 'nowrap' }, h('b', null, codeOf(x.cid)), ` ИИ ${shortValue(x.pred)} вместо ${shortValue(x.ref)}`)])
            : h('span', { class: 't-2' }, 'Совпадают все критерии'))));
      }
      tableBox.append(h('table', { class: 'tbl tbl--cards cal-cards' },
        h('thead', null, h('tr', null, h('th', null, 'Диалог'), h('th', { class: 'num' }, 'Разметка'), h('th', { class: 'num' }, 'ИИ'), h('th', { class: 'num' }, 'Разница'), h('th', null, 'Расхождения по критериям'))),
        tbody));
    }
    body.append(h('section', { class: 'panel' },
      h('div', { class: 'panel__head' },
        h('h2', { class: 'panel__title' }, `Диалоги с расхождениями: ${withDiffs.length} из ${all.length}`),
        h('label', { class: 'check-row t-13' }, toggle, 'Только с расхождениями')),
      tableBox));
    renderDialogs();
  }

  await load();
  return undefined;
}
