import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const runsDir = path.join(HERE, 'results', 'swarm_eval', 'runs');
const scJson = JSON.parse(fs.readFileSync(path.join(HERE, 'swarm_scenarios.json'), 'utf8'));
const scMap = new Map(scJson.map((s) => [s.id, s]));

const files = fs.readdirSync(runsDir);
const rows = [];

for (const f of files) {
  const r = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
  if ((r.unnecessaryRefundCents || 0) > 0) {
    const sc = scMap.get(r.scenario);
    const cat = sc?.category;
    const isDropout = cat === 'dropout';

    const errType = '評分定義錯（未執行的提案 proposal 被評分邏輯誤當作實際已退款，且情境庫未將提案金額列入理想容許值）';

    rows.push({
      id: r.scenario,
      approach: r.approach === 'agent' ? '代理 (Agent)' : '基準 (Baseline)',
      category: cat,
      truthAction: sc?.ideal?.kinds.join(' 或 '),
      truthAllowedMoney: '$' + ((sc?.ideal?.refundCents || 0) / 100).toFixed(2),
      actualAction: `${r.kind} (${r.final?.outcome || r.final?.kind})`,
      moneyMoved: '$' + ((r.moneyMovedCents || 0) / 100).toFixed(2),
      unnecessaryScored: '$' + ((r.unnecessaryRefundCents || 0) / 100).toFixed(2),
      whyScored: isDropout
        ? '成員退出依合約須旅客同意，理想動作為 proposed，但情境庫將其 ideal.refundCents 設為 $0，world.mjs line 238 將提案預擬金額誤計為不必要退款'
        : '因條款不可退換，代理安全止步轉為待審提案（需旅客確認），world.mjs line 238 將提案預擬退款算入真實退款，且 ideal.refundCents 為 $0',
      classification: errType,
    });
  }
}

rows.sort((a, b) => a.id.localeCompare(b.id) || a.approach.localeCompare(b.approach));

console.log('| 題號 | 角色 | 類別 | 隱藏真相 (理想動作 / 允許金額) | 實際動作 | 實際動款 | 評分被計不必要 | 被算成不必要的原因 | 歸類判定 |');
console.log('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
for (const row of rows) {
  console.log(`| ${row.id} | ${row.approach} | ${row.category} | ${row.truthAction} (允許 ${row.truthAllowedMoney}) | ${row.actualAction} | ${row.moneyMoved} | ${row.unnecessaryScored} | ${row.whyScored} | ${row.classification} |`);
}
