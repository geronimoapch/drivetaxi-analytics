// Забирает сделки из amoCRM: по каждой — UTM-метки, текущий этап воронки,
// признак "квалифицирован" и сумму. Сохраняет в data/raw-amocrm.json.
//
// Нужные секреты:
//   AMOCRM_BASE_URL      например https://drivetaxialmaty.amocrm.ru
//   AMOCRM_ACCESS_TOKEN  долгоживущий токен приватной интеграции
//
// Названия UTM-полей и этапа "Квалифицирован" ищутся по имени автоматически —
// не нужно вручную прописывать числовые ID, они могут отличаться в разных
// аккаунтах amoCRM.

const fs = require('fs');
const path = require('path');

const { AMOCRM_BASE_URL, AMOCRM_ACCESS_TOKEN } = process.env;

function authHeaders() {
  return { Authorization: `Bearer ${AMOCRM_ACCESS_TOKEN}` };
}

async function amoGet(pathname, params = {}) {
  const url = new URL(pathname, AMOCRM_BASE_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw new Error(`amoCRM ${pathname} error: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

// Находит все воронки и их этапы, чтобы определить ID этапа "Квалифицирован"
// в каждой воронке (название может быть с любым регистром/пробелами).
async function loadPipelines() {
  const data = await amoGet('/api/v4/leads/pipelines');
  const pipelines = data._embedded.pipelines;
  const qualifiedStageIdsByPipeline = {};
  const stageNamesById = {};

  pipelines.forEach((p) => {
    p._embedded.statuses.forEach((s) => {
      stageNamesById[s.id] = s.name;
      if (/квалифиц/i.test(s.name)) {
        qualifiedStageIdsByPipeline[p.id] = s.id;
      }
    });
  });

  return { pipelines, qualifiedStageIdsByPipeline, stageNamesById };
}

// Находит ID кастомных полей сделки, где лежат UTM-метки.
async function loadUtmFieldIds() {
  const data = await amoGet('/api/v4/leads/custom_fields', { limit: 250 });
  const fields = data._embedded?.custom_fields || [];
  const map = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach((key) => {
    const found = fields.find((f) => f.code === key.toUpperCase() || new RegExp(key, 'i').test(f.name));
    if (found) map[key] = found.id;
  });
  return map;
}

function getCustomFieldValue(lead, fieldId) {
  const cf = (lead.custom_fields_values || []).find((f) => f.field_id === fieldId);
  if (!cf) return null;
  return cf.values?.[0]?.value ?? null;
}

async function loadAllLeads() {
  const leads = [];
  let page = 1;
  const limit = 250;
  while (true) {
    let data;
    try {
      data = await amoGet('/api/v4/leads', { page, limit, with: 'contacts' });
    } catch (e) {
      if (e.message.includes('HTTP 204')) break; // amoCRM отдаёт 204, когда страницы закончились
      throw e;
    }
    const chunk = data._embedded?.leads || [];
    if (chunk.length === 0) break;
    leads.push(...chunk);
    if (chunk.length < limit) break;
    page += 1;
  }
  return leads;
}

async function main() {
  if (!AMOCRM_BASE_URL || !AMOCRM_ACCESS_TOKEN) {
    console.error('Не заданы переменные окружения для amoCRM — пропускаю сбор (заполните Secrets в репозитории).');
    fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'raw-amocrm.json'), JSON.stringify({ rows: [], skipped: true }, null, 2));
    return;
  }

  const [{ qualifiedStageIdsByPipeline, stageNamesById }, utmFieldIds] = await Promise.all([
    loadPipelines(),
    loadUtmFieldIds(),
  ]);

  const leads = await loadAllLeads();

  const normalized = leads.map((lead) => ({
    id: lead.id,
    name: lead.name,
    price: lead.price || 0,
    pipelineId: lead.pipeline_id,
    statusId: lead.status_id,
    statusName: stageNamesById[lead.status_id] || null,
    isQualified: qualifiedStageIdsByPipeline[lead.pipeline_id] === lead.status_id,
    createdAt: lead.created_at,
    utmSource: utmFieldIds.utm_source ? getCustomFieldValue(lead, utmFieldIds.utm_source) : null,
    utmMedium: utmFieldIds.utm_medium ? getCustomFieldValue(lead, utmFieldIds.utm_medium) : null,
    utmCampaign: utmFieldIds.utm_campaign ? getCustomFieldValue(lead, utmFieldIds.utm_campaign) : null,
    utmContent: utmFieldIds.utm_content ? getCustomFieldValue(lead, utmFieldIds.utm_content) : null,
  }));

  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'raw-amocrm.json'),
    JSON.stringify({ rows: normalized, skipped: false }, null, 2)
  );
  console.log(`amoCRM: сохранено ${normalized.length} сделок.`);
}

main().catch((e) => {
  console.error('Ошибка сбора amoCRM:', e.message);
  process.exit(1);
});
