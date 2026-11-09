// One short table over the evaluation rounds, built from the report.json files (nothing typed by hand), and spliced into
// README.md between the EVAL markers.   node eval/summary.mjs
import fs from 'node:fs';

const root = new URL('./results/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const readme = new URL('../README.md', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const rounds = [
  ['holdout', 'Round 1 holdout: 17 scenarios never used for tuning, instructions frozen at commit 34bba8d, run once'],
  ['holdout_after_fix', 'The same 17 scenarios again after one host guard was added (a new price must be one the traveler wrote); no longer unseen'],
  ['fresh', 'Round 2: 8 new scenarios written after round 1, run once with the second-round instructions'],
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
lines.push('Full tables per scenario, the method, what was changed after looking at which results, and the limits of this evaluation are in [`eval/README.md`](eval/README.md).', '');
const block = lines.join('\n');
fs.writeFileSync(`${root}SUMMARY.md`, block);
let text = fs.readFileSync(readme, 'utf8');
text = text.replace(/<!-- EVAL:BEGIN -->[\s\S]*<!-- EVAL:END -->/, `<!-- EVAL:BEGIN -->\n${block}\n<!-- EVAL:END -->`);
fs.writeFileSync(readme, text);
console.log(block);
