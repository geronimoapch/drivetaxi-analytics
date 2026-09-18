// Забирает расход и лиды (results) по кампаниям Meta Ads за последние 30 дней
// (для истории/CPL), и ОТДЕЛЬНО — дневной бюджет по всем кампаниям, которые
// включены ПРЯМО СЕЙЧАС (не зависит от того, были ли у них траты за 30 дней —
// иначе только что созданная кампания просто выпадает из расчёта бюджета).
// Сохраняет всё в data/raw-meta-ads.json.
//
// Важно: Meta отдаёт цифры в валюте рекламного кабинета (у нас это доллары),
// поэтому поля называются spendUsd / dailyBudgetUsd. Дашборд показывает
// суммы как есть, в долларах, без перевода в тенге.
//
// Ещё важно: daily_budget у Meta приходит в минимальных единицах валюты
// (для доллара — в центах), поэтому везде делим на 100.
//
// Нужные секреты:
//   META_ACCESS_TOKEN   (долгоживущий токен доступа к рекламному кабинету)
//   META_AD_ACCOUNT_ID  (вида act_1234567890)

const fs = require('fs');
const path = require('path');

const { META_ACCESS_TOKEN, META_AD_ACCOUNT_ID } = process.env;
const API_VERSION = 'v21.0';

// effective_status передаётся как JSON-массив в query-параметре — его нужно
// закодировать через encodeURIComponent, иначе некоторые запросы к Graph API
// могут отфильтровать не так, как ожидается.
const ACTIVE_FILTER = encodeURIComponent(JSON.stringify(['ACTIVE']));

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

// Все кампании, которые включены прямо сейчас, с их бюджетом (если он задан
// на уровне кампании — например, при Campaign Budget Optimization).
async function fetchActiveCampaigns() {
  const url = `https://graph.facebook.com/${API_VERSION}/${META_AD_ACCOUNT_ID}/campaigns` +
    `?fields=id,name,daily_budget,lifetime_budget,effective_status` +
    `&effective_status=${ACTIVE_FILTER}&limit=500&access_token=${META_ACCESS_TOKEN}`;
  const r = await fetch(url);
  const d = await r.json();
  if (!r.ok || d.error) throw new Error('Meta API error (campaigns): ' + JSON.stringify(d.error || d));
  return d.data || [];
}

// Все группы объявлений, которые включены прямо сейчас — нужны на случай,
// если у кампании бюджет не на её уровне, а разложен по группам объявлений.
async function fetchActiveAdsets() {
  const url = `https://graph.facebook.com/${API_VERSION}/${META_AD_ACCOUNT_ID}/adsets` +
    `?fields=id,name,campaign_id,daily_budget,lifetime_budget,effective_status` +
    `&effective_status=${ACTIVE_FILTER}&limit=500&access_token=${META_ACCESS_TOKEN}`;
  const r = await fetch(url);
  const d = await r.json();
  if (!r.ok || d.error) throw new Error('Meta API error (adsets): ' + JSON.stringify(d.error || d));
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

// Центы -> доллары.
function centsToUsd(v) {
  return Number(v || 0) / 100;
}

async function main() {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    console.error('Не заданы переменные окружения для Meta Ads — пропускаю сбор (заполните Secrets в репозитории).');
    fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'raw-meta-ads.json'), JSON.stringify({ rows: [], activeCampaigns: [], totalActiveDailyBudgetUsd: 0, skipped: true }, null, 2));
    return;
  }

  const [insights, campaigns, adsets] = await Promise.all([
    fetchInsights(),
    fetchActiveCampaigns(),
    fetchActiveAdsets(),
  ]);

  // Бюджеты групп объявлений, просуммированные по родительской кампании.
  const adsetBudgetByCampaign = {};
  adsets.forEach((a) => {
    const budget = centsToUsd(a.daily_budget);
    if (!budget) return;
    adsetBudgetByCampaign[a.campaign_id] = (adsetBudgetByCampaign[a.campaign_id] || 0) + budget;
  });

  // По каждой включённой прямо сейчас кампании считаем её реальный дневной
  // бюджет: сначала пробуем бюджет самой кампании (CBO), если он не задан —
  // берём сумму бюджетов её активных групп объявлений.
  const activeCampaigns = campaigns.map((c) => {
    const campaignBudget = centsToUsd(c.daily_budget);
    const dailyBudgetUsd = campaignBudget || adsetBudgetByCampaign[c.id] || 0;
    return {
      campaignId: c.id,
      campaignName: c.name,
      effectiveStatus: c.effective_status,
      dailyBudgetUsd,
    };
  });

  const totalActiveDailyBudgetUsd = activeCampaigns.reduce((acc, c) => acc + c.dailyBudgetUsd, 0);

  // Печатаем в лог, чтобы всегда можно было свериться, что реально пришло от Meta.
  console.log('Активные кампании и их дневной бюджет:');
  activeCampaigns.forEach((c) => {
    console.log(`  - ${c.campaignName} (${c.campaignId}): $${c.dailyBudgetUsd} [${c.effectiveStatus}]`);
  });
  console.log(`Итого дневной бюджет по активным кампаниям: $${totalActiveDailyBudgetUsd}`);

  const rows = insights.map((r) => ({
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    date: r.date_start,
    spendUsd: Number(r.spend || 0),
    leads: extractLeads(r.actions),
  }));

  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'raw-meta-ads.json'),
    JSON.stringify({ rows, activeCampaigns, totalActiveDailyBudgetUsd, skipped: false }, null, 2)
  );
  console.log(`Meta Ads: сохранено ${rows.length} строк расхода/лидов и ${activeCampaigns.length} активных кампаний.`);
}

main().catch((e) => {
  console.error('Ошибка сбора Meta Ads:', e.message);
  process.exit(1);
});
