// Сводит raw-google-ads.json + raw-meta-ads.json + raw-amocrm.json в один
// файл data/data.json, который читает дашборд (index.html).
//
// Google Ads и Meta Ads отдают расход и бюджет в долларах (валюта рекламных
// кабинетов) — оставляем как есть, без пересчёта в тенге.
//
// Данные по расходу/лидам сохраняются ПОДНЕВНО (daily: [{date, spend, leads}]),
// а не одной суммой — дашборд сам считает нужный период (сегодня/вчера/7 дней/
// этот месяц/прошлый месяц/произвольный диапазон) прямо в браузере.

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');

function readJson(file, fallback) {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Схлопывает построчные данные (может быть несколько кампаний в один день)
// в один ряд на дату: { date, spend, leads }.
function toDailySeries(rows, spendField, leadsField) {
  const byDate = {};
  rows.forEach((r) => {
    const date = r.date;
    if (!byDate[date]) byDate[date] = { date, spend: 0, leads: 0 };
    byDate[date].spend += Number(r[spendField] || 0);
    byDate[date].leads += Number(r[leadsField] || 0);
  });
  return Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
}

function main() {
  const googleRaw = readJson('raw-google-ads.json', { rows: [] });
  const metaRaw = readJson('raw-meta-ads.json', { rows: [] });
  const amo = readJson('raw-amocrm.json', { rows: [] }).rows;

  const channels = {
    google: {
      name: 'Google Ads',
      currency: 'USD',
      dailyBudget: googleRaw.totalActiveDailyBudgetUsd || 0,
      daily: toDailySeries(googleRaw.rows || [], 'costUsd', 'conversions'),
    },
    meta: {
      name: 'Meta Ads',
      currency: 'USD',
      dailyBudget: metaRaw.totalActiveDailyBudgetUsd || 0,
      daily: toDailySeries(metaRaw.rows || [], 'spendUsd', 'leads'),
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
  console.log('data.json собран. Каналы:', Object.keys(channels).join(', '), '| дней данных Google:', channels.google.daily.length, '| дней данных Meta:', channels.meta.daily.length);
}

main();
