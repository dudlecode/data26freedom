// Транскрипт: реплики с якорями, фазы (часть с ботом, удержание, после завершения), аудиоплеер звонка
// с переходом к реплике и подсветкой текущей, и полоса меток вдоль правого края: где в диалоге
// находятся реплики-основания выбранного критерия. Используется в карточке диалога и в апелляции.

import { h, icon, SPEAKERS, nTurns, rangeLabel } from './ui.js';

/**
 * renderTranscript(turns, { audioSrc, collapsePre, idPrefix })
 * -> { el, focusTurns(from, to, {seekAudio}), setHover(sel), setPinned(sel), turnText(idx), has(idx), audio }
 * sel = { turns: [idx], range: [from, to] | null } | null
 */
export function renderTranscript(turns, { audioSrc = null, collapsePre = true, idPrefix = 'turn-' } = {}) {
  const byIdx = new Map(turns.map((t) => [t.idx, t]));
  const rows = new Map();
  const root = h('div', { class: 'tx' });
  let audio = null;
  let playingIdx = null;

  /* ---------- аудио ---------- */
  if (audioSrc) {
    audio = h('audio', { controls: true, preload: 'none', src: audioSrc });
    const label = h('span', { class: 'player__label' }, 'Запись звонка');
    audio.addEventListener('error', () => {
      label.textContent = 'Запись недоступна';
      label.classList.add('is-error');
    });
    audio.addEventListener('timeupdate', () => syncPlaying());
    root.append(h('div', { class: 'player' }, label, audio));
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
      if (!audio.paused) keepVisible(r);
    }
    drawPlayMark();
  }

  function seek(idx, play) {
    const t = byIdx.get(idx);
    if (!audio || !t || typeof t.audio_offset !== 'number') return;
    if (audio.preload === 'none') audio.preload = 'metadata';
    try { audio.currentTime = Math.max(0, t.audio_offset - 0.2); } catch { /* метаданные ещё не загружены */ }
    if (play) audio.play().catch(() => {});
  }

  /* ---------- реплики ---------- */
  function turnRow(t) {
    const sp = t.speaker in SPEAKERS ? t.speaker : 'system';
    const canPlay = audio && typeof t.audio_offset === 'number';
    const row = h('div', { class: ['turn', `turn--${sp}`], id: `${idPrefix}${t.idx}`, dataset: { idx: t.idx } },
      h('div', { class: 'turn__meta' },
        h('span', { class: 'turn__no' }, `T${t.idx + 1}`),
        t.clock ? h('span', null, t.clock) : null),
      h('div', null,
        h('div', { class: 'turn__who' }, SPEAKERS[sp], t.boilerplate ? h('span', { class: 'turn__tag' }, 'шаблон') : null),
        h('div', { class: 'turn__text' }, t.text || '')),
      canPlay
        ? h('button', {
          type: 'button', class: 'turn__play', 'aria-label': `Слушать с реплики T${t.idx + 1}`, 'data-tip': `Слушать с ${t.clock || `T${t.idx + 1}`}`,
          onclick: () => seek(t.idx, true),
        }, icon('play', 12))
        : h('span'));
    rows.set(t.idx, row);
    return row;
  }

  const scroll = h('div', { class: 'tx__scroll' });
  const track = h('div', { class: 'tx__track', 'aria-hidden': 'true' });
  let i = 0;
  while (i < turns.length) {
    const t = turns[i];
    if (collapsePre && t.phase === 'pre_operator') {
      const group = [];
      while (i < turns.length && turns[i].phase === 'pre_operator') { group.push(turns[i]); i += 1; }
      if (!group.some((g) => g.speaker === 'bot')) { group.forEach((g) => scroll.append(turnRow(g))); continue; }
      const first = group[0].idx;
      const last = group[group.length - 1].idx;
      const det = h('details', { class: 'botgroup' },
        h('summary', null,
          h('span', { class: 'turn__meta' }, h('span', { class: 'turn__no' }, rangeLabel(first, last))),
          h('span', null, h('b', null, 'Бот'), `, ${nTurns(group.length)}`),
          icon('chevronDown', 16)),
        group.map(turnRow));
      det.addEventListener('toggle', () => redraw());
      scroll.append(det);
      continue;
    }
    if (t.phase === 'hold' || t.phase === 'after_end') {
      const ph = t.phase;
      const group = [];
      while (i < turns.length && turns[i].phase === ph) { group.push(turns[i]); i += 1; }
      scroll.append(h('div', { class: `band band--${ph === 'hold' ? 'hold' : 'after'}` },
        h('div', { class: 'band__label' }, ph === 'hold' ? 'Клиент на удержании' : 'После завершения разговора'),
        group.map(turnRow)));
      continue;
    }
    scroll.append(turnRow(t));
    i += 1;
  }
  root.append(h('div', { class: 'tx__body' }, scroll, track));

  /* ---------- подсветка и метки ---------- */
  let pinned = null;
  let hover = null;
  let marked = [];

  /** Видимый элемент реплики: сама строка или заголовок свёрнутой группы бота. */
  function visibleEl(row) {
    const det = row.closest('details');
    if (det && !det.open) return det.querySelector('summary');
    return row;
  }

  function rowsIn(from, to) {
    const out = [];
    for (const [idx, r] of rows) if (idx >= from && idx <= to) out.push(r);
    return out;
  }

  function apply() {
    const sel = hover || pinned;
    for (const el of marked) el.classList.remove('is-hl', 'is-range');
    marked = [];
    if (sel) {
      if (sel.range) {
        for (const r of rowsIn(sel.range[0], sel.range[1])) { r.classList.add('is-range'); marked.push(r); }
      }
      for (const idx of sel.turns || []) {
        const r = rows.get(idx);
        if (!r) continue;
        r.classList.remove('is-range');
        r.classList.add('is-hl');
        marked.push(r);
        const v = visibleEl(r);
        if (v !== r) { v.classList.add('is-hl'); marked.push(v); }
      }
    }
    redraw();
  }

  function posOf(el) {
    const sr = scroll.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { top: r.top - sr.top + scroll.scrollTop, height: r.height };
  }

  let raf = 0;
  function redraw() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(drawMarks);
  }

  // метки проявляются только при смене выбора (не при каждой перерисовке от resize или прокрутки)
  let drawnKey = '';
  function selKey(sel) {
    return sel ? `${(sel.turns || []).join(',')}|${sel.range ? sel.range.join('-') : ''}` : '';
  }

  function drawMarks() {
    for (const m of [...track.querySelectorAll('.tx__mark:not(.tx__mark--play)')]) m.remove();
    const sel = hover || pinned;
    const key = selKey(sel);
    const animate = key !== drawnKey;
    drawnKey = key;
    let n = 0;
    const enter = (el) => {
      if (!animate) return el;
      el.classList.add('is-in');
      el.style.animationDelay = `${Math.min(n, 9) * 15}ms`;
      n += 1;
      return el;
    };
    const total = scroll.scrollHeight || 1;
    if (sel && sel.range) {
      const rr = rowsIn(sel.range[0], sel.range[1]).map(visibleEl);
      if (rr.length) {
        const a = posOf(rr[0]);
        const b = posOf(rr[rr.length - 1]);
        track.append(enter(h('button', {
          type: 'button', class: 'tx__mark tx__mark--range', tabindex: -1,
          style: { top: `${(a.top / total) * 100}%`, height: `${Math.max(0.6, ((b.top + b.height - a.top) / total) * 100)}%` },
          'data-tip': `Проверенный участок ${rangeLabel(sel.range[0], sel.range[1])}`,
          onclick: () => focusTurns(sel.range[0], sel.range[1]),
        })));
      }
    }
    if (sel) {
      for (const idx of sel.turns || []) {
        const r = rows.get(idx);
        if (!r) continue;
        const p = posOf(visibleEl(r));
        track.append(enter(h('button', {
          type: 'button', class: 'tx__mark', tabindex: -1,
          style: { top: `${((p.top + p.height / 2) / total) * 100}%` },
          'data-tip': turnText(idx),
          onclick: () => focusTurns(idx),
        })));
      }
    }
    drawPlayMark();
  }

  let playMark = null;
  function drawPlayMark() {
    if (!audio) return;
    const r = playingIdx !== null ? rows.get(playingIdx) : null;
    if (!r) { if (playMark) playMark.hidden = true; return; }
    if (!playMark) { playMark = h('span', { class: 'tx__mark tx__mark--play' }); track.append(playMark); }
    const p = posOf(visibleEl(r));
    playMark.hidden = false;
    playMark.style.top = `${((p.top + p.height / 2) / (scroll.scrollHeight || 1)) * 100}%`;
  }

  if (typeof ResizeObserver === 'function') new ResizeObserver(() => redraw()).observe(scroll);

  /* ---------- навигация ---------- */
  function reveal(row) {
    const det = row.closest('details');
    if (det && !det.open) det.open = true;
  }

  /** Прокрутить к реплике (или участку), после остановки прокрутки мигнуть один раз, в звонке перемотать запись. */
  let flashSeq = 0;
  function focusTurns(from, to = from, { seekAudio = true } = {}) {
    const inRange = rowsIn(from, to);
    const target = rows.get(from) || inRange[0];
    if (!target) return false;
    for (const r of inRange) reveal(r);
    reveal(target);
    const seq = ++flashSeq;
    const targets = inRange.length ? inRange : [target];
    for (const r of targets) r.classList.remove('flash');
    centerRow(target).then(() => {
      if (seq !== flashSeq) return;
      for (const r of targets) {
        void r.offsetWidth;
        r.classList.add('flash');
        r.addEventListener('animationend', () => r.classList.remove('flash'), { once: true });
      }
    });
    if (seekAudio && audio) seek(from, !audio.paused);
    redraw();
    return true;
  }

  /** Плавная прокрутка строки к центру; промис выполняется, когда прокрутка остановилась. */
  function centerRow(row) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const p = posOf(row);
    const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const top = Math.max(0, Math.min(max, p.top - scroll.clientHeight / 2 + p.height / 2));
    if (Math.abs(top - scroll.scrollTop) < 2) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      let timer = 0;
      const finish = (timedOut) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        scroll.removeEventListener('scrollend', onEnd);
        // плавная прокрутка не дошла (прервана или вкладка в фоне): доводим без анимации
        if (timedOut === true && Math.abs(scroll.scrollTop - top) > 4) scroll.scrollTop = top;
        resolve();
      };
      const onEnd = () => finish(false);
      if (!reduce && 'onscrollend' in window) scroll.addEventListener('scrollend', onEnd);
      timer = setTimeout(() => finish(true), reduce ? 30 : 900);
      scroll.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
    });
  }

  function keepVisible(row) {
    const p = posOf(row);
    if (p.top < scroll.scrollTop + 40 || p.top + p.height > scroll.scrollTop + scroll.clientHeight - 20) centerRow(row);
  }

  function turnText(idx) {
    const t = byIdx.get(idx);
    if (!t) return `T${idx + 1}: реплика вне фрагмента`;
    const txt = String(t.text || '').replace(/\s+/g, ' ');
    return `T${idx + 1} ${SPEAKERS[t.speaker] || t.speaker}: ${txt.length > 180 ? `${txt.slice(0, 180)}…` : txt}`;
  }

  return {
    el: root,
    focusTurns,
    setHover(sel) { hover = sel || null; apply(); },
    setPinned(sel) { pinned = sel || null; apply(); },
    turnText,
    has: (idx) => rows.has(idx),
    audio,
  };
}
