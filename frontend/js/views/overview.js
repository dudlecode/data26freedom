// Обзор: тепловая карта «диалог x критерий» по последним оценкам с учётом апелляций, слабые места
// команды, операторы и последние грубые ошибки. Клик по ячейке открывает карточку на этом критерии,
// порядок строк карты становится порядком «[ / ]» в карточке. Карта одна таблица, события делегированы.

import { api } from '../api.js';
import {
  h, clear, icon, fmt, isNum, plural, nDialogs, emptyState, errorState, skeleton, pageHeader, segmented, select,
  channelLabel, LANG_LABELS, saveNavList, scoreCell, bar, keysBlocked,
} from '../ui.js';
import { operatorKey } from '../operators.js';

const SORTS = [
  { value: 'worst', label: 'Худшие сверху' },
  { value: 'gross', label: 'Грубые сверху' },
  { value: 'id', label: 'По ID' },
  { value: 'operator', label: 'По оператору' },
];
const VALUE_TEXT = { YES: 'Да', NO: 'Нет', NA: 'N/A' };

export async function mount(root, { query, ctx }) {
  ctx.setTitle('Обзор');
  let destroyed = false;
  const st = {
    group: query.group || '',
    lang: query.lang || '',
    channel: query.channel || '',
    sort: query.sort || 'worst',
    col: query.col || '',
    fail: query.fail || '',
    doubt: query.doubt === '1',
    allOps: false,
  };
  let data = null;
  let reqSeq = 0;

  const meta = h('div', { class: 'ov__meta' }, 'Загрузка');
  const filtersBox = h('div', { class: 'ov__filters' });
  const kpiBox = h('div', { class: 'kpis', 'aria-live': 'polite' });
  const body = h('div', { class: 'ov' }, skeletonGrid());
  root.append(pageHeader({ title: 'Обзор', meta, actions: [filtersBox] }), h('div', { class: 'content' }, kpiBox, body));

  function syncUrl() {
    ctx.replaceQuery({
      group: st.group, lang: st.lang, channel: st.channel, sort: st.sort === 'worst' ? '' : st.sort,
      col: st.col, fail: st.fail, doubt: st.doubt ? '1' : '',
    });
  }

  function skeletonGrid() {
    return h('div', { class: 'panel ov__main' }, h('div', { class: 'panel__head' }, h('span', { class: 'panel__title' }, 'Диалоги по критериям')), skeleton(12));
  }

  /* ---------- фильтры ---------- */
  function renderFilters() {
    clear(filtersBox);
    const o = (data && data.options) || {};
    const ORDER = ['RU', 'KZ', 'EN'];
    const langs = (o.languages && o.languages.length ? o.languages : ORDER).slice().sort((a, b) => ((ORDER.indexOf(a) + 9) % 9) - ((ORDER.indexOf(b) + 9) % 9));
    filtersBox.append(segmented([{ value: '', label: 'Все' }, ...langs.map((l) => ({ value: l, label: l }))], st.lang,
      (v) => { st.lang = v; syncUrl(); load(); }, { label: 'Язык' }));
    const chans = o.channels && o.channels.length ? o.channels : ['agent chat', 'voice call'];
    if (chans.length > 1) {
      filtersBox.append(segmented([{ value: '', label: 'Все каналы' }, ...chans.map((c) => ({ value: c, label: channelLabel(c) === 'Звонок' ? 'Звонки' : 'Чаты' }))], st.channel,
        (v) => { st.channel = v; syncUrl(); load(); }, { label: 'Канал' }));
    }
    const groups = o.groups || [];
    if (groups.length > 1 || st.group) {
      filtersBox.append(select([{ value: '', label: 'Все группы' }, ...groups.map((g) => ({ value: g, label: `Группа ${g}` }))], st.group,
        { class: 'input input--sm', 'aria-label': 'Группа', onchange: (e) => { st.group = e.target.value; syncUrl(); load(); } }));
    }
  }

  /* ---------- сводка ---------- */
  function renderKpi() {
    clear(kpiBox);
    const k = data.kpi;
    const stat = (num, label, { href, tone, onClick, pressed, tip } = {}) => {
      const inner = [h('b', { class: tone ? `t-${tone}` : null }, num), ` ${label}`];
      if (href) return h('a', { class: 'kpi', href, 'data-tip': tip || null }, inner);
      if (onClick) return h('button', { type: 'button', class: 'kpi kpi--btn', 'aria-pressed': String(!!pressed), onclick: onClick, 'data-tip': tip || null }, inner);
      return h('span', { class: 'kpi', 'data-tip': tip || null }, inner);
    };
    const parts = [
      stat(fmt.int(k.evaluated), plural(k.evaluated, 'диалог оценён', 'диалога оценено', 'диалогов оценено')),
      stat(isNum(k.avg_final) ? fmt.n2(k.avg_final) : 'нет', 'средний итог', { tip: 'После решений по апелляциям' }),
      isNum(k.share_85_plus) ? stat(fmt.share(k.share_85_plus), 'с итогом 85 и выше') : null,
      stat(fmt.int(k.gross_dialogs), plural(k.gross_dialogs, 'грубая ошибка', 'грубые ошибки', 'грубых ошибок'), { href: '#/gross', tone: k.gross_dialogs ? 'danger' : null }),
      stat(fmt.int(k.open_appeals), plural(k.open_appeals, 'открытая апелляция', 'открытые апелляции', 'открытых апелляций'), { href: '#/appeals', tone: k.open_appeals ? 'warn' : null }),
      stat(fmt.int(k.split_dialogs), 'с сомнением ИИ', {
        tone: k.split_dialogs ? 'warn' : null, pressed: st.doubt,
        tip: 'Прогоны модели разошлись хотя бы по одному критерию. Нажмите, чтобы оставить в карте только их.',
        onClick: () => { st.doubt = !st.doubt; syncUrl(); renderKpi(); renderMain(); },
      }),
      k.not_evaluated ? stat(fmt.int(k.not_evaluated), 'не оценено', { href: '#/dialogs', tone: 'warn' }) : null,
    ].filter(Boolean);
    parts.forEach((p, i) => { if (i) kpiBox.append(h('span', { class: 'sep', 'aria-hidden': 'true' }, '·')); kpiBox.append(p); });
  }

  /* ---------- строки карты ---------- */
  const colById = () => Object.fromEntries(data.columns.map((c) => [c.id, c]));
  const isFail = (c, cell) => {
    if (!cell || cell.v === null || cell.v === undefined || cell.v === 'NA') return false;
    if (c.type === 'flag') return cell.v === 'YES';
    return isNum(cell.f) ? cell.f < 0.999 : cell.v === 'NO';
  };

  function shownRows() {
    const cols = colById();
    let rows = data.rows.slice();
    if (st.doubt) rows = rows.filter((r) => isNum(r.min_agreement) && r.min_agreement < 0.999);
    if (st.fail && cols[st.fail]) rows = rows.filter((r) => isFail(cols[st.fail], r.cells[st.fail]));
    const byId = (a, b) => a.dialog_id.localeCompare(b.dialog_id, 'ru', { numeric: true });
    const fin = (r) => (isNum(r.final_total) ? r.final_total : isNum(r.total) ? r.total : 101);
    if (st.col && cols[st.col]) {
      const f = (r) => { const c = r.cells[st.col]; return c && isNum(c.f) ? c.f : 2; };
      rows.sort((a, b) => f(a) - f(b) || fin(a) - fin(b) || byId(a, b));
    } else if (st.sort === 'id') rows.sort(byId);
    else if (st.sort === 'gross') rows.sort((a, b) => (b.gross ? 1 : 0) - (a.gross ? 1 : 0) || fin(a) - fin(b) || byId(a, b));
    else if (st.sort === 'operator') {
      const name = (r) => (r.operator === 'Не указано' ? '￿' : r.operator);
      rows.sort((a, b) => name(a).localeCompare(name(b), 'ru') || byId(a, b));
    } else rows.sort((a, b) => fin(a) - fin(b) || byId(a, b));
    return rows;
  }

  /* ---------- основная часть ---------- */
  let grid = null;
  let shown = [];
  let colCells = new Map();
  let cursor = { r: 0, c: 0 };
  let hoverCol = null;

  function renderMain() {
    clear(body);
    if (!data.rows.length) {
      body.append(h('div', { class: 'panel ov__main' }, emptyState({
        title: data.kpi.dialogs ? 'Нет оценённых диалогов' : 'Диалогов пока нет',
        text: data.kpi.dialogs ? `Диалогов без оценки: ${fmt.int(data.kpi.not_evaluated || data.kpi.dialogs)}. Оцените их в разделе «Диалоги».` : 'Загрузите набор в разделе «Диалоги».',
        actions: [h('a', { class: 'btn btn--primary', href: '#/dialogs' }, h('span', null, 'Открыть диалоги'))],
      })));
      return;
    }
    body.append(heatmapPanel(), h('div', { class: 'ov__side' }, weakPanel(), operatorsPanel(), grossPanel()));
  }

  function heatmapPanel() {
    const cols = data.columns;
    shown = shownRows();
    const flt = [];
    const cmap = colById();
    if (st.fail && cmap[st.fail]) flt.push(chip(`Только нарушения: ${cmap[st.fail].code} ${cmap[st.fail].name}`, () => { st.fail = ''; syncUrl(); renderMain(); }));
    if (st.doubt) flt.push(chip('ИИ сомневается', () => { st.doubt = false; syncUrl(); renderKpi(); renderMain(); }));
    if (st.col && cmap[st.col] && !st.fail) flt.push(chip(`Сортировка: ${cmap[st.col].code}`, () => { st.col = ''; syncUrl(); renderMain(); }));
    const sortSel = select(SORTS, st.sort, {
      class: 'input input--sm', 'aria-label': 'Порядок строк',
      onchange: (e) => { st.sort = e.target.value; st.col = ''; syncUrl(); renderMain(); },
    });

    /* таблица */
    colCells = new Map(cols.map((c) => [c.id, []]));
    const head = h('tr', null,
      h('th', { class: 'hm__l hm__id', scope: 'col' }, 'Диалог'),
      h('th', { class: 'hm__l hm__op', scope: 'col' }, 'Оператор'),
      h('th', { class: 'hm__l hm__score num', scope: 'col' }, 'Итог'),
      cols.map((c, ci) => {
        const sorted = st.col === c.id || st.fail === c.id;
        // колонка новой версии без оценок и изменённый вес видны прямо в шапке: строки посчитаны по своей версии
        const empty = c.evaluated === 0 && data.rows.length > 0;
        const scored = (c.scored_weights || []).map((w) => fmt.n2(w)).join(', ');
        const verTip = empty ? '\nОценок по этому критерию ещё нет: он появился в новой версии, нужна переоценка'
          : c.weight_changed ? `\nВ активной версии вес ${fmt.n2(c.weight)}, показанные оценки посчитаны с весом ${scored}` : '';
        const th = h('th', { class: ['hm__h', c.type === 'flag' && 'hm__h--flag', sorted && 'is-sorted', empty && 'is-empty', c.weight_changed && 'is-wchanged'], scope: 'col', 'aria-sort': st.col === c.id ? 'ascending' : null, dataset: { ci } },
          h('button', {
            type: 'button', class: 'hm__hbtn',
            'data-tip': `${c.code} ${c.name}${c.type === 'flag' ? ', флаг без баллов' : `, вес ${fmt.n2(c.weight)}`}${verTip}\n${st.fail === c.id ? 'Нажмите, чтобы показать все строки' : st.col === c.id ? 'Нажмите ещё раз: только нарушения' : 'Нажмите: худшие по критерию сверху'}`,
            onclick: () => headClick(c.id),
          }, h('span', { class: 'hm__code' }, c.code), h('span', { class: 'hm__w' }, c.type === 'flag' ? 'флаг' : fmt.int(c.weight))));
        colCells.get(c.id).push(th);
        return th;
      }));
    const tbody = h('tbody');
    shown.forEach((r, ri) => {
      const tr = h('tr', { dataset: { ri } },
        h('th', { class: 'hm__l hm__id', scope: 'row' }, h('a', { href: cardHref(r), class: 'hm__link', tabindex: -1 }, r.dialog_id),
          h('span', { class: 'hm__lang', 'data-tip': LANG_LABELS[r.language] || null }, r.language || '')),
        h('td', { class: ['hm__l', 'hm__op', r.operator === 'Не указано' && 't-2'] }, r.operator === 'Не указано' ? r.operator
          : h('a', { class: 'hm__oplink', href: `#/operator/${encodeURIComponent(r.operator_key || operatorKey(r.operator))}`, tabindex: -1, 'data-tip': 'Профиль оператора' }, r.operator)),
        h('td', { class: 'hm__l hm__score num' }, r.gross
          ? h('span', { class: 'score', 'data-tip': 'Есть грубая ошибка' }, fmt.n2(r.final_total))
          : scoreCell(r.total, r.final_total)));
      cols.forEach((c, ci) => {
        const cell = r.cells[c.id] || { v: null };
        const tip = cellTip(r, c, cell);
        const td = h('td', { id: `hm-${ri}-${ci}`, role: 'gridcell', 'aria-label': tip.replace(/\n/g, '. '), class: ['hm__c', `hm--${tone(c, cell)}`, cell.split && 'is-split', cell.overridden && 'is-over', appealOpen(cell) && 'is-appeal'], dataset: { ri, ci }, 'data-tip': tip });
        if (tone(c, cell) === 'partial') td.style.setProperty('--a', String(0.85 - 0.5 * Math.max(0, Math.min(1, cell.f ?? 0.5))));
        colCells.get(c.id).push(td);
        tr.append(td);
      });
      tbody.append(tr);
    });
    grid = h('table', { class: 'hm', role: 'grid', tabindex: 0, 'aria-label': 'Тепловая карта: диалоги по критериям', 'aria-rowcount': String(shown.length + 1) },
      h('thead', null, head), tbody);

    grid.addEventListener('mouseover', (e) => {
      const cell = e.target.closest('[data-ci]');
      setHoverCol(cell ? data.columns[Number(cell.dataset.ci)].id : null);
    });
    grid.addEventListener('mouseleave', () => setHoverCol(null));
    grid.addEventListener('click', (e) => {
      const td = e.target.closest('td.hm__c');
      if (td) { openCell(Number(td.dataset.ri), Number(td.dataset.ci)); return; }
      if (e.target.closest('a.hm__oplink')) return;
      const rowHead = e.target.closest('tbody tr');
      if (rowHead && !e.target.closest('a')) { e.preventDefault(); openRow(Number(rowHead.dataset.ri)); }
      else if (e.target.closest('a.hm__link')) { e.preventDefault(); openRow(Number(e.target.closest('tr').dataset.ri)); }
    });
    grid.addEventListener('keydown', onGridKey);
    grid.addEventListener('focus', () => drawCursor());
    grid.addEventListener('blur', () => drawCursor(true));
    cursor = { r: Math.min(cursor.r, Math.max(0, shown.length - 1)), c: Math.min(cursor.c, cols.length - 1) };

    const content = shown.length
      ? h('div', { class: 'hm-wrap' }, grid)
      : emptyState({ title: 'Нет диалогов под этот фильтр', actions: [h('button', { type: 'button', class: 'btn btn--secondary', onclick: () => { st.fail = ''; st.doubt = false; syncUrl(); renderKpi(); renderMain(); } }, h('span', null, 'Показать все'))] });

    return h('section', { class: 'panel ov__main', 'aria-label': 'Тепловая карта' },
      h('div', { class: 'panel__head' },
        h('div', { class: 'ov__headl' }, h('h2', { class: 'panel__title' }, 'Диалоги по критериям'), h('span', { class: 't-13 t-2' }, nDialogs(shown.length)), flt),
        sortSel),
      content,
      h('div', { class: 'hm-legend', 'aria-hidden': 'true' },
        legend('pass', 'Выполнено'), legend('partial', 'Частично'), legend('fail', 'Нет'), legend('na', 'N/A'), legend('gross', 'Грубая ошибка'),
        shown.some((r) => cols.some((c) => tone(c, r.cells[c.id]) === 'none')) ? legend('none', 'Не оценивался') : null,
        h('span', { class: 'hm-legend__i' }, h('span', { class: 'hm-legend__sw hm--pass is-split' }), 'ИИ сомневается'),
        h('span', { class: 'hm-legend__i' }, h('span', { class: 'hm-legend__sw hm--pass is-over' }), 'изменено апелляцией'),
        h('span', { class: 'hm-legend__i' }, h('span', { class: 'hm-legend__sw hm--pass is-appeal' }), 'открыта апелляция')));
  }

  function chip(text, onClear) {
    return h('span', { class: 'fchip' }, text,
      h('button', { type: 'button', class: 'fchip__x', 'aria-label': `Сбросить: ${text}`, onclick: onClear }, icon('close', 12)));
  }
  function legend(t, label) {
    return h('span', { class: 'hm-legend__i' }, h('span', { class: `hm-legend__sw hm--${t}` }), label);
  }

  function tone(c, cell) {
    if (!cell || cell.v === null || cell.v === undefined || cell.v === '') return 'none';
    if (cell.v === 'NA') return 'na';
    if (c.type === 'flag') return cell.v === 'YES' ? 'gross' : 'flagok';
    if (isNum(cell.f)) return cell.f >= 0.999 ? 'pass' : cell.f <= 0.001 ? 'fail' : 'partial';
    return cell.v === 'YES' ? 'pass' : cell.v === 'NO' ? 'fail' : 'partial';
  }

  function cellTip(r, c, cell) {
    if (!cell || cell.v === null || cell.v === undefined) return `${r.dialog_id} · ${c.code} ${c.name}\nНе оценивался: критерия нет в версии v${r.checklist_version ?? '?'}, нужна переоценка`;
    const val = VALUE_TEXT[cell.v] || (c.type === 'scale' ? `${cell.v} из ${c.max ?? ''}` : cell.v);
    const lines = [`${r.dialog_id} · ${c.code} ${c.name}`, c.type === 'flag' ? (cell.v === 'YES' ? 'Грубая ошибка' : 'Грубых ошибок нет') : `${val}${isNum(cell.pts) && isNum(cell.w) ? `, ${fmt.n2(cell.pts)} из ${fmt.n2(cell.w)}` : ''}`];
    if (cell.split) lines.push('Прогоны модели разошлись');
    if (cell.overridden) lines.push('Значение изменено решением по апелляции');
    if (appealOpen(cell)) lines.push('Апелляция на рассмотрении');
    return lines.join('\n');
  }

  function appealOpen(cell) {
    const a = cell && cell.appeal;
    return a === 'open' || !!(a && typeof a === 'object' && a.status === 'open');
  }

  function setHoverCol(cid) {
    if (cid === hoverCol) return;
    if (hoverCol && colCells.get(hoverCol)) for (const el of colCells.get(hoverCol)) el.classList.remove('is-col');
    hoverCol = cid;
    if (cid && colCells.get(cid)) for (const el of colCells.get(cid)) el.classList.add('is-col');
  }

  function headClick(cid) {
    if (st.fail === cid) { st.fail = ''; st.col = ''; }
    else if (st.col === cid) { st.fail = cid; }
    else { st.col = cid; st.fail = ''; }
    syncUrl();
    renderMain();
  }

  /* ---------- переходы ---------- */
  function cardHref(r, cid) {
    return `#/dialog/${encodeURIComponent(r.dialog_id)}?eval=${r.evaluation_id}${cid ? `&crit=${encodeURIComponent(cid)}` : ''}`;
  }
  function rememberOrder() {
    saveNavList({ ids: shown.map((r) => r.dialog_id), back: location.hash || '#/overview', label: 'Обзор' });
  }
  function openCell(ri, ci) {
    const r = shown[ri];
    const c = data.columns[ci];
    if (!r || !c) return;
    rememberOrder();
    ctx.navigate(cardHref(r, c.id));
  }
  function openRow(ri) {
    const r = shown[ri];
    if (!r) return;
    rememberOrder();
    ctx.navigate(cardHref(r));
  }

  /* ---------- клавиатура в карте ---------- */
  function drawCursor(off) {
    if (!grid) return;
    for (const el of grid.querySelectorAll('.is-cursor')) el.classList.remove('is-cursor');
    if (off || document.activeElement !== grid) { grid.removeAttribute('aria-activedescendant'); return; }
    const td = grid.querySelector(`td.hm__c[data-ri="${cursor.r}"][data-ci="${cursor.c}"]`);
    if (td) {
      td.classList.add('is-cursor');
      grid.setAttribute('aria-activedescendant', td.id); // скринридер читает подсказку ячейки под курсором
      td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      setHoverCol(data.columns[cursor.c].id);
    }
  }
  function onGridKey(e) {
    const moves = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dr, dc] = moves[e.key];
      cursor = { r: Math.max(0, Math.min(shown.length - 1, cursor.r + dr)), c: Math.max(0, Math.min(data.columns.length - 1, cursor.c + dc)) };
      drawCursor();
    } else if (e.key === 'Home') { e.preventDefault(); cursor.c = 0; drawCursor(); }
    else if (e.key === 'End') { e.preventDefault(); cursor.c = data.columns.length - 1; drawCursor(); }
    else if (e.key === 'Enter') { e.preventDefault(); openCell(cursor.r, cursor.c); }
  }

  /* ---------- слабые места ---------- */
  function weakPanel() {
    const list = data.weak_spots.filter((w) => w.applicable > 0);
    const box = h('div', { class: 'weak' });
    for (const w of list) {
      const rate = w.fail_rate || 0;
      const isFlag = w.type === 'flag' || (data.columns.find((c) => c.id === w.criterion_id) || {}).type === 'flag';
      const n = (w.fail || 0) + (w.partial || 0);
      const b = h('button', {
        type: 'button', class: ['weak__row', st.fail === w.criterion_id && 'is-on'], 'aria-pressed': String(st.fail === w.criterion_id),
        'data-tip': `${w.code} ${w.name}\nНарушений ${n} из ${w.applicable} применимых${w.partial ? `, из них частично ${w.partial}` : ''}${w.na ? `. N/A: ${w.na}` : ''}${w.low_sample ? '\nМало оценок, поэтому в конце списка' : ''}\nНажмите, чтобы оставить в карте только их`,
        onclick: () => { st.fail = st.fail === w.criterion_id ? '' : w.criterion_id; st.col = ''; syncUrl(); renderMain(); },
        onmouseenter: () => setHoverCol(w.criterion_id),
        onmouseleave: () => setHoverCol(null),
      },
      h('span', { class: 'weak__code' }, w.code),
      h('span', { class: 'weak__name' }, h('span', { class: 'weak__label' }, w.name), isFlag ? h('span', { class: 'weak__tag' }, 'грубая') : null,
        w.low_sample ? h('span', { class: 'weak__tag weak__tag--low' }, 'мало данных') : null),
      h('span', { class: 'weak__bar' }, bar(rate * 100, rate >= 0.5 ? 'low' : rate >= 0.2 ? 'mid' : null, { grow: true })),
      h('span', { class: 'weak__n' }, `${n} из ${w.applicable}`));
      box.append(b);
    }
    return h('section', { class: 'panel' },
      h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, 'Слабые места команды'), h('span', { class: 't-12 t-2' }, 'доля нарушений')),
      list.length ? box : h('p', { class: 't-2 panel__body' }, 'Нарушений нет.'));
  }

  /* ---------- операторы ---------- */
  function operatorsPanel() {
    const ops = data.operators;
    const low = ops.filter((o) => (o.dialogs || 0) < 3).length;
    const allLow = ops.length && low === ops.length;
    const LIMIT = 8;
    const list = st.allOps ? ops : ops.slice(0, LIMIT);
    const tbody = h('tbody');
    for (const o of list) {
      const href = `#/operator/${encodeURIComponent(o.key || operatorKey(o.name))}`;
      // слабый критерий подписью под именем: таблица помещается в узкую колонку без обрезанных столбцов
      const lowData = !allLow && (o.dialogs || 0) < 3;
      const sub = o.weakest
        ? h('span', { class: 'sub ops__weak', 'data-tip': `Больше всего баллов потеряно: ${o.weakest.code} ${o.weakest.name}` },
          lowData ? h('span', { class: 'ops__low' }, 'мало данных · ') : null, `${o.weakest.code} ${o.weakest.name}`)
        : lowData ? h('span', { class: 'sub ops__low' }, 'мало данных') : null;
      tbody.append(h('tr', { class: 'is-link', onclick: (e) => { if (!e.target.closest('a')) ctx.navigate(href); } },
        h('td', { class: 'clip' }, h('a', { href, class: 'id ops__name', 'data-tip': o.name.length > 16 ? o.name : null }, o.name), sub),
        h('td', { class: 'num t-2' }, fmt.int(o.dialogs)),
        h('td', { class: 'num' }, o.gross ? h('span', { class: 'score' }, fmt.n2(o.avg_final)) : scoreCell(o.avg_final, o.avg_final)),
        h('td', { class: 'num' }, o.gross ? h('span', { class: 't-danger strong', 'data-tip': 'Диалогов с грубой ошибкой' }, fmt.int(o.gross)) : '')));
    }
    if (data.unnamed && data.unnamed.dialogs) {
      const u = data.unnamed;
      tbody.append(h('tr', { class: 'is-link is-muted', onclick: () => ctx.navigate('#/operator/_unknown') },
        h('td', { class: 't-2', 'data-tip': 'Оператор не представился или имя скрыто в записи' }, 'Не указано'),
        h('td', { class: 'num t-2' }, fmt.int(u.dialogs)),
        h('td', { class: 'num t-2' }, fmt.n2(u.avg_final)),
        h('td', { class: 'num' }, u.gross ? h('span', { class: 't-danger strong' }, fmt.int(u.gross)) : '')));
    }
    return h('section', { class: 'panel' },
      h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, 'Операторы'),
        h('span', { class: 't-12 t-2', 'data-tip': allLow ? 'У каждого оператора меньше трёх оценённых диалогов' : null }, allLow ? 'мало данных, рейтинг предварительный' : 'слабые сверху')),
      ops.length || (data.unnamed && data.unnamed.dialogs)
        ? h('div', null,
          h('table', { class: 'tbl tbl--compact tbl--ops' },
            h('thead', null, h('tr', null, h('th', { 'data-tip': 'Под именем: критерий, где потеряно больше всего баллов' }, 'Оператор'), h('th', { class: 'num c-n', 'data-tip': 'Оценённых диалогов' }, 'Диал.'), h('th', { class: 'num c-score' }, 'Итог'), h('th', { class: 'num c-gross', 'data-tip': 'Диалогов с грубой ошибкой' }, 'Груб.'))),
            tbody),
          ops.length > LIMIT ? h('div', { class: 'panel__more' }, h('button', { type: 'button', class: 'link-btn t-13', onclick: () => { st.allOps = !st.allOps; renderMain(); } }, st.allOps ? 'Свернуть' : `Все операторы: ${ops.length}`)) : null)
        : h('p', { class: 't-2 panel__body' }, 'Имена операторов не найдены в диалогах.'));
  }

  /* ---------- последние грубые ---------- */
  function grossPanel() {
    const items = data.recent_gross;
    return h('section', { class: 'panel' },
      h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, 'Последние грубые ошибки'), h('a', { class: 't-13', href: '#/gross' }, 'Все')),
      items.length
        ? h('ul', { class: 'rg' }, items.map((g) => {
          const href = `#/dialog/${encodeURIComponent(g.dialog_id)}?eval=${g.evaluation_id}${g.criterion_id ? `&crit=${encodeURIComponent(g.criterion_id)}` : ''}${g.quote && isNum(g.quote.idx) ? `&turn=${g.quote.idx}` : ''}`;
          const text = g.quote && g.quote.text ? `«${g.quote.text}»` : g.reason || '';
          return h('li', null, h('a', { class: 'rg__item', href },
            h('span', { class: 'rg__top' }, h('b', null, g.dialog_id), g.operator && g.operator !== 'Не указано' ? h('span', { class: 't-2' }, g.operator) : null, h('span', { class: 'rg__time t-2' }, fmt.ago(g.finished_at))),
            g.violation && g.violation.label ? h('span', { class: 'rg__type' }, g.violation.label) : null,
            text ? h('span', { class: 'rg__text' }, text) : null));
        }))
        : h('p', { class: 't-2 panel__body' }, 'Грубых ошибок нет.'));
  }

  /* ---------- загрузка ---------- */
  async function load() {
    const seq = ++reqSeq;
    if (data) body.classList.add('is-loading');
    try {
      const r = await api.overview({ group_id: st.group || undefined, language: st.lang || undefined, channel: st.channel || undefined });
      if (destroyed || seq !== reqSeq) return;
      data = r;
    } catch (e) {
      if (destroyed || seq !== reqSeq) return;
      clear(meta);
      clear(body).append(h('div', { class: 'panel ov__main' }, errorState(e, load)));
      body.classList.remove('is-loading');
      return;
    }
    body.classList.remove('is-loading');
    clear(meta).append(...versionNote(data.checklist));
    renderFilters();
    renderKpi();
    renderMain();
  }

  /** Подпись под заголовком: по какой версии посчитаны строки и чем она отличается от активной. */
  function versionNote(cl) {
    if (!cl) return ['Последние оценки с учётом апелляций'];
    const vs = (cl.evaluated_versions || []).filter((v) => isNum(v.version));
    const scoredBy = vs.length ? vs.map((v) => `v${v.version}`).join(', ') : `v${cl.version}`;
    if (!cl.mixed) return [`Последние оценки по чек-листу ${scoredBy}, с учётом апелляций`];
    const all = vs.reduce((a, v) => a + (v.dialogs || 0), 0);
    const fresh = vs.filter((v) => v.version === cl.version).reduce((a, v) => a + (v.dialogs || 0), 0);
    return [h('span', null, `Оценки по чек-листу ${scoredBy}, с учётом апелляций`),
      h('span', { class: 'ov__vnote', 'data-tip': 'Баллы каждой строки посчитаны по версии, которой диалог оценивали. Новые критерии заполнятся после переоценки, изменённый вес отмечен в шапке колонки.' },
        icon('alert', 14), `активна v${cl.version}, по ней оценено ${fresh} из ${all}`)];
  }

  const onKey = (e) => {
    if (keysBlocked(e)) return;
    if (e.key === 'Escape' && (st.fail || st.doubt || st.col)) { st.fail = ''; st.doubt = false; st.col = ''; syncUrl(); renderKpi(); renderMain(); }
  };
  document.addEventListener('keydown', onKey);
  const unreg = ctx.registerCommands(() => [
    st.doubt ? null : { label: 'Обзор: только где ИИ сомневается', icon: 'alert', run: () => { st.doubt = true; syncUrl(); renderKpi(); renderMain(); } },
    ...(data ? data.weak_spots.slice(0, 3).map((w) => ({ label: `Обзор: нарушения по ${w.code} ${w.name}`, icon: 'overview', run: () => { st.fail = w.criterion_id; st.col = ''; syncUrl(); renderMain(); } })) : []),
  ]);

  renderFilters();
  await load();
  return () => { destroyed = true; document.removeEventListener('keydown', onKey); unreg(); };
}
