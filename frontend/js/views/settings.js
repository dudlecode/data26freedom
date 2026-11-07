// Настройки: модель оценки, локальная модель, ключ Claude API. Сохранять может только супервайзер.

import { api } from '../api.js';
import { h, clear, icon, button, fmt, toast, errorState, skeleton, field, select, segmented, withBusy, pageHeader, fetchEstimate, plural } from '../ui.js';
import { can, roleHint } from '../session.js';

const EFFORT_LABELS = { low: 'Низкий, быстрее', medium: 'Средний', high: 'Высокий, рекомендуется', xhigh: 'Очень высокий', max: 'Максимальный' };

export async function mount(root, { ctx }) {
  ctx.setTitle('Настройки');
  const editable = can('manage');
  const body = h('div', { class: 'content' }, h('div', { class: 'panel' }, skeleton(8)));
  root.append(pageHeader({ title: 'Настройки', meta: editable ? 'Применяются к новым оценкам' : null }), body);
  let snapshot = null;
  let setSize = 0;
  let current = () => null;
  ctx.setLeaveGuard(() => !snapshot || JSON.stringify(current()) === snapshot);

  async function load() {
    let data;
    let key;
    try {
      let st;
      [data, key, st] = await Promise.all([api.settings(), api.anthropicKey().catch(() => null), api.stats().catch(() => null)]);
      setSize = st && st.dialogs ? st.dialogs : 0;
    } catch (e) {
      clear(body).append(h('div', { class: 'panel' }, errorState(e, load)));
      return;
    }
    render(data, key);
  }

  function render(data, key) {
    clear(body);
    const s = { ...(data.settings || {}) };
    const dis = !editable;
    const models = data.models || [];
    const efforts = data.efforts || ['low', 'medium', 'high', 'xhigh', 'max'];
    const providers = data.providers || [{ id: 'anthropic', label: 'Claude (Anthropic API)' }, { id: 'openai_compat', label: 'Локальная модель' }];

    const providerSel = select(providers.map((p) => ({ value: p.id, label: p.label })), s.provider, { disabled: dis });
    const modelSel = select(models.map((m) => ({ value: m.id, label: m.label || m.id })), s.model, { disabled: dis });
    if (s.model && !models.some((m) => m.id === s.model)) modelSel.append(h('option', { value: s.model, selected: true }, s.model));
    const effortSel = select(efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] || e })), s.effort, { disabled: dis });
    let votes = Number(s.votes) || 3;
    const voteOpts = [1, 2, 3, 4, 5];
    if (votes > 5) voteOpts.push(votes);
    const votesSeg = segmented(voteOpts.map((v) => ({ value: v, label: String(v) })), votes, (v) => { votes = Number(v); renderCost(); }, { label: 'Прогонов на диалог', disabled: dis });
    const concIn = h('input', { class: 'input input--num', type: 'number', min: 1, max: 32, value: s.concurrency ?? 4, disabled: dis });
    const concHint = h('span', { class: 'field__hint' }, 'От 1 до 32.');
    concIn.addEventListener('input', () => {
      const v = Number(concIn.value);
      concHint.className = v && (v < 1 || v > 32) ? 'field__error' : 'field__hint';
      concHint.textContent = v && (v < 1 || v > 32) ? `Будет сохранено ${Math.max(1, Math.min(32, Math.round(v)))}: допустимо от 1 до 32.` : 'От 1 до 32.';
    });
    const baseIn = h('input', { class: 'input', value: s.local_base_url || '', placeholder: 'http://localhost:11434/v1', disabled: dis });
    const localModelIn = h('input', { class: 'input', value: s.local_model || '', placeholder: 'qwen3-cqa', disabled: dis });
    const jsonSel = select([{ value: 'schema', label: 'JSON Schema, строгая схема' }, { value: 'object', label: 'JSON object, для DeepSeek и похожих' }], s.local_json_mode || 'schema', { disabled: dis });
    const costNote = h('p', { class: 'field__hint' });
    const msg = h('span', { class: 'inline-msg', role: 'status' });
    const claudeBox = h('div', { class: 'fstack' });
    const dirtyNote = h('span', { class: 't-13 t-warn', hidden: true }, 'Есть несохранённые изменения');

    let costSeq = 0;
    function renderCost() {
      const local = providerSel.value === 'openai_compat';
      claudeBox.hidden = local;
      localRow.hidden = !local;
      if (local) {
        costNote.textContent = 'Локальная модель: затрат на API нет.';
        return;
      }
      const seq = ++costSeq;
      const v = votes;
      fetchEstimate(api, { provider: 'anthropic', model: modelSel.value, votes: v }, setSize || 1).then((est) => {
        if (seq !== costSeq) return;
        if (!est) { costNote.textContent = ''; return; }
        const runs = v === 1 ? 'прогоне' : 'прогонах';
        const basis = est.basis && est.basis.source === 'history' ? `По фактической стоимости ${est.basis.evaluations} ${plural(est.basis.evaluations, 'оценки', 'оценок', 'оценок')} этой модели.` : 'Оценка по тарифу, истории оценок этой моделью пока нет.';
        const set = setSize > 1 ? `, ${fmt.money(est.cost)} за ${setSize} диалогов в базе` : '';
        costNote.textContent = `Около ${fmt.money(est.perDialog)} за диалог при ${v} ${runs}${set}. ${basis}${v > 1 ? ' Повторные прогоны читают промпт из кэша.' : ''}`;
      });
    }
    providerSel.addEventListener('change', renderCost);
    modelSel.addEventListener('change', renderCost);
    current = () => ({ provider: providerSel.value, model: modelSel.value, effort: effortSel.value, votes, concurrency: Number(concIn.value), base: baseIn.value, lm: localModelIn.value, json: jsonSel.value });
    const markDirty = () => { dirtyNote.hidden = JSON.stringify(current()) === snapshot; };

    const saveBtn = button('Сохранить', {
      kind: 'primary',
      onClick: (e) => withBusy(e.currentTarget, async () => {
        msg.className = 'inline-msg';
        msg.textContent = '';
        const conc = Math.max(1, Math.min(32, Number(concIn.value) || 1));
        const partial = {
          provider: providerSel.value, model: modelSel.value, effort: effortSel.value, votes, concurrency: conc,
          local_base_url: baseIn.value.trim(), local_model: localModelIn.value.trim(), local_json_mode: jsonSel.value,
        };
        for (const k of ['local_base_url', 'local_model']) if (!partial[k]) delete partial[k];
        try {
          await api.saveSettings(partial);
          concIn.value = String(conc);
          snapshot = JSON.stringify(current());
          markDirty();
          toast('Настройки сохранены. Новые оценки пойдут с ними.', 'success');
        } catch (err) {
          msg.classList.add('is-error');
          msg.textContent = err.message;
        }
      }),
    });

    /* ключ */
    const keyLine = h('div', { class: 'key-line' });
    const renderKey = (k) => {
      clear(keyLine);
      const ok = k && k.configured;
      keyLine.append(h('span', { class: ['dot', ok ? 'dot--ok' : 'dot--off'], 'aria-hidden': 'true' }),
        h('span', null, ok ? `Ключ задан: ${k.masked || 'скрыт'}` : 'Ключ не задан'));
    };
    renderKey(key || { configured: data.has_anthropic_key });
    const keyIn = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-ant-', 'aria-label': 'Новый ключ Claude API', disabled: dis });
    const keyMsg = h('span', { class: 'inline-msg', role: 'status' });
    const keyBtn = button('Сохранить и проверить', {
      kind: 'secondary',
      onClick: (e) => withBusy(e.currentTarget, async () => {
        const v = keyIn.value.trim();
        keyMsg.className = 'inline-msg';
        if (!v) { keyMsg.classList.add('is-error'); keyMsg.textContent = 'Вставьте ключ.'; keyIn.focus(); return; }
        keyMsg.textContent = 'Проверка ключа';
        try {
          const r = await api.saveAnthropicKey(v);
          keyIn.value = '';
          keyMsg.classList.add('is-ok');
          keyMsg.textContent = 'Ключ принят и сохранён на сервере.';
          renderKey(r && 'configured' in r ? r : await api.anthropicKey().catch(() => ({ configured: true })));
          ctx.refreshHealth();
        } catch (err) {
          keyMsg.classList.add('is-error');
          keyMsg.textContent = err.message;
        }
      }),
    });
    keyIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !keyBtn.disabled) keyBtn.click(); });

    const row = (title, desc, content) => h('section', { class: 'srow' },
      h('div', null, h('h2', { class: 'srow__title' }, title), desc ? h('p', { class: 'srow__desc' }, desc) : null),
      h('div', { class: 'srow__body fstack' }, content));

    claudeBox.append(field('Модель Claude', modelSel), field('Уровень рассуждений', effortSel));
    const localRow = row('Локальная модель', 'OpenAI-совместимый сервер: Ollama, vLLM, LM Studio.', [
      field('Адрес сервера', baseIn, { hint: 'По умолчанию Ollama на этом компьютере.' }),
      h('div', { class: 'fgrid' }, field('Модель', localModelIn, { hint: 'qwen3-cqa в Ollama' }), field('Режим JSON', jsonSel)),
    ]);
    body.append(h('div', { class: ['panel', 'settings', dis && 'is-readonly'], style: { maxWidth: '980px' } },
      dis ? h('div', { class: 'ed-note' }, icon('eye', 16), `Только просмотр. ${roleHint('manage')}.`) : null,
      row('Модель оценки', 'Провайдер и модель для новых оценок.', [
        field('Провайдер', providerSel),
        claudeBox,
        h('div', { class: 'fgrid' },
          field('Прогонов на диалог', votesSeg, { hint: 'Независимые прогоны, голосование по каждому критерию.' }),
          h('div', null, field('Параллельно диалогов', concIn), concHint)),
        costNote,
      ]),
      localRow,
      editable ? row('Ключ Claude API', 'Хранится только на сервере, в браузер не возвращается.', [
        keyLine,
        field('Новый ключ', keyIn),
        h('div', { class: 'factions' }, keyBtn, keyMsg),
      ]) : null,
      editable ? h('div', { class: 'settings__foot' }, dirtyNote, h('span', { class: 'spacer' }), msg, saveBtn) : null));
    renderCost();
    snapshot = JSON.stringify(current());
    for (const el of [providerSel, modelSel, effortSel, concIn, baseIn, localModelIn, jsonSel]) { el.addEventListener('input', markDirty); el.addEventListener('change', markDirty); }
    votesSeg.addEventListener('click', () => setTimeout(markDirty, 0));
  }

  await load();
  return () => ctx.setLeaveGuard(null);
}
