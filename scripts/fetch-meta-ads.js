// Забирает расход, лиды (results) и дневной бюджет по кампаниям Meta Ads
// за последние 30 дней и сохраняет сырые данные в data/raw-meta-ads.json.
// Важно: Meta отдаёт цифры в валюте рекламного кабинета (у нас это доллары),
// поэтому поля называются spendUsd / dailyBudgetUsd. Дашборд показывает
// суммы как есть, в долларах, без перевода в тенге.
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
  // effective_status учитывает не только статус самой кампании, но и то, что она
  // могла быть остановлена на уровне аккаунта/расписания — берём только реально включённые.
  const url = `https://graph.facebook.com/${API_VERSION}/${META_AD_ACCOUNT_ID}/campaigns` +
    `?fields=id,name,daily_budget,effective_status&effective_status=["ACTIVE"]&limit=500&access_token=${META_ACCESS_TOKEN}`;
  const r = await fetch(url);
  const d = await r.json();
  if (!r.ok || d.error) throw new Error('Meta API error
