// Забирает расход, лиды (конверсии) и дневной бюджет по кампаниям Google Ads
// за последние 30 дней и сохраняет сырые данные в data/raw-google-ads.json.
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

async function fetchCampaignStats(accessToken) {
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign_budget.amount_micros,
      metrics.cost_micros,
      metrics.conversions,
      segments.date
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
      AND campaign.status != 'REMOVED'
  `;

  const url = `https://googleads.googleapis.com/v17/customers/${GOOGLE_ADS_CUSTOMER_ID}/googleAds:search`;
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
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    throw new Error(`Google Ads API вернул не-JSON ответ (HTTP ${r.status}) по адресу ${url}: ${text.slice(0, 500)}`);
  }
  if (!r.ok) throw new Error('Google Ads API error: ' + JSON.stringify(d));
  return d.results || [];
}

async function main() {
  if (!GOOGLE_ADS_DEVELOPER_TOKEN || !GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_REFRESH_TOKEN || !GOOGLE_ADS_CUSTOMER_ID) {
    console.error('Не заданы переменные окружения для Google Ads — пропускаю сбор (заполните Secrets в репозитории).');
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'raw-google-ads.json'), JSON.stringify({ rows: [], skipped: true }, null, 2));
    return;
  }

  const accessToken = await getAccessToken();
  const rows = await fetchCampaignStats(accessToken);

  const normalized = rows.map((r) => ({
    campaignId: r.campaign.id,
    campaignName: r.campaign.name,
    date: r.segments.date,
    costTenge: Number(r.metrics.costMicros || 0) / 1_000_000,
    conversions: Number(r.metrics.conversions || 0),
    dailyBudgetTenge: Number(r.campaignBudget?.amountMicros || 0) / 1_000_000,
  }));

  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'raw-google-ads.json'),
    JSON.stringify({ rows: normalized, skipped: false }, null, 2)
  );
  console.log(`Google Ads: сохранено ${normalized.length} строк.`);
}

main().catch((e) => {
  console.error('Ошибка сбора Google Ads:', e.message);
  process.exit(1);
});
