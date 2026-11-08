// Единый набор иконок: сетка 16x16, линия 1.5, скругленные концы. Только там, где помогает сканированию.

const P = {
  overview: 'M2.75 2.75h4.5v4.5h-4.5zM8.75 2.75h4.5v4.5h-4.5zM2.75 8.75h4.5v4.5h-4.5zM8.75 8.75h4.5v4.5h-4.5z',
  user: 'M8 7.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5zM2.75 13.75c.6-2.5 2.7-4 5.25-4s4.65 1.5 5.25 4',
  keyboard: 'M2.25 4.25h11.5v7.5H2.25zM4.75 6.75h.01M7 6.75h.01M9 6.75h.01M11.25 6.75h.01M5.25 9.25h5.5',
  print: 'M4.25 5.75V2.75h7.5v3M4.25 11.25h-1.5v-5.5h10.5v5.5h-1.5M4.25 9.25h7.5v4h-7.5z',
  link: 'M6.75 9.25l2.5-2.5M7.5 4.75l1-1a2.47 2.47 0 0 1 3.5 3.5l-1 1M8.5 11.25l-1 1a2.47 2.47 0 0 1-3.5-3.5l1-1',
  panel: 'M2.75 2.75h10.5v10.5H2.75zM6.25 2.75v10.5',
  swap: 'M4.5 5.25h8M10.25 3l2.25 2.25-2.25 2.25M11.5 10.75h-8M5.75 8.5L3.5 10.75 5.75 13',
  more: 'M3.75 8h.01M8 8h.01M12.25 8h.01',
  filter: 'M2.5 3.25h11l-4.25 5v4.25l-2.5 1.5V8.25z',
  select: 'M2.75 2.75h10.5v10.5H2.75zM5.25 8l2 2 3.5-4',
  sheet: 'M4 2.75h5.5l2.5 2.5v8H4zM9.25 2.75v2.75h2.75M6 8.25h4M6 10.75h4',
  flag: 'M3.75 14V2.75M3.75 3.25h8.5L10.5 6.5l1.75 3.25h-8.5',
  undo: 'M5.5 3.75L2.75 6.5 5.5 9.25M3 6.5h6.25a3.5 3.5 0 0 1 0 7H7',
  spark: 'M8 2.25v3M8 10.75v3M2.25 8h3M10.75 8h3M4 4l1.75 1.75M10.25 10.25L12 12M12 4l-1.75 1.75M5.75 10.25L4 12',
  dialogs: 'M2.75 3.25h10.5v7.5h-6l-3 2.5v-2.5h-1.5z',
  phone: 'M3.75 2.75h1.75l1.25 2.75-1.5 1.25a7 7 0 0 0 3.25 3.25l1.25-1.5 2.75 1.25v1.75a1 1 0 0 1-1 1A10.25 10.25 0 0 1 2.75 3.75a1 1 0 0 1 1-1z',
  appeals: 'M3.75 14V2.75M3.75 3.25h8.5L10.5 6.5l1.75 3.25h-8.5',
  checklists: 'M7 4h6.5M7 8h6.5M7 12h6.5M2.5 4l1 1 1.75-2M2.5 8l1 1 1.75-2M2.5 12l1 1 1.75-2',
  calibration: 'M8 13.75a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5zM8 10.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5zM8 8h.01',
  settings: 'M2.5 4.5h5.5M11.5 4.5h2M2.5 11.5h2M8 11.5h5.5M9.75 2.75v3.5M6.25 9.75v3.5',
  play: 'M5.25 3.4v9.2c0 .4.43.64.77.43l7.1-4.6a.5.5 0 0 0 0-.86L6.02 2.97a.5.5 0 0 0-.77.43z',
  pause: 'M4.5 3.25h2.25v9.5H4.5zM9.25 3.25h2.25v9.5H9.25z',
  search: 'M7.25 12a4.75 4.75 0 1 0 0-9.5 4.75 4.75 0 0 0 0 9.5zM10.75 10.75L13.75 13.75',
  sort: 'M5.25 6.25L8 3.5l2.75 2.75M5.25 9.75L8 12.5l2.75-2.75',
  sortAsc: 'M5.25 9.75L8 7l2.75 2.75',
  sortDesc: 'M5.25 6.25L8 9l2.75-2.75',
  close: 'M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5',
  external: 'M9.5 2.75h3.75V6.5M13.25 2.75L7.5 8.5M11.75 9.5v3a.75.75 0 0 1-.75.75H3.5a.75.75 0 0 1-.75-.75V5a.75.75 0 0 1 .75-.75h3',
  chevronLeft: 'M9.75 3.5L5.25 8l4.5 4.5',
  chevronRight: 'M6.25 3.5L10.75 8l-4.5 4.5',
  chevronDown: 'M3.5 6l4.5 4.5L12.5 6',
  chevronUp: 'M3.5 10L8 5.5l4.5 4.5',
  plus: 'M8 3.25v9.5M3.25 8h9.5',
  copy: 'M5.75 5.75h7.5v7.5h-7.5zM10.25 5.75v-3h-7.5v7.5h3',
  trash: 'M2.75 4.5h10.5M6.25 4.5V2.75h3.5V4.5M4.25 4.5l.6 8.75h6.3l.6-8.75',
  upload: 'M8 10.25V2.75M5.25 5.5L8 2.75l2.75 2.75M2.75 10.25v2.5c0 .41.34.75.75.75h9c.41 0 .75-.34.75-.75v-2.5',
  download: 'M8 2.75v7.5M5.25 7.5L8 10.25l2.75-2.75M2.75 10.25v2.5c0 .41.34.75.75.75h9c.41 0 .75-.34.75-.75v-2.5',
  logout: 'M6.25 13.25H3.5a.75.75 0 0 1-.75-.75v-9c0-.41.34-.75.75-.75h2.75M10.25 10.75L13 8l-2.75-2.75M13 8H6.25',
  check: 'M3.25 8.5l3 3 6.5-7',
  alert: 'M8 2.5l5.75 10.25H2.25zM8 6.5v3M8 11.25v.01',
  gross: 'M5.6 2.25h4.8l3.35 3.35v4.8l-3.35 3.35H5.6L2.25 10.4V5.6zM8 5.25v3.25M8 10.75v.01',
  eye: 'M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  eyeOff: 'M6.4 3.95A6 6 0 0 1 8 3.75c4 0 6.25 4.25 6.25 4.25a11.5 11.5 0 0 1-1.7 2.2M10.2 11.8a5.8 5.8 0 0 1-2.2.45C4 12.25 1.75 8 1.75 8a11.4 11.4 0 0 1 2.45-2.9M6.6 6.6a2 2 0 0 0 2.8 2.8M2.75 2.75l10.5 10.5',
};

const FILLED = new Set(['play', 'pause']);
const NS = 'http://www.w3.org/2000/svg';

export function icon(name, size = 16, cls = '') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon ${cls}`.trim());
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', P[name] || P.alert);
  if (FILLED.has(name)) {
    path.setAttribute('fill', 'currentColor');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', name === 'more' ? '2.25' : '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(path);
  return svg;
}
