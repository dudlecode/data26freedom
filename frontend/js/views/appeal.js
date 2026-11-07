// Апелляция: фрагмент диалога с подсвеченными основаниями слева, справа разделы через линейки:
// критерий, оценка ИИ, апелляция, второе мнение ИИ, решение проверяющего, итог и история.

import { api, audioUrl } from '../api.js';
import {
  h, clear, icon, button, fmt, isNum, toast, toastError, dotted, withBusy, field, select, append, confirmDialog,
  valueBadge, valueLabel, normValue, allowedValues, scaleSteps, linkifyTurns, emptyState, errorState, skeleton,
  pageHeader, TYPE_LABELS, stripLead, isPhone, isTouch, reducedMotion,
} from '../ui.js';
import { renderTranscript } from '../transcript.js';
import { can } from '../session.js';

export async function mount(root, { params, ctx }) {
  const id = params.id;
  ctx.setTitle(`Апелляция №${id}`);
  let destroyed = false;
  let justDecided = false;

  async function load() {
    clear(root).append(pageHeader({ title: `Апелляция №${id}`, back: { href: '#/appeals', label: 'Апелляции' } }),
      h('div', { class: 'content' }, h('div', { class: 'panel' }, skeleton(8))));
    let data;
    try {
      data = await api.appeal(id);
    } catch (e) {
      clear(root).append(pageHeader({ title: `Апелляция №${id}`, back: { href: '#/appeals', label: 'Апелляции' } }),
        h('div', { class: 'content' }, h('div', { class: 'panel' }, errorState(e, load))));
      return;
    }
    if (destroyed) return;
    let siblings = [];
    try {
      const full = await api.evaluation(data.appeal.evaluation_id);
      siblings = (full.appeals || []).filter((a) => a.id !== data.appeal.id);
    } catch { /* другие апелляции необязательны */ }
    if (destroyed) return;
    render(data, siblings);
  }

  function render({ appeal: initial, evaluation, criterion, fragment, has_audio: hasAudio }, siblings) {
    clear(root);
    let appeal = initial;
    const c = criterion || { id: appeal.criterion_id, name: appeal.criterion_name, type: 'binary' };
    const original = appeal.original || {};
    const isOpen = appeal.status === 'open';
    const dialogHref = `#/dialog/${encodeURIComponent(appeal.dialog_id)}?eval=${appeal.evaluation_id}`;
    let turns = [...(fragment || [])];

    /* транскрипт фрагмента */
    const trOpts = { collapsePre: false, audioSrc: hasAudio ? audioUrl(appeal.dialog_id) : null, idPrefix: 'aturn-' };
    let tr = renderTranscript(turns, trOpts);
    const trHolder = h('div', { style: { display: 'contents' } }, tr.el);
    const pinEvidence = () => {
      const ev = new Set([...(original.evidence_turns || []), ...((appeal.ai_opinion && appeal.ai_opinion.evidence_turns) || [])]);
      const range = Array.isArray(original.checked_range) && original.checked_range.length === 2 ? original.checked_range : null;
      tr.setPinned(ev.size || range ? { turns: [...ev], range } : null);
    };
    const goTurn = (from, to = from) => {
      // телефон: ссылка T# раскрывает свёрнутый фрагмент и прокручивает страницу к нему
      if (isPhone()) {
        setFrag(true);
        fragPane.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
      if (!tr.focusTurns(from, to)) toast(`Реплика T${from + 1} вне фрагмента. Откройте диалог целиком.`, 'info');
    };
    const linkify = (text) => linkifyTurns(text, { onTurn: goTurn, preview: (i) => tr.turnText(i) });
    const chips = (list) => ((list || []).length
      ? h('div', { class: 'chips' }, list.map((t) => h('button', { type: 'button', class: 'chip', 'data-tip': tr.turnText(t), onclick: () => goTurn(t) }, `T${t + 1}`)))
      : null);

    async function refreshFragment(op) {
      const shown = new Set(turns.map((t) => t.idx));
      if (!op || !(op.evidence_turns || []).some((i) => !shown.has(i))) return;
      try {
        const fresh = await api.appeal(appeal.id);
        if (destroyed || !fresh || !Array.isArray(fresh.fragment) || !fresh.fragment.length) return;
        turns = [...fresh.fragment];
        tr = renderTranscript(turns, trOpts);
        clear(trHolder).append(tr.el);
      } catch { /* фрагмент обновится при следующем открытии */ }
    }

    /* шапка */
    const status = isOpen
      ? h('span', { class: 'badge badge--partial' }, 'На рассмотрении')
      : h('span', { class: 'badge badge--na' }, appeal.decision === 'changed' ? 'Решена, оценка изменена' : 'Решена, оценка подтверждена');
    root.append(pageHeader({
      title: [`Апелляция №${appeal.id}`, status],
      back: { href: '#/appeals', label: 'Апелляции' },
      meta: dotted([
        `Диалог ${appeal.dialog_id}`,
        `${c.code ? `${c.code} ` : ''}${c.name || appeal.criterion_name}`,
        evaluation ? `чек-лист v${evaluation.checklist_version}` : null,
        evaluation && isNum(evaluation.final_total) ? `итог оценки №${evaluation.id} ${fmt.n2(evaluation.final_total)}` : null,
      ]),
    }));

    const side = h('div', { class: 'pane__scroll' });
    /* телефон: фрагмент свёрнут до строки заголовка, разделы апелляции идут друг под другом */
    const fragToggle = h('button', { type: 'button', class: 'icon-btn frag__toggle', 'aria-controls': `frag-${appeal.id}`, onclick: () => setFrag(fragPane.classList.contains('is-collapsed')) }, icon('chevronDown', 16));
    const fragPane = h('section', { class: 'pane pane--frag is-collapsed', id: `frag-${appeal.id}`, 'aria-label': 'Фрагмент диалога' },
      h('div', { class: 'panel__head' },
        h('h2', { class: 'panel__title' }, 'Фрагмент диалога'),
        h('span', { class: 'frag__tools' },
          h('a', { href: dialogHref, class: 't-13 frag__open', style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } }, 'Открыть диалог', icon('external', 16)),
          turns.length ? fragToggle : null)),
      turns.length ? trHolder : emptyState({ title: 'Фрагмент не получен', text: 'Откройте диалог, чтобы увидеть контекст.' }));
    function setFrag(open) {
      fragPane.classList.toggle('is-collapsed', !open);
      fragToggle.setAttribute('aria-expanded', String(open));
      const label = open ? 'Свернуть фрагмент' : 'Показать фрагмент';
      fragToggle.setAttribute('aria-label', label);
      fragToggle.dataset.tip = label;
    }
    setFrag(false);
    root.append(h('div', { class: 'split split--appeal' }, fragPane, h('section', { class: 'pane', 'aria-label': 'Апелляция' }, side)));
    pinEvidence();

    /* итог решения сверху: сразу видно, чем закончилось */
    if (!isOpen) side.append(outcomeStrip(appeal, c, original));

    /* критерий */
    const steps = c.type === 'scale' ? scaleSteps(c) : [];
    side.append(h('section', { class: 'sect' },
      h('div', { class: 'sect__head' }, h('h2', { class: 'sect__title' }, 'Критерий')),
      h('p', { class: 'strong' }, `${c.code ? `${c.code} ` : ''}${c.name}`),
      h('p', { class: 't-13 t-2', style: { marginTop: '2px' } }, dotted([
        TYPE_LABELS[c.type] || c.type,
        c.type !== 'flag' && isNum(Number(c.weight)) ? `вес ${fmt.n2(Number(c.weight))}` : null,
        c.na_allowed ? 'Н/П разрешён' : null,
      ])),
      c.description ? h('p', { class: 'rule', style: { marginTop: '8px' } }, c.description) : null,
      steps.length ? h('ol', { class: 'scale' }, steps.map((s) => h('li', { class: normValue(s.value) === normValue(original.value) ? 'is-current' : '' },
        h('b', null, String(s.value)), h('span', null, s.label || '')))) : null,
      c.na_allowed && c.na_condition ? h('p', { class: 't-13', style: { marginTop: '8px' } }, h('span', { class: 't-2' }, 'Н/П, если: '), c.na_condition) : null));

    /* оценка ИИ */
    side.append(h('section', { class: 'sect' },
      h('div', { class: 'sect__head' }, h('h2', { class: 'sect__title' }, 'Оценка ИИ'),
        h('span', { class: 'factions' }, valueBadge(c, original.value), isNum(original.points) ? h('span', { class: 't-13' }, `${fmt.n2(original.points)} балла`) : null)),
      original.reasoning ? h('p', { class: 'reason' }, linkify(stripLead(original.reasoning, c))) : h('p', { class: 't-2' }, 'Обоснование не сохранено'),
      chips(original.evidence_turns)));

    /* апелляция */
    side.append(h('section', { class: 'sect' },
      h('div', { class: 'sect__head' }, h('h2', { class: 'sect__title' }, 'Апелляция')),
      h('blockquote', { class: 'quote' }, linkify(appeal.comment || '')),
      h('p', { class: 'byline' }, dotted([appeal.author || 'Автор не указан', fmt.date(appeal.created_at)]))));

    /* второе мнение ИИ */
    const aiBox = h('section', { class: 'sect' });
    let decisionApi = null;
    function renderAi(op) {
      clear(aiBox);
      const btn = button(op ? 'Запросить снова' : 'Получить второе мнение', {
        kind: 'secondary', size: 'sm', tip: 'ИИ повторно оценит только этот критерий с учётом апелляции, около $0,03',
        onClick: (e) => withBusy(e.currentTarget, async () => {
          if (op) {
            const again = await confirmDialog({
              title: 'Запросить второе мнение ещё раз?',
              message: 'Это новый платный вызов модели, около $0,03. Текущее мнение заменится новым.',
              confirmLabel: 'Запросить',
              cancelLabel: 'Отмена',
            });
            if (!again) return;
          }
          clear(body).append(h('p', { class: 't-2' }, 'ИИ перечитывает диалог и комментарий'));
          try {
            const r = await api.aiReview(appeal.id);
            appeal = r.appeal || appeal;
            await refreshFragment(appeal.ai_opinion);
            renderAi(appeal.ai_opinion);
            pinEvidence();
          } catch (err) {
            toastError(err, 'Второе мнение не получено');
            renderAi(op);
          }
        }),
      });
      const body = h('div');
      aiBox.append(h('div', { class: 'sect__head' }, h('h2', { class: 'sect__title' }, 'Второе мнение ИИ'), isOpen && can('review') ? btn : null), body);
      if (!op) {
        body.append(h('p', { class: 't-2' }, isOpen ? (can('review') ? 'Не запрашивалось. ИИ повторно оценит только этот критерий с учётом комментария.' : 'Не запрашивалось.') : 'Не запрашивалось до решения.'));
        return;
      }
      append(body, [
        h('div', { class: 'verdict' },
          valueBadge(c, op.value),
          h('span', { class: ['strong', op.appeal_valid ? 't-ok' : ''] }, op.appeal_valid ? 'Апелляция обоснована' : 'Апелляция не обоснована'),
          h('span', { class: 't-13 t-2' }, normValue(op.value) !== normValue(original.value) ? `первичная оценка: ${valueLabel(c, original.value)}` : 'совпадает с первичной оценкой')),
        op.reasoning ? h('p', { class: 'reason' }, linkify(op.reasoning)) : null,
        chips(op.evidence_turns),
        op.recommendation ? h('p', { class: 'reason', style: { marginTop: '8px' } }, h('span', { class: 'strong' }, 'Рекомендация: '), linkify(op.recommendation)) : null,
        h('p', { class: 'byline' }, dotted([op.model, isNum(op.cost_usd) ? fmt.money(op.cost_usd) : null]))]);
      if (decisionApi) decisionApi.offerAi(op);
    }

    /* решение */
    const decisionBox = h('section', { class: 'sect' });
    side.append(aiBox, decisionBox);
    if (isOpen && can('review')) decisionApi = renderForm(decisionBox, appeal, c, original);
    else if (isOpen) {
      decisionBox.append(h('div', { class: 'sect__head' }, h('h2', { class: 'sect__title' }, 'Решение')),
        h('p', { class: 'await' }, icon('appeals', 16), 'Ожидает решения проверяющего.'));
    } else renderDecision(decisionBox, appeal, c, original, linkify);
    renderAi(appeal.ai_opinion);

    /* история */
    const events = [{ at: appeal.created_at, text: `Подана: ${appeal.author || 'супервайзер'}` }];
    if (appeal.ai_opinion) events.push({ at: appeal.ai_opinion.created_at || appeal.ai_opinion.at || null, text: `Второе мнение ИИ: ${valueLabel(c, appeal.ai_opinion.value)}, ${appeal.ai_opinion.appeal_valid ? 'обоснована' : 'не обоснована'}` });
    if (!isOpen) events.push({ at: appeal.decided_at, text: `${appeal.reviewer || 'Проверяющий'}: ${appeal.decision === 'changed' ? `оценка изменена на «${valueLabel(c, appeal.decision_value)}»` : 'оценка подтверждена'}` });
    side.append(h('section', { class: 'sect' },
      h('div', { class: 'sect__head' }, h('h2', { class: 'sect__title' }, 'История')),
      h('ul', { class: 'hist' }, events.map((e) => h('li', null, h('span', null, e.at ? fmt.date(e.at) : ''), h('span', null, e.text)))),
      siblings.length ? h('div', { style: { marginTop: '12px' } },
        h('div', { class: 'tech__sub' }, 'Другие апелляции по этой оценке'),
        h('ul', { class: 'hist' }, siblings.map((s) => h('li', null,
          h('span', null, h('a', { href: `#/appeal/${s.id}` }, `№${s.id}`)),
          h('span', null, `${s.criterion_name || s.criterion_id}, ${s.status === 'open' ? 'на рассмотрении' : s.decision === 'changed' ? 'изменена' : 'подтверждена'}`))))) : null));
  }

  function renderForm(box, appeal, c, original) {
    const allowed = can('review');
    const name = `decision-${appeal.id}`;
    const rConfirm = h('input', { type: 'radio', name, value: 'confirm', checked: true, disabled: !allowed });
    const rChange = h('input', { type: 'radio', name, value: 'change', disabled: !allowed });
    const options = allowedValues(c).filter((v) => normValue(v) !== normValue(original.value));
    const valueSel = select(options.map((v) => ({ value: v, label: valueLabel(c, v) })), options[0], { disabled: true, 'aria-label': 'Новое значение' });
    const reason = h('textarea', { class: 'input', rows: 4, required: true, disabled: !allowed });
    const msg = h('span', { class: 'inline-msg', role: 'status' });
    const aiHint = h('div');
    const valueField = field('Новое значение', valueSel);
    let lastOp = null;
    const sync = () => {
      valueSel.disabled = !allowed || !rChange.checked;
      valueField.hidden = !rChange.checked;
      reason.placeholder = rChange.checked
        ? 'Почему исходная оценка неверна. Ссылайтесь на реплики T#.'
        : 'Почему исходная оценка верна. Ссылайтесь на реплики T#.';
      paintHint();
    };
    rConfirm.addEventListener('change', sync);
    rChange.addEventListener('change', sync);

    const submit = button('Сохранить решение', {
      kind: 'primary',
      onClick: (e) => withBusy(e.currentTarget, async () => {
        msg.className = 'inline-msg';
        msg.textContent = '';
        const action = rChange.checked ? 'change' : 'confirm';
        if (!reason.value.trim()) { msg.classList.add('is-error'); msg.textContent = 'Укажите причину решения.'; reason.focus(); return; }
        if (action === 'change' && !valueSel.value) { msg.classList.add('is-error'); msg.textContent = 'Выберите новое значение.'; return; }
        // какой станет итог: сервер пересчитывает по правилам чек-листа, без записи и без модели
        let totalNote = 'Итог диалога не изменится.';
        if (action === 'change') {
          totalNote = 'Итог диалога пересчитается.';
          try {
            const p = await api.previewDecision(appeal.id, valueSel.value);
            if (isNum(p.total_after) && isNum(p.total_before)) {
              const d = p.total_after - p.total_before;
              totalNote = Math.abs(d) < 0.005 ? `Итог диалога не изменится: ${fmt.n2(p.total_after)}.`
                : `Итог диалога станет ${fmt.n2(p.total_after)} (${d > 0 ? '+' : ''}${fmt.n2(d)}).`;
            }
            if (p.gross_after && !p.gross_before) totalNote += ' Появится грубая ошибка.';
            if (!p.gross_after && p.gross_before) totalNote += ' Грубая ошибка снимется.';
          } catch { /* предпросмотр необязателен */ }
        }
        const ok = await confirmDialog({
          title: action === 'change' ? `Изменить на «${valueLabel(c, valueSel.value)}»?` : `Подтвердить «${valueLabel(c, original.value)}»?`,
          message: `${totalNote} Решение по апелляции нельзя отменить.`,
          confirmLabel: 'Сохранить решение',
          cancelLabel: 'Вернуться',
        });
        if (!ok) return;
        try {
          const body = { action, reason: reason.value.trim() };
          if (action === 'change') body.value = valueSel.value;
          const r = await api.decide(appeal.id, body);
          toast(isNum(r.final_total) ? `Решение сохранено. Итог диалога ${fmt.n2(r.final_total)}` : 'Решение сохранено', 'success');
          ctx.refreshBadges();
          justDecided = true;
          load();
        } catch (err) {
          msg.classList.add('is-error');
          msg.textContent = err.message;
        }
      }),
    });

    reason.addEventListener('input', () => { if (reason.value.trim() && msg.classList.contains('is-error')) { msg.className = 'inline-msg'; msg.textContent = ''; } });
    reason.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit.click(); } });
    box.append(
      h('div', { class: 'sect__head' }, h('h2', { class: 'sect__title' }, 'Решение'), isTouch() ? null : h('span', { class: 't-12 t-2' }, 'Ctrl+Enter сохраняет')),
      h('div', { class: 'fstack' },
        h('div', { class: 'radios', role: 'radiogroup', 'aria-label': 'Решение' },
          h('label', { class: ['check-row', !allowed && 'is-disabled'] }, rConfirm, `Подтвердить «${valueLabel(c, original.value)}»`),
          h('label', { class: ['check-row', !allowed && 'is-disabled'] }, rChange, 'Изменить')),
        valueField,
        aiHint,
        field('Причина', reason),
        h('div', { class: 'factions' }, submit, msg)));
    sync();

    function paintHint() {
      clear(aiHint);
      const op = lastOp;
      if (!allowed || !op) return;
        const differs = normValue(op.value) !== normValue(original.value) && options.map(normValue).includes(normValue(op.value));
        const useReason = () => {
          if (!reason.value.trim()) reason.value = op.recommendation || op.reasoning || '';
          reason.dispatchEvent(new Event('input'));
          reason.focus();
        };
        if (differs) {
          aiHint.append(h('button', {
            type: 'button', class: 'link-btn t-13',
            onclick: () => {
              rChange.checked = true;
              valueSel.value = options.find((v) => normValue(v) === normValue(op.value));
              sync();
              useReason();
            },
          }, `Взять значение второго мнения: «${valueLabel(c, op.value)}»`));
        } else if ((op.recommendation || op.reasoning) && rConfirm.checked) {
          aiHint.append(h('button', {
            type: 'button', class: 'link-btn t-13',
            onclick: () => { rConfirm.checked = true; sync(); useReason(); },
          }, 'Взять рекомендацию ИИ как причину'));
        }
    }

    return {
      offerAi(op) {
        lastOp = op || null;
        paintHint();
      },
    };
  }

  function renderDecision(box, appeal, c, original, linkify) {
    append(box, [
      h('div', { class: 'sect__head' }, h('h2', { class: 'sect__title' }, 'Причина решения')),
      appeal.decision_reason ? h('blockquote', { class: 'quote' }, linkify(appeal.decision_reason)) : h('p', { class: 't-2' }, 'Причина не указана.'),
      h('p', { class: 'byline' }, dotted([appeal.reviewer || 'Проверяющий', fmt.date(appeal.decided_at)]))]);
    justDecided = false;
  }

  function outcomeStrip(appeal, c, original) {
    const changed = appeal.decision === 'changed';
    const hasTotals = isNum(appeal.total_before) && isNum(appeal.total_after);
    const moved = hasTotals && Math.abs(appeal.total_after - appeal.total_before) > 0.004;
    return h('section', { class: ['outcome', changed && 'outcome--changed'], role: 'status' },
      h('p', { class: 'outcome__title' }, changed
        ? `Оценка изменена: было «${valueLabel(c, original.value)}», стало «${valueLabel(c, appeal.decision_value)}»`
        : `Оценка ИИ подтверждена: «${valueLabel(c, original.value)}»`),
      hasTotals ? h('p', { class: 'outcome__total' }, 'Итог диалога ',
        moved ? [`был ${fmt.n2(appeal.total_before)}, стал `, newTotal(appeal.total_before, appeal.total_after)] : ['не изменился: ', h('b', null, fmt.n2(appeal.total_after))]) : null,
      h('p', { class: 'byline' }, dotted([appeal.reviewer || 'Проверяющий', fmt.date(appeal.decided_at)])));
  }

  /** Новый итог виден сразу; после решения он коротко подсвечивается (прежний уже назван словом «был»). */
  function newTotal(before, after) {
    return h('b', { class: justDecided ? 'num-flash' : null }, fmt.n2(after));
  }

  await load();
  return () => { destroyed = true; };
}
