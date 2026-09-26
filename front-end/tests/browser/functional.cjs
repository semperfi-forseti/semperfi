/* Isolated browser regression. No real API, identity, payment or provider is used.
 * Run: NODE_PATH=<directory containing playwright and axe-core> node tests/browser/functional.cjs
 * The local review-tools installation is also recognized on Windows.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
function dependency(name) {
  try { return require(name); }
  catch (_) { return createRequire(path.join(os.tmpdir(), 'semperfi-review-tools', 'package.json'))(name); }
}
const { chromium } = dependency('playwright');
const root = path.resolve(__dirname, '../..');
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const xss = '<img src=x onerror="window.__xss=1"> " & <script>window.__xss=1</script>';
const today = new Date().toLocaleDateString('en-CA');
const results = [], errors = [], unexpected = [], requests = [];
let activeCase = 'startup', billingEnabled = true, checkoutUrl = 'https://sandbox.asaas.com/checkout/test-only';
let agentCreated = false, agentEnabled = true, uploaded = false, reportError = true, queryPolls = 0;
const state = {
  clients: [{id:id(1),name:xss,type:'PF',document:'00000000000',email:'fixture@example.test',phone:'',address:'',notes:xss,responsible:'',status:'ativo',createdAt:Date.now()},
    {id:id(2),name:'Outro registro isolado',type:'PJ',document:'00000000000000',status:'ativo',createdAt:Date.now()}],
  processes: [{id:id(3),clientId:id(1),number:'0000000-00.2026.8.00.0000',court:xss,area:'Cível',phase:'Inicial',status:'ativo',responsible:'',notes:xss,value:0,createdAt:Date.now()}],
  intimations: [{id:id(4),processId:id(3),source:xss,type:'despacho',content:xss,receivedAt:'2026-09-25T12:00:00Z',confidence:'media',status:'triagem',createdAt:Date.now()}],
  investigations: [{id:id(5),title:'Investigação isolada',status:'aberta',riskLevel:'baixo',purpose:'Validação isolada de interface',legalBasis:'legitimo_interesse',authorizationReference:'TESTE',createdAt:Date.now(),scopeCodes:[]}],
  deadlines:[{id:id(20),processId:id(3),title:xss,date:today,status:'pendente',type:'manifestacao',responsible:'',notes:''}],appointments:[],
  financial:[{id:id(21),clientId:id(1),processId:id(3),type:'receita',description:xss,date:today,amount:10,status:'vencido',category:'honorarios'}],processMovements:[]
};
const agent = () => ({id:id(6),agent_type:'timeline',status:'pending_human_review',model_name:'local-test',input_safe:{text:xss},output:{analysis:xss},limitations:['Revisão humana obrigatória']});
const evidence = () => ({id:id(7),original_filename:'teste-isolado.pdf',validation_status:'pending',mime_type:'application/pdf',size_bytes:24,sha256:'a'.repeat(64),storage_key:null});
const reports = [{id:id(8),title:xss,version:1,status:'DRAFT',body:{summary:xss}}, {id:id(9),title:'Relatório aprovado isolado',version:1,status:'FINAL',body:{summary:'Revisado'}}];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/v1')) { unexpected.push(`API escaped mock: ${req.url}`); res.writeHead(502).end(); return; }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
    const content = await fs.readFile(file);
    res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream'}).end(content);
  } catch (_) { res.writeHead(404).end(); }
});
async function mock(route, origin) {
  const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname;
  if (url.origin !== origin) { await route.abort(); return; } // All external network is blocked.
  if (!pathname.startsWith('/v1/')) { await route.continue(); return; }
  const raw = request.postData() || '';
  let body; try { body = JSON.parse(raw); } catch (_) { body = raw; }
  requests.push({method,path:pathname,body,headers:request.headers()});
  const reply = (json, status = 200) => route.fulfill({json,status});
  if (pathname === '/v1/auth/status') return reply({authenticated:true,password_enabled:true,registration_enabled:true});
  if (pathname === '/v1/frontend/bootstrap') return reply({data:state,me:{display_name:'Operador isolado',email:'fixture@example.test',roles:['administrator']}});
  if (pathname === '/v1/clients' && method === 'POST') {
    await delay(100); const saved = {id:id(10),name:body.name,type:body.kind,document:body.document,email:body.email,status:body.status,createdAt:Date.now()}; state.clients.push(saved); return reply({id:saved.id},201);
  }
  if (pathname.startsWith('/v1/clients/') && method === 'GET') { const saved=state.clients.find(row=>row.id===pathname.split('/').at(-1)); return reply({...saved,kind:saved.type}); }
  if (pathname === '/v1/appointments' && method === 'POST') return reply({id:id(11),status:'confirmed'},201);
  if (pathname === `/v1/intimations/${id(4)}/launch`) {
    await delay(100); state.intimations[0].status='concluida';
    state.processMovements.push({id:id(12),processId:id(3),intimationId:id(4),date:body.movement.occurred_on,type:'intimacao',description:body.movement.description,source:'manual',attachments:[]});
    if(body.deadline)state.deadlines.push({id:id(13),processId:id(3),title:body.deadline.title,date:body.deadline.due_date,status:'pendente'});
    if(body.appointment)state.appointments.push({id:id(14),processId:id(3),clientId:id(1),title:body.appointment.title,date:body.appointment.appointment_date,time:body.appointment.appointment_time,status:'confirmado',type:'reuniao'});
    return reply({intimation_id:id(4),movement_id:id(12),already_launched:false,status:'concluded'},201);
  }
  if (pathname === '/v1/osint/runs' && method === 'POST') {queryPolls=0;return reply({run_id:'query-fixture',job_id:'job-fixture',status:'queued'},202);}
  if (pathname === '/v1/osint/runs/query-fixture') return reply(++queryPolls===1 ? {run_id:'query-fixture',status:'running'} : {run_id:'query-fixture',status:'completed',raw_snapshot:{razao_social:xss}});
  if (pathname === '/v1/billing/status') return reply({enabled:billingEnabled,can_checkout:billingEnabled,environment:'sandbox',sandbox_only:true,checkouts:[{plan_key:'lite',status:'PENDING',checkout_url:'https://attacker.invalid/test'}]});
  if (pathname === '/v1/billing/catalog') return reply({plans:[{key:'lite',name:'Lite',price:89.90}]});
  if (pathname === '/v1/billing/checkouts') {await delay(80);return reply({id:id(15),environment:'sandbox',checkout_url:checkoutUrl},201);}
  if (pathname === '/v1/agents/status') return reply({enabled:agentEnabled,provider:'ollama',model:'local-test'});
  if (pathname === '/v1/agents/runs' && method === 'POST') {await delay(80);agentCreated=true;return reply({agent_run_id:id(6),status:'queued'},202);}
  if (pathname === '/v1/agents/runs') return reply(agentCreated?[agent()]:[]);
  if (pathname === `/v1/agents/runs/${id(6)}`) return reply(agent());
  if (pathname === '/v1/evidences') return reply(uploaded?[evidence()]:[]);
  if (pathname === '/v1/evidences/uploads') {uploaded=true;return reply({evidence_id:id(7),status:'pending'},201);}
  if (pathname === `/v1/evidences/${id(7)}/events`) return reply([{event_type:'uploaded',details:xss}]);
  if (pathname === '/v1/reports') return reply(reports);
  if (pathname === `/v1/reports/${id(8)}/approve`) return reportError ? reply({detail:{policy_code:'MFA_REAUTH_REQUIRED',reason:'Confirmação de segurança recente necessária.'}},403) : reply({status:'FINAL'});
  if (pathname === `/v1/reports/${id(9)}/download`) return reportError ? reply({detail:'Cofre indisponível para teste.'},503) : reply({url:'javascript:window.__xss=1',expires_in_seconds:60});
  if (['/v1/audit-events','/v1/osint/runs','/v1/catalog/connectors','/v1/connectors'].includes(pathname)) return reply([]);
  unexpected.push(`${method} ${pathname}`);return reply({detail:'Unmocked test route'},501);
}
const count = (method, pathname) => requests.filter(r=>r.method===method&&r.path===pathname).length;
const last = pathname => requests.filter(r=>r.path===pathname).at(-1);
async function waitText(page, selector, text) { await page.waitForFunction(({selector,text})=>document.querySelector(selector)?.textContent.includes(text),{selector,text}); }
async function navigate(page, section) {await page.evaluate(section=>navigateSection(section),section);await page.locator('#contentWrapper > :first-child').waitFor();}
async function contextFields(page, prefix) {await page.locator(`#${prefix}Purpose`).fill('Teste isolado de integração da interface');await page.locator(`#${prefix}Basis`).selectOption('legitimo_interesse');await page.locator(`#${prefix}Reference`).fill('TESTE-ISOLADO');await page.locator(`#${prefix}Investigation`).selectOption(id(5));}
async function runCase(name, page, operation) {
  activeCase=name;
  await page.evaluate(()=>{window.__xss=0;});
  try {await operation();assert.equal(await page.evaluate(()=>window.__xss||0),0,'Untrusted record executed script');results.push({name,passed:true});console.log(`PASS ${name}`);}
  catch(error){results.push({name,passed:false,error:error.message});console.error(`FAIL ${name}: ${error.message}`);}
  finally {await page.evaluate(()=>window.closeModal?.()).catch(()=>{});}
}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser=await chromium.launch();
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce',colorScheme:'light'});
    page.setDefaultTimeout(8000);
    page.on('pageerror',error=>errors.push({case:activeCase,message:error.message}));
    page.on('dialog',dialog=>dialog.accept());
    await page.route('**/*',route=>mock(route,origin));
    await page.goto(origin+'/index.html');await page.locator('body:not(.auth-pending) .page-title').waitFor();
    await runCase('Notification previews preserve literal untrusted content',page,async()=>{
      await page.evaluate(()=>renderNotifications());await delay(60);
      assert.equal(await page.locator('#notifList img').count(),0);
      assert.ok((await page.locator('#notifList').textContent()).includes('<img'));
    });
    await runCase('All 21 sections render with API fixtures',page,async()=>{
      const sections=await page.evaluate(()=>SECTIONS.map(item=>item.id));assert.equal(sections.length,21);
      const unsafe=[];
      for(const section of sections){
        await page.evaluate(()=>{window.__xss=0;});await navigate(page,section);await delay(30);assert.ok((await page.locator('#contentWrapper').innerText()).trim());
        if(await page.evaluate(()=>window.__xss))unsafe.push({section,nodes:await page.locator('#contentWrapper img[onerror]').evaluateAll(nodes=>nodes.map(node=>node.parentElement.outerHTML))});
      }
      assert.deepEqual(unsafe,[],'Untrusted record markup was interpreted');
    });
    await runCase('Native legal validation and literal untrusted form values',page,async()=>{
      await navigate(page,'clients');await page.evaluate(()=>openClientForm());
      await page.locator('#modalContent .modal-footer .btn-primary').click();
      assert.equal(await page.locator('#f_name').evaluate(e=>e.validity.valueMissing),true);
      await page.locator('#f_name').fill('Cliente isolado');await page.locator('#f_document').fill('00000000000');await page.locator('#f_email').fill('invalid-email');
      await page.locator('#modalContent .modal-footer .btn-primary').click();assert.equal(await page.locator('#f_email').evaluate(e=>e.validity.typeMismatch),true);assert.equal(count('POST','/v1/clients'),0);
      await page.evaluate(clientId=>openClientForm(clientId),id(1));assert.equal(await page.locator('#f_name').inputValue(),xss);assert.equal(await page.locator('#modalContent img').count(),0);
      await page.evaluate(()=>closeModal());await page.evaluate(()=>openFinancialForm());await page.locator('#f_description').fill('Lançamento isolado');await page.locator('#f_date').fill(today);await page.locator('#f_amount').fill('-1');
      await page.locator('#modalContent .modal-footer .btn-primary').click();
      assert.equal(await page.locator('#f_amount').evaluate(e=>e.checkValidity()),false);assert.equal(count('POST','/v1/financial-entries'),0);
      await page.evaluate(()=>closeModal());await page.evaluate(()=>openProcessForm());await page.locator('#f_number').fill('PROCESSO-TESTE');await page.locator('#f_clientId').selectOption(id(1));await page.locator('#f_value').fill('-1');
      await page.locator('#modalContent .modal-footer .btn-primary').click();assert.equal(await page.locator('#f_value').evaluate(e=>e.checkValidity()),false);assert.equal(count('POST','/v1/processes'),0);
      await page.evaluate(()=>closeModal());await page.evaluate(()=>openIntimationForm());await page.locator('#f_content').fill('Conteúdo isolado');await page.locator('#f_receivedAt').fill('');
      await page.locator('#modalContent .modal-footer .btn-primary').click();assert.equal(await page.locator('#f_receivedAt').evaluate(e=>e.validity.valueMissing),true);assert.equal(count('POST','/v1/intimations'),0);
      await page.evaluate(()=>closeModal());await page.evaluate(()=>openDeadlineForm());await page.locator('#f_title').fill('Prazo isolado');await page.locator('#f_date').fill('');
      await page.locator('#modalContent .modal-footer .btn-primary').click();assert.equal(await page.locator('#f_date').evaluate(e=>e.validity.valueMissing),true);assert.equal(count('POST','/v1/deadlines'),0);
    });
    await runCase('Double activation produces one client POST',page,async()=>{
      await page.evaluate(()=>openClientForm());await page.locator('#f_name').fill('Cliente de teste isolado');await page.locator('#f_document').fill('00000000000');await page.locator('#f_email').fill('new@example.test');
      await page.locator('#modalContent .modal-footer .btn-primary').evaluate(button=>{button.click();button.click();});
      await page.waitForFunction(()=>!document.getElementById('modal').classList.contains('active'));
      assert.equal(count('POST','/v1/clients'),1);assert.equal(last('/v1/clients').body.name,'Cliente de teste isolado');
    });
    await runCase('Appointment process selection aligns and locks client',page,async()=>{
      await navigate(page,'agenda');await page.evaluate(()=>openAppointmentForm());await page.locator('#f_clientId').selectOption(id(2));await page.locator('#f_processId').selectOption(id(3));
      assert.equal(await page.locator('#f_clientId').inputValue(),id(1));assert.equal(await page.locator('#f_clientId').isDisabled(),true);
      await page.locator('#f_title').fill('Compromisso isolado');await page.locator('#f_date').fill('2026-10-06');await page.locator('#modalContent .modal-footer .btn-primary').click();
      await page.waitForFunction(()=>!document.getElementById('modal').classList.contains('active'));
      assert.equal(last('/v1/appointments').body.client_id,id(1));assert.equal(last('/v1/appointments').body.process_id,id(3));
    });
    await runCase('Intimation launch optional dates, one POST and refreshed state',page,async()=>{
      await navigate(page,'intimations');await page.evaluate(intimationId=>lancarIntimacaoNoAndamento(intimationId),id(4));
      assert.equal(await page.locator('#launchDeadlineDate').isDisabled(),true);await page.locator('#launchDeadline').check();await page.locator('#launchAppointment').check();
      await page.locator('#modalContent .modal-footer .btn-primary').click();assert.equal(count('POST',`/v1/intimations/${id(4)}/launch`),0);
      await page.locator('#launchDate').fill('2026-09-25');await page.locator('#launchDeadlineDate').fill('2026-10-07');await page.locator('#launchAppointmentDate').fill('2026-10-06');await page.locator('#launchAppointmentTime').fill('10:30');
      const before=count('GET','/v1/frontend/bootstrap');await page.locator('#modalContent .modal-footer .btn-primary').evaluate(button=>{button.click();button.click();});
      await page.waitForFunction(()=>DB.intimations[0].status==='concluida');assert.equal(count('POST',`/v1/intimations/${id(4)}/launch`),1);assert.ok(count('GET','/v1/frontend/bootstrap')>before);
      const body=last(`/v1/intimations/${id(4)}/launch`).body;assert.equal(body.deadline.due_date,'2026-10-07');assert.equal(body.appointment.appointment_time,'10:30');assert.equal(body.movement.description,xss);
    });
    await runCase('Queued public query polls existing job without a second POST',page,async()=>{
      await navigate(page,'queries');await page.locator('#queryInput').fill('00000000000000');await page.locator('#queryPurpose').fill('Verificar cadastro isolado');await page.locator('#queryConsent').check();
      await page.locator('#btnQuery').evaluate(button=>{button.click();button.click();});await waitText(page,'#queryResult','razao_social');
      assert.equal(count('POST','/v1/osint/runs'),1);assert.equal(queryPolls,2);assert.equal(await page.locator('#queryResult img').count(),0);
    });
    await runCase('Sandbox checkout rejects hostile links and honors disabled configuration',page,async()=>{
      await navigate(page,'billing');await page.locator('#billingPlan').waitFor();assert.equal(await page.locator('#billingCheckout a').count(),0);
      await page.locator('#billingCheckout input[type=checkbox]').check();checkoutUrl='https://sandbox.asaas.com.attacker.invalid/test';await page.locator('#billingCheckout button[type=submit]').click();await waitText(page,'[data-checkout-result]','endereço Sandbox válido');assert.equal(await page.locator('[data-checkout-result] a').count(),0);
      checkoutUrl='https://sandbox.asaas.com/checkout/test-only';await page.locator('#billingCheckout button[type=submit]').click();await page.locator('[data-checkout-result] a').waitFor();
      assert.equal(await page.locator('[data-checkout-result] a').getAttribute('href'),checkoutUrl);
      const attempts=requests.filter(r=>r.path==='/v1/billing/checkouts');assert.equal(attempts[0].body.request_id,attempts[1].body.request_id);
      billingEnabled=false;await navigate(page,'billing');await waitText(page,'[data-billing-content]','Aguardando configuração');assert.equal(await page.locator('#billingCheckout form').count(),0);
    });
    await runCase('Ollama input is posted once and result requires human review',page,async()=>{
      await navigate(page,'agentes');await waitText(page,'#agentsAvailability','Ollama configurado');await page.locator('#agentType').selectOption('timeline');await page.locator('#agentInput').fill(xss);await contextFields(page,'agent');await page.locator('#agentRunForm input[type=checkbox]').check();
      await page.locator('#agentRunForm button[type=submit]').evaluate(button=>{button.click();button.click();});await waitText(page,'#agentSubmitStatus','disponível para revisão humana');
      assert.equal(count('POST','/v1/agents/runs'),1);assert.equal(last('/v1/agents/runs').method,'GET');const sent=requests.find(r=>r.path==='/v1/agents/runs'&&r.method==='POST');assert.equal(sent.body.input_safe.text,xss);assert.equal(sent.body.investigation_id,id(5));assert.equal(await page.locator('#agentRuns img').count(),0);await waitText(page,'#agentRuns','Aguardando revisão humana');
      agentEnabled=false;await navigate(page,'agentes');await waitText(page,'#agentsAvailability','aguarda configuração');assert.equal(await page.locator('#agentRunForm button[type=submit]').isDisabled(),true);
    });
    await runCase('Evidence upload uses multipart and custody events stay literal',page,async()=>{
      await navigate(page,'metadata');await page.locator('#evidenceOriginal').setInputFiles({name:'teste-isolado.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 isolated fixture')});await contextFields(page,'evidence');await page.locator('#evidenceUploadForm button[type=submit]').click();await waitText(page,'#evidenceUploadStatus','Arquivo recebido');
      const upload=last('/v1/evidences/uploads');assert.match(upload.headers['content-type'],/^multipart\/form-data; boundary=/);assert.match(upload.body,/name="file"; filename="teste-isolado.pdf"/);assert.match(upload.body,/name="purpose"/);assert.match(upload.body,/name="investigation_id"/);
      await page.locator('[data-evidence-action=events]').click();await waitText(page,'#evidenceActionStatus','Histórico consultado');assert.equal(await page.locator('[data-evidence-detail] img').count(),0);assert.ok((await page.locator('[data-evidence-detail]').innerText()).includes('uploaded'));
    });
    await runCase('Report approval and download failures are visible and retryable',page,async()=>{
      await navigate(page,'reports');await page.locator('[data-report-action=approve]').waitFor();await page.locator('[data-report-action=approve]').click();await waitText(page,'#reportsStatus','Confirmação de segurança recente');assert.equal(await page.locator('[data-report-action=approve]').isDisabled(),false);
      await page.locator('[data-report-action=download]').click();await waitText(page,'#reportsStatus','Cofre indisponível');reportError=false;await page.locator('[data-report-action=download]').click();await waitText(page,'#reportsStatus','Endereço de download inválido');assert.equal(await page.locator('#reportsStatus a').count(),0);
    });
    await runCase('New forms expose accessible names (axe WCAG A/AA)',page,async()=>{
      await page.addScriptTag({content:dependency('axe-core').source});
      for(const section of ['agentes','metadata','transparencia','billing']){
        await navigate(page,section);await delay(60);
        const violations=await page.evaluate(async()=>{const result=await axe.run('#contentWrapper',{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']},rules:{'color-contrast':{enabled:false}}});return result.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}));});
        assert.deepEqual(violations,[],section);
      }
    });
    assert.deepEqual(errors,[],'Browser runtime errors');assert.deepEqual(unexpected,[],'Unmocked API routes');
    const stored=await page.evaluate(()=>Object.keys(localStorage).filter(key=>!['semperfi_settings_v1','semperfi_accessibility_v1'].includes(key)));assert.deepEqual(stored,[],'Operational records leaked to browser storage');
    console.log(JSON.stringify({passed:results.filter(r=>r.passed).length,total:results.length,results,errors,unexpected,apiRequests:requests.length},null,2));
    if(results.some(result=>!result.passed))process.exitCode=1;
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
