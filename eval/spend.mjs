// What the evaluation cost, recomputed from the raw run records (each model answer carries its own usage). This is the figure to
// trust: results/spend.json is rewritten from it, because several runs at once overwrite each other's running counters.
//   node eval/spend.mjs
import fs from 'node:fs';

const root = new URL('./results/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const NEURON_USD = 0.011 / 1000;
const byTag = {};
for (const tag of fs.readdirSync(root).filter((d) => fs.existsSync(`${root}${d}/runs`)).sort()) {
  let neurons = 0; let runs = 0;
  for (const f of fs.readdirSync(`${root}${tag}/runs`)) { const r = JSON.parse(fs.readFileSync(`${root}${tag}/runs/${f}`, 'utf8')); neurons += r.neurons ?? 0; runs++; }
  byTag[tag] = { runs, neurons: Math.round(neurons), usd: +(neurons * NEURON_USD).toFixed(3) };
}
// the two schema probes (eval/schema_probe.mjs) are not run records: about 90 short calls each
const probes = { neurons: 1450, usd: +(1450 * NEURON_USD).toFixed(3) };
const total = Object.values(byTag).reduce((n, t) => n + t.usd, 0) + probes.usd;
const out = { note: 'Gross Workers AI cost in US dollars before the 10,000 free neurons a day, recomputed from the run records by eval/spend.mjs', byTag, schemaProbes: probes, totalUsd: +total.toFixed(2) };
fs.writeFileSync(`${root}spend.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
