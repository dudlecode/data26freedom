// Чек-листы: версии (активация) и редактор с живой валидацией. Каждое сохранение — новая версия.

import { api } from '../api.js';
import {
  h, append, clear, icon, button, fmt, isNum, toast, toastError, openModal, confirmDialog, debounce,
  emptyState, errorState, skeleton, field, select, plural, TYPE_LABELS,
} from '../ui.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

export async function mount(root, { query, ctx }) {
  ctx.setTitle('Чек-листы');
  let destroyed = false;
  const state = {
    versions: [],
    cfg: null,
    snapshot: '',
    source: null, // {id, version, name} или {default: true}
    expanded: new Set(),
    errors: [],
    serverWeight: null,
    validating: false,
  };

  const listBox = h('div', { class: 'versions' });
  const editorBox = h('div', { class: 'editor' });
  root.append(
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', { class: 'page-title' }, 'Чек-листы'),
        h('p', { class: 'page-sub' }, 'Критерии, по которым ИИ оценивает оператора. Каждое сохранение создаёт новую версию; оценки хранят ссылку на свою версию.'))),
    h('div', { class: 'checklists-grid' },
      h('aside', { class: 'panel versions-panel', 'aria-label': 'Версии' },
        h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, 'Версии')),
        listBox),
      editorBox));

  const onBeforeUnload = (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  // переход по разделам приложения (hashchange) тоже спрашивает про несохранённые изменения
  if (ctx && typeof ctx.setLeaveGuard === 'function') ctx.setLeaveGuard(() => !isDirty());

  function isDirty() {
    return state.cfg && JSON.stringify(state.cfg) !== state.snapshot;
  }

  /* ---------- версии ---------- */
  async function loadVersions() {
    try {
      state.versions = ((await api.checklists()).items || []).sort((a, b) => b.id - a.id);
    } catch (e) {
      clear(listBox).append(errorState(e, loadVersions));
      return false;
    }
    renderVersions();
    return true;
  }

  function renderVersions() {
    clear(listBox);
    if (!state.versions.length) {
      listBox.append(h('p', { class: 'muted pad' }, 'Версий пока нет. Сохраните чек-лист из редактора.'));
      return;
    }
    for (const v of state.versions) {
      const current = state.source && state.source.id === v.id;
      const activateBtn = v.is_active ? null : button('Сделать активным', {
        kind: 'ghost', size: 'sm',
        onClick: async (e) => {
          e.stopPropagation();
          try {
            await api.activateChecklist(v.id);
            toast(`Версия ${v.version} теперь активна: новые оценки пойдут по ней`, 'success');
            loadVersions();
          } catch (err) { toastError(err, 'Не удалось активировать'); }
        },
      });
      listBox.append(h('div', {
        class: ['version', current && 'is-current', v.is_active && 'is-active'],
        tabindex: 0, role: 'button', 'aria-label': `Открыть версию ${v.version}`,
        onclick: () => openVersion(v.id),
        onkeydown: (e) => { if (e.key === 'Enter') openVersion(v.id); },
      },
      h('div', { class: 'version__top' },
        h('span', { class: 'version__no' }, `v${v.version}`),
        h('span', { class: 'version__name' }, v.name),
        v.is_active ? h('span', { class: 'chip chip--ok' }, 'активная') : null),
      h('div', { class: 'version__meta' },
        `${v.criteria_count} ${plural(v.criteria_count, 'критерий', 'критерия', 'критериев')}, сумма весов ${fmt.n2(v.total_weight)}`),
      h('div', { class: 'version__meta muted' }, fmt.date(v.created_at)),
      v.note ? h('div', { class: 'version__note' }, v.note) : null,
      current || activateBtn ? h('div', { class: 'version__actions' },
        current ? h('span', { class: 'muted small' }, 'открыта в редакторе') : null,
        activateBtn) : null));
    }
  }

  async function guardDirty() {
    if (!isDirty()) return true;
    return confirmDialog({ title: 'Несохранённые изменения', message: 'Изменения в редакторе будут потеряны. Продолжить?', confirmLabel: 'Отбросить изменения', danger: true });
  }

  async function openVersion(id) {
    if (state.source && state.source.id === id && !isDirty()) return;
    if (!(await guardDirty())) return;
    clear(editorBox).append(h('div', { class: 'card pad' }, skeleton(10)));
    try {
      const v = await api.checklist(id);
      setEditor(v.config, { id: v.id, version: v.version, name: v.name, is_active: v.is_active });
    } catch (e) {
      clear(editorBox).append(errorState(e, () => openVersion(id)));
    }
  }

  async function resetToDefault() {
    const ok = await confirmDialog({
      title: 'Сбросить к исходному чек-листу?',
      message: 'В редактор загрузится исходный чек-лист из поставки. Сохранённые версии не изменятся; чтобы применить его, сохраните новую версию.',
      confirmLabel: 'Загрузить исходный', danger: isDirty(),
    });
    if (!ok) return;
    try {
      const r = await api.defaultChecklist();
      setEditor(r && r.config ? r.config : r, { default: true }, { dirty: true });
      toast('Исходный чек-лист загружен в редактор', 'info');
    } catch (e) { toastError(e, 'Исходный чек-лист не загружен'); }
  }

  function setEditor(cfg, source, { dirty = false } = {}) {
    state.cfg = normalizeCfg(clone(cfg || {}));
    state.snapshot = dirty ? '' : JSON.stringify(state.cfg);
    state.source = source;
    state.expanded = new Set();
    renderVersions();
    renderEditor();
    validate();
  }

  function normalizeCfg(cfg) {
    cfg.name = cfg.name || 'Новый чек-лист';
    cfg.sections = Array.isArray(cfg.sections) ? cfg.sections : [];
    cfg.criteria = Array.isArray(cfg.criteria) ? cfg.criteria : [];
    for (const c of cfg.criteria) {
      c.type = c.type || 'binary';
      c.scale = Array.isArray(c.scale) ? c.scale : [];
      c.weight = isNum(Number(c.weight)) ? Number(c.weight) : 0;
      c.na_allowed = !!c.na_allowed;
      for (const k of ['code', 'name', 'description', 'na_condition', 'guidance', 'section']) if (c[k] == null) c[k] = '';
    }
    return cfg;
  }

  /* ---------- валидация ---------- */
  const validate = debounce(async () => {
    if (!state.cfg) return;
    const local = localErrors(state.cfg);
    state.validating = true;
    renderStatus();
    try {
      const r = await api.validateChecklist(state.cfg);
      if (destroyed) return;
      state.errors = [...new Set([...(r.errors || []), ...local])];
      state.serverWeight = isNum(r.total_weight) ? r.total_weight : null;
    } catch {
      state.errors = local;
      state.serverWeight = null;
    }
    state.validating = false;
    renderStatus();
  }, 350);

  function localErrors(cfg) {
    const errs = [];
    const codes = cfg.criteria.map((c) => String(c.code || '').trim()).filter(Boolean);
    if (new Set(codes).size !== codes.length) errs.push('Коды критериев повторяются.');
    for (const c of cfg.criteria) {
      if (c.type === 'scale' && c.scale.some((s) => !isNum(Number(s.value)) || s.value === '')) errs.push(`${c.name || c.id}: у каждой ступени шкалы должно быть числовое значение.`);
      if (c.na_allowed && c.type !== 'flag' && !String(c.na_condition || '').trim()) errs.push(`${c.name || c.id}: опишите условие N/A.`);
    }
    return errs;
  }

  function weightSum() {
    return state.cfg.criteria.filter((c) => c.type !== 'flag').reduce((s, c) => s + (Number(c.weight) || 0), 0);
  }

  /* ---------- редактор ---------- */
  let statusBox;
  let saveBtn;
  let critBox;
  let sectionsBox;
  let titleEl;

  function onChange() {
    renderStatus();
    validate();
  }

  function renderEditor() {
    clear(editorBox);
    const cfg = state.cfg;
    const src = state.source || {};
    titleEl = h('h2', { class: 'editor__title' }, cfg.name || 'Без названия');
    statusBox = h('div', { class: 'editor__status' });
    saveBtn = button('Сохранить как новую версию', { kind: 'primary', iconName: 'check', onClick: openSave });

    editorBox.append(h('div', { class: 'editor__bar card' },
      h('div', null,
        titleEl,
        h('div', { class: 'muted small' }, src.default ? 'Исходный чек-лист из поставки, ещё не сохранён' : `На основе версии ${src.version}${src.is_active ? ' (активная)' : ''}`)),
      h('div', { class: 'editor__bar-actions' },
        button('Сбросить к исходному', { kind: 'ghost', iconName: 'refresh', size: 'sm', onClick: resetToDefault }),
        saveBtn),
      statusBox));

    /* общие поля */
    const nameIn = h('input', { class: 'input', value: cfg.name || '' });
    nameIn.addEventListener('input', () => { cfg.name = nameIn.value; titleEl.textContent = cfg.name || 'Без названия'; onChange(); });
    const descIn = h('textarea', { class: 'input', rows: 2, value: cfg.description || '' });
    descIn.addEventListener('input', () => { cfg.description = descIn.value; onChange(); });
    const guideIn = h('textarea', { class: 'input', rows: 7, value: cfg.general_guidance || '' });
    guideIn.addEventListener('input', () => { cfg.general_guidance = guideIn.value; onChange(); });
    const zeroCb = h('input', { type: 'checkbox', checked: !!cfg.gross_error_zeroes_total });
    zeroCb.addEventListener('change', () => { cfg.gross_error_zeroes_total = zeroCb.checked; onChange(); });

    editorBox.append(h('section', { class: 'card pad editor__general' },
      h('div', { class: 'form-grid' },
        h('div', { class: 'form-grid__full' }, field('Название чек-листа', nameIn)),
        h('div', { class: 'form-grid__full' }, field('Описание', descIn)),
        h('div', { class: 'form-grid__full' }, field('Общие указания для ИИ', guideIn, { hint: 'Применяются ко всем критериям: кого оценивать, как трактовать бота, удержание, ошибки распознавания.' })),
        h('label', { class: 'switch-row form-grid__full' }, zeroCb, h('span', { class: 'switch' }), h('span', null, 'Грубая ошибка обнуляет итог (иначе показывается отдельным флагом)')))));

    /* секции */
    sectionsBox = h('div', { class: 'sections-editor' });
    editorBox.append(h('section', { class: 'card pad' },
      h('div', { class: 'card__head' }, h('h3', { class: 'card__title' }, 'Секции'),
        button('Добавить секцию', { kind: 'ghost', iconName: 'plus', size: 'sm', onClick: addSection })),
      sectionsBox));
    renderSections();

    /* критерии */
    critBox = h('div', { class: 'crit-editor-list' });
    editorBox.append(h('section', { class: 'editor__criteria' },
      h('div', { class: 'card__head card__head--loose' },
        h('h3', { class: 'card__title' }, 'Критерии'),
        h('div', { class: 'inline-group' },
          button('Развернуть все', { kind: 'ghost', size: 'sm', onClick: () => { cfg.criteria.forEach((c) => state.expanded.add(c.id)); renderCriteria(); } }),
          button('Свернуть все', { kind: 'ghost', size: 'sm', onClick: () => { state.expanded.clear(); renderCriteria(); } }))),
      critBox,
      h('button', { type: 'button', class: 'add-crit', onclick: addCriterion }, icon('plus', 18), 'Добавить критерий')));
    renderCriteria();
    renderStatus();
  }

  function renderStatus() {
    if (!statusBox) return;
    clear(statusBox);
    const sum = weightSum();
    const dirty = isDirty();
    append(statusBox, [
      h('div', { class: 'weight-sum' },
        h('span', { class: ['weight-sum__num', Math.abs(sum - 100) > 0.004 && 'is-off'] }, fmt.n2(sum)),
        h('span', null, 'сумма весов'),
        h('span', { class: 'muted small', 'data-tip': 'Итог всегда приводится к 100: веса нормируются, а вес критериев с N/A перераспределяется пропорционально между применимыми.' },
          Math.abs(sum - 100) > 0.004 ? 'веса будут нормированы к 100' : 'нормируется к 100 с перераспределением N/A', icon('info', 12))),
      h('div', { class: 'editor__flags' },
        dirty ? h('span', { class: 'chip chip--warn' }, 'есть несохранённые изменения') : h('span', { class: 'chip chip--muted' }, 'без изменений'),
        state.validating ? h('span', { class: 'muted small' }, h('span', { class: 'spinner spinner--xs' }), ' проверка…')
          : state.errors.length ? h('span', { class: 'chip chip--no' }, `${state.errors.length} ${plural(state.errors.length, 'ошибка', 'ошибки', 'ошибок')}`)
            : h('span', { class: 'chip chip--ok' }, icon('check', 12), 'чек-лист корректен')),
      state.errors.length ? h('ul', { class: 'error-list' }, state.errors.map((e) => h('li', null, e))) : null]);
    if (saveBtn) {
      // без изменений сохранять нечего (кроме ещё не сохранённого исходного чек-листа)
      const nothingToSave = !dirty && !(state.source && state.source.default);
      saveBtn.disabled = state.errors.length > 0 || nothingToSave;
      saveBtn.title = nothingToSave ? 'Нет изменений относительно выбранной версии' : '';
    }
  }

  /* --- секции --- */
  function renderSections() {
    clear(sectionsBox);
    const cfg = state.cfg;
    if (!cfg.sections.length) sectionsBox.append(h('p', { class: 'muted' }, 'Секций нет: критерии будут без группировки.'));
    cfg.sections.forEach((s, i) => {
      const used = cfg.criteria.filter((c) => c.section === s.id).length;
      const nameIn = h('input', { class: 'input input--sm', value: s.name || '', 'aria-label': 'Название секции' });
      nameIn.addEventListener('input', () => { s.name = nameIn.value; onChange(); refreshSectionSelects(); });
      sectionsBox.append(h('div', { class: 'section-row' },
        h('span', { class: 'section-row__id', 'data-tip': 'Идентификатор секции' }, s.id),
        nameIn,
        h('span', { class: 'muted small' }, `${used} ${plural(used, 'критерий', 'критерия', 'критериев')}`),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Выше', disabled: i === 0, onclick: () => { move(cfg.sections, i, -1); renderSections(); renderCriteria(); onChange(); } }, icon('up', 15)),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Ниже', disabled: i === cfg.sections.length - 1, onclick: () => { move(cfg.sections, i, 1); renderSections(); renderCriteria(); onChange(); } }, icon('down', 15)),
        h('button', {
          type: 'button', class: 'icon-btn icon-btn--danger', 'aria-label': 'Удалить секцию',
          onclick: async () => {
            if (used) { toast('Сначала перенесите критерии этой секции в другую', 'error'); return; }
            cfg.sections.splice(i, 1); renderSections(); renderCriteria(); onChange();
          },
        }, icon('trash', 15))));
    });
  }

  function addSection() {
    const cfg = state.cfg;
    let n = cfg.sections.length + 1;
    while (cfg.sections.some((s) => s.id === `s${n}`)) n += 1;
    cfg.sections.push({ id: `s${n}`, name: 'Новая секция' });
    renderSections();
    renderCriteria();
    onChange();
  }

  function refreshSectionSelects() {
    for (const sel of critBox.querySelectorAll('select[data-section-select]')) {
      for (const opt of sel.options) {
        const s = state.cfg.sections.find((x) => x.id === opt.value);
        if (s) opt.textContent = s.name || s.id;
      }
    }
  }

  /* --- критерии --- */
  function nextId() {
    const nums = state.cfg.criteria.map((c) => Number(String(c.id).replace(/\D/g, ''))).filter(isNum);
    const n = (nums.length ? Math.max(...nums) : 0) + 1;
    let id = `c${String(n).padStart(2, '0')}`;
    let k = n;
    while (state.cfg.criteria.some((c) => c.id === id)) { k += 1; id = `c${String(k).padStart(2, '0')}`; }
    return id;
  }

  function addCriterion() {
    const id = nextId();
    const cfg = state.cfg;
    const flagIdx = cfg.criteria.findIndex((c) => c.type === 'flag');
    const c = {
      id, code: id.replace(/^c/, ''), name: 'Новый критерий',
      section: (cfg.sections.find((s) => !cfg.criteria.some((x) => x.section === s.id && x.type === 'flag')) || cfg.sections[0] || {}).id || '',
      type: 'binary', weight: 10, na_allowed: false, description: 'Да — ', na_condition: '', scale: [], guidance: '',
    };
    // новые критерии с баллами встают перед флагом грубых ошибок
    if (flagIdx >= 0) cfg.criteria.splice(flagIdx, 0, c); else cfg.criteria.push(c);
    state.expanded.add(id);
    renderCriteria();
    renderSections();
    onChange();
    requestAnimationFrame(() => {
      const el = critBox.querySelector(`[data-cid="${id}"]`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); const inp = el.querySelector('input[data-f="name"]'); if (inp) { inp.focus(); inp.select(); } }
    });
  }

  function move(arr, i, d) {
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  function renderCriteria() {
    clear(critBox);
    const cfg = state.cfg;
    if (!cfg.criteria.length) {
      critBox.append(emptyState({ title: 'В чек-листе нет критериев', text: 'Добавьте первый критерий кнопкой ниже.', iconName: 'list' }));
      return;
    }
    cfg.criteria.forEach((c, i) => critBox.append(critCard(c, i)));
  }

  function critCard(c, i) {
    const cfg = state.cfg;
    const open = state.expanded.has(c.id);
    const share = h('span', { class: 'crit-ed__share' });
    const sumName = h('span', { class: 'crit-ed__name' });
    const sumCode = h('span', { class: 'crit__code' });
    const sumType = h('span', { class: 'chip chip--muted' });
    const sumNa = h('span', { class: 'chip chip--muted' }, 'N/A');
    const refreshSummary = () => {
      sumName.textContent = c.name || 'Без названия';
      sumCode.textContent = c.code || c.id;
      sumType.textContent = c.type === 'scale' ? `Шкала, ${c.scale.length} ${plural(c.scale.length, 'ступень', 'ступени', 'ступеней')}` : TYPE_LABELS[c.type] || c.type;
      sumNa.hidden = !c.na_allowed || c.type === 'flag';
      const sum = weightSum();
      share.textContent = c.type === 'flag' ? 'без баллов' : `вес ${fmt.n2(Number(c.weight) || 0)}${sum > 0 ? `, ${fmt.n2((100 * (Number(c.weight) || 0)) / sum)} % итога` : ''}`;
      for (const el of critBox.querySelectorAll('[data-share-refresh]')) if (el !== card) el.dispatchEvent(new Event('refresh-share'));
    };
    const changed = () => { refreshSummary(); onChange(); };

    const card = h('article', { class: ['crit-ed', open && 'is-open', c.type === 'flag' && 'crit-ed--flag'], dataset: { cid: c.id, shareRefresh: '1' } });
    card.addEventListener('refresh-share', () => {
      const sum = weightSum();
      share.textContent = c.type === 'flag' ? 'без баллов' : `вес ${fmt.n2(Number(c.weight) || 0)}${sum > 0 ? `, ${fmt.n2((100 * (Number(c.weight) || 0)) / sum)} % итога` : ''}`;
    });

    const toggle = () => {
      if (state.expanded.has(c.id)) state.expanded.delete(c.id); else state.expanded.add(c.id);
      card.classList.toggle('is-open');
      head.setAttribute('aria-expanded', String(card.classList.contains('is-open')));
    };
    const head = h('div', { class: 'crit-ed__head', role: 'button', tabindex: 0, 'aria-expanded': String(open), onclick: (e) => { if (!e.target.closest('.crit-ed__tools')) toggle(); }, onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === head) { e.preventDefault(); toggle(); } } },
      icon('chevron', 16, 'crit-ed__chev'),
      sumCode, sumName, sumType, sumNa, h('span', { class: 'spacer' }), share,
      h('div', { class: 'crit-ed__tools' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Переместить выше', 'data-tip': 'Выше', disabled: i === 0, onclick: () => { move(cfg.criteria, i, -1); renderCriteria(); onChange(); } }, icon('up', 15)),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Переместить ниже', 'data-tip': 'Ниже', disabled: i === cfg.criteria.length - 1, onclick: () => { move(cfg.criteria, i, 1); renderCriteria(); onChange(); } }, icon('down', 15)),
        h('button', {
          type: 'button', class: 'icon-btn', 'aria-label': 'Дублировать', 'data-tip': 'Дублировать',
          onclick: () => {
            const d = clone(c); d.id = nextId(); d.code = d.id.replace(/^c/, ''); d.name = `${c.name} (копия)`;
            cfg.criteria.splice(i + 1, 0, d); state.expanded.add(d.id); renderCriteria(); renderSections(); onChange();
          },
        }, icon('copy', 15)),
        h('button', {
          type: 'button', class: 'icon-btn icon-btn--danger', 'aria-label': 'Удалить', 'data-tip': 'Удалить критерий',
          onclick: async () => {
            const ok = await confirmDialog({ title: 'Удалить критерий?', message: `«${c.name}» будет удалён из редактора. Сохранённые версии и прошлые оценки не изменятся.`, confirmLabel: 'Удалить', danger: true });
            if (!ok) return;
            cfg.criteria.splice(cfg.criteria.indexOf(c), 1); renderCriteria(); renderSections(); onChange();
          },
        }, icon('trash', 15))));
    card.append(head);

    /* тело */
    const inp = (key, props = {}) => {
      const el = h('input', { class: 'input', value: c[key] ?? '', dataset: { f: key }, ...props });
      el.addEventListener('input', () => { c[key] = props.type === 'number' ? (el.value === '' ? 0 : Number(el.value)) : el.value; changed(); });
      return el;
    };
    const area = (key, rows, props = {}) => {
      const el = h('textarea', { class: 'input', rows, value: c[key] ?? '', ...props });
      el.addEventListener('input', () => { c[key] = el.value; changed(); });
      return el;
    };

    const sectionSel = select([{ value: '', label: 'Без секции' }, ...cfg.sections.map((s) => ({ value: s.id, label: s.name || s.id }))], c.section, { 'data-section-select': '1' });
    sectionSel.addEventListener('change', () => { c.section = sectionSel.value; renderSections(); changed(); });
    const typeSel = select([{ value: 'binary', label: 'Да/Нет' }, { value: 'scale', label: 'Шкала' }, { value: 'flag', label: 'Флаг без баллов' }], c.type);
    typeSel.addEventListener('change', () => {
      c.type = typeSel.value;
      if (c.type === 'flag') { c.weight = 0; c.na_allowed = false; }
      if (c.type === 'scale' && c.scale.length < 2) {
        const w = Number(c.weight) || 10;
        c.scale = [{ value: w, label: 'Полностью выполнено' }, { value: Math.round(w / 2), label: 'Частично' }, { value: 0, label: 'Не выполнено' }];
      }
      if (c.type === 'binary' && !c.weight) c.weight = 10;
      renderCriteria();
      onChange();
    });
    const weightIn = inp('weight', { type: 'number', min: 0, step: 'any', disabled: c.type === 'flag' });
    const naCb = h('input', { type: 'checkbox', checked: c.na_allowed, disabled: c.type === 'flag' });
    const naBox = h('div', { class: 'form-grid__full', hidden: !c.na_allowed || c.type === 'flag' },
      field('Условие N/A', area('na_condition', 2, { placeholder: 'Когда критерий неприменим. Например: клиент ушёл до формулировки запроса.' })));
    naCb.addEventListener('change', () => { c.na_allowed = naCb.checked; naBox.hidden = !c.na_allowed; changed(); });

    const body = h('div', { class: 'crit-ed__body' },
      h('div', { class: 'form-grid form-grid--crit' },
        field('Код', inp('code', { class: 'input input--code' }), { cls: 'field--code' }),
        h('div', { class: 'field--grow' }, field('Название', inp('name'))),
        field('Секция', sectionSel),
        field('Тип ответа', typeSel),
        field('Вес', weightIn, { cls: 'field--weight', hint: c.type === 'flag' ? 'флаг не даёт баллов' : null }),
        h('label', { class: 'switch-row switch-row--field' }, naCb, h('span', { class: 'switch' }), h('span', null, 'Разрешён N/A')),
        h('div', { class: 'form-grid__full' }, field('Описание правила', area('description', 3, { placeholder: 'Да — что должен сделать оператор. Нет — что считается нарушением.' }))),
        naBox,
        c.type === 'scale' ? h('div', { class: 'form-grid__full' }, scaleEditor(c, changed)) : null,
        h('div', { class: 'form-grid__full' }, field('Подсказка для ИИ — как применять критерий', area('guidance', 5, { placeholder: 'На какие реплики смотреть, пограничные случаи, примеры «Да» и «Нет».' })))));
    card.append(body);
    refreshSummary();
    return card;
  }

  function scaleEditor(c, changed) {
    const box = h('div', { class: 'scale-ed' });
    const render = () => {
      clear(box);
      box.append(h('div', { class: 'scale-ed__head' }, h('span', { class: 'field__label' }, 'Ступени шкалы'),
        h('span', { class: 'muted small' }, 'Баллы считаются пропорционально: верхняя ступень = полный вес критерия.')));
      c.scale.forEach((s, i) => {
        const v = h('input', { class: 'input input--code', type: 'number', step: 1, min: 0, value: s.value ?? '', 'aria-label': 'Значение ступени (целое число)' });
        v.addEventListener('input', () => { s.value = v.value === '' ? '' : Number(v.value); changed(); });
        const l = h('input', { class: 'input', value: s.label || '', placeholder: 'Что означает эта ступень', 'aria-label': 'Описание ступени' });
        l.addEventListener('input', () => { s.label = l.value; changed(); });
        box.append(h('div', { class: 'scale-ed__row' }, v, l,
          h('button', { type: 'button', class: 'icon-btn icon-btn--danger', 'aria-label': 'Удалить ступень', disabled: c.scale.length <= 2, onclick: () => { c.scale.splice(i, 1); render(); changed(); } }, icon('x', 15))));
      });
      box.append(button('Добавить ступень', { kind: 'ghost', iconName: 'plus', size: 'sm', onClick: () => { c.scale.push({ value: 0, label: '' }); render(); changed(); } }));
    };
    render();
    return box;
  }

  /* ---------- сохранение ---------- */
  function openSave() {
    const note = h('textarea', { class: 'input', rows: 3, placeholder: 'Что изменилось, например: заменён критерий 07 «Завершение» на «Предложение доп. помощи»' });
    const activate = h('input', { type: 'checkbox', checked: true });
    openModal({
      title: 'Сохранить как новую версию',
      subtitle: `Будет создана новая версия чек-листа «${state.cfg.name}». Прошлые оценки останутся привязаны к своим версиям.`,
      body: h('div', { class: 'form-stack' },
        field('Комментарий к версии', note),
        h('label', { class: 'switch-row' }, activate, h('span', { class: 'switch' }), h('span', null, 'Сделать активной — новые оценки пойдут по этой версии'))),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: 'Сохранить версию', kind: 'primary', icon: 'check',
          onClick: async () => {
            try {
              const v = await api.saveChecklist(state.cfg, note.value.trim() || undefined, activate.checked);
              state.snapshot = JSON.stringify(state.cfg);
              state.source = { id: v.id, version: v.version, name: v.name, is_active: v.is_active ?? activate.checked };
              await loadVersions();
              renderEditor();
              afterSave(v);
              return undefined;
            } catch (e) {
              if (e.errors) { state.errors = e.errors; renderStatus(); }
              throw e;
            }
          },
        },
      ],
    });
  }

  function afterSave(v) {
    openModal({
      title: `Версия ${v.version} сохранена`,
      subtitle: v.is_active ? 'Она активна: новые оценки пойдут по ней.' : 'Версия сохранена, но не активна.',
      size: 'sm',
      body: h('p', { class: 'modal__text' }, 'Примените чек-лист к диалогам, чтобы увидеть, как изменились оценки. В карточке диалога кнопка «Сравнить с…» покажет разницу по критериям.'),
      actions: [
        { label: 'Остаться в редакторе', kind: 'ghost' },
        { label: 'Применить к диалогам…', kind: 'primary', icon: 'spark', onClick: () => { ctx.navigate(`#/dialogs?checklist=${v.id}`); } },
      ],
    });
  }

  /* ---------- старт ---------- */
  editorBox.append(h('div', { class: 'card pad' }, skeleton(10)));
  const ok = await loadVersions();
  if (destroyed) return undefined;
  if (ok) {
    const want = query.id ? Number(query.id) : null;
    const target = state.versions.find((v) => v.id === want) || state.versions.find((v) => v.is_active) || state.versions[0];
    if (target) await openVersion(target.id);
    else {
      try {
        const r = await api.defaultChecklist();
        setEditor(r && r.config ? r.config : r, { default: true }, { dirty: true });
      } catch (e) {
        clear(editorBox).append(errorState(e, () => ctx.navigate('#/checklists')));
      }
    }
  } else {
    clear(editorBox);
  }

  return () => {
    destroyed = true;
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (ctx && typeof ctx.setLeaveGuard === 'function') ctx.setLeaveGuard(null);
  };
}
