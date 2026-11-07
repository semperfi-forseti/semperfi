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
let activeCase = 'startup', billingEnabled = true, checkoutUrl = 'https://sandbox.asaas.com/checkoutSession/show?id=test-only';
let agentCreated = false, agentEnabled = true, uploaded = false, reportError = true, queryPolls = 0;
let radarCreated = false, evidenceFinalizeFails = false, evidencePreserved = false;
let alertsUnavailable = false;
let bootstrapUnavailable = false, bootstrapDelay = 0;
let toolOutcome='failed', toolHistoryUnavailable=false;
const toolRuns=[];
const reportDraftCommands=new Map();
let reportDraftAmbiguous=true;
const corporateFixture = {cnpj:'00000000000000',razao_social:xss,descricao_situacao_cadastral:'ATIVA',qsa:[{nome_socio:xss,cnpj_cpf_do_socio:'00000000000',qualificacao_socio:'Sócio'}]};
const state = {
  clients: [{id:id(1),name:xss,type:'PF',document:'123.456.789-01',email:'fixture@example.test',phone:'',address:'',notes:xss,responsible:'',status:'ativo',createdAt:Date.now()},
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
let documentLinks=[], engineRuns=[], invitations=[];
let teamMember={id:id(30),display_name:xss,email:'member@example.test',role:'lawyer',role_label:'Advogado',is_active:true,account_active:true,is_self:false};
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
  if (pathname === '/v1/frontend/bootstrap') {if(bootstrapDelay)await delay(bootstrapDelay);return bootstrapUnavailable?reply({detail:'Isolated failure'},503):reply({data:state,me:{display_name:'Operador isolado',email:'fixture@example.test',roles:['administrator']}});}
  // Dashboard projections are a separate server contract; the browser must not derive them from bootstrap.
  const alerts={total:1,offset:0,limit:20,items:[{id:id(20),kind:'deadline',title:xss,description:xss,date:today,severity:'danger',section:'deadlines'}]};
  if (pathname === '/v1/dashboard/alerts') return alertsUnavailable?reply({detail:'Isolated failure'},503):reply(alerts);
  if (pathname === '/v1/dashboard/day') return reply({date:url.searchParams.get('date'),total:0,offset:0,limit:20,items:[]});
  const dashboardMonth=url.searchParams.get('month')||today.slice(0,7);
  if (pathname === '/v1/dashboard') return reply({
    today,month:dashboardMonth,timezone:'America/Sao_Paulo',generated_at:new Date().toISOString(),
    counts:{active_processes:1,critical_deadlines:1,overdue_deadlines:0,appointments_today:0,completed_appointments_today:0,pending_intimations:1,triage_intimations:1,stored_files:0,pending_files:0,total_audit_events:501},
    financial:{forecast_revenue:'0.00',overdue_receivables:'10.00',overdue_receivables_count:1,overdue_payables:'0.00',overdue_payables_count:0,received_month:'0.00',paid_month:'0.00',net_month:'0.00',period_start:dashboardMonth+'-01',period_end:new Date(Date.UTC(Number(dashboardMonth.slice(0,4)),Number(dashboardMonth.slice(5)),0)).toISOString().slice(0,10),basis:'entry_date'},
    upcoming_deadlines:{total:1,items:[{id:id(20),title:xss,date:today,process_number:null,days_remaining:0}]},urgent_actions:alerts,calendar:{days:dashboardMonth===today.slice(0,7)?[{date:today,appointments:0,deadlines:1}]:[]}
  });
  if (pathname === '/v1/organization/mine') return reply({items:[{tenant_id:id(31),name:'Escritório isolado',role:'administrator',role_label:'Administrador',current:true}],can_manage:true});
  if (pathname === '/v1/organization/members') return reply({items:[teamMember],total:1,offset:0,limit:100});
  if (pathname === `/v1/organization/members/${id(30)}` && method==='PATCH') {teamMember={...teamMember,...body};return reply(teamMember);}
  if (pathname === '/v1/organization/invitations' && method==='GET') return reply({items:invitations});
  if (pathname === '/v1/organization/invitations' && method==='POST') {const invitation={id:id(32),email:body.email,role:body.role,role_label:'Advogado',status:'pending',expires_at:'2026-10-07T12:00:00Z'};invitations=[invitation];return reply({token:'a'.repeat(43),invitation,delivery:'manual'},201);}
  if (pathname === `/v1/organization/invitations/${id(32)}` && method==='DELETE') {invitations[0].status='revoked';return route.fulfill({status:204});}
  if (/^\/v1\/(clients|processes)\/[^/]+\/documents(?:\/[^/]+)?$/.test(pathname)) {
    if(method==='GET')return reply(documentLinks);
    if(method==='POST'){documentLinks=[{id:id(33),evidence_id:id(7),filename:xss,label:body.label,validation_status:'pending'}];return reply(documentLinks[0]);}
    if(method==='DELETE'){documentLinks=[];return route.fulfill({status:204});}
  }
  if (pathname==='/v1/investigation-engines/runs') return reply(engineRuns);
  if (/^\/v1\/investigation-engines\/(tacer|siera)\/run$/.test(pathname)) {
    await delay(80);const saved={id:id(34),run_id:id(34),engine:'tacer',created_at:'2026-09-30T12:00:00Z',review_status:'pending',input_safe:body,result:{stages:[{code:'T',objective:xss}]}};engineRuns=[saved];return reply(saved);
  }
  if (pathname===`/v1/investigation-engines/runs/${id(34)}`)return reply(engineRuns[0]);
  if (pathname===`/v1/investigation-engines/runs/${id(34)}/review`) {engineRuns[0]={...engineRuns[0],review_status:body.decision,review_notes:body.notes,reviewed_at:'2026-09-30T12:01:00Z'};return reply(engineRuns[0]);}
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
  if (pathname === '/v1/osint/runs' && method === 'POST') {
    if(body.connector_id==='osint_tools'){
      const saved={id:id(100+toolRuns.length),connector_id:'osint_tools',status:toolOutcome,tool:body.payload.tool,target:body.payload.value,
        investigation_id:body.investigation_id,purpose:body.purpose,legal_basis:body.legal_basis,authorization_reference:body.authorization_reference,
        created_at:'2026-10-03T12:00:00Z',error_code:toolOutcome==='failed'?'ConnectorHTTPError':null,
        raw_snapshot:toolOutcome==='failed'?null:{tool:body.payload.tool,target:body.payload.value,data:{A:[],TXT:[xss]},partial:true,limitations:['MX indisponível no teste']}};
      toolRuns.unshift(saved);return reply({run_id:saved.id,status:'queued'},202);
    }
    if(body.investigation_id){radarCreated=true;return reply({run_id:'radar-fixture',status:'queued'},202);}
    queryPolls=0;return reply({run_id:'query-fixture',job_id:'job-fixture',status:'queued'},202);
  }
  if(pathname==='/v1/osint/runs'&&method==='GET'&&url.searchParams.get('connector_id')==='osint_tools'){
    if(toolHistoryUnavailable)return reply({detail:'Histórico indisponível no teste'},503);
    const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||20);
    return reply(toolRuns.slice(offset,offset+limit).map(({raw_snapshot,...row})=>row));
  }
  if(method==='GET'&&pathname.startsWith('/v1/osint/runs/')){
    const saved=toolRuns.find(row=>pathname===`/v1/osint/runs/${row.id}`);if(saved)return reply(saved);
  }
  if (pathname === '/v1/osint/runs' && method === 'GET' && url.searchParams.get('kind')==='cnpj') return reply(radarCreated?[{id:'radar-fixture',connector_id:'brasilapi',status:'completed',purpose:xss,normalized_result:{razao_social:xss},created_at:'2026-09-29T12:00:00Z'}]:[]);
  if (pathname === '/v1/osint/runs/radar-fixture') return reply({id:'radar-fixture',status:'completed',raw_snapshot:corporateFixture});
  if (pathname === '/v1/osint/runs/query-fixture') return reply(++queryPolls===1 ? {run_id:'query-fixture',status:'running'} : {run_id:'query-fixture',status:'completed',raw_snapshot:{razao_social:xss}});
  if (pathname === '/v1/billing/status') return reply({enabled:billingEnabled,can_checkout:billingEnabled,can_manage:true,environment:'sandbox',sandbox_only:true,checkouts:[{plan_key:'lite',status:'PENDING',checkout_url:'https://attacker.invalid/test'}]});
  if (pathname === '/v1/billing/catalog') return reply({environment:'sandbox',sandbox_only:true,plans:[{key:'lite',name:'Lite',price:89.90}]});
  if (pathname === '/v1/billing/checkouts') {await delay(80);return reply({id:id(15),environment:'sandbox',sandbox_only:true,status:'open',checkout_url:checkoutUrl},201);}
  if (pathname === '/v1/agents/status') return reply({enabled:agentEnabled,provider:'ollama',model:'local-test'});
  if (pathname === '/v1/agents/runs' && method === 'POST') {await delay(80);agentCreated=true;return reply({agent_run_id:id(6),status:'queued'},202);}
  if (pathname === '/v1/agents/runs') return reply(agentCreated?[agent()]:[]);
  if (pathname === `/v1/agents/runs/${id(6)}`) return reply(agent());
  if (pathname === '/v1/evidences') return reply(uploaded?[evidence()]:[]);
  if (pathname === '/v1/evidences/uploads') {uploaded=true;return reply({evidence_id:id(7),status:'pending'},201);}
  if (pathname === `/v1/evidences/${id(7)}/events`) return reply([{event_type:'uploaded',details:xss}]);
  if (pathname === `/v1/evidences/${id(7)}/finalize`) {if(evidenceFinalizeFails)return reply({detail:'Cofre indisponível para teste.'},503);evidencePreserved=true;return reply({id:id(7),status:'preserved'});}
  if(pathname===`/v1/investigations/${id(5)}/report-draft`&&method==='POST'){
    await delay(80);
    if(!reportDraftCommands.has(body.request_id)){
      const saved={id:id(120),title:'Relatório da investigação isolada',version:1,status:'DRAFT',content_hash:'b'.repeat(64),body:{object_objective:'Conteúdo persistido da investigação',findings:[{title:xss}]}};
      reports.push(saved);reportDraftCommands.set(body.request_id,saved);
    }
    const saved=reportDraftCommands.get(body.request_id);
    return reportDraftAmbiguous?reply({detail:'Resposta perdida após salvar'},503):reply({report_id:saved.id,status:saved.status,content_hash:saved.content_hash},201);
  }
  if (pathname === '/v1/reports') return reply(reports);
  if (pathname === `/v1/reports/${id(8)}/approve`) return reportError ? reply({detail:{policy_code:'MFA_REAUTH_REQUIRED',reason:'Confirme seu acesso novamente necessária.'}},403) : reply({status:'FINAL'});
  if (pathname === `/v1/reports/${id(9)}/download`) return reportError ? reply({detail:'Cofre indisponível para teste.'},503) : reply({url:'javascript:window.__xss=1',expires_in_seconds:60});
  if (['/v1/audit-events','/v1/osint/runs','/v1/catalog/connectors','/v1/connectors'].includes(pathname)) return reply([]);
  unexpected.push(`${method} ${pathname}`);return reply({detail:'Unmocked test route'},501);
}
const count = (method, pathname) => requests.filter(r=>r.method===method&&r.path===pathname).length;
const last = pathname => requests.filter(r=>r.path===pathname).at(-1);
async function waitText(page, selector, text) {
  try { await page.waitForFunction(({selector,text})=>document.querySelector(selector)?.textContent.includes(text),{selector,text}); }
  catch (_) { throw Error(`${selector}: expected ${text}; received ${await page.locator(selector).textContent()}`); }
}
async function navigate(page, section) {await page.evaluate(section=>navigateSection(section),section);await page.locator('#contentWrapper > :first-child').waitFor();if(section==='dashboard')await page.getByText('Dados consultados com sucesso.',{exact:true}).waitFor();}
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
      alertsUnavailable=true;await page.evaluate(()=>renderNotifications());
      assert.equal(await page.locator('#notifBadge').textContent(),'?');
      assert.match(await page.locator('#notifList [role=alert]').textContent(),/Não foi possível/);
      alertsUnavailable=false;await page.evaluate(()=>renderNotifications());
      assert.equal(await page.locator('#notifBadge').textContent(),'1');
    });
    await runCase('Global search protects records and query, masks documents, and supports keyboard',page,async()=>{
      await page.evaluate(query=>{SETTINGS.masked=true;runGlobalSearch(query);},'<img');
      assert.equal(await page.locator('#modalContent img').count(),0);
      assert.ok((await page.locator('#modalContent').innerText()).includes('<img'));
      assert.ok(!(await page.locator('#modalContent').innerText()).includes('00000000000'));
      assert.ok((await page.locator('#modalContent').innerText()).includes('***.***.***-01'));
      const result=page.locator('#modalContent .modal-body button').first();
      await result.focus();await page.keyboard.press('Enter');
      await page.waitForFunction(()=>appState.currentSection==='clients'&&!document.getElementById('modal').classList.contains('active'));
    });
    await runCase('Dashboard detail navigation refreshes records and handles failure and later navigation',page,async()=>{
      await navigate(page,'dashboard');await page.evaluate(()=>{DB.deadlines=[];});
      await page.locator('[data-metric=critical_deadlines]').focus();await page.keyboard.press('Enter');
      await page.waitForFunction(()=>appState.currentSection==='deadlines');
      assert.ok((await page.evaluate(()=>DB.deadlines)).some(row=>row.id===id(20)));
      await navigate(page,'dashboard');bootstrapUnavailable=true;
      await page.evaluate(()=>openDashboardRecords('deadlines'));
      assert.equal(await page.evaluate(()=>appState.currentSection),'dashboard');
      assert.match(await page.locator('#dashboardStatus[role=alert]').textContent(),/lista atualizada/);
      bootstrapUnavailable=false;bootstrapDelay=150;
      await page.evaluate(()=>{window.navigationCheck=openDashboardRecords('deadlines');navigateSection('clients');});
      await page.evaluate(()=>window.navigationCheck);bootstrapDelay=0;
      assert.equal(await page.evaluate(()=>appState.currentSection),'clients');
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
    await runCase('Investigation history reads persisted events and local operations cannot fabricate audit',page,async()=>{
      const unchanged=await page.evaluate(async()=>{
        const before=JSON.stringify(DB.audit);
        audit('osint','fabricated','local-only');await osintAudit('fabricated','local-only');
        return before===JSON.stringify(DB.audit);
      });
      assert.equal(unchanged,true);
      state.audit=[
        {id:id(90),module:'osint',timestamp:'2026-10-02T10:00:00Z',actor:'Operador do teste',action:xss,osintMeta:{investigationId:id(5)}},
        {id:id(91),module:'osint',timestamp:'2026-10-01T10:00:00Z',actor:'Operador do teste',action:'Atividade anterior do banco',osintMeta:{investigationId:id(5)}},
      ];
      await page.evaluate(id=>{DB.audit=[];openInvestigationWorkspace(id);switchOsintTab('timeline');},id(5));
      await page.locator('[data-timeline-refresh]').waitFor();
      const rows=page.locator('#investigationTimeline .timeline-content');
      assert.equal(await rows.count(),2);assert.equal(await rows.first().textContent(),'Atividade anterior do banco');
      assert.ok((await rows.last().textContent()).includes('<img'));assert.equal(await page.locator('#investigationTimeline img').count(),0);
      bootstrapUnavailable=true;await page.locator('[data-timeline-refresh]').click();await page.locator('#investigationTimeline [role=alert]').waitFor();
      assert.equal(await rows.count(),0);
      bootstrapUnavailable=false;await page.locator('[data-timeline-refresh]').click();await page.locator('#investigationTimeline .timeline-content').first().waitFor();
      assert.equal(await rows.count(),2);
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
    await runCase('Client and process details open without incomplete editing controls',page,async()=>{
      await page.evaluate(clientId=>showClientDetail(clientId),id(1));
      await page.locator('#modal.active').waitFor();
      assert.equal(await page.locator('#modal textarea').count(),0);
      assert.equal(await page.locator('#modal button').filter({hasText:/Salvar biografia|Arquivar documento|Vincular empresa/}).count(),0);
      await page.evaluate(()=>switchClientTab('links'));
      assert.ok(await page.locator('#modal a').count()>0);
      await page.evaluate(()=>closeModal());
      await page.evaluate(processId=>showProcessDetail(processId),id(3));
      await page.locator('#modal.active').waitFor();
      assert.ok((await page.locator('#modal').innerText()).includes('0000000-00.2026.8.00.0000'));
    });
    await runCase('OSINT result opens a supervised AI draft without executing it',page,async()=>{
      const before=count('POST','/v1/agents/runs');
      await page.evaluate(()=>{osintToolsState.lastResult={ok:true,data:{summary:'Resultado isolado para revisão'}};analyzeWithAI();});
      assert.equal(await page.locator('#agentType').inputValue(),'correlation');
      assert.ok((await page.locator('#agentInput').inputValue()).includes('Resultado isolado para revisão'));
      assert.equal(count('POST','/v1/agents/runs'),before);
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
      await page.locator('#btnQuery').evaluate(button=>{button.click();button.click();});await waitText(page,'#queryResult','Razão social');
      assert.equal(count('POST','/v1/osint/runs'),1);assert.equal(queryPolls,2);assert.equal(await page.locator('#queryResult img').count(),0);
    });
    await runCase('Radar saves a query through the API and reopens history after reload without POST',page,async()=>{
      await navigate(page,'societario');const before=count('POST','/v1/osint/runs');
      await page.locator('#radarCnpj').fill('abcdefghijklmn');
      assert.equal(await page.locator('#radarCnpj').evaluate(input=>input.checkValidity()),false);
      await page.locator('#radarCnpj').fill('00000000000000');await contextFields(page,'radar');
      await page.locator('#radarForm button[type=submit]').evaluate(button=>{button.click();button.click();});
      await waitText(page,'#radarStatus','Consulta concluída e registrada');
      assert.equal(count('POST','/v1/osint/runs'),before+1);
      const submitted=requests.filter(r=>r.path==='/v1/osint/runs'&&r.method==='POST').at(-1);
      assert.equal(submitted.body.investigation_id,id(5));assert.equal(submitted.body.payload.kind,'cnpj');
      assert.equal(await page.locator('#radarResult img').count(),0);
      assert.equal(await page.locator('#radarResult svg').getAttribute('viewBox'),'0 0 720 380');
      assert.ok(!(await page.locator('#radarResult').innerText()).includes('00000000000000'));
      await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();await navigate(page,'societario');
      await page.locator('[data-radar-run]').click();await waitText(page,'#radarStatus','Consulta concluída e registrada');
      assert.equal(count('POST','/v1/osint/runs'),before+1);assert.equal(await page.locator('#radarHistory img').count(),0);
    });
    await runCase('OSINT requires purpose and authorization before submitting; server failure keeps entered values',page,async()=>{
      await navigate(page,'osinttools');await page.evaluate(()=>selectOsintTool('dns'));
      const before=count('POST','/v1/osint/runs');
      await page.locator('#otTarget').fill('example.com');await page.locator('#otConsent').check();await page.evaluate(()=>runOsintTool());
      assert.equal(count('POST','/v1/osint/runs'),before);
      await contextFields(page,'ot');await page.evaluate(()=>runOsintTool());
      await waitText(page,'#otResult','Consulte o histórico');
      assert.equal(await page.locator('#otTarget').inputValue(),'example.com');assert.equal(await page.locator('#otResult .alert-success').count(),0);
      assert.equal(count('POST','/v1/osint/runs'),before+1);
      assert.equal(await page.locator('#otPurpose').inputValue(),'Teste isolado de integração da interface');
      assert.equal(await page.locator('#otReference').inputValue(),'TESTE-ISOLADO');
      await waitText(page,'#otHistory','Falhou');
    });
    await runCase('OSINT stores authorized context, labels partial results and reopens history after reload without POST',page,async()=>{
      toolOutcome='completed';const before=count('POST','/v1/osint/runs');
      await page.locator('button[onclick="runOsintTool()"]').evaluate(button=>{button.click();button.click();});
      await waitText(page,'#otResult','Consulta parcial');
      assert.equal(count('POST','/v1/osint/runs'),before+1);
      const body=requests.filter(row=>row.method==='POST'&&row.path==='/v1/osint/runs').at(-1).body;
      assert.equal(body.connector_id,'osint_tools');assert.equal(body.payload.tool,'dns');assert.equal(body.payload.authorized,true);
      assert.equal(body.investigation_id,id(5));assert.deepEqual(body.scope_codes,['digital_defensive']);
      await waitText(page,'#otRawWrap','MX indisponível no teste');assert.equal(await page.locator('#otRawWrap img').count(),0);
      const savedId=await page.evaluate(()=>osintToolsState.lastResult.runId);
      await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();await navigate(page,'osinttools');
      assert.equal(await page.evaluate(()=>osintToolsState.lastResult),null);
      await page.locator(`[data-tool-run="${savedId}"]`).focus();await page.keyboard.press('Enter');
      await waitText(page,'#otResult','Consulta parcial');
      assert.equal(await page.evaluate(()=>osintToolsState.lastResult.runId),savedId);
      assert.equal(count('POST','/v1/osint/runs'),before+1);assert.equal(await page.locator('#otHistory img').count(),0);
    });
    await runCase('OSINT history failure is explicit and retry reads the server without a new query',page,async()=>{
      const before=count('POST','/v1/osint/runs');toolHistoryUnavailable=true;
      await page.evaluate(()=>loadOsintToolHistory());await page.locator('#otHistory [role=alert]').waitFor();
      assert.equal(await page.locator('#otHistory [data-tool-run]').count(),0);
      assert.doesNotMatch(await page.locator('#otHistory').textContent(),/Nenhuma consulta/);
      toolHistoryUnavailable=false;await page.locator('#otHistory button').click();await page.locator('#otHistory [data-tool-run]').first().waitFor();
      assert.equal(await page.locator('#otHistory [data-tool-run]').count(),2);assert.equal(count('POST','/v1/osint/runs'),before);
    });
    await runCase('Investigative draft retries its saved command and reloads reports from server records',page,async()=>{
      const endpoint=`/v1/investigations/${id(5)}/report-draft`,before=count('POST',endpoint);
      await page.evaluate(async id=>{DB.findings=[{title:'FORGED LOCAL FINDING'}];await Promise.all([generateOsintReport(id,true),generateOsintReport(id,true)]);},id(5));
      assert.equal(count('POST',endpoint),before+1);assert.equal(reportDraftCommands.size,1);
      assert.equal(await page.evaluate(()=>appState.currentSection),'osinttools');
      const command=last(endpoint).body;assert.deepEqual(Object.keys(command),['request_id']);
      reportDraftAmbiguous=false;await page.evaluate(id=>generateOsintReport(id,true),id(5));
      assert.equal(count('POST',endpoint),before+2);assert.equal(last(endpoint).body.request_id,command.request_id);
      assert.equal(reportDraftCommands.size,1);await page.waitForFunction(()=>appState.currentSection==='reports');
      await waitText(page,'#contentWrapper','Relatório da investigação isolada');
      assert.ok(!(await page.locator('#contentWrapper').textContent()).includes('FORGED LOCAL FINDING'));
      assert.equal(await page.locator('#contentWrapper img').count(),0);
      await page.reload();await page.locator('body:not(.auth-pending) .page-title').waitFor();await navigate(page,'reports');
      await waitText(page,'#contentWrapper','Relatório da investigação isolada');assert.equal(reportDraftCommands.size,1);
      await navigate(page,'osinttools');
    });
    await runCase('Evidence finalization can retry its receipt without another upload',page,async()=>{
      const savedId=toolRuns.find(row=>row.status==='completed').id;
      await page.evaluate(id=>openOsintToolRun(id),savedId);
      await waitText(page,'#otResult','Consulta parcial');
      await page.evaluate(()=>{osintToolsState.lastResult.data.data.TXT=['FORGED BROWSER VALUE'];});
      const before=count('POST','/v1/evidences/uploads');evidenceFinalizeFails=true;
      await page.locator('button[onclick="preserveOsintResult()"]').evaluate(button=>{button.click();button.click();});
      await waitText(page,'#otResult','Retomar preservação');assert.equal(count('POST','/v1/evidences/uploads'),before+1);
      const payload=last('/v1/evidences/uploads').body;assert.ok(payload.includes('MX indisponível no teste'));assert.ok(!payload.includes('FORGED BROWSER VALUE'));
      assert.equal(await page.evaluate(()=>osintToolsState.lastResult.preserved),false);
      evidenceFinalizeFails=false;await page.locator('button[onclick="preserveOsintResult()"]').click();await waitText(page,'#otResult','Evidência preservada');
      assert.equal(count('POST','/v1/evidences/uploads'),before+1);assert.equal(evidencePreserved,true);
      assert.equal(await page.locator('button[onclick="preserveOsintResult()"]').isDisabled(),true);
    });
    await runCase('Sandbox checkout rejects hostile links and honors disabled configuration',page,async()=>{
      await navigate(page,'billing');await page.locator('#billingPlan').waitFor();assert.equal(await page.locator('#billingCheckout a').count(),0);
      await page.locator('#billingCheckout input[type=checkbox]').check();checkoutUrl='https://sandbox.asaas.com.attacker.invalid/test';await page.locator('#billingCheckout button[type=submit]').click();await waitText(page,'[data-checkout-result]','Atualize a situação antes de tentar novamente');assert.equal(await page.locator('[data-checkout-result] a').count(),0);
      checkoutUrl='https://sandbox.asaas.com/checkoutSession/show?id=test-only';await page.locator('#billingCheckout button[type=submit]').click();await page.locator('[data-checkout-result] a').waitFor();
      assert.equal(await page.locator('[data-checkout-result] a').getAttribute('href'),checkoutUrl);
      const attempts=requests.filter(r=>r.path==='/v1/billing/checkouts');assert.equal(attempts[0].body.request_id,attempts[1].body.request_id);
      billingEnabled=false;await navigate(page,'billing');await waitText(page,'[data-billing-content]','ainda não estão disponíveis');assert.equal(await page.locator('#billingCheckout form').count(),0);
    });
    await runCase('Ollama input is posted once and result requires human review',page,async()=>{
      await navigate(page,'agentes');await waitText(page,'#agentsAvailability','A assistência está configurada');await page.locator('#agentType').selectOption('timeline');await page.locator('#agentInput').fill(xss);await contextFields(page,'agent');await page.locator('#agentRunForm input[type=checkbox]').check();
      await page.locator('#agentRunForm button[type=submit]').evaluate(button=>{button.click();button.click();});await waitText(page,'#agentSubmitStatus','disponível para revisão humana');
      assert.equal(count('POST','/v1/agents/runs'),1);assert.equal(last('/v1/agents/runs').method,'GET');const sent=requests.find(r=>r.path==='/v1/agents/runs'&&r.method==='POST');assert.equal(sent.body.input_safe.text,xss);assert.equal(sent.body.investigation_id,id(5));assert.equal(await page.locator('#agentRuns img').count(),0);await waitText(page,'#agentRuns','Aguardando revisão humana');
      agentEnabled=false;await navigate(page,'agentes');await waitText(page,'#agentsAvailability','aguarda habilitação');assert.equal(await page.locator('#agentRunForm button[type=submit]').isDisabled(),true);
    });
    await runCase('Evidence upload uses multipart and custody events stay literal',page,async()=>{
      await navigate(page,'metadata');await page.locator('#evidenceOriginal').setInputFiles({name:'teste-isolado.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 isolated fixture')});await contextFields(page,'evidence');await page.locator('#evidenceUploadForm button[type=submit]').click();await waitText(page,'#evidenceUploadStatus','Arquivo recebido');
      const upload=last('/v1/evidences/uploads');assert.match(upload.headers['content-type'],/^multipart\/form-data; boundary=/);assert.match(upload.body,/name="file"; filename="teste-isolado.pdf"/);assert.match(upload.body,/name="purpose"/);assert.match(upload.body,/name="investigation_id"/);
      await page.locator('[data-evidence-action=events]').click();await waitText(page,'#evidenceActionStatus','Histórico consultado');assert.equal(await page.locator('[data-evidence-detail] img').count(),0);assert.ok((await page.locator('[data-evidence-detail]').innerText()).includes('Arquivo recebido'));
    });
    await runCase('Report approval and download failures are visible and retryable',page,async()=>{
      await navigate(page,'reports');await page.locator('[data-report-action=approve]').waitFor();await page.locator('[data-report-action=approve]').click();await waitText(page,'#reportsStatus','Confirme seu acesso novamente');assert.equal(await page.locator('[data-report-action=approve]').isDisabled(),false);
      await page.locator('[data-report-action=download]').click();await waitText(page,'#reportsStatus','Cofre indisponível');reportError=false;await page.locator('[data-report-action=download]').click();await waitText(page,'#reportsStatus','Endereço de download inválido');assert.equal(await page.locator('#reportsStatus a').count(),0);
    });
    await runCase('Document links persist across reopening and detach without deleting the original',page,async()=>{
      await page.evaluate(clientId=>{showClientDetail360(clientId);switchClientTab('documentos');},id(1));
      await page.locator('#legalDocumentSelect').selectOption(id(7));await page.locator('#legalDocumentLabel').fill('Mandato '+xss);
      await page.locator('[data-link-form] button[type=submit]').click();await waitText(page,'#legalDocumentsPanel','Vínculo salvo');
      assert.equal(await page.locator('#legalDocumentsPanel img').count(),0);
      assert.equal(await page.locator('[data-download]').count(),0,'Pending evidence cannot download');
      await page.evaluate(()=>{switchClientTab('visao');switchClientTab('documentos');});await page.locator('[data-unlink]').waitFor();
      await page.locator('[data-unlink]').click();await waitText(page,'#legalDocumentsPanel','Vínculo removido');
      assert.equal(count('DELETE',`/v1/evidences/${id(7)}`),0);assert.equal(uploaded,true);
    });
    await runCase('Team controls change a membership and create or revoke a manual invitation',page,async()=>{
      await navigate(page,'settings');await page.locator('#organizationInviteEmail').waitFor();
      assert.equal(await page.locator('#organizationPanel img').count(),0);
      await page.locator('[data-member-toggle]').click();await waitText(page,'#organizationStatus','Acesso suspenso');
      await page.locator('[data-member-toggle]').click();await waitText(page,'#organizationStatus','Acesso reativado');
      await page.locator('#organizationInviteEmail').fill('recipient@example.test');await page.locator('#organizationInviteForm button[type=submit]').click();
      await page.locator('[data-revoke-invitation]').waitFor();assert.equal(invitations.length,1);
      assert.ok((await page.locator('#organizationShare').textContent()).includes('Convite criado'));
      assert.equal(await page.evaluate(()=>Object.values(localStorage).some(value=>value.includes('a'.repeat(43)))),false);
      await page.locator('[data-revoke-invitation]').click();await waitText(page,'#organizationInvitations','Revogado');
    });
    await runCase('Investigation plans save once, reopen from history and record human review',page,async()=>{
      await page.evaluate(invId=>{const inv=DB.investigations.find(row=>row.id===invId);inv.status='em_coleta';inv.scope=['empresarial'];openInvestigationWorkspace(invId);switchOsintTab('motores');},id(5));
      await page.locator('#investigationEngines summary').click();
      assert.equal(await page.locator('#engineInvestigation').inputValue(),id(5),'Planning defaults to the open investigation');
      await page.locator('#engineTarget').fill(xss);await page.locator('#enginePurpose').fill('Planejamento autorizado para teste isolado');
      await page.locator('#engineBasis').selectOption('legitimo_interesse');await page.locator('#engineReference').fill('REF-TESTE');
      await page.locator('[name=declared_scope]').first().check();await page.locator('[name=acknowledge]').check();
      await page.locator('[data-engine-form] button[type=submit]').evaluate(button=>{button.click();button.click();});
      await page.locator('[data-engine-review]').waitFor();assert.equal(count('POST','/v1/investigation-engines/tacer/run'),1);
      assert.equal(last('/v1/investigation-engines/tacer/run').body.investigation_id,id(5));
      assert.equal(await page.locator('#investigationEngines img').count(),0);
      await page.locator('#engineReviewNotes').fill('Planejamento revisado por responsável do teste');await page.locator('[data-engine-review] button').click();
      await waitText(page,'[data-engine-detail]','Revisão humana registrada');
      await page.evaluate(()=>{switchOsintTab('overview');switchOsintTab('motores');});await page.locator('[data-engine-open]').click();
      await waitText(page,'[data-engine-detail]','Planejamento revisado por responsável do teste');
      assert.equal(await page.locator('[data-engine-review]').count(),0);
    });
    await runCase('New forms expose accessible names (axe WCAG A/AA)',page,async()=>{
      await page.addScriptTag({content:dependency('axe-core').source});
      for(const section of ['agentes','metadata','transparencia','billing','societario','settings']){
        await navigate(page,section);await delay(60);
        const violations=await page.evaluate(async()=>{const result=await axe.run('#contentWrapper',{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']},rules:{'color-contrast':{enabled:false}}});return result.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}));});
        assert.deepEqual(violations,[],section);
      }
    });
    await runCase('Ordinary profiles do not see administrative diagnostics',page,async()=>{
      await page.evaluate(()=>{SETTINGS.userProfile='lawyer';});
      for(const section of ['agentes','metadata','reports','audit']){
        await navigate(page,section);await delay(80);
        assert.equal(await page.locator('#contentWrapper summary').filter({hasText:'Diagnóstico administrativo'}).count(),0,section);
        const text=await page.locator('#contentWrapper').innerText();
        assert.ok(!text.includes('local-test'),section+' exposed model name');
        assert.ok(!text.includes(id(6)),section+' exposed run ID');
      }
      await page.evaluate(()=>{SETTINGS.userProfile='administrator';});
    });
    await runCase('Mobile large-text controls remain reachable',page,async()=>{
      await page.setViewportSize({width:320,height:740});
      await page.evaluate(()=>SemperfiAccessibility.setPreferences({theme:'light',textSize:200,spacing:true}));
      for(const section of ['agentes','metadata','reports','billing','calculators','settings','societario']){
        await navigate(page,section);await delay(80);
        const width=await page.evaluate(()=>({content:document.documentElement.scrollWidth,viewport:window.innerWidth}));
        assert.ok(width.content<=width.viewport+1,`${section} horizontal overflow: ${JSON.stringify(width)}`);
      }
      await page.evaluate(()=>SemperfiAccessibility.setPreferences({theme:'system',textSize:100,spacing:false}));
      await page.setViewportSize({width:1440,height:1000});
    });
    assert.deepEqual(errors,[],'Browser runtime errors');assert.deepEqual(unexpected,[],'Unmocked API routes');
    const stored=await page.evaluate(()=>Object.keys(localStorage).filter(key=>!['semperfi_settings_v1','semperfi_accessibility_v1'].includes(key)));assert.deepEqual(stored,[],'Operational records leaked to browser storage');
    console.log(JSON.stringify({passed:results.filter(r=>r.passed).length,total:results.length,results,errors,unexpected,apiRequests:requests.length},null,2));
    if(results.some(result=>!result.passed))process.exitCode=1;
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
