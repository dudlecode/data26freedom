// Сборка сводных данных на клиенте. Основной путь: эндпоинты сервера (/api/overview, /coaching).
// Если сервер их ещё не отдаёт (старая версия backend, 404), те же структуры собираются здесь
// из уже существующих эндпоинтов. Формат совпадает с контрактом, поэтому экраны не знают, откуда данные.

import { normValue, valueTone, valueLabel, scaleSteps, isNum, isCall } from './ui.js';
import { operatorName, operatorKey, UNKNOWN } from './operators.js';

/* ---------- общие правила ---------- */

/** Доля баллов критерия 0..1, null для N/A. Для флага 1, если грубой ошибки нет. */
export function cellFraction(c, value, sc) {
  const n = normValue(value);
  if (!n) return null;
  if (n === 'NA') return null;
  if (c.type === 'flag') return n === 'YES' ? 0 : 1;
  if (sc && isNum(sc.points) && isNum(sc.effective_weight) && sc.effective_weight > 0) return sc.points / sc.effective_weight;
  const t = valueTone(c, value);
  if (t === 'yes') return 1;
  if (t === 'no') return 0;
  if (c.type === 'scale') {
    const mx = Math.max(...(c.scale || []).map((s) => Number(s.value)), 1);
    return Number(n) / mx;
  }
  return null;
}

/** fail | partial | pass | na | none (как считает команда: «Нет», ступень ниже верхней, флаг «Да»). */
export function cellStatus(c, value) {
  const t = valueTone(c, value);
  if (t === 'no') return 'fail';
  if (t === 'partial') return 'partial';
  if (t === 'yes') return 'pass';
  if (t === 'na') return 'na';
  return 'none';
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i;
      i += 1;
      try { out[k] = await fn(items[k]); } catch { out[k] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const firstSentence = (s) => {
  const t = String(s || '').trim();
  const m = /^(.{20,220}?[.!?])(\s|$)/.exec(t);
  return m ? m[1] : t.slice(0, 220);
};

/* ---------- обзор ---------- */

const evalCache = new Map();

export async function buildOverview(api, params = {}) {
  const [list, active] = await Promise.all([
    api.dialogs(params.group_id ? { group_id: params.group_id } : undefined),
    api.activeChecklist().catch(() => null),
  ]);
  const all = list.items || [];
  const groups = list.groups || [];
  const languages = [...new Set(all.map((d) => d.language).filter(Boolean))].sort();
  const channels = [...new Set(all.map((d) => d.channel).filter(Boolean))].sort();
  const dialogs = all.filter((d) => (!params.language || d.language === params.language)
    && (!params.channel || d.channel === params.channel || (params.channel === 'call' ? isCall(d.channel) : params.channel === 'chat' ? !isCall(d.channel) : false)));
  const cfg = (active && active.config) || { criteria: [] };
  const columns = (cfg.criteria || []).map((c) => ({
    id: c.id, code: c.code || c.id, name: c.name, type: c.type, weight: Number(c.weight) || 0,
    max: c.type === 'scale' ? Math.max(...(c.scale || []).map((s) => Number(s.value)), 0) : null, section: c.section,
  }));
  const done = dialogs.filter((d) => d.latest && d.latest.status === 'done');
  const evs = await pool(done, 8, async (d) => {
    const key = `${d.latest.id}:${d.latest.finished_at}:${d.latest.open_appeals}:${d.latest.decided_appeals}`;
    if (evalCache.has(key)) return evalCache.get(key);
    const e = await api.evaluation(d.latest.id);
    evalCache.set(key, e);
    return e;
  });

  const rows = [];
  done.forEach((d, i) => {
    const e = evs[i];
    if (!e) return;
    const fin = e.final || {};
    const values = fin.values || {};
    const sc = (fin.score && fin.score.criteria) || {};
    const res = (e.result && e.result.criteria) || {};
    const evCfg = (e.checklist && e.checklist.config) || cfg;
    const cells = {};
    for (const col of columns) {
      const c = (evCfg.criteria || []).find((x) => x.id === col.id);
      if (!c || values[col.id] === undefined) { cells[col.id] = { v: null, f: null, pts: null, w: col.weight, split: false, overridden: false, appeal: null }; continue; }
      const v = values[col.id];
      const appeals = (e.appeals || []).filter((a) => a.criterion_id === col.id).sort((a, b) => b.id - a.id);
      cells[col.id] = {
        v: normValue(v),
        f: cellFraction(c, v, sc[col.id]),
        pts: sc[col.id] && isNum(sc[col.id].points) ? sc[col.id].points : null,
        w: sc[col.id] && isNum(sc[col.id].effective_weight) ? sc[col.id].effective_weight : col.weight,
        split: isNum((res[col.id] || {}).agreement) && res[col.id].agreement < 0.999,
        overridden: !!(fin.overrides && fin.overrides[col.id]),
        appeal: appeals[0] ? appeals[0].status : null,
      };
    }
    rows.push({
      dialog_id: d.id, evaluation_id: e.id, checklist_version: e.checklist_version, language: d.language, channel: d.channel,
      operator: d.operator || UNKNOWN, total: e.total, final_total: isNum(e.final_total) ? e.final_total : e.total,
      gross: !!e.gross, open_appeals: e.open_appeals || 0, min_agreement: e.min_agreement, finished_at: e.finished_at,
      cells, _reason: Object.fromEntries(Object.entries(res).map(([k, r]) => [k, r.reasoning || ''])),
    });
  });

  const finals = rows.map((r) => r.final_total).filter(isNum);
  const kpi = {
    dialogs: dialogs.length,
    evaluated: rows.length,
    not_evaluated: dialogs.length - done.length,
    avg_final: mean(finals),
    gross_dialogs: rows.filter((r) => r.gross).length,
    open_appeals: rows.reduce((s, r) => s + (r.open_appeals || 0), 0),
    split_dialogs: rows.filter((r) => isNum(r.min_agreement) && r.min_agreement < 0.999).length,
    share_85_plus: finals.length ? finals.filter((x) => x >= 85).length / finals.length : null,
  };

  const weak = columns.map((col) => {
    const c = (cfg.criteria || []).find((x) => x.id === col.id) || col;
    let fail = 0; let partial = 0; let pass = 0; let na = 0;
    const lost = [];
    const scored = [];
    for (const r of rows) {
      const cell = r.cells[col.id];
      if (!cell || cell.v === null) continue;
      const st = cellStatus(c, cell.v);
      if (st === 'fail') fail += 1; else if (st === 'partial') partial += 1; else if (st === 'pass') pass += 1; else if (st === 'na') na += 1;
      if (st !== 'na' && isNum(cell.pts) && isNum(cell.w)) lost.push(cell.w - cell.pts);
      if (st === 'fail' || st === 'partial') scored.push([r.dialog_id, cell.f ?? 0]);
    }
    const applicable = fail + partial + pass;
    return {
      criterion_id: col.id, code: col.code, name: col.name, weight: col.weight, type: col.type, applicable, fail, partial, pass, na,
      fail_rate: applicable ? (fail + partial) / applicable : 0,
      avg_points_lost: mean(lost) || 0,
      worst_dialogs: scored.sort((a, b) => a[1] - b[1]).slice(0, 5).map((x) => x[0]),
    };
  });
  const floor = Math.min(5, Math.max(0, ...weak.map((w) => w.applicable)));
  for (const w of weak) w.low_sample = w.applicable > 0 && w.applicable < floor;
  weak.sort((a, b) => (a.low_sample - b.low_sample) || b.fail_rate - a.fail_rate || b.avg_points_lost - a.avg_points_lost);

  const byOp = new Map();
  for (const r of rows) {
    const key = operatorKey(r.operator);
    if (!byOp.has(key)) byOp.set(key, { key, name: r.operator, rows: [] });
    byOp.get(key).rows.push(r);
  }
  const operators = [];
  let unnamed = null;
  for (const o of byOp.values()) {
    const fins = o.rows.map((r) => r.final_total).filter(isNum);
    const entry = { key: o.key, name: o.name, dialogs: o.rows.length, avg_final: mean(fins), gross: o.rows.filter((r) => r.gross).length, weakest: weakestOf(o.rows, columns), languages: [...new Set(o.rows.map((r) => r.language))] };
    if (o.key === '_unknown') unnamed = { dialogs: entry.dialogs, avg_final: entry.avg_final, gross: entry.gross };
    else operators.push(entry);
  }
  operators.sort((a, b) => (a.avg_final ?? 101) - (b.avg_final ?? 101) || a.name.localeCompare(b.name, 'ru'));

  const flagCol = columns.find((c) => c.type === 'flag');
  const recent = rows.filter((r) => r.gross).sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at))).slice(0, 5)
    .map((r) => ({ dialog_id: r.dialog_id, evaluation_id: r.evaluation_id, operator: r.operator, finished_at: r.finished_at, criterion_id: flagCol ? flagCol.id : null, quote: null, reason: firstSentence(flagCol ? r._reason[flagCol.id] : '') }));
  for (const r of rows) delete r._reason;

  return {
    filters: { group_id: params.group_id || null, language: params.language || null, channel: params.channel || null },
    options: { groups, languages, channels },
    checklist: active ? { id: active.id, version: active.version, name: active.name } : null,
    kpi, columns, rows, weak_spots: weak, operators, unnamed, recent_gross: recent, _fallback: true,
  };
}

function weakestOf(rows, columns) {
  let best = null;
  for (const col of columns) {
    let lost = 0; let fs = []; let n = 0; let failed = 0;
    for (const r of rows) {
      const cell = r.cells[col.id];
      if (!cell || cell.v === null || cell.f === null) continue;
      n += 1;
      fs.push(cell.f);
      if (cell.f < 0.999) failed += 1;
      if (isNum(cell.pts) && isNum(cell.w)) lost += cell.w - cell.pts;
    }
    if (!n || !failed) continue;
    const f = mean(fs);
    if (!best || lost > best.lost + 1e-9 || (Math.abs(lost - best.lost) < 1e-9 && f < best.f)) best = { lost, f, col, rate: failed / n };
  }
  return best ? { criterion_id: best.col.id, code: best.col.code, name: best.col.name, fail_rate: best.rate } : null;
}

/* ---------- разбор для оператора ---------- */

function expectedText(c) {
  if (c.coaching && String(c.coaching).trim()) return String(c.coaching).trim();
  const d = String(c.description || '');
  if (c.type === 'binary') {
    const m = /Да:\s*([\s\S]*?)(?=\s*(?:N\/A:|Н\/П:|Нет:)|$)/i.exec(d);
    if (m && m[1].trim()) return `Ожидается: ${m[1].trim()}`;
  }
  if (c.type === 'flag') {
    const m = /Да:\s*выявлено\s*([\s\S]*?)(?=\s*Нет:|$)/i.exec(d);
    if (m && m[1].trim()) return `Недопустимо: ${m[1].trim()}`;
  }
  return d.trim();
}

function scaleText(c, value) {
  const steps = scaleSteps(c);
  const cur = steps.find((s) => normValue(s.value) === normValue(value));
  const top = steps[0];
  if (!top) return expectedText(c);
  return `${cur && cur.label ? `Сейчас: ${cur.label}. ` : ''}Ожидается: ${top.label || 'верхняя ступень шкалы'}.`;
}

export function buildCoaching(ev, dialogData) {
  const cfg = (ev.checklist && ev.checklist.config) || { criteria: [] };
  const fin = ev.final || {};
  const values = fin.values || {};
  const sc = (fin.score && fin.score.criteria) || {};
  const res = (ev.result && ev.result.criteria) || {};
  const turns = (dialogData && dialogData.turns) || [];
  const byIdx = new Map(turns.map((t) => [t.idx, t]));
  const dialog = (dialogData && dialogData.dialog) || { id: ev.dialog_id };
  const items = [];
  let passed = 0;
  let applicable = 0;
  for (const c of cfg.criteria || []) {
    const v = values[c.id] !== undefined ? values[c.id] : (res[c.id] || {}).value;
    const st = cellStatus(c, v);
    if (st === 'na' || st === 'none') continue;
    applicable += 1;
    if (st === 'pass') { passed += 1; continue; }
    const s = sc[c.id] || {};
    const r = res[c.id] || {};
    const appeals = (ev.appeals || []).filter((a) => a.criterion_id === c.id).sort((a, b) => b.id - a.id);
    const quotes = (r.evidence_turns || []).slice(0, 3).map((i) => byIdx.get(i)).filter(Boolean).map((t) => ({
      idx: t.idx, turn: `T${t.idx + 1}`, speaker: t.speaker, clock: t.clock || '',
      text: String(t.text || '').length > 280 ? `${String(t.text).slice(0, 279)}…` : String(t.text || ''),
    }));
    const max = isNum(s.effective_weight) ? s.effective_weight : Number(c.weight) || 0;
    const pts = isNum(s.points) ? s.points : 0;
    items.push({
      criterion_id: c.id, code: c.code || c.id, name: c.name, value: normValue(v), value_label: valueLabel(c, v),
      points: c.type === 'flag' ? null : pts, max_points: c.type === 'flag' ? null : max, lost: c.type === 'flag' ? 0 : Math.max(0, max - pts),
      status: c.type === 'flag' ? 'gross' : st, reasoning: r.reasoning || '', quotes,
      checked_range: Array.isArray(r.checked_range) ? r.checked_range : null,
      appeal: appeals[0] ? { status: appeals[0].status, decision: appeals[0].decision } : null,
      _c: c,
    });
  }
  items.sort((a, b) => (a.status === 'gross' ? -1 : 0) - (b.status === 'gross' ? -1 : 0) || b.lost - a.lost);
  const improve = items.slice(0, 4).map((it) => ({
    criterion_id: it.criterion_id,
    text: it._c.type === 'scale' ? scaleText(it._c, it.value) : expectedText(it._c),
  }));
  for (const it of items) delete it._c;
  return {
    dialog: { id: dialog.id, channel: dialog.channel, language: dialog.language, operator: dialog.operator || operatorName(turns) },
    evaluation: { id: ev.id, checklist_version: ev.checklist_version, finished_at: ev.finished_at, total: ev.total, final_total: isNum(ev.final_total) ? ev.final_total : ev.total, gross: !!ev.gross },
    items, improve, passed_count: passed, applicable_count: applicable, generated_at: new Date().toISOString(), _fallback: true,
  };
}
