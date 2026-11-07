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
- `GET /api/settings` > `{settings, models: ANTHROPIC_MODELS, efforts: [...], providers: [{id:"anthropic",label}, {id:"openai_compat",label}], has_anthropic_key}`
- `PUT /api/settings` (частичный объект) > `{settings}`. Ключи API в настройках не хранятся (только .env).
- `GET /api/stats` > `{dialogs, evaluated, avg_total, gross_count, open_appeals, total_cost_usd, by_language: {RU:{count,avg}}, by_criterion: {cid: {name, distribution: {value: n}}}}` (по последней завершённой оценке каждого диалога; `?group_id=`, только эта группа; итог = `final_total`, даже если он null).

### Данные
- `POST /api/datasets/fetch` `{group_id, source_url?}` > `{group_id, imported, ids, renamed}`. Берёт `CQA_SOURCE_URL` (или `source_url`), подменяет query-параметр `group_id`, GET, проверяет `isSuccess`, upsert в `dialogs`.
- `POST /api/dialogs/import` `{group_id?, payload}` > `{imported, ids, group_id, renamed}`. Группа: явный `group_id` > `dataset_group_id` из ответа организаторов > `UPLOAD`. `payload`: ответ API организаторов целиком, или `data`, или массив записей, или одна запись; либо `{"text": "...", "conversation_id"?, "channel"?, "language"?}`, свободный текст, строки вида `[00:02] operator: текст` / `Оператор: текст` / `client: ...` (роли RU/EN: клиент/оператор/бот/система). Роли в JSON-записях (`Оператор`, `agent`, `customer`, …) приводятся к `operator|client|bot|system` той же таблицей. ID очищаются для URL (`/ \ ? # %` и пробелы > `-`); запись без реплик отклоняется (400).
  Повторный импорт: если диалог с таким ID уже оценён, а текст другой, новая версия сохраняется под ID `<id>-2` (`-3`, …), прежние оценки не трогаются; `renamed = {старый: новый}`. Тот же текст: обычный upsert.
- `GET /api/dialogs?group_id=&language=&channel=&q=` > `{items: [DialogRow], groups: ["DEV", ...]}`
  `DialogRow = {id, group_id, channel, language, turns, imported_at, latest: EvalSummary|null}`
- `GET /api/dialogs/{id}` > `{dialog: {id, group_id, channel, language, has_audio}, turns: [Turn], facts, evaluations: [EvalSummary] (новые первыми)}`

`EvalSummary = {id, dialog_id, status, error, checklist_id, checklist_name, checklist_version, total, final_total, gross, min_agreement, open_appeals, decided_appeals, model, cost_usd, duration_ms, created_at, finished_at}`

### Чек-листы (версионирование: каждое сохранение = новая версия)
- `GET /api/checklists` > `{items: [{id, name, version, is_active, note, created_at, criteria_count, total_weight}]}`
- `GET /api/checklists/active` и `GET /api/checklists/{id}` > `{id, name, version, is_active, note, created_at, config}`
- `POST /api/checklists/validate` `{config}` > `{errors, total_weight}`. Проверки сверх `scoring.validate_checklist`: вес, конечное число; ступени шкалы, целые, неотрицательные, без повторов, верхняя > 0; ID уникальны после обрезки пробелов.
- `POST /api/checklists` `{config, note?, activate?: true}` > созданная версия (version = max+1). 422 при ошибках.
- `POST /api/checklists/{id}/activate` > `{ok: true}`
- `GET /api/checklists/default` > исходный чек-лист из файла (для «сбросить к исходному»).

Формат `config` = как `default_checklist.json`: `{name, description, rounding, gross_error_zeroes_total, general_guidance, sections:[{id,name}], criteria:[{id, code, name, section, type: binary|scale|flag, weight, na_allowed, description, na_condition, scale:[{value,label}], guidance}]}`.

### Оценки
- `POST /api/evaluations` `{dialog_ids: [...], checklist_id?: активный, settings?: частичный override}` > `{evaluation_ids: [...]}`. Создаёт строки `status=queued`, обрабатывает в фоне (asyncio). Лимит параллельности: ГЛОБАЛЬНАЯ настройка `concurrency` (перечитывается при каждом запуске задачи; override `concurrency` в запросе не действует).
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
- `POST /api/evaluations/{id}/rerun` > `{evaluation_id}` новая оценка того же диалога тем же чек-листом.

Алгоритм оценки (`cqa/evaluator.py`):
1. `prepare(record)`, `render_for_llm`, промпт и схема из `checklist.config`.
2. `votes` прогонов: первый отдельно (прогрев кэша промпта), остальные параллельно. Ошибки отдельных прогонов не валят оценку, если есть хотя бы один успешный.
3. Агрегация по критерию: `normalize_value` каждого голоса > большинство; ничья по шкале > медиана (snap к ступени), ничья по бинарному > значение первого прогона. `agreement` = доля голосов за итог. Обоснование/доказательства: из первого прогона с итоговым значением; если за медиану никто не голосовал, из прогона с ближайшим голосом, с пометкой «Итог, медиана голосов (…)». `evidence_turns` фильтруются по существующим индексам; `checked_range` = `[from,to]` если оба ≥0 и валидны, иначе null.
4. `scoring.compute` > `score` (баллы считаются точными дробями, округление half-up только в конце); `final` = копия (без апелляций). `total`, `final_total`, `gross`, `cost_usd` (сумма), `usage` (сумма), `duration_ms` (wall clock).

### Апелляции
`Appeal = {id, evaluation_id, dialog_id, criterion_id, criterion_name, comment, author, status: open|decided, original: {value, reasoning, evidence_turns, points}, ai_opinion: {value, reasoning, evidence_turns, appeal_valid, recommendation, model, cost_usd}|null, decision: confirmed|changed|null, decision_value, decision_reason, reviewer, created_at, decided_at, total_before, total_after}`
- `POST /api/evaluations/{id}/appeals` `{criterion_id, comment, author?}` > `Appeal` (одна открытая апелляция на критерий оценки; иначе 409).
- `GET /api/appeals?status=open|decided|all` > `{items: [Appeal + {dialog_channel, dialog_language}]}`
- `GET /api/appeals/{id}` > `{appeal, evaluation: EvalSummary, criterion: <config критерия>, fragment: [Turn], has_audio}`, `fragment`: реплики вокруг `evidence_turns`/`checked_range` (±2), либо вся операторская часть, если доказательств нет.
- `POST /api/appeals/{id}/ai-review` > `{appeal}` с заполненным `ai_opinion` (повторная оценка ОДНОГО критерия с учётом комментария). Только для открытой апелляции (иначе 409); любая ошибка модели > 502 с текстом по-русски.
- `POST /api/appeals/{id}/decide` `{action: "confirm"|"change", value?, reason, reviewer?}` > `{appeal, final_total}`. `change` требует допустимое `value`, `reason` обязателен. Пересчитывает `final` и `final_total` оценки (атомарно под блокировкой БД). Если решение вернуло значение ИИ, `overrides` по критерию не остаётся.

### Звук
- `GET /api/audio/{dialog_id}` > 302 на mp3. `audio_url` диалога отдаёт HTML-плеер; сервер скачивает его, достаёт `<source src="...">` (подписанная ссылка ~1 час), кэширует ~50 минут.
- `GET /api/audio/{dialog_id}/info` > `{mp3_url, player_url}`.

### Экспорт и калибровка
- `GET /api/export?group_id=&format=csv|json` > файл: по каждому диалогу последняя завершённая оценка, итог, финальный итог, грубая ошибка, значение и баллы по каждому критерию.
- `GET /api/calibration?group_id=` > сравнение последних оценок с `eval/reference_dev.json` (если файл есть): `{available, n_dialogs, overall_exact, total_mae, by_criterion: {cid: {name, exact, n, confusion: {"ref->pred": n}}}, dialogs: [{id, ref_total, pred_total, diffs: [{cid, ref, pred}]}]}`. `ref_total` считается `scoring.compute` по эталонным значениям тем же чек-листом.

### Ключ Claude API из интерфейса
- `GET /api/settings/anthropic-key` > `{configured, masked}` (`sk-ant-…abcd`, сам ключ никогда не возвращается).
- `POST /api/settings/anthropic-key` `{key}` > проверяет ключ (`client.models.list`, без затрат токенов), записывает `CQA_ANTHROPIC_API_KEY` в `.env` (chmod 600) и обновляет `config.ANTHROPIC_API_KEY` в памяти. 400 с понятным текстом, если ключ не принят. Ключ не логировать.

### Вход и роли
- `POST /api/auth/login` `{username, password}` > `{user: {id, username, display_name, role, role_label}, token}`, ставит HttpOnly-cookie `cqa_session` (12 часов). 401 при неверных данных.
- `GET /api/auth/me` > `{user}`. `POST /api/auth/logout`.
- Любой `/api/*` кроме `health` и `auth/login|logout` без сессии > 401 `{"detail": "Требуется вход в систему."}`. Токен также принимается в заголовке `Authorization: Bearer <token>` (встраивание в Dynamics 365).
- Роли: `supervisor` (оценка, импорт, подача апелляций), `reviewer` (второе мнение ИИ, решение по апелляции), `admin` (всё, включая `PUT /api/settings`, ключ API, сохранение и активацию чек-листов). Нарушение роли > 403 с текстом.
- Автор апелляции и проверяющий берутся из сессии. Демо-пользователи создаются при первом запуске: `supervisor`, `reviewer`, `admin`, пароль `CQA_DEMO_PASSWORD` (по умолчанию `freedom2026`).
