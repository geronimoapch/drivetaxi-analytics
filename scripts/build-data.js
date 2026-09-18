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
  const stageCounts = {};
  amo.forEach((lead) => {
    const key = lead.statusName || 'Без статуса';
    if (!stageCounts[key]) stageCounts[key] = { count: 0, sumTenge: 0 };
    stageCounts[key].count += 1;
    stageCounts[key].sumTenge += lead.price || 0;
  });

  // --- Сделки amoCRM: по UTM-источнику ---
  const byUtmSource = {};
  amo.forEach((lead) => {
    const key = lead.utmSource || 'без метки';
    if (!byUtmSource[key]) byUtmSource[key] = { total: 0, qualified: 0, sumTenge: 0 };
    byUtmSource[key].total += 1;
    if (lead.isQualified) byUtmSource[key].qualified += 1;
    byUtmSource[key].sumTenge += lead.price || 0;
  });

  const totalDeals = amo.length;
  const totalQualified = amo.filter((l) => l.isQualified).length;

  const output = {
    generatedAt: new Date().toISOString(),
    channels,
    crm: {
      totalDeals,
      totalQualified,
      stageCounts,
      byUtmSource,
    },
  };

  fs.writeFileSync(path.join(dataDir, 'data.json'), JSON.stringify(output, null, 2));
  console.log('data.json собран:', JSON.stringify(output, null, 2).slice(0, 300) + '...');
}

main();
