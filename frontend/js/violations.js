// Вид грубого нарушения по тексту обоснования и обоснование без повтора заголовка.
// Общие для списка грубых ошибок и карточки диалога.

export const TYPES = [
  { id: 'insult', label: 'Оскорбление клиента', mark: /вид\s*\(а\)/i, rx: /оскорб|униж|насмеш|издев|хамств/i },
  { id: 'paid', label: 'Услуга в обход компании', mark: /вид\s*\(б\)/i, rx: /обход|лично|частн|платн/i },
  { id: 'disclosure', label: 'Раскрытие конфиденциальной информации', mark: /вид\s*\(в\)/i, rx: /конфиденц|раскры|идентификац/i },
];
export const FALLBACK = { id: 'other', label: 'Грубое нарушение' };

/** Вид нарушения по тексту обоснования: сначала явная пометка «вид (а/б/в)», затем ключевые слова. */
export function violationType(reasoning) {
  const s = String(reasoning || '');
  return TYPES.find((t) => t.mark.test(s)) || TYPES.find((t) => t.rx.test(s)) || FALLBACK;
}

/**
 * Обоснование без повтора заголовка: убирает формулу «Грубые ошибки: Да, вид (б): <вид нарушения>.»,
 * если после неё есть собственно объяснение. Полный текст остаётся в карточке диалога.
 */
export function reasonBody(reasoning, type) {
  const src = String(reasoning || '').trim();
  let r = src.replace(/^\s*Грубые ошибки\s*:\s*Да[,.:]?\s*(?:выявлен\s+)?/i, '');
  r = r.replace(/^вид\s*(?:\([абв]\)|[абв](?=[\s.:,]))\s*[:.,]?\s*/i, '');
  const cut = /[.!?]\s+(?=[А-ЯЁA-Z«TТ])/.exec(r);
  if (cut && type && type.rx && type.rx.test(r.slice(0, cut.index))) {
    const rest = r.slice(cut.index + cut[0].length).trim();
    if (rest) r = rest;
  }
  r = r.replace(/\s*\(\s*вид\s*[абв]\s*\)/gi, '').replace(/,?\s*вид\s*\([абв]\)\s*:?/gi, '').trim();
  if (!r) return src;
  return r.charAt(0).toUpperCase() + r.slice(1);
}

