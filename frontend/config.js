// Адрес backend API. Пустая строка — тот же origin, с которого отдан фронтенд.
// Для Dynamics 365 (HTML web resource) укажите полный адрес, например 'https://cqa.example.kz'.
// При другом origin разрешите его на сервере: CQA_CORS_ORIGINS=https://org.crm4.dynamics.com в .env.
window.CQA_CONFIG = { apiBase: '' };
