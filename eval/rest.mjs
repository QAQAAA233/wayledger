// The model, reached over Workers AI's REST endpoint instead of the Worker's AI binding. It answers in the same shape
// (`result.choices[0].message`, `result.usage.neurons`), so the agent code under test runs unchanged: `run(modelId, input)`.
// Every call is counted in neurons; a spend cap stops the evaluation before it can cost more than agreed.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ACCOUNT = '5ba971c84e2588c4ba3c72a5821ae21f';
export const NEURON_USD = 0.011 / 1000;

function readToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const cfg = fs.readFileSync(path.join(process.env.APPDATA, 'xdg.config', '.wrangler', 'config', 'default.toml'), 'utf8');
  return cfg.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
}

// Neurons already used by this evaluation, kept in a file so that several runs add up against one cap.
export class Spend {
  constructor(file, capUsd) {
    this.file = file; this.capUsd = capUsd;
    const d = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    // eval/spend.mjs rewrites the file from the run records (several runs at once overwrite each other's counters)
    this.data = { neurons: d.neurons ?? (d.totalUsd ? d.totalUsd / NEURON_USD : 0), calls: d.calls ?? 0, byTag: d.byTag ?? {} };
    this.dirty = 0;
  }
  get usd() { return this.data.neurons * NEURON_USD; }
  add(tag, model, neurons) {
    this.data.neurons += neurons; this.data.calls += 1;
    const t = (this.data.byTag[tag] ??= { neurons: 0, calls: 0, byModel: {} });
    t.calls ??= 0; t.byModel ??= {};
    t.neurons += neurons; t.calls += 1; t.byModel[model] = (t.byModel[model] ?? 0) + neurons;
    if (++this.dirty >= 10) this.save();
    if (this.usd >= this.capUsd) { this.save(); throw Object.assign(new Error(`The evaluation spend cap of $${this.capUsd} was reached ($${this.usd.toFixed(3)}).`), { code: 'BUDGET_CAP' }); }
  }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ ...this.data, usd: +this.usd.toFixed(4), capUsd: this.capUsd }, null, 1)); this.dirty = 0; }
}

export function makeRest({ spend, tag }) {
  let token = readToken();
  const refresh = () => { spawnSync(process.execPath, [path.resolve('node_modules/wrangler/bin/wrangler.js'), 'whoami'], { encoding: 'utf8', timeout: 60_000 }); token = readToken(); };
  return async function run(modelId, input) {
    for (let attempt = 1; ; attempt++) {
      let res; let body;
      try {
        res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${modelId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(100_000) });
        body = await res.json().catch(() => ({}));
      } catch (e) {
        if (attempt >= 4) throw new Error(`network: ${String(e?.message ?? e).slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      if (res.status === 401 || res.status === 403) { if (attempt >= 3) throw new Error(`auth ${res.status}: ${JSON.stringify(body.errors ?? []).slice(0, 160)}`); refresh(); continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
      if (!res.ok || body.success === false) throw new Error(`api ${res.status}: ${JSON.stringify(body.errors ?? body).slice(0, 200)}`);
      const result = body.result;
      spend.add(tag, modelId, Number(result?.usage?.neurons ?? 0));
      return result;
    }
  };
}
