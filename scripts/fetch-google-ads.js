// Забирает расход и лиды (конверсии) по дням по кампаниям Google Ads с начала
// прошлого месяца по сегодня (этого хватает на пресеты "сегодня/вчера/7 дней/
// этот месяц/прошлый месяц" в дашборде), и ОТДЕЛЬНО — дневной бюджет по всем
// кампаниям, которые включены ПРЯМО СЕЙЧАС (не зависит от истории показов —
// иначе только что созданная кампания выпадает из расчёта бюджета).
// Сохраняет всё в data/raw-google-ads.json.
//
// Важно: цифры приходят от Google в валюте самого рекламного аккаунта (у нас
// это доллары), поэтому поля называются costUsd / dailyBudgetUsd. Дашборд
// показывает суммы как есть, в долларах, без перевода в тенге.
//
// Нужные секреты (передаются как переменные окружения в GitHub Actions):
//   GOOGLE_ADS_DEVELOPER_TOKEN
//   GOOGLE_ADS_CLIENT_ID
//   GOOGLE_ADS_CLIENT_SECRET
//   GOOGLE_ADS_REFRESH_TOKEN
//   GOOGLE_ADS_CUSTOMER_ID   (без дефисов, например 1234567890)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID  (ID менеджерского аккаунта — там, где выдан токен разработчика)

const fs = require('fs');
const path = require('path');

const {
  GOOGLE_ADS_DEVELOPER_TOKEN,
  GOOGLE_ADS_CLIENT_ID,
  GOOGLE_ADS_CLIENT_SECRET,
  GOOGLE_ADS_REFRESH_TOKEN,
  GOOGLE_ADS_CUSTOMER_ID,
  GOOGLE_ADS_LOGIN_CUSTOMER_ID,
} = process.env;

const API_VERSION = 'v24';

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function todayIso() {
  return isoDate(new Date());
}
// Первое число прошлого месяца — с запасом хватает на пресеты
// "этот месяц" и "прошлый месяц" в дашборде.
function firstDayOfPreviousMonthIso() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return isoDate(d);
}

async function getAccessToken() {
  const params = new URLSearchParams({
    client_id: GOOGLE_ADS_CLIENT_ID,
    client_secret: GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const text = await r.text();
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    throw new Error(`Google OAuth вернул не-JSON ответ (HTTP ${r.status}): ${text.slice(0, 500)}`);
  }
  if (!r.ok) throw new Error('Google OAuth error: ' + JSON.stringify(d));
  return d.access_token;
}

// Google Ads API отдаёт результаты постранично (nextPageToken) — если не
// пройти по всем страницам, хвост данных (например, старые даты за прошлый
// месяц) молча теряется.
async function runQuery(accessToken, query) {
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${GOOGLE_ADS_CUSTOMER_ID}/googleAds:search`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': GOOGLE_ADS_DEVELOPER_TOKEN,
  };
  // Токен разработчика выдан на менеджерском аккаунте (MCC) — нужно явно
  // указать, через какой MCC идёт запрос, иначе Google Ads API откажет.
  if (GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    headers['login-customer-id'] = GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  }

  const allResults = [];
  let pageToken = null;
  do {
    const body = { query, pageSize: 10000 };
    if (pageToken) body.pageToken = pageToken;
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let d;
    try {
      d = JSON.parse(text);
    } catch {
      throw new Error(`Google Ads API вернул не-JSON ответ (HTTP ${r.status}) по адресу ${url}: ${text.slice(0, 500)}`);
    }
    if (!r.ok) throw new Error('Google Ads API error: ' + JSON.stringify(d));
    allResults.push(...(d.results || []));
    pageToken = d.nextPageToken || null;
  } while (pageToken);

  return allResults;
}

// Расход и конверсии по дням — начиная с прошлого месяца.
async function fetchDailyStats(accessToken) {
  const since = firstDayOfPreviousMonthIso();
  const until = todayIso();
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      metrics.cost_micros,
      metrics.conversions,
      segments.date
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'
      AND campaign.status != 'REMOVED'
  `;
  return runQuery(accessToken, query);
}

// Бюджет по кампаниям, которые включены ПРЯМО СЕЙЧАС — отдельно от статистики
// по дням, чтобы новая кампания без истории показов не выпадала из расчёта.
async function fetchActiveCampaignBudgets(accessToken) {
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.status = 'ENABLED'
  `;
  return runQuery(accessToken, query);
}

async function main() {
  if (!GOOGLE_ADS_DEVELOPER_TOKEN || !GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_REFRESH_TOKEN || !GOOGLE_ADS_CUSTOMER_ID) {
    console.error('Не заданы переменные окружения для Google Ads — пропускаю сбор (заполните Secrets в репозитории).');
    fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'raw-google-ads.json'), JSON.stringify({ rows: [], activeCampaigns: [], totalActiveDailyBudgetUsd: 0, skipped: true }, null, 2));
    return;
  }

  const accessToken = await getAccessToken();
  const [statsRows, budgetRows] = await Promise.all([
    fetchDailyStats(accessToken),
    fetchActiveCampaignBudgets(accessToken),
  ]);

  const rows = statsRows.map((r) => ({
    campaignId: r.campaign.id,
    campaignName: r.campaign.name,
    date: r.segments.date,
    costUsd: Number(r.metrics.costMicros || 0) / 1_000_000,
    conversions: Number(r.metrics.conversions || 0),
  }));

  const activeCampaigns = budgetRows.map((r) => ({
    campaignId: r.campaign.id,
    campaignName: r.campaign.name,
    status: r.campaign.status,
    dailyBudgetUsd: Number(r.campaignBudget?.amountMicros || 0) / 1_000_000,
  }));

  const totalActiveDailyBudgetUsd = activeCampaigns.reduce((acc, c) => acc + c.dailyBudgetUsd, 0);

  console.log('Активные кампании Google и их дневной бюджет:');
  activeCampaigns.forEach((c) => {
    console.log(`  - ${c.campaignName} (${c.campaignId}): $${c.dailyBudgetUsd} [${c.status}]`);
  });
  console.log(`Итого дневной бюджет по активным кампаниям Google: $${totalActiveDailyBudgetUsd}`);

  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'raw-google-ads.json'),
    JSON.stringify({ rows, activeCampaigns, totalActiveDailyBudgetUsd, skipped: false }, null, 2)
  );
  console.log(`Google Ads: сохранено ${rows.length} строк расхода/конверсий и ${activeCampaigns.length} активных кампаний.`);
}

main().catch((e) => {
  console.error('Ошибка сбора Google Ads:', e.message);
  process.exit(1);
});
