// Runs scenarios against an approach and a model and writes one raw record per run.
//
//   node eval/run.mjs --tag dev1 --split dev --approach agent,baseline --model gemma --reps 3
//   node eval/run.mjs --tag oracle --approach oracle
//
// Options: --only S01,S02  --concurrency 3  --cap 2.5 (US dollars for the whole evaluation, all tags together)
import fs from 'node:fs';
import path from 'node:path';
import { SCENARIOS } from './scenarios.mjs';
import { makeRest, Spend, NEURON_USD } from './rest.mjs';
import { buildWorld, runAgent, runBaseline, runOracle, measure, negativeWeather } from './world.mjs';
import { MODELS } from '../src/agent/model.js';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []));
const tag = args.tag ?? 'scratch';
const approaches = (args.approach ?? 'agent').split(',');
const models = (approaches.includes('oracle') || approaches.includes('negative')) && !args.model ? ['gemma'] : (args.model ?? 'gemma').split(',');
const reps = Number(args.reps ?? 3);
const concurrency = Number(args.concurrency ?? 3);
const only = args.only ? new Set(args.only.split(',')) : null;
const scenarios = SCENARIOS.filter((s) => (!args.split || s.split === args.split) && (!only || only.has(s.id)) && (!approaches.includes('negative') || s.negative));
const root = new URL('./results/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const outDir = path.join(root, tag, 'runs');
fs.mkdirSync(outDir, { recursive: true });
const spend = new Spend(path.join(root, 'spend.json'), Number(args.cap ?? 2.5));
console.log(`tag=${tag} approaches=${approaches} models=${models} reps=${reps} scenarios=${scenarios.map((s) => s.id).join(',')} spent so far $${spend.usd.toFixed(3)} of $${spend.capUsd}`);

// what this tag ran with: a hash of every file that decides the agent's behaviour, and the commit it was run from
const FILES = ['src/agent/prompts.js', 'src/agent/tools.js', 'src/agent/loop.js', 'src/agent/schema.js', 'src/agent/model.js', 'src/domain/policy.js', 'src/domain/mandate.js', 'src/domain/delta.js', 'src/engine.js', 'eval/world.mjs', 'eval/scenarios.mjs'];
const hashes = Object.fromEntries(FILES.map((f) => [f, createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16)]));
let commit = null; let dirty = null;
try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); dirty = execSync('git status --porcelain -- src eval ":!eval/results"', { encoding: 'utf8' }).trim().length > 0; } catch { /* not a git checkout */ }
const metaFile = path.join(root, tag, 'meta.json');
if (!fs.existsSync(metaFile)) fs.writeFileSync(metaFile, JSON.stringify({ tag, startedAt: new Date().toISOString(), commit, uncommittedChangesInSrcOrEval: dirty, approaches, models, reps, split: args.split ?? 'all', fileHashes: hashes }, null, 1));
const jobs = [];
for (const rep of Array.from({ length: reps }, (_, i) => i + 1)) for (const model of models) for (const sc of scenarios) for (const approach of approaches) jobs.push({ sc, approach, model, rep });
const fileOf = (j) => path.join(outDir, `${j.sc.id}__${j.approach}__${['oracle', 'negative'].includes(j.approach) ? 'none' : j.model}__r${j.rep}.json`);
const todo = jobs.filter((j) => !fs.existsSync(fileOf(j)));
console.log(`${jobs.length} runs planned, ${jobs.length - todo.length} already on disk, ${todo.length} to do`);

async function one(j) {
  const t0 = Date.now();
  const rest = makeRest({ spend, tag });
  const calls = []; let lastInput = null;
  const run = async (modelId, input) => {
    const c0 = Date.now(); lastInput = input.messages;
    const res = await rest(modelId, input);
    calls.push({ modelId, ms: Date.now() - c0, usage: res.usage ?? null, finish: res.choices?.[0]?.finish_reason ?? null, message: res.choices?.[0]?.message ?? null });
    return res;
  };
  const rec = { scenario: j.sc.id, name: j.sc.name, split: j.sc.split, approach: j.approach, model: ['oracle', 'negative'].includes(j.approach) ? null : j.model, rep: j.rep, tag, startedAt: new Date().toISOString() };
  let wd;
  try {
    wd = await buildWorld(j.sc, { run, model: j.model, ...(j.approach === 'negative' ? { weather: negativeWeather(j.sc) } : {}) });
    const before = structuredClone(wd.state().plan);
    const ledgerBefore = wd.state().ledger.length;
    const out = j.approach === 'agent' ? await runAgent(j.sc, wd) : j.approach === 'baseline' ? await runBaseline(j.sc, wd, { run, model: j.model }) : await runOracle(j.sc, wd, j.approach);
    Object.assign(rec, measure(j.sc, wd, before, ledgerBefore, out), { final: out.final, stats: out.stats, trace: out.trace });
  } catch (e) {
    Object.assign(rec, { error: String(e?.message ?? e).slice(0, 300), kind: 'error', satisfied: false, ideal: false, checks: {}, refundCents: 0, unnecessaryRefundCents: 0, needsHuman: false, unnecessaryHuman: false, lossCents: 0, moneyMovedCents: 0 });
  } finally {
    wd?.stop();
  }
  const neurons = calls.reduce((n, c) => n + Number(c.usage?.neurons ?? 0), 0);
  Object.assign(rec, { ms: Date.now() - t0, modelCalls: calls.length, neurons: +neurons.toFixed(1), usd: +(neurons * NEURON_USD).toFixed(5), modelOutputs: calls, conversation: lastInput && calls.length ? [...lastInput, calls.at(-1).message] : null });
  fs.writeFileSync(fileOf(j), JSON.stringify(rec));
  console.log(`${j.sc.id} ${j.approach.padEnd(8)} ${String(j.model).padEnd(6)} r${j.rep} ${rec.satisfied ? 'PASS' : 'FAIL'} kind=${rec.kind} calls=${rec.modelCalls} ${rec.ms}ms $${rec.usd}${rec.error ? ` ERR ${rec.error}` : ''}${rec.satisfied ? '' : ` failed: ${Object.entries(rec.checks).filter(([, v]) => !v).map(([k]) => k).join('; ')}`}`);
}

let next = 0; let stop = false;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (!stop) {
    const j = todo[next++]; if (!j) return;
    if (spend.usd >= spend.capUsd) { stop = true; console.log('spend cap reached, stopping'); return; }
    await one(j);
  }
}));
spend.save();
console.log(`done. spent so far $${spend.usd.toFixed(3)} of $${spend.capUsd}`);
void MODELS;
