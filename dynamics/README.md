# CQA в контуре Microsoft Dynamics 365 / Power Platform

CQA - отдельный сервис (FastAPI + статический фронтенд без сборки). С CRM он связан тремя путями:

```
 Dynamics 365 (форма обращения)            Power Automate                    Dataverse / Teams / почта
 ┌───────────────────────────┐   ┌──────────────────────────────────┐   ┌──────────────────────────┐
 │ веб-ресурс                │   │ When an HTTP request is received │──►│ строка cqa_evaluation,   │
 │ cqa_dialog_card.html ─────┼─┐ │  (тело = webhook-schema.json)    │   │ задача супервайзеру,     │
 └───────────────────────────┘ │ └───────────────▲──────────────────┘   │ уведомление о грубой     │
                               │                 │ вебхук POST JSON     │ ошибке                   │
                               ▼                 │                      └──────────────────────────┘
                         ┌─────────────────────────────┐
  чаты / звонки ───────► │ CQA: REST API /api/*        │ ◄── Postman, Swagger /docs, ETL-скрипты
  (API организаторов,    │ оценка LLM, апелляции,      │
   POST /api/dialogs/    │ журнал действий /api/audit  │
   import)               └─────────────────────────────┘
```

## 1. Карточка оценки на форме CRM (веб-ресурс)

1. Разверните CQA по HTTPS (например, `https://cqa.company.kz`) и запустите: `cd backend && python -m cqa`.
2. В `cqa_dialog_card.html` укажите `CQA_URL`, имя поля с ID разговора (`CONVERSATION_FIELD`) и роль.
3. Make.powerapps.com → Решение → Добавить → Веб-ресурс → тип «Веб-страница (HTML)», загрузите файл
   (имя, например, `cqa_/dialog_card.html`).
4. На форме обращения (или своей таблицы разговоров) → Вставить → Веб-ресурс → выберите его.
   В поле «Пользовательский параметр (data)» можно сразу указать `dialog=p1-ru-001` или оставить пустым -
   тогда ID возьмётся из поля записи.

Веб-ресурс открывает CQA в iframe в режиме встраивания:

| Параметр URL | Что делает |
|---|---|
| `?dialog=<id>` | сразу открыть карточку диалога |
| `?appeal=<id>` | открыть апелляцию (для проверяющего) |
| `?view=appeals` | открыть раздел (`dialogs`, `appeals`, `checklists`, `calibration`, `settings`) |
| `?data=...` | то же, но в формате Dynamics 365: `p1-ru-001`, `dialog=p1-ru-001`, `appeal=12` |
| `?embed=1` | без шапки и навигации - карточка на форме |

Роль и права берутся из входа в CQA: если сессии нет, сначала откроется экран входа, после него нужная карточка. В журнал действий пишется вошедший пользователь.

Пример: `https://cqa.company.kz/?embed=1&data=appeal%3D12`.

**Вариант без iframe.** Каждый экран фронтенда - ES-модуль с `mount(container, ctx)` (см. `frontend/js/app.js`),
поэтому файлы `frontend/` можно загрузить как веб-ресурсы целиком. Тогда в `frontend/config.js` задайте
`apiBase: 'https://cqa.company.kz'`, а на сервере - `CQA_CORS_ORIGINS=https://<org>.crm4.dynamics.com`.

## 2. События в Power Automate (вебхуки)

В `.env` сервера:

```
CQA_WEBHOOK_URLS=https://prod-00.westeurope.logic.azure.com/workflows/.../invoke?api-version=1&sp=...&sig=...
CQA_WEBHOOK_SECRET=длинная-случайная-строка   # необязательно: подпись X-CQA-Signature: sha256=<hmac>
CQA_PUBLIC_URL=https://cqa.company.kz         # чтобы в событиях были ссылки на карточку
```

Адресов может быть несколько через запятую. События:

| event | когда | что полезно сделать в потоке |
|---|---|---|
| `evaluation.completed` | оценка диалога готова | записать итог и баллы по критериям в Dataverse; при `gross_error = true` - задача руководителю |
| `evaluation.failed` | оценка не удалась | уведомить администратора |
| `appeal.created` | супервайзер оспорил критерий | задача проверяющему со ссылкой `url` |
| `appeal.decided` | проверяющий решил | обновить итог (`final_total`), уведомить автора апелляции |
| `checklist.created`, `checklist.activated` | изменён чек-лист | уведомить отдел качества |

Поток: триггер **When an HTTP request is received** → в «Request Body JSON Schema» вставьте
[`webhook-schema.json`](webhook-schema.json) (или «Use sample payload» с [`sample-event.json`](sample-event.json)) →
**Switch** по `event` → **Add a new row** (Dataverse) / **Post message** (Teams) / **Send an email**.
Поле `id` события одинаково при повторной доставке - используйте его как ключ, чтобы не создавать дубли.

Доставка: POST `application/json`, заголовки `X-CQA-Event`, `X-CQA-Delivery`, `X-CQA-Signature` (если задан секрет),
до 3 попыток с паузой. Каждая попытка видна в интерфейсе (Настройки → Интеграции) и в `GET /api/integrations/deliveries`;
подписи `sig=` в адресах там скрыты. Кнопка «Отправить тестовое событие» проверяет новый поток до включения.

## 3. REST API

- Swagger UI: `/docs`, схема OpenAPI: `/openapi.json`, контракт с примерами: [`docs/API.md`](../docs/API.md).
- Коллекция Postman: [`docs/CQA.postman_collection.json`](../docs/CQA.postman_collection.json) - переменная `baseUrl`.
- Загрузка диалогов из своей системы: `POST /api/dialogs/import` с телом в формате API организаторов
  (`{"payload": {"data": {"records": [...]}}}`), запуск оценки: `POST /api/evaluations`, выгрузка: `GET /api/export?format=csv|json`.
- Журнал действий: `GET /api/audit?entity=appeal&entity_id=12` - кто, когда и что изменил.
