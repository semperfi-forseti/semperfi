/* Browser -> real FastAPI -> disposable SQLite. No mocks of legal endpoints.
 * Requires synced assets, Playwright and SEMPERFI_TEST_PYTHON with backend dependencies.
 * Uses a random port, a fresh database and development identity only in this child process.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {createRequire} = require('node:module');
function dependency(name) {
  try { return require(name); }
  catch (_) { return createRequire(path.join(os.tmpdir(),'semperfi-review-tools','package.json'))(name); }
}
const {chromium} = dependency('playwright');
const root = path.resolve(__dirname,'../../..');
const python = process.env.SEMPERFI_TEST_PYTHON;
if (!python) throw Error('Informe SEMPERFI_TEST_PYTHON apontando para um ambiente de testes com as dependências do backend.');
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port = listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  return port;
}
let child, browser;
(async()=>{
  const parent = path.join(root,'back-end/var/test');
  await fs.mkdir(parent,{recursive:true});
  const directory = await fs.mkdtemp(path.join(parent,'browser-live-'));
  const database = path.join(directory,'isolated.sqlite').replaceAll('\\','/');
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  let serverLog = '';
  // Start with a minimal environment: never inherit DATABASE_URL, SMTP, keys or production settings.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|COMSPEC)$/i.test(key)));
  Object.assign(env,{
    PYTHONPATH:path.join(root,'back-end'),PYTHONUTF8:'1',ENVIRONMENT:'test',
    DATABASE_URL:`sqlite+aiosqlite:///${database}`,AUTH_MODE:'development',ALLOW_DEVELOPMENT_IDENTITY_HEADERS:'true',
    REDIS_URL:'redis://127.0.0.1:1/0',CELERY_BROKER_URL:'redis://127.0.0.1:1/0',CELERY_RESULT_BACKEND:'redis://127.0.0.1:1/1',
    AI_PROVIDER:'disabled',ASAAS_SANDBOX_ENABLED:'false',SMTP_HOST:'',SMTP_USERNAME:'',SMTP_PASSWORD:'',
    AUTH_OTP_SIGNING_KEY:'isolated-browser-test-only-not-for-deployment',EVIDENCE_STAGING_DIR:directory,
  });
  // cwd is the fresh directory, so Settings cannot load the project's private .env.
  child = spawn(python,['-m','uvicorn','app.main:app','--host','127.0.0.1','--port',String(port),'--no-access-log'],{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.on('error',error=>{serverLog=error.message;});
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{serverLog=(serverLog+chunk.toString()).slice(-6000);});
  let ready=false;
  for(let attempt=0;attempt<100;attempt++){
    if(child.exitCode!==null)throw Error(`Servidor isolado encerrou: ${serverLog}`);
    try { if((await fetch(origin+'/health/ready',{signal:AbortSignal.timeout(500)})).ok){ready=true;break;} }catch(_){}
    await pause(150);
  }
  assert.ok(ready,`Servidor isolado não iniciou: ${serverLog}`);
  browser=await chromium.launch();
  const page=await browser.newPage({reducedMotion:'reduce'}), errors=[];
  page.setDefaultTimeout(10000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin ? route.continue() : route.abort());
  await page.goto(origin+'/ui/frontend/login.html');
  await page.locator('#developmentAccess').waitFor({state:'visible'});
  await page.locator('#developmentAccess summary').click();
  await page.locator('#developmentLogin').click();
  await page.locator('body:not(.auth-pending) .page-title').waitFor();
  async function bootstrap(){const response=await page.request.get(origin+'/v1/frontend/bootstrap');assert.equal(response.status(),200);return (await response.json()).data;}
  assert.equal((await bootstrap()).clients.length,0);
  async function open(name,...args){await page.evaluate(({name,args})=>window[name](...args),{name,args});await page.locator('#legalOperationForm').waitFor();}
  async function fill(values){for(const [id,value]of Object.entries(values))await page.locator('#'+id).fill(value);}
  async function select(id,value){await page.locator('#'+id).selectOption(value);}
  async function save(route,method='POST'){
    const waiting=page.waitForResponse(response=>new URL(response.url()).pathname===`/v1${route}`&&response.request().method()===method);
    await page.locator('#modal .modal-footer button').filter({hasText:/^Salvar$/}).click();
    const response=await waiting;
    assert.ok(response.ok(),`${method} ${route}: ${response.status()} ${await response.text()}`);
    const result=await response.json();
    await page.waitForFunction(()=>!document.getElementById('modal').classList.contains('active'));
    console.log(`PASS ${method} ${route}`);
    return result;
  }
  await open('openClientForm');
  await fill({f_name:'Pessoa do teste isolado',f_document:'00000000000',f_email:'isolated@example.test',f_notes:'Acentuação: diligências e créditos 💳'});
  const client=await save('/clients');
  await open('openClientForm',client.id);await fill({f_name:'Pessoa revisada no teste'});await save(`/clients/${client.id}`,'PATCH');
  await open('openProcessForm');await fill({f_number:'0000000-00.2026.8.00.0000',f_court:'Órgão do teste',f_value:'123.45'});await select('f_clientId',client.id);
  const legalCase=await save('/processes');
  await open('openProcessForm',legalCase.id);await fill({f_notes:'Alteração persistida no processo'});await save(`/processes/${legalCase.id}`,'PATCH');
  await open('openDeadlineForm');await fill({f_title:'Prazo do teste',f_date:'2026-10-15'});await select('f_processId',legalCase.id);
  const deadline=await save('/deadlines');
  await open('openDeadlineForm',deadline.id);await fill({f_title:'Prazo revisado'});await save(`/deadlines/${deadline.id}`,'PATCH');
  await open('openAppointmentForm');await fill({f_title:'Reunião do teste',f_date:'2026-10-14',f_time:'10:30'});await select('f_processId',legalCase.id);
  const appointment=await save('/appointments');
  await open('openAppointmentForm',appointment.id);await select('f_status','concluido');await save(`/appointments/${appointment.id}`,'PATCH');
  await open('openFinancialForm');await fill({f_description:'Honorários do teste',f_date:'2026-10-13',f_amount:'250.75'});await select('f_processId',legalCase.id);
  const financial=await save('/financial-entries');
  await open('openFinancialForm',financial.id);await select('f_status','recebido');await save(`/financial-entries/${financial.id}`,'PATCH');
  await open('openIntimationForm');await select('f_processId',legalCase.id);await fill({f_content:'Publicação isolada para verificação do lançamento conjunto.',f_receivedAt:'2026-09-26T10:30'});
  const intimation=await save('/intimations');
  await page.evaluate(id=>lancarIntimacaoNoAndamento(id),intimation.id);
  await page.locator('#legalOperationForm').waitFor();
  await fill({launchDate:'2026-09-26',launchDescription:'Andamento revisado no teste'});
  const launchResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`/v1/intimations/${intimation.id}/launch`&&response.request().method()==='POST');
  await page.locator('#modal .modal-footer .btn-primary').click();
  const launched=await launchResponse;assert.ok(launched.ok(),await launched.text());
  await page.waitForFunction(()=>!document.getElementById('modal').classList.contains('active'));
  await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();
  const stored=await bootstrap();
  assert.equal(stored.clients[0].name,'Pessoa revisada no teste');assert.ok(stored.clients[0].notes.includes('💳'));
  assert.equal(stored.processes[0].notes,'Alteração persistida no processo');
  assert.equal(stored.deadlines[0].title,'Prazo revisado');assert.equal(stored.appointments[0].status,'concluido');
  assert.equal(stored.financial[0].status,'recebido');assert.equal(stored.intimations[0].status,'concluida');
  assert.equal(stored.processMovements.length,1);
  // Exercise the new profile against the real API, including reload persistence.
  await page.evaluate(id=>{showClientDetail360(id);switchClientTab('perfil');},client.id);
  await page.getByRole('button',{name:'Editar perfil complementar',exact:true}).click();
  await page.getByLabel('Profissão',{exact:true}).fill('Advogado do teste');
  await page.getByLabel('Biografia',{exact:true}).fill('Informações fornecidas no teste isolado.');
  await page.getByLabel('Notas complementares',{exact:true}).fill('Notas do perfil, distintas do cadastro.');
  const profileSaved=page.waitForResponse(response=>new URL(response.url()).pathname===`/v1/clients/${client.id}/profile`&&response.request().method()==='PUT');
  await page.getByRole('button',{name:'Salvar perfil',exact:true}).click();assert.ok((await profileSaved).ok());
  await page.getByRole('button',{name:'Editar perfil complementar',exact:true}).waitFor();
  await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();
  await page.evaluate(id=>{showClientDetail360(id);switchClientTab('perfil');},client.id);
  await page.getByRole('button',{name:'Editar perfil complementar',exact:true}).waitFor();
  assert.match(await page.locator('#clientProfileContent').textContent(),/Advogado do teste/);
  assert.ok((await bootstrap()).clients[0].notes.includes('💳'),'Basic notes must not be replaced by profile notes');
  await page.evaluate(()=>closeModal());

  // Only the original-file metadata is a fixture; links use real HTTP/SQLite.
  // No storage provider, SMTP, payment or operational database is accessed.
  const identityResponse=await page.request.get(origin+'/v1/frontend/bootstrap');
  const currentIdentity=(await identityResponse.json()).me;
  const seedPath=path.join(directory,'seed_document.py');
  await fs.writeFile(seedPath,`import asyncio, sys\nfrom datetime import datetime, UTC\nfrom uuid import UUID\nfrom app.db import SessionLocal\nfrom app.models import Evidence\nasync def main():\n    async with SessionLocal() as session:\n        item = Evidence(tenant_id=UUID(sys.argv[1]),original_filename='documento-isolado.txt',mime_type='text/plain',size_bytes=7,sha256='a'*64,source_type='test',collection_method='isolated-fixture',collected_at=datetime.now(UTC))\n        session.add(item)\n        await session.flush()\n        item_id=str(item.id)\n        await session.commit()\n        print(item_id)\nasyncio.run(main())\n`,'utf8');
  const evidenceId=await new Promise((resolve,reject)=>{
    const process=spawn(python,[seedPath,currentIdentity.tenant_id],{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',error='';process.stdout.on('data',chunk=>output+=chunk.toString());process.stderr.on('data',chunk=>error+=chunk.toString());
    process.on('error',reject);process.on('exit',code=>code===0?resolve(output.trim()):reject(Error(error)));
  });
  await page.evaluate(id=>{showClientDetail360(id);switchClientTab('documentos');},client.id);
  await page.locator('#legalDocumentSelect').selectOption(evidenceId);await page.locator('#legalDocumentLabel').fill('Mandato isolado');
  await page.locator('[data-link-form] button[type=submit]').click();await page.getByText('Vínculo salvo.',{exact:true}).waitFor();
  await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();
  await page.evaluate(id=>{showClientDetail360(id);switchClientTab('documentos');},client.id);
  await page.locator('[data-unlink]').waitFor();assert.match(await page.locator('#legalDocumentsPanel').textContent(),/Mandato isolado/);
  await page.locator('[data-unlink]').click();await page.getByText('Vínculo removido. O arquivo foi mantido.',{exact:true}).waitFor();
  const originals=await page.request.get(origin+'/v1/evidences');assert.ok((await originals.json()).some(row=>row.id===evidenceId));
  await page.evaluate(()=>closeModal());

  const investigationResponse=await page.request.post(origin+'/v1/investigations',{data:{title:'Investigação do teste',category:'test',objective:'Validar planejamento e revisão com persistência no banco isolado do navegador.',purpose:'Teste isolado de planejamento',legal_basis:'contrato',authorization_reference:'TESTE',proportionality_assessment:'Limitado aos dados do teste',scope_codes:['empresarial'],risk_level:'low'}});
  assert.equal(investigationResponse.status(),201,await investigationResponse.text());
  const investigation=(await investigationResponse.json()).id;
  await page.evaluate(async id=>{await refreshBackendBootstrap();openInvestigationWorkspace(id);switchOsintTab('motores');},investigation);
  await page.locator('#investigationEngines summary').click();
  await page.locator('#engineInvestigation').selectOption(investigation);
  await fill({engineTarget:'Empresa declarada no teste',enginePurpose:'Planejamento autorizado do teste isolado',engineReference:'TESTE-ISOLADO'});
  await page.locator('#engineBasis').selectOption('legitimo_interesse');await page.locator('[name=declared_scope]').first().check();await page.locator('[name=acknowledge]').check();
  const planSaved=page.waitForResponse(response=>new URL(response.url()).pathname==='/v1/investigation-engines/tacer/run'&&response.request().method()==='POST');
  await page.locator('[data-engine-form] button[type=submit]').click();const planResponse=await planSaved;assert.ok(planResponse.ok(),await planResponse.text());
  await page.locator('#engineReviewNotes').fill('Revisão registrada pelo responsável do teste');
  await page.locator('[data-engine-review] button[type=submit]').click();await page.getByRole('heading',{name:'Revisão humana registrada'}).waitFor();
  await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();
  await page.evaluate(id=>{openInvestigationWorkspace(id);switchOsintTab('motores');},investigation);
  await page.locator('[data-engine-open]').click();await page.getByRole('heading',{name:'Revisão humana registrada'}).waitFor();
  assert.match(await page.locator('[data-engine-detail]').textContent(),/Revisão registrada pelo responsável/);
  await page.evaluate(()=>closeModal());
  const audit=await page.request.get(origin+'/v1/audit-events');assert.ok((await audit.json()).length>0);
  for(const [name,id,route]of [['deleteFinancial',financial.id,'financial-entries'],['deleteAppointment',appointment.id,'appointments'],['deleteDeadline',deadline.id,'deadlines']]){
    const waiting=page.waitForResponse(response=>new URL(response.url()).pathname===`/v1/${route}/${id}`&&response.request().method()==='DELETE');
    await page.evaluate(({name,id})=>window[name](id),{name,id});assert.ok((await waiting).ok());
  }
  await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();
  const after=await bootstrap();assert.equal(after.financial.length,0);assert.equal(after.appointments.length,0);assert.equal(after.deadlines.length,0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,realApi:true,isolatedDatabase:true,flows:['client create/edit','process create/edit','deadline create/edit/delete','appointment create/edit/delete','financial create/edit/delete','intimation create/launch','reload persistence','audit persistence','client profile save/reload','document link/reload/detach preserves original','investigation plan/review/reload'],browserErrors:errors.length}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();if(child?.exitCode===null)child.kill();});
