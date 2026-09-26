const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const source = readFileSync(join(__dirname,'../assets/js/audit-view.js'),'utf8');

const event = (changes = {}) => ({id:'event-test',action:'client.create',resource_type:'client',resource_id:'resource-test',result:'success',correlation_id:'request-test',occurred_at:'2026-09-23T12:00:00Z',event_hash:'a'.repeat(64),...changes});
function harness(responses) {
  const elements = new Map(), calls = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id,{value:id==='auditLimit'?'100':'',innerHTML:'',textContent:'',disabled:false,attributes:{},handlers:{},classList:{toggle(){}},setAttribute(name,value){this.attributes[name]=value;},addEventListener(name,listener){this.handlers[name]=listener;},focus(){this.focused=true;}});
    return elements.get(id);
  };
  const panel = {isConnected:true,querySelector:selector=>element(selector.slice(1))};
  const context = vm.createContext({AbortController,Intl,Date,document:{getElementById:()=>panel},window:{setTimeout,clearTimeout},fetch:async(url,options)=>{
    calls.push({url,options});
    const next = responses.shift();
    if (typeof next === 'function') return next();
    if (next instanceof Error) throw next;
    return {ok:next.status == null || next.status < 400,status:next.status || 200,json:async()=>next.data};
  }});
  vm.runInContext(source,context);
  return {api:context.window.SemperfiAudit,panel,element,calls};
}

test('audit view consumes persisted event fields and escapes server content',async()=>{
  const injected = '<img src=x onerror=alert(1)>';
  const h=harness([{data:[event({action:injected}),event({id:'other',resource_type:'process',result:'denied'})]}]);
  await h.api.mount();
  assert.equal(h.calls[0].url,'/v1/audit-events?limit=100');
  assert.equal(h.calls[0].options.credentials,'same-origin');
  assert.equal(h.calls[0].options.cache,'no-store');
  assert.match(h.element('auditRows').innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(h.element('auditRows').innerHTML,/<img/);
  assert.doesNotMatch(h.element('auditRows').innerHTML,/<th[^>]*>Ator/);
  assert.match(h.element('auditAction').innerHTML,/&lt;img/);
  h.element('auditResource').value='process';
  h.element('auditResource').handlers.change();
  assert.match(h.element('auditCount').textContent,/1 de 2/);
  assert.doesNotMatch(h.element('auditRows').innerHTML,/&lt;img/);
  h.element('auditSearch').value='request-test';
  h.element('auditSearch').handlers.input();
  assert.match(h.element('auditCount').textContent,/1 de 2/);
  h.element('auditClearFilters').handlers.click();
  assert.equal(h.element('auditSearch').focused,true);
  assert.match(h.element('auditCount').textContent,/2 de 2/);
  await h.api.mount();
  assert.equal(h.calls.length,1,'mount is idempotent for the same panel');
});

test('audit reload keeps old records on failure and indicates they may be stale',async()=>{
  const h=harness([{data:[event()]},new Error('network unavailable'),{data:[]}]);
  await h.api.mount();
  const previous=h.element('auditRows').innerHTML;
  await h.element('auditReload').handlers.click();
  assert.equal(h.element('auditRows').innerHTML,previous);
  assert.match(h.element('auditLoadStatus').textContent,/desatualizados/);
  assert.equal(h.element('auditLoadStatus').attributes.role,'alert');
  assert.equal(h.element('auditReload').disabled,false);
  h.element('auditLimit').value='500';
  await h.element('auditLimit').handlers.change();
  assert.equal(h.calls.at(-1).url,'/v1/audit-events?limit=500');
  assert.match(h.element('auditRows').innerHTML,/Nenhum evento foi retornado/);
  assert.equal(h.element('auditLoadStatus').attributes.role,'status');
});

test('verification uses POST, handles MFA rejection and reports a broken chain as an alert',async()=>{
  const h=harness([{data:[]},{status:403,data:{detail:{policy_code:'MFA_REAUTH_REQUIRED',reason:'internal'}}},{data:{valid:false,checked:3,broken_event_id:'<script>untrusted</script>'}},{data:{valid:true,checked:0,head_hash:null}}]);
  await h.api.mount();
  await h.element('auditVerify').handlers.click();
  assert.equal(h.calls[1].url,'/v1/audit-events/verify-chain');
  assert.equal(h.calls[1].options.method,'POST');
  assert.match(h.element('auditVerifyStatus').textContent,/entre novamente com o código/);
  assert.equal(h.element('auditVerify').disabled,false);
  await h.element('auditVerify').handlers.click();
  assert.equal(h.element('auditVerifyStatus').attributes.role,'alert');
  assert.match(h.element('auditVerifyStatus').textContent,/Inconsistência.*3 eventos/);
  assert.equal(h.element('auditVerifyStatus').innerHTML,'','server values are assigned as text, not HTML');
  await h.element('auditVerify').handlers.click();
  assert.match(h.element('auditVerifyStatus').textContent,/Nenhum evento existia/);
  assert.doesNotMatch(h.element('auditVerifyStatus').textContent,/Cadeia consistente/);
});

test('malformed audit data and verification results cannot masquerade as empty or verified',async()=>{
  const h=harness([{data:{events:[]}},{data:{valid:'true',checked:1}}]);
  await h.api.mount();
  assert.match(h.element('auditLoadStatus').textContent,/formato inválido/);
  assert.equal(h.element('auditSearch').disabled,true);
  assert.equal(h.element('auditRows').innerHTML,'');
  await h.element('auditVerify').handlers.click();
  assert.match(h.element('auditVerifyStatus').textContent,/formato inválido/);
  assert.equal(h.element('auditVerifyStatus').attributes.role,'alert');
});

test('pending loads do not update a detached view or allow overlapping verification',async()=>{
  let release;
  const h=harness([()=>new Promise(resolve=>{release=resolve;})]);
  const loading=h.api.mount();
  assert.equal(h.element('auditVerify').disabled,true);
  await h.element('auditVerify').handlers.click();
  assert.equal(h.calls.length,1);
  h.panel.isConnected=false;
  release({ok:true,status:200,json:async()=>[event()]});
  await loading;
  assert.equal(h.element('auditRows').innerHTML,'');
});
