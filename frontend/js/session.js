// Текущий пользователь и права ролей. Права дублируют серверные правила (cqa/auth.py):
// интерфейс прячет или блокирует действия, сервер всё равно проверяет роль и вернёт 403.

const ROLE_LABEL = { operator: 'Оператор', supervisor: 'Супервайзер', reviewer: 'Проверяющий', admin: 'Администратор' };

const RULES = {
  evaluate: ['supervisor', 'admin'],
  import: ['supervisor', 'admin'],
  appeal: ['operator', 'supervisor', 'admin'],
  review: ['reviewer', 'admin'],
  admin: ['admin'],
};

let user = null;

export function setUser(u) { user = u || null; }
export function getUser() { return user; }
export function hasRole(role) { return !!(user && user.role === role); }

export function can(action) {
  const roles = RULES[action];
  return !!(user && roles && roles.includes(user.role));
}

/** Текст подсказки для недоступного действия: «Доступно ролям: Супервайзер, Администратор». */
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
