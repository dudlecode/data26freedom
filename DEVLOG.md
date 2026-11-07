# DEVLOG

Бэклог задач команды и агентов. Правила - [AGENTS.md](AGENTS.md#devlog-обязательно). Время - Астана (UTC+5).

Статусы: `[ ]` ждёт, `[>]` в работе, `[x]` сделано, `[!]` заблокировано.
Строка индекса: ID, что делаем, кто (человек / агент), ветка, когда взято. Детали - в разделе задачи ниже.

## Сроки

- вс 08.11 ~11:00 - организаторы открывают 10 контрольных чатов (новый `group_id`, тот же API).
- вс 08.11 12:00 - стоп-код: `results/dev/results.json` и `results/prod/results.json` в открытом репозитории, commit и push.
- вс 08.11 13:00-17:00 - питчи топ-50: 5 минут живого демо.

## Задачи

- [x] `TASK-001` Запуск проекта на Windows - Magurin / Claude Code - `main` - 07.11 16:25
- [>] `TASK-002` Интеграции и выгрузка results.json - Magurin / Claude Code - `feat/integrations` - 07.11 17:20
- [>] `TASK-003` Замер локальной модели qwen3:30b - Magurin / Claude Code - `feat/integrations` - 07.11 17:55
- [!] `TASK-004` Собрать results/dev/results.json - не взята - заблокирована: нужен быстрый доступ к qwen3:30b (внешний хостинг)
- [x] `TASK-005` Убрать Claude API, оставить один OpenAI-совместимый провайдер под Qwen - Magurin / Claude Code - `feat/integrations` - 07.11 18:26
- [>] `TASK-006` Перепроверка Qwen по разъяснениям организаторов на DEV - Alex / Claude Code - без ветки (только замер) - 07.11 21:35

## `TASK-001`

venv, зависимости, сервер на http://127.0.0.1:8000. 28 из 29 тестов: падала проверка прав 0600 у `.env`,
на Windows их нет (исправлено в `TASK-002`).

## `TASK-002`

Область: `backend/cqa/{app,db,results,integrations,postman}.py`, `frontend/js/{app,api}.js`,
`frontend/js/views/{settings,dialogs}.js`, `dynamics/`, `docs/`, `results/README.md`, `.github/workflows/ci.yml`, `ollama/`.
Готово, когда: ветка закоммичена, CI зелёный, влита в `main`.

Сделано на ветке, ещё не закоммичено:
- выгрузка `results.json` по приложению к гайду + проверка формата: `python -m cqa.results`, кнопка **results.json**
  на экране диалогов, `GET /api/results`;
- журнал действий (`GET /api/audit`, Настройки → Журнал действий);
- вебхуки для Power Automate с HMAC и журналом доставок;
- встраивание в Dynamics 365 (`?embed=1&data=dialog%3D<id>`, `dynamics/cqa_dialog_card.html`);
- коллекция Postman, CI на Ubuntu и Windows, 38 тестов.

## `TASK-003`

Цель: время на диалог и совпадение с `eval/reference_dev.json` на 5-10 диалогах DEV.
- Ollama по умолчанию обрезает промпт до 4096 токенов молча. Добавлен `qwen3:30b-cqa` с окном 16k
  (`ollama/Modelfile.qwen3-30b-cqa`).
- С обрезанным промптом: ~5 мин на диалог, 64% модели на CPU (RTX 4060 8 ГБ).
- С окном 16k оценка не уложилась в таймаут клиента (~15 мин): «Нет соединения с localhost:11434». Разбираюсь.

## `TASK-004`

DEV не оценён: без модели все 65 записей уйдут как `status: "error"`. Команда, когда модель будет:
`cd backend && ../.venv/Scripts/python.exe -m cqa.results --group DEV --evaluate --out ../results/dev/results.json`.

## `TASK-005`

Решение команды: модель - qwen3:30b (скорее всего на внешнем хостинге), Claude API не используем.
Область: `backend/cqa/{providers,config,keys,app,results,postman}.py`, `frontend/js/views/settings.js`, `frontend/js/{ui,api,app}.js`,
`frontend/index.html`, тесты, `requirements.txt`, `README.md`, `docs/API.md`, `.env.example`.
Готово, когда: в коде и доках нет Claude API, оценка идёт через один провайдер (base_url + модель + ключ), стоимость
считается по цене за токен из `.env`, тесты зелёные. Таблица «Точность на DEV» в README остаётся как ориентир (Claude Opus).

Итог (07.11 19:05, на ветке `feat/integrations`, коммит вместе с `TASK-002`): один провайдер `OpenAICompatProvider`;
настройки `base_url / model / json_mode / votes / concurrency / price_*_per_mtok` (env `CQA_MODEL_*`, `CQA_PRICE_*`);
ключ `CQA_MODEL_API_KEY` (Настройки → Ключ API сервера модели, проверка `GET /models`); `mode` в results.json -
по адресу (localhost / частная сеть = `local`, иначе `external_api`); баннер - только если сервер модели недоступен;
старые настройки в базе переводятся автоматически; пакет `anthropic` убран из requirements; 40 тестов.
Тайм-аут модели теперь пишется прямо: «Модель не ответила за N с» (`CQA_MODEL_TIMEOUT`, по умолчанию 900).

## `TASK-006`

Область: только замер, файлы репозитория не меняются. `qwen3-cqa` в Ollama на MacBook, текущий промпт и чек-лист из рабочей копии
`feat/ui-auth-deploy`, вызов `evaluator.evaluate` в обход базы приложения (`results/dev` не трогается). По смыслу рядом с `TASK-003`
(Magurin): решение Alex, замер Qwen в `TASK-003` не заменяет.
Повод: прогон Qwen из `eval/local_qwen3_dev.json` ставит C7 «Да» за одно прощание в 21 чате, пропускает C8 в kz-013, kz-015, en-014
и в 7 чатах C2 не N/A, хотя организаторы в чате разъяснили обратное.
Готово, когда: на этих ~29 диалогах видно, исправил ли текущий промпт эти ошибки.

## Решения и грабли

- Формат сдачи - приложение к гайду, JSON 1.0. `results.json` собирать только кодом (`cqa.results`), руками не править.
- Сравнивают по ответу на каждый критерий; контрольные 10 - только чаты.
- Видимость репозитория (сейчас приватный) меняет команда, не агенты.
