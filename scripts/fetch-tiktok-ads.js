// Забирает расход и лиды (результаты) по дням по кампаниям TikTok Ads с
// начала прошлого месяца по сегодня — так же, как fetch-google-ads.js и
// fetch-meta-ads.js — и ОТДЕЛЬНО дневной бюджет по кампаниям, которые
// включены ПРЯМО СЕЙЧАС. Сохраняет всё в data/raw-tiktok-ads.json.
//
// TikTok отдаёт цифры в валюте рекламного кабинета — оставляем как есть,
// без пересчёта в тенге (так же, как Google Ads и Meta Ads).
//
// Нужные секреты:
//   TIKTOK_ACCESS_TOKEN   (токен доступа к Marketing API, из TikTok for Business)
//   TIKTOK_ADVERTISER_ID  (ID рекламного кабинета)

const fs = require('fs');
const path = require('path');

const { TIKTOK_ACCESS_TOKEN, TIKTOK_ADVERTISER_ID } = process.env;
const API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

function today() {
  return new Date().toISOString().slice(0, 10);
}
function firstDayOfPreviousMonth() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

async function tiktokGet(pathName, params) {
  const url = new URL(`${API_BASE}${pathName}`);
  Object.entries(params).forEach(([key, value]) => {
    const v = typeof value === 'string' ? value : JSON.stringify(value);
    url.searchParams.set(key, v);
  });
  const r = await fetch(url, {
    headers: { 'Access-Token': TIKTOK_ACCESS_TOKEN },
  });
  const d = await r.json();
  if (!r.ok || d.code !== 0) {
    throw new Error(`TikTok API error (${pathName}): ` + JSON.stringify(d));
  }
  return d.data;
}

// Отчёт по дням по каждой кампании. TikTok отдаёт результаты постранично —
// проходим по всем страницам через page_info, иначе хвост данных потеряется
// (та же логика, что и для Meta/Google).
async function fetchInsights() {
  const rows = [];
  let page = 1;
  const pageSize = 1000;
  while (true) {
    const data = await tiktokGet('/report/integrated/get/', {
      advertiser_id: TIKTOK_ADVERTISER_ID,
      report_type: 'BASIC',
      data_level: 'AUCTION_CAMPAIGN',
      dimensions: ['campaign_id', 'stat_time_day'],
      metrics: ['campaign_name', 'spend', 'conversion', 'result'],
      start_date: firstDayOfPreviousMonth(),
      end_date: today(),
      page,
      page_size: pageSize,
    });
    rows.push(...(data.list || []));
    const totalPages = data.page_info ? data.page_info.total_page : 1;
    if (page >= totalPages) break;
    page += 1;
  }
  return rows;
}

// Все кампании, которые включены прямо сейчас, с их дневным бюджетом.
async function fetchActiveCampaigns() {
  const rows = [];
  let page = 1;
  const pageSize = 1000;
  while (true) {
    const data = await tiktokGet('/campaign/get/', {
      advertiser_id: TIKTOK_ADVERTISER_ID,
      fields: ['campaign_id', 'campaign_name', 'budget', 'budget_mode', 'operation_status'],
      filtering: { primary_status: 'STATUS_ALL' },
      page,
      page_size: pageSize,
    });
    rows.push(...(data.list || []));
    const totalPages = data.page_info ? data.page_info.total_page : 1;
    if (page >= totalPages) break;
    page += 1;
  }
  return rows.filter((c) => c.operation_status === 'ENABLE');
}

// "Лид" — берём первый найденный из списка метрик-результатов, по
// приоритету: 'result' (заточен под цель кампании — лидформа, сообщения и
// т.п.) и, если его нет, 'conversion' (конверсии по пикселю/событию). Не
// суммируем, чтобы не задвоить один и тот же результат.
const LEAD_METRIC_PRIORITY = ['result', 'conversion'];

function extractLeads(metrics) {
  for (const key of LEAD_METRIC_PRIORITY) {
    const v = Number(metrics[key]);
    if (v > 0) return v;
  }
  return 0;
}

async function main() {
  if (!TIKTOK_ACCESS_TOKEN || !TIKTOK_ADVERTISER_ID) {
    console.error('Не заданы переменные окружения для TikTok Ads — пропускаю сбор (заполните Secrets в репозитории).');
    fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'raw-tiktok-ads.json'), JSON.stringify({ rows: [], activeCampaigns: [], totalActiveDailyBudgetUsd: 0, skipped: true }, null, 2));
    return;
  }

  const [insights, campaigns] = await Promise.all([
    fetchInsights(),
    fetchActiveCampaigns(),
  ]);

  const activeCampaigns = campaigns.map((c) => ({
    campaignId: c.campaign_id,
    campaignName: c.campaign_name,
    effectiveStatus: c.operation_status,
    // BUDGET_MODE_INFINITE значит бюджет не ограничен на уровне кампании —
    // считаем как 0, чтобы не занижать/не выдумывать цифру.
    dailyBudgetUsd: c.budget_mode === 'BUDGET_MODE_INFINITE' ? 0 : Number(c.budget || 0),
  }));

  const totalActiveDailyBudgetUsd = activeCampaigns.reduce((acc, c) => acc + c.dailyBudgetUsd, 0);

  console.log('Активные кампании TikTok и их дневной бюджет:');
  activeCampaigns.forEach((c) => {
    console.log(`  - ${c.campaignName} (${c.campaignId}): $${c.dailyBudgetUsd} [${c.effectiveStatus}]`);
  });
  console.log(`Итого дневной бюджет по активным кампаниям: $${totalActiveDailyBudgetUsd}`);

  const rows = insights.map((r) => ({
    campaignId: r.dimensions.campaign_id,
    campaignName: r.metrics.campaign_name,
    date: r.dimensions.stat_time_day.slice(0, 10),
    spendUsd: Number(r.metrics.spend || 0),
    leads: extractLeads(r.metrics),
  }));

  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'raw-tiktok-ads.json'),
    JSON.stringify({ rows, activeCampaigns, totalActiveDailyBudgetUsd, skipped: false }, null, 2)
  );
  console.log(`TikTok Ads: сохранено ${rows.length} строк расхода/лидов и ${activeCampaigns.length} активных кампаний.`);
}

main().catch((e) => {
  console.error('Ошибка сбора TikTok Ads:', e.message);
  process.exit(1);
});
