// Карточка диалога: транскрипт слева, результат оценки справа (история оценок, итог, секции,
// критерии с обоснованием и ссылками на реплики, апелляции, сравнение оценок, технические детали).

import { api, audioUrl } from '../api.js';
import {
  h, clear, icon, button, fmt, isNum, prefs, toast, toastError, openModal, plural, roleAction,
  valueBadge, valueTone, normValue, scoreTone, linkifyTurns, emptyState, errorState, skeleton,
  select, field, isCall, LANG_LABELS, TYPE_LABELS, estimateCost,
} from '../ui.js';
import { renderTranscript } from '../transcript.js';

const ENDED_BY = { operator_closed: 'оператор закрыл чат', client_or_connection: 'клиент ушёл или связь прервалась' };

export async function mount(root, { params, query, ctx }) {
  const dialogId = params.id;
  ctx.setTitle(`Диалог ${dialogId}`);
  let destroyed = false;
  let pollTimer = null;
  let data;

  root.append(h('div', { class: 'card pad' }, skeleton(10)));
  try {
    data = await api.dialog(dialogId);
  } catch (e) {
    clear(root).append(errorState(e, () => ctx.navigate(location.hash)));
    return undefined;
  }
  clear(root);
  if (destroyed) return undefined;

  const { dialog, turns = [], facts = {} } = data;
  let evaluations = data.evaluations || [];
  const call = dialog.has_audio || isCall(dialog.channel);
  const transcript = renderTranscript(turns, { audioSrc: dialog.has_audio ? audioUrl(dialog.id) : null });

  /* ---------- шапка ---------- */
  const metaChips = [
    h('span', { class: 'meta-chip' }, icon(call ? 'phone' : 'chat', 14), call ? 'Звонок' : 'Чат'),
    h('span', { class: 'meta-chip' }, LANG_LABELS[dialog.language] || dialog.language || 'язык не определён'),
    h('span', { class: 'meta-chip' }, `${turns.length} ${plural(turns.length, 'реплика', 'реплики', 'реплик')}`),
  ];
  if (isNum(facts.duration_s)) metaChips.push(h('span', { class: 'meta-chip' }, icon('clock', 14), fmt.duration(facts.duration_s * 1000)));
  if (isNum(facts.first_response_s)) {
    metaChips.push(h('span', { class: ['meta-chip', facts.first_response_ok === false && 'meta-chip--warn'], 'data-tip': 'Время от эскалации до первого ответа оператора. Порог — 3 минуты.' },
      `Первый ответ: ${fmt.duration(facts.first_response_s * 1000)}`));
  }
  if (facts.ended_by) metaChips.push(h('span', { class: 'meta-chip' }, `Завершение: ${ENDED_BY[facts.ended_by] || facts.ended_by}`));
  if (dialog.group_id) metaChips.push(h('span', { class: 'meta-chip meta-chip--muted' }, `Группа ${dialog.group_id}`));

  root.append(h('div', { class: 'page-head page-head--dialog' },
    h('div', null,
      h('a', { class: 'back-link', href: '#/dialogs' }, icon('chevron', 14, 'icon--flip'), 'Все диалоги'),
      h('h1', { class: 'page-title' }, dialog.id),
      h('div', { class: 'meta-row' }, metaChips))));

  const resultPane = h('div', { class: 'result-pane' });
  root.append(h('div', { class: 'dialog-grid' },
    h('section', { class: 'panel panel--transcript', 'aria-label': 'Транскрипт' },
      h('div', { class: 'panel__head' },
        h('h2', { class: 'panel__title' }, 'Транскрипт'),
        h('div', { class: 'legend' },
          h('span', { class: 'spk spk--client' }, 'Клиент'), h('span', { class: 'spk spk--operator' }, 'Оператор'),
          h('span', { class: 'spk spk--bot' }, 'Бот'), h('span', { class: 'spk spk--system' }, 'Система'))),
      h('div', { class: 'scroll-pane' }, transcript.el)),
    resultPane));

  /* ---------- переход к репликам ---------- */
  function goTurn(from, to = from) {
    if (!transcript.focusTurns(from, to)) toast(`Реплика T${from} не найдена в транскрипте`, 'error');
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

  async function refreshEvaluations() {
    try {
      const d = await api.dialog(dialogId);
      evaluations = d.evaluations || [];
    } catch { /* оставляем старый список */ }
  }

  async function show(evalId, { push = true } = {}) {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    currentId = evalId;
    if (push && evalId) ctx.replaceQuery({ eval: evalId });
    clear(resultPane);
    if (!evalId) { renderNoEval(); return; }
    resultPane.append(evalBar(null), h('div', { class: 'card pad' }, skeleton(8)));
    let ev;
    try {
      ev = await api.evaluation(evalId);
    } catch (e) {
      clear(resultPane).append(evalBar(null), errorState(e, () => show(evalId)));
      return;
    }
    if (destroyed || currentId !== evalId) return;
    clear(resultPane);
    resultPane.append(evalBar(ev));
    if (ev.status === 'queued' || ev.status === 'running') { renderRunning(ev); return; }
    if (ev.status === 'error') { renderError(ev); return; }
    renderResult(ev);
  }

  function evalBar(ev) {
    const sel = h('select', { class: 'input input--sm eval-select', 'aria-label': 'История оценок' });
    for (const e of evaluations) {
      const st = e.status === 'done' ? (isNum(e.final_total) ? fmt.n2(e.final_total) : '—') : e.status === 'error' ? 'ошибка' : 'в работе';
      // сначала то, чем оценки отличаются (номер, версия чек-листа, итог); остальное — в подсказке
      sel.append(h('option', {
        value: e.id, selected: e.id === currentId,
        title: `${e.checklist_name || 'чек-лист'}, версия ${e.checklist_version ?? '?'}${e.model ? `, ${e.model}` : ''}`,
      }, `№${e.id} · v${e.checklist_version ?? '?'} · ${st} · ${fmt.dateShort(e.created_at)}`));
    }
    sel.addEventListener('change', () => show(Number(sel.value)));
    const doneCount = evaluations.filter((e) => e.status === 'done').length;
    const cmp = button('Сравнить с…', { kind: 'ghost', iconName: 'compare', size: 'sm', onClick: () => openCompare(ev), disabled: !ev || ev.status !== 'done' || doneCount < 2, tip: doneCount < 2 ? 'Нужно минимум две завершённые оценки' : 'Сравнить критерии двух оценок, например до и после изменения чек-листа' });
    return h('div', { class: 'eval-bar card' },
      h('div', { class: 'eval-bar__select' },
        h('span', { class: 'eval-bar__label' }, `${evaluations.length} ${plural(evaluations.length, 'оценка', 'оценки', 'оценок')}`),
        evaluations.length ? sel : h('span', { class: 'muted' }, 'нет оценок')),
      h('div', { class: 'eval-bar__actions' },
        button('Оценить заново', { kind: 'secondary', iconName: 'refresh', size: 'sm', onClick: () => openRerun(ev) }),
        cmp));
  }

  function renderNoEval() {
    resultPane.append(emptyState({
      title: 'Диалог ещё не оценён',
      text: 'Запустите оценку ИИ по активному или выбранному чек-листу. Результат появится здесь через 20–60 секунд.',
      iconName: 'spark',
      action: button('Оценить диалог', { kind: 'primary', iconName: 'spark', onClick: () => openRerun(null) }),
    }));
  }

  function renderRunning(ev) {
    const started = ev.created_at ? new Date(ev.created_at).getTime() : Date.now();
    const timer = h('span', { class: 'muted' });
    const tickClock = () => { timer.textContent = `прошло ${fmt.duration(Math.max(0, Date.now() - started))}`; };
    tickClock();
    resultPane.append(h('div', { class: 'card running-card' },
      h('div', { class: 'running-card__icon' }, h('span', { class: 'spinner spinner--lg' })),
      h('div', null,
        h('h3', null, ev.status === 'queued' ? 'Оценка в очереди' : 'ИИ анализирует диалог'),
        h('p', { class: 'muted' }, `Чек-лист «${ev.checklist_name || ''}» v${ev.checklist_version ?? ''}. Несколько независимых прогонов модели, затем голосование по каждому критерию.`),
        timer)));
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
    resultPane.append(h('div', { class: 'card banner-card banner-card--error' },
      icon('alert', 20),
      h('div', null,
        h('h3', null, 'Оценка завершилась ошибкой'),
        h('p', { class: 'pre-wrap' }, ev.error || 'Причина не указана'),
        button('Повторить оценку', { kind: 'secondary', iconName: 'refresh', size: 'sm', onClick: () => openRerun(ev) }))));
  }

  /* ---------- результат ---------- */
  function renderResult(ev) {
    const config = (ev.checklist && ev.checklist.config) || { criteria: [], sections: [] };
    const result = ev.result || {};
    const final = ev.final || {};
    const score = final.score || result.score || {};
    const origScore = result.score || {};
    const overrides = final.overrides || {};
    const appeals = ev.appeals || [];
    const sectionsById = Object.fromEntries((config.sections || []).map((s) => [s.id, s]));
    const finalTotal = isNum(ev.final_total) ? ev.final_total : score.total;
    const origTotal = isNum(ev.total) ? ev.total : origScore.total;
    const changed = isNum(origTotal) && isNum(finalTotal) && Math.abs(origTotal - finalTotal) > 0.004;

    /* итог */
    const summary = h('div', { class: 'card summary-card' },
      scoreRing(finalTotal, score.max_total),
      h('div', { class: 'summary-card__side' },
        h('div', { class: 'summary-card__title' },
          h('span', null, 'Итоговая оценка оператора'),
          ev.decided_appeals || ev.open_appeals ? h('span', { class: 'chip chip--muted' }, `апелляций: ${ev.decided_appeals || 0} решено, ${ev.open_appeals || 0} открыто`) : null),
        changed ? h('div', { class: 'appeal-delta' },
          h('span', null, 'исходно '), h('s', null, fmt.n2(origTotal)), h('span', null, ' → итог '), h('strong', null, fmt.n2(finalTotal)),
          h('span', { class: 'muted' }, ' после решения по апелляции')) : null,
        h('div', { class: 'summary-card__meta' },
          h('span', null, `${ev.checklist_name || config.name || 'Чек-лист'}, версия ${ev.checklist_version ?? '—'}`),
          h('span', null, fmt.date(ev.finished_at || ev.created_at)),
          ev.model ? h('span', null, ev.model) : null),
        sectionBars(score.sections || []),
        isNum(score.redistribution_factor) && score.redistribution_factor > 1.0001
          ? h('p', { class: 'summary-card__note' }, icon('info', 14),
            `Часть критериев неприменима (N/A): их вес распределён между остальными, коэффициент ×${fmt.n2(score.redistribution_factor)}.`)
          : null));
    resultPane.append(summary);

    /* грубые ошибки */
    const gross = score.gross_criteria || [];
    if (score.gross_error || gross.length) {
      const banner = h('div', { class: 'gross-banner', role: 'alert' },
        h('div', { class: 'gross-banner__head' }, icon('alert', 20), h('strong', null, 'Грубая ошибка оператора'),
          config.gross_error_zeroes_total ? h('span', { class: 'gross-banner__tag' }, 'итог обнулён') : null));
      for (const cid of gross) {
        const c = (config.criteria || []).find((x) => x.id === cid) || { name: cid };
        const r = (result.criteria || {})[cid] || {};
        banner.append(h('div', { class: 'gross-banner__item' },
          h('button', { type: 'button', class: 'gross-banner__name', onclick: () => scrollToCrit(cid) }, `${c.code ? `${c.code}. ` : ''}${c.name}`),
          r.reasoning ? h('p', null, linkify(r.reasoning)) : null));
      }
      resultPane.append(banner);
    }

    /* запрос клиента */
    if (result.client_request) {
      resultPane.append(h('div', { class: 'card request-card' },
        h('h3', { class: 'card__title' }, icon('target', 16), 'Запрос клиента'),
        h('p', null, linkify(result.client_request))));
    }

    /* критерии */
    const critList = h('div', { class: 'crit-list' });
    let lastSection = null;
    for (const c of config.criteria || []) {
      if (c.section !== lastSection) {
        lastSection = c.section;
        const sec = sectionsById[c.section];
        const ss = (score.sections || []).find((s) => s.id === c.section);
        critList.append(h('div', { class: 'crit-section' },
          h('h3', null, sec ? sec.name : (c.section || 'Без секции')),
          ss ? h('span', { class: 'crit-section__pts' }, `${fmt.n2(ss.points)} из ${fmt.n2(ss.max_points)}`) : null));
      }
      critList.append(criterionCard(ev, c, { result, final, score, overrides, appeals }));
    }
    resultPane.append(h('section', { 'aria-label': 'Критерии' }, critList));

    resultPane.append(techDetails(ev, config));
  }

  function scrollToCrit(cid) {
    const el = resultPane.querySelector(`[data-crit="${CSS.escape(cid)}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
  }

  function criterionCard(ev, c, { result, final, score, overrides, appeals }) {
    const r = (result.criteria || {})[c.id] || {};
    const origVal = r.value;
    const val = (final.values && final.values[c.id] !== undefined) ? final.values[c.id] : origVal;
    const sc = (score.criteria || {})[c.id] || {};
    const ov = overrides[c.id];
    const tone = valueTone(c, val);
    const myAppeals = appeals.filter((a) => a.criterion_id === c.id).sort((a, b) => b.id - a.id);
    const openAppeal = myAppeals.find((a) => a.status === 'open');
    const isFlag = c.type === 'flag';

    const card = h('article', { class: ['crit', `crit--${tone}`, isFlag && 'crit--flag'], dataset: { crit: c.id } });

    /* заголовок */
    card.append(h('header', { class: 'crit__head' },
      h('div', { class: 'crit__title' },
        h('span', { class: 'crit__code' }, c.code || c.id),
        h('h4', null, c.name),
        h('span', { class: 'crit__type', 'data-tip': c.description || '' }, TYPE_LABELS[c.type] || c.type)),
      valueBadge(c, val, { size: 'lg' })));

    /* баллы, вес, согласованность */
    const metrics = h('div', { class: 'crit__metrics' });
    if (isFlag) {
      metrics.append(h('span', { class: 'metric' }, 'Флаг грубой ошибки, без баллов'));
    } else if (normValue(val) === 'NA') {
      metrics.append(h('span', { class: 'metric', 'data-tip': `Критерий неприменим: его вес ${fmt.n2(c.weight)} распределён между остальными применимыми критериями.` }, `Не учитывается, вес ${fmt.n2(c.weight)} перераспределён`));
    } else {
      const eff = sc.effective_weight;
      const factor = score.redistribution_factor;
      const tip = isNum(factor) && factor > 1.0001
        ? `Исходный вес ${fmt.n2(c.weight)}. Критерии с N/A исключены, сумма весов применимых — ${fmt.n2(score.applicable_weight)}; веса умножены на ${fmt.n2(factor)}, чтобы максимум остался 100.`
        : `Вес критерия ${fmt.n2(c.weight)} из 100. N/A в этом диалоге нет, перераспределения не было.`;
      metrics.append(
        h('span', { class: 'metric metric--points' }, h('strong', null, fmt.n2(sc.points)), ` из ${fmt.n2(eff)}`),
        h('span', { class: 'metric', 'data-tip': tip, tabindex: 0 },
          isNum(eff) && isNum(c.weight) && Math.abs(eff - c.weight) > 0.004 ? `вес ${fmt.n2(c.weight)} → ${fmt.n2(eff)}` : `вес ${fmt.n2(c.weight)}`,
          icon('info', 12)));
    }
    const votes = Array.isArray(r.votes) ? r.votes : [];
    if (votes.length) {
      const agree = votes.filter((v) => normValue(v) === normValue(origVal)).length;
      const dist = {};
      for (const v of votes) { const k = normValue(v); dist[k] = (dist[k] || 0) + 1; }
      const distTxt = Object.entries(dist).map(([k, n]) => `${k === 'YES' ? 'Да' : k === 'NO' ? 'Нет' : k === 'NA' ? 'N/A' : k}: ${n}`).join(', ');
      const full = agree === votes.length;
      metrics.append(h('span', { class: ['metric', 'metric--agree', full ? 'is-full' : 'is-split'], 'data-tip': `Голоса прогонов: ${distTxt}`, tabindex: 0 },
        icon(full ? 'check' : 'alert', 13),
        votes.length === 1 ? '1 прогон' : `${agree}/${votes.length} прогонов согласны`,
        !full ? h('span', { class: 'metric__hint' }, 'проверить') : null));
    }
    card.append(metrics);

    /* изменение по апелляции */
    if (ov) {
      card.append(h('div', { class: 'override' },
        h('div', { class: 'override__row' },
          h('span', { class: 'override__label' }, 'Оценка ИИ'), valueBadge(c, ov.from ?? origVal),
          icon('chevron', 14),
          h('span', { class: 'override__label' }, 'после апелляции'), valueBadge(c, ov.to ?? val)),
        ov.reason ? h('p', { class: 'override__reason' }, h('span', { class: 'muted' }, 'Причина проверяющего: '), ov.reason) : null,
        ov.appeal_id ? h('a', { class: 'link-sm', href: `#/appeal/${ov.appeal_id}` }, `Апелляция №${ov.appeal_id}`) : null));
    }

    /* подтверждённые апелляции: решение и причина проверяющего */
    if (!ov) {
      const confirmed = myAppeals.find((a) => a.status === 'decided' && a.decision === 'confirmed');
      if (confirmed) {
        card.append(h('div', { class: 'override override--confirmed' },
          h('div', { class: 'override__row' },
            icon('check', 14),
            h('span', { class: 'override__label' }, 'Проверяющий подтвердил оценку ИИ'), valueBadge(c, val)),
          confirmed.decision_reason ? h('p', { class: 'override__reason' }, h('span', { class: 'muted' }, 'Причина: '), confirmed.decision_reason) : null,
          h('p', { class: 'muted small' },
            confirmed.reviewer ? `Проверяющий: ${confirmed.reviewer}. ` : '',
            h('a', { class: 'link-sm', href: `#/appeal/${confirmed.id}` }, `Апелляция №${confirmed.id}`))));
      }
    }

    /* обоснование (при изменении по апелляции — это исходный текст ИИ, помечаем явно) */
    if (r.reasoning) {
      card.append(h('p', { class: 'crit__reason' },
        ov ? h('span', { class: 'muted' }, 'Обоснование ИИ (до апелляции): ') : null,
        linkify(r.reasoning)));
    }
    if (normValue(origVal) === 'NA' && r.na_reason) {
      card.append(h('p', { class: 'na-note' }, h('strong', null, ov ? 'Почему ИИ выбрал N/A (до апелляции): ' : 'Почему N/A: '), linkify(r.na_reason)));
    }

    /* доказательства */
    const ev_turns = Array.isArray(r.evidence_turns) ? r.evidence_turns : [];
    const range = Array.isArray(r.checked_range) && r.checked_range.length === 2 ? r.checked_range : null;
    if (ev_turns.length || range) {
      const chips = h('div', { class: 'evidence' }, h('span', { class: 'evidence__label' }, 'Реплики'));
      for (const t of ev_turns) {
        chips.append(h('button', { type: 'button', class: 'turn-chip', 'data-tip': preview(t), onclick: () => goTurn(t) }, `T${t}`));
      }
      if (range) {
        chips.append(h('button', {
          type: 'button', class: 'turn-chip turn-chip--range',
          'data-tip': 'Участок, где ожидалось действие оператора. Нажмите, чтобы подсветить его в транскрипте.',
          onclick: () => goTurn(range[0], range[1]),
        }, icon('target', 12), range[0] === range[1] ? `Проверена реплика T${range[0]}` : `Проверен участок T${range[0]}–T${range[1]}`));
      }
      card.append(chips);
    }

    /* апелляция */
    const foot = h('footer', { class: 'crit__foot' });
    for (const a of myAppeals.slice(0, 2)) {
      foot.append(h('a', { class: ['appeal-chip', `appeal-chip--${a.status}`], href: `#/appeal/${a.id}` },
        icon('gavel', 13),
        a.status === 'open' ? `Апелляция №${a.id} на рассмотрении` : `Апелляция №${a.id}: ${a.decision === 'changed' ? 'оценка изменена' : 'оценка подтверждена'}`));
    }
    const appealBtn = button('Оспорить', { kind: 'ghost', iconName: 'gavel', size: 'sm', disabled: !!openAppeal, onClick: () => openAppealModal(ev, c, val), tip: openAppeal ? 'По этому критерию уже есть открытая апелляция' : 'Подать апелляцию на оценку критерия' });
    roleAction(appealBtn, 'supervisor');
    foot.append(h('span', { class: 'spacer' }), appealBtn);
    card.append(foot);
    return card;
  }

  /* ---------- модальные окна ---------- */
  function openAppealModal(ev, c, val) {
    const comment = h('textarea', { class: 'input', rows: 5, placeholder: 'Например: оператор представился в T14 — «меня зовут [Имя скрыто]», значит критерий выполнен.' });
    const author = h('input', { class: 'input', value: prefs.get('name.supervisor', ''), placeholder: 'Имя супервайзера' });
    openModal({
      title: `Оспорить: ${c.code ? `${c.code}. ` : ''}${c.name}`,
      subtitle: 'Апелляцию рассмотрит проверяющий: он подтвердит оценку ИИ или изменит её с обоснованием. Итог пересчитается автоматически.',
      body: h('div', { class: 'form-stack' },
        h('div', { class: 'appeal-current' }, h('span', { class: 'muted' }, 'Текущее значение'), valueBadge(c, val)),
        field('Почему оценка неверна', comment, { hint: 'Ссылайтесь на реплики, например T12 или T12–T15.' }),
        field('Автор', author)),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: 'Подать апелляцию', kind: 'primary', icon: 'gavel',
          onClick: async () => {
            if (!comment.value.trim()) { toast('Опишите, почему оценка неверна', 'error'); comment.focus(); return false; }
            prefs.set('name.supervisor', author.value.trim());
            const a = await api.fileAppeal(ev.id, c.id, comment.value.trim(), author.value.trim() || undefined);
            toast(`Апелляция №${a.id} подана`, 'success');
            ctx.refreshBadges();
            await refreshEvaluations();
            show(ev.id, { push: false });
            return undefined;
          },
        },
      ],
    });
  }

  async function openRerun(ev) {
    let list = [];
    try { list = (await api.checklists()).items || []; } catch (e) { toastError(e, 'Чек-листы не загружены'); return; }
    if (!list.length) { toast('Нет чек-листов: создайте его в разделе «Чек-листы»', 'error'); return; }
    const active = list.find((c) => c.is_active);
    // по умолчанию — АКТИВНАЯ версия: после замены критерия повторная оценка идёт по новому чек-листу
    const def = active ? active.id : ev ? ev.checklist_id : list[0].id;
    const sel = select([...list].sort((a, b) => b.id - a.id).map((c) => ({ value: c.id, label: `${c.name}, версия ${c.version}${c.is_active ? ' (активная)' : ''}${ev && c.id === ev.checklist_id ? ' — текущая оценка' : ''}` })), def);
    let settings = null;
    try { settings = (await api.settings()).settings; } catch { /* по умолчанию */ }
    const est = estimateCost(settings, 1);
    const costHint = est.local
      ? `Прогонов модели: ${est.votes}. Локальная модель — без затрат на API.`
      : `Прогонов модели: ${est.votes}. Ориентировочно ${fmt.money(est.cost)}${est.model ? ` (${est.model})` : ''}.`;
    const evCl = ev ? list.find((c) => c.id === ev.checklist_id) : null;
    const versionNote = ev && active && evCl && evCl.id !== active.id
      ? h('p', { class: 'muted small' }, `Текущая оценка сделана по версии ${evCl.version}, активная — версия ${active.version}. По умолчанию выбрана активная.`)
      : null;
    openModal({
      title: ev ? 'Оценить заново' : 'Оценить диалог',
      subtitle: 'Новая оценка сохранится в истории, предыдущие останутся доступны для сравнения.',
      body: h('div', { class: 'form-stack' },
        versionNote,
        field('Версия чек-листа', sel, { hint: costHint })),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: 'Запустить оценку', kind: 'primary', icon: 'spark',
          onClick: async () => {
            const r = await api.evaluate([dialogId], Number(sel.value));
            const newId = (r.evaluation_ids || [])[0];
            toast('Оценка запущена', 'success');
            await refreshEvaluations();
            if (newId) show(newId);
            return undefined;
          },
        },
      ],
    });
  }

  async function openCompare(ev) {
    const others = evaluations.filter((e) => e.status === 'done' && e.id !== ev.id);
    if (!others.length) return;
    const sel = select(others.map((e) => ({ value: e.id, label: `Оценка №${e.id}: ${e.checklist_name || ''} v${e.checklist_version ?? '?'}, ${fmt.dateShort(e.created_at)} — ${fmt.n2(e.final_total)}` })), others[0].id, { class: 'input input--sm' });
    const out = h('div', { class: 'compare' }, skeleton(6));
    async function load() {
      clear(out).append(skeleton(6));
      try {
        const other = await api.evaluation(Number(sel.value));
        // слева — более ранняя оценка, справа — более поздняя
        const [a, b] = other.id < ev.id ? [other, ev] : [ev, other];
        clear(out).append(compareView(a, b));
      } catch (e) {
        clear(out).append(errorState(e, load));
      }
    }
    sel.addEventListener('change', load);
    openModal({
      title: 'Сравнение оценок',
      subtitle: 'Показывает, как изменились значения и баллы по критериям — например, после замены критерия в чек-листе.',
      size: 'xl',
      body: h('div', null, h('div', { class: 'compare__pick' }, h('span', null, `Оценка №${ev.id} и`), sel), out),
      actions: [{ label: 'Закрыть', kind: 'secondary' }],
    });
    load();
  }

  function compareView(a, b) {
    const ca = (a.checklist && a.checklist.config) || { criteria: [] };
    const cb = (b.checklist && b.checklist.config) || { criteria: [] };
    const ids = [...(ca.criteria || []).map((c) => c.id)];
    for (const c of cb.criteria || []) if (!ids.includes(c.id)) ids.push(c.id);
    const sa = (a.final && a.final.score) || (a.result && a.result.score) || {};
    const sb = (b.final && b.final.score) || (b.result && b.result.score) || {};
    const va = (a.final && a.final.values) || {};
    const vb = (b.final && b.final.values) || {};
    const ra = (a.result && a.result.criteria) || {};
    const rb = (b.result && b.result.criteria) || {};

    const head = (e, s) => h('div', { class: 'compare__col' },
      h('div', { class: 'compare__name' }, `Оценка №${e.id}`),
      h('div', { class: 'muted' }, `${e.checklist_name || ''}, версия ${e.checklist_version ?? '—'}`),
      h('div', { class: 'muted' }, fmt.date(e.finished_at || e.created_at)),
      h('div', { class: ['compare__total', `tone-${scoreTone(e.final_total)}`] }, fmt.n2(isNum(e.final_total) ? e.final_total : s.total)));
    const dt = (isNum(b.final_total) && isNum(a.final_total)) ? b.final_total - a.final_total : null;

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
        if (xa.name !== xb.name) notes.push('переименован');
        if (Number(xa.weight) !== Number(xb.weight)) notes.push(`вес ${fmt.n2(xa.weight)} → ${fmt.n2(xb.weight)}`);
        if (xa.type !== xb.type) notes.push('изменён тип');
        if ((xa.description || '') !== (xb.description || '') || (xa.guidance || '') !== (xb.guidance || '') || (xa.na_condition || '') !== (xb.na_condition || '')) notes.push('изменено описание');
        if (JSON.stringify(xa.scale || []) !== JSON.stringify(xb.scale || [])) notes.push('изменена шкала');
      }
      const valueChanged = normValue(va[id] ?? (ra[id] || {}).value) !== normValue(vb[id] ?? (rb[id] || {}).value);
      const ptsDelta = isNum(pa.points) && isNum(pb.points) ? pb.points - pa.points : null;
      const isChanged = valueChanged || notes.length || (ptsDelta !== null && Math.abs(ptsDelta) > 0.004);
      if (isChanged) changes += 1;
      const c = xb || xa;
      tbody.append(h('tr', { class: isChanged ? 'is-changed' : '' },
        h('td', null, h('div', { class: 'compare__crit' }, h('span', { class: 'crit__code' }, c.code || id), h('span', null, xb && xa && xa.name !== xb.name ? `${xa.name} → ${xb.name}` : c.name)),
          notes.length ? h('div', { class: 'compare__notes' }, notes.map((n) => h('span', { class: 'chip chip--info' }, n))) : null),
        h('td', null, xa ? valueBadge(xa, va[id] ?? (ra[id] || {}).value) : h('span', { class: 'muted' }, 'нет')),
        h('td', { class: 'num' }, xa && !pa.is_flag ? fmt.n2(pa.points) : '—'),
        h('td', null, xb ? valueBadge(xb, vb[id] ?? (rb[id] || {}).value) : h('span', { class: 'muted' }, 'нет')),
        h('td', { class: 'num' }, xb && !pb.is_flag ? fmt.n2(pb.points) : '—'),
        h('td', { class: ['num', ptsDelta > 0.004 && 'delta-up', ptsDelta < -0.004 && 'delta-down'] }, ptsDelta === null ? '—' : `${ptsDelta > 0 ? '+' : ''}${fmt.n2(ptsDelta)}`)));
    }
    return h('div', null,
      h('div', { class: 'compare__heads' }, head(a, sa),
        h('div', { class: 'compare__delta' },
          h('div', { class: ['compare__delta-num', dt > 0.004 && 'delta-up', dt < -0.004 && 'delta-down'] }, dt === null ? '—' : `${dt > 0 ? '+' : ''}${fmt.n2(dt)}`),
          h('div', { class: 'muted' }, `изменилось критериев: ${changes}`)),
        head(b, sb)),
      h('table', { class: 'table table--compact' },
        h('thead', null, h('tr', null, h('th', null, 'Критерий'), h('th', null, `№${a.id}`), h('th', { class: 'num' }, 'Баллы'), h('th', null, `№${b.id}`), h('th', { class: 'num' }, 'Баллы'), h('th', { class: 'num' }, 'Разница'))),
        tbody));
  }

  /* ---------- технические детали ---------- */
  function techDetails(ev, config) {
    const u = ev.usage || {};
    const st = ev.settings || {};
    const runs = (ev.result && ev.result.runs) || [];
    const crits = config.criteria || [];
    const finalVals = (ev.result && ev.result.criteria) || {};
    const kv = (k, v) => h('div', { class: 'kv' }, h('dt', null, k), h('dd', null, v));
    const providers = [...new Set(runs.map((r) => r.provider).filter(Boolean))].join(', ') || st.provider || '—';

    const runTable = h('table', { class: 'table table--compact table--runs' },
      h('thead', null, h('tr', null,
        h('th', null, 'Прогон'), h('th', null, 'Модель'), h('th', { class: 'num' }, 'Время'), h('th', { class: 'num' }, 'Стоимость'),
        h('th', { class: 'num' }, 'Токены вход / выход'),
        crits.map((c) => h('th', { class: 'num', 'data-tip': c.name }, c.code || c.id)))),
      h('tbody', null, runs.map((r, i) => h('tr', { class: r.error ? 'is-error' : '' },
        h('td', null, `№${i + 1}`),
        h('td', null, r.model || '—'),
        h('td', { class: 'num' }, fmt.duration(r.duration_ms)),
        h('td', { class: 'num' }, fmt.money(r.cost_usd)),
        h('td', { class: 'num' }, r.usage ? `${fmt.tokens(r.usage.input_tokens)} / ${fmt.tokens(r.usage.output_tokens)}` : '—'),
        r.error
          ? h('td', { colspan: crits.length, class: 'run-error' }, r.error)
          : crits.map((c) => {
            const v = r.values ? r.values[c.id] : undefined;
            const diff = v !== undefined && normValue(v) !== normValue((finalVals[c.id] || {}).value);
            return h('td', { class: ['num', diff && 'cell-diff'], 'data-tip': diff ? 'Голос расходится с итоговым значением' : null }, v === undefined ? '—' : normValue(v) === 'NA' ? 'N/A' : normValue(v) === 'YES' ? 'Да' : normValue(v) === 'NO' ? 'Нет' : String(v));
          })))));

    const factsBox = h('div', { class: 'facts' },
      kv('Эскалация на оператора', isNum(facts.escalation_turn) ? `T${facts.escalation_turn}` : '—'),
      kv('Первая реплика оператора', isNum(facts.first_operator_turn) ? `T${facts.first_operator_turn}` : '—'),
      kv('Первый ответ', isNum(facts.first_response_s) ? `${fmt.int(facts.first_response_s)} с${facts.first_response_ok === false ? ' (превышен порог)' : ''}` : '—'),
      kv('Долгие ожидания клиента', Array.isArray(facts.long_waits) ? String(facts.long_waits.length) : '—'),
      kv('Реплик оператора / клиента', `${fmt.int(facts.operator_turns)} / ${fmt.int(facts.client_turns)}`),
      kv('Реплик на удержании', Array.isArray(facts.hold_turns) ? String(facts.hold_turns.length) : '—'));

    return h('details', { class: 'card tech' },
      h('summary', null, icon('cog', 16), h('span', null, 'Технические детали оценки'),
        h('span', { class: 'tech__sum' }, `${ev.model || st.model || ''}, ${runs.length} ${plural(runs.length, 'прогон', 'прогона', 'прогонов')}, ${fmt.money(ev.cost_usd)}, ${fmt.duration(ev.duration_ms)}`)),
      h('div', { class: 'tech__body' },
        h('dl', { class: 'kv-grid' },
          kv('Модель', ev.model || st.model || '—'),
          kv('Провайдер', providers),
          kv('Прогонов (голосов)', String(st.votes ?? runs.length)),
          kv('Уровень рассуждений', st.effort || '—'),
          kv('Токены на входе', fmt.tokens(u.input_tokens)),
          kv('Токены на выходе', fmt.tokens(u.output_tokens)),
          kv('Чтение из кэша', fmt.tokens(u.cache_read_input_tokens)),
          kv('Запись в кэш', fmt.tokens(u.cache_creation_input_tokens)),
          kv('Стоимость', fmt.money(ev.cost_usd)),
          kv('Длительность', fmt.duration(ev.duration_ms)),
          kv('Создана', fmt.date(ev.created_at)),
          kv('Завершена', fmt.date(ev.finished_at)),
          kv('ID оценки', `№${ev.id}`),
          kv('ID чек-листа', ev.checklist_id != null ? String(ev.checklist_id) : '—')),
        h('h4', { class: 'tech__sub' }, 'Голоса по прогонам'),
        runs.length ? h('div', { class: 'table-scroll' }, runTable) : h('p', { class: 'muted' }, 'Данных по прогонам нет'),
        h('h4', { class: 'tech__sub' }, 'Факты, вычисленные из транскрипта до вызова модели'),
        factsBox));
  }

  /* ---------- графические элементы ---------- */
  function sectionBars(sections) {
    if (!sections.length) return null;
    return h('div', { class: 'sections' }, sections.map((s) => {
      const pct = isNum(s.percent) ? s.percent : null;
      return h('div', { class: 'section-bar' },
        h('div', { class: 'section-bar__head' },
          h('span', null, s.name),
          h('span', { class: 'section-bar__val' }, isNum(s.max_points) && s.max_points > 0 ? `${fmt.n2(s.points)} / ${fmt.n2(s.max_points)}` : 'N/A')),
        h('div', { class: 'section-bar__track' },
          h('div', { class: ['section-bar__fill', `tone-bg-${scoreTone(pct)}`], style: { width: `${pct ?? 0}%` } })));
    }));
  }

  show(currentId, { push: false });

  return () => {
    destroyed = true;
    if (pollTimer) clearTimeout(pollTimer);
  };
}

export function scoreRing(total, max = 100) {
  const NS = 'http://www.w3.org/2000/svg';
  const size = 132;
  const r = 56;
  const c = 2 * Math.PI * r;
  const frac = isNum(total) ? Math.max(0, Math.min(1, total / (max || 100))) : 0;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const mk = (cls, dash) => {
    const el = document.createElementNS(NS, 'circle');
    el.setAttribute('cx', size / 2);
    el.setAttribute('cy', size / 2);
    el.setAttribute('r', r);
    el.setAttribute('class', cls);
    if (dash !== undefined) {
      el.setAttribute('stroke-dasharray', `${c}`);
      el.setAttribute('stroke-dashoffset', `${c}`);
      el.style.setProperty('--ring-target', `${c * (1 - dash)}`);
      el.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
    }
    return el;
  };
  svg.append(mk('ring__track'), mk('ring__value', frac));
  const wrap = h('div', { class: ['ring', `ring--${scoreTone(total)}`], role: 'img', 'aria-label': isNum(total) ? `Итог ${fmt.n2(total)} из 100` : 'Итог не рассчитан' },
    svg,
    h('div', { class: 'ring__center' },
      h('div', { class: 'ring__num' }, isNum(total) ? fmt.n2(total) : '—'),
      h('div', { class: 'ring__of' }, isNum(total) ? 'из 100' : 'нет применимых')));
  setTimeout(() => wrap.classList.add('is-drawn'), 40);
  return wrap;
}
