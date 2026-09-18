// Забирает расход, лиды (results) и дневной бюджет по кампаниям Meta Ads
// за последние 30 дней и сохраняет сырые данные в data/raw-meta-ads.json.
//
// Нужные секреты:
//   META_ACCESS_TOKEN   (долгоживущий токен доступа к рекламному кабинету)
//   META_AD_ACCOUNT_ID  (вида act_1234567890)

const fs = require('fs');
const path = require('path');

const { META_ACCESS_TOKEN, META_AD_ACCOUNT_ID } = process.env;
const API_VERSION = 'v21.0';

async function fetchInsights() {
  const fields = [
    'campaign_id',
    'campaign_name',
    'spend',
    'actions',
    'cost_per_action_type',
    'date_start',
  ].join(',');

  const url = `https://graph.facebook.com/${API_VERSION}/${META_AD_ACCOUNT_ID}/insights` +
    `?level=campaign&time_range={"since":"${last30DaysAgo()}","until":"${today()}"}` +
    `&time_increment=1&fields=${fields}&access_token=${META_ACCESS_TOKEN}`;

  const r = await fetch(url);
  const d = await r.json();
  if (!r.ok || d.error) throw new Error('Meta API error: ' + JSON.stringify(d.error || d));
  return d.data || [];
}

async function fetchDailyBudgets() {
  const url = `https://graph.facebook.com/${API_VERSION}/${META_AD_ACCOUNT_ID}/campaigns` +
    `?fields=id,name,daily_budget,status&access_token=${META_ACCESS_TOKEN}`;
  const r = await fetch(url);
  const d = await r.json();
  if (!r.ok || d.error) throw new Error('Meta API error (budgets): ' + JSON.stringify(d.error || d));
  return d.data || [];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
function last30DaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

function extractLeads(actions) {
  if (!Array.isArray(actions)) return 0;
  const leadAction = actions.find((a) => a.action_type === 'lead' || a.action_type === 'offsite_conversion.fb_pixel_lead');
  return leadAction ? Number(leadAction.value) : 0;
}

async function main() {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    console.error('Не заданы переменные окружения для Meta Ads — пропускаю сбор (заполните Secrets в репозитории).');
    fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'raw-meta-ads.json'), JSON.stringify({ rows: [], skipped: true }, null, 2));
    return;
  }

  const [insights, budgets] = await Promise.all([fetchInsights(), fetchDailyBudgets()]);
  const budgetByCampaign = {};
  budgets.forEach((b) => { budgetByCampaign[b.id] = Number(b.daily_budget || 0); });

  const normalized = insights.map((r) => ({
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    date: r.date_start,
    spendTenge: Number(r.spend || 0),
    leads: extractLeads(r.actions),
    dailyBudgetTenge: budgetByCampaign[r.campaign_id] || 0,
  }));

  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'raw-meta-ads.json'),
    JSON.stringify({ rows: normalized, skipped: false }, null, 2)
  );
  console.log(`Meta Ads: сохранено ${normalized.length} строк.`);
}

main().catch((e) => {
  console.error('Ошибка сбора Meta Ads:', e.message);
  process.exit(1);
});
