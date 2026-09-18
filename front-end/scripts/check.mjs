import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
let failures = 0, checked = 0;
async function scan(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(item.name)) continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) { await scan(path); continue; }
    if (!/\.(?:html|css|js|mjs|cjs|json)$/.test(item.name)) continue;
    checked++;
    const source = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
    const brokenEncoding = /\u00c3[\u0080-\u00bf]|\u00c2[\u0080-\u00bf]|\u00e2(?:\u0080|\u20ac)|\u00f0\u0178|\u251c[\u00ba\u00a7\u00a3\u00a1\u00a9]|\u00d4\u00c7|\ufffd/;
    source.split(/\r?\n/).forEach((line, index) => {
      if (brokenEncoding.test(line)) {
        console.error(`Possível codificação corrompida: ${path}:${index + 1}`); failures++;
      }
    });
    if (item.name.endsWith('.html') && !/<meta\s+charset=["']utf-8["']/i.test(source)) {
      console.error(`Charset ausente: ${path}`); failures++;
    }
    if (/\.(?:js|mjs|cjs)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0) failures++;
    }
    if (item.name.endsWith('.json')) JSON.parse(source);
  }
}
await scan(root);
console.log(`${checked} arquivos verificados (UTF-8, mojibake, charset HTML, sintaxe JavaScript e JSON).`);
if (failures) process.exitCode = 1;
