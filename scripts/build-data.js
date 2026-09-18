// Сводит raw-google-ads.json + raw-meta-ads.json + raw-amocrm.json в один
// файл data/data.json, который читает дашборд (index.html).
//
// Google Ads и Meta Ads отдают расход и бюджет в долларах (валюта рекламных
// кабинетов) — оставляем как есть, без пересчёта в тенге.

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');

function readJson(file, fallback) {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function sum(arr, fn) {
  return arr.reduce((acc, x) => acc + (fn(x) || 0), 0);
}

function main() {
  const google = readJson('raw-google-ads.json', { rows: [] }).rows;
  const meta = readJson('raw-meta-ads.json', { rows: [] }).rows;
  const amo = readJson('raw-amocrm.json', { rows: [] }).rows;

  // --- Итоги по каналам (для таблицы "Эффективность по каналам"), в долларах ---
  const channels = {
    google: {
      name: 'Google Ads',
      currency: 'USD',
      spend: sum(google, (r) => r.costUsd),
      dailyBudget: sum(
        [...new Map(google.map((r) => [r.campaignId, r])).values()],
        (r) => r.dailyBudgetUsd
      ),
      leads: sum(google, (r) => r.conversions),
    },
    meta: {
      name: 'Meta Ads',
      currency: 'USD',
      spend: sum(meta, (r) => r.spendUsd),
      dailyBudget: sum(
        [...new Map(meta.map((r) => [r.campaignId, r])).values()],
        (r) => r.dailyBudgetUsd
      ),
      leads: sum(meta, (r) => r.leads),
    },
  };

  // --- Сделки amoCRM: по этапам воронки (как на скрине CRM) ---
