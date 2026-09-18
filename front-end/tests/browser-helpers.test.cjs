const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {spawnSync} = require('node:child_process');
const vm = require('node:vm');
const source = readFileSync(join(__dirname, '../assets/js/app.js'), 'utf8');

test('calendar dates keep the local day at night and round-trip date inputs', () => {
  const helpers = source.slice(source.indexOf('function toISO('), source.indexOf('function fmtDate('));
  const result = spawnSync(process.execPath, ['-e', `${helpers}
    const assert = require('node:assert/strict');
    assert.equal(toISO(new Date('2026-09-17T01:30:00Z')), '2026-09-16');
    assert.equal(toISO(fromISO('2026-09-16')), '2026-09-16');
  `], {env:{...process.env,TZ:'America/Sao_Paulo'},encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
});

for (const outcome of ['load', 'error', 'timeout']) {
  test(`image ${outcome} completes and releases the temporary URL`, async () => {
    let revoked = 0, cleared = 0, onTimeout;
    class Image {
      naturalWidth = 120;
      naturalHeight = 80;
      set src(_) {
        queueMicrotask(() => outcome === 'timeout' ? onTimeout() : this[`on${outcome}`]());
      }
    }
    const context = vm.createContext({Image,
      URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:()=> revoked++},
      setTimeout:callback=>{onTimeout=callback;return 1;},clearTimeout:()=>cleared++
    });
    vm.runInContext(source.slice(source.indexOf('function readImageDimensions('),source.indexOf('async function handleFiles(')),context);
    const pending = context.readImageDimensions({});
    if (outcome === 'load') {
      const dimensions = await pending;
      assert.equal(dimensions.width,120); assert.equal(dimensions.height,80);
    } else await assert.rejects(pending, outcome === 'error' ? /formato/ : /demorou/);
    assert.equal(revoked,1); assert.equal(cleared,1);
  });
}
