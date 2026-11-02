// Read-only retrieval clients and deterministic computations. No agent logic here.
import { readFileSync } from 'node:fs';

const DATA = new URL('../data/', import.meta.url);
const UA = { 'user-agent': 'switch-dossier/0.1 (research tool)' };

export async function fetchRaw(url, { timeout = 20000, retries = 2 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
      if (res.status === 404) return { status: 404, text: '' };
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, text: await res.text() };
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw new Error(`${url.split('?')[0]} failed: ${last.message}`);
}
const getJson = async (url, opts) => {
  const r = await fetchRaw(url, opts);
  return r.status === 404 ? null : JSON.parse(r.text);
};

export const clean = (s) => String(s).replace(/["\\]/g, ' ').trim();

// ---------- openFDA ----------
export async function openfdaLabels(search, limit = 25) {
  const j = await getJson(`https://api.fda.gov/drug/label.json?search=${encodeURIComponent(search)}&limit=${limit}`);
  return j?.results ?? [];
}
export async function openfdaDrugsFda(search, limit = 100) {
  const j = await getJson(`https://api.fda.gov/drug/drugsfda.json?search=${encodeURIComponent(search)}&limit=${limit}`);
  return { results: j?.results ?? [], total: j?.meta?.results?.total ?? 0 };
}

const LABEL_FIELDS = [
  'indications_and_usage', 'dosage_and_administration', 'dosage_forms_and_strengths', 'description',
  'inactive_ingredient', 'how_supplied', 'storage_and_handling', 'boxed_warning', 'contraindications',
  'warnings_and_cautions', 'warnings', 'package_label_principal_display_panel', 'spl_unclassified_section',
];
export function labelText(r) {
  const parts = [];
  for (const f of LABEL_FIELDS) {
    const v = r[f];
    if (!v) continue;
    parts.push(`## ${f}\n${(Array.isArray(v) ? v.join('\n') : String(v)).slice(0, 8000)}`);
  }
  return parts.join('\n\n');
}

// ---------- PubMed ----------
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
export async function pubmedSearch(term, retmax = 10) {
  const j = await getJson(`${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=${retmax}&sort=relevance&term=${encodeURIComponent(term)}`);
  return j?.esearchresult?.idlist ?? [];
}
const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x?[0-9a-f]+;/gi, ' ').replace(/&amp;/g, '&');
export async function pubmedFetch(ids) {
  if (!ids.length) return [];
  const { text } = await fetchRaw(`${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&id=${ids.join(',')}`, { timeout: 30000 });
  const out = [];
  for (const art of text.split('<PubmedArticle>').slice(1)) {
    const pmid = art.match(/<PMID[^>]*>(\d+)<\/PMID>/)?.[1];
    const title = decode(art.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)?.[1] ?? '');
    const abstract = [...art.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)]
      .map((m) => {
        const label = m[1].match(/Label="([^"]+)"/)?.[1];
        return (label ? `${label}: ` : '') + decode(m[2]);
      }).join(' ');
    const journal = decode(art.match(/<Title>([\s\S]*?)<\/Title>/)?.[1] ?? '');
    const year = art.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/)?.[1] ?? art.match(/<MedlineDate>(\d{4})/)?.[1] ?? '';
    if (pmid) out.push({ pmid, title, abstract, journal, year });
  }
  return out;
}

// ---------- ClinicalTrials.gov ----------
export async function ctgovSearch(term, pageSize = 10) {
  const fields = 'NCTId,BriefTitle,OverallStatus,Phase,EnrollmentCount,StudyType';
  const j = await getJson(`https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(term)}&pageSize=${pageSize}&fields=${fields}`);
  return (j?.studies ?? []).map((s) => ({
    nct: s.protocolSection?.identificationModule?.nctId,
    title: s.protocolSection?.identificationModule?.briefTitle,
    status: s.protocolSection?.statusModule?.overallStatus,
    phase: (s.protocolSection?.designModule?.phases ?? []).join('/') || null,
    enrollment: s.protocolSection?.designModule?.enrollmentInfo?.count ?? null,
  })).filter((s) => s.nct);
}

// ---------- NADAC (data.medicaid.gov) ----------
let nadacCache;
async function nadacDatasetId() {
  if (nadacCache && Date.now() - nadacCache.at < 864e5) return nadacCache;
  const items = await getJson('https://data.medicaid.gov/api/1/metastore/schemas/dataset/items?show-reference-ids=false', { timeout: 40000 });
  let best;
  for (const i of items ?? []) {
    const m = i.title?.match(/^NADAC \(National Average Drug Acquisition Cost\) (\d{4})$/);
    if (m && (!best || +m[1] > best.year)) best = { year: +m[1], id: i.identifier };
  }
  if (!best) throw new Error('NADAC dataset not found');
  return (nadacCache = { ...best, at: Date.now() });
}
export async function nadacRows(name, limit = 60) {
  const ds = await nadacDatasetId();
  const qs = new URLSearchParams({
    'conditions[0][property]': 'ndc_description', 'conditions[0][value]': `%${name.toUpperCase()}%`, 'conditions[0][operator]': 'LIKE',
    'sort[0][property]': 'effective_date', 'sort[0][order]': 'desc', limit: String(limit),
  });
  const j = await getJson(`https://data.medicaid.gov/api/1/datastore/query/${ds.id}/0?${qs}`, { timeout: 40000 });
  return { year: ds.year, rows: (j?.results ?? []).map((r) => ({
    ndc: r.ndc, description: r.ndc_description, perUnit: parseFloat(r.nadac_per_unit), unit: r.pricing_unit,
    effective: r.effective_date, cls: r.classification_for_rate_setting,
  })) };
}

// ---------- reference tables ----------
const readJson = (f) => JSON.parse(readFileSync(new URL(f, DATA), 'utf8'));
export const stateRules = () => readJson('state_rules.json');
export const interchangeOverrides = () => readJson('interchangeability_overrides.json').entries ?? {};

// ---------- deterministic computations ----------
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function parseDose(text) {
  if (!text?.trim()) return null;
  const t = text.toLowerCase();
  const amt = t.match(/(\d+(?:\.\d+)?)\s*(mg\/kg|mcg|mg|g|units?|iu)\b/);
  let perYear = null;
  let m;
  if ((m = t.match(/every\s*(\d+)\s*(day|week|month)s?/)) || (m = t.match(/q\s*(\d+)\s*(d|w|m)\b/))) {
    const n = +m[1], u = m[2][0];
    perYear = (u === 'd' ? 365 : u === 'w' ? 52 : 12) / n;
  } else if (/twice\s+(a\s+)?(daily|day)|\bbid\b/.test(t)) perYear = 730;
  else if (/three times|\btid\b/.test(t)) perYear = 1095;
  else if (/once\s+(a\s+)?week|weekly|\bqw\b/.test(t)) perYear = 52;
  else if (/monthly|once\s+(a\s+)?month/.test(t)) perYear = 12;
  else if (/daily|once\s+(a\s+)?day|\bqd\b/.test(t)) perYear = 365;
  return { raw: text.trim(), amount: amt ? +amt[1] : null, unit: amt ? amt[2] : null, perYear: perYear ? Math.round(perYear * 100) / 100 : null };
}

function strengthOf(desc) {
  const m = desc.match(/(\d+(?:\.\d+)?)\s*(MG|MCG|UNITS?|IU)\b/i);
  return m ? { amount: +m[1], unit: m[2].toLowerCase().replace(/s$/, '') } : null;
}
// Annual cost per patient from NADAC rows whose strength divides the dose evenly.
export function annualCost({ rows, dose }) {
  if (!dose?.amount || !dose.perYear || dose.unit === 'mg/kg') return { ok: false, reason: dose?.unit === 'mg/kg' ? 'weight-based dose needs patient weight' : 'dose amount or frequency could not be parsed' };
  const du = dose.unit.replace(/s$/, '');
  const usable = [];
  for (const r of rows) {
    if (!Number.isFinite(r.perUnit) || r.unit === 'ML' || /\bML\b.*\bML\b/.test(r.description) && r.unit === 'ML') continue;
    const s = strengthOf(r.description);
    if (!s || s.unit !== du) continue;
    const ratio = dose.amount / s.amount;
    if (ratio >= 1 && Math.abs(ratio - Math.round(ratio)) < 1e-6) usable.push({ ...r, unitsPerAdmin: Math.round(ratio) });
  }
  if (!usable.length) return { ok: false, reason: 'no NADAC rows with a strength matching the dose' };
  const perAdmin = median(usable.map((r) => r.perUnit * r.unitsPerAdmin));
  return { ok: true, perAdmin: round(perAdmin), annual: round(perAdmin * dose.perYear), rowsUsed: usable.length, ndcs: usable.map((r) => r.ndc) };
}
const round = (n) => Math.round(n * 100) / 100;

export function addYears(iso, y) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + y);
  return d.toISOString().slice(0, 10);
}
// BPCIA statutory floor for a reference biologic: 4-year filing bar, 12-year approval bar.
export function bpciaExclusivity({ approval }) {
  return { filingBarEnds: addYears(approval, 4), referenceExclusivityEnds: addYears(approval, 12) };
}
export const earliestDate = ({ dates }) => dates.slice().sort()[0] ?? null;

export const savings = ({ orig, alt }) => ({ amount: round(orig - alt), pct: round((100 * (orig - alt)) / orig) });
export const COMPUTE = { annualCost, bpciaExclusivity, earliestDate, savings };

export const isoDate = (yyyymmdd) => (yyyymmdd && /^\d{8}$/.test(yyyymmdd) ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}` : null);
