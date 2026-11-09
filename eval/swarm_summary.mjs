// Computes the 4 key metrics required for Hackathon submission evidence:
// 1. 沒同意就動到的錢 (Money moved without consent / operator loss)
// 2. 不必要的扣款與退款 (Unnecessary charges / refunds)
// 3. 比一次呼叫好多少 (Improvement of Agent Loop over One-Call Baseline)
// 4. 過度反應率 (Overreaction rate on no-change / question scenarios)
// Plus Workers AI actual spend and neurons.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : acc), []));
const tag = args.tag ?? 'swarm_eval';
const runsDir = path.join(HERE, 'results', tag, 'runs');

if (!fs.existsSync(runsDir)) {
  console.error(`Runs directory not found: ${runsDir}`);
  process.exit(1);
}

const runFiles = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json'));
console.log(`Found ${runFiles.length} raw run records in ${runsDir}.`);

const runs = runFiles.map((f) => JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')));
const agentRuns = runs.filter((r) => r.approach === 'agent');
const baselineRuns = runs.filter((r) => r.approach === 'baseline');

const scenarioIds = [...new Set(runs.map((r) => r.scenario))].sort();
console.log(`Total unique scenarios evaluated: ${scenarioIds.length}`);

// Metric 1: 沒同意就動到的錢
const agentLossCents = agentRuns.reduce((sum, r) => sum + (r.lossCents ?? 0), 0);
const baselineLossCents = baselineRuns.reduce((sum, r) => sum + (r.lossCents ?? 0), 0);
const agentUnauthorizedMoney = agentRuns.filter((r) => (r.lossCents ?? 0) > 0 || (r.moneyMovedCents > 0 && r.kind !== 'executed'));

// Metric 2: 不必要的扣款與退款
const agentUnnecessaryRefundCents = agentRuns.reduce((sum, r) => sum + (r.unnecessaryRefundCents ?? 0), 0);
const baselineUnnecessaryRefundCents = baselineRuns.reduce((sum, r) => sum + (r.unnecessaryRefundCents ?? 0), 0);

// Metric 3: 比一次呼叫好多少
let agentBetter = 0;
let baselineBetter = 0;
let tie = 0;

for (const sid of scenarioIds) {
  const aRun = agentRuns.find((r) => r.scenario === sid);
  const bRun = baselineRuns.find((r) => r.scenario === sid);
  if (!aRun || !bRun) continue;
  const aPass = aRun.satisfied ? 1 : 0;
  const bPass = bRun.satisfied ? 1 : 0;
  if (aPass > bPass) agentBetter++;
  else if (bPass > aPass) baselineBetter++;
  else tie++;
}

const agentPassRate = agentRuns.length ? (agentRuns.filter((r) => r.satisfied).length / agentRuns.length) : 0;
const baselinePassRate = baselineRuns.length ? (baselineRuns.filter((r) => r.satisfied).length / baselineRuns.length) : 0;

// Metric 4: 過度反應率 (針對 ideal 是 no_change 的題目：如問問題、微雨、詢問行程)
// 題目 bank 中，category === 'question' 或 ideal 包含 'no_change'
const rawScenarios = JSON.parse(fs.readFileSync(path.join(HERE, 'swarm_scenarios.json'), 'utf8'));
const noChangeScenarioIds = new Set(rawScenarios.filter((s) => s.category === 'question' || (s.ideal.kinds.length === 1 && s.ideal.kinds[0] === 'no_change')).map((s) => s.id));

const agentNoChangeRuns = agentRuns.filter((r) => noChangeScenarioIds.has(r.scenario));
const baselineNoChangeRuns = baselineRuns.filter((r) => noChangeScenarioIds.has(r.scenario));

// 過度反應：本該 no_change，卻擅自執行 (executed)、改動款項或提出變更 (proposed)
const agentOverreacted = agentNoChangeRuns.filter((r) => r.kind !== 'no_change');
const baselineOverreacted = baselineNoChangeRuns.filter((r) => r.kind !== 'no_change');

const agentOverreactionRate = agentNoChangeRuns.length ? (agentOverreacted.length / agentNoChangeRuns.length) : 0;
const baselineOverreactionRate = baselineNoChangeRuns.length ? (baselineOverreacted.length / baselineNoChangeRuns.length) : 0;

// Spend
const spendFile = path.join(HERE, 'results', 'spend.json');
let spend = { usd: 0, byTag: {} };
try { spend = JSON.parse(fs.readFileSync(spendFile, 'utf8')); } catch {}
const tagSpend = spend.byTag?.[tag] ?? { neurons: 0, usd: runs.reduce((s, r) => s + (r.usd ?? 0), 0) };

const summary = {
  tag,
  generatedAt: new Date().toISOString(),
  scenariosCount: scenarioIds.length,
  totalRuns: runs.length,
  agentRunsCount: agentRuns.length,
  baselineRunsCount: baselineRuns.length,
  metrics: {
    // 1. 沒同意就動到的錢
    moneyMovedWithoutConsent: {
      agentLossDollars: agentLossCents / 100,
      baselineLossDollars: baselineLossCents / 100,
      agentUnauthorizedRuns: agentUnauthorizedMoney.length,
      unit: 'USD',
    },
    // 2. 不必要的扣款與退款
    unnecessaryChargesOrRefunds: {
      agentUnnecessaryDollars: agentUnnecessaryRefundCents / 100,
      baselineUnnecessaryDollars: baselineUnnecessaryRefundCents / 100,
      unit: 'USD',
    },
    // 3. 比一次呼叫好多少
    agentVsBaseline: {
      pairedComparison: {
        agentBetter,
        baselineBetter,
        tie,
        comparedScenarios: agentBetter + baselineBetter + tie,
      },
      agentPassRatePct: +(agentPassRate * 100).toFixed(1),
      baselinePassRatePct: +(baselinePassRate * 100).toFixed(1),
      passRateGainPct: +((agentPassRate - baselinePassRate) * 100).toFixed(1),
    },
    // 4. 過度反應率
    overreactionRate: {
      testedScenariosCount: agentNoChangeRuns.length,
      agentOverreactedCount: agentOverreacted.length,
      agentOverreactionRatePct: +(agentOverreactionRate * 100).toFixed(1),
      baselineOverreactedCount: baselineOverreacted.length,
      baselineOverreactionRatePct: +(baselineOverreactionRate * 100).toFixed(1),
    },
    // 實際花費
    spend: {
      tagUsd: +(tagSpend.usd ?? runs.reduce((s, r) => s + (r.usd ?? 0), 0)).toFixed(4),
      cumulativeUsd: +(spend.usd ?? 0).toFixed(4),
      capUsd: spend.capUsd ?? 10,
    },
  },
};

const summaryPath = path.join(HERE, 'results', tag, 'summary.json');
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

console.log('----------------------------------------------------');
console.log('EVALUATION EVIDENCE SUMMARY:');
console.log(`Scenarios: ${summary.scenariosCount} (Runs: ${summary.totalRuns})`);
console.log(`1. 沒同意就動到的錢: Agent $${summary.metrics.moneyMovedWithoutConsent.agentLossDollars.toFixed(2)} (vs Baseline $${summary.metrics.moneyMovedWithoutConsent.baselineLossDollars.toFixed(2)})`);
console.log(`2. 不必要的扣款/退款: Agent $${summary.metrics.unnecessaryChargesOrRefunds.agentUnnecessaryDollars.toFixed(2)} (vs Baseline $${summary.metrics.unnecessaryChargesOrRefunds.baselineUnnecessaryDollars.toFixed(2)})`);
console.log(`3. 比一次呼叫好多少: Agent 勝 ${agentBetter} 題, Baseline 勝 ${baselineBetter} 題, 平手 ${tie} 題 (通過率: Agent ${summary.metrics.agentVsBaseline.agentPassRatePct}% vs Baseline ${summary.metrics.agentVsBaseline.baselinePassRatePct}%, 差距 +${summary.metrics.agentVsBaseline.passRateGainPct}%)`);
console.log(`4. 過度反應率: Agent ${summary.metrics.overreactionRate.agentOverreactionRatePct}% (Baseline ${summary.metrics.overreactionRate.baselineOverreactionRatePct}%)`);
console.log(`實際花費: 本次 $${summary.metrics.spend.tagUsd} (累計 $${summary.metrics.spend.cumulativeUsd} / 上限 $${summary.metrics.spend.capUsd})`);
console.log(`Summary written to: ${summaryPath}`);
console.log('----------------------------------------------------');
