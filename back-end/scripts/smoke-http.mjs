import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.SEMPERFI_SMOKE_PORT || 8010);
const base = `http://127.0.0.1:${port}`;
const directory = await mkdtemp(join(tmpdir(), 'semperfi-smoke-'));
const env = {
  ...process.env,
  ENVIRONMENT: 'test', AUTH_MODE: 'development',
  DATABASE_URL: `sqlite+aiosqlite:///${join(directory, 'smoke.db').replaceAll('\\', '/')}`,
  EVIDENCE_STAGING_DIR: join(directory, 'evidence'),
};
const child = spawn('uv', ['run', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)], { cwd: root, env, windowsHide: true });
let failure = '', launchError;
child.stderr.on('data', chunk => { failure = (failure + chunk).slice(-5000); });
child.on('error', error => { launchError = error; });
async function get(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(3000) });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`API encerrada: ${failure}`);
    try { await get('/health/ready'); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  assert(ready, `API indisponível: ${failure}`);
  const live = await get('/health/live').then(response => response.json());
  const status = await get('/v1/auth/status').then(response => response.json());
  const contract = await get('/v1/openapi.json').then(response => response.json());
  assert.equal(status.authenticated, false);
  assert(contract.paths['/v1/clients']);
  for (const path of ['/', '/ui/frontend/login.html', '/ui/frontend/assets/js/auth.js', '/ui/frontend/assets/css/style.css', '/ui/frontend/data/sources.json']) await get(path);
  console.log(JSON.stringify({live:live.status,authenticated:status.authenticated,api:contract.info.title,assets:'ok',database:'isolated temporary database'}, null, 2));
} finally {
  if (child.pid && child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {windowsHide:true,stdio:'ignore'});
    else child.kill('SIGTERM');
  }
}
