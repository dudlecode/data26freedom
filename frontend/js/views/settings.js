// Настройки: модель оценки (Qwen3 через OpenAI-совместимый API), прогоны, параллельность, цена, ключ сервера модели.

import { api, apiBase } from '../api.js';
import { h, clear, icon, button, fmt, toast, toastError, errorState, skeleton, field, select, estimateCost, costHint, isLocalUrl } from '../ui.js';

export async function mount(root, { ctx }) {
  ctx.setTitle('Настройки');
  root.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h1', { class: 'page-title' }, 'Настройки'),
      h('p', { class: 'page-sub' }, 'Модель для оценки, число независимых прогонов, цена и доступ к серверу модели.'))));
  const body = h('div', { class: 'settings-grid' }, h('div', { class: 'card pad' }, skeleton(8)));
  root.append(body);

  async function load() {
    let data;
    let key;
    let health = null;
    try {
      [data, key, health] = await Promise.all([api.settings(), api.modelKey().catch(() => null), api.health().catch(() => null)]);
    } catch (e) {
      clear(body).append(errorState(e, load));
      return;
    }
    render(data, key, health && health.model);
  }

  function render(data, key, modelStatus) {
    clear(body);
    const s = { ...(data.settings || {}) };
    const baseIn = h('input', { class: 'input', value: s.base_url || '', placeholder: 'http://localhost:11434/v1' });
    const modelIn = h('input', { class: 'input', value: s.model || '', placeholder: 'qwen3:30b' });
    const jsonSel = select([{ value: 'schema', label: 'JSON Schema (строгая схема)' }, { value: 'object', label: 'JSON object (сервер без поддержки схем)' }], s.json_mode || 'schema');
    const votesBox = h('div', { class: 'segmented segmented--num', role: 'radiogroup', 'aria-label': 'Число прогонов' });
    let votes = Number(s.votes) || 3;
    const concIn = h('input', { class: 'input input--code', type: 'number', min: 1, max: 32, value: s.concurrency ?? 4 });
    const pinIn = h('input', { class: 'input input--code', type: 'number', min: 0, step: '0.01', value: s.price_input_per_mtok ?? 0 });
    const poutIn = h('input', { class: 'input input--code', type: 'number', min: 0, step: '0.01', value: s.price_output_per_mtok ?? 0 });
    const where = h('p', { class: 'muted small' });
    const costNote = h('p', { class: 'cost-note' });
    const statusLine = h('div', { class: 'key-status' });

    function renderStatus() {
      clear(statusLine);
      const m = modelStatus || {};
      const ok = m.reachable && !m.error;
      statusLine.append(
        h('span', { class: ['key-status__dot', ok ? 'is-ok' : 'is-missing'] }),
        h('div', null,
          h('div', { class: 'key-status__title' }, ok ? 'Сервер модели отвечает' : 'Сервер модели недоступен'),
          h('div', { class: 'muted small' }, ok
            ? `${m.model}${m.model_found === false ? ' - модели нет в списке сервера' : ''}`
            : (m.error || 'Проверьте адрес и что сервер модели запущен.'))));
    }
    function renderVotes() {
      clear(votesBox);
      // сервер допускает 1-9 прогонов; показываем 1-5 и сохранённое значение, если оно больше
      const opts = [1, 2, 3, 4, 5];
      if (votes > 5 && !opts.includes(votes)) opts.push(votes);
      for (const i of opts) {
        votesBox.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(i === votes), class: i === votes ? 'is-on' : '', onclick: () => { votes = i; renderVotes(); renderCost(); } }, String(i)));
      }
    }
    function current() {
      return { base_url: baseIn.value.trim(), model: modelIn.value.trim(), votes,
        price_input_per_mtok: Number(pinIn.value) || 0, price_output_per_mtok: Number(poutIn.value) || 0 };
    }
    function renderCost() {
      clear(costNote);
      const est = estimateCost(current(), 65);
      where.textContent = isLocalUrl(baseIn.value.trim())
        ? 'Модель в контуре компании (локальный сервер): данные диалогов не уходят наружу. В results.json - mode: local.'
        : 'Внешний сервер модели: диалоги отправляются провайдеру. В results.json - mode: external_api.';
      costNote.append(icon('info', 14), h('span', null,
        `${votes} ${votes === 1 ? 'прогон' : votes < 5 ? 'прогона' : 'прогонов'} на диалог. Весь DEV (65 диалогов): ${costHint(est)}`
        + (est.cost != null ? ' Расчёт для типичного прогона ~9 тыс. токенов на входе и ~1,5 тыс. на выходе; точная стоимость каждой оценки - в её технических деталях.' : '')));
    }
    for (const el of [baseIn, modelIn, pinIn, poutIn]) el.addEventListener('input', renderCost);

    const saveBtn = button('Сохранить настройки', {
      kind: 'primary', iconName: 'check',
      onClick: async () => {
        const conc = Math.max(1, Math.min(32, Number(concIn.value) || 1));
        const partial = { ...current(), json_mode: jsonSel.value, concurrency: conc };
        // backend отклоняет пустые строки - пустое поле означает «не менять»
        for (const k of ['base_url', 'model']) if (!partial[k]) delete partial[k];
        saveBtn.disabled = true;
        try {
          await api.saveSettings(partial);
          toast('Настройки сохранены', 'success');
          ctx.refreshHealth();
          load();
        } catch (e) { toastError(e, 'Настройки не сохранены'); } finally { saveBtn.disabled = false; }
      },
    });

    body.append(h('section', { class: 'card pad settings-card' },
      h('h3', { class: 'card__title' }, icon('spark', 16), 'Модель оценки'),
      statusLine,
      h('div', { class: 'form-stack' },
        h('div', { class: 'form-grid' },
          h('div', { class: 'form-grid__full' }, field('Адрес сервера модели (base_url)', baseIn, { hint: 'Любой OpenAI-совместимый API: vLLM, Ollama, LM Studio или провайдер. Путь до /v1.' })),
          field('Модель', modelIn, { hint: 'Qwen3 30B. Для Ollama - qwen3:30b-cqa (окно 16k, см. README).' }),
          field('Режим JSON', jsonSel)),
        where,
        h('div', { class: 'form-grid' },
          field('Прогонов на диалог', votesBox, { hint: 'Независимые прогоны с голосованием по каждому критерию. 3 - баланс точности и времени.' }),
          field('Параллельно диалогов', concIn, { hint: 'Сколько диалогов оценивается одновременно.' })),
        h('div', { class: 'form-grid' },
          field('Цена: вход, $ за 1 млн токенов', pinIn, { hint: '0 - не считать (свой сервер).' }),
          field('Цена: выход, $ за 1 млн токенов', poutIn)),
        costNote,
        h('div', { class: 'form-actions' }, saveBtn))));

    /* ключ сервера модели */
    const keyStatus = h('div', { class: 'key-status' });
    const renderKey = (k) => {
      clear(keyStatus);
      const ok = k && k.configured;
      keyStatus.append(
        h('span', { class: ['key-status__dot', ok ? 'is-ok' : 'is-na'] }),
        h('div', null,
          h('div', { class: 'key-status__title' }, ok ? 'Ключ задан' : 'Ключ не задан'),
          h('div', { class: 'muted small' }, ok ? (k.masked || '…') : 'Нужен только провайдеру. Своей Ollama / vLLM ключ не нужен.')));
    };
    renderKey(key || { configured: data.has_key });
    const keyIn = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'ключ API провайдера', 'aria-label': 'Ключ API сервера модели' });
    const msg = h('p', { class: 'key-msg', role: 'status' });
    const keyBtn = button('Сохранить и проверить', {
      kind: 'primary', iconName: 'key',
      onClick: async () => {
        const v = keyIn.value.trim();
        if (!v) { toast('Вставьте ключ', 'error'); keyIn.focus(); return; }
        keyBtn.disabled = true;
        keyBtn.classList.add('is-busy');
        msg.className = 'key-msg';
        msg.textContent = 'Проверяем ключ…';
        try {
          const r = await api.saveModelKey(v);
          keyIn.value = '';
          msg.classList.add('is-ok');
          msg.textContent = 'Ключ принят и сохранён.';
          renderKey(r && 'configured' in r ? r : await api.modelKey().catch(() => ({ configured: true })));
          ctx.refreshHealth();
        } catch (e) {
          msg.classList.add('is-error');
          msg.textContent = e.message;
        } finally {
          keyBtn.disabled = false;
          keyBtn.classList.remove('is-busy');
        }
      },
    });
    keyIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') keyBtn.click(); });

    body.append(h('section', { class: 'card pad settings-card' },
      h('h3', { class: 'card__title' }, icon('key', 16), 'Ключ API сервера модели'),
      keyStatus,
      h('div', { class: 'form-stack' },
        field('Новый ключ', keyIn, { hint: 'Проверяется запросом списка моделей (без затрат токенов) и сохраняется только на сервере, в файле .env. В браузер он не возвращается.' }),
        h('div', { class: 'form-actions' }, keyBtn),
        msg)));

    renderVotes();
    renderStatus();
    renderCost();
    body.append(integrationsCard(), auditCard(ctx));
  }

  await load();
  return undefined;
}

/* ---------- интеграции: вебхуки Power Automate, Dynamics 365, OpenAPI ---------- */

const ROLE_LABELS = { supervisor: 'Супервайзер', reviewer: 'Проверяющий' };
const DELIVERY = { ok: ['chip--ok', 'доставлено'], error: ['chip--no', 'ошибка'], pending: ['chip--warn', 'в очереди'] };

function integrationsCard() {
  const box = h('section', { class: 'card pad settings-card' },
    h('h3', { class: 'card__title' }, icon('external', 16), 'Интеграции'), skeleton(4));
  const testIn = h('input', { class: 'input', placeholder: 'https://prod-…logic.azure.com/… (необязательно)', 'aria-label': 'Адрес для тестового события' });

  async function load() {
    let st;
    let dl;
    try {
      [st, dl] = await Promise.all([api.integrations(), api.deliveries(8)]);
    } catch (e) {
      clear(box).append(h('h3', { class: 'card__title' }, icon('external', 16), 'Интеграции'), errorState(e, load));
      return;
    }
    const wh = st.webhooks || {};
    const row = (k, v) => h('div', { class: 'integ-row' }, h('span', { class: 'muted' }, k), h('span', null, v));
    const testBtn = button('Отправить тестовое событие', {
      iconName: 'play',
      onClick: async () => {
        testBtn.disabled = true;
        try {
          const r = await api.testWebhook(testIn.value.trim());
          const d = (r.deliveries || [])[0] || {};
          if (d.status === 'ok') toast(`Событие доставлено (HTTP ${d.http_status})`, 'success');
          else toast(`Не доставлено: ${d.error || d.status}`, 'error');
          load();
        } catch (e) { toastError(e, 'Тест не выполнен'); } finally { testBtn.disabled = false; }
      },
    });
    clear(box).append(
      h('h3', { class: 'card__title' }, icon('external', 16), 'Интеграции'),
      h('p', { class: 'muted small' },
        'События CQA уходят JSON-вебхуком, например в поток Power Automate («When an HTTP request is received»), '
        + 'а из него в Dataverse / Dynamics 365, Teams или почту. Интерфейс встраивается в Dynamics 365 как веб-ресурс (папка dynamics/).'),
      h('div', { class: 'integ-list' },
        row('Вебхуки', wh.configured
          ? h('span', { class: 'chip chip--ok' }, `настроено адресов: ${wh.urls.length}`)
          : h('span', { class: 'chip chip--muted' }, 'не настроены (CQA_WEBHOOK_URLS в .env)')),
        ...(wh.urls || []).map((u) => row('', h('code', { class: 'integ-url' }, u))),
        row('Подпись HMAC', wh.signed ? h('span', { class: 'chip chip--ok' }, 'X-CQA-Signature, SHA-256') : h('span', { class: 'chip chip--muted' }, 'выключена (CQA_WEBHOOK_SECRET)')),
        row('События', h('span', { class: 'small' }, Object.keys(wh.events || {}).filter((e) => e !== 'webhook.test').join(', '))),
        row('Ссылки в событиях', st.public_url ? h('code', null, st.public_url) : h('span', { class: 'muted small' }, 'CQA_PUBLIC_URL не задан')),
        row('Встраивание (CORS)', (st.cors_origins || []).length ? h('code', null, st.cors_origins.join(', ')) : h('span', { class: 'muted small' }, 'только этот адрес (CQA_CORS_ORIGINS)')),
        row('API', h('span', null,
          h('a', { href: `${apiBase()}${st.swagger}`, target: '_blank', rel: 'noopener' }, 'Swagger UI'), ' · ',
          h('a', { href: `${apiBase()}${st.openapi}`, target: '_blank', rel: 'noopener' }, 'OpenAPI JSON'), ' · ',
          h('span', { class: 'muted small' }, st.postman)))),
      h('div', { class: 'form-stack' },
        field('Проверить приёмник', testIn, { hint: 'Пусто - событие уйдёт на настроенные адреса.' }),
        h('div', { class: 'form-actions' }, testBtn)),
      (dl.items || []).length
        ? h('div', null,
          h('div', { class: 'muted small integ-sub' }, 'Последние доставки'),
          h('table', { class: 'table table--compact' },
            h('tbody', null, ...dl.items.map((d) => {
              const [cls, label] = DELIVERY[d.status] || ['chip--muted', d.status];
              return h('tr', null,
                h('td', { class: 'small' }, fmt.dateShort(d.created_at)),
                h('td', null, h('code', { class: 'small' }, d.event)),
                h('td', null, h('span', { class: `chip ${cls}`, title: d.error || '' }, d.http_status ? `${label} · ${d.http_status}` : label)));
            }))))
        : '');
  }
  load();
  return box;
}

/* ---------- журнал действий ---------- */

const AUDIT_FILTERS = [
  { value: '', label: 'Все действия' },
  { value: 'appeal', label: 'Апелляции' },
  { value: 'checklist', label: 'Чек-листы и запуски оценки' },
  { value: 'evaluation', label: 'Повторные оценки' },
  { value: 'dataset', label: 'Загрузка данных' },
  { value: 'settings', label: 'Настройки' },
];
const AUDIT_ICONS = { appeal: 'gavel', checklist: 'list', evaluation: 'refresh', dataset: 'upload', settings: 'cog' };

function auditCard(ctx) {
  const filter = select(AUDIT_FILTERS, '');
  const list = h('div', { class: 'audit-list' }, skeleton(5));
  const box = h('section', { class: 'card pad settings-card settings-wide' },
    h('div', { class: 'audit-head' },
      h('h3', { class: 'card__title' }, icon('clock', 16), 'Журнал действий'),
      filter),
    h('p', { class: 'muted small' }, 'Кто, когда и что изменил: апелляции и решения по ним, версии чек-листов, запуски оценки, загрузка данных. Доступно и через GET /api/audit.'),
    list);

  async function load() {
    clear(list).append(skeleton(4));
    let items;
    try {
      items = (await api.audit({ entity: filter.value || undefined, limit: 100 })).items || [];
    } catch (e) {
      clear(list).append(errorState(e, load));
      return;
    }
    clear(list);
    if (!items.length) { list.append(h('p', { class: 'muted small' }, 'Записей пока нет.')); return; }
    for (const it of items) {
      const link = it.entity === 'appeal' ? `#/appeal/${it.entity_id}` : it.entity === 'checklist' ? '#/checklists' : null;
      list.append(h('div', { class: 'audit-item' },
        h('span', { class: 'audit-item__icon' }, icon(AUDIT_ICONS[it.entity] || 'info', 14)),
        h('div', { class: 'audit-item__body' },
          link ? h('a', { href: link, class: 'audit-item__text' }, it.summary) : h('span', { class: 'audit-item__text' }, it.summary),
          h('div', { class: 'muted small' }, `${fmt.date(it.at)} · ${ROLE_LABELS[it.actor] || it.actor || 'система'} · ${it.event}`))));
    }
  }
  filter.addEventListener('change', load);
  load();
  return box;
}
