// Тонкий клиент для backend CQA (контракт: docs/API.md).
// Базовый адрес берётся из window.CQA_CONFIG.apiBase (config.js).

export function apiBase() {
  const b = (window.CQA_CONFIG && window.CQA_CONFIG.apiBase) || '';
  return String(b).replace(/\/+$/, '');
}

export class ApiError extends Error {
  constructor(message, { status = 0, detail = null, errors = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.errors = errors;
  }
}

function detailToMessage(detail, status) {
  if (detail == null) return `Ошибка сервера (HTTP ${status})`;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    // Ошибки валидации FastAPI: [{loc, msg}]
    return detail.map((d) => (d && d.msg ? `${(d.loc || []).slice(1).join('.')}: ${d.msg}` : String(d))).join('; ');
  }
  if (typeof detail === 'object' && Array.isArray(detail.errors)) return detail.errors.join('; ');
  try { return JSON.stringify(detail); } catch { return String(detail); }
}

function qs(params) {
  if (!params) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function request(method, path, { body, params, signal } = {}) {
  const url = apiBase() + path + qs(params);
  const init = { method, headers: { Accept: 'application/json' }, signal };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    window.dispatchEvent(new CustomEvent('cqa:offline'));
    throw new ApiError('Сервер CQA недоступен. Проверьте, что backend запущен.', { status: 0 });
  }
  window.dispatchEvent(new CustomEvent('cqa:online'));
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    if (typeof data === 'string' || data === null) {
      // ответ не от API CQA (например, статический сервер без backend)
      const msg = res.status === 404
        ? `API CQA не найдено (${path}). Проверьте, что backend запущен, и адрес apiBase в config.js.`
        : `Ошибка сервера (HTTP ${res.status})`;
      throw new ApiError(msg, { status: res.status });
    }
    const detail = data && typeof data === 'object' ? data.detail : data;
    const errors = detail && typeof detail === 'object' && Array.isArray(detail.errors) ? detail.errors : null;
    throw new ApiError(detailToMessage(detail, res.status), { status: res.status, detail, errors });
  }
  return data;
}

const get = (path, params, opts) => request('GET', path, { ...opts, params });
const post = (path, body, opts) => request('POST', path, { ...opts, body: body === undefined ? {} : body });
const put = (path, body) => request('PUT', path, { body });
const enc = encodeURIComponent;

export const api = {
  // служебные
  health: () => get('/api/health'),
  settings: () => get('/api/settings'),
  saveSettings: (partial) => put('/api/settings', partial),
  stats: (params) => get('/api/stats', params),
  anthropicKey: () => get('/api/settings/anthropic-key'),
  saveAnthropicKey: (key) => post('/api/settings/anthropic-key', { key }),

  // данные
  fetchDataset: (group_id, source_url) => post('/api/datasets/fetch', source_url ? { group_id, source_url } : { group_id }),
  // group_id не указан → сервер берёт dataset_group_id из ответа организаторов, иначе UPLOAD
  importDialogs: (payload, group_id) => post('/api/dialogs/import', group_id ? { group_id, payload } : { payload }),
  dialogs: (params) => get('/api/dialogs', params),
  dialog: (id) => get(`/api/dialogs/${enc(id)}`),

  // чек-листы
  checklists: () => get('/api/checklists'),
  activeChecklist: () => get('/api/checklists/active'),
  checklist: (id) => get(`/api/checklists/${enc(id)}`),
  defaultChecklist: () => get('/api/checklists/default'),
  validateChecklist: (config, opts) => request('POST', '/api/checklists/validate', { ...opts, body: { config } }),
  saveChecklist: (config, note, activate) => post('/api/checklists', { config, note, activate }),
  activateChecklist: (id) => post(`/api/checklists/${enc(id)}/activate`),

  // оценки
  evaluate: (dialog_ids, checklist_id, settings) => {
    const body = { dialog_ids };
    if (checklist_id) body.checklist_id = Number(checklist_id);
    if (settings) body.settings = settings;
    return post('/api/evaluations', body);
  },
  evaluations: (params) => get('/api/evaluations', params),
  evaluation: (id) => get(`/api/evaluations/${enc(id)}`),
  rerun: (id) => post(`/api/evaluations/${enc(id)}/rerun`),

  // апелляции
  fileAppeal: (evalId, criterion_id, comment, author) => post(`/api/evaluations/${enc(evalId)}/appeals`, { criterion_id, comment, author }),
  appeals: (status = 'all') => get('/api/appeals', { status }),
  appeal: (id) => get(`/api/appeals/${enc(id)}`),
  aiReview: (id) => post(`/api/appeals/${enc(id)}/ai-review`),
  decide: (id, body) => post(`/api/appeals/${enc(id)}/decide`, body),

  // калибровка и экспорт
  calibration: (group_id) => get('/api/calibration', { group_id }),
};

export const audioUrl = (dialogId) => `${apiBase()}/api/audio/${enc(dialogId)}`;
export const exportUrl = (group_id, format) => `${apiBase()}/api/export${qs({ group_id, format })}`;
