// Имя оператора из его первой реплики («меня зовут Алина», «Нұрланмын», «my name is Maya»).
// Тот же детерминированный разбор, что и в backend (cqa/operators.py); здесь он нужен как запасной путь,
// если сервер ещё не отдаёт поле operator. Никакой модели: только шаблоны.

const NAME = '([^\\s\\d_.,!?;:«»"\'()\\-][^\\s\\d_.,!?;:«»"\'()\\-]*(?:-[^\\s\\d_.,!?;:«»"\'()\\-]+)?)';
const PATTERNS = [
  { rx: '(?:^|[^\\p{L}])меня\\s+зовут\\s+' },
  { rx: '(?:^|[^\\p{L}])менің\\s+атым\\s+', kz: true },
  { rx: '(?:^|[^\\p{L}])my\\s+name\\s+is\\s+' },
  { rx: "(?:^|[^\\p{L}])i\\s*['’]\\s*m\\s+" },
  { rx: '(?:^|[^\\p{L}])i\\s+am\\s+' },
  { rx: '(?:^|[^\\p{L}])this\\s+is\\s+' },
  { rx: '(?:^|[^\\p{L}])мен\\s+', kz: true },
  { rx: '(?:^|[^\\p{L}])я\\s+' },
  { rx: '(?:^|[^\\p{L}])это\\s+' },
].map((p) => ({ ...p, re: new RegExp(p.rx + NAME, 'iu') }));
const KZ_SUFFIX = /(мын|мін|пын|пін|бын|бін)$/iu;
const STOP = new Set(['freedom', 'фридом', 'support', 'поддержка', 'вы', 'вам', 'вас', 'ваш', 'сіз', 'сізге', 'you']);

export const UNKNOWN = 'Не указано';

/** turns: реплики с speaker и phase (как отдаёт /api/dialogs/{id}). */
export function operatorName(turns) {
  const first = (turns || []).find((t) => t.speaker === 'operator' && (!t.phase || t.phase === 'main'));
  if (!first) return UNKNOWN;
  const text = String(first.text || '');
  if (/\[Имя скрыто\]/i.test(text)) return UNKNOWN;
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    let name = m[1].replace(/[.,!?;:«»"'()]/g, '');
    if (!name || name[0] !== name[0].toLocaleUpperCase() || name[0] === name[0].toLocaleLowerCase()) continue;
    if (p.kz && KZ_SUFFIX.test(name)) {
      const cut = name.replace(KZ_SUFFIX, '');
      if (cut.length >= 2) name = cut;
    }
    if (STOP.has(name.toLocaleLowerCase())) continue;
    return name;
  }
  // казахское «Нұрланмын» без «мен»: имя с суффиксом в начале реплики
  const kz = /(?:^|[^\p{L}])(\p{Lu}\p{Ll}+)(мын|мін|пын|пін|бын|бін)(?![\p{L}])/u.exec(text);
  if (kz && kz[1].length >= 2 && !STOP.has(kz[1].toLocaleLowerCase())) return kz[1];
  return UNKNOWN;
}

/** Ключ оператора для адреса профиля: без регистра, ё как е. «Не указано» даёт _unknown. */
export function operatorKey(name) {
  if (!name || name === UNKNOWN) return '_unknown';
  return String(name).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}
