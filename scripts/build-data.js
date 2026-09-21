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

// Известные направления бизнеса. Ищем эти слова ГДЕ УГОДНО в названии
// кампании (регистр не важен) — на практике название может быть построено
// по-разному: "Аренда - Поиск", "Подключашка | Алматы",
// "Drive Taxi | Подключашка | KZ" и т.п., и слово-направление не всегда
// стоит первым.
const KNOWN_CATEGORIES = ['Аренда', 'Подключашка', 'Инвест', 'Еда'];

function categoryFromName(name) {
  if (!name) return 'Без направления';
  const lower = name.toLowerCase();
  const found = KNOWN_CATEGORIES.find((cat) => lower.includes(cat.toLowerCase()));
  if (found) return found;

  // Название не содержит ни одно известное направление — пробуем разделители
  // " - " или " | ", берём первый кусок, чтобы хотя бы похожие кампании
  // сгруппировались между собой (например, все "Яндекс ..." вместе).
  const sepMatch = name.match(/\s[-|]\s/);
  if (sepMatch) return name.slice(0, sepMatch.index).trim();

  return name.trim();
}

// Строит разбивку по направлениям (Аренда/Подключашка/Инвест/Еда) ВНУТРИ
// одного канала — то есть только по его собственным строкам/кампаниям, без
// смешивания с другим каналом. Используется отдельно для Google и для Meta,
// чтобы под каждым каналом дашборд мог показать свой раскрывающийся список
// направлений с корректным per-канальным дневным лимитом.
function buildCategoriesForChannel(rows, activeCampaigns, spendField, leadsField) {
  const rowsByCategory = {};
  (rows || []).forEach((r) => {
    const cat = categoryFromName(r.campaignName);
    if (!rowsByCategory[cat]) rowsByCategory[cat] = [];
    rowsByCategory[cat].push({ date: r.date, spend: r[spendField], leads: r[leadsField] });
  });

  const activeBudgetByCategory = {};
  (activeCampaigns || []).forEach((c) => {
    const cat = categoryFromName(c.campaignName);
    activeBudgetByCategory[cat] = (activeBudgetByCategory[cat] || 0) + Number(c.dailyBudgetUsd || 0);
  });

  const categoryNames = new Set([...Object.keys(rowsByCategory), ...Object.keys(activeBudgetByCategory)]);
  const categories = {};
  categoryNames.forEach((cat) => {
    categories[cat] = {
      name: cat,
      dailyBudget: activeBudgetByCategory[cat] || 0,
      daily: toDailySeriesFromUnified(rowsByCategory[cat] || []),
    };
  });
  return categories;
}

// Кампании, которые полностью исключаем из дашборда (не текущие продукты,
// не должны попадать никуда — ни в общий расход канала, ни в направления).
// Ищем ключевое слово где угодно в названии, регистр не важен.
const EXCLUDED_KEYWORDS = ['алишер'];

function isExcludedCampaign(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return EXCLUDED_KEYWORDS.some((kw) => lower.includes(kw));
}

function filterExcludedCampaigns(raw) {
  return {
    ...raw,
    rows: (raw.rows || []).filter((r) => !isExcludedCampaign(r.campaignName)),
    activeCampaigns: (raw.activeCampaigns || []).filter((c) => !isExcludedCampaign(c.campaignName)),
  };
}

function main() {
  const googleRaw = filterExcludedCampaigns(readJson('raw-google-ads.json', { rows: [] }));
  const metaRaw = filterExcludedCampaigns(readJson('raw-meta-ads.json', { rows: [] }));
  const amo = readJson('raw-amocrm.json', { rows: [] }).rows;

  // Пересчитываем дневной бюджет канала ПОСЛЕ исключения кампаний — нельзя
  // брать готовую сумму totalActiveDailyBudgetUsd из raw-файла, она считалась
  // ДО фильтрации и включала бы бюджет исключённых кампаний.
  const sumActiveBudget = (activeCampaigns) =>
    (activeCampaigns || []).reduce((acc, c) => acc + Number(c.dailyBudgetUsd || 0), 0);

  const channels = {
    google: {
      name: 'Google Ads',
      currency: 'USD',
      dailyBudget: sumActiveBudget(googleRaw.activeCampaigns),
      daily: toDailySeries(googleRaw.rows || [], 'costUsd', 'conversions'),
      categories: buildCategoriesForChannel(googleRaw.rows, googleRaw.activeCampaigns, 'costUsd', 'conversions'),
    },
    meta: {
      name: 'Meta Ads',
      currency: 'USD',
      dailyBudget: sumActiveBudget(metaRaw.activeCampaigns),
      daily: toDailySeries(metaRaw.rows || [], 'spendUsd', 'leads'),
      categories: buildCategoriesForChannel(metaRaw.rows, metaRaw.activeCampaigns, 'spendUsd', 'leads'),
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
  console.log(
    'data.json собран. Каналы:', Object.keys(channels).join(', '),
    '| направления Google:', Object.keys(channels.google.categories).join(', '),
    '| направления Meta:', Object.keys(channels.meta.categories).join(', '),
    '| дней данных Google:', channels.google.daily.length,
    '| дней данных Meta:', channels.meta.daily.length
  );
}

main();
