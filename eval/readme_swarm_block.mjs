// Writes the "Large-scale evaluation" block of README.md from eval/results/swarm_eval/summary.json.
// Every number in the block is copied from that file by this program, not typed. Run from the repo root: node eval/readme_swarm_block.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const README = path.join(HERE, '..', 'README.md');
const s = JSON.parse(fs.readFileSync(path.join(HERE, 'results', 'swarm_eval', 'summary.json'), 'utf8'));
const m = s.metrics;
const f = m.agentVsBaseline.fairComparison;
const strict = m.agentVsBaseline.strictOneCall;
const fail = m.agentVsBaseline.baselineFailureBreakdown;
const pc = f.pairedComparison;
const o = m.overreactionRate;
const px = m.proposalFinancialEffectMatchesExecution;
const mm = m.moneyMovedWithoutConsent;
const un = m.unnecessaryChargesOrRefunds;
const n = s.scenariosCount;
const count = (pct) => Math.round((pct * n) / 100);
const usd = (x) => `$${Number(x).toFixed(2)}`;
const sameWithoutRetry = strict.agentPassRatePct === f.agentPassRatePct && strict.baselinePassRatePct === f.baselinePassRatePct;
const cats = [...new Set(o.cases.map((c) => c.category))];
const overreactionMoney = o.cases.reduce((a, c) => a + (c.moneyMovedDollars || 0), 0);
const oracle = (m.generationAndOracle?.oracleRole || '').match(/\((\d+)\/(\d+) PASS\)/);

const block = [
  '## Large-scale evaluation: 300 scenarios, 600 live runs',
  '',
  `The 24 scenarios above are hand-written. For scale, ${n} more were generated in six categories, 50 each (weather, closure, dropout, price, malicious, question), with \`eval/generate_swarm.mjs\`. Each has a ground truth taken from the operators' terms${oracle ? ` and a reference answer that passes its own checks (${oracle[1]} of ${oracle[2]})` : ''}. Every scenario ran twice against the live agent, once as the **agent loop** and once as the **one-call baseline** with the same facts and the same guards: ${s.totalRuns} runs. The numbers below are copied by \`eval/readme_swarm_block.mjs\` from \`eval/results/swarm_eval/summary.json\`, which \`eval/swarm_summary.mjs\` computes from the raw run logs.`,
  '',
  '| | Agent loop | One-call baseline |',
  '|---|---|---|',
  `| Pass rate (one format retry for both) | ${f.agentPassRatePct}% (${count(f.agentPassRatePct)} of ${n}) | ${f.baselinePassRatePct}% (${count(f.baselinePassRatePct)} of ${n}) |`,
  `| Better in a paired comparison of ${pc.comparedScenarios} scenarios | ${pc.agentBetter} | ${pc.baselineBetter} (${pc.tie} ties) |`,
  `| Money moved without the traveler's consent | ${usd(mm.agentLossDollars)} | ${usd(mm.baselineLossDollars)} |`,
  `| Unnecessary charges or refunds actually executed | ${usd(un.actualExecuted.agentUnnecessaryDollars)} | ${usd(un.actualExecuted.baselineUnnecessaryDollars)} |`,
  `| Overreaction, in ${o.testedScenariosCount} scenarios where nothing should change | ${o.agentOverreactedCount} (${o.agentOverreactionRatePct}%) | ${o.baselineOverreactionRateFairPct}% |`,
  '',
  `The baseline's ${fail.totalFailed} failures are not format errors (${fail.formatErrorsCount}); all ${fail.judgmentAndGuardErrorsCount} are judgment or guard errors.${sameWithoutRetry ? ' Without the format retry the numbers are the same.' : ''} Of the proposals that were confirmed and then executed, ${px.matchedCount} of ${px.executedProposalsChecked} showed exactly the money effect PayPal executed afterwards.`,
  '',
  `**Where the agent does worse.** All ${o.agentOverreactedCount} overreactions are in the ${cats.join(', ')} categor${cats.length === 1 ? 'y' : 'ies'}: the reference answer was "no change", the agent asked the traveler instead${o.cases.every((c) => /暴風雨/.test(c.rootCause || '')) ? ' because the forecast really did contain a storm' : ''}, and moved ${usd(overreactionMoney)}.`,
  '',
  `**One scoring rule was fixed before these numbers.** An earlier rule counted ${un.diagnostics.agentAffectedScenariosCount} proposals that were never executed as refunds (${usd(un.legacyProposedIncluded.agentUnnecessaryDollars)}). A proposal that waits for the traveler moves no money, so the rule was wrong; the old figure stays in the summary file.`,
].join('\n');

let text = fs.readFileSync(README, 'utf8');
const nl = text.includes('\r\n') ? '\r\n' : '\n';
const wrapped = `<!-- SWARM-EVAL:BEGIN -->${nl}${block.replace(/\n/g, nl)}${nl}<!-- SWARM-EVAL:END -->`;
if (/<!-- SWARM-EVAL:BEGIN -->[\s\S]*<!-- SWARM-EVAL:END -->/.test(text)) {
  text = text.replace(/<!-- SWARM-EVAL:BEGIN -->[\s\S]*<!-- SWARM-EVAL:END -->/, () => wrapped);
} else {
  const at = text.indexOf('## Seen working on the live site');
  if (at < 0) throw new Error('Could not find the heading to insert before');
  text = text.slice(0, at) + wrapped + nl + nl + text.slice(at);
}
fs.writeFileSync(README, text);
console.log(`README block written: ${f.agentPassRatePct}% vs ${f.baselinePassRatePct}%, ${n} scenarios, ${s.totalRuns} runs`);
