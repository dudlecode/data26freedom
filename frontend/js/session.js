// Текущий пользователь и права ролей. Права дублируют серверные правила (cqa/auth.py):
// интерфейс прячет или блокирует действия, сервер всё равно проверяет роль и вернёт 403.

export const ROLE_LABEL = { operator: 'Оператор', supervisor: 'Супервайзер', reviewer: 'Проверяющий' };

// Три роли. Супервайзер ведёт и чек-лист с настройками; решение по апелляции только у
// проверяющего, чтобы оценку и спор по ней не решал один человек.
const RULES = {
  evaluate: ['supervisor'],
  import: ['supervisor'],
  appeal: ['operator', 'supervisor'],
  review: ['reviewer'],
  manage: ['supervisor'],
  analytics: ['supervisor', 'reviewer'],
};

export const ROLES = [
  { id: 'operator', label: 'Оператор', duty: 'Смотрит свои оценки и оспаривает их' },
  { id: 'supervisor', label: 'Супервайзер', duty: 'Оценивает диалоги, ведёт чек-лист и настройки' },
  { id: 'reviewer', label: 'Проверяющий', duty: 'Решает апелляции' },
];

/** Стартовый экран роли: оператору нужны его оценки, остальным обзор команды. */
export function landing(u = user) {
  return u && u.role === 'operator' ? '#/dialogs' : '#/overview';
}

let user = null;

export function setUser(u) { user = u || null; }
export function getUser() { return user; }
export function hasRole(role) { return !!(user && user.role === role); }

export function can(action) {
  const roles = RULES[action];
  return !!(user && roles && roles.includes(user.role));
}

/** Текст подсказки для недоступного действия: «Доступно роли Супервайзер». */
export function roleHint(action) {
  const roles = RULES[action] || [];
  const names = roles.map((r) => ROLE_LABEL[r]);
  return names.length === 1 ? `Доступно роли ${names[0]}` : `Доступно ролям: ${names.join(', ')}`;
}

/**
 * Применяет право к элементу управления: если действие недоступно, элемент блокируется,
 * а подсказка с ролью вешается на обёртку (у disabled-кнопки нет событий мыши).
 */
export function gate(el, action) {
  if (can(action)) return el;
  el.disabled = true;
  el.removeAttribute('data-tip');
  const wrap = document.createElement('span');
  wrap.className = 'gate';
  wrap.style.display = 'inline-flex';
  wrap.tabIndex = 0;
  wrap.dataset.tip = roleHint(action);
  wrap.append(el);
  return wrap;
}
