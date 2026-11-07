// Профиль оператора: средний итог против команды, критерии с двойной полосой (оператор и отметка
// команды), его диалоги и грубые ошибки. Клик по критерию оставляет в таблице диалоги, где он нарушен.

import { api } from '../api.js';
import {
  h, clear, icon, fmt, isNum, plural, nDialogs, emptyState, errorState, skeleton, pageHeader, dotted,
  channelLabel, LANG_LABELS, saveNavList, scoreCell, keysBlocked, SPEAKERS,
} from '../ui.js';

export async function mount(root, { params, ctx }) {
  const key = params.key;
  let destroyed = false;
  let only = '';
  const back = { href: '#/overview', label: 'Обзор', kbd: 'Esc' };
  const box = h('div', { class: 'content' }, h('div', { class: 'panel' }, skeleton(8)));
  const head = h('div');
  root.append(head, box);
  head.append(pageHeader({ title: key === '_unknown' ? 'Не указано' : decodeURIComponent(key), back }));

  const onKey = (e) => { if (!keysBlocked(e) && e.key === 'Escape') { e.preventDefault(); ctx.navigate(back.href, { instant: true }); } };
  document.addEventListener('keydown', onKey);

  let d;
  try {
    d = await api.operator(key);
  } catch (e) {
    if (destroyed) return undefined;
    clear(box).append(h('div', { class: 'panel' }, e.status === 404 && /не найден/i.test(e.message)
      ? emptyState({ title: 'Оператор не найден', text: 'В оценённых диалогах нет оператора с таким именем.', actions: [h('a', { class: 'btn btn--secondary', href: '#/overview' }, h('span', null, 'К обзору'))] })
      : errorState(e, () => ctx.navigate(location.hash))));
    return () => { destroyed = true; document.removeEventListener('keydown', onKey); };
  }
  if (destroyed) return undefined;
  const s = d.summary || {};
  ctx.setTitle(d.name);

  clear(head).append(pageHeader({
    title: d.name,
    back,
    meta: dotted([
      d.languages.length ? d.languages.map((l) => LANG_LABELS[l] || l).join(', ') : null,
      nDialogs(s.dialogs || 0),
      isNum(s.rank) && isNum(s.of) && key !== '_unknown' ? h('span', { 'data-tip': 'По среднему итогу, место 1 у лучшего' }, `место ${s.rank} из ${s.of}`) : null,
      s.low_data ? h('span', { class: 't-warn', 'data-tip': 'Меньше трёх оценённых диалогов: выводы предварительные' }, 'мало данных') : null,
    ]),
  }));

  /* сводка */
  const delta = isNum(s.avg_final) && isNum(s.team_avg_final) ? s.avg_final - s.team_avg_final : null;
  const summary = h('div', { class: 'headline' }, ...dotted([
    h('span', null, h('b', { class: isNum(s.avg_final) && s.avg_final < 60 ? 't-danger' : null }, isNum(s.avg_final) ? fmt.n2(s.avg_final) : 'нет'), 'средний итог'),
    isNum(s.team_avg_final) ? h('span', null, h('b', null, fmt.n2(s.team_avg_final)), 'по команде') : null,
    delta !== null ? h('span', null, h('b', { class: delta > 0.004 ? 't-ok' : delta < -0.004 ? 't-danger' : null }, `${delta > 0 ? '+' : ''}${fmt.n2(delta)}`), 'к команде') : null,
    h('span', null, h('b', { class: s.gross ? 't-danger' : null }, fmt.int(s.gross || 0)), plural(s.gross || 0, 'грубая ошибка', 'грубые ошибки', 'грубых ошибок')),
  ]));

  /* критерии */
  const critBox = h('div', { class: 'opc' });
  const dialogsBox = h('div');
  function renderCrit() {
    clear(critBox);
    for (const c of d.criteria) {
      if (!c.applicable) {
        critBox.append(h('div', { class: 'opc__row is-na' },
          h('span', { class: 'opc__code' }, c.code), h('span', { class: 'opc__name' }, c.name),
          // ни одной оценки по критерию: он новый (нет в версии, по которой оценивали) или всегда был N/A
          c.na ? h('span', { class: 'opc__bars t-2 t-12', 'data-tip': `N/A во всех ${c.na} диалогах` }, 'всегда N/A')
            : h('span', { class: 'opc__bars t-2 t-12', 'data-tip': 'Критерия не было в версии чек-листа, по которой оценивали эти диалоги. Нужна переоценка.' }, 'не оценивался'),
          h('span'), h('span')));
        continue;
      }
      const rate = isNum(c.rate) ? c.rate : null;
      const team = isNum(c.team_rate) ? c.team_rate : null;
      const dl = isNum(c.delta) ? c.delta : (rate !== null && team !== null ? rate - team : null);
      const failed = (c.fail || 0) + (c.partial || 0);
      const row = h('button', {
        type: 'button', class: ['opc__row', only === c.criterion_id && 'is-on'], 'aria-pressed': String(only === c.criterion_id),
        disabled: !failed,
        'data-tip': failed ? `Показать диалоги, где ${c.code} нарушен` : 'Нарушений нет',
        onclick: () => { only = only === c.criterion_id ? '' : c.criterion_id; renderCrit(); renderDialogs(); },
      },
      h('span', { class: 'opc__code' }, c.code),
      h('span', { class: 'opc__name' }, c.name),
      h('span', { class: ['opc__bars', rate !== null && rate < 0.995 && 'has-loss'], 'aria-label': `оператор ${fmt.share(rate)}, команда ${fmt.share(team)}` },
        h('span', { class: 'opc__fill', style: { width: `${Math.round((rate ?? 0) * 100)}%` } }),
        team !== null ? h('span', { class: 'opc__tick', style: { left: `${Math.round(team * 100)}%` }, 'data-tip': `Команда: ${fmt.share(team)}` }) : null),
      h('span', { class: ['opc__delta', dl > 0.004 && 't-ok', dl < -0.004 && 't-danger'], 'data-tip': dl === null ? null : `Оператор ${fmt.share(rate)}, команда ${fmt.share(team)}: разница в процентных пунктах` }, dl === null || Math.abs(dl) < 0.005 ? 'как все' : `${dl > 0 ? '+' : ''}${fmt.int(dl * 100)} п.п.`),
      h('span', {
        class: ['opc__n', c.fail ? 't-danger' : 't-2'],
        'data-tip': `Выполнен в ${c.pass || 0} из ${c.applicable || 0}${c.partial ? `, частично в ${c.partial}` : ''}${c.fail ? `, нарушен в ${c.fail}` : ''}`,
      }, c.partial ? `${fmt.int((rate ?? 0) * 100)} %` : `${c.pass || 0} из ${c.applicable || 0}`));
      critBox.append(row);
    }
  }

  function renderDialogs() {
    clear(dialogsBox);
    let rows = d.dialogs.slice();
    if (only) rows = rows.filter((r) => r.failed ? r.failed.includes(only) : r.weakest_cid === only || (r.failed_cids || []).includes(only));
    const label = `Профиль: ${d.name}`;
    saveNavList({ ids: rows.map((r) => r.dialog_id), back: location.hash, label });
    if (!rows.length) {
      dialogsBox.append(emptyState({ title: only ? 'Нет диалогов с этим нарушением' : 'Диалогов нет' }));
      return;
    }
    const critName = Object.fromEntries(d.criteria.map((c) => [c.criterion_id, c]));
    const tbody = h('tbody');
    for (const r of rows) {
      const href = `#/dialog/${encodeURIComponent(r.dialog_id)}?eval=${r.evaluation_id}${r.weakest_cid ? `&crit=${encodeURIComponent(only || r.weakest_cid)}` : ''}`;
      const w = critName[r.weakest_cid];
      tbody.append(h('tr', { class: 'is-link', onclick: (e) => { if (!e.target.closest('a')) ctx.navigate(href); } },
        h('td', null, h('a', { class: 'id', href }, r.dialog_id)),
        h('td', null, r.language || ''),
        h('td', null, channelLabel(r.channel)),
        h('td', { class: 'num' }, r.gross ? h('span', { class: 'score' }, fmt.n2(r.final_total)) : scoreCell(r.total, r.final_total)),
        h('td', null, r.gross ? h('span', { class: 'sig sig--danger' }, 'Грубая') : ''),
        h('td', null, w ? h('span', { class: 'nowrap' }, h('span', { class: 'code-chip' }, w.code), ` ${w.name}`) : h('span', { class: 't-2' }, 'нет')),
        h('td', { class: 't-2 nowrap' }, fmt.when(r.finished_at))));
    }
    dialogsBox.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'Диалог'), h('th', null, 'Язык'), h('th', null, 'Канал'), h('th', { class: 'num' }, 'Итог'), h('th', null, 'Сигналы'), h('th', null, 'Слабый критерий'), h('th', null, 'Оценено'))),
      tbody)));
  }

  /* грубые ошибки */
  const grossBox = d.gross_items.length ? h('section', { class: 'panel' },
    h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title t-danger' }, 'Грубые ошибки')),
    h('ul', { class: 'rg' }, d.gross_items.map((g) => {
      const q = g.quote || (g.evidence && g.evidence[0]) || null;
      const href = `#/dialog/${encodeURIComponent(g.dialog_id)}?eval=${g.evaluation_id}${g.criterion_id ? `&crit=${encodeURIComponent(g.criterion_id)}` : ''}${q && isNum(q.idx) ? `&turn=${q.idx}` : ''}`;
      return h('li', null, h('a', { class: 'rg__item', href },
        h('span', { class: 'rg__top' }, h('b', null, g.dialog_id), q ? h('span', { class: 't-2' }, `T${q.idx + 1} ${SPEAKERS[q.speaker] || ''}`) : null),
        q && q.text ? h('span', { class: 'rg__text' }, `«${q.text}»`) : g.reason ? h('span', { class: 'rg__text' }, g.reason) : null));
    }))) : null;

  clear(box).append(
    summary,
    h('div', { class: 'op-grid' },
      h('section', { class: 'panel' },
        h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, 'По критериям'),
          h('span', { class: 'opc__legend t-12 t-2' }, h('span', { class: 'opc__sw' }), 'набрано', h('span', { class: 'opc__sw opc__sw--loss' }), 'потеряно', h('span', { class: 'opc__sw opc__sw--tick' }), 'команда')),
        critBox),
      grossBox),
    h('section', { class: 'fstack', style: { gap: '8px' } },
      h('h2', { class: 'sect__title' }, 'Диалоги'),
      dialogsBox));
  renderCrit();
  renderDialogs();

  return () => { destroyed = true; document.removeEventListener('keydown', onKey); };
}
