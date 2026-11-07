// Калибровка: совпадение последних оценок ИИ с контрольной разметкой команды (eval/reference_dev.json).

import { api } from '../api.js';
import { h, clear, fmt, isNum, prefs, emptyState, errorState, skeleton, pageHeader, bar, shortValue, normValue, dotted, nDialogs } from '../ui.js';

const asPct = (x) => (isNum(x) ? (x <= 1 ? x * 100 : x) : null);
const codeOf = (cid) => String(cid).replace(/^c/, '');

export async function mount(root, { ctx }) {
  ctx.setTitle('Калибровка');
  let group = prefs.get('calibration.group', '');
  let onlyDiffs = prefs.get('calibration.onlyDiffs', true);
  const groupIn = h('input', { class: 'input input--sm', value: group, placeholder: 'Все группы', 'aria-label': 'Группа', style: { width: '120px' } });
  const reload = () => { group = groupIn.value.trim(); prefs.set('calibration.group', group); load(); };
  groupIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') reload(); });
  const body = h('div', { class: 'content' }, h('div', { class: 'panel' }, skeleton(8)));

  root.append(
    pageHeader({
      title: 'Калибровка',
      meta: 'Эталон: контрольная разметка команды (eval/reference_dev.json), не эталон организаторов',
      actions: [groupIn, h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: reload }, h('span', null, 'Пересчитать'))],
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
        text: 'Нужны файл eval/reference_dev.json на сервере и хотя бы одна завершённая оценка диалога из него.',
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
        h('td', { class: 'strong', style: { width: '40px' } }, codeOf(cid)),
        h('td', null, c.name || cid),
        h('td', null, h('div', { class: 'acc' }, bar(p, p >= 90 ? null : p < 70 ? 'low' : 'mid'), h('span', null, fmt.pct(p)))),
        h('td', { class: 'num nowrap' }, `${fmt.int(hits)} из ${fmt.int(c.n)}`),
        h('td', { class: 'wrap' }, misses.length
          ? misses.map((x, i) => [i ? [h('span', { class: 'sep' }, '·'), '\u200B'] : null, h('span', { class: 'nowrap' }, `ИИ ${shortValue(x.pred)} вместо ${shortValue(x.ref)}: `, h('b', null, String(x.n)))])
          : h('span', { class: 't-2' }, 'Расхождений нет'))));
    }
    body.append(h('section', { class: 'tbl-wrap' },
      h('table', { class: 'tbl' },
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
      if (!rows.length) { tableBox.append(emptyState({ title: 'Расхождений нет' })); return; }
      const tbody = h('tbody');
      for (const r of rows) {
        const delta = isNum(r.pred_total) && isNum(r.ref_total) ? r.pred_total - r.ref_total : null;
        const href = `#/dialog/${encodeURIComponent(r.id)}`;
        tbody.append(h('tr', { class: 'is-link', onclick: (e) => { if (!e.target.closest('a')) ctx.navigate(href); } },
          h('td', null, h('a', { class: 'id', href }, r.id)),
          h('td', { class: 'num' }, fmt.n2(r.ref_total)),
          h('td', { class: 'num' }, fmt.n2(r.pred_total)),
          h('td', { class: ['num', delta > 0.004 && 'delta-up', delta < -0.004 && 'delta-down'] }, delta === null || Math.abs(delta) < 0.005 ? '' : `${delta > 0 ? '+' : ''}${fmt.n2(delta)}`),
          h('td', { class: 'wrap' }, (r.diffs || []).length
            ? r.diffs.map((x, i) => [i ? [h('span', { class: 'sep' }, '·'), '\u200B'] : null, h('span', { class: 'nowrap' }, h('b', null, codeOf(x.cid)), ` ИИ ${shortValue(x.pred)} вместо ${shortValue(x.ref)}`)])
            : h('span', { class: 't-2' }, 'Совпадают все критерии'))));
      }
      tableBox.append(h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Диалог'), h('th', { class: 'num' }, 'Эталон'), h('th', { class: 'num' }, 'ИИ'), h('th', { class: 'num' }, 'Разница'), h('th', null, 'Расхождения по критериям'))),
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
