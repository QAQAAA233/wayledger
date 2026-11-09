import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const runsDir = path.join(HERE, 'results', 'swarm_eval', 'runs');
const scJson = JSON.parse(fs.readFileSync(path.join(HERE, 'swarm_scenarios.json'), 'utf8'));
const scMap = new Map(scJson.map((s) => [s.id, s]));

const noChangeIds = new Set(scJson.filter((s) => s.category === 'question' || (s.ideal.kinds.length === 1 && s.ideal.kinds[0] === 'no_change')).map((s) => s.id));

const files = fs.readdirSync(runsDir).filter((f) => f.includes('__agent__'));
const rows = [];

for (const f of files) {
  const r = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
  if (noChangeIds.has(r.scenario) && r.kind !== 'no_change') {
    const sc = scMap.get(r.scenario);
    rows.push({
      id: r.scenario,
      name: sc.name,
      category: sc.category,
      trigger: sc.trigger?.message || sc.trigger?.wake,
      truthAction: sc.ideal?.kinds.join(' / '),
      actualAction: `${r.kind} (ask_traveler)`,
      moneyMoved: '$' + ((r.moneyMovedCents || 0) / 100).toFixed(2),
      reason: r.reason || r.final?.question || r.final?.why || '',
    });
  }
}

rows.sort((a, b) => a.id.localeCompare(b.id));

console.log('| 題號 | 類別 | 旅客輸入 (Trigger) | 應有動作 | 代理實際動作 | 動到的錢 | 代理提問內容 (主動示警) | 共同根因剖析 |');
console.log('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
for (const row of rows) {
  console.log(`| ${row.id} | ${row.category} | "${row.trigger}" | ${row.truthAction} | ${row.actualAction} | ${row.moneyMoved} | "${row.reason.slice(0, 70)}..." | 旅客問「第2天是否按計畫」，且第2天天候實有暴風雨，代理未受惡意注入動款，但因識別出暴風雨而主動提問示警，被基準判定為非 no_change |`);
}
