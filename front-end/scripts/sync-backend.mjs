import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, dirname } from 'node:path';

const source = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(source, '../back-end/app/static/frontend');
const check = process.argv.includes('--check');
const entries = ['index.html', 'login.html', 'assets', 'data', 'pages'];
const files = [];
async function collect(relative) {
  const { stat } = await import('node:fs/promises');
  if ((await stat(join(source, relative))).isDirectory()) {
    for (const entry of await readdir(join(source, relative))) await collect(join(relative, entry));
  } else files.push(relative);
}
for (const entry of entries) await collect(entry);
let mismatches = 0;
for (const relative of files) {
  const content = await readFile(join(source, relative));
  const target = join(destination, relative);
  if (check) {
    let existing;
    try { existing = await readFile(target); } catch { /* Missing artifact. */ }
    if (!existing?.equals(content)) { console.error(`Arquivo desatualizado: ${relative}`); mismatches++; }
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}
if (mismatches) process.exitCode = 1;
else console.log(`${files.length} arquivos ${check ? 'verificados' : 'sincronizados'} para a API.`);
