# Сквозная аналитика — DriveTaxi Almaty

Дашборд по расходам на рекламу (Google Ads + Meta Ads) и сделкам из amoCRM,
с разбивкой по UTM-меткам и по статусу "квалифицирован".

## Как это устроено

1. `.github/workflows/update-data.yml` — раз в час GitHub автоматически запускает
   скрипты сбора данных (без участия человека).
2. `scripts/fetch-google-ads.js`, `scripts/fetch-meta-ads.js`, `scripts/fetch-amocrm.js` —
   каждый идёт в свой сервис и забирает данные.
3. `scripts/build-data.js` — сводит всё вместе в один файл `data/data.json`.
4. `index.html` — сам дашборд, читает `data/data.json` и рисует таблицы/графики.
5. GitHub Pages отдаёт `index.html` как обычный сайт по ссылке
   `https://geronimoapch.github.io/drivetaxi-analytics/`.

**Важно:** никакие пароли, токены и ключи не хранятся в коде и не попадают на
сайт. Они лежат отдельно в разделе **Settings → Secrets and variables →
Actions** этого репозитория — их видит только сам GitHub при запуске скриптов,
в браузере посетителя дашборда их нет и не будет.

## Что нужно занести в Secrets, чтобы всё заработало

Settings → Secrets and variables → Actions → New repository secret:

| Имя секрета | Что это |
|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Токен разработчика Google Ads API |
| `GOOGLE_ADS_CLIENT_ID` | OAuth Client ID |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth Client Secret |
| `GOOGLE_ADS_REFRESH_TOKEN` | OAuth Refresh Token (получается один раз) |
| `GOOGLE_ADS_CUSTOMER_ID` | ID рекламного аккаунта, например 1234567890 |
| `META_ACCESS_TOKEN` | Долгоживущий токен доступа Meta (обновлять раз в ~60 дней) |
| `META_AD_ACCOUNT_ID` | ID рекламного кабинета Meta, например act_1234567890 |
| `AMOCRM_BASE_URL` | Например https://drivetaxialmaty.amocrm.ru |
| `AMOCRM_ACCESS_TOKEN` | Долгоживущий токен приватной интеграции amoCRM |

Пока эти секреты не добавлены — автообновление будет падать с понятной
ошибкой в логах Actions, это нормально на данном этапе.

## Статус

🚧 Каркас проекта. Реальные поля amoCRM (UTM, ID стадии "Квалифицирован")
будут уточнены и захардкожены в `scripts/fetch-amocrm.js`, как только появится
токен доступа к аккаунту.
