// Диалоги: фильтры и быстрые срезы со счётчиками, сортируемая таблица с колонкой «Сигналы»
// (грубая ошибка, расхождение прогонов, апелляция, изменение), массовая оценка через плавающую
// панель выбора с подтверждением стоимости и живым прогрессом.

import { api, exportUrl, resultsUrl, opName } from '../api.js';
import {
  h, clear, icon, button, fmt, isNum, prefs, toast, toastError, debounce, select, segmented, field,
  scoreCell, fraction, emptyState, errorState, skeleton, plural, nDialogs, menu, withBusy, pageHeader,
  fetchEstimate, costText, channelLabel, isCall, LANG_LABELS, popover, closePopover, progressLine, keysBlocked, saveNavList, isKey, download, humanError,
  isPhone, isTouch, phoneMQ, sheet, closeSheet,
} from '../ui.js';
import { can } from '../session.js';
import { operatorKey } from '../operators.js';

/* быстрые срезы: один активный, считаются по видимым с учётом языка, канала и поиска */
const SLICES = [
  { value: '', label: 'Все' },
  { value: 'gross', label: 'Грубые', tone: 'danger', test: (l) => done(l) && l.gross },
  { value: 'check', label: 'ИИ сомневается', tone: 'warn', tip: 'Прогоны модели разошлись хотя бы по одному критерию', test: (l) => done(l) && isNum(l.min_agreement) && l.min_agreement < 0.999 },
  { value: 'appeal', label: 'С апелляцией', tone: 'warn', test: (l) => !!l && (l.open_appeals || 0) > 0 },
  { value: 'error', label: 'Ошибки оценки', tone: 'danger', test: (l) => !!l && l.status === 'error' },
  { value: 'none', label: 'Не оценены', test: (l) => !l },
  { value: 'active', label: 'В работе', test: null },
];
const done = (l) => !!l && l.status === 'done';

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
  if (saved.gross && !saved.status) saved.status = 'gross';
  if (!SLICES.some((s) => s.value === saved.status)) saved.status = '';
  const state = {
    items: [],
    groups: [],
    // фильтры живут в адресе (#/dialogs?status=gross&q=...): «Назад» из карточки возвращает тот же список.
    // Группа не запоминается между заходами: после импорта в UPLOAD список не должен залипать на одном диалоге.
    filters: {
      group: query.group || '',
      language: query.language ?? (saved.language || ''),
      channel: query.channel ?? (saved.channel || ''),
      status: query.status ?? (saved.status || ''),
      q: query.q || '',
    },
    sort: prefs.get('dialogs.sort', { key: 'id', dir: 1 }),
    checklistId: query.checklist ? Number(query.checklist) : null,
    checklists: [],
    settings: null,
    selected: new Set(),
    // телефон: режим выбора карточек (кнопка «Выбрать» или долгое нажатие на карточку)
    selectMode: false,
    active: [],
    confirm: null,
    loading: true,
    error: null,
    stats: null,
  };
  if (state.sort.key === 'gross' || state.sort.key === 'agreement' || state.sort.key === 'appeals' || state.sort.key === 'status') state.sort = { key: 'signals', dir: -1 };
  const canEval = can('evaluate');
  const canImport = can('import');
  let pollTimer = null;
  let lastActiveKey = null;
  let destroyed = false;
  let flashId = null;

  /* ---------- шапка ---------- */
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
  const submitGroup = () => {
    if (state.filters.group) return state.filters.group;
    const g = state.groups.filter((x) => x !== 'UPLOAD');
    return g.includes('DEV') ? 'DEV' : g[0] || '';
  };
  const exportBtn = button('Экспорт', { kind: 'ghost', size: 'sm', trailing: 'chevronDown' });
  exportBtn.setAttribute('aria-haspopup', 'menu');
  exportBtn.addEventListener('click', () => {
    const sg = submitGroup();
    menu(exportBtn, [
      { label: 'Таблица CSV', icon: 'download', onClick: () => download(exportUrl(state.filters.group, 'csv')) },
      { label: 'Данные JSON', icon: 'download', onClick: () => download(exportUrl(state.filters.group, 'json')) },
      { label: sg ? `results.json для сдачи, группа ${sg}` : 'results.json для сдачи', icon: 'download', onClick: async () => {
        if (!sg) { toast('Нет группы для сдачи. Загрузите набор по group_id.', 'error'); return; }
        try {
          const chk = await api.resultsCheck(sg);
          if (chk.validation_errors && chk.validation_errors.length) {
            toast(`Файл не прошёл проверку: ${chk.validation_errors.slice(0, 2).join(' ')}`, 'error', 9000);
            return;
          }
          toast(`Группа ${sg}: проверка пройдена, ${chk.count} записей, оценено ${chk.ok}, ошибок ${chk.errors_in_results}.`, 'success');
          download(resultsUrl(sg));
        } catch (e) { toastError(e, 'Не удалось выгрузить results.json'); }
      } },
    ]);
  });
  const evalNewBtn = button('Оценить неоценённые', { kind: 'secondary', size: 'sm', onClick: () => askEvaluate(unevaluated().map((d) => d.id), { onlyMissing: true }) });
  const evalNewWrap = h('span', { class: 'gate', style: { display: 'inline-flex' } }, evalNewBtn);

  const me = ctx.user();
  const mine = !!(me && me.role === 'operator' && me.operator_key);
  if (mine) ctx.setTitle('Мои диалоги');
  const header = pageHeader({
    title: mine ? 'Мои диалоги' : 'Диалоги',
    meta: mine ? 'Оспорить оценку можно в карточке диалога' : null,
    actions: [
      progressText,
      canImport ? importBtn : null, can('analytics') ? exportBtn : null, fileInput,
      canEval ? h('span', { class: 'ph__divider', 'aria-hidden': 'true' }) : null,
      canEval ? evalNewWrap : null,
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
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go.click(); } });
    pasteBox.append(
      h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, 'Вставить транскрипт'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрыть', onclick: () => togglePaste(false) }, icon('close', 16))),
      h('div', { class: 'panel__body fstack' },
        field('Текст диалога', ta, { hint: `Каждая реплика с новой строки: роль и текст. Время в квадратных скобках можно не указывать.${isTouch() ? '' : ' Ctrl+Enter импортирует.'}` }),
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
  const groupSel = h('select', { class: 'input input--sm', 'aria-label': 'Группа', onchange: (e) => { setFilter('group', e.target.value); loadDialogs(); loadStats(); } });
  const searchIn = h('input', { class: 'input input--sm', type: 'search', placeholder: isPhone() || isTouch() ? 'ID, оператор, текст' : 'ID, оператор или текст', 'aria-label': 'Поиск по ID, оператору и тексту диалога' });
  searchIn.value = state.filters.q;
  searchIn.addEventListener('input', debounce(() => { state.filters.q = searchIn.value.trim(); syncQuery(); loadDialogs(); }, 300));
  searchIn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); searchIn.blur(); moveCursor(e.key === 'Enter' ? 0 : 1, true); }
    if (e.key === 'Escape' && searchIn.value) { e.preventDefault(); e.stopPropagation(); searchIn.value = ''; state.filters.q = ''; syncQuery(); loadDialogs(); }
  });
  const summary = h('div', { class: 'list-summary' });
  // телефон: язык, канал, группа и сортировка уходят в нижний лист «Фильтры»
  const filterBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--sm filters__sheetbtn', 'aria-haspopup': 'dialog', onclick: () => openFilterSheet() });
  const selectBtn = canEval ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm filters__selbtn', 'aria-pressed': 'false', onclick: () => setSelectMode(!state.selectMode) }) : null;
  for (const el of [langSeg, chanSel, groupSel]) el.classList.add('filters__more');
  const filters = h('div', { class: 'filters' },
    h('div', { class: 'search' }, icon('search', 16), searchIn, h('kbd', { class: 'search__kbd', 'aria-hidden': 'true' }, '/')),
    langSeg, chanSel, groupSel, filterBtn, selectBtn, h('span', { class: 'spacer' }), summary);

  function paintFilterBtn() {
    const n = ['language', 'channel', 'group'].filter((k) => state.filters[k]).length;
    clear(filterBtn).append(icon('filter', 16));
    if (n) filterBtn.append(h('span', { class: 'count', 'aria-hidden': 'true' }, String(n)));
    filterBtn.setAttribute('aria-label', n ? `Фильтры и сортировка, включено фильтров: ${n}` : 'Фильтры и сортировка');
    if (selectBtn) {
      clear(selectBtn).append(icon(state.selectMode ? 'check' : 'select', 16), h('span', null, state.selectMode ? 'Готово' : 'Выбрать'));
      selectBtn.setAttribute('aria-pressed', String(state.selectMode));
      selectBtn.setAttribute('aria-label', state.selectMode ? 'Закончить выбор' : 'Выбрать диалоги для оценки');
    }
  }

  function setSelectMode(on) {
    state.selectMode = !!on;
    if (!on) { state.selected.clear(); state.confirm = null; }
    renderTable();
  }

  const SORTS = [
    { key: 'id', label: 'ID' }, { key: 'operator', label: 'Оператор' }, { key: 'total', label: 'Итог' },
    { key: 'signals', label: 'Сигналы' }, { key: 'updated', label: 'Обновлено' }, { key: 'turns', label: 'Реплик' },
    { key: 'channel', label: 'Канал' }, { key: 'language', label: 'Язык' },
  ];

  function openFilterSheet() {
    const keys = new Set(columns().map((c) => c.key));
    const sortSel = select(SORTS.filter((x) => keys.has(x.key)).map((x) => ({ value: x.key, label: x.label })), state.sort.key, { 'aria-label': 'Сортировка' });
    const dirSeg = segmented([{ value: '1', label: 'По возрастанию' }, { value: '-1', label: 'По убыванию' }], String(state.sort.dir), (v) => {
      state.sort = { key: state.sort.key, dir: Number(v) };
      prefs.set('dialogs.sort', state.sort);
      renderTable();
    }, { label: 'Направление сортировки' });
    sortSel.addEventListener('change', () => {
      state.sort = { key: sortSel.value, dir: state.sort.dir };
      prefs.set('dialogs.sort', state.sort);
      renderTable();
    });
    // те же элементы фильтров переносятся в лист и возвращаются на место при закрытии
    const moved = [langSeg, chanSel, groupSel].map((el) => { const mark = document.createComment(''); el.before(mark); return [el, mark]; });
    const groupField = groupSel.hidden ? null : field('Группа', groupSel);
    const body = h('div', { class: 'fsheet' },
      field('Язык', langSeg), field('Канал', chanSel), groupField,
      h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Сортировка'), sortSel, dirSeg),
      h('div', { class: 'fsheet__foot' },
        button('Сбросить фильтры', { kind: 'secondary', onClick: () => { resetFilters(); groupSel.value = ''; if (state.filters.group) { setFilter('group', ''); loadDialogs(); loadStats(); } } }),
        button('Показать', { kind: 'primary', onClick: () => closeSheet() })));
    sheet({
      title: 'Фильтры и сортировка',
      content: body,
      onClose: () => { for (const [el, mark] of moved) { mark.replaceWith(el); } paintFilterBtn(); },
    });
  }
  const onPhoneChange = () => { if (!isPhone() && state.selectMode) setSelectMode(false); };
  phoneMQ.addEventListener('change', onPhoneChange);
  const slices = h('div', { class: 'slices', role: 'group', 'aria-label': 'Быстрые срезы' });

  const bulk = h('div', { class: 'bulk', hidden: true, role: 'region', 'aria-label': 'Действия с выбранными' });
  const tableBox = h('div', { class: 'tbl-wrap tbl-wrap--fill' });

  root.append(header, pasteBox, h('div', { class: 'content content--fill content--list' }, h('div', { class: 'toolbar' }, filters, slices), tableBox, bulk));
  pasteBox.classList.add('paste-box');

  /* ---------- данные ---------- */
  function syncQuery() {
    const f = state.filters;
    ctx.replaceQuery({ group: f.group, language: f.language, channel: f.channel, status: f.status, q: f.q });
  }

  function setFilter(key, value) {
    state.filters[key] = value;
    prefs.set('dialogs.filters', { language: state.filters.language, channel: state.filters.channel, status: state.filters.status });
    syncQuery();
    renderTable();
  }

  function statusOf(d) {
    const act = state.active.find((e) => e.dialog_id === d.id);
    if (act) return act.status;
    return d.latest ? d.latest.status : 'none';
  }

  /** Фильтр по языку и каналу (поиск уже на сервере), без среза. */
  function base() {
    const f = state.filters;
    return state.items.filter((d) => {
      if (f.language && d.language !== f.language) return false;
      if (f.channel === 'call' && !isCall(d.channel)) return false;
      if (f.channel === 'chat' && isCall(d.channel)) return false;
      return true;
    });
  }

  function sliceTest(value) {
    const s = SLICES.find((x) => x.value === value);
    if (!s || !s.value) return () => true;
    if (s.value === 'active') return (d) => ['queued', 'running'].includes(statusOf(d));
    return (d) => s.test(d.latest);
  }

  function filtered() { return base().filter(sliceTest(state.filters.status)); }
  function unevaluated() { return filtered().filter((d) => !d.latest || (d.latest.status === 'error' && !['queued', 'running'].includes(statusOf(d)))).filter((d) => !['queued', 'running'].includes(statusOf(d))); }

  function signalScore(l) {
    if (!done(l)) return -1;
    return (l.gross ? 8 : 0) + (isNum(l.min_agreement) && l.min_agreement < 0.999 ? 4 : 0) + ((l.open_appeals || 0) ? 2 : 0) + (isNum(l.total) && isNum(l.final_total) && Math.abs(l.total - l.final_total) > 0.004 ? 1 : 0);
  }

  function sortKey(d, key) {
    const l = d.latest;
    switch (key) {
      case 'id': return d.id;
      case 'operator': { const o = opName(d.operator); return o && o !== 'Не указано' ? o : '￿'; }
      case 'channel': return channelLabel(d.channel);
      case 'language': return d.language || '';
      case 'turns': return d.turns ?? -1;
      case 'total': {
        if (done(l)) return isNum(l.final_total) ? l.final_total : isNum(l.total) ? l.total : -1;
        return -10 - (STATUS_ORDER[statusOf(d)] ?? 9);
      }
      case 'signals': return signalScore(l);
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
    if (!canEval) return;
    try {
      state.stats = await api.stats(state.filters.group ? { group_id: state.filters.group } : undefined);
      if (!destroyed) renderSummary(filtered());
    } catch { state.stats = null; }
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
    if (!canEval) return;
    try {
      const [list, st] = await Promise.all([api.checklists(), api.settings().catch(() => null)]);
      state.checklists = (list.items || []).sort((a, b) => b.id - a.id);
      state.settings = st && st.settings;
      // без ключа Claude оценка через Claude не запустится: кнопку запуска выключаем заранее
      state.noKey = !!(st && st.has_anthropic_key === false && (st.settings || {}).provider !== 'openai_compat');
      const active = state.checklists.find((c) => c.is_active);
      if (!state.checklistId || !state.checklists.some((c) => c.id === state.checklistId)) state.checklistId = active ? active.id : (state.checklists[0] && state.checklists[0].id);
    } catch { state.checklists = []; }
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

  function renderSlices() {
    clear(slices);
    const b = base();
    for (const s of SLICES) {
      const n = s.value ? b.filter(sliceTest(s.value)).length : b.length;
      if (s.value && !n && state.filters.status !== s.value) continue;
      const on = state.filters.status === s.value;
      slices.append(h('button', {
        type: 'button', class: ['slice', s.tone && `slice--${s.tone}`], 'aria-pressed': String(on), 'data-tip': s.tip || null,
        onclick: () => { setFilter('status', on && s.value ? '' : s.value); },
      }, s.label, h('span', { class: 'slice__n' }, fmt.int(n))));
    }
  }

  function renderSummary(rows) {
    clear(summary);
    const fins = rows.map((d) => d.latest).filter(done).map((l) => (isNum(l.final_total) ? l.final_total : l.total)).filter(isNum);
    const parts = [];
    if (fins.length) parts.push(h('span', { 'data-tip': 'Средний итог показанных диалогов после апелляций' }, 'средний итог ', h('b', null, fmt.n2(fins.reduce((a, x) => a + x, 0) / fins.length))));
    if (canEval && state.stats && isNum(state.stats.total_cost_usd)) parts.push(h('span', { 'data-tip': 'Затраты на модель по последним оценкам группы' }, 'затраты ', h('b', null, fmt.money(state.stats.total_cost_usd))));
    parts.forEach((p, i) => { if (i) summary.append(h('span', { class: 'sep', 'aria-hidden': 'true' }, '·')); summary.append(p); });
  }

  /* ---------- таблица ---------- */
  function columns() {
    const hasOp = state.items.some((d) => opName(d.operator) && opName(d.operator) !== 'Не указано');
    return [
      { key: 'id', label: 'ID' },
      hasOp ? { key: 'operator', label: 'Оператор' } : null,
      { key: 'channel', label: 'Канал' },
      { key: 'language', label: 'Язык' },
      { key: 'turns', label: 'Реплик', num: true },
      { key: 'total', label: 'Итог', num: true },
      { key: 'signals', label: 'Сигналы', tip: 'Грубая ошибка, расхождение прогонов модели, апелляция, изменение по апелляции' },
      { key: 'updated', label: 'Обновлено' },
    ].filter(Boolean);
  }

  function renderTable() {
    const keepScroll = tableBox.scrollTop;
    const hadFocus = tableBox.contains(document.activeElement) && document.activeElement.matches('tr');
    clear(tableBox);
    const rows = sorted(filtered());
    const nNew = unevaluated().length;
    evalNewBtn.disabled = !canEval || nNew === 0;
    evalNewBtn.querySelector('span').textContent = nNew ? `Оценить неоценённые: ${nNew}` : 'Все оценены';
    if (nNew) evalNewWrap.removeAttribute('data-tip');
    else evalNewWrap.dataset.tip = 'Показанные диалоги уже оценены. Чтобы переоценить, выберите их галочками.';
    renderSlices();
    renderSummary(rows);
    renderBulk();
    paintFilterBtn();
    tableBox.classList.toggle('is-selecting', state.selectMode);
    saveNavList({ ids: rows.map((d) => d.id), back: location.hash.startsWith('#/dialogs') ? location.hash : '#/dialogs', label: mine ? 'Мои диалоги' : 'Диалоги' });
    if (state.loading && !state.items.length) { tableBox.append(skeleton(10)); return; }
    if (state.error) { tableBox.append(errorState(state.error, () => loadDialogs())); return; }
    if (!state.items.length) {
      tableBox.append(emptyState({
        title: state.filters.q ? 'Ничего не найдено' : 'Диалогов пока нет',
        text: state.filters.q ? 'Измените запрос поиска.' : canImport ? 'Загрузите набор из API организаторов по group_id или импортируйте файл.' : 'Диалоги загружает супервайзер.',
        actions: !state.filters.q && canImport ? [button('Загрузить набор', { kind: 'primary', onClick: () => openFetch() })] : null,
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

    const cols = columns();
    const headRow = h('tr');
    if (canEval) {
      const allChecked = rows.every((d) => state.selected.has(d.id));
      const headCb = h('input', { type: 'checkbox', 'aria-label': 'Выбрать все показанные', checked: allChecked });
      headCb.indeterminate = !allChecked && rows.some((d) => state.selected.has(d.id));
      headCb.addEventListener('change', () => {
        for (const d of rows) { if (headCb.checked) state.selected.add(d.id); else state.selected.delete(d.id); }
        state.confirm = null;
        renderTable();
      });
      headRow.append(h('th', { class: 'cb' }, headCb));
    }
    for (const c of cols) {
      const on = state.sort.key === c.key;
      headRow.append(h('th', { class: ['sortable', c.num && 'num'], 'data-tip': c.tip || null, 'aria-sort': on ? (state.sort.dir > 0 ? 'ascending' : 'descending') : null },
        h('button', {
          type: 'button',
          onclick: () => {
            state.sort = on ? { key: c.key, dir: -state.sort.dir } : { key: c.key, dir: ['total', 'updated', 'turns', 'signals'].includes(c.key) ? -1 : 1 };
            if (!on && c.key === 'total') state.sort.dir = 1;
            prefs.set('dialogs.sort', state.sort);
            renderTable();
          },
        }, c.label, icon(on ? (state.sort.dir > 0 ? 'sortAsc' : 'sortDesc') : 'sort', 16))));
    }
    const tbody = h('tbody');
    for (const d of rows) tbody.append(rowEl(d, cols));
    tableBox.append(h('table', { class: 'tbl tbl--cards dl-cards' }, h('thead', null, headRow), tbody));
    tableBox.scrollTop = keepScroll;
    if (cursorId && !rows.some((d) => d.id === cursorId)) cursorId = null;
    if (!cursorId && pendingCursor && rows.some((d) => d.id === pendingCursor)) {
      cursorId = pendingCursor;
      pendingCursor = null;
      setCursor(cursorId, { focus: !document.activeElement || document.activeElement === document.body || hadFocus, center: true });
    } else if (cursorId) setCursor(cursorId, { focus: hadFocus, scroll: false });
    if (flashId) {
      const tr = tableBox.querySelector(`tr[data-id="${CSS.escape(flashId)}"]`);
      if (tr) { tr.scrollIntoView({ block: 'center' }); tr.classList.add('flash'); tr.addEventListener('animationend', () => tr.classList.remove('flash'), { once: true }); }
      flashId = null;
    }
  }

  /* ---------- клавиатура: J/K или стрелки двигают строку, Enter открывает, X выбирает ---------- */
  let cursorId = null;
  let pendingCursor = null;
  if (/^\/dialog\//.test(ctx.prevPath ? ctx.prevPath() : '')) {
    try { pendingCursor = sessionStorage.getItem('cqa.lastDialog'); } catch { /* ignore */ }
  }

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
    if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open], .pop, .palette')) {
      if (state.confirm) { e.preventDefault(); state.confirm = null; renderBulk(); return; }
      if (state.selected.size && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) { e.preventDefault(); state.selected.clear(); renderTable(); return; }
    }
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
    langSeg.setValue('');
    chanSel.value = '';
    setFilter('status', '');
  }

  function rowEl(d, cols) {
    const l = d.latest;
    const st = statusOf(d);
    const href = `#/dialog/${encodeURIComponent(d.id)}`;
    const toggleSel = () => {
      if (state.selected.has(d.id)) state.selected.delete(d.id); else state.selected.add(d.id);
      state.confirm = null;
      renderTable();
    };
    let pressed = false;
    const tr = h('tr', {
      class: ['is-link', state.selected.has(d.id) && 'is-selected'],
      tabindex: -1,
      dataset: { id: d.id, press: '' },
      onclick: (e) => {
        if (pressed) { pressed = false; e.preventDefault(); return; }
        // телефон в режиме выбора: касание карточки отмечает её, ссылки внутри не открываются
        if (isPhone() && state.selectMode && canEval) { if (!e.target.closest('input')) { e.preventDefault(); toggleSel(); } return; }
        if (!e.target.closest('a, input, button, label')) ctx.navigate(href);
      },
    });
    if (canEval) {
      // долгое нажатие на карточку на телефоне включает режим выбора и отмечает её
      let timer = 0;
      let start = null;
      tr.addEventListener('touchstart', (e) => {
        if (!isPhone() || e.touches.length > 1) return;
        start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        timer = setTimeout(() => {
          pressed = true;
          state.selectMode = true;
          if (navigator.vibrate) { try { navigator.vibrate(10); } catch { /* ignore */ } }
          toggleSel();
        }, 480);
      }, { passive: true });
      tr.addEventListener('touchmove', (e) => {
        if (start && (Math.abs(e.touches[0].clientX - start.x) > 10 || Math.abs(e.touches[0].clientY - start.y) > 10)) clearTimeout(timer);
      }, { passive: true });
      tr.addEventListener('touchend', (e) => { clearTimeout(timer); if (pressed && e.cancelable) e.preventDefault(); });
      tr.addEventListener('contextmenu', (e) => { if (isPhone()) e.preventDefault(); });
    }
    if (canEval) {
      const cb = h('input', { type: 'checkbox', 'aria-label': `Выбрать ${d.id}`, checked: state.selected.has(d.id) });
      cb.addEventListener('change', () => {
        if (cb.checked) state.selected.add(d.id); else state.selected.delete(d.id);
        state.confirm = null;
        renderTable();
      });
      tr.append(h('td', { class: 'cb' }, cb));
    }
    for (const c of cols) {
      switch (c.key) {
        case 'id': tr.append(h('td', { class: 'c-id' }, h('a', { class: 'id', href }, d.id))); break;
        case 'operator': {
          const o = opName(d.operator);
          tr.append(h('td', { class: 'clip c-op c-meta', style: { maxWidth: '140px' } }, o && o !== 'Не указано'
            ? (can('analytics') ? h('a', { class: 'op-link', href: `#/operator/${encodeURIComponent(d.operator_key || operatorKey(o))}`, 'data-tip': 'Профиль оператора' }, o) : o)
            : h('span', { class: 't-2' }, 'Не указано')));
          break;
        }
        case 'channel': tr.append(h('td', { class: 'c-channel c-meta' }, channelLabel(d.channel))); break;
        case 'language': tr.append(h('td', { class: 'c-lang c-meta', 'data-tip': LANG_LABELS[d.language] || null }, d.language || '')); break;
        case 'turns': tr.append(h('td', { class: 'num c-turns' }, fmt.int(d.turns))); break;
        case 'total': tr.append(h('td', { class: 'num c-total' }, totalCell(st, l))); break;
        case 'signals': tr.append(h('td', { class: 'c-signals' }, signalsCell(d, l))); break;
        case 'updated': tr.append(h('td', { class: 't-2 nowrap c-updated', 'data-tip': fmt.date((l && (l.finished_at || l.created_at)) || d.imported_at) }, fmt.when((l && (l.finished_at || l.created_at)) || d.imported_at))); break;
        default: tr.append(h('td'));
      }
    }
    return tr;
  }

  function totalCell(st, l) {
    // фаза анимации привязана к часам: перерисовка таблицы при опросе не перезапускает полосу
    if (st === 'running') return h('span', { class: 'rowprog' }, h('span', { class: 'rowprog__bar', style: { '--phase': `-${Date.now() % 1100}ms` } }), 'Оценивается');
    if (st === 'queued') return h('span', { class: 't-2' }, 'В очереди');
    if (st === 'error') return h('span', { class: 't-danger strong', 'data-tip': l && l.error ? humanError(l.error).summary : null }, 'Ошибка');
    if (!done(l)) return h('span', { class: 't-2' }, 'Не оценён');
    const wrap = h('span', { 'data-tip': `Чек-лист v${l.checklist_version ?? '?'}${l.gross ? '. Есть грубая ошибка' : ''}` });
    if (l.gross) wrap.append(h('span', { class: 'score' }, fmt.n2(isNum(l.final_total) ? l.final_total : l.total)));
    else wrap.append(scoreCell(l.total, l.final_total));
    return wrap;
  }

  function signalsCell(d, l) {
    if (!done(l)) return '';
    const out = [];
    const href = `#/dialog/${encodeURIComponent(d.id)}?eval=${l.id}`;
    if (l.gross) out.push(h('a', { class: 'sig sig--danger', href: `${href}&crit=gross`, 'data-tip': 'Открыть грубую ошибку в карточке' }, 'Грубая'));
    if (isNum(l.min_agreement) && l.min_agreement < 0.999) {
      const fr = fraction(l.min_agreement);
      out.push(h('span', { class: 'sig sig--warn', 'data-tip': 'Прогоны модели разошлись: минимальное согласие по одному из критериев' }, fr ? `${fr.k} из ${fr.n}` : fmt.share(l.min_agreement)));
    }
    if (l.open_appeals) out.push(h('span', { class: 'sig sig--warn', 'data-tip': `Открытых апелляций: ${l.open_appeals}` }, l.open_appeals > 1 ? `Апелляции: ${l.open_appeals}` : 'Апелляция'));
    if (isNum(l.total) && isNum(l.final_total) && Math.abs(l.total - l.final_total) > 0.004) out.push(h('span', { class: 'sig sig--neutral', 'data-tip': `Итог изменён по апелляции: было ${fmt.n2(l.total)}, стало ${fmt.n2(l.final_total)}` }, 'Изменено'));
    else if (l.decided_appeals && !l.open_appeals) out.push(h('span', { class: 'sig sig--neutral', 'data-tip': `Решённых апелляций: ${l.decided_appeals}` }, 'Апелляция решена'));
    return out.length ? h('span', { class: 'sigs' }, out) : '';
  }

  /* ---------- оценка ---------- */
  function renderBulk() {
    clear(bulk);
    const n = state.selected.size;
    if (state.confirm) {
      const { ids, onlyMissing } = state.confirm;
      const costEl = h('span', { class: 'bulk__cost' }, state.confirm.est ? `${costText(state.confirm.est)}.` : 'Считаем стоимость');
      if (!state.confirm.est) {
        const pending = state.confirm;
        fetchEstimate(api, state.settings, ids.length).then((est) => {
          if (state.confirm !== pending) return;
          pending.est = est;
          costEl.textContent = est ? `${costText(est)}.` : 'Стоимость не рассчитана.';
        });
      }
      const sel = select(state.checklists.map((c) => ({ value: c.id, label: `v${c.version}${c.is_active ? ', активный' : ''}` })), state.checklistId,
        { class: 'input input--sm', 'aria-label': 'Версия чек-листа', onchange: (e) => { state.checklistId = Number(e.target.value); } });
      const run = button('Запустить оценку', { kind: 'primary', size: 'sm', disabled: !!state.noKey, onClick: (e) => withBusy(e.currentTarget, () => evaluate(ids, { onlyMissing })) });
      const cancel = button('Отмена', { kind: 'ghost', size: 'sm', onClick: () => { state.confirm = null; renderBulk(); } });
      bulk.append(
        h('span', { class: 'bulk__text' }, `Оценить ${nDialogs(ids.length)} по чек-листу`),
        state.checklists.length > 1 ? sel : h('span', { class: 'bulk__text' }, state.checklists[0] ? `v${state.checklists[0].version}` : ''),
        state.noKey ? h('span', { class: 'bulk__cost t-warn' }, 'Ключ Claude API не задан на сервере.') : costEl,
        h('span', { class: 'spacer' }),
        run, cancel);
      bulk.hidden = false;
      bulk.classList.add('is-confirm');
      setTimeout(() => cancel.focus({ preventScroll: true }), 0);
      return;
    }
    bulk.classList.remove('is-confirm');
    if (!n) { bulk.hidden = true; return; }
    bulk.hidden = false;
    bulk.append(
      h('span', { class: 'bulk__text' }, `Выбрано ${n}`),
      button('Оценить', { kind: 'primary', size: 'sm', onClick: () => askEvaluate([...state.selected]) }),
      button('Снять выбор', { kind: 'ghost', size: 'sm', onClick: () => { state.selected.clear(); state.selectMode = false; renderTable(); } }),
      h('kbd', { class: 'bulk__kbd', 'data-tip': 'Esc снимает выбор' }, 'Esc'));
  }

  function askEvaluate(ids, { onlyMissing = false } = {}) {
    if (!ids.length || !canEval) return;
    if (!state.checklistId) { toast('Нет чек-листа для оценки. Создайте его в разделе «Чек-листы».', 'error'); return; }
    state.confirm = { ids, onlyMissing };
    renderBulk();
  }

  async function evaluate(ids, { onlyMissing = false } = {}) {
    try {
      const r = await api.evaluate(ids, state.checklistId, null, { only_missing: onlyMissing });
      const evIds = r.evaluation_ids || [];
      const skipped = (r.skipped || []).length;
      const prev = loadBatch();
      if (evIds.length) saveBatch(prev && prev.ids ? { ids: [...prev.ids, ...evIds], total: prev.total + evIds.length } : { ids: evIds, total: evIds.length });
      if (!evIds.length) toast(skipped ? `Все ${nDialogs(skipped)} уже оценены или в очереди` : 'Нечего оценивать', 'info');
      else toast(skipped ? `Оценка запущена: ${nDialogs(evIds.length)}. Пропущено уже оценённых: ${skipped}` : `Оценка запущена: ${nDialogs(evIds.length)}`, 'success');
      state.selected.clear();
      state.selectMode = false;
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
    let doneN = 0;
    if (batch && batch.total) {
      total = batch.total;
      doneN = Math.max(0, total - active.filter((e) => batch.ids.includes(e.id)).length);
    }
    progressText.hidden = false;
    clear(progressText).append('Оценка: ', h('b', null, `${doneN} из ${total}`));
    progress.set(doneN, total);
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
      toast(`Импортировано ${nDialogs(n)} в группу ${grp}.${isPhone() ? '' : ' Отметьте диалог галочкой, чтобы оценить.'}`, 'success', 5000);
      setFilter('group', grp);
      setFilter('status', '');
      warnRenamed(r);
      if (r.ids && r.ids.length) { flashId = r.ids[0]; cursorId = r.ids[0]; }
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

  /* ---------- команды палитры ---------- */
  const unreg = ctx.registerCommands(() => [
    canEval && state.selected.size ? { label: `Оценить выбранные: ${state.selected.size}`, icon: 'check', run: () => askEvaluate([...state.selected]) } : null,
    canEval && unevaluated().length ? { label: `Оценить неоценённые: ${unevaluated().length}`, icon: 'check', run: () => askEvaluate(unevaluated().map((d) => d.id), { onlyMissing: true }) } : null,
    canImport ? { label: 'Загрузить набор из API организаторов', icon: 'download', run: () => openFetch() } : null,
    canImport ? { label: 'Вставить транскрипт', icon: 'copy', run: () => togglePaste(true) } : null,
  ]);

  /* ---------- старт ---------- */
  renderGroups();
  renderTable();
  loadStats();
  await loadChecklists();
  await loadDialogs();
  if (loadBatch()) startPolling(true);

  return () => {
    destroyed = true;
    unreg();
    document.removeEventListener('keydown', onKey);
    phoneMQ.removeEventListener('change', onPhoneChange);
    if (pollTimer) clearTimeout(pollTimer);
  };
}
