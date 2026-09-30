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
function dispatcher(fetch) {
  const context = {fetch,AbortSignal,FormData};
  vm.runInNewContext(fragment('async function dispatchOsintTool(', 'function renderOsintToolResult('),context);
  return context.dispatchOsintTool;
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
test('a complete DNS outage fails instead of returning empty successful answers',async()=>{
  let count=0;
  const run=dispatcher(async()=>{count++;throw new Error('offline');});
  await assert.rejects(run('dns','example.test'),/Nenhum resultado foi confirmado/);
  assert.equal(count,7);
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
  const context={osintToolsState:{selected:'dns'},OSINT_TOOLS:[{id:'dns',kind:'dns'}],
    document:{getElementById:id=>id==='otTarget'?{value:'example.test'}:{checked:true}},
    appState:{currentSection:'osinttools'},toast(){},audit(){},renderSection:id=>rendered.push(id),
    dispatchOsintTool:()=>new Promise(resolve=>{finish=resolve;})};
  vm.runInNewContext(fragment('async function runOsintTool(', 'async function dispatchOsintTool('),context);
  const running=context.runOsintTool();context.appState.currentSection='clients';finish({A:[]});await running;
  assert.equal(rendered.length,1);assert.equal(context.osintToolsState.loading,false);assert.equal(context.osintToolsState.lastResult.ok,true);
});
test('DNS partial results retain confirmed empty answers and label unavailable queries',async()=>{
  const run=dispatcher(async url=>({ok:true,json:async()=>url.includes('type=MX')?{Status:2}:{Status:0,Answer:[]}}));
  const result=await run('dns','example.test');
  assert.equal(result.partial,true);assert.equal(result.A.length,0);
  assert.equal(Object.hasOwn(result,'MX'),false);assert.match(result.limitations[0],/MX/);
});
test('GitLab empty results are not a found profile; provider outage is not absence',async()=>{
  const run=dispatcher(async url=>({ok:!url.includes('github'),status:url.includes('github')?404:200,json:async()=>[]}));
  const result=await run('username','test');
  assert.equal(result.GitLab.found,false);assert.equal(result.GitHub.found,false);
  await assert.rejects(dispatcher(async()=>({ok:false,status:503}))('username','test'),/Nenhum perfil foi confirmado/);
});
test('URL threat check rejects HTTP failures and unsuccessful provider replies',async()=>{
  await assert.rejects(dispatcher(async()=>({ok:false,status:403,json:async()=>({})}))('urlthreat','https://example.test'),/fonte/);
  await assert.rejects(dispatcher(async()=>({ok:true,json:async()=>({query_status:'invalid_url'})}))('urlthreat','https://example.test'),/não confirmou/);
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
