// Компонент транскрипта: реплики с якорями turn-<idx>, фазы (бот, удержание, после завершения),
// аудиоплеер для звонков с переходом к реплике и подсветкой текущей. Используется в карточке
// диалога и в рабочем месте проверяющего.

import { h, icon, SPEAKERS, plural } from './ui.js';

const PHASE_NOTES = {
  hold: 'Клиент на удержании — не слышит',
  after_end: 'После завершения разговора клиентом — не оценивается',
};

/**
 * renderTranscript(turns, { audioSrc, collapsePre, highlight: Set<idx>, idPrefix })
 * → { el, focusTurns(from, to, {seek}), highlightRange(from, to), turnText(idx) }
 */
export function renderTranscript(turns, { audioSrc = null, collapsePre = true, highlight = null, idPrefix = 'turn-', compact = false } = {}) {
  const byIdx = new Map(turns.map((t) => [t.idx, t]));
  const rows = new Map();
  const root = h('div', { class: ['transcript', compact && 'transcript--compact'] });
  let audio = null;
  let playingIdx = null;

  /* --- аудио --- */
  if (audioSrc) {
    audio = h('audio', { class: 'player__audio', controls: true, preload: 'none', src: audioSrc });
    const status = h('span', { class: 'player__status' }, 'Запись звонка');
    audio.addEventListener('error', () => {
      status.textContent = 'Запись недоступна: ссылка на mp3 не получена';
      status.classList.add('is-error');
    });
    audio.addEventListener('playing', () => { status.textContent = 'Воспроизведение'; status.classList.remove('is-error'); });
    audio.addEventListener('pause', () => { status.textContent = 'Пауза'; });
    audio.addEventListener('timeupdate', () => syncPlaying());
    root.append(h('div', { class: 'player' }, h('div', { class: 'player__head' }, icon('headset', 16), status), audio));
  }

  const offsets = turns.filter((t) => typeof t.audio_offset === 'number').map((t) => [t.audio_offset, t.idx]).sort((a, b) => a[0] - b[0]);

  function syncPlaying() {
    if (!audio) return;
    const ct = audio.currentTime;
    let cur = null;
    for (const [off, idx] of offsets) { if (off <= ct + 0.15) cur = idx; else break; }
    if (cur === playingIdx) return;
    if (playingIdx !== null && rows.get(playingIdx)) rows.get(playingIdx).classList.remove('is-playing');
    playingIdx = cur;
    const r = cur !== null ? rows.get(cur) : null;
    if (r) {
      r.classList.add('is-playing');
      if (!audio.paused) scrollIntoViewIfNeeded(r);
    }
  }

  function seek(idx, play) {
    const t = byIdx.get(idx);
    if (!audio || !t || typeof t.audio_offset !== 'number') return;
    try {
      audio.currentTime = Math.max(0, t.audio_offset - 0.2);
    } catch { /* метаданные ещё не загружены */ }
    if (play) audio.play().catch(() => {});
    else if (audio.preload === 'none') { audio.preload = 'metadata'; }
  }

  /* --- реплики --- */
  function turnRow(t) {
    const sp = t.speaker in SPEAKERS ? t.speaker : 'system';
    const row = h('div', {
      class: ['turn', `turn--${sp}`, `turn--phase-${t.phase || 'main'}`, t.boilerplate && 'turn--boiler', highlight && highlight.has(t.idx) && 'is-evidence'],
      id: `${idPrefix}${t.idx}`,
      dataset: { idx: t.idx },
    },
    h('div', { class: 'turn__meta' },
      h('span', { class: 'turn__no' }, `T${t.idx}`),
      h('span', { class: 'turn__clock' }, t.clock || '')),
    h('div', { class: 'turn__body' },
      h('div', { class: 'turn__head' },
        h('span', { class: `spk spk--${sp}` }, SPEAKERS[sp] || sp),
        t.boilerplate ? h('span', { class: 'turn__tag', 'data-tip': 'Шаблонное сообщение бота' }, 'шаблон') : null),
      h('div', { class: 'turn__text' }, t.text || '')),
    audio && typeof t.audio_offset === 'number'
      ? h('button', {
        type: 'button', class: 'turn__play', 'aria-label': `Воспроизвести с реплики T${t.idx}`, 'data-tip': `Слушать с ${fmtOffset(t.audio_offset)}`,
        onclick: () => seek(t.idx, true),
      }, icon('play', 12))
      : null);
    rows.set(t.idx, row);
    return row;
  }

  const list = h('div', { class: 'transcript__list' });
  let i = 0;
  let preDetails = null;
  while (i < turns.length) {
    const t = turns[i];
    if (collapsePre && t.phase === 'pre_operator') {
      const group = [];
      while (i < turns.length && turns[i].phase === 'pre_operator') { group.push(turns[i]); i += 1; }
      if (!group.some((g) => g.speaker === 'bot')) { group.forEach((g) => list.append(turnRow(g))); continue; }
      const det = h('details', { class: 'pre-op' },
        h('summary', null,
          icon('bot', 15),
          h('span', null, `Часть с ботом, ${group.length} ${plural(group.length, 'реплика', 'реплики', 'реплик')}`),
          h('span', { class: 'pre-op__range' }, `T${group[0].idx}–T${group[group.length - 1].idx}`)),
        h('div', { class: 'pre-op__body' }, group.map(turnRow)));
      preDetails = det;
      list.append(det);
      continue;
    }
    if (t.phase === 'hold' || t.phase === 'after_end') {
      const ph = t.phase;
      const group = [];
      while (i < turns.length && turns[i].phase === ph) { group.push(turns[i]); i += 1; }
      list.append(h('div', { class: `phase-block phase-block--${ph}` },
        h('div', { class: 'phase-block__label' }, icon(ph === 'hold' ? 'pause' : 'clock', 13), PHASE_NOTES[ph]),
        group.map(turnRow)));
      continue;
    }
    list.append(turnRow(t));
    i += 1;
  }
  root.append(list);

  /* --- навигация --- */
  let rangeMarked = [];
  function clearRange() {
    for (const r of rangeMarked) r.classList.remove('is-range');
    rangeMarked = [];
  }

  function rowsIn(from, to) {
    const out = [];
    for (const [idx, r] of rows) if (idx >= from && idx <= to) out.push(r);
    return out;
  }

  function reveal(row) {
    const det = row.closest('details');
    if (det && !det.open) det.open = true;
  }

  /** Прокрутить к реплике (или диапазону), подсветить вспышкой, для звонка — перемотать запись. */
  function focusTurns(from, to = from, { seekAudio = true, keepRange = false } = {}) {
    let target = rows.get(from);
    const inRange = rowsIn(from, to);
    if (!target && inRange.length) target = inRange[0];
    if (!target) return false;
    if (!keepRange) clearRange();
    for (const r of inRange) { reveal(r); }
    reveal(target);
    if (to > from) {
      for (const r of inRange) r.classList.add('is-range');
      rangeMarked.push(...inRange);
    }
    scrollToRow(target);
    for (const r of inRange.length ? inRange : [target]) {
      r.classList.remove('flash');
      void r.offsetWidth; // перезапуск анимации
      r.classList.add('flash');
      setTimeout(() => r.classList.remove('flash'), 1700);
    }
    if (seekAudio && audio) seek(from, !audio.paused);
    return true;
  }

  function highlightRange(from, to) {
    clearRange();
    const inRange = rowsIn(from, to);
    for (const r of inRange) { reveal(r); r.classList.add('is-range'); }
    rangeMarked = inRange;
    if (inRange[0]) scrollToRow(inRange[0]);
  }

  function turnText(idx) {
    const t = byIdx.get(idx);
    if (!t) return `T${idx}: реплика не найдена`;
    const txt = String(t.text || '').replace(/\s+/g, ' ');
    return `T${idx} ${SPEAKERS[t.speaker] || t.speaker}: ${txt.length > 180 ? `${txt.slice(0, 180)}…` : txt}`;
  }

  return { el: root, focusTurns, highlightRange, clearRange, turnText, has: (idx) => rows.has(idx), audio, preDetails };
}

function fmtOffset(s) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function prefersReduced() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Прокрутка только внутри панели транскрипта (страница не дёргается); в узкой раскладке — к панели. */
function scrollToRow(row) {
  const behavior = prefersReduced() ? 'auto' : 'smooth';
  const pane = row.closest('.scroll-pane');
  if (pane && pane.scrollHeight > pane.clientHeight + 4) {
    const p = pane.getBoundingClientRect();
    if (p.top < 0 || p.bottom > window.innerHeight) pane.scrollIntoView({ behavior, block: 'nearest' });
    const r = row.getBoundingClientRect();
    pane.scrollTo({ top: pane.scrollTop + (r.top - p.top) - p.height / 2 + r.height / 2, behavior });
  } else {
    row.scrollIntoView({ behavior, block: 'center' });
  }
}

function scrollIntoViewIfNeeded(el) {
  const sc = el.closest('.scroll-pane');
  if (!sc) return;
  const r = el.getBoundingClientRect();
  const p = sc.getBoundingClientRect();
  if (r.top < p.top + 60 || r.bottom > p.bottom - 20) scrollToRow(el);
}

