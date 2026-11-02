// Runs the read-only retrieval clients for one drug and saves raw results to samples/.
// Usage: node scripts/sample_retrieval.mjs infliximab
import { writeFileSync } from 'node:fs';
import { openfdaLabels, openfdaDrugsFda, pubmedSearch, pubmedFetch, ctgovSearch, nadacRows, parseDose, annualCost } from '../lib/tools.js';

const drug = process.argv[2] ?? 'infliximab';
const out = { drug, retrievedAt: new Date().toISOString() };

const labels = await openfdaLabels(`openfda.generic_name:${drug}*`, 50);
out.labels = labels.map((l) => ({
  brand: l.openfda?.brand_name?.[0], generic: l.openfda?.generic_name?.[0], manufacturer: l.openfda?.manufacturer_name?.[0],
  application: l.openfda?.application_number?.[0], setId: l.set_id, effective: l.effective_time,
}));
const fda = await openfdaDrugsFda(`openfda.generic_name:${drug}*`, 50);
out.drugsFda = { total: fda.total, applications: fda.results.map((r) => ({ application: r.application_number, sponsor: r.sponsor_name, products: r.products?.map((p) => ({ brand: p.brand_name, status: p.marketing_status })) })) };

const ids = await pubmedSearch(`"${drug}"[tiab] AND (biosimilar[tiab] OR generic[tiab]) AND (switch*[tiab] OR interchangeab*[tiab])`, 8);
out.pubmed = await pubmedFetch(ids);
out.trials = await ctgovSearch(`${drug} AND (switch OR switching OR interchangeability)`, 8);
const nadac = await nadacRows(drug, 20);
out.nadac = nadac;
out.costExample = annualCost({ rows: nadac.rows, dose: parseDose('40 mg every 2 weeks') });

writeFileSync(new URL(`../samples/retrieval_${drug}.json`, import.meta.url), JSON.stringify(out, null, 2));
console.log(`labels=${out.labels.length} drugsfda=${fda.total} pubmed=${out.pubmed.length} trials=${out.trials.length} nadacRows=${nadac.rows.length}`);
