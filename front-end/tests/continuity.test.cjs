'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {createHash} = require('node:crypto');
const vm = require('node:vm');
const source = readFileSync(join(__dirname,'../assets/js/app.js'),'utf8').replace(/\r\n/g,'\n');
const fragment = (start,end) => source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const escapeHTML = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const toolFixture = {id:'saved-run',connector_id:'osint_tools',status:'completed',created_at:'2026-10-03T12:00:00Z',investigation_id:'investigation',raw_snapshot:{tool:'dns',target:'example.com',data:{A:[]},partial:false,limitations:[]}};
function dispatcher(request,extra={}) {
  const context = {backendApi:request,AbortController,setTimeout,clearTimeout,
    osintToolsState:{purpose:'Verificar domínio autorizado',legalBasis:'contrato',authorizationReference:'AUTORIZACAO-1',investigationId:'investigation',consent:true},
    OSINT_TOOLS:[{id:'dns',kind:'dns',name:'DNS'}],document:{getElementById:()=>null},...extra};
  context.window=context;
  vm.runInNewContext(readFileSync(join(__dirname,'../assets/js/connector-jobs.js'),'utf8'),context);
  vm.runInNewContext(fragment('async function dispatchOsintTool(', 'function renderOsintToolResult('),context);
  return context;
}
test('global search escapes records and query, masks documents, and renders keyboard buttons',()=>{
  const value = '<img src=x onerror="alert(1)">';
  let modal;
  const context = {DB:{clients:[{name:value,document:'12345678901'}],processes:[],deadlines:[],intimations:[]},
    maskDoc:()=> '***.***.***-01',escapeHTML,openModal:options=>{modal=options;}};
  vm.runInNewContext(fragment('function runGlobalSearch(', '// ============================================================\n//          OSINT'),context);
  context.runGlobalSearch(value);
  assert.doesNotMatch(modal.title+modal.body, /<img|12345678901/);
  assert.match(modal.body,/&lt;img/);assert.match(modal.body,/\*\*\*/);
  assert.match(modal.body,/<button type="button"/);
});
test('OSINT dispatch persists authorized context and polls the saved job through the backend only',async()=>{
  const calls=[];
  const context=dispatcher(async(path,options)=>{calls.push({path,options});return options.method==='POST'?{run_id:'saved-run',status:'queued'}:toolFixture;});
  const result=await context.dispatchOsintTool('dns','example.com');
  assert.equal(result.raw_snapshot.target,'example.com');
  assert.deepEqual(calls.map(call=>[call.path,call.options.method]),[['/osint/runs','POST'],['/osint/runs/saved-run','GET']]);
  assert.deepEqual(JSON.parse(calls[0].options.body),{connector_id:'osint_tools',investigation_id:'investigation',payload:{tool:'dns',value:'example.com',authorized:true},purpose:'Verificar domínio autorizado',legal_basis:'contrato',authorization_reference:'AUTORIZACAO-1',scope_codes:['digital_defensive'],risk_level:'low'});
  assert.equal(context.osintToolsState.runId,'saved-run');
});
test('real document masking exposes only the last two digits regardless of punctuation',()=>{
  const context={SETTINGS:{masked:true}};
  vm.runInNewContext(fragment('function maskDoc(', 'function maskHash('),context);
  for(const doc of ['12345678901','123.456.789-01','12.345.678/0001-90','12345678000190']){
    assert.equal(context.maskDoc(doc).replace(/\D/g,''),doc.replace(/\D/g,'').slice(-2));
  }
  context.SETTINGS.masked=false;assert.equal(context.maskDoc('123.456.789-01'),'123.456.789-01');
});
test('OSINT completion does not replace another section after navigation',async()=>{
  let finish;const rendered=[];
  const fields={otTarget:{value:'example.com'},otConsent:{checked:true},otPurpose:{value:'Consulta autorizada de teste'},otBasis:{value:'contrato'},otReference:{value:'AUTORIZACAO-1'},otInvestigation:{value:'investigation'}};
  const context={osintToolsState:{selected:'dns'},OSINT_TOOLS:[{id:'dns',kind:'dns'}],
    document:{getElementById:id=>fields[id]},
    appState:{currentSection:'osinttools'},toast(){},audit(){},renderSection:id=>rendered.push(id),
    dispatchOsintTool:()=>new Promise(resolve=>{finish=resolve;})};
  vm.runInNewContext(fragment('function acceptOsintToolResult(', 'async function openOsintToolRun('),context);
  vm.runInNewContext(fragment('async function runOsintTool(', 'async function dispatchOsintTool('),context);
  const running=context.runOsintTool();context.appState.currentSection='clients';finish(toolFixture);await running;
  assert.equal(rendered.length,1);assert.equal(context.osintToolsState.loading,false);assert.equal(context.osintToolsState.lastResult.ok,true);
  assert.equal(context.osintToolsState.lastResult.runId,'saved-run');
});
test('failed server execution retains the saved job and configuration error without successful fallback',async()=>{
  const calls=[];
  const context=dispatcher(async(path,options)=>{calls.push(path);return {id:'saved-run',status:options.method==='POST'?'queued':'failed',error_code:'ProviderNotConfigured'};});
  await assert.rejects(context.dispatchOsintTool('urlthreat','https://example.com'),error=>error.serverCode==='ProviderNotConfigured'&&error.runId==='saved-run'&&error.code==='EXECUTION_FAILED');
  assert.deepEqual(calls,['/osint/runs','/osint/runs/saved-run']);
});
test('saved OSINT response preserves partial limitations and rejects a different connector or incomplete data',()=>{
  const context=dispatcher(async()=>{});
  const partial={...toolFixture,raw_snapshot:{...toolFixture.raw_snapshot,partial:true,limitations:['MX indisponível']}};
  assert.equal(context.acceptOsintToolResult(partial).data.partial,true);
  assert.deepEqual(context.acceptOsintToolResult(partial).data.limitations,['MX indisponível']);
  assert.equal(context.acceptOsintToolResult(partial).at,toolFixture.created_at);
  for(const invalid of [{...toolFixture,connector_id:'brasilapi'},{...toolFixture,status:'failed'},{...toolFixture,raw_snapshot:null},{...toolFixture,raw_snapshot:{tool:'unknown',data:{}}}]){
    assert.throws(()=>context.acceptOsintToolResult(invalid),/inválido/);
  }
});
test('reopening an OSINT result after a new page reads the saved run without resubmission',async()=>{
  const calls=[],rendered=[];
  const context=dispatcher(async(path,options)=>{calls.push({path,method:options.method});return toolFixture;},{appState:{currentSection:'osinttools'},renderSection:section=>rendered.push(section)});
  await context.openOsintToolRun('saved-run');
  assert.deepEqual(calls,[{path:'/osint/runs/saved-run',method:'GET'}]);
  assert.equal(context.osintToolsState.lastResult.runId,'saved-run');
  assert.equal(context.osintToolsState.lastResult.investigationId,'investigation');
  assert.deepEqual(rendered,['osinttools']);
});
function reportGenerator(request,extra={}) {
  const context={Map,crypto:require('node:crypto').webcrypto,backendApi:request,closeModal(){},navigateSection(){},toast(){},...extra};
  vm.runInNewContext(fragment('const reportCommands = new Map();','// ============================================================\n//          OSINT TOOLS'),context);
  return context.generateOsintReport;
}
test('investigative report waits for confirmation and sends only the server command',async()=>{
  const calls=[],navigations=[];let confirmation;
  const generate=reportGenerator(async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return {report_id:'report',status:'DRAFT',content_hash:'a'.repeat(64)};},
    {openCreditConsumptionModal:(_action,options)=>{confirmation=options;},navigateSection:section=>navigations.push(section),DB:{findings:[{title:'Unpersisted browser assertion'}]}});
  await generate('investigation');assert.equal(calls.length,0);
  await confirmation.onConfirmed();
  assert.equal(calls[0].path,'/investigations/investigation/report-draft');
  assert.deepEqual(Object.keys(calls[0].body),['request_id']);
  assert.match(calls[0].body.request_id,/^[a-f0-9-]{36}$/);assert.deepEqual(navigations,['reports']);
});
test('ambiguous investigative report failure reuses its command; double activation submits once',async()=>{
  const calls=[],navigations=[];let fail;
  const generate=reportGenerator(async(path,options)=>{
    calls.push(JSON.parse(options.body));if(calls.length===1)return new Promise((_resolve,reject)=>{fail=reject;});
    return {report_id:'saved-report',status:'DRAFT',content_hash:'b'.repeat(64)};
  },{navigateSection:section=>navigations.push(section)});
  const pending=generate('investigation',true);await generate('investigation',true);
  assert.equal(calls.length,1);fail(Error('Lost response'));await pending;assert.deepEqual(navigations,[]);
  await generate('investigation',true);assert.equal(calls.length,2);assert.equal(calls[0].request_id,calls[1].request_id);
  assert.deepEqual(navigations,['reports']);
});
test('investigative report cannot announce a saved draft without a valid server receipt',async()=>{
  const notifications=[],navigations=[];
  const generate=reportGenerator(async()=>({report_id:'report',status:'DRAFT',content_hash:'invalid'}),
    {navigateSection:section=>navigations.push(section),toast:(message,level)=>notifications.push({message,level})});
  await generate('investigation',true);assert.deepEqual(navigations,[]);assert.equal(notifications.at(-1).level,'error');
});
function preservation(request,refresh=async()=>{}) {
  const context={Map,FormData,File,backendApi:request,refreshBackendBootstrap:refresh,apiErrorMessage:e=>e.message,
    sha256Hex:async text=>createHash('sha256').update(text).digest('hex')};
  vm.runInNewContext(fragment('const evidenceTransfers = new Map();','// ---------- Audit ----------'),context);
  return context.createBackendEvidenceRecord;
}
test('failed finalization reuses its upload, does not attest, and requires preservation confirmation',async()=>{
  const calls=[];let unavailable=true;
  const save=preservation(async path=>{
    calls.push(path);
    if(path==='/evidences/uploads')return {evidence_id:'fixture'};
    if(path.endsWith('/finalize')){if(unavailable)throw new Error('Cofre indisponível');return {status:'preserved'};}
    return {status:'validated'};
  });
  const input={content:{result:'isolated'},sourceName:'Test',autoAttest:true};
  const [first,duplicate]=await Promise.all([save(input),save(input)]);
  assert.equal(first.preserved,false);assert.equal(duplicate.evidenceId,'fixture');
  assert.equal(calls.filter(p=>p==='/evidences/uploads').length,1);
  assert.equal(calls.some(p=>p.endsWith('/attest')),false);
  unavailable=false;const resumed=await save(input);
  assert.equal(resumed.preserved,true);assert.equal(resumed.warning,'');
  assert.equal(calls.filter(p=>p==='/evidences/uploads').length,1);
  assert.equal(calls.filter(p=>p.endsWith('/attest')).length,1);
});
test('refresh failure keeps receipt; ambiguous upload response prevents duplicate POST',async()=>{
  let uploads=0;
  const save=preservation(async path=>path==='/evidences/uploads'?(uploads++,{evidence_id:'fixture'}):{status:'preserved'},async()=>{throw new Error('offline');});
  const input={content:'isolated',sourceName:'Test'};
  assert.equal((await save(input)).preserved,true);await save(input);assert.equal(uploads,1);
  let attempts=0;const unknown=preservation(async()=>{attempts++;throw new Error('lost response');});
  await assert.rejects(unknown(input),/lost response/);
  await assert.rejects(unknown(input),/Confira a aba Arquivos/);assert.equal(attempts,1);
});
test('a persisted finding receipt resumes after a new page without uploading again',async()=>{
  const calls=[];
  const save=preservation(async path=>{calls.push(path);return {status:'preserved'};});
  const result=await save({content:'Persisted finding',sourceName:'Test',findingId:'finding',existingEvidenceId:'original'});
  assert.equal(result.evidenceId,'original');assert.equal(result.preserved,true);
  assert.deepEqual(calls,['/evidences/original/finalize','/findings/finding']);
});
