// Чек-листы: версии слева, редактор справа (общие поля, секции, таблица критериев с раскрытием
// строки для правки), живая проверка и нижняя панель сохранения. Каждое сохранение создаёт новую версию.
// Сохранять и активировать может только супервайзер; остальные видят чек-лист в режиме чтения.

import { api } from '../api.js';
import {
  h, clear, icon, button, iconButton, fmt, isNum, toast, toastError, confirmDialog, debounce, withBusy, dotted,
  emptyState, errorState, skeleton, field, select, plural, pageHeader, TYPE_LABELS, replay, append, menu,
} from '../ui.js';
import { can } from '../session.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

export async function mount(root, { query, ctx }) {
  ctx.setTitle('Чек-листы');
  const editable = can('manage');
  let destroyed = false;
  const state = {
    versions: [],
    cfg: null,
    snapshot: '',
    source: null,
    expanded: new Set(),
    errors: [],
    issues: [],
    validating: false,
    saved: null,
    allOpen: false,
    sim: null,
    // новый критерий: ошибки пустых полей показываются после ухода из поля или по клику на счётчик,
    // иначе подсказки появляются под курсором, пока пользователь ещё заполняет форму
    fresh: new Set(),
    touched: new Set(),
    revealAll: false,
  };

  const headerMeta = h('span');
  const listBox = h('div', { class: 'pane__scroll' });
  const editorScroll = h('div', { class: 'pane__scroll' });
  const foot = h('div', { class: 'pane__foot' });
  const simBox = h('div', { class: 'sim', hidden: true, 'aria-live': 'polite' });
  /* телефон: список версий заменяет выпадающий список над редактором */
  const verSel = h('select', { class: 'input', 'aria-label': 'Версия чек-листа', onchange: () => { if (verSel.value) openVersion(Number(verSel.value)).then(renderVerBar); } });
  const verAct = h('span', { class: 'cl-vbar__act' });
  const verBar = h('div', { class: 'cl-vbar' }, verSel, verAct, versionsMenuBtn());
  root.append(
    pageHeader({ title: 'Чек-листы', meta: headerMeta }),
    verBar,
    h('div', { class: 'cl-layout' },
      h('aside', { class: 'pane', 'aria-label': 'Версии' }, h('div', { class: 'panel__head' }, h('h2', { class: 'panel__title' }, 'Версии'), versionsMenuBtn()), listBox),
      h('section', { class: 'pane', 'aria-label': 'Редактор' }, editorScroll, simBox, foot)));

  function versionsMenuBtn() {
    if (!editable) return null;
    const b = iconButton('more', 'Действия с версиями', () => menu(b, [
      { label: 'Сбросить к исходному чек-листу', icon: 'undo', onClick: () => resetToDefault() },
    ]));
    b.setAttribute('aria-haspopup', 'menu');
    return b;
  }

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

  function renderVerBar() {
    clear(verSel);
    const cur = state.source && state.source.id;
    if (state.source && state.source.default) verSel.append(h('option', { value: '', selected: true }, 'Исходный чек-лист, не сохранён'));
    for (const v of state.versions) {
      verSel.append(h('option', { value: v.id, selected: v.id === cur }, `Версия ${v.version}${v.is_active ? ', активная' : ''}`));
    }
    verSel.disabled = !state.versions.length;
    clear(verAct);
    const v = state.versions.find((x) => x.id === cur);
    if (v && !v.is_active && editable) {
      verAct.append(button('Сделать активной', {
        kind: 'secondary', size: 'sm',
        onClick: (e) => withBusy(e.currentTarget, async () => {
          try {
            await api.activateChecklist(v.id);
            toast(`Версия ${v.version} активна. Новые оценки пойдут по ней.`, 'success');
            if (state.source && !state.source.default) state.source.is_active = state.source.id === v.id;
            if (state.saved) state.saved.is_active = state.saved.id === v.id;
            await loadVersions();
            renderFoot();
          } catch (err) { toastError(err, 'Версия не активирована'); }
        }),
      }));
    }
  }

  function renderVersions() {
    renderVerBar();
    clear(listBox);
    const active = state.versions.find((v) => v.is_active);
    clear(headerMeta).append(...dotted([
      active ? `Активная версия ${active.version}` : 'Активной версии нет',
      `${state.versions.length} ${plural(state.versions.length, 'версия', 'версии', 'версий')}`,
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
              if (state.source && !state.source.default) state.source.is_active = state.source.id === v.id;
              if (state.saved) state.saved.is_active = state.saved.id === v.id;
              await loadVersions();
              renderFoot();
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
    state.sim = null;
    state.allOpen = false;
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
      if (c.coaching == null) delete c.coaching;
    }
    return cfg;
  }

  /* ---------- проверка ----------
   * Сервер возвращает issues с местом ошибки (criterion_index, field, step_index): поле подсвечивается
   * прямо в форме критерия, счётчик в подвале ведёт к первой ошибке. Если сервер не ответил, работает
   * короткая локальная проверка. */
  const validate = debounce(async () => {
    if (!state.cfg) return;
    state.validating = true;
    renderFoot();
    try {
      const r = await api.validateChecklist(state.cfg);
      if (destroyed) return;
      state.issues = Array.isArray(r.issues) ? r.issues : (r.errors || []).map((m) => ({ message: m, criterion_index: null }));
    } catch {
      state.issues = localIssues(state.cfg);
    }
    state.errors = [...new Set(state.issues.map((x) => x.message))];
    state.validating = false;
    renderErrors();
    paintIssues();
    renderFoot();
    simulate();
  }, 350);

  function localIssues(cfg) {
    const out = [];
    const seen = new Map();
    cfg.criteria.forEach((c, i) => {
      const label = c.name || c.code || c.id;
      const code = String(c.code || '').trim();
      if (code && seen.has(code)) out.push({ message: `${label}: код ${code} уже есть у другого критерия.`, criterion_index: i, field: 'code' });
      if (code) seen.set(code, i);
      if (!String(c.name || '').trim()) out.push({ message: `${label}: не задано название.`, criterion_index: i, field: 'name' });
      if (!String(c.description || '').trim()) out.push({ message: `${label}: не задано правило оценки.`, criterion_index: i, field: 'description' });
      if (c.na_allowed && c.type !== 'flag' && !String(c.na_condition || '').trim()) out.push({ message: `${label}: разрешён Н/П, но не указано, когда он ставится.`, criterion_index: i, field: 'na_condition' });
      if (c.type === 'scale') c.scale.forEach((st, k) => { if (st.value === '' || !isNum(Number(st.value))) out.push({ message: `${label}: ступень ${k + 1}: укажите число баллов.`, criterion_index: i, field: 'scale', step_index: k }); });
    });
    return out;
  }

  /** Сообщение без повтора названия критерия: в форме и так видно, о каком он. */
  const shortMsg = (m) => String(m).replace(/^[^:]{1,80}:\s*/, '').replace(/^./, (ch) => ch.toUpperCase());

  function paintIssues() {
    if (!critBody) return;
    for (const tr of critBody.querySelectorAll('tr.has-error')) tr.classList.remove('has-error');
    for (const el of critBody.querySelectorAll('[data-err]')) { el.textContent = ''; el.hidden = true; }
    for (const el of critBody.querySelectorAll('[aria-invalid="true"]')) el.removeAttribute('aria-invalid');
    for (const x of state.issues) {
      const i = x.criterion_index;
      if (!isNum(i)) continue;
      const c = state.cfg.criteria[i];
      if (!c) continue;
      const tr = critBody.querySelector(`tr[data-row="${CSS.escape(c.id)}"]`);
      if (tr) { tr.classList.add('has-error'); tr.dataset.tip = x.message; }
      const form = critBody.querySelector(`[data-edit="${CSS.escape(c.id)}"]`);
      if (!form) continue;
      if (state.fresh.has(c.id) && !state.revealAll && !state.touched.has(`${c.id}:${x.field}`)) continue;
      const known = ['code', 'name', 'description', 'na_condition', 'weight', 'section', 'type', 'scale', 'guidance'];
      const key = known.includes(x.field) ? x.field : 'general';
      const slot = form.querySelector(`[data-err="${key}"]`) || form.querySelector('[data-err="general"]');
      if (slot) { slot.hidden = false; slot.append(h('span', null, shortMsg(x.message))); }
      if (x.field === 'scale' && isNum(x.step_index)) {
        const inp = form.querySelector(`input[data-step="${x.step_index}"]`);
        if (inp) inp.setAttribute('aria-invalid', 'true');
      } else if (x.field) {
        for (const inp of form.querySelectorAll(`[data-f="${x.field}"]`)) inp.setAttribute('aria-invalid', 'true');
      }
    }
    for (const tr of critBody.querySelectorAll('tr[data-row]:not(.has-error)')) tr.removeAttribute('data-tip');
  }

  function jumpToFirstError() {
    state.revealAll = true;
    paintIssues();
    const x = state.issues.find((it) => isNum(it.criterion_index)) || null;
    if (!x) { editorScroll.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const c = state.cfg.criteria[x.criterion_index];
    if (!c) return;
    if (!state.expanded.has(c.id)) { state.expanded.add(c.id); renderCriteria(); paintIssues(); }
    requestAnimationFrame(() => {
      const form = critBody.querySelector(`[data-edit="${CSS.escape(c.id)}"]`);
      if (!form) return;
      const target = (x.field === 'scale' && isNum(x.step_index) ? form.querySelector(`input[data-step="${x.step_index}"]`) : null)
        || form.querySelector(`[data-f="${x.field}"]`) || form.querySelector('input, textarea');
      if (target) { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); target.focus({ preventScroll: true }); }
    });
  }

  /* ---------- влияние правок на уже оценённые диалоги (без модели) ---------- */
  let simSeq = 0;
  const simulate = debounce(async () => {
    const seq = ++simSeq;
    // Пока есть ошибки, строка остаётся на месте с прошлым расчётом: если она исчезнет, список
    // над ней вырастет и прокрутка сдвинется прямо под курсором.
    if (!state.cfg || !isDirty()) { state.sim = null; state.simStale = false; renderSim(); return; }
    if (state.issues.length) { state.simStale = true; renderSim(); return; }
    let r = null;
    try { r = await api.simulateChecklist(state.cfg); } catch { r = null; }
    if (destroyed || seq !== simSeq) return;
    state.sim = r && r.before && r.after ? r : null;
    state.simStale = false;
    renderSim();
  }, 300);

  function renderSim() {
    clear(simBox);
    const r = state.sim;
    const keep = state.simStale && state.cfg && isDirty();
    simBox.hidden = !r && !keep;
    simBox.classList.toggle('is-stale', !!keep);
    if (!r) {
      if (keep) simBox.append(icon('spark', 16), h('span', { class: 'sim__main t-2' }, 'Влияние на итоги посчитаем, когда ошибок не останется'));
      return;
    }
    if (keep) {
      simBox.append(icon('spark', 16), h('span', { class: 'sim__main' }, 'Средний итог ', h('b', null, fmt.n2(r.before.avg_final)), ' станет ', h('b', null, fmt.n2(r.after.avg_final))),
        h('span', { class: 'sim__details t-2' }, 'Пересчёт после исправления ошибок'));
      return;
    }
    const b = r.before.avg_final;
    const a = r.after.avg_final;
    const d = isNum(a) && isNum(b) ? a - b : null;
    const changed = r.changed_count ?? (r.changed || []).length;
    const movers = [...(r.changed || [])].sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, 8);
    const details = h('details', { class: 'sim__details', open: !!state.simOpen, ontoggle: (e) => { state.simOpen = e.currentTarget.open; } },
      h('summary', null, changed ? `Изменится итог у ${changed} ${plural(changed, 'диалога', 'диалогов', 'диалогов')} из ${r.dialogs}` : 'Итоги диалогов не изменятся'),
      movers.length ? h('ul', { class: 'sim__list' }, movers.map((m) => h('li', null,
        h('a', { href: `#/dialog/${encodeURIComponent(m.dialog_id)}?eval=${m.evaluation_id}` }, m.dialog_id),
        m.operator ? h('span', { class: 't-2' }, m.operator) : null,
        h('span', { class: 'sim__nums' }, `${fmt.n2(m.before)}, станет `, h('b', null, fmt.n2(m.after))),
        h('span', { class: m.delta > 0 ? 'delta-up' : 'delta-down' }, `${m.delta > 0 ? '+' : ''}${fmt.n2(m.delta)}`)))) : null);
    simBox.append(
      icon('spark', 16),
      h('span', { class: 'sim__main' },
        'Средний итог ', h('b', null, fmt.n2(b)), d !== null && Math.abs(d) > 0.004 ? [' станет ', h('b', { class: d > 0 ? 'delta-up' : 'delta-down' }, fmt.n2(a)), ` (${d > 0 ? '+' : ''}${fmt.n2(d)})`] : ' не изменится',
        r.after.gross !== r.before.gross ? `, грубых ошибок ${r.before.gross}, станет ${r.after.gross}` : null,
        (r.new_criteria || []).length ? h('span', { class: 't-2' }, '. Новые критерии учтутся после переоценки') : null),
      details);
  }

  function weightSum() {
    return state.cfg.criteria.filter((c) => c.type !== 'flag').reduce((s, c) => s + (Number(c.weight) || 0), 0);
  }

  /* ---------- редактор ---------- */
  let errorsBox;
  let sectionsBox;
  let critBody;
  let toggleAllBtn;
  let addBtn;

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
      editorScroll.append(h('div', { class: 'ed-note' }, icon('eye', 16), 'Только просмотр. Изменять и активировать чек-лист может супервайзер.'));
    }
    errorsBox = h('div');
    editorScroll.append(errorsBox);
    renderErrors();

    /* критерии */
    critBody = h('tbody');
    editorScroll.append(h('section', { class: 'ed-sect' },
      h('div', { class: 'ed-sect__head' }, h('h2', { class: 'ed-sect__title' }, 'Критерии'),
        h('div', { class: 'factions' },
          toggleAllBtn = button(state.allOpen ? 'Свернуть все' : 'Развернуть все', { kind: 'ghost', size: 'sm', onClick: () => {
            state.allOpen = !state.allOpen;
            if (state.allOpen) cfg.criteria.forEach((c) => state.expanded.add(c.id)); else state.expanded.clear();
            toggleAllBtn.querySelector('span').textContent = state.allOpen ? 'Свернуть все' : 'Развернуть все';
            renderCriteria(); paintIssues();
          } }),
          editable ? addBtn = button('Добавить критерий', { kind: 'secondary', size: 'sm', iconName: 'plus', onClick: addCriterion }) : null)),
      h('div', { class: 'tbl-wrap' },
        h('table', { class: 'tbl ctbl tbl--cards' },
          h('colgroup', null, [28, 48, null, 168, 76, 84, 88, 44].map((w) => h('col', { style: w ? { width: `${w}px` } : null }))),
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
    const general = [...new Set(state.issues.filter((x) => !isNum(x.criterion_index)).map((x) => x.message))];
    if (!general.length) return;
    errorsBox.append(h('div', { class: 'ed-errors', role: 'alert' }, h('ul', null, general.map((e) => h('li', null, e)))));
  }

  function renderFoot() {
    clear(foot);
    // только просмотр: на телефоне полоса сохранения скрыта (класс), на компьютере сводка весов остаётся
    foot.classList.toggle('pane__foot--ro', !editable);
    if (!state.cfg) return;
    const sum = weightSum();
    const dirty = isDirty();
    const off = Math.abs(sum - 100) > 0.004;
    const status = h('span', { class: 't-13 foot-status' },
      h('span', { class: off ? 't-warn strong' : 'strong', 'data-tip': off ? 'Итог всё равно приводится к 100: веса нормируются.' : null }, `Веса ${fmt.n2(sum)}`),
      h('span', { class: 'sep' }, '·'),
      state.validating ? h('span', { class: 't-2' }, 'Проверка')
        : state.errors.length ? h('button', { type: 'button', class: 'link-btn t-danger', 'data-tip': 'Перейти к первой ошибке', onclick: jumpToFirstError }, `${state.errors.length} ${plural(state.errors.length, 'ошибка', 'ошибки', 'ошибок')}`)
          : h('span', { class: 't-ok' }, 'Ошибок нет'),
      h('span', { class: 'sep' }, '·'),
      h('span', { class: dirty ? 't-warn' : 't-2' }, state.source && state.source.default ? 'Исходный, не сохранён' : dirty ? 'Изменено' : `Без изменений, версия ${state.source ? state.source.version : ''}`));
    if (!editable) {
      foot.append(status);
      return;
    }
    if (state.saved) {
      const v = state.saved;
      foot.append(h('span', { class: 't-13 foot-status' },
        h('span', { class: 't-ok strong' }, `Версия ${v.version} сохранена${v.is_active ? ' и активна' : ''}. `),
        h('a', { href: `#/dialogs?checklist=${v.id}` }, `Оценить диалоги по версии ${v.version}`)),
      h('span', { class: 'spacer' }));
      return;
    }
    const note = h('input', { class: 'input input--sm foot-note', placeholder: 'Что изменилось, коротко', 'aria-label': 'Комментарий к версии' });
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
          state.sim = null;
          renderSim();
          renderFoot();
          toast(`Версия ${v.version} сохранена`, 'success');
        } catch (err) {
          if (err.errors) { state.errors = err.errors; validate(); }
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
    // в последнюю секцию с баллами, сразу после её последнего критерия: заголовок секции не дублируется
    const scored = cfg.criteria.filter((c) => c.type !== 'flag');
    const section = (scored.length ? scored[scored.length - 1].section : (cfg.sections[0] || {}).id) || '';
    let at = -1;
    cfg.criteria.forEach((c, i) => { if (c.section === section) at = i; });
    const c = {
      id, code: id.replace(/^c/, ''), name: 'Новый критерий', section,
      type: 'binary', weight: 10, na_allowed: false, description: '', na_condition: '', scale: [], guidance: '',
    };
    if (at >= 0) cfg.criteria.splice(at + 1, 0, c);
    else {
      const flagIdx = cfg.criteria.findIndex((x) => x.type === 'flag');
      if (flagIdx >= 0) cfg.criteria.splice(flagIdx, 0, c); else cfg.criteria.push(c);
    }
    state.expanded.add(id);
    state.fresh.add(id);
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
    paintIssues();
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
      code: h('td', { class: 'strong k-code' }),
      name: h('td', { class: 'wrap k-name' }),
      section: h('td', { class: 'clip k-sec k-meta', style: { maxWidth: '124px' }, dataset: { sectionCell: c.section } }),
      type: h('td', { class: 'nowrap k-type k-meta' }),
      weight: h('td', { class: 'num cell-input k-weight', 'data-label': 'Вес' }),
      share: h('td', { class: 'num t-2 k-share' }),
      na: h('td', { class: 'k-na' }),
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
      cells.na.dataset.label = cells.na.textContent ? 'Н/П' : '';
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

    const chev = h('td', { class: 'k-chev' }, icon('chevronDown', 16, 'chev'));
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
    const markTouched = (e) => {
      const f = e.target && e.target.dataset && e.target.dataset.f;
      if (!f || !state.fresh.has(c.id) || state.touched.has(`${c.id}:${f}`)) return;
      state.touched.add(`${c.id}:${f}`);
      paintIssues();
    };
    const err = (key) => h('span', { class: 'field__error', dataset: { err: key }, hidden: true, role: 'alert' });
    const inp = (key, props = {}) => {
      const el = h('input', { class: 'input', value: c[key] ?? '', dataset: { f: key }, disabled: dis, ...props });
      el.addEventListener('input', () => { c[key] = props.type === 'number' ? (el.value === '' ? 0 : Number(el.value)) : el.value; changed(); });
      return el;
    };
    const area = (key, rows, props = {}) => {
      const el = h('textarea', { class: 'input', rows, value: c[key] ?? '', disabled: dis, dataset: { f: key }, ...props });
      el.addEventListener('input', () => { c[key] = el.value; changed(); });
      return el;
    };
    const sectionSel = select([{ value: '', label: 'Без секции' }, ...cfg.sections.map((s) => ({ value: s.id, label: s.name || s.id }))], c.section, { 'data-section-select': '1', 'data-f': 'section', disabled: dis });
    sectionSel.addEventListener('change', () => { c.section = sectionSel.value; renderSections(); changed(); });
    const typeSel = select([{ value: 'binary', label: 'Да/Нет' }, { value: 'scale', label: 'Шкала' }, { value: 'flag', label: 'Флаг без баллов' }], c.type, { disabled: dis, 'data-f': 'type' });
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
      field('Условие Н/П', area('na_condition', 2, { placeholder: 'Когда критерий неприменим' })), err('na_condition'));
    naCb.addEventListener('change', () => { c.na_allowed = naCb.checked; naBox.hidden = !c.na_allowed; changed(); });

    return h('div', { class: 'fgrid fgrid--3', onfocusout: markTouched },
      h('div', { class: 'span-all field__error', dataset: { err: 'general' }, hidden: true, role: 'alert' }),
      h('div', null, field('Код', inp('code')), err('code')),
      h('div', { style: { gridColumn: 'span 2' } }, field('Название', inp('name')), err('name')),
      h('div', null, field('Секция', sectionSel), err('section')),
      h('div', null, field('Тип', typeSel), err('type')),
      h('div', null, field('Вес', weightIn, { hint: c.type === 'flag' ? 'Флаг не даёт баллов' : null }), err('weight')),
      h('label', { class: ['check-row', 'span-all', (dis || c.type === 'flag') && 'is-disabled'] }, naCb, 'Разрешён Н/П'),
      h('div', { class: 'span-all' }, field('Правило', area('description', 3, { placeholder: 'Да: что считается выполнением. Нет: что считается нарушением.' })), err('description')),
      naBox,
      c.type === 'scale' ? h('div', { class: 'span-all' }, scaleEditor(c, changed), err('scale')) : null,
      h('div', { class: 'span-all' }, field('Указания для ИИ', area('guidance', 4, { placeholder: 'На какие реплики смотреть, пограничные случаи' })), err('guidance')),
      h('div', { class: 'span-all' }, field('Совет оператору', area('coaching', 2, { placeholder: 'Что сказать оператору, если критерий не выполнен. Попадает в лист разбора, ИИ его не видит.' }))));
  }

  function scaleEditor(c, changed) {
    const box = h('div', { class: 'scale-ed' });
    const render = () => {
      clear(box);
      box.append(h('span', { class: 'field__label' }, 'Ступени шкалы'));
      c.scale.forEach((s, i) => {
        const v = h('input', { class: 'input', type: 'number', step: 1, min: 0, value: s.value ?? '', disabled: !editable, 'aria-label': `Баллы ступени ${i + 1}`, dataset: { step: i } });
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
    if (target) {
      await openVersion(target.id);
      if (query.new && addBtn) { addBtn.focus(); toast('Правки сохранятся как новая версия. Прежние оценки не изменятся.', 'info'); }
    }
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
