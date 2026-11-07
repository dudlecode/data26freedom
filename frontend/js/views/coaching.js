// Разбор для оператора: лист A4 по одной оценке. Что улучшить, замечания по критериям с цитатами,
// что выполнено, подписи. Печать (window.print, стили @media print) и копия текстом для мессенджера.

import { api } from '../api.js';
import {
  h, clear, icon, button, fmt, isNum, toast, emptyState, errorState, skeleton, pageHeader, linkifyTurns,
  channelLabel, LANG_LABELS, SPEAKERS, copyText, keysBlocked, rangeLabel,
} from '../ui.js';

export async function mount(root, { params, query, ctx }) {
  const dialogId = params.id;
  ctx.setTitle(`Разбор ${dialogId}`);
  let destroyed = false;
  let evalId = query.eval ? Number(query.eval) : null;
  const cardHref = () => `#/dialog/${encodeURIComponent(dialogId)}${evalId ? `?eval=${evalId}` : ''}`;
  const head = h('div');
  const box = h('div', { class: 'content sheet-wrap' }, h('div', { class: 'sheet' }, skeleton(14)));
  root.append(head, box);
  const renderHead = (actions) => clear(head).append(pageHeader({ title: `Разбор диалога ${dialogId}`, back: { href: cardHref(), label: 'Карточка диалога', kbd: 'Esc' }, actions }));
  renderHead(null);

  const onKey = (e) => {
    if (keysBlocked(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); ctx.navigate(cardHref(), { instant: true }); }
  };
  document.addEventListener('keydown', onKey);
  const done = () => () => { destroyed = true; document.removeEventListener('keydown', onKey); };

  let data;
  try {
    if (!evalId) {
      const d = await api.dialog(dialogId);
      const ev = (d.evaluations || []).find((e) => e.status === 'done');
      if (!ev) {
        clear(box).append(h('div', { class: 'panel' }, emptyState({ title: 'Нужна завершённая оценка', text: 'Разбор строится по оценке диалога.', actions: [h('a', { class: 'btn btn--secondary', href: cardHref() }, h('span', null, 'К карточке'))] })));
        return done();
      }
      evalId = ev.id;
      ctx.replaceQuery({ eval: evalId });
      renderHead(null);
    }
    data = await api.coaching(evalId, dialogId);
  } catch (e) {
    if (destroyed) return undefined;
    clear(box).append(h('div', { class: 'panel' }, errorState(e, () => ctx.navigate(location.hash))));
    return done();
  }
  if (destroyed) return undefined;

  const dlg = data.dialog || {};
  const ev = data.evaluation || {};
  const items = data.items || [];
  const improve = data.improve || [];
  const passed = data.passed_count ?? 0;
  const applicable = data.applicable_count ?? (passed + items.length);
  const finalTotal = isNum(ev.final_total) ? ev.final_total : ev.total;
  const goTurn = (from) => ctx.navigate(`#/dialog/${encodeURIComponent(dialogId)}?eval=${evalId}&turn=${from}`);
  const linkify = (t) => linkifyTurns(t, { onTurn: goTurn });
  const opName = dlg.operator && dlg.operator !== 'Не указано' ? dlg.operator : 'не указан';
  const generated = data.generated_at || new Date().toISOString();

  /* лист */
  const metaRow = (k, v) => [h('dt', null, k), h('dd', null, v)];
  const sheet = h('article', { class: 'sheet', 'aria-label': 'Разбор диалога' },
    h('header', { class: 'sheet__head' },
      h('img', { class: 'sheet__logo', src: 'assets/freedom-logo-dark.svg', alt: 'Freedom Broker', width: 112, height: 25 }),
      h('span', { class: 'sheet__kind' }, 'Контроль качества')),
    h('h1', { class: 'sheet__title' }, `Разбор диалога ${dlg.id || dialogId}`),
    h('div', { class: 'sheet__meta' },
      h('dl', { class: 'sheet__dl' },
        metaRow('Оператор', opName),
        metaRow('Канал', channelLabel(dlg.channel)),
        metaRow('Язык', LANG_LABELS[dlg.language] || dlg.language || ''),
        metaRow('Дата оценки', fmt.date(ev.finished_at)),
        metaRow('Чек-лист', `версия ${ev.checklist_version ?? '?'}`)),
      h('div', { class: ['sheet__total', !ev.gross && isNum(finalTotal) && finalTotal >= 85 && 'is-good', isNum(finalTotal) && finalTotal < 60 && 'is-low'] },
        h('span', { class: 'sheet__total-num' }, isNum(finalTotal) ? fmt.n2(finalTotal) : 'N/A'),
        h('span', { class: 'sheet__total-of' }, 'из 100'),
        isNum(ev.total) && isNum(finalTotal) && Math.abs(ev.total - finalTotal) > 0.004 ? h('span', { class: 'sheet__total-orig' }, `исходно ${fmt.n2(ev.total)}`) : null)),
    ev.gross ? h('div', { class: 'sheet__gross', role: 'note' }, icon('gross', 16), h('span', null, h('b', null, 'Грубая ошибка. '), 'Нарушение разобрано ниже, оно обсуждается отдельно от итога.')) : null,
    improve.length ? h('section', { class: 'sheet__sect' },
      h('h2', { class: 'sheet__h2' }, 'Что улучшить'),
      h('ol', { class: 'sheet__improve' }, improve.map((x) => h('li', null,
        x.name ? h('span', { class: 'sheet__improve-name' }, `${x.code ? `${x.code} ` : ''}${x.name}. `) : null, x.text)))) : null,
    items.length ? h('section', { class: 'sheet__sect' },
      h('h2', { class: 'sheet__h2' }, 'Замечания по критериям'),
      items.map((it) => h('div', { class: ['sheet__item', it.status === 'gross' && 'is-gross'] },
        h('div', { class: 'sheet__item-head' },
          h('span', { class: 'sheet__code' }, it.code),
          h('span', { class: 'sheet__name' }, it.name),
          h('span', { class: `badge badge--${it.status === 'partial' ? 'partial' : 'no'}` }, it.status === 'gross' ? (it.violation && it.violation.label) || 'Грубая ошибка' : it.value_label || it.value),
          isNum(it.points) && isNum(it.max_points) ? h('span', { class: 'sheet__pts' }, `${fmt.n2(it.points)} из ${fmt.n2(it.max_points)}`) : null),
        it.reason || it.reasoning ? h('p', { class: 'sheet__reason' }, linkify(it.reason || it.reasoning)) : null,
        (it.quotes || []).map((q) => h('blockquote', { class: ['sheet__quote', q.speaker === 'operator' && 'is-op'] },
          h('span', { class: 'sheet__qhead' }, `${q.turn || `T${q.idx + 1}`} · ${SPEAKERS[q.speaker] || q.speaker || ''}${q.clock ? ` · ${q.clock}` : ''}`),
          h('span', { class: 'sheet__qtext' }, q.text))),
        !(it.quotes || []).length && Array.isArray(it.checked_range) ? h('p', { class: 'sheet__note' }, `Проверен участок ${rangeLabel(it.checked_range[0], it.checked_range[1]).replace('-', '..')}`) : null,
        it.appeal ? h('p', { class: 'sheet__note' }, it.appeal.status === 'open' ? 'Оценка оспорена, апелляция на рассмотрении.' : it.appeal.decision === 'changed' ? 'Оценка изменена по апелляции.' : 'Апелляция рассмотрена, оценка подтверждена.') : null))) : null,
    h('p', { class: 'sheet__passed' }, items.length
      ? `Выполнено: ${passed} из ${applicable} ${applicable % 10 === 1 && applicable % 100 !== 11 ? 'критерия' : 'критериев'}`
      : 'Замечаний нет. Все критерии выполнены.'),
    h('div', { class: 'sheet__sign' },
      h('span', null, 'Оператор', h('i')), h('span', null, 'Супервайзер', h('i')), h('span', null, 'Дата', h('i'))),
    h('footer', { class: 'sheet__foot' }, `CQA · оценка №${ev.id ?? evalId} · сформировано ${fmt.date(generated)}`));

  /* текст для мессенджера */
  function plain() {
    const L = [];
    L.push(`Разбор диалога ${dlg.id || dialogId}`);
    L.push(`Оператор: ${opName}. ${channelLabel(dlg.channel)}, ${dlg.language || ''}. Итог ${isNum(finalTotal) ? fmt.n2(finalTotal) : 'N/A'} из 100.`);
    if (ev.gross) L.push('Есть грубая ошибка.');
    if (improve.length) {
      L.push('', 'Что улучшить:');
      improve.forEach((x, i) => L.push(`${i + 1}. ${x.name ? `${x.name}. ` : ''}${x.text}`));
    }
    if (items.length) {
      L.push('', 'Замечания:');
      for (const it of items) {
        L.push(`${it.code} ${it.name}: ${it.status === 'gross' ? 'грубая ошибка' : it.value_label || it.value}${isNum(it.points) ? `, ${fmt.n2(it.points)} из ${fmt.n2(it.max_points)}` : ''}.`);
        if (it.reason || it.reasoning) L.push(it.reason || it.reasoning);
        for (const q of it.quotes || []) L.push(`  ${q.turn || `T${q.idx + 1}`} ${SPEAKERS[q.speaker] || ''}: «${q.text}»`);
      }
    }
    L.push('', items.length ? `Выполнено: ${passed} из ${applicable}.` : 'Замечаний нет.');
    return L.join('\n');
  }

  const copyBtn = button('Скопировать текст', {
    kind: 'secondary', size: 'sm', iconName: 'copy',
    onClick: async () => {
      const ok = await copyText(data.plain_text || plain());
      toast(ok ? 'Текст разбора скопирован' : 'Не удалось скопировать', ok ? 'success' : 'error');
    },
  });
  const printBtn = button('Печать', { kind: 'primary', size: 'sm', iconName: 'print', onClick: () => window.print() });
  renderHead([copyBtn, printBtn]);
  clear(box).append(sheet);

  return done();
}
