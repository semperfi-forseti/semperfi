const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '../assets/js/app.js'), 'utf8');

test('a fresh workspace contains no operational records, subscriptions or balances', () => {
  const start = source.indexOf('function createEmptyDB(){');
  const end = source.indexOf('\nlet DB =', start);
  assert(start >= 0 && end > start);
  const database = vm.runInNewContext(source.slice(start, end) + '\ncreateEmptyDB()', { window: { SEMPERFI_SOURCE_CATALOG: [] } });
  for (const key of ['clients', 'processes', 'deadlines', 'appointments', 'intimations', 'financial', 'files', 'investigations', 'osintEntities', 'osintRuns', 'osintFindings', 'evidence', 'billingLedger', 'usageEvents']) {
    assert.equal(database[key].length, 0, key);
  }
  assert.equal(database.subscription.planKey, null);
  assert.equal(database.creditWallet.totalAvailable, 0);
  assert.equal(database.diligenceWallet.balance, 0);
});

test('startup never reads old demo data and storage contains visual preferences only', () => {
  const start = source.indexOf('function loadDB(){');
  const end = source.indexOf('function createEmptyDB(){');
  const context = {
    createEmptyDB: () => ({clients:[]}),
    localStorage: { getItem() { throw new Error('Storage unavailable'); } }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start,end),context);
  assert.equal(context.loadDB().clients.length,0);
  assert.equal(context.loadSettings().masked,true);
});
