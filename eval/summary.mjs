// One short table over the evaluation rounds, built from the report.json files (nothing typed by hand), and spliced into
// README.md between the EVAL markers.   node eval/summary.mjs
import fs from 'node:fs';

const root = new URL('./results/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const readme = new URL('../README.md', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const rounds = [
  ['holdout', 'Round 1 holdout: 17 scenarios never used for tuning, instructions frozen at commit 34bba8d, run once'],
  ['holdout_after_fix', 'The same 17 scenarios again after one host guard was added (a new price must be one the traveler wrote); no longer unseen'],
  ['holdout_round2', 'The same 17 scenarios with the second-round instructions (the shipped version); seen before, so not a clean test'],
  ['fresh', 'Round 2: 8 new scenarios written after round 1, run once with the second-round instructions (the shipped version)'],
];
const have = rounds.filter(([n]) => fs.existsSync(`${root}${n}/report.json`));
const pct = (x) => `${(100 * x).toFixed(0)}%`;
const usd = (c) => `$${(c / 100).toFixed(0)}`;
const lines = [];
lines.push('## Evaluation: does the loop beat one call?', '');
lines.push('Same trips, same facts, same guards and simulator, two ways of deciding: the **agent loop** (tools, several rounds, simulate before submit) and a **one-call baseline** (all the facts pre-fetched into one prompt, one answer, no way to look anything up or try an option first, with the formatting help a retry would give). Two models through Workers AI: Gemma 4 26B (thinking off) and gpt-oss-120b, three runs each. Every figure is computed by a program from the raw records in `eval/results/`; the scenarios, their ground truth and their checks were written before any model ran (`eval/scenarios.mjs`), and a reference answer that meets every check plus wrong answers that fail them prove the scoring (`eval/README.md`).', '');
for (const [name, title] of have) {
  const r = JSON.parse(fs.readFileSync(`${root}${name}/report.json`, 'utf8'));
  lines.push(`**${title}**`, '', '| | runs | constraints met | every repetition met | ideal decision | refunded without need | operator loss without a yes | no decision or error | neurons per run |', '|---|---|---|---|---|---|---|---|---|');
  for (const [g, t] of Object.entries(r.table)) lines.push(`| ${t.approach === 'agent' ? 'agent loop' : 'one call'} / ${t.model} | ${t.runs} | **${pct(t.satisfied)}** | ${pct(t.allRepsSatisfied)} | ${pct(t.ideal)} | ${usd(t.unnecessaryRefundCents)} | ${usd(t.lossCents)} | ${t.stopped} | ${t.neurons.toFixed(0)} |`);
  lines.push('');
}
// the reading of the tables, with every number taken from them
const R = have.map(([name]) => JSON.parse(fs.readFileSync(`${root}${name}/report.json`, 'utf8')));
const t = (r, g) => r.table[g];
const sat = (g) => R.map((r) => pct(t(r, g).satisfied));
const versus = (a, b) => sat(a).map((x, i) => `${x} against ${sat(b)[i]}`).join('; ');
const stoppedOne = R.map((r) => t(r, 'baseline|gemma').stopped);
const stoppedLoop = R.map((r) => t(r, 'agent|gemma').stopped);
const ossAhead = R.filter((r) => t(r, 'agent|oss').satisfied > t(r, 'baseline|oss').satisfied).length;
const cell = (g, id) => R.map((r) => r.perScenario.find((x) => x.id === id)?.cells[g]).filter(Boolean).map((c) => `${c.pass} of ${c.n}`).join(', ');
lines.push(`**Reading the tables.** With the default model (Gemma) the agent loop met more constraints than one call in every round (${versus('agent|gemma', 'baseline|gemma')}). It can read the terms, try options and recover when a guard refuses an answer: the one call ended without any decision in ${Math.min(...stoppedOne)} to ${Math.max(...stoppedOne)} runs per round (of 51, or 24 in the last), the loop in at most ${Math.max(...stoppedLoop)}. With gpt-oss-120b the loop was ahead of one call in ${ossAhead} of ${R.length} rounds (${versus('agent|oss', 'baseline|oss')}), so the loop is not a free win and the model matters; Gemma is the default because it scored higher, answered faster and used about a third of the compute. Where the loop loses, the per-scenario tables show it: with Gemma it changed a booking for a 35% chance of light rain (S13, runs meeting the constraints per round: ${cell('agent|gemma', 'S13')}) and it sometimes acts on a plain question (S31, fresh round: ${cell('agent|gemma', 'S31')}), where one call did not. A change that costs the traveler money at an operator never went through without a yes in any row.`, '');
lines.push('Full tables per scenario, the method, what was changed after looking at which results, and the limits of this evaluation are in [`eval/README.md`](eval/README.md).', '');
const block = lines.join('\n');
fs.writeFileSync(`${root}SUMMARY.md`, block);
let text = fs.readFileSync(readme, 'utf8');
text = text.replace(/<!-- EVAL:BEGIN -->[\s\S]*<!-- EVAL:END -->/, `<!-- EVAL:BEGIN -->\n${block}\n<!-- EVAL:END -->`);
fs.writeFileSync(readme, text);
console.log(block);
