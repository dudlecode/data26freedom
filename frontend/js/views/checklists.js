// Чек-листы: версии слева, редактор справа (общие поля, секции, таблица критериев с раскрытием
// строки для правки), живая проверка и нижняя панель сохранения. Каждое сохранение создаёт новую версию.
// Сохранять и активировать может только администратор; остальные видят чек-лист в режиме чтения.

import { api } from '../api.js';
import {
  h, clear, icon, button, iconButton, fmt, isNum, toast, toastError, confirmDialog, debounce, withBusy, dotted,
  emptyState, errorState, skeleton, field, select, plural, pageHeader, TYPE_LABELS, replay, append,
} from '../ui.js';
import { can } from '../session.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

export async function mount(root, { query, ctx }) {
  ctx.setTitle('Чек-листы');
  const editable = can('admin');
  let destroyed = false;
  const state = {
    versions: [],
    cfg: null,
    snapshot: '',
    source: null,
    expanded: new Set(),
    errors: [],
    validating: false,
    saved: null,
  };

  const headerMeta = h('span');
  const listBox = h('div', { class: 'pane__scroll' });
  const editorScroll = h('div', { class: 'pane__scroll' });
  const foot = h('div', { class: 'pane__foot' });
  root.append(
    pageHeader({ title: 'Чек-листы', meta: headerMeta, actions: editable ? [button('Сбросить к исходному', { kind: 'secondary', size: 'sm', onClick: () => resetToDefault() })] : null }),
    h('div', { class: 'cl-layout' },
      h('aside', { class: 'pane', 'aria-label': 'Версии' }, h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, 'Версии')), listBox),
      h('section', { class: 'pane', 'aria-label': 'Редактор' }, editorScroll, foot)));

  const onBeforeUnload = (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  ctx.setLeaveGuard(() => !isDirty());

  function isDirty() {
    return !!state.cfg && JSON.stringify(state.cfg) !== state.snapshot;
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
    const active = state.versions.find((v) => v.is_active);
    clear(headerMeta).append(...dotted([
      active ? `Активная версия ${active.version}` : 'Активной версии нет',
      `${state.versions.length} ${plural(state.versions.length, 'версия', 'версии', 'версий')}`,
      editable ? null : 'только просмотр',
    ]));
    if (!state.versions.length) {
      listBox.append(h('p', { class: 't-2', style: { padding: '16px' } }, 'Сохранённых версий нет.'));
      return;
    }
    for (const v of state.versions) {
      const current = state.source && state.source.id === v.id;
      const act = !v.is_active && editable ? button('Сделать активной', {
        kind: 'secondary', size: 'sm',
        onClick: (e) => {
          e.stopPropagation();
          withBusy(e.currentTarget, async () => {
            try {
              await api.activateChecklist(v.id);
              toast(`Версия ${v.version} активна. Новые оценки пойдут по ней.`, 'success');
              await loadVersions();
            } catch (err) { toastError(err, 'Версия не активирована'); }
          });
        },
      }) : null;
      listBox.append(h('div', {
        class: ['ver', current && 'is-current'], role: 'button', tabindex: 0, 'aria-current': current ? 'true' : null,
        onclick: () => openVersion(v.id),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openVersion(v.id); } },
      },
      h('div', { class: 'ver__top' }, h('span', { class: 'ver__name' }, `Версия ${v.version}`), v.is_active ? h('span', { class: 'badge badge--yes' }, 'Активная') : null),
      h('div', { class: 'ver__meta' }, `${v.criteria_count} ${plural(v.criteria_count, 'критерий', 'критерия', 'критериев')}, сумма весов ${fmt.n2(v.total_weight)}`),
      h('div', { class: 'ver__meta' }, fmt.date(v.created_at)),
      v.note ? h('div', { class: 'ver__note' }, v.note) : null,
      act ? h('div', { class: 'ver__act' }, act) : null));
    }
  }

  async function guardDirty() {
    if (!isDirty()) return true;
    return confirmDialog({ title: 'Изменения не сохранены', message: 'Изменения в редакторе будут потеряны.', confirmLabel: 'Отбросить изменения', cancelLabel: 'Остаться', danger: true });
  }

  async function openVersion(id) {
    if (state.source && state.source.id === id && !isDirty()) return;
    if (!(await guardDirty())) return;
    clear(editorScroll).append(skeleton(10));
    try {
      const v = await api.checklist(id);
      setEditor(v.config, { id: v.id, version: v.version, name: v.name, is_active: v.is_active });
    } catch (e) {
      clear(editorScroll).append(errorState(e, () => openVersion(id)));
    }
  }

  async function resetToDefault() {
    if (isDirty() && !(await confirmDialog({ title: 'Сбросить к исходному?', message: 'Несохранённые изменения будут потеряны. Сохранённые версии не изменятся.', confirmLabel: 'Сбросить', danger: true }))) return;
    try {
      const r = await api.defaultChecklist();
      setEditor(r && r.config ? r.config : r, { default: true }, { dirty: true });
      toast('В редакторе исходный чек-лист. Сохраните его как новую версию.', 'info');
    } catch (e) { toastError(e, 'Исходный чек-лист не загружен'); }
  }

  function setEditor(cfg, source, { dirty = false } = {}) {
    state.cfg = normalizeCfg(clone(cfg || {}));
    state.snapshot = dirty ? '' : JSON.stringify(state.cfg);
    state.source = source;
    state.expanded = new Set();
    state.saved = null;
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

  /* ---------- проверка ---------- */
  const validate = debounce(async () => {
    if (!state.cfg) return;
    const local = localErrors(state.cfg);
    state.validating = true;
    renderFoot();
    try {
      const r = await api.validateChecklist(state.cfg);
      if (destroyed) return;
      state.errors = [...new Set([...(r.errors || []), ...local])];
    } catch {
      state.errors = local;
    }
    state.validating = false;
    renderErrors();
    renderFoot();
  }, 350);

  function localErrors(cfg) {
    const errs = [];
    const codes = cfg.criteria.map((c) => String(c.code || '').trim()).filter(Boolean);
    if (new Set(codes).size !== codes.length) errs.push('Коды критериев повторяются.');
    for (const c of cfg.criteria) {
      if (c.type === 'scale' && c.scale.some((s) => s.value === '' || !isNum(Number(s.value)))) errs.push(`${c.name || c.id}: у каждой ступени шкалы должно быть число.`);
      if (c.na_allowed && c.type !== 'flag' && !String(c.na_condition || '').trim()) errs.push(`${c.name || c.id}: опишите условие Н/П.`);
    }
    return errs;
  }

  function weightSum() {
    return state.cfg.criteria.filter((c) => c.type !== 'flag').reduce((s, c) => s + (Number(c.weight) || 0), 0);
  }

  /* ---------- редактор ---------- */
  let errorsBox;
  let sectionsBox;
  let critBody;

  function onChange() {
    state.saved = null;
    renderFoot();
    validate();
  }

  function renderEditor() {
    clear(editorScroll);
    const cfg = state.cfg;
    const dis = !editable;

    if (!editable) {
      editorScroll.append(h('div', { class: 'ed-note' }, 'Только просмотр. Изменять и активировать чек-лист может администратор.'));
    }
    errorsBox = h('div');
    editorScroll.append(errorsBox);
    renderErrors();

    /* критерии */
    critBody = h('tbody');
    editorScroll.append(h('section', { class: 'ed-sect' },
      h('div', { class: 'ed-sect__head' }, h('h2', { class: 'ed-sect__title' }, 'Критерии'),
        h('div', { class: 'factions' },
          button('Развернуть все', { kind: 'ghost', size: 'sm', onClick: () => { cfg.criteria.forEach((c) => state.expanded.add(c.id)); renderCriteria(); } }),
          button('Свернуть все', { kind: 'ghost', size: 'sm', onClick: () => { state.expanded.clear(); renderCriteria(); } }),
          editable ? button('Добавить критерий', { kind: 'secondary', size: 'sm', iconName: 'plus', onClick: addCriterion }) : null)),
      h('div', { class: 'tbl-wrap' },
        h('table', { class: 'tbl ctbl' },
          h('colgroup', null, [28, 44, null, 124, 76, 80, 84, 40].map((w) => h('col', { style: w ? { width: `${w}px` } : null }))),
          h('thead', null, h('tr', null,
            h('th'), h('th', null, 'Код'), h('th', null, 'Название'), h('th', null, 'Секция'), h('th', null, 'Тип'),
            h('th', { class: 'num' }, 'Вес'), h('th', { class: 'num' }, 'Доля итога'), h('th', null, 'Н/П'))),
          critBody))));
    renderCriteria();

    /* секции */
    sectionsBox = h('div');
    editorScroll.append(h('section', { class: 'ed-sect' },
      h('div', { class: 'ed-sect__head' }, h('h2', { class: 'ed-sect__title' }, 'Секции'),
        editable ? button('Добавить секцию', { kind: 'ghost', size: 'sm', iconName: 'plus', onClick: addSection }) : null),
      sectionsBox));
    renderSections();

    /* общие поля */
    const nameIn = h('input', { class: 'input', value: cfg.name || '', disabled: dis });
    nameIn.addEventListener('input', () => { cfg.name = nameIn.value; onChange(); });
    const descIn = h('textarea', { class: 'input', rows: 2, value: cfg.description || '', disabled: dis });
    descIn.addEventListener('input', () => { cfg.description = descIn.value; onChange(); });
    const guideIn = h('textarea', { class: 'input', rows: 6, value: cfg.general_guidance || '', disabled: dis });
    guideIn.addEventListener('input', () => { cfg.general_guidance = guideIn.value; onChange(); });
    const zeroCb = h('input', { type: 'checkbox', checked: !!cfg.gross_error_zeroes_total, disabled: dis });
    zeroCb.addEventListener('change', () => { cfg.gross_error_zeroes_total = zeroCb.checked; onChange(); });

    editorScroll.append(h('section', { class: 'ed-sect', style: { borderBottom: 0 } },
      h('div', { class: 'ed-sect__head' }, h('h2', { class: 'ed-sect__title' }, 'Название и общие указания')),
      h('div', { class: 'fgrid' },
        h('div', { class: 'span-all' }, field('Название', nameIn)),
        h('div', { class: 'span-all' }, field('Описание', descIn)),
        h('div', { class: 'span-all' }, field('Общие указания для ИИ', guideIn, { hint: 'Применяются ко всем критериям.' })),
        h('label', { class: ['check-row', 'span-all', dis && 'is-disabled'] }, zeroCb, 'Грубая ошибка обнуляет итог'))));

    renderFoot();
  }

  function renderErrors() {
    if (!errorsBox) return;
    clear(errorsBox);
    if (!state.errors.length) return;
    errorsBox.append(h('div', { class: 'ed-errors', role: 'alert' }, h('ul', null, state.errors.map((e) => h('li', null, e)))));
  }

  function renderFoot() {
    clear(foot);
    if (!state.cfg) return;
    const sum = weightSum();
    const dirty = isDirty();
    const off = Math.abs(sum - 100) > 0.004;
    const status = h('span', { class: 't-13 foot-status' },
      h('span', { class: off ? 't-warn strong' : 'strong', 'data-tip': off ? 'Итог всё равно приводится к 100: веса нормируются.' : null }, `Веса ${fmt.n2(sum)}`),
      h('span', { class: 'sep' }, '·'),
      state.validating ? h('span', { class: 't-2' }, 'Проверка')
        : state.errors.length ? h('span', { class: 't-danger strong' }, `${state.errors.length} ${plural(state.errors.length, 'ошибка', 'ошибки', 'ошибок')}`)
          : h('span', { class: 't-ok' }, 'Ошибок нет'),
      h('span', { class: 'sep' }, '·'),
      h('span', { class: dirty ? 't-warn' : 't-2' }, state.source && state.source.default ? 'Исходный, не сохранён' : dirty ? 'Изменено' : `Без изменений, версия ${state.source ? state.source.version : ''}`));
    if (!editable) {
      foot.append(status);
      return;
    }
    if (state.saved) {
      const v = state.saved;
      foot.append(h('span', { class: 't-13' },
        h('span', { class: 't-ok strong' }, `Версия ${v.version} сохранена${v.is_active ? ' и активна' : ''}. `),
        h('a', { href: `#/dialogs?checklist=${v.id}` }, `Оценить диалоги по версии ${v.version}`)),
      h('span', { class: 'spacer' }));
      return;
    }
    const note = h('input', { class: 'input input--sm', placeholder: 'Что изменилось', 'aria-label': 'Комментарий к версии', style: { width: '120px' } });
    const activate = h('input', { type: 'checkbox', checked: state.draftActivate !== false });
    activate.addEventListener('change', () => { state.draftActivate = activate.checked; });
    const nothing = !dirty && !(state.source && state.source.default);
    if (state.draftNote !== undefined) note.value = state.draftNote;
    note.addEventListener('input', () => { state.draftNote = note.value; });
    const save = button('Сохранить версию', {
      kind: 'primary', size: 'sm', disabled: state.errors.length > 0 || nothing,
      tip: 'Каждое сохранение создаёт новую версию, прежние оценки не меняются',
      onClick: (e) => withBusy(e.currentTarget, async () => {
        try {
          const v = await api.saveChecklist(state.cfg, note.value.trim() || undefined, activate.checked);
          state.snapshot = JSON.stringify(state.cfg);
          state.source = { id: v.id, version: v.version, name: v.name, is_active: v.is_active ?? activate.checked };
          await loadVersions();
          state.saved = { id: v.id, version: v.version, is_active: v.is_active ?? activate.checked };
          state.draftNote = '';
          renderFoot();
          toast(`Версия ${v.version} сохранена`, 'success');
        } catch (err) {
          if (err.errors) { state.errors = err.errors; renderErrors(); }
          toastError(err, 'Версия не сохранена');
          renderFoot();
        }
      }),
    });
    append(foot, [status, h('span', { class: 'spacer' }),
      nothing ? null : note,
      nothing ? null : h('label', { class: 'check-row t-13' }, activate, 'сделать активной'),
      save]);
  }

  /* ---------- секции ---------- */
  function renderSections() {
    clear(sectionsBox);
    const cfg = state.cfg;
    if (!cfg.sections.length) { sectionsBox.append(h('p', { class: 't-2' }, 'Секций нет, критерии без группировки.')); return; }
    cfg.sections.forEach((s, i) => {
      const used = cfg.criteria.filter((c) => c.section === s.id).length;
      const nameIn = h('input', { class: 'input input--sm', value: s.name || '', 'aria-label': `Название секции ${s.id}`, disabled: !editable });
      nameIn.addEventListener('input', () => { s.name = nameIn.value; onChange(); refreshSectionNames(); });
      sectionsBox.append(h('div', { class: 'secrow' },
        h('span', { class: 'secrow__id' }, s.id),
        nameIn,
        h('span', { class: 'secrow__n' }, `${used} ${plural(used, 'критерий', 'критерия', 'критериев')}`),
        editable ? h('span', { class: 'secrow__tools' },
          iconButton('chevronUp', 'Выше', () => { move(cfg.sections, i, -1); renderSections(); renderCriteria(); onChange(); }, { disabled: i === 0 }),
          iconButton('chevronDown', 'Ниже', () => { move(cfg.sections, i, 1); renderSections(); renderCriteria(); onChange(); }, { disabled: i === cfg.sections.length - 1 }),
          iconButton('trash', used ? 'Сначала перенесите критерии секции' : 'Удалить секцию', () => {
            if (used) return;
            cfg.sections.splice(i, 1); renderSections(); renderCriteria(); onChange();
          }, { danger: true, disabled: used > 0 })) : h('span')));
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

  function refreshSectionNames() {
    for (const el of critBody.querySelectorAll('[data-section-cell]')) {
      const s = state.cfg.sections.find((x) => x.id === el.dataset.sectionCell);
      el.textContent = s ? s.name || s.id : 'Без секции';
    }
    for (const sel of critBody.querySelectorAll('select[data-section-select]')) {
      for (const opt of sel.options) {
        const s = state.cfg.sections.find((x) => x.id === opt.value);
        if (s) opt.textContent = s.name || s.id;
      }
    }
  }

  /* ---------- критерии ---------- */
  function nextId() {
    const nums = state.cfg.criteria.map((c) => Number(String(c.id).replace(/\D/g, ''))).filter(isNum);
    let k = (nums.length ? Math.max(...nums) : 0) + 1;
    let id = `c${String(k).padStart(2, '0')}`;
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
      type: 'binary', weight: 10, na_allowed: false, description: '', na_condition: '', scale: [], guidance: '',
    };
    if (flagIdx >= 0) cfg.criteria.splice(flagIdx, 0, c); else cfg.criteria.push(c);
    state.expanded.add(id);
    renderCriteria();
    renderSections();
    onChange();
    requestAnimationFrame(() => {
      const inp = critBody.querySelector(`[data-edit="${id}"] input[data-f="name"]`);
      replay(critBody.querySelector(`tr[data-row="${id}"]`), 'flash');
      if (inp) { inp.scrollIntoView({ behavior: 'smooth', block: 'center' }); inp.focus({ preventScroll: true }); inp.select(); }
    });
  }

  function move(arr, i, d) {
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  function renderCriteria() {
    clear(critBody);
    const cfg = state.cfg;
    if (!cfg.criteria.length) {
      critBody.append(h('tr', null, h('td', { colspan: 8 }, emptyState({ title: 'Критериев нет', text: editable ? 'Добавьте первый критерий.' : null }))));
      return;
    }
    cfg.criteria.forEach((c, i) => critRows(c, i).forEach((r) => critBody.append(r)));
  }

  function shareText(c) {
    if (c.type === 'flag') return 'без баллов';
    const sum = weightSum();
    return sum > 0 ? fmt.pct((100 * (Number(c.weight) || 0)) / sum) : '';
  }

  function critRows(c, i) {
    const cfg = state.cfg;
    const open = state.expanded.has(c.id);
    const cells = {
      code: h('td', { class: 'strong' }),
      name: h('td', { class: 'wrap' }),
      section: h('td', { class: 'clip', style: { maxWidth: '124px' }, dataset: { sectionCell: c.section } }),
      type: h('td', { class: 'nowrap' }),
      weight: h('td', { class: 'num cell-input' }),
      share: h('td', { class: 'num t-2' }),
      na: h('td'),
    };
    // вес правится прямо в строке таблицы; поле в раскрытой форме и строка синхронизированы
    const weightIn = editable && c.type !== 'flag'
      ? h('input', { class: 'input input--sm input--cell', type: 'number', min: 0, step: 'any', value: String(Number(c.weight) || 0), 'aria-label': `Вес критерия ${c.code || c.id}` })
      : null;
    const refresh = () => {
      cells.code.textContent = c.code || c.id;
      cells.name.textContent = c.name || 'Без названия';
      const s = cfg.sections.find((x) => x.id === c.section);
      cells.section.dataset.sectionCell = c.section;
      cells.section.textContent = s ? s.name || s.id : 'Без секции';
      cells.section.title = cells.section.textContent;
      cells.type.textContent = TYPE_LABELS[c.type] || c.type;
      if (c.type === 'scale') {
        const vals = [...c.scale].map((x) => x.value).filter((v) => v !== '' && v != null).sort((a, b) => Number(b) - Number(a));
        cells.type.dataset.tip = `${c.scale.length} ${plural(c.scale.length, 'ступень', 'ступени', 'ступеней')}: ${vals.join(', ')}`;
      } else delete cells.type.dataset.tip;
      if (weightIn) {
        if (!cells.weight.contains(weightIn)) cells.weight.replaceChildren(weightIn);
        if (document.activeElement !== weightIn) weightIn.value = String(Number(c.weight) || 0);
      } else cells.weight.textContent = c.type === 'flag' ? '' : fmt.n2(Number(c.weight) || 0);
      cells.na.textContent = c.na_allowed && c.type !== 'flag' ? 'Да' : '';
      for (const el of critBody.querySelectorAll('[data-share]')) {
        const cc = cfg.criteria.find((x) => x.id === el.dataset.share);
        if (cc) el.textContent = shareText(cc);
      }
    };
    cells.share.dataset.share = c.id;
    const changed = () => { refresh(); onChange(); };
    if (weightIn) {
      weightIn.addEventListener('input', () => {
        c.weight = weightIn.value === '' ? 0 : Number(weightIn.value);
        const formIn = critBody.querySelector(`[data-edit="${CSS.escape(c.id)}"] input[data-f="weight"]`);
        if (formIn && document.activeElement !== formIn) formIn.value = String(c.weight);
        changed();
      });
      weightIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') weightIn.blur(); });
    }

    const tools = h('div', { class: 'tools' });
    const renderTools = () => {
      clear(tools);
      if (!editable) return;
      tools.append(
        button('Выше', { kind: 'ghost', size: 'sm', iconName: 'chevronUp', disabled: i === 0, onClick: (e) => { e.stopPropagation(); move(cfg.criteria, i, -1); renderCriteria(); onChange(); } }),
        button('Ниже', { kind: 'ghost', size: 'sm', iconName: 'chevronDown', disabled: i === cfg.criteria.length - 1, onClick: (e) => { e.stopPropagation(); move(cfg.criteria, i, 1); renderCriteria(); onChange(); } }),
        button('Дублировать', { kind: 'ghost', size: 'sm', iconName: 'copy', onClick: (e) => {
          e.stopPropagation();
          const d = clone(c); delete d.export_id; d.id = nextId(); d.code = d.id.replace(/^c/, ''); d.name = `${c.name} (копия)`;
          cfg.criteria.splice(i + 1, 0, d); state.expanded.add(d.id); renderCriteria(); renderSections(); onChange();
        } }),
        button('Удалить', { kind: 'ghost', size: 'sm', iconName: 'trash', onClick: (e) => { e.stopPropagation(); askDelete(); } }));
    };
    const askDelete = () => {
      clear(tools).append(h('span', { class: 'confirm-inline' }, `Удалить критерий ${c.code || c.id}?`,
        button('Удалить', { kind: 'danger', size: 'sm', onClick: (e) => { e.stopPropagation(); cfg.criteria.splice(cfg.criteria.indexOf(c), 1); state.expanded.delete(c.id); renderCriteria(); renderSections(); onChange(); } }),
        button('Отмена', { kind: 'ghost', size: 'sm', onClick: (e) => { e.stopPropagation(); renderTools(); } })));
    };
    renderTools();

    const chev = h('td', null, icon('chevronDown', 16, 'chev'));
    const row = h('tr', {
      class: ['is-link', open && 'is-open'], tabindex: 0, 'aria-expanded': String(open), dataset: { row: c.id },
      onclick: (e) => { if (!e.target.closest('button, input')) toggle(); },
      onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === row) { e.preventDefault(); toggle(); } },
    }, chev, cells.code, cells.name, cells.section, cells.type, cells.weight, cells.share, cells.na);
    const toggle = () => {
      if (state.expanded.has(c.id)) state.expanded.delete(c.id); else state.expanded.add(c.id);
      renderCriteria();
    };
    refresh();
    if (!open) return [row];
    return [row, h('tr', { class: 'edit-row', dataset: { edit: c.id } }, h('td', { colspan: 8 },
      editable ? h('div', { class: 'edit-tools' }, tools) : null,
      editForm(c, changed)))];
  }

  function editForm(c, changed) {
    const cfg = state.cfg;
    const dis = !editable;
    const inp = (key, props = {}) => {
      const el = h('input', { class: 'input', value: c[key] ?? '', dataset: { f: key }, disabled: dis, ...props });
      el.addEventListener('input', () => { c[key] = props.type === 'number' ? (el.value === '' ? 0 : Number(el.value)) : el.value; changed(); });
      return el;
    };
    const area = (key, rows, props = {}) => {
      const el = h('textarea', { class: 'input', rows, value: c[key] ?? '', disabled: dis, ...props });
      el.addEventListener('input', () => { c[key] = el.value; changed(); });
      return el;
    };
    const sectionSel = select([{ value: '', label: 'Без секции' }, ...cfg.sections.map((s) => ({ value: s.id, label: s.name || s.id }))], c.section, { 'data-section-select': '1', disabled: dis });
    sectionSel.addEventListener('change', () => { c.section = sectionSel.value; renderSections(); changed(); });
    const typeSel = select([{ value: 'binary', label: 'Да/Нет' }, { value: 'scale', label: 'Шкала' }, { value: 'flag', label: 'Флаг без баллов' }], c.type, { disabled: dis });
    typeSel.addEventListener('change', () => {
      c.type = typeSel.value;
      if (c.type === 'flag') { c.weight = 0; c.na_allowed = false; }
      if (c.type === 'scale' && c.scale.length < 2) {
        const w = Number(c.weight) || 10;
        c.scale = [{ value: w, label: 'Выполнено полностью' }, { value: Math.round(w / 2), label: 'Выполнено частично' }, { value: 0, label: 'Не выполнено' }];
      }
      if (c.type === 'binary' && !c.weight) c.weight = 10;
      renderCriteria();
      onChange();
    });
    const weightIn = inp('weight', { type: 'number', min: 0, step: 'any', disabled: dis || c.type === 'flag' });
    const naCb = h('input', { type: 'checkbox', checked: c.na_allowed, disabled: dis || c.type === 'flag' });
    const naBox = h('div', { class: 'span-all', hidden: !c.na_allowed || c.type === 'flag' },
      field('Условие Н/П', area('na_condition', 2, { placeholder: 'Когда критерий неприменим' })));
    naCb.addEventListener('change', () => { c.na_allowed = naCb.checked; naBox.hidden = !c.na_allowed; changed(); });

    return h('div', { class: 'fgrid fgrid--3' },
      field('Код', inp('code')),
      h('div', { style: { gridColumn: 'span 2' } }, field('Название', inp('name'))),
      field('Секция', sectionSel),
      field('Тип', typeSel),
      field('Вес', weightIn, { hint: c.type === 'flag' ? 'Флаг не даёт баллов' : null }),
      h('label', { class: ['check-row', 'span-all', (dis || c.type === 'flag') && 'is-disabled'] }, naCb, 'Разрешён Н/П'),
      h('div', { class: 'span-all' }, field('Правило', area('description', 3, { placeholder: 'Что считается выполнением и что нарушением' }))),
      naBox,
      c.type === 'scale' ? h('div', { class: 'span-all' }, scaleEditor(c, changed)) : null,
      h('div', { class: 'span-all' }, field('Указания для ИИ', area('guidance', 4, { placeholder: 'На какие реплики смотреть, пограничные случаи' }))));
  }

  function scaleEditor(c, changed) {
    const box = h('div', { class: 'scale-ed' });
    const render = () => {
      clear(box);
      box.append(h('span', { class: 'field__label' }, 'Ступени шкалы'));
      c.scale.forEach((s, i) => {
        const v = h('input', { class: 'input', type: 'number', step: 1, min: 0, value: s.value ?? '', disabled: !editable, 'aria-label': 'Баллы ступени' });
        v.addEventListener('input', () => { s.value = v.value === '' ? '' : Number(v.value); changed(); });
        const l = h('input', { class: 'input', value: s.label || '', disabled: !editable, placeholder: 'Что означает ступень', 'aria-label': 'Описание ступени' });
        l.addEventListener('input', () => { s.label = l.value; changed(); });
        box.append(h('div', { class: 'scale-ed__row' }, v, l,
          editable ? iconButton('close', 'Удалить ступень', () => { c.scale.splice(i, 1); render(); changed(); }, { danger: true, disabled: c.scale.length <= 2 }) : h('span')));
      });
      if (editable) box.append(h('div', null, button('Добавить ступень', { kind: 'ghost', size: 'sm', iconName: 'plus', onClick: () => { c.scale.push({ value: 0, label: '' }); render(); changed(); } })));
      box.append(h('span', { class: 'field__hint' }, 'Верхняя ступень равна полному весу критерия, баллы считаются пропорционально.'));
    };
    render();
    return box;
  }

  /* ---------- старт ---------- */
  editorScroll.append(skeleton(10));
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
        clear(editorScroll).append(errorState(e, () => ctx.navigate('#/checklists')));
      }
    }
  } else {
    clear(editorScroll);
  }

  return () => {
    destroyed = true;
    window.removeEventListener('beforeunload', onBeforeUnload);
    ctx.setLeaveGuard(null);
  };
}
