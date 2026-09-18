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

// То же самое, но для уже приведённых к общему виду строк { date, spend, leads }
// (используется при объединении Google + Meta в один ряд по направлению).
function toDailySeriesFromUnified(rows) {
  const byDate = {};
  rows.forEach((r) => {
    const date = r.date;
    if (!byDate[date]) byDate[date] = { date, spend: 0, leads: 0 };
    byDate[date].spend += Number(r.spend || 0);
    byDate[date].leads += Number(r.leads || 0);
  });
  return Object.values(byDate).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Направление — это текст до " - " в названии кампании, например
// "Аренда - WhatsApp" -> "Аренда". Если разделителя нет, вся кампания
// считается отдельным направлением (по своему полному имени), чтобы ничего
// не терялось из дашборда, пока не все кампании переименованы по конвенции.
function categoryFromName(name) {
  if (!name) return 'Без направления';
  const idx = name.indexOf(' - ');
  return idx === -1 ? name.trim() : name.slice(0, idx).trim();
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

  // --- Разбивка по направлениям (Аренда/Подключашка/Инвест/Еда и т.д.) ---
  // Объединяем построчные данные Google + Meta в общий вид { date, spend, leads, category },
  // группируем по направлению, и для каждого направления считаем поднедельный ряд
  // + текущий дневной лимит (только по активным прямо сейчас кампаниям/группам).
  const unifiedRows = [
    ...(googleRaw.rows || []).map((r) => ({
      date: r.date,
      spend: r.costUsd,
      leads: r.conversions,
      category: categoryFromName(r.campaignName),
    })),
    ...(metaRaw.rows || []).map((r) => ({
      date: r.date,
      spend: r.spendUsd,
      leads: r.leads,
      category: categoryFromName(r.campaignName),
    })),
  ];

  const rowsByCategory = {};
  unifiedRows.forEach((r) => {
    if (!rowsByCategory[r.category]) rowsByCategory[r.category] = [];
    rowsByCategory[r.category].push(r);
  });

  const activeBudgetByCategory = {};
  [...(googleRaw.activeCampaigns || []), ...(metaRaw.activeCampaigns || [])].forEach((c) => {
    const cat = categoryFromName(c.campaignName);
    activeBudgetByCategory[cat] = (activeBudgetByCategory[cat] || 0) + Number(c.dailyBudgetUsd || 0);
  });

  const categoryNames = new Set([...Object.keys(rowsByCategory), ...Object.keys(activeBudgetByCategory)]);
  const categories = {};
  categoryNames.forEach((cat) => {
    categories[cat] = {
      name: cat,
      currency: 'USD',
      dailyBudget: activeBudgetByCategory[cat] || 0,
      daily: toDailySeriesFromUnified(rowsByCategory[cat] || []),
    };
  });

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
    categories,
    crm: {
      totalDeals,
      totalQualified,
      stageCounts,
      byUtmSource,
    },
  };

  fs.writeFileSync(path.join(dataDir, 'data.json'), JSON.stringify(output, null, 2));
  console.log('data.json собран. Каналы:', Object.keys(channels).join(', '), '| направления:', Object.keys(categories).join(', '), '| дней данных Google:', channels.google.daily.length, '| дней данных Meta:', channels.meta.daily.length);
}

main();
