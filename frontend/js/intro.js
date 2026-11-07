// Заставка при входе в сервис: логотип Freedom по центру на фоне сайдбара проявляется, короткая пауза,
// затем заставка растворяется и открывает приложение. Один раз за сессию браузера, пропускается
// кликом или любой клавишей, при prefers-reduced-motion не показывается.
// Отключается флагом window.CQA_CONFIG.intro = false (например, во встраивании в Dynamics 365).
// Тайминги в CSS-переменных --intro-in, --intro-hold, --intro-out (css/app.css).

const FLAG = 'cqa.introShown';

function cssMs(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return v.endsWith('ms') ? n : n * 1000;
}

/** Нужно ли показывать заставку сейчас (и пометить сессию, если да). */
export function shouldPlayIntro() {
  const cfg = window.CQA_CONFIG || {};
  if (cfg.intro === false) return false;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  try {
    if (sessionStorage.getItem(FLAG)) return false;
    sessionStorage.setItem(FLAG, '1');
  } catch { /* без sessionStorage показываем один раз за загрузку страницы */ }
  return true;
}

/**
 * Показывает заставку поверх страницы. Возвращает промис, который выполняется, когда заставка снята.
 * onCovered вызывается, как только экран закрыт: под заставкой можно раскладывать приложение.
 */
export function playIntro({ onCovered } = {}) {
  return new Promise((resolve) => {
    const img = document.createElement('img');
    img.className = 'intro__logo';
    img.src = 'assets/freedom-logo-light.svg';
    img.alt = '';
    img.width = 320;
    img.height = 72;
    const overlay = document.createElement('div');
    overlay.className = 'intro';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.append(img);
    document.body.append(overlay);

    const tCover = cssMs('--intro-cover', 150);
    const tIn = cssMs('--intro-in', 300);
    const tHold = cssMs('--intro-hold', 400);
    const tOut = cssMs('--intro-out', 250);
    const t0 = performance.now();
    let leaving = false;
    let holdTimer = 0;

    const leave = () => {
      if (leaving) return;
      if (performance.now() - t0 < tCover) { setTimeout(leave, tCover - (performance.now() - t0) + 16); return; }
      leaving = true;
      clearTimeout(holdTimer);
      overlay.removeEventListener('pointerdown', skip);
      window.removeEventListener('keydown', skip, true);
      overlay.classList.add('is-out');
      setTimeout(() => { overlay.remove(); resolve(); }, tOut + 20);
    };
    function skip(e) {
      if (e.type === 'keydown') { e.preventDefault(); e.stopPropagation(); }
      leave();
    }
    overlay.addEventListener('pointerdown', skip);
    window.addEventListener('keydown', skip, true);

    // фон заставки закрывает экран за --intro-cover; после этого под ним раскладывается приложение
    setTimeout(() => { if (onCovered) { try { onCovered(); } catch (err) { console.error(err); } } }, tCover);
    holdTimer = setTimeout(leave, Math.max(tIn, tCover) + tHold);
  });
}
