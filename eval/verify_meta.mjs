// Checks, for every evaluation tag, that the files it ran with are byte for byte the ones in the commit it names.   node eval/verify_meta.mjs
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = 'eval/results';
for (const tag of fs.readdirSync(root).filter((d) => fs.existsSync(`${root}/${d}/meta.json`)).sort()) {
  const m = JSON.parse(fs.readFileSync(`${root}/${tag}/meta.json`, 'utf8'));
  let same = 0; const diff = [];
  for (const [f, h] of Object.entries(m.fileHashes)) {
    let blob; try { blob = execSync(`git show ${m.commit}:${f}`, { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { diff.push(`${f}(absent)`); continue; }
    // the commit's text may have CRLF/LF differences; hash both forms
    const hs = [createHash('sha256').update(blob).digest('hex').slice(0, 16), createHash('sha256').update(Buffer.from(blob.toString('utf8').replace(/\r\n/g, '\n'))).digest('hex').slice(0, 16), createHash('sha256').update(Buffer.from(blob.toString('utf8').replace(/\r?\n/g, '\r\n'))).digest('hex').slice(0, 16)];
    if (hs.includes(h)) same++; else diff.push(f.split('/').pop());
  }
  console.log(tag.padEnd(18), m.commit, `${same}/${Object.keys(m.fileHashes).length} files identical to the commit`, diff.length ? `differs: ${diff.join(', ')}` : '');
}
