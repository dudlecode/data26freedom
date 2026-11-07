# Результаты для организаторов

Формат - «CQA Student Guide Appendix: Как сдать результаты», JSON 1.0.

| Файл | Набор |
|---|---|
| `dev/results.json` | DEV: 60 чатов + 5 звонков (65 записей) |
| `prod/results.json` | контрольный набор: ровно 10 записей, включая ошибки |

Файлы собираются кодом из базы CQA (`backend/cqa/results.py`) и перед записью проверяются по правилам
приложения: все 8 критериев с кодами `contact … critical`, типы значений (`true` / `false` / `null`, ступени шкалы),
`evidence_turns` с 1 по исходному транскрипту, `final_score` 0-100 с двумя знаками, `critical_flag` = `critical`,
без повторов ID, неоценённые диалоги - `status: "error"` с причиной.

## DEV

```bash
cd backend
../.venv/bin/python -m cqa.results --group DEV --evaluate --out ../results/dev/results.json
```

## Контрольный час (сервер CQA запущен)

1. Получить `group_id` контрольного набора от организаторов (за час до стоп-кода).
2. Если по заданию меняется критерий - сохранить новую версию чек-листа в интерфейсе (**Чек-листы**), она станет активной.
   Для нового критерия задайте в его JSON поле `export_id` (код из приложения), иначе в файл пойдёт его ID.
3. Одна команда - загрузка из API, оценка, проверка формата, запись файла:

```bash
cd backend
../.venv/bin/python -m cqa.results --group <group_id> --fetch --evaluate --expect 10 --out ../results/prod/results.json
```

4. `git add results && git commit -m "results: prod" && git push` - без push результат не засчитывается.

То же из интерфейса: **Диалоги** → фильтр группы → кнопка **results.json** (проверяет формат и скачивает файл).
