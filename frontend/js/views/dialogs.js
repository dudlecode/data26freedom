// Диалоги: KPI, загрузка/импорт, фильтры, выбор чек-листа, массовая оценка с живым прогрессом.

import { api, exportUrl } from '../api.js';
import {
  h, clear, icon, button, fmt, isNum, prefs, toast, toastError, openModal, confirmDialog, debounce,
  scorePill, agreementMeter, statusChip, channelCell, emptyState, errorState, skeleton, select, field, plural, LANG_LABELS,
  estimateCost, costHint,
} from '../ui.js';

const STATUS_FILTERS = [
  { value: '', label: 'Все статусы' },
  { value: 'none', label: 'Не оценён' },
  { value: 'active', label: 'В очереди / оценивается' },
  { value: 'done', label: 'Оценён' },
  { value: 'error', label: 'Ошибка' },
  { value: 'gross', label: 'С грубой ошибкой' },
  { value: 'check', label: 'Нужна проверка (согласованность < 1)' },
  { value: 'appeal', label: 'С открытой апелляцией' },
];

function loadBatch() {
  try { return JSON.parse(sessionStorage.getItem('cqa.batch') || 'null'); } catch { return null; }
}
function saveBatch(b) {
  try { if (b) sessionStorage.setItem('cqa.batch', JSON.stringify(b)); else sessionStorage.removeItem('cqa.batch'); } catch { /* ignore */ }
}

export async function mount(root, { query, ctx }) {
  ctx.setTitle('Диалоги');
  const saved = prefs.get('dialogs.filters', {});
  const state = {
    items: [],
    groups: [],
    filters: { group: saved.group ?? '', language: saved.language || '', channel: saved.channel || '', status: saved.status || '', q: '' },
    checklistId: query.checklist ? Number(query.checklist) : null,
    checklists: [],
    settings: null,
    selected: new Set(),
    active: [],
    loading: true,
    error: null,
  };
  let pollTimer = null;
  let lastActiveKey = null;
  let destroyed = false;

  /* ---------- каркас ---------- */
  const kpiBox = h('section', { class: 'kpi-strip', 'aria-label': 'Сводка' }, skeleton(1));
  const fetchInput = h('input', { class: 'input input--sm', value: prefs.get('dialogs.fetchGroup', 'DEV'), 'aria-label': 'group_id набора', placeholder: 'group_id', size: 8 });
  const fileInput = h('input', { type: 'file', accept: '.json,.txt,application/json,text/plain', hidden: true, onchange: onFile });
  const progressBox = h('div', { class: 'batch-progress', hidden: true });

  const groupSel = h('select', { class: 'input input--sm', 'aria-label': 'Группа', onchange: (e) => setFilter('group', e.target.value, true) });
  const langSel = select([{ value: '', label: 'Все языки' }, { value: 'RU', label: 'Русский' }, { value: 'KZ', label: 'Казахский' }, { value: 'EN', label: 'Английский' }], state.filters.language,
    { class: 'input input--sm', 'aria-label': 'Язык', onchange: (e) => setFilter('language', e.target.value, true) });
  const chanSel = select([{ value: '', label: 'Все каналы' }, { value: 'agent chat', label: 'Чаты' }, { value: 'voice call', label: 'Звонки' }], state.filters.channel,
    { class: 'input input--sm', 'aria-label': 'Канал', onchange: (e) => setFilter('channel', e.target.value, true) });
  const statusSel = select(STATUS_FILTERS, state.filters.status, { class: 'input input--sm', 'aria-label': 'Статус', onchange: (e) => setFilter('status', e.target.value, false) });
  const searchInput = h('input', { class: 'input input--sm input--search', type: 'search', placeholder: 'Поиск по ID и тексту', 'aria-label': 'Поиск' });
  searchInput.addEventListener('input', debounce(() => setFilter('q', searchInput.value.trim(), true), 300));
  const checklistSel = h('select', { class: 'input input--sm', 'aria-label': 'Чек-лист для оценки', onchange: (e) => { state.checklistId = Number(e.target.value); } });

  /* защита от двойного клика: пока запрос в работе, повторные нажатия игнорируются, кнопка в состоянии is-busy */
  const inflight = new Set();
  const busy = (key, fn) => async (e) => {
    if (inflight.has(key)) return;
    inflight.add(key);
    const btn = e && e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
    const wasDisabled = btn ? btn.disabled : false;
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true'); }
    try { await fn(); } finally {
      inflight.delete(key);
      if (btn) { btn.classList.remove('is-busy'); btn.removeAttribute('aria-busy'); btn.disabled = wasDisabled; }
      if (!destroyed) renderTable();
    }
  };
  const evalSelectedBtn = button('Оценить выбранные', { kind: 'primary', iconName: 'spark', onClick: busy('evaluate', () => evaluate([...state.selected])) });
  const evalAllBtn = button('Оценить все отфильтрованные', { kind: 'secondary', onClick: busy('evaluate', () => evaluate(filtered().map((d) => d.id), true)) });
  const countLabel = h('span', { class: 'toolbar__count' });

  const tableBox = h('div', { class: 'table-wrap' });

  root.append(
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title' }, 'Диалоги'),
        h('p', { class: 'page-sub' }, 'Чаты и звонки операторов. Выберите диалоги и чек-лист, затем запустите оценку ИИ.')),
      h('div', { class: 'page-head__actions' },
        h('div', { class: 'inline-group', role: 'group', 'aria-label': 'Загрузка набора из API организаторов' },
          fetchInput,
          button('Загрузить из API', { kind: 'secondary', iconName: 'cloud', size: 'sm', onClick: busy('fetch', onFetch) })),
        button('Импорт файла', { kind: 'secondary', iconName: 'upload', size: 'sm', onClick: () => fileInput.click(), tip: 'JSON из API организаторов или .txt с транскриптом' }),
        button('Вставить текст', { kind: 'ghost', iconName: 'edit', size: 'sm', onClick: openPaste }),
        fileInput)),
    kpiBox,
    h('div', { class: 'toolbar card' },
      h('div', { class: 'toolbar__row' },
        h('div', { class: 'toolbar__filters' }, groupSel, langSel, chanSel, statusSel, searchInput),
        h('div', { class: 'toolbar__export' },
          h('a', { class: 'btn btn--ghost btn--sm', href: '#', onclick: (e) => { e.preventDefault(); window.open(exportUrl(state.filters.group, 'csv'), '_blank'); } }, icon('download', 14), h('span', null, 'CSV')),
          h('a', { class: 'btn btn--ghost btn--sm', href: '#', onclick: (e) => { e.preventDefault(); window.open(exportUrl(state.filters.group, 'json'), '_blank'); } }, icon('download', 14), h('span', null, 'JSON')),
          h('a', {
            class: 'btn btn--ghost btn--sm', href: '#', 'data-tip': 'results.json для сдачи организаторам: формат JSON 1.0, проверка перед скачиванием',
            onclick: async (e) => {
              e.preventDefault();
              const group = state.filters.group;
              if (!group) { toast('Выберите группу (DEV или контрольную) в фильтре слева', 'error'); return; }
              try {
                const r = await api.results(group);
                if (r.errors.length) toast(`Формат: ${r.errors.length} замечаний, первое - ${r.errors[0]}`, 'error', 8000);
                else toast(`results.json: ${r.count} записей, оценено ${r.ok}, без оценки ${r.error}. Формат в порядке`, r.error ? 'info' : 'success', 6000);
                window.open(exportUrl(group, 'results'), '_blank');
              } catch (err) { toastError(err, 'Не удалось собрать results.json'); }
            },
          }, icon('download', 14), h('span', null, 'results.json')))),
      h('div', { class: 'toolbar__row toolbar__row--eval' },
        h('label', { class: 'inline-label' }, h('span', null, 'Чек-лист'), checklistSel),
        countLabel,
        h('div', { class: 'toolbar__actions' }, evalSelectedBtn, evalAllBtn)),
      progressBox),
    tableBox,
  );

  /* ---------- данные ---------- */
  function setFilter(key, value, refetch) {
    state.filters[key] = value;
    prefs.set('dialogs.filters', { group: state.filters.group, language: state.filters.language, channel: state.filters.channel, status: state.filters.status });
    if (refetch) loadDialogs(); else renderTable();
    if (key === 'group') loadStats();
  }

  function filtered() {
    const f = state.filters.status;
    if (!f) return state.items;
    return state.items.filter((d) => {
      const l = d.latest;
      switch (f) {
        case 'none': return !l;
        case 'active': return l && (l.status === 'queued' || l.status === 'running');
        case 'done': return l && l.status === 'done';
        case 'error': return l && l.status === 'error';
        case 'gross': return l && l.gross;
        case 'check': return l && isNum(l.min_agreement) && l.min_agreement < 0.999;
        case 'appeal': return l && l.open_appeals > 0;
        default: return true;
      }
    });
  }

  async function loadStats() {
    try {
      // сводка по выбранной группе, чтобы KPI совпадали с таблицей
      const s = await api.stats(state.filters.group ? { group_id: state.filters.group } : undefined);
      if (destroyed) return;
      renderKpi(s);
    } catch (e) {
      clear(kpiBox).append(h('div', { class: 'kpi-strip__error' }, `Сводка недоступна: ${e.message}`));
    }
  }

  async function loadDialogs({ quiet = false } = {}) {
    if (!quiet) { state.loading = true; renderTable(); }
    try {
      const r = await api.dialogs({ group_id: state.filters.group, language: state.filters.language, channel: state.filters.channel, q: state.filters.q });
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
    if (state.items.some((d) => d.latest && (d.latest.status === 'queued' || d.latest.status === 'running'))) startPolling();
  }

  async function loadChecklists() {
    try {
      const [list, st] = await Promise.all([api.checklists(), api.settings().catch(() => null)]);
      state.checklists = list.items || [];
      state.settings = st && st.settings;
      const active = state.checklists.find((c) => c.is_active);
      if (!state.checklistId || !state.checklists.some((c) => c.id === state.checklistId)) state.checklistId = active ? active.id : (state.checklists[0] && state.checklists[0].id);
      clear(checklistSel);
      for (const c of [...state.checklists].sort((a, b) => b.id - a.id)) {
        checklistSel.append(h('option', { value: c.id, selected: c.id === state.checklistId },
          `${c.name}, версия ${c.version}${c.is_active ? ' (активная)' : ''}`));
      }
      if (query.checklist) toast('Чек-лист выбран для оценки. Отметьте диалоги и нажмите «Оценить».', 'info');
    } catch (e) {
      clear(checklistSel).append(h('option', { value: '' }, 'Чек-листы недоступны'));
    }
  }

  function renderGroups() {
    const cur = state.filters.group;
    clear(groupSel);
    groupSel.append(h('option', { value: '' }, 'Все группы'));
    const groups = [...new Set([...(state.groups || []), cur].filter(Boolean))];
    for (const g of groups) groupSel.append(h('option', { value: g, selected: g === cur }, `Группа ${g}`));
    groupSel.value = cur;
  }

  /* ---------- KPI ---------- */
  function renderKpi(s) {
    clear(kpiBox);
    const byLang = s.by_language ? Object.entries(s.by_language).map(([k, v]) => `${LANG_LABELS[k] || k}: ${fmt.n2(v.avg)} (${v.count})`).join('\n') : '';
    const items = [
      ['Диалогов', fmt.int(s.dialogs), null],
      ['Оценено', fmt.int(s.evaluated), isNum(s.dialogs) && s.dialogs ? `${Math.round((100 * (s.evaluated || 0)) / s.dialogs)} % набора` : null],
      ['Средний балл', fmt.n2(s.avg_total), byLang ? 'по языкам' : null, byLang],
      ['Грубых ошибок', fmt.int(s.gross_count), null, null, s.gross_count > 0 ? 'danger' : null],
      ['Открытых апелляций', fmt.int(s.open_appeals), null, null, s.open_appeals > 0 ? 'warn' : null],
      ['Затраты на ИИ', fmt.money(s.total_cost_usd), 'всего по оценкам'],
    ];
    for (const [label, value, sub, tip, tone] of items) {
      kpiBox.append(h('div', { class: ['kpi', tone && `kpi--${tone}`], 'data-tip': tip || null, tabindex: tip ? 0 : null },
        h('div', { class: 'kpi__value' }, value),
        h('div', { class: 'kpi__label' }, label),
        sub ? h('div', { class: 'kpi__sub' }, sub) : null));
    }
  }

  /* ---------- таблица ---------- */
  function renderTable() {
    clear(tableBox);
    const rows = filtered();
    updateActions(rows);
    if (state.loading && !state.items.length) { tableBox.append(h('div', { class: 'card pad' }, skeleton(8))); return; }
    if (state.error) { tableBox.append(errorState(state.error, () => loadDialogs())); return; }
    if (!state.items.length) {
      tableBox.append(emptyState({
        title: 'Диалогов пока нет',
        text: 'Загрузите набор из API организаторов по group_id, импортируйте JSON-файл или вставьте транскрипт текстом.',
        iconName: 'chat',
        action: h('div', { class: 'empty__actions' },
          button('Загрузить из API', { kind: 'primary', iconName: 'cloud', onClick: busy('fetch', onFetch) }),
          button('Вставить текст', { kind: 'secondary', iconName: 'edit', onClick: openPaste })),
      }));
      return;
    }
    if (!rows.length) {
      tableBox.append(emptyState({ title: 'Нет диалогов под эти фильтры', text: 'Измените статус или сбросьте поиск.', iconName: 'search' }));
      return;
    }

    const allChecked = rows.every((d) => state.selected.has(d.id));
    const headCb = h('input', { type: 'checkbox', 'aria-label': 'Выбрать все', checked: allChecked });
    headCb.indeterminate = !allChecked && rows.some((d) => state.selected.has(d.id));
    headCb.addEventListener('change', () => {
      for (const d of rows) { if (headCb.checked) state.selected.add(d.id); else state.selected.delete(d.id); }
      renderTable();
    });

    const tbody = h('tbody');
    for (const d of rows) tbody.append(rowEl(d));
    tableBox.append(h('table', { class: 'table table--dialogs' },
      h('thead', null, h('tr', null,
        h('th', { class: 'col-cb' }, headCb),
        h('th', null, 'ID диалога'),
        h('th', null, 'Канал'),
        h('th', null, 'Язык'),
        h('th', { class: 'num' }, 'Реплик'),
        h('th', { class: 'num' }, 'Итог'),
        h('th', null, 'Грубая ошибка'),
        h('th', null, 'Согласованность'),
        h('th', null, 'Апелляции'),
        h('th', null, 'Статус'),
        h('th', null, 'Чек-лист'))),
      tbody));
  }

  function rowEl(d) {
    const l = d.latest;
    const active = state.active.find((e) => e.dialog_id === d.id);
    const status = active ? active.status : l ? l.status : null;
    const href = `#/dialog/${encodeURIComponent(d.id)}`;
    const cb = h('input', { type: 'checkbox', 'aria-label': `Выбрать ${d.id}`, checked: state.selected.has(d.id) });
    cb.addEventListener('change', () => { if (cb.checked) state.selected.add(d.id); else state.selected.delete(d.id); renderTable(); });
    cb.addEventListener('click', (e) => e.stopPropagation());
    const done = l && l.status === 'done';
    const tr = h('tr', { class: ['row-link', state.selected.has(d.id) && 'is-selected'], onclick: (e) => { if (!e.target.closest('a, input, button')) ctx.navigate(href); } },
      h('td', { class: 'col-cb' }, cb),
      h('td', null, h('a', { class: 'id-link', href }, d.id)),
      h('td', null, channelCell(d.channel)),
      h('td', null, h('span', { class: 'lang', 'data-tip': LANG_LABELS[d.language] || d.language }, d.language || '—')),
      h('td', { class: 'num' }, fmt.int(d.turns)),
      h('td', { class: 'num' }, done ? scorePill(l.total, l.final_total) : h('span', { class: 'muted' }, '—')),
      h('td', null, done ? (l.gross ? h('span', { class: 'flag flag--gross' }, icon('alert', 13), 'Есть') : h('span', { class: 'muted' }, 'Нет')) : h('span', { class: 'muted' }, '—')),
      h('td', null, done ? agreementMeter(l.min_agreement) : h('span', { class: 'muted' }, '—')),
      h('td', null, l && (l.open_appeals || l.decided_appeals) ? h('span', { class: 'appeal-count' },
        l.open_appeals ? h('span', { class: 'chip chip--warn', 'data-tip': 'Открытые апелляции' }, `${l.open_appeals} откр.`) : null,
        l.decided_appeals ? h('span', { class: 'chip chip--muted', 'data-tip': 'Рассмотренные апелляции' }, `${l.decided_appeals} реш.`) : null) : h('span', { class: 'muted' }, '—')),
      h('td', null, statusChip(status, l && l.error)),
      h('td', { class: 'cell-checklist' }, l ? h('span', { 'data-tip': `${l.checklist_name || ''}, ${fmt.date(l.finished_at || l.created_at)}` }, `v${l.checklist_version ?? '?'}`) : h('span', { class: 'muted' }, '—')));
    return tr;
  }

  function updateActions(rows) {
    const n = state.selected.size;
    evalSelectedBtn.disabled = n === 0;
    evalSelectedBtn.querySelector('span').textContent = n ? `Оценить выбранные (${n})` : 'Оценить выбранные';
    evalAllBtn.disabled = rows.length === 0;
    evalAllBtn.querySelector('span').textContent = `Оценить все отфильтрованные (${rows.length})`;
    countLabel.textContent = `${rows.length} ${plural(rows.length, 'диалог', 'диалога', 'диалогов')}${n ? `, выбрано ${n}` : ''}`;
  }

  /* ---------- оценка ---------- */
  function estimate(n) {
    return estimateCost(state.settings, n);
  }

  async function evaluate(ids, all = false) {
    if (!ids.length) return;
    if (!state.checklistId) { toast('Сначала создайте чек-лист в разделе «Чек-листы».', 'error'); return; }
    const est = estimate(ids.length);
    const cl = state.checklists.find((c) => c.id === state.checklistId);
    const msg = `${ids.length} ${plural(ids.length, 'диалог', 'диалога', 'диалогов')} по чек-листу «${cl ? `${cl.name}, версия ${cl.version}` : state.checklistId}», ${est.votes} ${plural(est.votes, 'прогон', 'прогона', 'прогонов')} на диалог. `
      + costHint(est);
    if (all || ids.length > 3) {
      const ok = await confirmDialog({ title: 'Запустить оценку?', message: msg, confirmLabel: 'Запустить оценку' });
      if (!ok) return;
    }
    try {
      const r = await api.evaluate(ids, state.checklistId);
      const evIds = r.evaluation_ids || [];
      const prev = loadBatch();
      const batch = prev && prev.ids ? { ids: [...prev.ids, ...evIds], total: prev.total + evIds.length } : { ids: evIds, total: evIds.length };
      saveBatch(batch);
      toast(`Оценка запущена: ${evIds.length} ${plural(evIds.length, 'диалог', 'диалога', 'диалогов')}`, 'success');
      state.selected.clear();
      await loadDialogs({ quiet: true });
      startPolling(true);
    } catch (e) {
      toastError(e, 'Не удалось запустить оценку');
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
        const active = r.items || [];
        state.active = active;
        const key = active.map((e) => e.id).sort((a, b) => a - b).join(',');
        const changed = lastActiveKey !== null && key !== lastActiveKey;
        lastActiveKey = key;
        renderProgress();
        if (changed) { await loadDialogs({ quiet: true }); loadStats(); ctx.refreshBadges(); } else renderTable();
        if (!active.length) {
          finishBatch();
          return;
        }
      } catch {
        // временная ошибка сети — пробуем дальше
      }
      pollTimer = setTimeout(tick, 2000);
    };
    pollTimer = setTimeout(tick, immediate ? 300 : 2000);
  }

  function finishBatch() {
    const batch = loadBatch();
    if (batch && batch.total) {
      const errs = state.items.filter((d) => d.latest && batch.ids.includes(d.latest.id) && d.latest.status === 'error').length;
      toast(errs ? `Оценка завершена, с ошибкой: ${errs}` : 'Оценка завершена', errs ? 'error' : 'success');
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
    if (!active.length) { progressBox.hidden = true; return; }
    progressBox.hidden = false;
    clear(progressBox);
    let total;
    let done;
    if (batch && batch.total) {
      const inBatch = active.filter((e) => batch.ids.includes(e.id)).length;
      total = batch.total;
      done = Math.max(0, total - inBatch);
    } else {
      total = active.length;
      done = 0;
    }
    const running = active.filter((e) => e.status === 'running').length;
    const pct = total ? Math.round((100 * done) / total) : 0;
    progressBox.append(
      h('div', { class: 'batch-progress__head' },
        h('span', { class: 'spinner spinner--xs' }),
        h('strong', null, batch && batch.total ? `Оценено ${done} из ${total}` : `В работе: ${active.length}`),
        h('span', { class: 'muted' }, `сейчас оценивается ${running}, в очереди ${active.length - running}`)),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done },
        h('div', { class: 'progress__bar', style: { width: `${pct}%` } })));
  }

  /* ---------- загрузка и импорт ---------- */
  async function onFetch() {
    const g = fetchInput.value.trim() || 'DEV';
    prefs.set('dialogs.fetchGroup', g);
    try {
      toast(`Загружаем набор ${g}…`, 'info', 2000);
      const r = await api.fetchDataset(g);
      toast(`Загружено ${r.imported} ${plural(r.imported, 'диалог', 'диалога', 'диалогов')} в группу ${r.group_id || g}`, 'success');
      state.filters.group = r.group_id || g;
      setFilter('group', state.filters.group, true);
      warnRenamed(r);
    } catch (e) {
      toastError(e, 'Загрузка не удалась');
    }
  }

  async function onFile() {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    let text;
    try { text = await f.text(); } catch (e) { toastError(e, 'Файл не прочитан'); return; }
    let payload;
    // .txt-транскрипт вида «[00:02] Клиент: …» тоже начинается с «[», поэтому JSON пробуем,
    // но при неудаче для не-.json файлов импортируем как текст
    const isJsonName = /\.json$/i.test(f.name);
    if (isJsonName || /^\s*[[{]/.test(text)) {
      try { payload = JSON.parse(text); } catch (e) {
        if (isJsonName) { toast(`Файл ${f.name} не является корректным JSON: ${e.message}`, 'error'); return; }
        payload = null;
      }
    }
    if (!payload) payload = { text, conversation_id: f.name.replace(/\.[^.]+$/, '') };
    await doImport(payload);
  }

  async function doImport(payload) {
    try {
      // без group_id: ответ организаторов попадёт в свою группу (dataset_group_id), остальное — в UPLOAD
      const r = await api.importDialogs(payload);
      const n = r.imported ?? (r.ids || []).length;
      const grp = r.group_id || 'UPLOAD';
      toast(`Импортировано ${n} ${plural(n, 'диалог', 'диалога', 'диалогов')} в группу ${grp}`, 'success');
      setFilter('group', grp, true);
      warnRenamed(r);
      if (r.ids && r.ids.length === 1) {
        state.selected = new Set(r.ids);
      }
      return true;
    } catch (e) {
      toastError(e, 'Импорт не удался');
      return false;
    }
  }

  /** Диалог с таким ID уже был оценён по другому тексту — сервер сохранил новый под другим ID. */
  function warnRenamed(r) {
    const pairs = Object.entries((r && r.renamed) || {});
    if (!pairs.length) return;
    const shown = pairs.slice(0, 3).map(([a, b]) => `${a} → ${b}`).join(', ');
    toast(`Текст ${pairs.length} ${plural(pairs.length, 'диалога', 'диалогов', 'диалогов')} отличается от уже оценённого, поэтому сохранён под новым ID: ${shown}${pairs.length > 3 ? '…' : ''}. Прежние оценки не затронуты.`, 'info', 9000);
  }

  function openPaste() {
    const ta = h('textarea', { class: 'input input--mono', rows: 14, placeholder: '[00:02] Клиент: Здравствуйте, не могу пополнить счёт\n[00:40] Оператор: Добрый день! Меня зовут Айгерим…\n\nили без времени:\nКлиент: …\nОператор: …' });
    const idIn = h('input', { class: 'input', placeholder: 'например, demo-001 (необязательно)' });
    const chSel = select([{ value: 'agent chat', label: 'Чат' }, { value: 'voice call', label: 'Звонок' }], 'agent chat');
    const lnSel = select([{ value: '', label: 'Определить автоматически' }, { value: 'RU', label: 'Русский' }, { value: 'KZ', label: 'Казахский' }, { value: 'EN', label: 'Английский' }], '');
    openModal({
      title: 'Вставить транскрипт',
      subtitle: 'Каждая реплика с новой строки: роль (клиент, оператор, бот, система) и текст. Время в квадратных скобках необязательно.',
      size: 'lg',
      body: h('div', { class: 'form-grid' },
        h('div', { class: 'form-grid__full' }, field('Текст диалога', ta)),
        field('ID диалога', idIn), field('Канал', chSel), field('Язык', lnSel)),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: 'Импортировать', kind: 'primary', icon: 'upload',
          onClick: async () => {
            if (!ta.value.trim()) { toast('Вставьте текст диалога', 'error'); return false; }
            const payload = { text: ta.value, channel: chSel.value };
            if (idIn.value.trim()) payload.conversation_id = idIn.value.trim();
            if (lnSel.value) payload.language = lnSel.value;
            return (await doImport(payload)) ? undefined : false;
          },
        },
      ],
    });
  }

  /* ---------- старт ---------- */
  renderGroups();
  renderTable();
  loadStats();
  loadChecklists();
  await loadDialogs();
  if (loadBatch()) startPolling(true);

  return () => {
    destroyed = true;
    if (pollTimer) clearTimeout(pollTimer);
  };
}
