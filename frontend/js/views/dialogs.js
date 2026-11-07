// Диалоги: сводка одной строкой, загрузка и импорт, фильтры, сортируемая таблица,
// массовая оценка с подтверждением в строке действий и живым прогрессом.

import { api, exportUrl, resultsUrl } from '../api.js';
import {
  h, clear, icon, button, fmt, isNum, prefs, toast, toastError, debounce, dotted, select, segmented, field,
  scoreCell, fraction, emptyState, errorState, skeleton, plural, nDialogs, menu, withBusy, pageHeader,
  estimateCost, costText, channelLabel, isCall, LANG_LABELS, popover, closePopover, progressLine, keysBlocked, saveNavList, isKey,
} from '../ui.js';
import { can, gate } from '../session.js';

const STATUS_FILTERS = [
  { value: '', label: 'Все статусы' },
  { value: 'none', label: 'Не оценён' },
  { value: 'active', label: 'В работе' },
  { value: 'done', label: 'Оценён' },
  { value: 'error', label: 'Ошибка оценки' },
  { value: 'check', label: 'Прогоны расходятся' },
  { value: 'appeal', label: 'С открытой апелляцией' },
];

const COLUMNS = [
  { key: 'id', label: 'ID' },
  { key: 'channel', label: 'Канал' },
  { key: 'language', label: 'Язык' },
  { key: 'turns', label: 'Реплик', num: true },
  { key: 'total', label: 'Итог', num: true },
  { key: 'gross', label: 'Грубая ошибка' },
  { key: 'agreement', label: 'Согласие', tip: 'Согласие прогонов модели: минимум по критериям' },
  { key: 'appeals', label: 'Апелляции' },
  { key: 'status', label: 'Статус' },
  { key: 'updated', label: 'Обновлено' },
];

const STATUS_ORDER = { running: 0, queued: 1, error: 2, none: 3, done: 4 };

function loadBatch() {
  try { return JSON.parse(sessionStorage.getItem('cqa.batch') || 'null'); } catch { return null; }
}
function saveBatch(b) {
  try { if (b) sessionStorage.setItem('cqa.batch', JSON.stringify(b)); else sessionStorage.removeItem('cqa.batch'); } catch { /* ignore */ }
}

export async function mount(root, { query, ctx }) {
  ctx.setTitle('Диалоги');
  const saved = prefs.get('dialogs.filters', {});
  if (saved.status === 'gross') { saved.status = ''; saved.gross = true; }
  const state = {
    items: [],
    groups: [],
    filters: { group: saved.group ?? '', language: saved.language || '', channel: saved.channel || '', status: saved.status || '', gross: !!saved.gross, q: '' },
    sort: prefs.get('dialogs.sort', { key: 'id', dir: 1 }),
    checklistId: query.checklist ? Number(query.checklist) : null,
    checklists: [],
    settings: null,
    selected: new Set(),
    active: [],
    confirm: null,
    loading: true,
    error: null,
  };
  const canEval = can('evaluate');
  const canImport = can('import');
  let pollTimer = null;
  let lastActiveKey = null;
  let destroyed = false;

  /* ---------- шапка ---------- */
  const strip = h('div', { class: 'strip' }, h('span', null, 'Загрузка сводки'));
  const progressText = h('span', { class: 'progress-text', hidden: true });
  const progress = progressLine('Прогресс оценки');

  const fileInput = h('input', { type: 'file', accept: '.json,.txt,application/json,text/plain', hidden: true, onchange: onFile });
  const importBtn = button('Импорт', { kind: 'secondary', size: 'sm', trailing: 'chevronDown' });
  importBtn.setAttribute('aria-haspopup', 'menu');
  importBtn.addEventListener('click', () => menu(importBtn, [
    { label: 'Загрузить из API организаторов', icon: 'download', onClick: () => openFetch() },
    { label: 'Файл JSON или TXT', icon: 'upload', onClick: () => fileInput.click() },
    { label: 'Вставить текст', icon: 'copy', onClick: () => togglePaste(true) },
  ]));
  const exportBtn = button('Экспорт', { kind: 'ghost', size: 'sm', trailing: 'chevronDown' });
  exportBtn.setAttribute('aria-haspopup', 'menu');
  exportBtn.addEventListener('click', () => menu(exportBtn, [
    { label: 'Таблица CSV', onClick: () => window.open(exportUrl(state.filters.group, 'csv'), '_blank') },
    { label: 'Данные JSON', onClick: () => window.open(exportUrl(state.filters.group, 'json'), '_blank') },
    { label: 'results.json для сдачи', onClick: async () => {
      try {
        const chk = await api.resultsCheck(state.filters.group);
        if (chk.validation_errors && chk.validation_errors.length) {
          toast(`Файл не прошёл проверку: ${chk.validation_errors.slice(0, 2).join(' ')}`, 'error', 9000);
          return;
        }
        toast(`Проверка пройдена: ${chk.count} записей, оценено ${chk.ok}, ошибок ${chk.errors_in_results}.`, 'success');
        window.open(resultsUrl(state.filters.group), '_blank');
      } catch (e) { toastError(e, 'Не удалось выгрузить results.json'); }
    } },
  ]));
  const checklistSel = h('select', { class: 'input input--sm', 'aria-label': 'Чек-лист для оценки', onchange: (e) => { state.checklistId = Number(e.target.value); state.confirm = null; renderBulk(); } });
  const evalAllBtn = button('Оценить все', { kind: 'secondary', size: 'sm', onClick: () => askEvaluate(filtered().map((d) => d.id)) });

  const header = pageHeader({
    title: 'Диалоги',
    actions: [
      progressText,
      gate(importBtn, 'import'), exportBtn, fileInput,
      h('span', { class: 'ph__divider', 'aria-hidden': 'true' }),
      canEval ? checklistSel : null,
      gate(evalAllBtn, 'evaluate'),
    ],
    progress: progress.el,
  });

  function openFetch() {
    const groupIn = h('input', { class: 'input', value: prefs.get('dialogs.fetchGroup', 'DEV'), 'aria-label': 'group_id набора', spellcheck: 'false', autocapitalize: 'none' });
    const msg = h('span', { class: 'inline-msg', role: 'status' });
    const go = button('Загрузить', { kind: 'primary', size: 'sm', onClick: (e) => withBusy(e.currentTarget, () => onFetch(groupIn.value, msg)) });
    groupIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
    popover(importBtn, h('div', { class: 'fstack' },
      h('div', { class: 'pop__title', style: { marginBottom: 0 } }, 'Загрузить из API организаторов'),
      field('group_id набора', groupIn, { hint: 'Диалоги с тем же ID обновятся, оценённые сохранятся под новым ID.' }),
      h('div', { class: 'factions' }, go, button('Отмена', { kind: 'ghost', size: 'sm', onClick: () => closePopover() }), msg)), { cls: 'pop--form' });
    setTimeout(() => groupIn.select(), 0);
  }

  /* ---------- вставка текста ---------- */
  const pasteBox = h('section', { class: 'panel', hidden: true, 'aria-label': 'Вставка транскрипта' });
  function buildPaste() {
    clear(pasteBox);
    const ta = h('textarea', { class: 'input', rows: 8, placeholder: '[00:02] Клиент: Здравствуйте, не могу пополнить счёт\n[00:40] Оператор: Добрый день, меня зовут Айгерим' });
    const idIn = h('input', { class: 'input', placeholder: 'Например, demo-001' });
    const chSel = select([{ value: 'agent chat', label: 'Чат' }, { value: 'voice call', label: 'Звонок' }], 'agent chat');
    const lnSel = select([{ value: '', label: 'Определить автоматически' }, { value: 'RU', label: 'Русский' }, { value: 'KZ', label: 'Казахский' }, { value: 'EN', label: 'Английский' }], '');
    const msg = h('span', { class: 'inline-msg', role: 'status' });
    const go = button('Импортировать', {
      kind: 'primary',
      onClick: (e) => withBusy(e.currentTarget, async () => {
        msg.className = 'inline-msg';
        msg.textContent = '';
        if (!ta.value.trim()) { msg.classList.add('is-error'); msg.textContent = 'Вставьте текст диалога.'; ta.focus(); return; }
        const payload = { text: ta.value, channel: chSel.value };
        if (idIn.value.trim()) payload.conversation_id = idIn.value.trim();
        if (lnSel.value) payload.language = lnSel.value;
        if (await doImport(payload)) togglePaste(false);
      }),
    });
    pasteBox.append(
      h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, 'Вставить транскрипт'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => togglePaste(false) }, icon('close', 16))),
      h('div', { class: 'panel__body fstack' },
        field('Текст диалога', ta, { hint: 'Каждая реплика с новой строки: роль и текст. Время в квадратных скобках можно не указывать.' }),
        h('div', { class: 'fgrid fgrid--3' }, field('ID диалога', idIn), field('Канал', chSel), field('Язык', lnSel)),
        h('div', { class: 'factions' }, go, button('Отмена', { kind: 'secondary', onClick: () => togglePaste(false) }), msg)));
    setTimeout(() => ta.focus(), 0);
  }
  function togglePaste(on) {
    pasteBox.hidden = !on;
    if (on) buildPaste(); else clear(pasteBox);
  }

  /* ---------- фильтры ---------- */
  const langSeg = segmented([{ value: '', label: 'Все' }, { value: 'RU', label: 'RU' }, { value: 'KZ', label: 'KZ' }, { value: 'EN', label: 'EN' }],
    state.filters.language, (v) => setFilter('language', v), { label: 'Язык' });
  const chanSel = select([{ value: '', label: 'Все каналы' }, { value: 'chat', label: 'Чаты' }, { value: 'call', label: 'Звонки' }], state.filters.channel,
    { class: 'input input--sm', 'aria-label': 'Канал', onchange: (e) => setFilter('channel', e.target.value) });
  const statusSel = select(STATUS_FILTERS, state.filters.status, { class: 'input input--sm', 'aria-label': 'Статус', onchange: (e) => setFilter('status', e.target.value) });
  const groupSel = h('select', { class: 'input input--sm', 'aria-label': 'Группа', onchange: (e) => { setFilter('group', e.target.value); loadDialogs(); loadStats(); } });
  const searchIn = h('input', { class: 'input input--sm', type: 'search', placeholder: 'ID или текст', 'aria-label': 'Поиск по ID и тексту диалога' });
  searchIn.addEventListener('input', debounce(() => { state.filters.q = searchIn.value.trim(); loadDialogs(); }, 300));
  searchIn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); searchIn.blur(); moveCursor(e.key === 'Enter' ? 0 : 1, true); }
    if (e.key === 'Escape' && searchIn.value) { e.preventDefault(); searchIn.value = ''; state.filters.q = ''; loadDialogs(); }
  });
  const grossCount = h('span', { class: 'qf__n' });
  const grossBtn = h('button', {
    type: 'button', class: 'qf qf--danger', 'aria-pressed': String(state.filters.gross),
    onclick: () => { setFilter('gross', !state.filters.gross); grossBtn.setAttribute('aria-pressed', String(state.filters.gross)); },
  }, 'Грубая ошибка: есть', grossCount);

  const filters = h('div', { class: 'filters' },
    h('div', { class: 'search' }, icon('search', 16), searchIn),
    langSeg, chanSel, statusSel, groupSel, grossBtn);

  const bulk = h('div', { class: 'bulk', hidden: true, role: 'region', 'aria-label': 'Действия с выбранными' });
  const tableBox = h('div', { class: 'tbl-wrap tbl-wrap--fill' });

  root.append(header, pasteBox, h('div', { class: 'content content--fill' }, strip, h('div', { class: 'toolbar' }, filters, bulk), tableBox));
  pasteBox.style.margin = '0 24px 12px';

  /* ---------- данные ---------- */
  function setFilter(key, value) {
    state.filters[key] = value;
    prefs.set('dialogs.filters', { group: state.filters.group, language: state.filters.language, channel: state.filters.channel, status: state.filters.status, gross: state.filters.gross });
    renderTable();
  }

  function statusOf(d) {
    const act = state.active.find((e) => e.dialog_id === d.id);
    if (act) return act.status;
    return d.latest ? d.latest.status : 'none';
  }

  function filtered() {
    const f = state.filters;
    return state.items.filter((d) => {
      if (f.language && d.language !== f.language) return false;
      if (f.channel === 'call' && !isCall(d.channel)) return false;
      if (f.channel === 'chat' && isCall(d.channel)) return false;
      const l = d.latest;
      if (f.gross && !(l && l.status === 'done' && l.gross)) return false;
      switch (f.status) {
        case 'none': return !l;
        case 'active': return ['queued', 'running'].includes(statusOf(d));
        case 'done': return l && l.status === 'done';
        case 'error': return l && l.status === 'error';
        case 'check': return l && isNum(l.min_agreement) && l.min_agreement < 0.999;
        case 'appeal': return l && l.open_appeals > 0;
        default: return true;
      }
    });
  }

  function sortKey(d, key) {
    const l = d.latest;
    const done = l && l.status === 'done';
    switch (key) {
      case 'id': return d.id;
      case 'channel': return channelLabel(d.channel);
      case 'language': return d.language || '';
      case 'turns': return d.turns ?? -1;
      case 'total': return done ? (isNum(l.final_total) ? l.final_total : isNum(l.total) ? l.total : -1) : -2;
      case 'gross': return done ? (l.gross ? 1 : 0) : -1;
      case 'agreement': return done && isNum(l.min_agreement) ? l.min_agreement : 2;
      case 'appeals': return l ? (l.open_appeals || 0) * 100 + (l.decided_appeals || 0) : -1;
      case 'status': return STATUS_ORDER[statusOf(d)] ?? 9;
      case 'updated': return (l && (l.finished_at || l.created_at)) || d.imported_at || '';
      default: return '';
    }
  }

  function sorted(rows) {
    const { key, dir } = state.sort;
    return [...rows].sort((a, b) => {
      const x = sortKey(a, key);
      const y = sortKey(b, key);
      const c = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y), 'ru', { numeric: true }) : x - y;
      return c * dir || a.id.localeCompare(b.id, 'ru', { numeric: true });
    });
  }

  async function loadStats() {
    try {
      const s = await api.stats(state.filters.group ? { group_id: state.filters.group } : undefined);
      if (destroyed) return;
      clear(strip).append(...dotted([
        h('span', null, h('b', null, fmt.int(s.dialogs)), ` ${plural(s.dialogs, 'диалог', 'диалога', 'диалогов')}`),
        h('span', null, h('b', null, fmt.int(s.evaluated)), ' оценено'),
        h('span', { 'data-tip': s.by_language ? Object.entries(s.by_language).map(([k, v]) => `${LANG_LABELS[k] || k}: ${fmt.n2(v.avg)}, ${nDialogs(v.count)}`).join('\n') : null },
          'средний балл ', h('b', null, isNum(s.avg_total) ? fmt.n2(s.avg_total) : 'нет')),
        h('span', null, 'грубых ошибок ', h('b', { class: s.gross_count ? 't-danger' : '' }, fmt.int(s.gross_count))),
        h('span', null, 'открытых апелляций ', h('b', { class: s.open_appeals ? 't-warn' : '' }, fmt.int(s.open_appeals))),
        h('span', null, 'затраты ', h('b', null, fmt.money(s.total_cost_usd) || '$0,00')),
      ]));
    } catch (e) {
      clear(strip).append(h('span', null, `Сводка недоступна. ${e.message}`));
    }
  }

  async function loadDialogs({ quiet = false } = {}) {
    if (!quiet) { state.loading = true; renderTable(); }
    try {
      const r = await api.dialogs({ group_id: state.filters.group, q: state.filters.q });
      if (destroyed) return;
      state.items = r.items || [];
      state.groups = r.groups || [];
      state.error = null;
      const ids = new Set(state.items.map((d) => d.id));
      for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
      renderGroups();
    } catch (e) {
      state.error = e;
    } finally {
      state.loading = false;
      renderTable();
    }
    if (state.items.some((d) => d.latest && ['queued', 'running'].includes(d.latest.status))) startPolling();
  }

  async function loadChecklists() {
    try {
      const [list, st] = await Promise.all([api.checklists(), api.settings().catch(() => null)]);
      state.checklists = (list.items || []).sort((a, b) => b.id - a.id);
      state.settings = st && st.settings;
      const active = state.checklists.find((c) => c.is_active);
      if (!state.checklistId || !state.checklists.some((c) => c.id === state.checklistId)) state.checklistId = active ? active.id : (state.checklists[0] && state.checklists[0].id);
      clear(checklistSel);
      for (const c of state.checklists) {
        checklistSel.append(h('option', { value: c.id, selected: c.id === state.checklistId, title: c.name }, `Чек-лист v${c.version}${c.is_active ? ', активный' : ''}`));
      }
    } catch {
      clear(checklistSel).append(h('option', { value: '' }, 'Чек-листы недоступны'));
    }
  }

  function renderGroups() {
    const cur = state.filters.group;
    const groups = [...new Set([...(state.groups || []), cur].filter(Boolean))];
    groupSel.hidden = groups.length < 2 && !cur;
    clear(groupSel);
    groupSel.append(h('option', { value: '' }, 'Все группы'));
    for (const g of groups) groupSel.append(h('option', { value: g, selected: g === cur }, `Группа ${g}`));
    groupSel.value = cur;
  }

  /* ---------- таблица ---------- */
  function renderTable() {
    const keepScroll = tableBox.scrollTop;
    const hadFocus = tableBox.contains(document.activeElement) && document.activeElement.matches('tr');
    clear(tableBox);
    const rows = sorted(filtered());
    evalAllBtn.disabled = !canEval || rows.length === 0;
    evalAllBtn.querySelector('span').textContent = rows.length && rows.length !== state.items.length ? `Оценить отфильтрованные: ${rows.length}` : `Оценить все${rows.length ? `: ${rows.length}` : ''}`;
    const nGross = state.items.filter((d) => d.latest && d.latest.status === 'done' && d.latest.gross).length;
    grossCount.textContent = state.items.length ? String(nGross) : '';
    renderBulk();
    saveNavList({ ids: rows.map((d) => d.id), back: '#/dialogs', label: 'Диалоги' });
    if (state.loading && !state.items.length) { tableBox.append(skeleton(10)); return; }
    if (state.error) { tableBox.append(errorState(state.error, () => loadDialogs())); return; }
    if (!state.items.length) {
      tableBox.append(emptyState({
        title: state.filters.q ? 'Ничего не найдено' : 'Диалогов пока нет',
        text: state.filters.q ? 'Измените запрос поиска.' : 'Загрузите набор из API организаторов по group_id или импортируйте файл.',
      }));
      return;
    }
    if (!rows.length) {
      tableBox.append(emptyState({
        title: 'Нет диалогов под эти фильтры',
        actions: [button('Сбросить фильтры', { kind: 'secondary', onClick: resetFilters })],
      }));
      return;
    }

    const headRow = h('tr');
    if (canEval) {
      const allChecked = rows.every((d) => state.selected.has(d.id));
      const headCb = h('input', { type: 'checkbox', 'aria-label': 'Выбрать все', checked: allChecked });
      headCb.indeterminate = !allChecked && rows.some((d) => state.selected.has(d.id));
      headCb.addEventListener('change', () => {
        for (const d of rows) { if (headCb.checked) state.selected.add(d.id); else state.selected.delete(d.id); }
        state.confirm = null;
        renderTable();
      });
      headRow.append(h('th', { class: 'cb' }, headCb));
    }
    for (const c of COLUMNS) {
      const on = state.sort.key === c.key;
      headRow.append(h('th', { class: ['sortable', c.num && 'num'], 'data-tip': c.tip || null, 'aria-sort': on ? (state.sort.dir > 0 ? 'ascending' : 'descending') : null },
        h('button', {
          type: 'button',
          onclick: () => {
            state.sort = on ? { key: c.key, dir: -state.sort.dir } : { key: c.key, dir: ['total', 'updated', 'appeals', 'turns'].includes(c.key) ? -1 : 1 };
            prefs.set('dialogs.sort', state.sort);
            renderTable();
          },
        }, c.label, icon(on ? (state.sort.dir > 0 ? 'sortAsc' : 'sortDesc') : 'sort', 16))));
    }
    const tbody = h('tbody');
    for (const d of rows) tbody.append(rowEl(d));
    tableBox.append(h('table', { class: 'tbl' }, h('thead', null, headRow), tbody));
    tableBox.scrollTop = keepScroll;
    if (cursorId && !rows.some((d) => d.id === cursorId)) cursorId = null;
    if (!cursorId && pendingCursor && rows.some((d) => d.id === pendingCursor)) {
      cursorId = pendingCursor;
      pendingCursor = null;
      setCursor(cursorId, { focus: !document.activeElement || document.activeElement === document.body || hadFocus, center: true });
    } else if (cursorId) setCursor(cursorId, { focus: hadFocus, scroll: false });
  }

  /* ---------- клавиатура: J/K или стрелки двигают строку, Enter открывает, X выбирает ---------- */
  let cursorId = null;
  let pendingCursor = null;
  try { pendingCursor = sessionStorage.getItem('cqa.lastDialog'); } catch { /* ignore */ }

  function rowEls() { return [...tableBox.querySelectorAll('tbody tr[data-id]')]; }

  function setCursor(id, { focus = true, scroll = true, center = false } = {}) {
    cursorId = id;
    let target = null;
    for (const tr of rowEls()) {
      const on = tr.dataset.id === id;
      tr.classList.toggle('is-cursor', on);
      tr.tabIndex = on ? 0 : -1;
      if (on) target = tr;
    }
    if (!target) return;
    if (focus) target.focus({ preventScroll: true });
    if (scroll || center) target.scrollIntoView({ block: center ? 'center' : 'nearest' });
  }

  function moveCursor(delta, fromSearch) {
    const trs = rowEls();
    if (!trs.length) return;
    let i = trs.findIndex((tr) => tr.dataset.id === cursorId);
    if (i < 0 || fromSearch) i = delta >= 0 ? 0 : trs.length - 1;
    else i = Math.max(0, Math.min(trs.length - 1, i + delta));
    setCursor(trs[i].dataset.id);
  }

  function onKey(e) {
    if (keysBlocked(e)) return;
    const down = isKey(e, 'down') || e.key === 'ArrowDown';
    const up = isKey(e, 'up') || e.key === 'ArrowUp';
    if (down || up) {
      const a = document.activeElement;
      if (a && a !== document.body && !tableBox.contains(a) && a.closest('button, a, [role="group"]') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return;
      e.preventDefault();
      moveCursor(down ? 1 : -1);
      return;
    }
    if (e.key === 'Enter' && cursorId) {
      const a = document.activeElement;
      if (a && a !== document.body && !(a.matches('tr[data-id]'))) return;
      e.preventDefault();
      ctx.navigate(`#/dialog/${encodeURIComponent(cursorId)}`, { instant: true });
      return;
    }
    if (isKey(e, 'select') && cursorId && canEval) {
      e.preventDefault();
      if (state.selected.has(cursorId)) state.selected.delete(cursorId); else state.selected.add(cursorId);
      state.confirm = null;
      renderTable();
      return;
    }
    if (isKey(e, 'search') && !e.shiftKey) { e.preventDefault(); searchIn.focus(); searchIn.select(); }
  }
  document.addEventListener('keydown', onKey);

  function resetFilters() {
    state.filters.language = '';
    state.filters.channel = '';
    state.filters.status = '';
    state.filters.gross = false;
    langSeg.setValue('');
    chanSel.value = '';
    statusSel.value = '';
    grossBtn.setAttribute('aria-pressed', 'false');
    setFilter('status', '');
  }

  function rowEl(d) {
    const l = d.latest;
    const st = statusOf(d);
    const done = l && l.status === 'done';
    const href = `#/dialog/${encodeURIComponent(d.id)}`;
    const tr = h('tr', {
      class: ['is-link', state.selected.has(d.id) && 'is-selected'],
      tabindex: -1,
      dataset: { id: d.id },
      onclick: (e) => { if (!e.target.closest('a, input, button, label')) ctx.navigate(href); },
    });
    if (canEval) {
      const cb = h('input', { type: 'checkbox', 'aria-label': `Выбрать ${d.id}`, checked: state.selected.has(d.id) });
      cb.addEventListener('change', () => {
        if (cb.checked) state.selected.add(d.id); else state.selected.delete(d.id);
        state.confirm = null;
        renderTable();
      });
      tr.append(h('td', { class: 'cb' }, cb));
    }
    const fr = done ? fraction(l.min_agreement) : null;
    tr.append(
      h('td', null, h('a', { class: 'id', href }, d.id)),
      h('td', null, channelLabel(d.channel)),
      h('td', { 'data-tip': LANG_LABELS[d.language] || null }, d.language || ''),
      h('td', { class: 'num' }, fmt.int(d.turns)),
      h('td', { class: 'num' }, done ? scoreCell(l.total, l.final_total) : ''),
      h('td', null, done ? (l.gross ? h('a', { class: 't-danger strong', href: '#/gross', 'data-tip': 'Все грубые ошибки с обоснованием' }, 'Есть') : h('span', { class: 't-2' }, 'Нет')) : ''),
      h('td', null, done && isNum(l.min_agreement)
        ? (l.min_agreement >= 0.999
          ? h('span', { class: 't-2' }, 'Полное')
          : h('span', { class: 't-warn strong', 'data-tip': 'Минимальное согласие прогонов по одному из критериев' }, fr ? `${fr.k} из ${fr.n}` : fmt.share(l.min_agreement)))
        : ''),
      h('td', null, appealsCell(l)),
      h('td', null, statusCell(st, l)),
      h('td', { class: 't-2 nowrap' }, fmt.dateShort((l && (l.finished_at || l.created_at)) || d.imported_at)));
    return tr;
  }

  function appealsCell(l) {
    if (!l || (!l.open_appeals && !l.decided_appeals)) return '';
    return h('span', { class: 'nowrap' },
      l.open_appeals ? h('span', { class: 't-warn strong' }, `${l.open_appeals} ${plural(l.open_appeals, 'открыта', 'открыты', 'открыто')}`) : null,
      l.open_appeals && l.decided_appeals ? ', ' : null,
      l.decided_appeals ? h('span', { class: 't-2' }, `${l.decided_appeals} ${plural(l.decided_appeals, 'решена', 'решены', 'решено')}`) : null);
  }

  function statusCell(st, l) {
    // фаза анимации привязана к часам: перерисовка таблицы при опросе не перезапускает полосу
    if (st === 'running') return h('span', { class: 'rowprog' }, h('span', { class: 'rowprog__bar', style: { '--phase': `-${Date.now() % 1100}ms` } }), 'Оценивается');
    if (st === 'queued') return h('span', { class: 't-2' }, 'В очереди');
    if (st === 'error') return h('span', { class: 't-danger', 'data-tip': l && l.error ? String(l.error) : null }, 'Ошибка');
    if (st === 'done') return h('span', null, 'Оценён', l && l.checklist_version != null ? h('span', { class: 't-2' }, `, v${l.checklist_version}`) : null);
    return h('span', { class: 't-2' }, 'Не оценён');
  }

  /* ---------- оценка ---------- */
  function checklistLabel() {
    const cl = state.checklists.find((c) => c.id === state.checklistId);
    return cl ? `версия ${cl.version}` : '';
  }

  function renderBulk() {
    clear(bulk);
    const n = state.selected.size;
    if (state.confirm) {
      const ids = state.confirm.ids;
      const est = estimateCost(state.settings, ids.length);
      const run = button('Запустить оценку', { kind: 'primary', size: 'sm', onClick: (e) => withBusy(e.currentTarget, () => evaluate(ids)) });
      bulk.append(
        h('span', { class: 'bulk__text' }, `Оценить ${nDialogs(ids.length)} по чек-листу, ${checklistLabel()}`,
          h('span', null, `. ${costText(est)}${est.local ? '' : ' всего'}.`)),
        h('span', { class: 'spacer' }),
        run,
        button('Отмена', { kind: 'ghost', size: 'sm', onClick: () => { state.confirm = null; renderBulk(); } }));
      bulk.hidden = false;
      setTimeout(() => run.focus(), 0);
      return;
    }
    if (!n) { bulk.hidden = true; return; }
    bulk.hidden = false;
    bulk.append(
      h('span', { class: 'bulk__text' }, `Выбрано ${n}`),
      button('Оценить', { kind: 'primary', size: 'sm', onClick: () => askEvaluate([...state.selected]) }),
      button('Снять выбор', { kind: 'ghost', size: 'sm', onClick: () => { state.selected.clear(); renderTable(); } }));
  }

  function askEvaluate(ids) {
    if (!ids.length || !canEval) return;
    if (!state.checklistId) { toast('Нет чек-листа для оценки. Создайте его в разделе «Чек-листы».', 'error'); return; }
    if (ids.length <= 3) { evaluate(ids); return; }
    state.confirm = { ids };
    renderBulk();
  }

  async function evaluate(ids) {
    try {
      const r = await api.evaluate(ids, state.checklistId);
      const evIds = r.evaluation_ids || [];
      const prev = loadBatch();
      saveBatch(prev && prev.ids ? { ids: [...prev.ids, ...evIds], total: prev.total + evIds.length } : { ids: evIds, total: evIds.length });
      toast(`Оценка запущена: ${nDialogs(evIds.length)}`, 'success');
      state.selected.clear();
      state.confirm = null;
      await loadDialogs({ quiet: true });
      startPolling(true);
    } catch (e) {
      toastError(e, 'Оценка не запущена');
    }
  }

  function startPolling(immediate) {
    if (pollTimer) return;
    const tick = async () => {
      pollTimer = null;
      if (destroyed) return;
      try {
        const r = await api.evaluations({ status: 'active' });
        if (destroyed) return;
        state.active = r.items || [];
        const key = state.active.map((e) => e.id).sort((a, b) => a - b).join(',');
        const changed = lastActiveKey !== null && key !== lastActiveKey;
        lastActiveKey = key;
        renderProgress();
        if (changed) { await loadDialogs({ quiet: true }); loadStats(); ctx.refreshBadges(); } else renderTable();
        if (!state.active.length) { finishBatch(); return; }
      } catch { /* временная ошибка сети, пробуем дальше */ }
      pollTimer = setTimeout(tick, 2000);
    };
    pollTimer = setTimeout(tick, immediate ? 300 : 2000);
  }

  function finishBatch() {
    const batch = loadBatch();
    if (batch && batch.total) {
      const errs = state.items.filter((d) => d.latest && batch.ids.includes(d.latest.id) && d.latest.status === 'error').length;
      toast(errs ? `Оценка завершена, ошибок: ${errs}` : 'Оценка завершена', errs ? 'error' : 'success');
    }
    saveBatch(null);
    lastActiveKey = null;
    state.active = [];
    renderProgress();
    loadDialogs({ quiet: true });
    loadStats();
  }

  function renderProgress() {
    const batch = loadBatch();
    const active = state.active;
    if (!active.length) { progressText.hidden = true; progress.hide(); return; }
    let total = active.length;
    let done = 0;
    if (batch && batch.total) {
      total = batch.total;
      done = Math.max(0, total - active.filter((e) => batch.ids.includes(e.id)).length);
    }
    progressText.hidden = false;
    clear(progressText).append('Оценка: ', h('b', null, `${done} из ${total}`));
    progress.set(done, total);
  }

  /* ---------- загрузка и импорт ---------- */
  async function onFetch(value, msg) {
    const g = String(value || '').trim() || 'DEV';
    prefs.set('dialogs.fetchGroup', g);
    try {
      const r = await api.fetchDataset(g);
      closePopover();
      toast(`Загружено ${nDialogs(r.imported)} в группу ${r.group_id || g}`, 'success');
      state.filters.group = r.group_id || g;
      setFilter('group', state.filters.group);
      warnRenamed(r);
      await loadDialogs();
      loadStats();
      ctx.refreshBadges();
    } catch (e) {
      if (msg && msg.isConnected) { msg.className = 'inline-msg is-error'; msg.textContent = e.message; } else toastError(e, 'Загрузка не выполнена');
    }
  }

  async function onFile() {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    let text;
    try { text = await f.text(); } catch (e) { toastError(e, 'Файл не прочитан'); return; }
    let payload = null;
    const isJsonName = /\.json$/i.test(f.name);
    if (isJsonName || /^\s*[[{]/.test(text)) {
      try { payload = JSON.parse(text); } catch (e) {
        if (isJsonName) { toast(`Файл ${f.name} не является корректным JSON. ${e.message}`, 'error'); return; }
      }
    }
    if (!payload) payload = { text, conversation_id: f.name.replace(/\.[^.]+$/, '') };
    await doImport(payload);
  }

  async function doImport(payload) {
    try {
      const r = await api.importDialogs(payload);
      const n = r.imported ?? (r.ids || []).length;
      const grp = r.group_id || 'UPLOAD';
      toast(`Импортировано ${nDialogs(n)} в группу ${grp}`, 'success');
      setFilter('group', grp);
      warnRenamed(r);
      if (r.ids && r.ids.length === 1) state.selected = new Set(r.ids);
      await loadDialogs();
      loadStats();
      ctx.refreshBadges();
      return true;
    } catch (e) {
      toastError(e, 'Импорт не выполнен');
      return false;
    }
  }

  function warnRenamed(r) {
    const pairs = Object.entries((r && r.renamed) || {});
    if (!pairs.length) return;
    const shown = pairs.slice(0, 3).map(([a, b]) => `${a} сохранён как ${b}`).join(', ');
    toast(`Текст отличается от уже оценённого, поэтому диалоги сохранены под новыми ID: ${shown}. Прежние оценки не затронуты.`, 'info', 9000);
  }

  /* ---------- старт ---------- */
  renderGroups();
  renderTable();
  loadStats();
  await loadChecklists();
  await loadDialogs();
  if (loadBatch()) startPolling(true);

  return () => {
    destroyed = true;
    document.removeEventListener('keydown', onKey);
    if (pollTimer) clearTimeout(pollTimer);
  };
}
