// Рабочее место проверяющего: критерий, оценка ИИ, апелляция, фрагмент диалога,
// второе мнение ИИ и решение с пересчётом итога.

import { api, audioUrl } from '../api.js';
import {
  h, append, clear, icon, button, fmt, isNum, prefs, toast, toastError, roleAction, valueBadge, valueLabel, normValue,
  allowedValues, scaleSteps, linkifyTurns, emptyState, errorState, skeleton, field, plural, TYPE_LABELS,
} from '../ui.js';
import { renderTranscript } from '../transcript.js';

export async function mount(root, { params, ctx }) {
  const id = params.id;
  ctx.setTitle(`Апелляция №${id}`);
  let destroyed = false;

  async function load() {
    clear(root).append(h('div', { class: 'card pad' }, skeleton(10)));
    let data;
    try {
      data = await api.appeal(id);
    } catch (e) {
      clear(root).append(errorState(e, load));
      return;
    }
    if (destroyed) return;
    let siblings = [];
    try {
      const full = await api.evaluation(data.appeal.evaluation_id);
      siblings = (full.appeals || []).filter((a) => a.id !== data.appeal.id);
    } catch { /* история других апелляций необязательна */ }
    if (destroyed) return;
    render(data, siblings);
  }

  function render({ appeal, evaluation, criterion, fragment, has_audio: hasAudio }, siblings) {
    clear(root);
    const c = criterion || { id: appeal.criterion_id, name: appeal.criterion_name, type: 'binary' };
    const original = appeal.original || {};
    const turns = [...(fragment || [])];
    const evidence = new Set(original.evidence_turns || []);
    // для звонков — плеер и кнопки воспроизведения реплик фрагмента (ошибки распознавания — частая причина апелляции)
    const trOpts = { collapsePre: false, highlight: evidence, compact: true, audioSrc: hasAudio ? audioUrl(appeal.dialog_id) : null };
    let tr = renderTranscript(turns, trOpts);
    const trHolder = h('div', { class: 'scroll-pane' }, tr.el);
    /** второе мнение ИИ может сослаться на реплики вне фрагмента — сервер добавит их при новом запросе */
    async function refreshFragment(op) {
      const shown = new Set(turns.map((t) => t.idx));
      if (!op || !(op.evidence_turns || []).some((i) => !shown.has(i))) return;
      try {
        const fresh = await api.appeal(appeal.id);
        if (destroyed || !fresh || !Array.isArray(fresh.fragment) || !fresh.fragment.length) return;
        turns.splice(0, turns.length, ...fresh.fragment);
        tr = renderTranscript(turns, trOpts);
        clear(trHolder).append(tr.el);
      } catch { /* фрагмент обновится при следующем открытии */ }
    }
    const dialogHref = `#/dialog/${encodeURIComponent(appeal.dialog_id)}?eval=${appeal.evaluation_id}`;

    const goTurn = (from, to = from) => {
      if (!tr.focusTurns(from, to, { seekAudio: false })) {
        toast(`Реплика T${from} вне показанного фрагмента. Откройте весь диалог.`, 'info');
      }
    };
    const linkify = (text) => linkifyTurns(text, { onTurn: goTurn, preview: (i) => tr.turnText(i) });
    const turnChips = (list) => (list || []).length
      ? h('div', { class: 'evidence' }, h('span', { class: 'evidence__label' }, 'Реплики'),
        list.map((t) => h('button', { type: 'button', class: 'turn-chip', 'data-tip': tr.turnText(t), onclick: () => goTurn(t) }, `T${t}`)))
      : null;

    const isOpen = appeal.status === 'open';

    /* шапка */
    root.append(h('div', { class: 'page-head' },
      h('div', null,
        h('a', { class: 'back-link', href: '#/appeals' }, icon('chevron', 14, 'icon--flip'), 'Все апелляции'),
        h('h1', { class: 'page-title' }, `Апелляция №${appeal.id}: ${c.name || appeal.criterion_name}`),
        h('div', { class: 'meta-row' },
          isOpen ? h('span', { class: 'chip chip--warn' }, icon('clock', 12), 'На рассмотрении')
            : h('span', { class: ['chip', appeal.decision === 'changed' ? 'chip--info' : 'chip--ok'] }, appeal.decision === 'changed' ? 'Оценка изменена' : 'Оценка подтверждена'),
          h('span', { class: 'meta-chip' }, `Диалог ${appeal.dialog_id}`),
          evaluation && evaluation.checklist_name ? h('span', { class: 'meta-chip' }, `${evaluation.checklist_name}, версия ${evaluation.checklist_version}`) : null,
          evaluation && isNum(evaluation.final_total) ? h('span', { class: 'meta-chip' }, `Итог диалога сейчас: ${fmt.n2(evaluation.final_total)}`) : null)),
      h('div', { class: 'page-head__actions' },
        h('a', { class: 'btn btn--secondary btn--sm', href: dialogHref }, icon('external', 14), h('span', null, 'Открыть весь диалог')))));

    const side = h('div', { class: 'appeal-side' });
    root.append(h('div', { class: 'dialog-grid dialog-grid--appeal' },
      h('section', { class: 'panel panel--transcript', 'aria-label': 'Фрагмент диалога' },
        h('div', { class: 'panel__head' },
          h('h2', { class: 'panel__title' }, 'Фрагмент диалога'),
          h('span', { class: 'muted' }, turns.length ? `${turns.length} ${plural(turns.length, 'реплика', 'реплики', 'реплик')}, доказательства выделены` : '')),
        turns.length ? trHolder : h('div', { class: 'pad' }, emptyState({ title: 'Фрагмент не получен', text: 'Откройте весь диалог, чтобы увидеть контекст.', iconName: 'chat' }))),
      side));

    /* критерий */
    const steps = c.type === 'scale' ? scaleSteps(c) : [];
    side.append(h('div', { class: 'card ws-card' },
      h('h3', { class: 'card__title' }, h('span', { class: 'crit__code' }, c.code || c.id), c.name),
      h('div', { class: 'meta-row' },
        h('span', { class: 'chip chip--muted' }, TYPE_LABELS[c.type] || c.type),
        c.type !== 'flag' ? h('span', { class: 'chip chip--muted' }, `вес ${fmt.n2(c.weight)}`) : null,
        c.na_allowed ? h('span', { class: 'chip chip--muted' }, 'N/A разрешён') : null),
      c.description ? h('p', { class: 'rule' }, c.description) : null,
      steps.length ? h('ol', { class: 'scale-list' }, steps.map((s) => h('li', { class: normValue(s.value) === normValue(original.value) ? 'is-current' : '' },
        h('span', { class: 'scale-list__v' }, String(s.value)), h('span', null, s.label || '')))) : null,
      c.na_allowed && c.na_condition ? h('p', { class: 'na-note' }, h('strong', null, 'N/A, если: '), c.na_condition) : null,
      c.guidance ? h('details', { class: 'mini-details' }, h('summary', null, 'Подсказка для ИИ'), h('p', { class: 'pre-wrap' }, c.guidance)) : null));

    /* оценка ИИ и апелляция */
    side.append(h('div', { class: 'card ws-card' },
      h('div', { class: 'ws-card__row' },
        h('h3', { class: 'card__title' }, icon('spark', 16), 'Оценка ИИ'),
        h('div', { class: 'ws-card__value' }, valueBadge(c, original.value, { size: 'lg' }),
          isNum(original.points) ? h('span', { class: 'metric metric--points' }, h('strong', null, fmt.n2(original.points)), ' балла') : null)),
      original.reasoning ? h('p', { class: 'crit__reason' }, linkify(original.reasoning)) : h('p', { class: 'muted' }, 'Обоснование не сохранено'),
      turnChips(original.evidence_turns)));

    side.append(h('div', { class: 'card ws-card ws-card--appeal' },
      h('h3', { class: 'card__title' }, icon('gavel', 16), 'Апелляция супервайзера'),
      h('blockquote', { class: 'quote' }, linkify(appeal.comment || '')),
      h('div', { class: 'muted small' }, `${appeal.author || 'Автор не указан'}, ${fmt.date(appeal.created_at)}`)));

    /* второе мнение ИИ */
    const aiBox = h('div', { class: 'card ws-card' });
    function renderAi(op) {
      clear(aiBox);
      const btn = button(op ? 'Запросить заново' : 'Второе мнение ИИ', {
        kind: op ? 'ghost' : 'secondary', iconName: 'spark', size: 'sm',
        tip: 'ИИ повторно оценит только этот критерий с учётом комментария апелляции (≈ $0,03)',
        onClick: async () => {
          btn.disabled = true;
          btn.classList.add('is-busy');
          clear(body).append(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), h('span', null, 'ИИ перечитывает диалог и комментарий…')));
          try {
            const r = await api.aiReview(appeal.id);
            appeal = r.appeal || appeal;
            await refreshFragment(appeal.ai_opinion);
            renderAi(appeal.ai_opinion);
          } catch (e) {
            toastError(e, 'Второе мнение не получено');
            renderAi(op);
          }
        },
      });
      roleAction(btn, 'reviewer');
      const body = h('div');
      // после решения второе мнение только для чтения: новый платный запрос не нужен и не меняет историю
      aiBox.append(h('div', { class: 'ws-card__row' }, h('h3', { class: 'card__title' }, icon('spark', 16), 'Второе мнение ИИ'), isOpen ? btn : null), body);
      if (!op) {
        body.append(h('p', { class: 'muted' }, isOpen
          ? 'Независимая перепроверка критерия с учётом аргументов апелляции. Помогает принять решение, но не заменяет его.'
          : 'Второе мнение ИИ по этой апелляции не запрашивалось.'));
        return;
      }
      append(body, [
        h('div', { class: 'ai-verdict' },
          valueBadge(c, op.value, { size: 'lg' }),
          h('span', { class: ['chip', op.appeal_valid ? 'chip--info' : 'chip--muted'] }, op.appeal_valid ? 'Апелляция обоснована' : 'Апелляция не обоснована'),
          normValue(op.value) !== normValue(original.value) ? h('span', { class: 'muted small' }, `иначе, чем первичная оценка (${valueLabel(c, original.value)})`) : h('span', { class: 'muted small' }, 'совпадает с первичной оценкой')),
        op.reasoning ? h('p', { class: 'crit__reason' }, linkify(op.reasoning)) : null,
        turnChips(op.evidence_turns),
        op.recommendation ? h('p', { class: 'recommend' }, h('strong', null, 'Рекомендация: '), linkify(op.recommendation)) : null,
        h('div', { class: 'muted small' }, [op.model, isNum(op.cost_usd) ? fmt.money(op.cost_usd) : null].filter(Boolean).join(', '))]);
      if (isOpen && decisionApi) decisionApi.offerAi(op);
    }

    /* решение */
    const decisionBox = h('div', { class: 'card ws-card ws-card--decision' });
    let decisionApi = null;
    side.append(aiBox, decisionBox);
    if (isOpen) decisionApi = renderForm(decisionBox, appeal, c, original);
    else renderDecision(decisionBox, appeal, c, original);
    renderAi(appeal.ai_opinion);

    /* история */
    const events = [{ at: appeal.created_at, text: `Апелляцию подал(а) ${appeal.author || 'супервайзер'}`, icon: 'gavel' }];
    if (appeal.ai_opinion) events.push({ at: null, text: `Получено второе мнение ИИ: ${valueLabel(c, appeal.ai_opinion.value)}`, icon: 'spark' });
    if (!isOpen) events.push({ at: appeal.decided_at, text: `${appeal.reviewer || 'Проверяющий'}: ${appeal.decision === 'changed' ? `оценка изменена на «${valueLabel(c, appeal.decision_value)}»` : 'оценка подтверждена'}`, icon: 'check' });
    side.append(h('div', { class: 'card ws-card' },
      h('h3', { class: 'card__title' }, icon('clock', 16), 'История'),
      h('ol', { class: 'timeline' }, events.map((e) => h('li', null, h('span', { class: 'timeline__dot' }, icon(e.icon, 12)),
        h('div', null, h('div', null, e.text), e.at ? h('div', { class: 'muted small' }, fmt.date(e.at)) : null)))),
      siblings.length ? h('div', { class: 'siblings' },
        h('h4', null, 'Другие апелляции по этой оценке'),
        siblings.map((s) => h('a', { class: 'sibling', href: `#/appeal/${s.id}` },
          h('span', null, `№${s.id}: ${s.criterion_name || s.criterion_id}`),
          h('span', { class: ['chip', s.status === 'open' ? 'chip--warn' : 'chip--muted'] }, s.status === 'open' ? 'открыта' : s.decision === 'changed' ? 'изменена' : 'подтверждена')))) : null));
  }

  function renderForm(box, appeal, c, original) {
    const name = `decision-${appeal.id}`;
    const rConfirm = h('input', { type: 'radio', name, value: 'confirm', checked: true });
    const rChange = h('input', { type: 'radio', name, value: 'change' });
    const options = allowedValues(c).filter((v) => normValue(v) !== normValue(original.value));
    const valueSel = h('select', { class: 'input', disabled: true, 'aria-label': 'Новое значение' },
      options.map((v) => h('option', { value: v }, valueLabel(c, v))));
    const reason = h('textarea', { class: 'input', rows: 4, required: true, placeholder: 'Почему вы подтверждаете или меняете оценку. Ссылайтесь на реплики T#.' });
    const reviewer = h('input', { class: 'input', value: prefs.get('name.reviewer', ''), placeholder: 'Имя проверяющего' });
    const aiHint = h('div');
    const sync = () => { valueSel.disabled = !rChange.checked; box.classList.toggle('is-change', rChange.checked); };
    rConfirm.addEventListener('change', sync);
    rChange.addEventListener('change', sync);

    const submit = button('Сохранить решение', {
      kind: 'primary', iconName: 'check',
      onClick: async () => {
        const action = rChange.checked ? 'change' : 'confirm';
        if (!reason.value.trim()) { toast('Укажите причину решения', 'error'); reason.focus(); return; }
        if (action === 'change' && !valueSel.value) { toast('Выберите новое значение', 'error'); return; }
        prefs.set('name.reviewer', reviewer.value.trim());
        submit.disabled = true;
        submit.classList.add('is-busy');
        try {
          const body = { action, reason: reason.value.trim() };
          if (action === 'change') body.value = valueSel.value;
          if (reviewer.value.trim()) body.reviewer = reviewer.value.trim();
          const r = await api.decide(appeal.id, body);
          const a = r.appeal || {};
          toast(isNum(r.final_total) ? `Решение сохранено. Итог диалога: ${fmt.n2(r.final_total)}` : 'Решение сохранено', 'success');
          ctx.refreshBadges();
          if (a.id) load();
        } catch (e) {
          toastError(e, 'Решение не сохранено');
        } finally {
          submit.disabled = false;
          submit.classList.remove('is-busy');
        }
      },
    });
    roleAction(submit, 'reviewer');

    box.append(
      h('h3', { class: 'card__title' }, icon('scale', 16), 'Решение проверяющего'),
      h('div', { class: 'radio-cards', role: 'radiogroup' },
        h('label', { class: 'radio-card' }, rConfirm, h('span', null, h('strong', null, 'Подтвердить оценку'), h('span', { class: 'muted small' }, `оставить «${valueLabel(c, original.value)}»`))),
        h('label', { class: 'radio-card' }, rChange, h('span', null, h('strong', null, 'Изменить оценку'), h('span', { class: 'muted small' }, 'выбрать другое значение')))),
      h('div', { class: 'form-stack' },
        field('Новое значение', valueSel, { cls: 'field--change' }),
        aiHint,
        field('Причина решения', reason, { hint: 'Обязательно. Будет показана в карточке диалога.' }),
        field('Проверяющий', reviewer)),
      h('div', { class: 'form-actions' }, submit));

    return {
      offerAi(op) {
        clear(aiHint);
        if (!op || normValue(op.value) === normValue(original.value) || !options.map(normValue).includes(normValue(op.value))) return;
        aiHint.append(h('button', {
          type: 'button', class: 'link-btn',
          onclick: () => {
            rChange.checked = true;
            valueSel.value = options.find((v) => normValue(v) === normValue(op.value));
            sync();
            if (!reason.value.trim() && op.recommendation) reason.value = op.recommendation;
            reason.focus();
          },
        }, icon('spark', 13), `Взять значение второго мнения ИИ: «${valueLabel(c, op.value)}»`));
      },
    };
  }

  function renderDecision(box, appeal, c, original) {
    const changed = appeal.decision === 'changed';
    const delta = isNum(appeal.total_before) && isNum(appeal.total_after) ? appeal.total_after - appeal.total_before : null;
    append(box, [
      h('h3', { class: 'card__title' }, icon('scale', 16), 'Решение проверяющего'),
      h('div', { class: 'decision-result' },
        h('div', { class: 'decision-result__values' },
          valueBadge(c, original.value, { size: 'lg' }),
          changed ? icon('chevron', 16) : null,
          changed ? valueBadge(c, appeal.decision_value, { size: 'lg' }) : h('span', { class: 'chip chip--ok' }, icon('check', 12), 'подтверждено')),
        h('div', { class: 'decision-result__total' },
          h('span', { class: 'muted' }, 'Итог диалога'),
          h('div', { class: 'value-move value-move--lg' }, fmt.n2(appeal.total_before), ' → ', h('strong', null, fmt.n2(appeal.total_after)),
            delta !== null && Math.abs(delta) > 0.004 ? h('span', { class: delta > 0 ? 'delta-up' : 'delta-down' }, ` ${delta > 0 ? '+' : ''}${fmt.n2(delta)}`) : null))),
      appeal.decision_reason ? h('blockquote', { class: 'quote' }, appeal.decision_reason) : null,
      h('div', { class: 'muted small' }, `${appeal.reviewer || 'Проверяющий'}, ${fmt.date(appeal.decided_at)}`)]);
  }

  await load();
  return () => { destroyed = true; };
}

