// Карточка диалога: транскрипт слева, оценка справа. Наведение на критерий подсвечивает его
// реплики-основания в транскрипте и ставит метки на полосе вдоль транскрипта; ссылки T# прокручивают
// к реплике и перематывают запись звонка. Апелляция подаётся прямо в строке критерия.

import { api, audioUrl } from '../api.js';
import {
  h, clear, icon, button, fmt, isNum, toast, toastError, dotted, select, field, popover, closePopover, withBusy,
  valueBadge, valueLabel, normValue, shortValue, scoreTone, linkifyTurns, rangeLabel, bar,
  emptyState, errorState, skeleton, pageHeader, nTurns, nRuns, estimateCost, costText,
  isCall, channelLabel, ENDED_BY, iconButton, countUp, replay, keysBlocked, loadNavList, progressLine, reducedMotion, isKey,
} from '../ui.js';
import { renderTranscript } from '../transcript.js';
import { can, gate, hasRole } from '../session.js';

/** Оценки, итог которых уже «досчитан» при первом показе: повторные отрисовки без анимации. */
const shownEvals = new Set();

/** Для disabled-кнопки подсказку показывает обёртка: у неактивной кнопки нет событий мыши. */
function wrapTip(btn) {
  if (!btn.disabled) return btn;
  const w = h('span', { class: 'gate', 'data-tip': btn.dataset.tip, 'data-kbd': btn.dataset.kbd || null });
  btn.removeAttribute('data-tip');
  btn.removeAttribute('data-kbd');
  w.append(btn);
  return w;
}

export async function mount(root, { params, query, ctx }) {
  const dialogId = params.id;
  ctx.setTitle(`Диалог ${dialogId}`);
  let destroyed = false;
  let pollTimer = null;
  let data;
  try { sessionStorage.setItem('cqa.lastDialog', dialogId); } catch { /* ignore */ }

  /* порядок списка, из которого открыт диалог: «предыдущий / следующий» и возврат по Esc */
  const nav = loadNavList();
  const navIdx = nav ? nav.ids.indexOf(dialogId) : -1;
  const back = navIdx >= 0 && nav.back ? { href: nav.back, label: nav.label || 'Диалоги' } : { href: '#/dialogs', label: 'Диалоги' };
  const neighbour = (d) => (navIdx >= 0 ? nav.ids[navIdx + d] : undefined);
  const goNeighbour = (d, instant) => {
    const id = neighbour(d);
    if (id) ctx.navigate(`#/dialog/${encodeURIComponent(id)}`, { instant });
  };
  const onKey = (e) => {
    if (keysBlocked(e)) return;
    if (isKey(e, 'prev') || isKey(e, 'next')) {
      e.preventDefault();
      goNeighbour(isKey(e, 'prev') ? -1 : 1, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      ctx.navigate(back.href, { instant: true });
    }
  };
  document.addEventListener('keydown', onKey);

  try {
    data = await api.dialog(dialogId);
  } catch (e) {
    if (destroyed) return undefined;
    root.append(pageHeader({ title: dialogId, back }),
      h('div', { class: 'content' }, h('div', { class: 'panel' }, errorState(e, () => ctx.navigate(location.hash)))));
    return () => { destroyed = true; document.removeEventListener('keydown', onKey); };
  }
  if (destroyed) return undefined;

  const { dialog, turns = [], facts = {} } = data;
  let evaluations = data.evaluations || [];
  const call = dialog.has_audio || isCall(dialog.channel);
  const transcript = renderTranscript(turns, { audioSrc: dialog.has_audio ? audioUrl(dialog.id) : null });

  /* ---------- шапка ---------- */
  const metaParts = [
    channelLabel(dialog.channel),
    dialog.language || null,
    nTurns(turns.length),
  ];
  if (isNum(facts.duration_s) && call) metaParts.push(`длительность ${fmt.seconds(facts.duration_s)}`);
  if (isNum(facts.first_response_s)) {
    metaParts.push(h('span', { class: facts.first_response_ok === false ? 't-warn' : null, 'data-tip': 'От перевода на оператора до его первого ответа' },
      `первая реакция ${fmt.seconds(facts.first_response_s)}`));
  }
  if (facts.ended_by) metaParts.push(`завершение: ${ENDED_BY[facts.ended_by] || facts.ended_by}`);

  const evalSel = h('select', { class: 'input input--sm', 'aria-label': 'Оценка', style: { maxWidth: '300px' } });
  evalSel.addEventListener('change', () => show(Number(evalSel.value)));
  const rerunBtn = button('Переоценить', { kind: 'secondary', size: 'sm', trailing: 'chevronDown' });
  rerunBtn.setAttribute('aria-haspopup', 'dialog');
  rerunBtn.addEventListener('click', () => openRerun(rerunBtn));
  const compareBtn = button('Сравнить', { kind: 'secondary', size: 'sm' });
  compareBtn.addEventListener('click', () => toggleCompare());
  const compareWrap = h('span', { style: { display: 'inline-flex' } }, compareBtn);

  const runLine = progressLine('Оценка выполняется');
  const prevBtn = iconButton('chevronUp', 'Предыдущий диалог', () => goNeighbour(-1), { disabled: !neighbour(-1), tip: neighbour(-1) ? 'Предыдущий диалог' : 'Это первый диалог списка' });
  const nextBtn = iconButton('chevronDown', 'Следующий диалог', () => goNeighbour(1), { disabled: !neighbour(1), tip: neighbour(1) ? 'Следующий диалог' : 'Это последний диалог списка' });
  prevBtn.dataset.kbd = '[';
  nextBtn.dataset.kbd = ']';
  const pager = navIdx >= 0
    ? h('div', { class: 'pager', role: 'group', 'aria-label': `Навигация по списку «${back.label}»` },
      h('span', { class: 'pager__pos', 'data-tip': `Порядок списка «${back.label}» с его фильтрами и сортировкой` }, `${navIdx + 1} из ${nav.ids.length}`),
      wrapTip(prevBtn), wrapTip(nextBtn))
    : null;

  root.append(pageHeader({
    title: dialog.id,
    back: { ...back, kbd: 'Esc' },
    meta: dotted(metaParts),
    actions: [evalSel, gate(rerunBtn, 'evaluate'), compareWrap, pager ? h('span', { class: 'ph__divider', 'aria-hidden': 'true' }) : null, pager],
    progress: runLine.el,
  }));

  const evalScroll = h('div', { class: 'pane__scroll' });
  root.append(h('div', { class: 'split' },
    h('section', { class: 'pane', 'aria-label': 'Транскрипт' }, transcript.el),
    h('section', { class: 'pane', 'aria-label': 'Оценка' }, evalScroll)));

  /* ---------- реплики ---------- */
  function goTurn(from, to = from) {
    if (!transcript.focusTurns(from, to)) toast(`Реплики T${from + 1} нет в транскрипте`, 'error');
  }
  const preview = (idx) => transcript.turnText(idx);
  const linkify = (text) => linkifyTurns(text, { onTurn: goTurn, preview });

  /* ---------- выбор оценки ---------- */
  function pickEvalId() {
    if (query.eval && evaluations.some((e) => String(e.id) === String(query.eval))) return Number(query.eval);
    const done = evaluations.find((e) => e.status === 'done');
    return done ? done.id : evaluations[0] ? evaluations[0].id : null;
  }
  let currentId = pickEvalId();
  let current = null;
  let compareWith = null;

  function renderEvalSelect() {
    clear(evalSel);
    evalSel.hidden = !evaluations.length;
    for (const e of evaluations) {
      const st = e.status === 'done' ? (isNum(e.final_total) ? fmt.n2(e.final_total) : 'Н/П') : e.status === 'error' ? 'ошибка' : 'в работе';
      evalSel.append(h('option', { value: e.id, selected: e.id === currentId },
        `№${e.id} · v${e.checklist_version ?? '?'} · ${fmt.dateShort(e.created_at)} · ${st}`));
    }
    const doneCount = evaluations.filter((e) => e.status === 'done').length;
    const ok = doneCount >= 2 && current && current.status === 'done';
    compareBtn.disabled = !ok;
    compareWrap.dataset.tip = ok ? '' : 'Нужны две завершённые оценки';
    if (ok) compareWrap.removeAttribute('data-tip');
    compareBtn.setAttribute('aria-pressed', String(!!compareWith));
  }

  async function refreshEvaluations() {
    try {
      const d = await api.dialog(dialogId);
      evaluations = d.evaluations || [];
    } catch { /* оставляем прежний список */ }
  }

  async function show(evalId, { push = true, keepScroll = false } = {}) {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    const prevScroll = evalScroll.scrollTop;
    currentId = evalId;
    if (push && evalId) ctx.replaceQuery({ eval: evalId });
    transcript.setPinned(null);
    transcript.setHover(null);
    if (!keepScroll) clear(evalScroll).append(skeleton(10));
    if (!evalId) { current = null; runLine.hide(); renderEvalSelect(); renderNoEval(); if (!deepLinked) { deepLinked = true; applyDeepLink(); } return; }
    let ev;
    try {
      ev = await api.evaluation(evalId);
    } catch (e) {
      clear(evalScroll).append(errorState(e, () => show(evalId)));
      return;
    }
    if (destroyed || currentId !== evalId) return;
    current = ev;
    if (compareWith && (ev.status !== 'done' || compareWith === ev.id)) compareWith = null;
    renderEvalSelect();
    clear(evalScroll);
    if (ev.status === 'queued' || ev.status === 'running') { runLine.set(); renderRunning(ev); return; }
    runLine.hide();
    if (ev.status === 'error') { renderError(ev); return; }
    renderResult(ev);
    if (keepScroll) evalScroll.scrollTop = prevScroll;
    if (!deepLinked) { deepLinked = true; applyDeepLink(); }
  }

  /* ?turn=N (и ?crit=cid): открыть критерий и прокрутить транскрипт к реплике, один раз после загрузки */
  let deepLinked = false;
  function applyDeepLink() {
    const turn = query.turn !== undefined ? Number(query.turn) : null;
    const crit = query.crit || null;
    if (crit) openCrit(crit, { focusTranscript: turn === null });
    if (turn !== null && Number.isFinite(turn)) {
      setTimeout(() => { if (!destroyed) goTurn(turn); }, 0);
    }
    if (query.turn !== undefined || query.crit) {
      const q = { ...query };
      delete q.turn;
      delete q.crit;
      if (currentId) q.eval = currentId;
      ctx.replaceQuery(q);
    }
  }

  function renderNoEval() {
    clear(evalScroll);
    const b = button('Оценить', { kind: 'primary' });
    b.addEventListener('click', () => openRerun(b));
    evalScroll.append(emptyState({ title: 'Диалог не оценён', text: 'Оценка займёт около минуты.', actions: [gate(b, 'evaluate')] }));
  }

  function renderRunning(ev) {
    const started = ev.created_at ? new Date(ev.created_at).getTime() : Date.now();
    const timer = h('span', { class: 't-2' });
    const tickClock = () => { timer.textContent = `прошло ${fmt.duration(Math.max(0, Date.now() - started))}`; };
    tickClock();
    evalScroll.append(h('div', { class: 'evblock' },
      h('div', { class: 'rowprog' }, h('span', { class: 'rowprog__bar' }), h('span', { class: 'strong', style: { color: 'var(--text)' } }, ev.status === 'queued' ? 'В очереди' : 'Оценивается')),
      h('p', { class: 'evmeta', style: { marginTop: '6px' } }, dotted([`Чек-лист, версия ${ev.checklist_version ?? ''}`, timer]))));
    const tick = async () => {
      if (destroyed || currentId !== ev.id) return;
      tickClock();
      try {
        const r = await api.evaluations({ ids: ev.id });
        const cur = (r.items || [])[0];
        if (cur && cur.status !== 'queued' && cur.status !== 'running') {
          await refreshEvaluations();
          show(ev.id, { push: false });
          if (cur.status === 'done') toast('Оценка готова', 'success');
          return;
        }
      } catch { /* повторим */ }
      pollTimer = setTimeout(tick, 2000);
    };
    pollTimer = setTimeout(tick, 2000);
  }

  function renderError(ev) {
    const b = button('Повторить оценку', { kind: 'secondary', size: 'sm' });
    b.addEventListener('click', () => openRerun(b));
    evalScroll.append(h('div', { class: 'alert alert--danger', role: 'alert' }, icon('alert', 16),
      h('div', { class: 'fstack', style: { gap: '8px' } },
        h('div', { class: 'alert__title' }, 'Оценка завершилась ошибкой'),
        h('div', { class: 'pre-wrap' }, ev.error || 'Причина не указана'),
        h('div', null, gate(b, 'evaluate')))));
  }

  /* ---------- результат ---------- */
  function renderResult(ev) {
    openRows = new Map();
    const config = (ev.checklist && ev.checklist.config) || { criteria: [], sections: [] };
    const result = ev.result || {};
    const final = ev.final || {};
    const score = final.score || result.score || {};
    const overrides = final.overrides || {};
    const appeals = ev.appeals || [];
    const sectionsById = Object.fromEntries((config.sections || []).map((s) => [s.id, s]));
    const finalTotal = isNum(ev.final_total) ? ev.final_total : score.total;
    const origTotal = isNum(ev.total) ? ev.total : (result.score || {}).total;
    const changed = isNum(origTotal) && isNum(finalTotal) && Math.abs(origTotal - finalTotal) > 0.004;
    const crits = config.criteria || [];
    const critById = Object.fromEntries(crits.map((c) => [c.id, c]));

    if (compareWith) evalScroll.append(compareSection(ev));

    /* итог и секции: при первом показе оценки итог досчитывается от 0, полосы секций растут */
    const first = !shownEvals.has(ev.id);
    shownEvals.add(ev.id);
    const secRows = (score.sections || []).filter((s) => isNum(s.max_points) && s.max_points > 0);
    const factor = score.redistribution_factor;
    const totalNum = h('span', { class: 'evtotal__val' }, isNum(finalTotal) ? fmt.n2(finalTotal) : 'Н/П');
    evalScroll.append(h('div', { class: 'evhead' },
      h('div', null,
        h('div', { class: ['evtotal__num', scoreTone(finalTotal) === 'low' && 'score--low'] },
          totalNum, h('small', null, 'из 100')),
        changed ? h('div', { class: 'evtotal__orig' }, `Исходно ${fmt.n2(origTotal)}`) : null,
        isNum(factor) && factor > 1.0001
          ? h('div', { class: 'evtotal__note', 'data-tip': `Сумма весов применимых критериев ${fmt.n2(score.applicable_weight)}. Веса умножены на ${fmt.n2(factor)}, чтобы максимум остался 100.` },
            'Вес критериев Н/П перераспределён')
          : null),
      secRows.length ? h('div', { class: 'sec-grid', role: 'list', 'aria-label': 'Баллы по секциям' }, secRows.map((s) => h('div', { class: 'sec-grid__row', role: 'listitem' },
        h('span', { class: 'sec-grid__name', title: s.name }, s.name),
        h('span', { class: 'sec-grid__pts' }, fmt.n2(s.points), h('span', null, ` / ${fmt.n2(s.max_points)}`)),
        bar(s.percent, s.percent >= 85 ? null : s.percent < 60 ? 'low' : 'mid', { grow: first })))) : h('span')));
    if (first && isNum(finalTotal)) countUp(totalNum, finalTotal, fmt.n2, 400);

    /* грубые ошибки */
    const gross = score.gross_criteria || [];
    if (score.gross_error || gross.length) {
      for (const cid of gross.length ? gross : [null]) {
        const c = cid ? critById[cid] || { name: cid } : { name: 'нарушение без указания критерия' };
        const r = cid ? (result.criteria || {})[cid] || {} : {};
        evalScroll.append(h('div', { class: 'alert alert--danger', role: 'alert' }, icon('alert', 16),
          h('div', null,
            h('div', null,
              cid ? h('button', { type: 'button', class: 'link-btn alert__title', style: { color: 'var(--danger)' }, onclick: () => openCrit(cid) },
                /груб/i.test(c.name || '') ? 'Грубая ошибка' : `Грубая ошибка: ${c.name}`) : h('span', { class: 'alert__title' }, 'Грубая ошибка'),
              config.gross_error_zeroes_total ? h('span', { class: 't-2' }, '. Итог обнулён') : null),
            r.reasoning ? h('div', { class: 'reason', style: { marginTop: '2px' } }, linkify(r.reasoning)) : null)));
      }
    }

    /* запрос клиента и метаданные */
    const votes = (ev.settings && ev.settings.votes) || ((result.runs || []).length || null);
    evalScroll.append(h('div', { class: 'evblock' },
      result.client_request ? h('h3', { class: 'evblock__title' }, 'Запрос клиента') : null,
      result.client_request ? h('p', { class: 'reason' }, linkify(result.client_request)) : null,
      h('p', { class: 'evmeta', style: { marginTop: result.client_request ? '8px' : 0 } }, dotted([
        ev.model || (ev.settings && ev.settings.model),
        votes ? nRuns(votes) : null,
        fmt.money(ev.cost_usd),
        `чек-лист v${ev.checklist_version ?? '?'}`,
        fmt.date(ev.finished_at || ev.created_at),
      ], 'sep'))));

    /* критерии */
    let lastSection;
    for (const c of crits) {
      if (c.section !== lastSection) {
        lastSection = c.section;
        const sec = sectionsById[c.section];
        const ss = (score.sections || []).find((s) => s.id === c.section);
        evalScroll.append(h('div', { class: 'crit-sec' },
          h('span', null, sec ? sec.name : 'Без секции'),
          ss && isNum(ss.max_points) && ss.max_points > 0 ? h('span', null, `${fmt.n2(ss.points)} из ${fmt.n2(ss.max_points)}`) : h('span')));
      }
      evalScroll.append(criterionRow(ev, c, { result, final, score, overrides, appeals }));
    }

    evalScroll.append(techDetails(ev, config));
  }

  let openRows = new Map();
  function openCrit(cid, { focusTranscript = true } = {}) {
    const el = evalScroll.querySelector(`[data-crit="${CSS.escape(cid)}"]`);
    if (!el) return;
    if (!el.classList.contains('is-open') && el.toggleOpen) el.toggleOpen(true, { focusTranscript });
    el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    replay(el, 'flash');
  }

  function criterionRow(ev, c, { result, final, score, overrides, appeals }) {
    const r = (result.criteria || {})[c.id] || {};
    const origVal = r.value;
    const val = (final.values && final.values[c.id] !== undefined) ? final.values[c.id] : origVal;
    const sc = (score.criteria || {})[c.id] || {};
    const ov = overrides[c.id];
    const isFlag = c.type === 'flag';
    const isNA = normValue(val) === 'NA';
    const myAppeals = appeals.filter((a) => a.criterion_id === c.id).sort((a, b) => b.id - a.id);
    const openAppeal = myAppeals.find((a) => a.status === 'open');
    const evTurns = Array.isArray(r.evidence_turns) ? r.evidence_turns : [];
    const range = Array.isArray(r.checked_range) && r.checked_range.length === 2 ? r.checked_range : null;
    const sel = evTurns.length || range ? { turns: evTurns, range } : null;

    /* согласие прогонов */
    const votes = Array.isArray(r.votes) ? r.votes : [];
    const agree = votes.filter((v) => normValue(v) === normValue(origVal)).length;
    const dist = {};
    for (const v of votes) { const k = shortValue(v) || String(v); dist[k] = (dist[k] || 0) + 1; }
    const split = votes.length > 1 && agree < votes.length;

    /* баллы */
    let ptsCell;
    if (isFlag) ptsCell = h('span', { class: 't-2' }, 'без баллов');
    else if (isNA) ptsCell = h('span', { class: 't-2', 'data-tip': `Критерий неприменим, его вес ${fmt.n2(c.weight)} распределён между остальными` }, 'не учитывается');
    else {
      const eff = sc.effective_weight;
      const redistributed = isNum(eff) && isNum(c.weight) && Math.abs(eff - c.weight) > 0.004;
      ptsCell = h('span', { 'data-tip': redistributed ? `Вес ${fmt.n2(c.weight)}, после перераспределения Н/П ${fmt.n2(eff)}` : `Вес ${fmt.n2(c.weight)}` },
        fmt.n2(sc.points), h('span', null, ` из ${fmt.n2(eff)}`));
    }

    const mark = openAppeal ? h('span', { class: 'crit__mark' }, 'апелляция') : ov ? h('span', { class: 'crit__mark', style: { color: 'var(--text-2)' } }, 'изменено') : null;
    const rowBtn = h('button', { type: 'button', class: 'crit__row', 'aria-expanded': 'false' },
      h('span', { class: 'crit__code' }, c.code || c.id),
      h('span', { class: 'crit__name', title: c.name }, h('span', { class: 'crit__label' }, c.name), mark),
      valueBadge(c, val),
      h('span', { class: 'crit__pts' }, ptsCell),
      h('span', { class: ['crit__agree', split && 'is-split'], 'data-tip': votes.length ? `Голоса прогонов: ${Object.entries(dist).map(([k, n]) => `${k} ${n}`).join(', ')}` : null },
        votes.length ? `${agree} из ${votes.length}` : ''),
      icon('chevronDown', 16, 'crit__chev'));

    const inner = h('div', { class: 'crit__inner' });
    const panel = h('div', { class: 'crit__panel', inert: true, id: `crit-panel-${c.id}` }, inner);
    rowBtn.setAttribute('aria-controls', panel.id);
    const item = h('div', { class: 'crit', dataset: { crit: c.id } }, rowBtn, panel);
    let built = false;

    item.addEventListener('mouseenter', () => { if (sel) transcript.setHover(sel); });
    item.addEventListener('mouseleave', () => transcript.setHover(null));
    rowBtn.addEventListener('focus', () => { if (sel) transcript.setHover(sel); });
    rowBtn.addEventListener('blur', () => transcript.setHover(null));

    // раскрытие: строка grid-template-rows 0fr -> 1fr (240 мс), тело проявляется (180 мс);
    // свёрнутое тело остаётся в DOM для анимации закрытия, но inert, чтобы не ловить фокус
    function toggleOpen(open, { focusTranscript = true } = {}) {
      if (open && !built) { inner.append(buildBody()); built = true; }
      item.classList.toggle('is-open', open);
      rowBtn.setAttribute('aria-expanded', String(open));
      panel.inert = !open;
      if (open) {
        openRows.set(c.id, sel);
        transcript.setPinned(sel);
        if (sel && focusTranscript) {
          const first = range ? range[0] : Math.min(...evTurns);
          transcript.focusTurns(first, range ? range[1] : first, { seekAudio: false });
        }
      } else {
        openRows.delete(c.id);
        const rest = [...openRows.values()];
        transcript.setPinned(rest.length ? rest[rest.length - 1] : null);
      }
    }
    item.toggleOpen = toggleOpen;
    rowBtn.addEventListener('click', () => toggleOpen(!item.classList.contains('is-open')));

    function buildBody() {
      const b = h('div', { class: 'crit__body' });
      if (r.reasoning) {
        b.append(h('div', null,
          h('div', { class: 'reason__label' }, ov ? 'Обоснование ИИ до апелляции' : 'Обоснование ИИ'),
          h('p', { class: 'reason' }, linkify(r.reasoning))));
      }
      if (normValue(origVal) === 'NA' && r.na_reason) {
        b.append(h('div', null, h('div', { class: 'reason__label' }, 'Почему Н/П'), h('p', { class: 'reason' }, linkify(r.na_reason))));
      }
      if (evTurns.length || range) {
        b.append(h('div', { class: 'chips' },
          evTurns.map((t) => h('button', { type: 'button', class: 'chip', 'data-tip': preview(t), onclick: () => goTurn(t) }, `T${t + 1}`)),
          range ? h('button', { type: 'button', class: 'chip chip--range', onclick: () => goTurn(range[0], range[1]) },
            range[0] === range[1] ? `Проверена реплика T${range[0] + 1}` : `Проверен участок ${rangeLabel(range[0], range[1])}`) : null));
      }
      if (split) {
        b.append(h('p', { class: 't-13 t-warn' }, `Прогоны модели разошлись: ${Object.entries(dist).map(([k, n]) => `${k} ${n}`).join(', ')}. Оценку стоит перепроверить.`));
      }

      /* апелляции по критерию */
      for (const a of myAppeals) {
        const rows = [
          ['Апелляция', h('a', { href: `#/appeal/${a.id}` }, `№${a.id}`, a.status === 'open' ? ', на рассмотрении' : ', решена')],
          ['Комментарий', h('span', null, linkify(a.comment || ''))],
          ['Автор', `${a.author || ''}${a.created_at ? `, ${fmt.dateShort(a.created_at)}` : ''}`],
        ];
        if (a.status === 'decided') {
          rows.push(['Исходно', valueLabel(c, (a.original && a.original.value) ?? origVal)]);
          rows.push(['Решение', a.decision === 'changed' ? `Изменено на «${valueLabel(c, a.decision_value)}»` : 'Оценка ИИ подтверждена']);
          if (a.decision_reason) rows.push(['Причина', h('span', null, linkify(a.decision_reason))]);
          rows.push(['Проверяющий', `${a.reviewer || ''}${a.decided_at ? `, ${fmt.dateShort(a.decided_at)}` : ''}`]);
        }
        b.append(h('dl', { class: 'dl' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
      }

      /* форма апелляции */
      if (!openAppeal) {
        if (can('appeal')) b.append(appealForm(ev, c));
        else b.append(h('div', null, gate(button('Подать апелляцию', { kind: 'secondary', size: 'sm' }), 'appeal')));
      } else if (hasRole('operator')) {
        b.append(h('p', { class: 't-13 t-2' }, 'Оценка оспорена, апелляция на рассмотрении у проверяющего.'));
      }
      return b;
    }
    return item;
  }

  function appealForm(ev, c) {
    const operator = hasRole('operator');
    const ta = h('textarea', { class: 'input', rows: 3, placeholder: operator ? 'С чем вы не согласны. Ссылайтесь на реплики, например T12 или T12-T15.' : 'Почему оценка неверна. Ссылайтесь на реплики, например T12 или T12-T15.' });
    const msg = h('span', { class: 'inline-msg', role: 'status' });
    const submit = button(operator ? 'Оспорить оценку' : 'Подать апелляцию', {
      kind: 'primary', size: 'sm',
      onClick: (e) => withBusy(e.currentTarget, async () => {
        msg.className = 'inline-msg';
        msg.textContent = '';
        if (!ta.value.trim()) { msg.classList.add('is-error'); msg.textContent = 'Опишите, почему оценка неверна.'; ta.focus(); return; }
        try {
          const a = await api.fileAppeal(ev.id, c.id, ta.value.trim());
          toast(operator ? `Оценка оспорена, апелляция №${a.id} передана проверяющему` : `Апелляция №${a.id} подана`, 'success');
          ctx.refreshBadges();
          await refreshEvaluations();
          await show(ev.id, { push: false, keepScroll: true });
          openCrit(c.id);
        } catch (err) {
          msg.classList.add('is-error');
          msg.textContent = err.message;
        }
      }),
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit.click(); } });
    return h('div', { class: 'appeal-form' },
      field(operator ? 'Не согласны с оценкой?' : 'Апелляция', ta, { hint: 'Ctrl+Enter отправляет. Решение примет проверяющий.' }),
      h('div', { class: 'factions' }, submit, msg));
  }

  /* ---------- переоценка ---------- */
  async function openRerun(anchor) {
    let list = [];
    let settings = null;
    try {
      [list, settings] = await Promise.all([
        api.checklists().then((r) => r.items || []),
        api.settings().then((r) => r.settings).catch(() => null),
      ]);
    } catch (e) { toastError(e, 'Чек-листы не загружены'); return; }
    if (!list.length) { toast('Нет чек-листов. Создайте его в разделе «Чек-листы».', 'error'); return; }
    const active = list.find((c) => c.is_active);
    const ev = current;
    const def = active ? active.id : ev ? ev.checklist_id : list[0].id;
    const sel = select([...list].sort((a, b) => b.id - a.id).map((c) => ({
      value: c.id, label: `Версия ${c.version}${c.is_active ? ', активная' : ''}${ev && c.id === ev.checklist_id ? ', как в текущей' : ''}`,
    })), def);
    const est = estimateCost(settings, 1);
    const run = button('Запустить', {
      kind: 'primary', size: 'sm',
      onClick: (e) => withBusy(e.currentTarget, async () => {
        try {
          const r = await api.evaluate([dialogId], Number(sel.value));
          const newId = (r.evaluation_ids || [])[0];
          closePopover();
          toast('Оценка запущена', 'success');
          await refreshEvaluations();
          if (newId) show(newId);
        } catch (err) { toastError(err, 'Оценка не запущена'); }
      }),
    });
    popover(anchor, h('div', { class: 'fstack' },
      h('div', { class: 'pop__title', style: { marginBottom: 0 } }, ev ? 'Переоценить диалог' : 'Оценить диалог'),
      field('Версия чек-листа', sel, { hint: costText(est) }),
      h('div', { class: 'factions' }, run, button('Отмена', { kind: 'ghost', size: 'sm', onClick: () => closePopover() }))), { cls: 'pop--form' });
  }

  /* ---------- сравнение ---------- */
  function toggleCompare() {
    if (!current || current.status !== 'done') return;
    if (compareWith) { compareWith = null; show(currentId, { push: false }); return; }
    const other = evaluations.find((e) => e.status === 'done' && e.id !== current.id);
    if (!other) return;
    compareWith = other.id;
    show(currentId, { push: false });
  }

  function compareSection(ev) {
    const others = evaluations.filter((e) => e.status === 'done' && e.id !== ev.id);
    const sel = select(others.map((e) => ({ value: e.id, label: `№${e.id} · v${e.checklist_version ?? '?'} · ${fmt.dateShort(e.created_at)} · ${fmt.n2(e.final_total)}` })), compareWith,
      { class: 'input input--sm', 'aria-label': 'Оценка для сравнения' });
    const out = h('div', null, skeleton(5));
    const load = async () => {
      compareWith = Number(sel.value);
      clear(out).append(skeleton(5));
      try {
        const other = await api.evaluation(compareWith);
        const [a, b] = other.id < ev.id ? [other, ev] : [ev, other];
        clear(out).append(compareView(a, b));
      } catch (e) { clear(out).append(errorState(e, load)); }
    };
    sel.addEventListener('change', load);
    load();
    return h('section', { class: 'cmp', 'aria-label': 'Сравнение оценок' },
      h('div', { class: 'cmp__head' },
        h('span', { class: 'strong' }, `Сравнение: №${ev.id} и`), sel,
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть сравнение', onclick: () => toggleCompare() }, icon('close', 16))),
      out);
  }

  function compareView(a, b) {
    const ca = (a.checklist && a.checklist.config) || { criteria: [] };
    const cb = (b.checklist && b.checklist.config) || { criteria: [] };
    const ids = (ca.criteria || []).map((c) => c.id);
    for (const c of cb.criteria || []) if (!ids.includes(c.id)) ids.push(c.id);
    const sa = (a.final && a.final.score) || (a.result && a.result.score) || {};
    const sb = (b.final && b.final.score) || (b.result && b.result.score) || {};
    const va = (a.final && a.final.values) || {};
    const vb = (b.final && b.final.values) || {};
    const ra = (a.result && a.result.criteria) || {};
    const rb = (b.result && b.result.criteria) || {};
    const dt = isNum(b.final_total) && isNum(a.final_total) ? b.final_total - a.final_total : null;
    const sign = (x) => `${x > 0 ? '+' : ''}${fmt.n2(x)}`;

    const tbody = h('tbody');
    let changes = 0;
    for (const id of ids) {
      const xa = (ca.criteria || []).find((c) => c.id === id);
      const xb = (cb.criteria || []).find((c) => c.id === id);
      const pa = (sa.criteria || {})[id] || {};
      const pb = (sb.criteria || {})[id] || {};
      const notes = [];
      if (!xa) notes.push('новый критерий');
      else if (!xb) notes.push('удалён из чек-листа');
      else {
        if (xa.name !== xb.name) notes.push(`было «${xa.name}»`);
        if (Number(xa.weight) !== Number(xb.weight)) notes.push(`вес: было ${fmt.n2(xa.weight)}, стало ${fmt.n2(xb.weight)}`);
        if (xa.type !== xb.type) notes.push('изменён тип');
        if ((xa.description || '') !== (xb.description || '') || (xa.guidance || '') !== (xb.guidance || '') || (xa.na_condition || '') !== (xb.na_condition || '')) notes.push('изменено правило');
        if (JSON.stringify(xa.scale || []) !== JSON.stringify(xb.scale || [])) notes.push('изменена шкала');
      }
      const vA = va[id] ?? (ra[id] || {}).value;
      const vB = vb[id] ?? (rb[id] || {}).value;
      const d = isNum(pa.points) && isNum(pb.points) ? pb.points - pa.points : null;
      const isChanged = normValue(vA) !== normValue(vB) || notes.length || (d !== null && Math.abs(d) > 0.004);
      if (isChanged) changes += 1;
      const c = xb || xa;
      tbody.append(h('tr', { class: isChanged ? 'is-changed' : '' },
        h('td', { class: 'wrap' }, h('span', { class: 'crit__code' }, c.code || id), ' ', c.name,
          notes.length ? h('span', { class: 'sub' }, notes.join('; ')) : null),
        h('td', null, xa ? [valueBadge(xa, vA), isNum(pa.points) && !pa.is_flag ? h('span', { class: 'cmp__pts' }, fmt.n2(pa.points)) : null] : h('span', { class: 't-2' }, 'нет')),
        h('td', null, xb ? [valueBadge(xb, vB), isNum(pb.points) && !pb.is_flag ? h('span', { class: 'cmp__pts' }, fmt.n2(pb.points)) : null] : h('span', { class: 't-2' }, 'нет')),
        h('td', { class: ['num', d > 0.004 && 'delta-up', d < -0.004 && 'delta-down'] }, d === null || Math.abs(d) < 0.005 ? '' : sign(d))));
    }
    return h('div', null,
      h('div', { class: 'cmp__totals' },
        h('span', null, `№${a.id}, v${a.checklist_version ?? '?'}: `, h('b', null, fmt.n2(a.final_total))),
        h('span', null, `№${b.id}, v${b.checklist_version ?? '?'}: `, h('b', null, fmt.n2(b.final_total))),
        h('span', null, 'Разница: ', h('b', { class: dt > 0.004 ? 'delta-up' : dt < -0.004 ? 'delta-down' : '' }, dt === null ? 'нет' : sign(dt))),
        h('span', { class: 't-2' }, `изменилось критериев: ${changes}`)),
      h('table', { class: 'tbl tbl--compact' },
        h('thead', null, h('tr', null, h('th', null, 'Критерий'), h('th', null, `№${a.id}, баллы`), h('th', null, `№${b.id}, баллы`), h('th', { class: 'num' }, 'Разница'))),
        tbody));
  }

  /* ---------- технические детали ---------- */
  function techDetails(ev, config) {
    const u = ev.usage || {};
    const st = ev.settings || {};
    const runs = (ev.result && ev.result.runs) || [];
    const crits = config.criteria || [];
    const finalVals = (ev.result && ev.result.criteria) || {};
    const providers = [...new Set(runs.map((r) => r.provider).filter(Boolean))].join(', ') || st.provider || '';
    const kv = (k, v) => [h('dt', null, k), h('dd', null, v === '' || v == null ? 'нет' : v)];

    const runTable = h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl tbl--compact' },
      h('thead', null, h('tr', null,
        h('th', null, 'Прогон'), h('th', null, 'Модель'), h('th', { class: 'num' }, 'Время'), h('th', { class: 'num' }, 'Стоимость'),
        h('th', { class: 'num' }, 'Токены вход, выход'),
        crits.map((c) => h('th', { class: 'num', 'data-tip': c.name }, c.code || c.id)))),
      h('tbody', null, runs.map((r, i) => h('tr', null,
        h('td', null, `№${i + 1}`),
        h('td', { class: 'nowrap' }, r.model || ''),
        h('td', { class: 'num' }, fmt.duration(r.duration_ms)),
        h('td', { class: 'num' }, fmt.money(r.cost_usd)),
        h('td', { class: 'num nowrap' }, r.usage ? `${fmt.tokens(r.usage.input_tokens)}, ${fmt.tokens(r.usage.output_tokens)}` : ''),
        r.error
          ? h('td', { colspan: crits.length, class: 't-danger wrap' }, r.error)
          : crits.map((c) => {
            const v = r.values ? r.values[c.id] : undefined;
            const diff = v !== undefined && normValue(v) !== normValue((finalVals[c.id] || {}).value);
            return h('td', { class: ['num', diff && 'cell-diff'], 'data-tip': diff ? 'Голос расходится с итоговым значением' : null }, v === undefined ? '' : shortValue(v));
          }))))));

    return h('details', { class: 'tech' },
      h('summary', null, icon('chevronDown', 16), 'Технические детали',
        h('span', { class: 't-2' }, dotted([ev.model || st.model, nRuns(runs.length), fmt.money(ev.cost_usd), fmt.duration(ev.duration_ms)]))),
      h('div', { class: 'tech__body' },
        h('dl', { class: 'dl' },
          kv('Модель', ev.model || st.model),
          kv('Провайдер', providers),
          kv('Прогонов', String(st.votes ?? runs.length)),
          kv('Уровень рассуждений', st.effort),
          kv('Токены на входе', fmt.tokens(u.input_tokens)),
          kv('Токены на выходе', fmt.tokens(u.output_tokens)),
          kv('Чтение из кэша', fmt.tokens(u.cache_read_input_tokens)),
          kv('Запись в кэш', fmt.tokens(u.cache_creation_input_tokens)),
          kv('Стоимость', fmt.money(ev.cost_usd)),
          kv('Длительность', fmt.duration(ev.duration_ms)),
          kv('Создана', fmt.date(ev.created_at)),
          kv('Завершена', fmt.date(ev.finished_at)),
          kv('Оценка', `№${ev.id}, чек-лист ${ev.checklist_name || ''} v${ev.checklist_version ?? '?'}`)),
        h('div', null, h('h4', { class: 'tech__sub' }, 'Голоса по прогонам'), runs.length ? runTable : h('p', { class: 't-2' }, 'Данных по прогонам нет')),
        h('div', null, h('h4', { class: 'tech__sub' }, 'Факты из транскрипта до вызова модели'),
          h('dl', { class: 'dl' },
            kv('Перевод на оператора', isNum(facts.escalation_turn) ? `T${facts.escalation_turn + 1}` : ''),
            kv('Первая реплика оператора', isNum(facts.first_operator_turn) ? `T${facts.first_operator_turn + 1}` : ''),
            kv('Первая реакция', isNum(facts.first_response_s) ? `${fmt.seconds(facts.first_response_s)}${facts.first_response_ok === false ? ', порог превышен' : ''}` : ''),
            kv('Ожиданий клиента', Array.isArray(facts.client_waits) ? String(facts.client_waits.length) : Array.isArray(facts.long_waits) ? String(facts.long_waits.length) : ''),
            kv('Реплик оператора, клиента', `${fmt.int(facts.operator_turns)}, ${fmt.int(facts.client_turns)}`),
            kv('Реплик на удержании', Array.isArray(facts.hold_turns) ? String(facts.hold_turns.length) : '0')))));
  }

  renderEvalSelect();
  show(currentId, { push: false });

  return () => {
    destroyed = true;
    document.removeEventListener('keydown', onKey);
    if (pollTimer) clearTimeout(pollTimer);
    if (transcript.audio) { try { transcript.audio.pause(); } catch { /* ignore */ } }
  };
}
