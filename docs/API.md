# CQA: контракт API (FastAPI, префикс `/api`, JSON)

Сервер: `backend/cqa/app.py`, запуск `python -m cqa` из `backend/` (uvicorn, порт `CQA_PORT`, по умолчанию 8000). Статика `frontend/` отдаётся с `/`. Нужен вход: см. раздел «Вход и роли» в конце. CORS выключен; для встраивания с другого origin: `CQA_CORS_ORIGINS` (через запятую).
Ошибки: HTTP 4xx/5xx с телом `{"detail": "текст по-русски"}`; ошибки валидации чек-листа, 422 `{"detail": {"errors": ["..."]}}`.

## Уже реализовано (не переписывать, только использовать)
- `cqa/preprocess.py`, `prepare(record) -> Prepared` (turns: `Turn.to_dict()` = `{idx, timestamp, speaker, text, t, clock, phase, audio_offset, boilerplate}`; `phase` ∈ `pre_operator|main|hold|after_end`), `facts` dict, `render_for_llm(prepared)`.
- `cqa/scoring.py`, `allowed_values(c)`, `normalize_value(c, v)`, `compute(checklist, values) -> score`, `validate_checklist(cfg) -> [errors]`. Значения: `"YES"|"NO"|"NA"` или строка ступени шкалы (`"20"`).
- `cqa/prompting.py`, `build_system/build_schema/build_user`, `build_appeal_system/build_appeal_schema/build_appeal_user`.
- `cqa/providers.py`, `make_provider(settings)` > объект с `async complete_json(system, user, schema) -> RunResult(data, model, usage, duration_ms, cost_usd, provider)`; `ProviderError`.
- `cqa/db.py`, SQLite-хелперы и схема таблиц `dialogs, checklists, evaluations, appeals, settings`.
- `cqa/config.py`, пути, env, `DEFAULT_SETTINGS`, `ANTHROPIC_MODELS`, `cost_usd`.
- `cqa/default_checklist.json`, исходный чек-лист (сидится как версия 1, активная, при пустой таблице).

## Объект Score (`scoring.compute`)
```
{ total: float|null, max_total, applicable_weight, redistribution_factor,
  criteria: { cid: {value, weight, applicable, effective_weight, points|null, is_flag?} },
  sections: [{id, name, points, max_points, percent|null}],
  gross_error: bool, gross_criteria: [cid] }
```

## Эндпоинты

### Служебные
- `GET /api/health` > `{ok, has_anthropic_key, source_configured, version}`
- `GET /favicon.ico` > знак Freedom (SVG), без сессии.
- `GET /api/settings` > `{settings, models: ANTHROPIC_MODELS, efforts: [...], providers: [{id:"anthropic",label}, {id:"openai_compat",label}], has_anthropic_key}`
- `PUT /api/settings` (частичный объект) > `{settings}`. Ключи API в настройках не хранятся (только .env).
- `GET /api/stats?group_id=&language=&channel=&q=` > `{dialogs, evaluated, avg_total, gross_count, split_count, not_evaluated, active, error_count, with_open_appeal, open_appeals, total_cost_usd, by_language: {RU:{count,avg}}, by_criterion: {cid: {name, distribution: {value: n}}}}`. Фильтры те же, что у `GET /api/dialogs`, поэтому сводка совпадает с тем, что видно в списке. Считается по последней завершённой оценке каждого диалога; итог = `final_total`, даже если он null. `split_count`: диалоги, где прогоны модели разошлись хотя бы по одному критерию. `not_evaluated`, `active` (в очереди или оценивается), `error_count`, `with_open_appeal` считаются по последней попытке оценки. `open_appeals` и `total_cost_usd` общие по базе.

### Данные
- `POST /api/datasets/fetch` `{group_id, source_url?}` > `{group_id, imported, ids, renamed}`. Берёт `CQA_SOURCE_URL` (или `source_url`), подменяет query-параметр `group_id`, GET, проверяет `isSuccess`, upsert в `dialogs`.
- `POST /api/dialogs/import` `{group_id?, payload}` > `{imported, ids, group_id, renamed}`. Группа: явный `group_id` > `dataset_group_id` из ответа организаторов > `UPLOAD`. `payload`: ответ API организаторов целиком, или `data`, или массив записей, или одна запись; либо `{"text": "...", "conversation_id"?, "channel"?, "language"?}`, свободный текст, строки вида `[00:02] operator: текст` / `Оператор: текст` / `client: ...` (роли RU/EN: клиент/оператор/бот/система). Роли в JSON-записях (`Оператор`, `agent`, `customer`, …) приводятся к `operator|client|bot|system` той же таблицей. ID очищаются для URL (`/ \ ? # %` и пробелы > `-`); запись без реплик отклоняется (400).
  Повторный импорт: если диалог с таким ID уже оценён, а текст другой, новая версия сохраняется под ID `<id>-2` (`-3`, …), прежние оценки не трогаются; `renamed = {старый: новый}`. Тот же текст: обычный upsert.
- `GET /api/dialogs?group_id=&language=&channel=&q=` > `{items: [DialogRow], groups: ["DEV", ...]}`. `q` ищет без учёта регистра (ё = е) по ID, имени оператора и тексту реплик.
  `DialogRow = {id, group_id, channel, language, turns, imported_at, operator, operator_key, latest: EvalSummary|null}`
- `GET /api/dialogs/{id}` > `{dialog: {id, group_id, channel, language, has_audio, operator, operator_key}, turns: [Turn], facts, evaluations: [EvalSummary] (новые первыми)}`

Имя оператора (`cqa/operators.py`) берётся без модели из первой реплики оператора в основной фазе: «меня зовут Алина», «мен Нұрланмын», «I'm Maya» и т. п. Скрытое имя («[Имя скрыто]») или реплика без представления дают `operator: "Не указано"`, `operator_key: "_unknown"`. `operator_key` = имя в нижнем регистре, ё = е; варианты на разных языках не склеиваются.

`EvalSummary = {id, dialog_id, status, error, checklist_id, checklist_name, checklist_version, total, final_total, gross, min_agreement, open_appeals, decided_appeals, model, cost_usd, duration_ms, created_at, finished_at}`

### Чек-листы (версионирование: каждое сохранение = новая версия)
- `GET /api/checklists` > `{items: [{id, name, version, is_active, note, created_at, criteria_count, total_weight}]}`
- `GET /api/checklists/active` и `GET /api/checklists/{id}` > `{id, name, version, is_active, note, created_at, config}`
- `POST /api/checklists/validate` `{config}` > `{errors: [str], issues: [Issue], total_weight}`.
  `Issue = {message, criterion_index (с 0, по порядку в присланном config) | null, criterion_id | null, field: name|criteria|id|code|type|weight|description|na_condition|section|scale | null, step_index (с 0) | null}`; `errors` = `issues[].message` в том же порядке, без повторов.
  Проверки: название чек-листа; у критерия ID и код уникальны (после обрезки пробелов), есть название, тип binary|scale|flag, вес конечный и неотрицательный, задано правило (`description`); если разрешён N/A, указано условие (`na_condition`); секция существует; у шкалы минимум 2 ступени, у каждой ступени целое неотрицательное число баллов без повторов, верхняя > 0; хотя бы один критерий с весом > 0.
- `POST /api/checklists` `{config, note?, activate?: true}` > созданная версия (version = max+1). 422 `{"detail": {"errors": [...], "issues": [...]}}` при ошибках. При сохранении критерии одной секции собираются вместе в порядке секций (внутри секции порядок сохраняется), поэтому критерий, добавленный в конец списка, встаёт к своей секции.
- `POST /api/checklists/simulate` `{config, group_id?}` > влияние правки на уже оценённые диалоги, без вызова модели: финальные значения последней завершённой оценки каждого диалога пересчитываются новым чек-листом.
  ```
  { errors, issues, group_id, dialogs,
    before: {avg_final, gross}, after: {avg_final, gross},
    changed_count, changed: [{dialog_id, evaluation_id, operator, operator_key, before, after, delta, gross_before, gross_after}],
    new_criteria: [cid], removed_criteria: [cid] }
  ```
  `changed` отсортирован по |delta| убыв. Критерий, которого в оценке нет (новый или со сменённым типом), считается N/A до переоценки, его вес перераспределяется; значения шкалы приводятся к ближайшей новой ступени. При ошибках в config ответ 200 с заполненными `errors` и `issues`, `before`/`after` = null.
- `POST /api/checklists/{id}/activate` > `{ok: true}`
- `GET /api/checklists/default` > исходный чек-лист из файла (для «сбросить к исходному»).

Формат `config` = как `default_checklist.json`: `{name, description, rounding, gross_error_zeroes_total, general_guidance, sections:[{id,name}], criteria:[{id, code, name, section, type: binary|scale|flag, weight, na_allowed, description, na_condition, scale:[{value,label}], guidance}]}`.

### Оценки
- `POST /api/evaluations` `{dialog_ids: [...], checklist_id?: активный, settings?: частичный override, only_missing?: false}` > `{evaluation_ids: [...], skipped: [dialog_id]}`. `only_missing: true` пропускает диалоги, у которых уже есть завершённая или идущая оценка этой версией чек-листа (кнопка «Оценить неоценённые» не тратит деньги повторно). Диалог, у которого оценка уже в очереди или идёт, никогда не запускается второй раз: он попадает в `skipped`, а если запрос состоял только из таких диалогов, ответ 409 (то же для `POST /api/evaluations/{id}/rerun`). Создаёт строки `status=queued`, обрабатывает в фоне (asyncio). Лимит параллельности: ГЛОБАЛЬНАЯ настройка `concurrency` (перечитывается при каждом запуске задачи; override `concurrency` в запросе не действует).
- `GET /api/evaluations/estimate?dialogs=N&votes=&model=&provider=` > `{dialogs, votes, model, provider, per_dialog_usd, total_usd, basis: {evaluations, first_run_usd, extra_run_usd, by_runs: {"3": usd}, source: history|default|local}}`. Оценка стоимости по фактическим расходам завершённых оценок текущей модели (кэш промпта учтён): средняя цена оценки с тем же числом прогонов, иначе первый прогон + (votes-1) × последующий. Без истории: $0,08 + $0,016 за каждый следующий прогон. Для локальной модели 0. `votes` по умолчанию из настроек, 1..9. `model` и `provider` считают стоимость для ещё не сохранённых настроек (экран «Настройки»).
- `GET /api/evaluations?ids=1,2,3` или `?status=active` (queued+running) > `{items: [EvalSummary]}`
- `GET /api/evaluations/{id}` > `EvalFull`:
```
{ ...EvalSummary, settings, usage,
  checklist: {id, name, version, config},
  result: { client_request,
            criteria: { cid: { value, reasoning, evidence_turns: [int], checked_range: [from,to]|null,
                               na_reason, votes: [value...], agreement: 0..1 } },
            score: Score,
            runs: [ {model, provider, usage, duration_ms, cost_usd, values: {cid: value}, error?} ] },
  final: { values: {cid: value}, score: Score, overrides: { cid: {appeal_id, from, to, reason} } },
  appeals: [Appeal] }
```
- `POST /api/evaluations/{id}/rerun` > `{evaluation_id}` новая оценка того же диалога тем же чек-листом. Решения по апелляциям прежней оценки в новую не переносятся (см. `Appeal.is_latest_evaluation`).
- `GET /api/evaluations/{id}/coaching` > разбор для оператора, без модели (`cqa/coaching.py`). Только для завершённой оценки, иначе 409.
  ```
  { dialog: {id, channel, language, operator, operator_key},
    evaluation: {id, checklist_id, checklist_name, checklist_version, finished_at, total, final_total, gross},
    items: [{criterion_id, code, name, type, value, value_label, step_label, points, max_points, lost,
             status: fail|partial|gross, reasoning, reason, violation: {id, label}|null,
             quotes: [{idx, turn: "T8", speaker, clock, audio_offset, text}],
             checked_range: [from, to]|null, override: {appeal_id, from, from_label, to, to_label, reason}|null,
             appeal: {id, status, decision}|null}],
    improve: [{criterion_id, code, name, text}], passed_count, applicable_count, generated_at, plain_text }
  ```
  В `items` только невыполненные критерии по финальным значениям: сначала грубая ошибка, затем по потерянным баллам. `quotes`: до 3 реплик-доказательств, текст до 280 символов; `checked_range` заполнен, когда реплик нет. `reason`: обоснование без повтора «Критерий: Нет.». `improve` (до 4): поле критерия `coaching`, если задано; иначе для бинарного «Ожидается: » + правило после «Да:»; для шкалы «Сейчас: <ступень>. Ожидается: <верхняя ступень>.»; для грубой ошибки «Недопустимо: <вид нарушения>.». `plain_text`: тот же разбор простым текстом для мессенджера или письма. Поле `coaching` в критерии необязательное, промпт его не читает.

Алгоритм оценки (`cqa/evaluator.py`):
1. `prepare(record)`, `render_for_llm`, промпт и схема из `checklist.config`.
2. `votes` прогонов: первый отдельно (прогрев кэша промпта), остальные параллельно. Ошибки отдельных прогонов не валят оценку, если есть хотя бы один успешный.
3. Агрегация по критерию: `normalize_value` каждого голоса > большинство; ничья по шкале > медиана (snap к ступени), ничья по бинарному > значение первого прогона. `agreement` = доля голосов за итог. Обоснование/доказательства: из первого прогона с итоговым значением; если за медиану никто не голосовал, из прогона с ближайшим голосом, с пометкой «Итог, медиана голосов (…)». `evidence_turns` фильтруются по существующим индексам; `checked_range` = `[from,to]` если оба ≥0 и валидны, иначе null.
4. `scoring.compute` > `score` (баллы считаются точными дробями, округление half-up только в конце); `final` = копия (без апелляций). `total`, `final_total`, `gross`, `cost_usd` (сумма), `usage` (сумма), `duration_ms` (wall clock).

### Апелляции
`Appeal = {id, evaluation_id, dialog_id, criterion_id, criterion_name, comment, author, status: open|decided, original: {value, reasoning, evidence_turns, points}, ai_opinion: {value, reasoning, evidence_turns, appeal_valid, recommendation, model, cost_usd, requested_at, requested_by}|null, decision: confirmed|changed|null, decision_value, decision_reason, reviewer, created_at, decided_at, total_before, total_after, total_delta, original_value_label, decision_value_label, latest_evaluation_id, is_latest_evaluation}`
`total_delta` = `total_after - total_before` у рассмотренной апелляции. `*_value_label`: «Да», «Нет», «N/A» или число ступени. `latest_evaluation_id`: последняя завершённая оценка диалога; `is_latest_evaluation: false` значит, что диалог переоценён и решение относится к более старой оценке.
- `POST /api/evaluations/{id}/appeals` `{criterion_id, comment, author?}` > `Appeal` (одна открытая апелляция на критерий оценки; иначе 409).
- `GET /api/appeals?status=open|decided|all&mine=0|1&dialog_id=&sort=newest|oldest` > `{items: [Appeal + {dialog_channel, dialog_language}]}`. `mine=1`: апелляции, поданные текущим пользователем (по имени в сессии). `sort=oldest`: дольше всех ждущие сверху.
- `GET /api/appeals/{id}` > `{appeal, evaluation: EvalSummary, criterion: <config критерия>, fragment: [Turn], has_audio}`, `fragment`: реплики вокруг `evidence_turns`/`checked_range` (±2), либо вся операторская часть, если доказательств нет.
- `POST /api/appeals/{id}/ai-review` > `{appeal}` с заполненным `ai_opinion` (повторная оценка ОДНОГО критерия с учётом комментария). Только для открытой апелляции (иначе 409); любая ошибка модели > 502 с текстом по-русски.
- `POST /api/appeals/{id}/preview` `{value}` > `{total_before, total_after, gross_before, gross_after}`: каким станет итог при решении «изменить на value». Ничего не записывает, модель не вызывает. Роль `reviewer`.
- `POST /api/appeals/{id}/decide` `{action: "confirm"|"change", value?, reason, reviewer?}` > `{appeal, final_total}`. `change` требует допустимое `value`, `reason` обязателен. Пересчитывает `final` и `final_total` оценки (атомарно под блокировкой БД). Если решение вернуло значение ИИ, `overrides` по критерию не остаётся.

### Звук
- `GET /api/audio/{dialog_id}` > 302 на mp3. `audio_url` диалога отдаёт HTML-плеер; сервер скачивает его, достаёт `<source src="...">` (подписанная ссылка ~1 час), кэширует ~50 минут.
- `GET /api/audio/{dialog_id}/info` > `{mp3_url, player_url}`.

### Экспорт и калибровка
- `GET /api/export/results?group_id=&checklist_id=&team_name=&download=1` > `results.json` в формате организаторов 1.0; заголовки `X-CQA-Validation-Errors` и `X-CQA-Groups`. Без `group_id` в файл идут все группы, кроме ручных тестовых загрузок `UPLOAD` (если других групп нет, то все).
- `GET /api/export/results/check?group_id=&checklist_id=` > `{groups, count, ok, errors_in_results, model, team_name, validation_errors}`, те же правила выбора групп.
- `GET /api/export?group_id=&format=csv|json` > файл: по каждому диалогу последняя завершённая оценка, итог, финальный итог, грубая ошибка, значение и баллы по каждому критерию.
- `GET /api/calibration?group_id=` > сравнение последних оценок с `eval/reference_dev.json` (если файл есть): `{available, n_dialogs, overall_exact, total_mae, by_criterion: {cid: {name, exact, n, confusion: {"ref->pred": n}}}, dialogs: [{id, ref_total, pred_total, diffs: [{cid, ref, pred}]}]}`. `ref_total` считается `scoring.compute` по эталонным значениям тем же чек-листом.

### Обзор и операторы (только чтение, любая роль, без вызова модели)
Источник: последняя завершённая оценка каждого диалога, финальные значения с учётом апелляций. Столбцы: критерии активного чек-листа; критерия, которого нет в версии старой оценки, в строке нет (`status: "none"`). Баллы строки всегда посчитаны по версии, которой диалог оценивали: `checklist.evaluated_versions` перечисляет эти версии, `mixed: true`, если среди них есть не активная. У колонки `evaluated` = число строк со значением (0 у нового критерия до переоценки), `scored_weights` = веса критерия в версиях строк, `weight_changed: true`, если они отличаются от веса в активной версии.
`Cell = {v, label, status: pass|partial|fail|na|none, f, pts, w, lost, split, overridden, appeal: {id, status, decision}|null}`. `f`: доля веса (ступень / верхняя ступень, 1 или 0 у бинарного, у флага 1 = грубой ошибки нет), null для N/A. `pts`, `w`: баллы и вес после перераспределения (у флага null). `lost` = `w - pts`. `split`: прогоны модели разошлись.

- `GET /api/overview?group_id=&language=&channel=` >
  ```
  { filters: {group_id, language, channel}, options: {groups, languages, channels},
    checklist: {id, version, name, evaluated_versions: [{checklist_id, version, dialogs}], mixed},
    kpi: {dialogs, evaluated, not_evaluated, avg_final, gross_dialogs, open_appeals, split_dialogs, share_85_plus},
    columns: [{id, code, name, type, weight, max, section, evaluated, scored_weights, weight_changed}],
    rows: [{dialog_id, evaluation_id, checklist_version, group_id, language, channel, operator, operator_key,
            total, final_total, gross, open_appeals, min_agreement, finished_at, weakest_cid, cells: {cid: Cell}}],
    weak_spots: [{criterion_id, code, name, type, weight, applicable, fail, partial, pass, na, fail_rate, avg_points_lost, worst_dialogs}],
    operators: [Operator], unnamed: Operator|null,
    recent_gross: [GrossItem], gross_total }
  ```
  `rows`: худшие сверху (`final_total` по возрастанию). `weak_spots`: по `fail_rate` = (fail + partial) / applicable убыв., затем по `avg_points_lost`; флаг входит, у него `avg_points_lost` null. `worst_dialogs`: до 5 диалогов с наибольшей потерей баллов. `recent_gross`: до 5 последних грубых ошибок, `gross_total`: всего.
  `Operator = {key, name, dialogs, avg_final, gross, open_appeals, weakest: {criterion_id, code, name, fail_rate}|null, languages, dialog_ids, low_data, rank, of}`; `operators` отсортированы от слабого к сильному, `rank` = место по среднему итогу (1 = лучший, равные делят место), `low_data` = меньше 3 диалогов. «Не указано» не ранжируется и приходит отдельно в `unnamed`.
  `GrossItem = {dialog_id, evaluation_id, operator, operator_key, language, channel, final_total, finished_at, criterion_id, code, violation: {id: insult|paid|disclosure|other, label}, quote: {idx, turn, speaker, text}|null, reason, overridden}`; `quote`: первая реплика-доказательство оператора, `reason`: первое предложение обоснования без формулы «Грубые ошибки: Да, вид (б)».
- `GET /api/operators?group_id=&language=&channel=` > `{items: [Operator], unnamed: Operator|null}`.
- `GET /api/operators/{key}?group_id=&language=&channel=` > профиль оператора на фоне команды с тем же фильтром. `key` из `operator_key` (в URL кодируется, регистр не важен), `_unknown` = диалоги без имени. 404 `{"detail": "Оператор не найден."}`.
  ```
  { key, name, languages,
    summary: {dialogs, avg_final, team_avg_final, gross, open_appeals, rank, of, low_data},
    criteria: [{criterion_id, code, name, type, weight, applicable, fail, partial, pass, na, rate, team_rate, delta, failed_dialogs}],
    dialogs: [{dialog_id, evaluation_id, language, channel, total, final_total, gross, open_appeals, min_agreement, finished_at, weakest_cid, failed: [cid]}],
    gross_items: [GrossItem] }
  ```
  `rate` = Σбаллов / Σвеса по применимым диалогам оператора (у флага: доля диалогов без грубой ошибки), `team_rate` то же по всем диалогам фильтра, `delta = rate - team_rate`.

### Грубые ошибки
- `GET /api/nav-counts?mine=` > `{open_appeals, gross}`: счётчики сайдбара без полных списков. `open_appeals` в области видимости пользователя (`mine=1`: поданные им), `gross` (диалоги с грубой ошибкой в последней оценке) только для `supervisor` и `reviewer`, иначе null.
- `GET /api/gross-errors?group_id=&language=&channel=` > `{items: [{dialog_id, group_id, channel, language, evaluation_id, operator, operator_key, finished_at, total, final_total, criteria: [{criterion_id, code, name, reasoning, violation: {id, label}, reason, evidence_turns, evidence: [{idx, speaker, text}], agreement, votes, overridden}]}]}`.

### Ключ Claude API из интерфейса
- `GET /api/settings/anthropic-key` > `{configured, masked}` (`sk-ant-…abcd`, сам ключ никогда не возвращается). `masked` видит только `supervisor`, остальным приходит пустая строка.
- `POST /api/settings/anthropic-key` `{key}` > проверяет ключ (`client.models.list`, без затрат токенов), записывает `CQA_ANTHROPIC_API_KEY` в `.env` (chmod 600) и обновляет `config.ANTHROPIC_API_KEY` в памяти. 400 с понятным текстом, если ключ не принят. Ключ не логировать.

### Вход и роли
Интерфейс входит без пароля: экран входа показывает роли, вход в один клик через `POST /api/auth/quick`. Вход по паролю остаётся в API для скриптов (`cqa.submit`, Power Automate).
- `GET /api/auth/session` (без сессии) > `{user: User|null, quick: QuickInfo}`. Для первой загрузки страницы: не отвечает 401, если пользователь не вошёл.
- `GET /api/auth/quick` (без сессии) > `QuickInfo = {enabled, roles: ["operator", ...], users: [{id, username, display_name, role, role_label, description}], operators: [{key, name, dialogs, evaluated, languages}]}`. `description`: одна строка об обязанностях роли. `operators`: операторы, найденные в диалогах (пусто, если роль оператора выключена).
- `POST /api/auth/quick` `{username, operator_key?}` > `{user, token}`, ставит cookie `cqa_session`. 403, если роль выключена. Для `operator` с `operator_key` сессия привязана к этому оператору из данных: `user = {..., display_name: имя оператора, operator_key, operator_name}`, и оператор видит только свои диалоги: `/api/dialogs`, `/api/stats`, `/api/evaluations` и `/api/appeals` отфильтрованы, чужой диалог, оценка, разбор, апелляция или запись звонка > 403 «Это диалог другого оператора.», подать апелляцию можно только на свою оценку. 404 «Оператор не найден.» для неизвестного ключа. Без `operator_key` (и при входе по паролю) оператор видит всё, как раньше.
  Какие роли доступны, задаёт `CQA_QUICK_LOGIN_ROLES`: не задано, пусто или `all` = все демо-роли (по умолчанию); список через запятую, например `operator,reviewer`; `none` = быстрый вход выключен.
- `POST /api/auth/login` `{username, password}` > `{user: {id, username, display_name, role, role_label}, token}`, ставит HttpOnly-cookie `cqa_session` (12 часов). 401 при неверных данных.
- `GET /api/auth/me` > `{user}` (401 без сессии). `POST /api/auth/logout`.
- Любой `/api/*` кроме `health`, `auth/session`, `auth/quick` и `auth/login|logout` без сессии > 401 `{"detail": "Требуется вход в систему."}`. Токен также принимается в заголовке `Authorization: Bearer <token>` (встраивание в Dynamics 365).
- Командная аналитика (`/api/overview`, `/api/operators*`, `/api/gross-errors`, `/api/calibration`, `/api/export*`) доступна ролям `supervisor` и `reviewer`; оператору 403.
- Роли (три): `operator` (просмотр своих оценок, подача апелляций), `supervisor` (оценка, импорт, подача апелляций, `PUT /api/settings`, ключ API, сохранение и активация чек-листов), `reviewer` (второе мнение ИИ, предпросмотр и решение по апелляции). Решать апелляции супервайзер не может. Нарушение роли > 403 с текстом.
- Автор апелляции и проверяющий берутся из сессии. Демо-пользователи создаются при первом запуске: `operator`, `supervisor`, `reviewer`, пароль `CQA_DEMO_PASSWORD` (по умолчанию `freedom2026`). Пользователь `admin` из старых баз удаляется при запуске, другие пользователи с ролью `admin` становятся `supervisor`.

## Схема ответа модели

До 8 критериев включительно модель отвечает по строгой схеме с объектом на каждый критерий (`criteria: {c01: {...}}`, своё перечисление значений у каждого). Больше 8: компактная схема постоянного размера, `criteria: [{criterion_id, reasoning, value, evidence_turns, checked_from, checked_to, na_reason}]` (иначе API отвечает 400 «The compiled grammar is too large»). Значения в любом случае приводятся к допустимым сервером (`scoring.normalize_value`). Если API всё равно не компилирует схему, запрос повторяется без строгого формата, со схемой в промпте. Ошибки API сохраняются как «Коротко по-русски. Подробности: сообщение API» без JSON-обёртки.
