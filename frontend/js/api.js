// Тонкий клиент backend CQA (контракт: docs/API.md).
// Базовый адрес берётся из window.CQA_CONFIG.apiBase (config.js). Сессия: HttpOnly-cookie,
// а при встраивании с другого origin ещё и токен в sessionStorage (заголовок Authorization: Bearer).

const TOKEN_KEY = 'cqa.token';

export function apiBase() {
  const b = (window.CQA_CONFIG && window.CQA_CONFIG.apiBase) || '';
  return String(b).replace(/\/+$/, '');
}

function crossOrigin() {
  const b = apiBase();
  if (!b) return false;
  try { return new URL(b, location.href).origin !== location.origin; } catch { return false; }
}

function getToken() {
  if (window.CQA_CONFIG && window.CQA_CONFIG.token) return window.CQA_CONFIG.token;
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function setToken(t) {
  try {
    if (t && crossOrigin()) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* приватный режим */ }
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
  if (detail == null) return `Ошибка сервера, код ${status}`;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
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
  const init = {
    method,
    headers: { Accept: 'application/json' },
    credentials: crossOrigin() ? 'include' : 'same-origin',
    signal,
  };
  const token = getToken();
  if (token) init.headers.Authorization = `Bearer ${token}`;
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
    throw new ApiError('Сервер CQA не отвечает. Проверьте, что backend запущен.', { status: 0 });
  }
  window.dispatchEvent(new CustomEvent('cqa:online'));
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') {
      setToken(null);
      window.dispatchEvent(new CustomEvent('cqa:unauthorized'));
    }
    if (typeof data === 'string' || data === null) {
      const msg = res.status === 404
        ? `API CQA не найдено (${path}). Проверьте адрес apiBase в config.js.`
        : `Ошибка сервера, код ${res.status}`;
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
  // вход
  async login(username, password) {
    const r = await post('/api/auth/login', { username, password });
    setToken(r && r.token);
    return r;
  },
  me: () => get('/api/auth/me'),
  async logout() {
    try { await post('/api/auth/logout'); } finally { setToken(null); }
  },

  // служебные
  health: () => get('/api/health'),
  settings: () => get('/api/settings'),
  saveSettings: (partial) => put('/api/settings', partial),
  stats: (params) => get('/api/stats', params),
  anthropicKey: () => get('/api/settings/anthropic-key'),
  saveAnthropicKey: (key) => post('/api/settings/anthropic-key', { key }),

  // данные
  fetchDataset: (group_id, source_url) => post('/api/datasets/fetch', source_url ? { group_id, source_url } : { group_id }),
  importDialogs: (payload, group_id) => post('/api/dialogs/import', group_id ? { group_id, payload } : { payload }),
  dialogs: (params) => get('/api/dialogs', params),
  dialog: (id) => get(`/api/dialogs/${enc(id)}`),

  // чек-листы
  checklists: () => get('/api/checklists'),
  activeChecklist: () => get('/api/checklists/active'),
  checklist: (id) => get(`/api/checklists/${enc(id)}`),
  defaultChecklist: () => get('/api/checklists/default'),
  validateChecklist: (config) => post('/api/checklists/validate', { config }),
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

  // апелляции (автор и проверяющий берутся сервером из сессии)
  fileAppeal: (evalId, criterion_id, comment) => post(`/api/evaluations/${enc(evalId)}/appeals`, { criterion_id, comment }),
  appeals: (status = 'all') => get('/api/appeals', { status }),
  appeal: (id) => get(`/api/appeals/${enc(id)}`),
  aiReview: (id) => post(`/api/appeals/${enc(id)}/ai-review`),
  decide: (id, body) => post(`/api/appeals/${enc(id)}/decide`, body),

  // грубые ошибки
  grossErrors: (group_id) => get('/api/gross-errors', { group_id }),

  // сдача результатов (формат организаторов 1.0)
  resultsCheck: (group_id) => get('/api/export/results/check', { group_id }),

  // калибровка
  calibration: (group_id) => get('/api/calibration', { group_id }),
};

export const audioUrl = (dialogId) => `${apiBase()}/api/audio/${enc(dialogId)}`;
export const exportUrl = (group_id, format) => `${apiBase()}/api/export${qs({ group_id, format })}`;
export const resultsUrl = (group_id) => `${apiBase()}/api/export/results${qs({ group_id })}`;
