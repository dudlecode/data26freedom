// Калибровка: сравнение последних оценок ИИ с собственной контрольной разметкой команды (eval/reference_dev.json).

import { api } from '../api.js';
import { h, clear, icon, fmt, isNum, prefs, emptyState, errorState, skeleton, plural, normValue } from '../ui.js';

const short = (v) => {
  const n = normValue(v);
  return n === 'YES' ? 'Да' : n === 'NO' ? 'Нет' : n === 'NA' ? 'N/A' : (n || '—');
};
const asPct = (x) => (isNum(x) ? (x <= 1 ? x * 100 : x) : null);

export async function mount(root, { ctx }) {
  ctx.setTitle('Калибровка');
  let group = prefs.get('calibration.group', '');
  const groupIn = h('input', { class: 'input input--sm', value: group, placeholder: 'все группы', size: 10, 'aria-label': 'group_id' });
  const body = h('div');
  const reload = () => { group = groupIn.value.trim(); prefs.set('calibration.group', group); load(); };
  groupIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') reload(); });

  root.append(
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title' }, 'Калибровка'),
        h('p', { class: 'page-sub' }, 'Насколько оценки ИИ совпадают с собственной контрольной разметкой команды (eval/reference_dev.json, не официальная разметка организаторов): по каждому критерию и по итоговому баллу. Цифры верны только для размеченных диалогов — смотрите их число.')),
      h('div', { class: 'page-head__actions' },
        h('label', { class: 'inline-label' }, h('span', null, 'Группа'), groupIn),
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: reload }, icon('refresh', 14), h('span', null, 'Пересчитать')))),
    body);

  async function load() {
    clear(body).append(h('div', { class: 'card pad' }, skeleton(8)));
    let d;
    try {
      d = await api.calibration(group || undefined);
    } catch (e) {
      clear(body).append(errorState(e, load));
      return;
    }
    clear(body);
    if (!d || !d.available) {
      body.append(emptyState({
        title: 'Калибровка недоступна',
        text: 'Нужен файл контрольной разметки команды eval/reference_dev.json на сервере и хотя бы одна завершённая оценка диалогов из него. Оцените диалоги группы DEV и вернитесь сюда.',
        iconName: 'target',
        action: h('a', { class: 'btn btn--primary', href: '#/dialogs' }, h('span', null, 'Перейти к диалогам')),
      }));
      return;
    }
    if (!d.n_dialogs) {
      body.append(emptyState({ title: 'Нет оценённых диалогов с контрольной разметкой', text: 'Оцените диалоги, для которых есть контрольная разметка команды.', iconName: 'target' }));
      return;
    }

    /* сводка */
    const exact = asPct(d.overall_exact);
    body.append(h('section', { class: 'kpi-strip kpi-strip--3' },
      h('div', { class: 'kpi' }, h('div', { class: 'kpi__value' }, fmt.pct(exact)), h('div', { class: 'kpi__label' }, 'точное совпадение значений'), h('div', { class: 'kpi__sub' }, 'по всем критериям всех диалогов')),
      h('div', { class: 'kpi' }, h('div', { class: 'kpi__value' }, fmt.n2(d.total_mae)), h('div', { class: 'kpi__label' }, 'средняя ошибка итога'), h('div', { class: 'kpi__sub' }, 'MAE в баллах из 100')),
      h('div', { class: 'kpi' }, h('div', { class: 'kpi__value' }, fmt.int(d.n_dialogs)), h('div', { class: 'kpi__label' }, `${plural(d.n_dialogs, 'диалог', 'диалога', 'диалогов')} в сравнении`), h('div', { class: 'kpi__sub' }, `по ${d.n_dialogs} ${plural(d.n_dialogs, 'размеченному диалогу', 'размеченным диалогам', 'размеченным диалогам')}, последняя оценка каждого`))));

    /* по критериям */
    const crits = Object.entries(d.by_criterion || {});
    const critCard = h('section', { class: 'card pad' }, h('h3', { class: 'card__title' }, 'Точность по критериям'));
    const list = h('div', { class: 'calib-list' });
    for (const [cid, c] of crits) {
      const p = asPct(c.exact);
      const conf = Object.entries(c.confusion || {}).sort((a, b) => b[1] - a[1]);
      list.append(h('div', { class: 'calib-row' },
        h('div', { class: 'calib-row__name' }, h('span', { class: 'crit__code' }, cid), h('span', null, c.name || cid)),
        h('div', { class: 'calib-row__bar' },
          h('div', { class: 'section-bar__track' }, h('div', { class: ['section-bar__fill', p >= 85 ? 'tone-bg-great' : p >= 70 ? 'tone-bg-good' : p >= 50 ? 'tone-bg-mid' : 'tone-bg-low'], style: { width: `${p ?? 0}%` } }))),
        h('div', { class: 'calib-row__pct' }, fmt.pct(p), h('span', { class: 'muted small' }, ` из ${c.n}`)),
        h('div', { class: 'calib-row__conf' }, conf.map(([k, n]) => {
          const [ref, pred] = k.split(/→|->/);
          const same = normValue(ref) === normValue(pred);
          return h('span', { class: ['conf-chip', same ? 'conf-chip--ok' : 'conf-chip--miss'], 'data-tip': same ? 'Совпадение с эталоном' : `Эталон: ${short(ref)}, ИИ: ${short(pred)}` },
            same ? short(ref) : `${short(ref)} → ${short(pred)}`, h('strong', null, String(n)));
        }))));
    }
    critCard.append(h('p', { class: 'muted small calib-legend' }, 'Справа — матрица ошибок: «эталон → ИИ» и число диалогов. Зелёные — совпадения.'), list);
    body.append(critCard);

    /* по диалогам */
    const rows = [...(d.dialogs || [])].sort((a, b) => Math.abs((b.pred_total ?? 0) - (b.ref_total ?? 0)) - Math.abs((a.pred_total ?? 0) - (a.ref_total ?? 0)));
    const tbody = h('tbody');
    for (const r of rows) {
      const delta = isNum(r.pred_total) && isNum(r.ref_total) ? r.pred_total - r.ref_total : null;
      const href = `#/dialog/${encodeURIComponent(r.id)}`;
      tbody.append(h('tr', { class: 'row-link', onclick: (e) => { if (!e.target.closest('a')) ctx.navigate(href); } },
        h('td', null, h('a', { class: 'id-link', href }, r.id)),
        h('td', { class: 'num' }, fmt.n2(r.ref_total)),
        h('td', { class: 'num' }, fmt.n2(r.pred_total)),
        h('td', { class: ['num', delta > 0.004 && 'delta-up', delta < -0.004 && 'delta-down'] }, delta === null ? '—' : `${delta > 0 ? '+' : ''}${fmt.n2(delta)}`),
        h('td', null, (r.diffs || []).length
          ? h('div', { class: 'diff-chips' }, r.diffs.map((x) => h('span', { class: 'conf-chip conf-chip--miss' }, h('strong', null, x.cid), ` ${short(x.ref)} → ${short(x.pred)}`)))
          : h('span', { class: 'chip chip--ok' }, icon('check', 12), 'полное совпадение'))));
    }
    body.append(h('section', { class: 'card' },
      h('div', { class: 'card__head pad-x' }, h('h3', { class: 'card__title' }, 'Диалоги'), h('span', { class: 'muted small' }, 'отсортированы по величине расхождения итога')),
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Диалог'), h('th', { class: 'num' }, 'Эталон'), h('th', { class: 'num' }, 'ИИ'), h('th', { class: 'num' }, 'Разница'), h('th', null, 'Расхождения по критериям: эталон → ИИ'))),
        tbody)));
  }

  await load();
  return undefined;
}
