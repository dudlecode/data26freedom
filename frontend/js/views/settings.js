// Настройки: провайдер и модель, число прогонов, параллельность, локальная модель, ключ Claude API.

import { api } from '../api.js';
import { h, clear, icon, button, fmt, toast, toastError, errorState, skeleton, field, select } from '../ui.js';

const COST_PER_RUN = { 'claude-opus-5-5': 0.08, 'claude-sonnet-5-5': 0.04, 'claude-haiku-5-5': 0.002 };
const EFFORT_LABELS = { low: 'Низкий — быстро', medium: 'Средний', high: 'Высокий — рекомендуется', xhigh: 'Очень высокий', max: 'Максимальный' };

export async function mount(root, { ctx }) {
  ctx.setTitle('Настройки');
  root.append(h('div', { class: 'page-head' },
    h('div', null,
      h('h1', { class: 'page-title' }, 'Настройки'),
      h('p', { class: 'page-sub' }, 'Модель для оценки, число независимых прогонов и доступ к Claude API.'))));
  const body = h('div', { class: 'settings-grid' }, h('div', { class: 'card pad' }, skeleton(8)));
  root.append(body);

  async function load() {
    let data;
    let key;
    try {
      [data, key] = await Promise.all([api.settings(), api.anthropicKey().catch(() => null)]);
    } catch (e) {
      clear(body).append(errorState(e, load));
      return;
    }
    render(data, key);
  }

  function render(data, key) {
    clear(body);
    const s = { ...(data.settings || {}) };
    const models = data.models || [];
    const efforts = data.efforts || ['low', 'medium', 'high', 'xhigh', 'max'];
    const providers = data.providers || [{ id: 'anthropic', label: 'Claude (Anthropic)' }, { id: 'openai_compat', label: 'Локальная модель (OpenAI-compatible)' }];

    const providerSel = select(providers.map((p) => ({ value: p.id, label: p.label })), s.provider);
    const modelSel = select(models.map((m) => ({ value: m.id, label: m.label || m.id })), s.model);
    if (s.model && !models.some((m) => m.id === s.model)) modelSel.append(h('option', { value: s.model, selected: true }, s.model));
    const effortSel = select(efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] || e })), s.effort);
    const votesBox = h('div', { class: 'segmented segmented--num', role: 'radiogroup', 'aria-label': 'Число прогонов' });
    let votes = Number(s.votes) || 3;
    const concIn = h('input', { class: 'input input--code', type: 'number', min: 1, max: 32, value: s.concurrency ?? 4 });
    const baseIn = h('input', { class: 'input', value: s.local_base_url || '', placeholder: 'http://localhost:11434/v1' });
    const localModelIn = h('input', { class: 'input', value: s.local_model || '', placeholder: 'qwen3:30b' });
    const jsonSel = select([{ value: 'schema', label: 'JSON Schema (строгая схема)' }, { value: 'object', label: 'JSON object (для DeepSeek и похожих)' }], s.local_json_mode || 'schema');
    const costNote = h('p', { class: 'cost-note' });

    function renderVotes() {
      clear(votesBox);
      // сервер допускает 1–9 прогонов; показываем 1–5 и сохранённое значение, если оно больше
      const opts = [1, 2, 3, 4, 5];
      if (votes > 5 && !opts.includes(votes)) opts.push(votes);
      for (const i of opts) {
        votesBox.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(i === votes), class: i === votes ? 'is-on' : '', onclick: () => { votes = i; renderVotes(); renderCost(); } }, String(i)));
      }
    }
    function renderCost() {
      clear(costNote);
      if (providerSel.value === 'openai_compat') {
        costNote.append(icon('info', 14), h('span', null, 'Локальная модель: затрат на API нет, скорость и точность зависят от модели и железа.'));
        return;
      }
      const per = COST_PER_RUN[modelSel.value] ?? 0.08;
      costNote.append(icon('info', 14), h('span', null,
        `Ориентировочно ${fmt.money(per)} за прогон × ${votes} = ${fmt.money(per * votes)} за диалог. `
        + `Набор из 65 диалогов — около ${fmt.money(per * votes * 65)}. На Opus 5.5 прогон стоит примерно $0,08; кэш промпта снижает цену повторных прогонов.`));
    }
    const claudeBlock = h('div', { class: 'form-grid' },
      field('Модель Claude', modelSel),
      field('Уровень рассуждений', effortSel, { hint: 'Выше — точнее, но дольше и дороже.' }));
    const localBlock = h('div', { class: 'form-grid' },
      h('div', { class: 'form-grid__full' }, field('Адрес сервера (base_url)', baseIn, { hint: 'Ollama, vLLM, LM Studio или любой OpenAI-совместимый API.' })),
      field('Модель', localModelIn),
      field('Режим JSON', jsonSel));
    const syncProvider = () => {
      claudeBlock.hidden = providerSel.value !== 'anthropic';
      localBlock.hidden = providerSel.value === 'anthropic';
      renderCost();
    };
    providerSel.addEventListener('change', syncProvider);
    modelSel.addEventListener('change', renderCost);

    const saveBtn = button('Сохранить настройки', {
      kind: 'primary', iconName: 'check',
      onClick: async () => {
        const conc = Math.max(1, Math.min(32, Number(concIn.value) || 1));
        const partial = {
          provider: providerSel.value, model: modelSel.value, effort: effortSel.value, votes, concurrency: conc,
          local_base_url: baseIn.value.trim(), local_model: localModelIn.value.trim(), local_json_mode: jsonSel.value,
        };
        // backend отклоняет пустые строки — пустое поле означает «не менять»
        for (const k of ['local_base_url', 'local_model']) if (!partial[k]) delete partial[k];
        saveBtn.disabled = true;
        try {
          await api.saveSettings(partial);
          toast('Настройки сохранены', 'success');
        } catch (e) { toastError(e, 'Настройки не сохранены'); } finally { saveBtn.disabled = false; }
      },
    });

    body.append(h('section', { class: 'card pad settings-card' },
      h('h3', { class: 'card__title' }, icon('spark', 16), 'Модель оценки'),
      h('div', { class: 'form-stack' },
        field('Провайдер', providerSel),
        claudeBlock,
        localBlock,
        h('div', { class: 'form-grid' },
          field('Прогонов на диалог', votesBox, { hint: 'Независимые прогоны с голосованием по каждому критерию. 3 — баланс точности и цены.' }),
          field('Параллельно диалогов', concIn, { hint: 'Сколько диалогов оценивается одновременно.' })),
        costNote,
        h('div', { class: 'form-actions' }, saveBtn))));

    /* ключ */
    const keyStatus = h('div', { class: 'key-status' });
    const renderKey = (k) => {
      clear(keyStatus);
      const ok = k && k.configured;
      keyStatus.append(
        h('span', { class: ['key-status__dot', ok ? 'is-ok' : 'is-missing'] }),
        h('div', null,
          h('div', { class: 'key-status__title' }, ok ? 'Ключ задан' : 'Ключ не задан'),
          h('div', { class: 'muted small' }, ok ? (k.masked || 'sk-ant-…') : 'Без ключа оценка через Claude недоступна.')));
    };
    renderKey(key || { configured: data.has_anthropic_key });
    const keyIn = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-ant-…', 'aria-label': 'Ключ Claude API' });
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
          const r = await api.saveAnthropicKey(v);
          keyIn.value = '';
          msg.classList.add('is-ok');
          msg.textContent = (r && (r.message || r.detail)) || 'Ключ принят и сохранён.';
          renderKey(r && 'configured' in r ? r : await api.anthropicKey().catch(() => ({ configured: true })));
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
      h('h3', { class: 'card__title' }, icon('key', 16), 'Ключ Claude API'),
      keyStatus,
      h('div', { class: 'form-stack' },
        field('Новый ключ', keyIn, { hint: 'Ключ проверяется запросом списка моделей (без затрат токенов) и сохраняется только на сервере, в файле .env. В браузер он не возвращается.' }),
        h('div', { class: 'form-actions' }, keyBtn),
        msg)));

    renderVotes();
    syncProvider();
  }

  await load();
  return undefined;
}
