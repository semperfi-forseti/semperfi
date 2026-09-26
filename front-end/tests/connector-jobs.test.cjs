const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/js/connector-jobs.js'), 'utf8');
function loadJobs() {
  const context = vm.createContext({AbortController, setTimeout, clearTimeout});
  vm.runInContext(source, context);
  return context.SemperfiConnectorJobs;
}
const options = {pollIntervalMs:1, timeoutMs:500};
const completed = {id:'run-123', status:'completed', raw_snapshot:{name:'Resultado real'}, normalized_result:{items:[]}, limitations:['Verificar a fonte.']};

test('production queue is polled until completed, submitting only once', async () => {
  const jobs = loadJobs(), calls = [], progress = [];
  const responses = [{run_id:'run-123', job_id:'job-1', status:'queued'},
    {id:'run-123', status:'running'}, {id:'run-123', status:'running'}, completed];
  const request = async (url, init) => { calls.push({url, init}); return responses.shift(); };
  const result = await jobs.run(request, {connector_id:'brasilapi', payload:{kind:'cnpj', value:'123'}},
    {...options, onProgress:event => progress.push(event.status)});
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
  assert.equal(calls[0].url, '/osint/runs');
  assert.equal(JSON.parse(calls[0].init.body).connector_id, 'brasilapi');
  assert.ok(calls.slice(1).every(c => c.url === '/osint/runs/run-123' && c.init.method === 'GET'));
  assert.deepEqual(progress, ['submitting','queued','running','running','completed']);
  assert.equal(result.run_id, 'run-123');
  assert.equal(result.job_id, 'job-1');
  assert.equal(result.raw_snapshot.name, 'Resultado real');
  assert.ok(calls.every(c => c.init.signal && !c.init.signal.aborted));
});

test('server failures never become successful empty results', async () => {
  const jobs = loadJobs(); let count = 0;
  const request = async () => ++count === 1 ? {run_id:'run-123', status:'queued'} : {id:'run-123', status:'failed', error_code:'ValueError'};
  await assert.rejects(jobs.run(request, {}, options), error => {
    assert.equal(error.code, 'EXECUTION_FAILED');
    assert.equal(error.runId, 'run-123');
    assert.equal(error.serverCode, 'ValueError');
    return true;
  });
  assert.equal(count, 2);
});

test('HTTP 202 approval response is not treated as an executed query', async () => {
  let count = 0;
  await assert.rejects(loadJobs().run(async () => { count++; return {detail:{status:'approval_required'}}; }, {}, options),
    error => error.code === 'APPROVAL_REQUIRED' && error.runId === null);
  assert.equal(count, 1);
});

test('unknown, mismatched and empty completed responses fail explicitly', async () => {
  for (const response of [
    {id:'run-123', status:'unrecognized'},
    {id:'other-run', status:'completed', normalized_result:{}},
    {id:'run-123', status:'completed'},
    {status:'running'}
  ]) {
    await assert.rejects(loadJobs().resume(async () => response, 'run-123', options), error => error.code === 'INVALID_RESPONSE');
  }
});

test('an empty valid collection can complete', async () => {
  const result = await loadJobs().resume(async () => ({id:'run-123', status:'completed', raw_snapshot:[]}), 'run-123', options);
  assert.equal(result.status, 'completed');
  assert.equal(result.raw_snapshot.length, 0);
});

test('timeout stops polling, aborts the adapter and retains the recoverable ID', async () => {
  let signal, requests = 0;
  const request = async (_, init) => {
    requests++; signal = init.signal;
    if (requests === 1) return {run_id:'run-123', job_id:'job-1', status:'queued'};
    return new Promise(() => {}); // Adapter intentionally ignores abort.
  };
  await assert.rejects(loadJobs().run(request, {}, {...options, timeoutMs:20}), error => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.runId, 'run-123');
    assert.equal(error.jobId, 'job-1');
    assert.match(error.message, /run-123/);
    return true;
  });
  assert.equal(requests, 2);
  assert.equal(signal.aborted, true);
});

test('resume checks the original job without another POST', async () => {
  const calls = [];
  await loadJobs().resume(async (url, init) => { calls.push({url, method:init.method}); return completed; }, 'run-123', options);
  assert.deepEqual(calls, [{url:'/osint/runs/run-123', method:'GET'}]);
});

test('cancelling during the polling pause leaves the server job recoverable', async () => {
  const controller = new AbortController(); let requests = 0;
  const operation = loadJobs().resume(async () => { requests++; return {id:'run-123', status:'running'}; }, 'run-123',
    {...options, pollIntervalMs:100, signal:controller.signal,
      onProgress:event => { if (event.status === 'running') setTimeout(() => controller.abort(), 1); }});
  await assert.rejects(operation, error => error.code === 'ABORTED' && error.runId === 'run-123');
  assert.equal(requests, 1);
});

test('a pre-cancelled request submits nothing', async () => {
  const controller = new AbortController(); controller.abort(); let requests = 0;
  await assert.rejects(loadJobs().run(async () => { requests++; }, {}, {...options, signal:controller.signal}), error => error.code === 'ABORTED');
  assert.equal(requests, 0);
});

test('network failure preserves the run ID without retrying or resubmitting', async () => {
  let requests = 0;
  await assert.rejects(loadJobs().resume(async () => { requests++; throw new Error('offline'); }, 'run-123', options),
    error => error.code === 'REQUEST_FAILED' && error.runId === 'run-123');
  assert.equal(requests, 1);
});

test('progress observer failures do not alter a successful server result', async () => {
  const result = await loadJobs().resume(async () => completed, 'run-123', {...options, onProgress:() => { throw new Error('UI observer'); }});
  assert.equal(result.status, 'completed');
});

test('invalid resume identifiers and timing options never reach the API', async () => {
  let requests = 0; const request = async () => { requests++; };
  for (const id of [undefined, null, '', '../other', 'run?another=1']) {
    await assert.rejects(loadJobs().resume(request, id, options), /Identificador/);
  }
  await assert.rejects(loadJobs().run(request, {}, {timeoutMs:-1}), /timeoutMs/);
  await assert.rejects(loadJobs().run(request, {}, {pollIntervalMs:0}), /pollIntervalMs/);
  assert.equal(requests, 0);
});

test('a lost POST response times out without sending another execution', async () => {
  let requests = 0;
  await assert.rejects(loadJobs().run(async () => { requests++; return new Promise(() => {}); }, {}, {timeoutMs:20}),
    error => error.code === 'TIMEOUT' && error.runId === null && /histórico/.test(error.message));
  assert.equal(requests, 1);
});

test('a server cancellation is terminal and never produces results', async () => {
  let requests = 0;
  await assert.rejects(loadJobs().resume(async () => { requests++; return {id:'run-123', status:'cancelled'}; }, 'run-123', options),
    error => error.code === 'EXECUTION_CANCELLED' && error.runId === 'run-123');
  assert.equal(requests, 1);
});
