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

  // Exercise every wizard step instead of bypassing the browser form. Values
  // must survive a fresh bootstrap; the browser cache is only a projection.
  await page.evaluate(()=>openInvestigationWizard());
  await fill({wz_title:'Investigação do teste',wz_owner:'Responsável declarado do teste',wz_deadline:'2026-10-16'});
  await select('wz_category','societaria');await select('wz_priority','alta');
  await select('wz_clientId',client.id);await select('wz_processId',legalCase.id);
  await page.locator('#modal').getByRole('button',{name:'Avançar →',exact:true}).click();
  await fill({wz_objective:'Validar planejamento e revisão com persistência no banco isolado do navegador.',wz_hypothesis:'Hipótese pendente de verificação do teste.',wz_questions:'Qual registro foi consultado?\nA coleta está vinculada ao achado?',wz_expected:'Relatório revisável com diligências e créditos 💳'});
  await page.locator('#modal').getByRole('button',{name:'Avançar →',exact:true}).click();
  await fill({wz_purpose:'Teste isolado de planejamento',wz_authRef:'TESTE-ISOLADO',wz_liaText:'Limitado aos dados do teste isolado',wz_retention:'2'});
  await select('wz_legalBasis','legitimo_interesse');await select('wz_riskLevel','baixo');
  await page.locator('.wz_scope[value=empresarial]').check();
  await page.locator('#modal').getByRole('button',{name:'Avançar →',exact:true}).click();
  await page.locator('#wz_declaration').check();
  const investigationSaved=page.waitForResponse(response=>new URL(response.url()).pathname==='/v1/investigations'&&response.request().method()==='POST');
  await page.locator('#modal').getByRole('button',{name:'Criar investigação',exact:true}).click();
  const investigationResponse=await investigationSaved;
  assert.equal(investigationResponse.status(),201,await investigationResponse.text());
  const investigation=(await investigationResponse.json()).id;
  await page.locator('#modal .tab').filter({hasText:'Visão Geral'}).waitFor();
  await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();
  const investigationRecord=(await bootstrap()).investigations.find(row=>row.id===investigation);
  assert.equal(investigationRecord.owner,'Responsável declarado do teste');assert.equal(investigationRecord.priority,'alta');
  assert.equal(investigationRecord.deadline,'2026-10-16');assert.equal(investigationRecord.expected,'Relatório revisável com diligências e créditos 💳');
  assert.deepEqual(investigationRecord.questions,['Qual registro foi consultado?','A coleta está vinculada ao achado?']);
  assert.equal(investigationRecord.clientId,client.id);assert.equal(investigationRecord.processId,legalCase.id);
  await page.evaluate(id=>{openInvestigationWorkspace(id);switchOsintTab('entidades');},investigation);
  await page.locator('#modal').getByRole('button',{name:'+ Adicionar entidade',exact:true}).click();
  await select('ent_type','pessoa_juridica');
  await fill({ent_name:'Entidade do teste isolado',ent_aliases:'Nome anterior, Razão alternativa',ent_notes:'Identidade declarada no teste, sem consulta externa.'});
  const entitySaved=page.waitForResponse(response=>new URL(response.url()).pathname===`/v1/investigations/${investigation}/entities`&&response.request().method()==='POST');
  await page.locator('#modal .modal-footer').getByRole('button',{name:'Salvar',exact:true}).click();
  const entityResponse=await entitySaved;assert.equal(entityResponse.status(),201,await entityResponse.text());
  const entity=(await entityResponse.json()).id;
  await page.locator('#modal').getByText('Entidade do teste isolado',{exact:true}).waitFor();
  await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();
  assert.deepEqual((await bootstrap()).osintEntities.find(row=>row.id===entity).aliases,['Nome anterior','Razão alternativa']);
  console.log('PASS Investigation wizard fields and entity aliases saved by real forms and retained after reload');

  // Only the completed provider response is a fixture. The history, finding
  // association, review, report and reload below all use real HTTP and SQLite.
  // No provider is queried and no queue is published in this isolated suite.
  const connectorSeedPath=path.join(directory,'seed_connector.py');
  const snapshot={tool:'phone',target:'+5511999999999',data:{normalized:'+5511999999999',valid_format:true,ddd:'11',ddd_data:{state:'SP',cities:['Cidade do teste isolado']},line_confirmed:null,limitation:'Não confirma titularidade; registro do teste isolado.'},partial:false,limitations:['Fixture isolada; nenhuma consulta externa executada.']};
  await fs.writeFile(connectorSeedPath,`import asyncio, hashlib, json, sys\nfrom uuid import UUID\nfrom app.db import SessionLocal\nfrom app.models import ConnectorRun\nasync def main():\n    snapshot=json.loads(sys.argv[4])\n    async with SessionLocal() as session:\n        item=ConnectorRun(tenant_id=UUID(sys.argv[1]),investigation_id=UUID(sys.argv[2]),target_entity_id=UUID(sys.argv[3]),connector_id='osint_tools',status='completed',purpose='Coleta isolada para verificar vínculo persistido',correlation_id='browser-isolated-connector',request_hash='b'*64,request_payload={'tool':'phone','value':snapshot['target'],'authorized':True},response_hash=hashlib.sha256(json.dumps(snapshot,sort_keys=True).encode()).hexdigest(),raw_snapshot=snapshot,normalized_result=snapshot,limitations=snapshot['limitations'])\n        session.add(item)\n        await session.flush()\n        item_id=str(item.id)\n        await session.commit()\n        print(item_id)\nasyncio.run(main())\n`,'utf8');
  const runId=await new Promise((resolve,reject)=>{
    const process=spawn(python,[connectorSeedPath,currentIdentity.tenant_id,investigation,entity,JSON.stringify(snapshot)],{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',error='';process.stdout.on('data',chunk=>output+=chunk.toString());process.stderr.on('data',chunk=>error+=chunk.toString());
    process.on('error',reject);process.on('exit',code=>code===0?resolve(output.trim()):reject(Error(error)));
  });
  const findingResponse=await page.request.post(origin+`/v1/investigations/${investigation}/findings`,{data:{entity_id:entity,connector_run_id:runId,title:'Achado vinculado à coleta isolada',statement:'Declaração persistida e submetida à revisão humana no teste.',source_name:'Fonte do teste isolado',method:'connector_run',collected_at:'2026-10-01T12:00:00Z',reliability_score:0.5,limitations:['Registro exclusivamente de teste.']}});
  assert.equal(findingResponse.status(),201,await findingResponse.text());
  const finding=(await findingResponse.json()).id;
  await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();
  assert.equal((await bootstrap()).osintFindings.find(row=>row.id===finding).runId,runId);
  await page.evaluate(id=>{openInvestigationWorkspace(id);switchOsintTab('achados');},investigation);
  const findingRow=page.locator('#modal tbody tr').filter({hasText:'Achado vinculado à coleta isolada'});
  const reviewed=page.waitForResponse(response=>new URL(response.url()).pathname===`/v1/findings/${finding}`&&response.request().method()==='PATCH');
  await findingRow.getByRole('button',{name:'Validar',exact:true}).click();assert.ok((await reviewed).ok());
  await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();
  const savedFinding=(await bootstrap()).osintFindings.find(row=>row.id===finding);
  assert.equal(savedFinding.runId,runId);assert.equal(savedFinding.humanValidated,true);
  assert.equal(savedFinding.classification,'conclusao_humana');
  await page.evaluate(()=>navigateSection('osinttools'));
  await page.locator(`[data-tool-run="${runId}"]`).click();
  await page.getByText('Consulta concluída',{exact:false}).first().waitFor();
  assert.match(await page.locator('#otRawWrap').textContent(),/Cidade do teste isolado/);
  assert.equal(await page.evaluate(()=>osintToolsState.lastResult.runId),runId);
  await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();
  await page.locator(`[data-tool-run="${runId}"]`).click();await page.locator('#otRawWrap').waitFor();
  assert.deepEqual(await page.evaluate(()=>osintToolsState.lastResult.data),snapshot);
  console.log('PASS OSINT history and linked finding review reloaded from the real database');

  // A client-side edit must never enter an investigative report. The POST
  // carries only an idempotency key and the server reads its persisted records.
  await page.evaluate(({investigation,finding})=>{
    DB.investigations.find(row=>row.id===investigation).expected='CONTEÚDO SOMENTE NO NAVEGADOR';
    DB.osintFindings.find(row=>row.id===finding).statement='CONTEÚDO SOMENTE NO NAVEGADOR';
    openInvestigationWorkspace(investigation);switchOsintTab('relatorio');
  },{investigation,finding});
  await page.locator('#modal').getByRole('button',{name:'📄 Criar rascunho investigativo',exact:true}).click();
  const reportSaved=page.waitForResponse(response=>new URL(response.url()).pathname===`/v1/investigations/${investigation}/report-draft`&&response.request().method()==='POST');
  await page.locator('#modal').getByRole('button',{name:'Confirmar',exact:true}).click();
  const reportResponse=await reportSaved;assert.equal(reportResponse.status(),201,await reportResponse.text());
  const reportReceipt=await reportResponse.json();assert.equal(reportReceipt.status,'DRAFT');assert.match(reportReceipt.content_hash,/^[a-f0-9]{64}$/);
  const reportCommand=reportResponse.request().postDataJSON();assert.deepEqual(Object.keys(reportCommand),['request_id']);
  await page.locator('#reportsRecords h3').filter({hasText:'Relatório investigativo — Investigação do teste'}).waitFor();
  await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();
  await page.locator('#reportsRecords h3').filter({hasText:'Relatório investigativo — Investigação do teste'}).waitFor();
  await page.locator('#reportsRecords').getByText('Revisar conteúdo',{exact:true}).click();
  assert.match(await page.locator('#reportsRecords').textContent(),/Qual registro foi consultado/);
  assert.doesNotMatch(await page.locator('#reportsRecords').textContent(),/CONTEÚDO SOMENTE NO NAVEGADOR/);
  const reportsResponse=await page.request.get(origin+`/v1/reports?investigation_id=${investigation}`);assert.ok(reportsResponse.ok());
  const reports=await reportsResponse.json();assert.equal(reports.length,1);
  const report=reports[0];assert.equal(report.id,reportReceipt.report_id);assert.equal(report.content_hash,reportReceipt.content_hash);
  assert.equal(report.body.investigation.expected_result,investigationRecord.expected);
  assert.equal(report.body.investigation.responsible,investigationRecord.owner);
  assert.deepEqual(report.body.investigation.questions,investigationRecord.questions);
  assert.deepEqual(report.body.entities[0].aliases,['Nome anterior','Razão alternativa']);
  assert.equal(report.body.findings[0].connector_run_id,runId);assert.equal(report.body.findings[0].reviewed,true);
  assert.equal(report.body.findings[0].statement,'Declaração persistida e submetida à revisão humana no teste.');
  assert.equal(report.body.collections[0].id,runId);assert.equal(report.body.collections[0].status,'completed');
  const repeatedReport=await page.request.post(origin+`/v1/investigations/${investigation}/report-draft`,{data:reportCommand});
  assert.equal(repeatedReport.status(),201,await repeatedReport.text());assert.deepEqual(await repeatedReport.json(),reportReceipt);
  assert.equal((await (await page.request.get(origin+`/v1/reports?investigation_id=${investigation}`)).json()).length,1);
  console.log('PASS Investigative report persists server records, rejects browser-only content and reuses the command receipt');

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
  // Dashboard -> real aggregates from the isolated database, including writes made
  // after bootstrap. Browser-only rows must never become operational indicators.
  async function api(path,method='GET',data){
    const response=await page.request.fetch(origin+'/v1'+path,{method,...(data?{data}:{})});
    assert.ok(response.ok(),`${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.status()===204?null:response.json();
  }
  const baseline=await api('/dashboard?month=2026-10');
  const yesterday=new Date(baseline.today+'T12:00:00Z');yesterday.setUTCDate(yesterday.getUTCDate()-1);
  const late=await api('/deadlines','POST',{process_id:legalCase.id,title:'Prazo atrasado do banco',due_date:yesterday.toISOString().slice(0,10),status:'pending'});
  const cancelled=await api('/appointments','POST',{process_id:legalCase.id,title:'Compromisso cancelado do banco',appointment_date:baseline.today,status:'cancelled'});
  const extras=[];
  for(const data of [
    {entry_type:'revenue',status:'received',entry_date:'2026-09-13',amount:'500.00'},
    {entry_type:'expense',status:'paid',entry_date:'2026-10-13',amount:'40.00'},
    {entry_type:'revenue',status:'overdue',entry_date:'2026-10-13',amount:'80.00'},
    {entry_type:'expense',status:'overdue',entry_date:'2026-10-13',amount:'30.00'},
    {entry_type:'revenue',status:'forecast',entry_date:'2026-10-13',amount:'99.95'},
  ]) extras.push(await api('/financial-entries','POST',{client_id:client.id,description:'Lançamento isolado do dashboard',...data}));
  const projection=await api('/dashboard?month=2026-10');
  assert.equal(projection.counts.critical_deadlines,baseline.counts.critical_deadlines+1);
  assert.equal(projection.counts.overdue_deadlines,baseline.counts.overdue_deadlines+1);
  assert.equal(projection.counts.appointments_today,baseline.counts.appointments_today);
  assert.equal(projection.counts.stored_files,0);assert.equal(projection.counts.pending_files,1);
  assert.equal(projection.financial.received_month,'250.75');assert.equal(projection.financial.net_month,'210.75');
  assert.equal(projection.financial.overdue_receivables,'80.00');assert.equal(projection.financial.overdue_payables,'30.00');
  assert.ok(projection.urgent_actions.items.some(row=>row.id===late.id));
  await page.evaluate(()=>{
    DB.files.push({id:'only-in-browser',name:'not-stored.pdf'});
    DB.audit=Array.from({length:9999},(_,i)=>({id:String(i)}));
    DB.financial=[];DB.deadlines=[];DB.appointments=[];
    navigateSection('dashboard');
  });
  await page.getByText('Dados consultados com sucesso.',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-metric=stored_files] .kpi-value').textContent(),'0');
  assert.notEqual(await page.locator('[data-metric=total_audit_events] .kpi-value').textContent(),'9999');
  assert.equal(await page.locator('[data-metric=critical_deadlines] .kpi-value').textContent(),String(projection.counts.critical_deadlines));
  await page.locator('[data-metric=critical_deadlines]').click();
  await page.locator('.page-title').filter({hasText:'Prazos'}).waitFor();
  assert.ok((await page.evaluate(()=>DB.deadlines)).some(row=>row.id===late.id),'Opening details must refresh the server records instead of retaining the empty browser cache');
  await page.evaluate(()=>navigateSection('dashboard'));await page.getByText('Dados consultados com sucesso.',{exact:true}).waitFor();
  await page.locator('#dashboardMonth').fill('2026-10');await page.locator('#dashboardMonth').dispatchEvent('change');
  await page.getByText('Dados consultados com sucesso.',{exact:true}).waitFor();
  assert.match(await page.locator('.detail-row').filter({hasText:'Recebido no período'}).textContent(),/250,75/);
  assert.match(await page.locator('.detail-row').filter({hasText:'Saldo dos lançamentos'}).textContent(),/210,75/);
  await page.locator('[data-dashboard-day="2026-10-14"]').click();
  await page.getByText('Compromisso: Reunião do teste',{exact:true}).waitFor();
  assert.match(await page.locator('#dashboardRecords').textContent(),/Concluído/);
  await page.locator('[data-dashboard-close]').click();
  await page.locator('[data-dashboard-month-step="-1"]').click();
  await page.getByText('Dados consultados com sucesso.',{exact:true}).waitFor();
  assert.match(await page.locator('.detail-row').filter({hasText:'Recebido no período'}).textContent(),/500,00/);
  // Failure must preserve a clearly marked old snapshot, never invent zeros.
  await page.route('**/v1/dashboard?*',route=>route.fulfill({status:503,json:{detail:'Isolated failure'}}));
  await page.locator('[data-dashboard-refresh]').click();
  await page.locator('#dashboardStatus[role=alert]').waitFor();
  assert.match(await page.locator('#dashboardStatus').textContent(),/última consulta/);
  assert.match(await page.locator('.detail-row').filter({hasText:'Recebido no período'}).textContent(),/500,00/);
  await page.unroute('**/v1/dashboard?*');
  await api('/financial-entries/'+extras.at(-1).id,'PATCH',{client_id:client.id,description:'Lançamento isolado do dashboard',entry_type:'revenue',status:'forecast',entry_date:'2026-10-13',amount:'120.50'});
  await page.locator('[data-dashboard-refresh]').click();await page.getByText('Dados consultados com sucesso.',{exact:true}).waitFor();
  assert.match(await page.locator('[data-metric=forecast_revenue] .kpi-value').textContent(),/120,50/);
  for(const item of extras)await api('/financial-entries/'+item.id,'DELETE');
  await api('/deadlines/'+late.id,'DELETE');await api('/appointments/'+cancelled.id,'DELETE');
  console.log('PASS Dashboard real database aggregates, periods, cancelled/overdue records, refresh and browser-state independence');
  for(const [name,id,route]of [['deleteFinancial',financial.id,'financial-entries'],['deleteAppointment',appointment.id,'appointments'],['deleteDeadline',deadline.id,'deadlines']]){
    const waiting=page.waitForResponse(response=>new URL(response.url()).pathname===`/v1/${route}/${id}`&&response.request().method()==='DELETE');
    await page.evaluate(({name,id})=>window[name](id),{name,id});assert.ok((await waiting).ok());
  }
  await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();
  const after=await bootstrap();assert.equal(after.financial.length,0);assert.equal(after.appointments.length,0);assert.equal(after.deadlines.length,0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,realApi:true,isolatedDatabase:true,flows:['client create/edit','process create/edit','deadline create/edit/delete','appointment create/edit/delete','financial create/edit/delete','intimation create/launch','reload persistence','audit persistence','client profile save/reload','document link/reload/detach preserves original','investigation wizard fields/reload','entity aliases/reload','OSINT saved history/reopen','finding collection link/review/reload','investigative report from persisted records/reload/idempotency','investigation plan/review/reload','dashboard aggregates/calendar/refresh from database'],browserErrors:errors.length}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();if(child?.exitCode===null)child.kill();});
