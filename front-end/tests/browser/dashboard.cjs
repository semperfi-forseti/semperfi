/* Dashboard component contract in Chromium. Only this test server receives requests. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
function dependency(name) {
  try { return require(name); }
  catch (_) { return createRequire(path.join(os.tmpdir(), 'semperfi-review-tools', 'package.json'))(name); }
}
const {chromium} = dependency('playwright');
const root = path.resolve(__dirname, '../..');
const requests = [], errors = [], passed = [];
const attack = '<img src=x onerror="window.injected=true"> & revisão ⚖️';
let mode = 'success', modalMode = 'success', revision = 1, holdNext = false, held = null;
function fixture(month = '2026-10') {
  return {
    generated_at:`2026-10-02T12:00:${String(revision).padStart(2,'0')}Z`,timezone:'America/Sao_Paulo',today:'2026-10-02',month,
    counts:{active_processes:37 + revision,critical_deadlines:8,overdue_deadlines:3,appointments_today:5,completed_appointments_today:2,pending_intimations:6,triage_intimations:4,stored_files:42,pending_files:2,total_audit_events:1874},
    financial:{forecast_revenue:'1500.99',overdue_receivables:'321.45',overdue_receivables_count:2,overdue_payables:'200.01',overdue_payables_count:1,received_month:month==='2026-10'?'123.45':'91.23',paid_month:'23.45',net_month:month==='2026-10'?'100.00':'67.78',period_start:month+'-01',period_end:new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10),basis:'entry_date'},
    urgent_actions:{total:25,items:[{kind:'deadline',id:'hidden-internal-id',title:attack,description:'Prazo vencido há 3 dias',date:'2026-09-29',section:'deadlines',severity:'danger'}]},
    upcoming_deadlines:{total:8,items:[{id:'hidden-deadline-id',title:attack,date:'2026-09-29',process_number:'PROCESSO-FICTICIO-TESTE',days_remaining:-3}]},
    calendar:{days:[{date:month+'-02',appointments:13,deadlines:10}]},
  };
}
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    if (url.pathname === '/dashboard-test') {
      const styles=['style','interface','themes','accessibility','dashboard'].map(name=>`<link rel="stylesheet" href="/assets/css/${name}.css">`).join('');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(`<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard component test</title>${styles}<style>html,body{height:auto;overflow:auto;display:block}main{padding:12px;max-width:1200px;margin:auto}dialog{width:min(40rem,calc(100vw - 32px));max-height:90vh;overflow:auto;padding:16px;background:var(--obsidian-light);color:var(--text-primary);border:1px solid var(--border-color)}</style></head><body><main></main><dialog aria-labelledby="testDialogTitle"></dialog><script src="/assets/js/dashboard.js"></script></body></html>`);
      return;
    }
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(root+path.sep)||!url.pathname.startsWith('/assets/')) {res.writeHead(403).end();return;}
    const content=await fs.readFile(file);
    res.writeHead(200,{'Content-Type':`${path.extname(file)==='.js'?'text/javascript':'text/css'}; charset=utf-8`}).end(content);
  } catch (_) { res.writeHead(404).end(); }
});
async function main() {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin)return route.abort();
      if(!url.pathname.startsWith('/v1/'))return route.continue();
      requests.push(url.pathname+url.search);
      const reply=(json,status=200)=>route.fulfill({json,status});
      if(url.pathname==='/v1/dashboard') {
        if(holdNext){holdNext=false;held={route,data:fixture(url.searchParams.get('month')||undefined)};return;}
        if(mode==='failure')return reply({detail:'Não disponível'},503);
        if(mode==='forbidden')return reply({detail:'Permissão revogada'},403);
        if(mode==='unauthorized')return reply({detail:'Sessão encerrada'},401);
        if(mode==='invalid')return reply({...fixture(),counts:{}});
        if(mode==='invalid-money-count')return reply({...fixture(),financial:{...fixture().financial,overdue_receivables_count:undefined}});
        if(mode==='invalid-period')return reply({...fixture(),financial:{...fixture().financial,period_end:'2026-11-01'}});
        if(mode==='invalid-calendar')return reply({...fixture(),calendar:{days:[{date:'2026-10-02',appointments:-1,deadlines:3}]}});
        if(mode==='invalid-alert')return reply({...fixture(),urgent_actions:{total:1,items:[{title:'Alerta incompleto'}]}});
        return reply(fixture(url.searchParams.get('month')||undefined));
      }
      if(modalMode==='failure')return reply({detail:'Não disponível'},503);
      if(modalMode==='forbidden')return reply({detail:'Permissão revogada'},403);
      const offset=Number(url.searchParams.get('offset'));
      if(url.pathname==='/v1/dashboard/alerts')return reply({total:25,items:Array.from({length:Math.min(20,25-offset)},(_,i)=>({kind:'deadline',id:`alert-${offset+i}`,title:`Aviso ${offset+i+1}: ${attack}`,description:'Revisão necessária',date:'2026-10-02',section:'deadlines',severity:'warning'}))});
      if(url.pathname==='/v1/dashboard/day')return reply({date:url.searchParams.get('date'),total:23,items:Array.from({length:Math.min(20,23-offset)},(_,i)=>({id:`day-${offset+i}`,kind:i%2?'deadline':'appointment',title:`Registro ${offset+i+1}: ${attack}`,time:'14:30:00',location:attack,process_number:attack,status:'pending',date:url.searchParams.get('date')}))});
      errors.push(`Unexpected API ${url.pathname}`);return reply({},404);
    });
    await page.goto(origin+'/dashboard-test');
    await page.evaluate(()=>{
      window.DB={processes:Array(999).fill({status:'active'}),files:Array(888).fill({}),audit:Array(777).fill({}),financial:[{value:99999999}]};
      localStorage.setItem('semperfi_test_fake_operational_cache',JSON.stringify(window.DB));
      window.realNow=Date.now;window.testTimeShift=0;Date.now=()=>window.realNow()+window.testTimeShift;
      window.visits=[];window.ignoreAbort=false;
      window.dashboardRequest=async(path,options={})=>{
        const response=await fetch('/v1'+path,{...options,...(window.ignoreAbort?{signal:undefined}:{})});
        if(!response.ok)throw Object.assign(new Error('Request failed'),{status:response.status});
        return response.json();
      };
      window.mountDashboard=(intervalMs=3600000)=>{
        window.dashboardController?.dispose();
        document.querySelector('main').innerHTML=SemperfiDashboard.render();
        window.dashboardController=SemperfiDashboard.mount({request:window.dashboardRequest,navigate:section=>window.visits.push(section),intervalMs,
          closeModal:()=>document.querySelector('dialog').close(),
          openModal:({title,body,footer,onMount})=>{
            const dialog=document.querySelector('dialog');dialog.innerHTML='<h2 id="testDialogTitle"></h2>'+body+'<footer>'+footer+'</footer>';
            dialog.querySelector('h2').textContent=title;dialog.showModal();onMount(dialog);
          }});
      };
      window.mountDashboard();
    });
    const ready=()=>page.waitForFunction(()=>document.getElementById('dashboardStatus')?.textContent==='Dados consultados com sucesso.');
    const metric=key=>page.locator(`[data-metric="${key}"] .kpi-value`);
    await ready();
    assert.equal(await metric('active_processes').textContent(),'38');
    assert.equal(await metric('stored_files').textContent(),'42');
    assert.equal(await metric('total_audit_events').textContent(),'1874');
    assert.match(await metric('overdue_receivables').textContent(),/321,45/);
    assert.match(await page.locator('#dashboardPanel').textContent(),/Vencido há 3 dia/);
    assert.equal(await page.locator('time').getAttribute('datetime'),'2026-10-02T12:00:01Z');
    assert.doesNotMatch(await page.locator('#dashboardPanel').textContent(),/hidden-internal-id|hidden-deadline-id|99\.999\.999/);
    passed.push('Cards and timestamps use only server projections, ignoring divergent browser data and uncapped audit count');

    await page.locator('[data-metric="active_processes"]').focus();await page.keyboard.press('Enter');
    await page.locator('[data-metric="stored_files"]').focus();await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(()=>window.visits),['processes','metadata']);
    passed.push('Metric buttons support native keyboard navigation');

    await page.locator('#dashboardMonth').fill('2026-09');await page.locator('#dashboardMonth').dispatchEvent('change');await ready();
    assert.equal(await page.locator('#dashboardMonth').inputValue(),'2026-09');
    assert.match(await page.locator('#dashboardPanel').textContent(),/setembro de 2026/);
    assert.match(await page.locator('#dashboardPanel').textContent(),/91,23/);
    assert.equal(await metric('appointments_today').textContent(),'5');
    await page.getByRole('button',{name:'Próximo mês',exact:true}).click();await ready();
    assert.equal(await page.locator('#dashboardMonth').inputValue(),'2026-10');
    assert.equal(await page.getByRole('button',{name:'Próximo mês',exact:true}).evaluate(el=>el===document.activeElement),true);
    passed.push('Month controls request backend periods without changing server-defined today');

    await page.locator('[data-dashboard-day="2026-10-02"]').focus();await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('#dashboardRecords')?.textContent.includes('Mostrando 1 a 20'));
    assert.match(await page.locator('#dashboardRecords').textContent(),/Compromisso: Registro 1|Prazo: Registro 2/);
    assert.equal(await page.locator('#dashboardRecords img').count(),0);
    await page.getByRole('button',{name:'Próxima página',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#dashboardRecords')?.textContent.includes('Mostrando 21 a 23'));
    assert.equal(await page.getByRole('button',{name:'Próxima página',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Página anterior',exact:true}).evaluate(el=>el===document.activeElement),true);
    await page.getByRole('button',{name:'Página anterior',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#dashboardRecords')?.textContent.includes('Mostrando 1 a 20'));
    await page.getByRole('button',{name:'Fechar',exact:true}).click();
    passed.push('Calendar opens paginated backend day records by keyboard, with working previous and next controls');

    await page.getByRole('button',{name:'Ver todos os avisos',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#dashboardRecords')?.textContent.includes('Mostrando 1 a 20'));
    await page.getByRole('button',{name:'Próxima página',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#dashboardRecords')?.textContent.includes('Mostrando 21 a 25'));
    await page.locator('#dashboardRecords [data-dashboard-nav]').first().click();
    assert.equal(await page.locator('dialog').isVisible(),false);
    assert.equal((await page.evaluate(()=>window.visits)).at(-1),'deadlines');
    assert.equal(await page.locator('#dashboardPanel img').count(),0);
    assert.equal(await page.evaluate(()=>window.injected),undefined);
    assert.match(await page.locator('#dashboardPanel').textContent(),/onerror=/);
    passed.push('Alerts paginate from API, close on navigation and escape persisted HTML across cards and modals');

    mode='failure';await page.getByRole('button',{name:'Atualizar dados',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('dashboardStatus').textContent.includes('última consulta'));
    assert.equal(await metric('active_processes').textContent(),'38');
    assert.equal(await page.locator('time').getAttribute('datetime'),'2026-10-02T12:00:01Z');
    assert.equal(await page.locator('#dashboardStatus').getAttribute('role'),'alert');
    assert.equal(await page.getByRole('button',{name:'Atualizar dados',exact:true}).evaluate(el=>el===document.activeElement),true);
    await page.locator('[data-dashboard-day="2026-10-02"]').focus();
    await page.evaluate(()=>window.dashboardController.reload());
    assert.equal(await page.locator('[data-dashboard-day="2026-10-02"]').evaluate(el=>el===document.activeElement),true);
    mode='success';revision=2;await page.getByRole('button',{name:'Atualizar dados',exact:true}).click();await ready();
    assert.equal(await metric('active_processes').textContent(),'39');
    assert.equal(await page.locator('time').getAttribute('datetime'),'2026-10-02T12:00:02Z');
    passed.push('Failed refresh labels stale results and preserves previous timestamp; successful retry replaces data');

    for(const failure of ['forbidden','unauthorized']) {
      mode=failure;await page.getByRole('button',{name:'Atualizar dados',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('[data-dashboard-body]')?.getAttribute('aria-busy')==='false'&&document.getElementById('dashboardStatus')?.getAttribute('role')==='alert');
      assert.equal(await page.locator('[data-metric]').count(),0);
      assert.equal(await page.locator('time').count(),0);
      mode='success';await page.getByRole('button',{name:'Tentar novamente',exact:true}).click();await ready();
    }
    passed.push('Expired or revoked access clears previously visible data for both 401 and 403');

    for(const failure of ['failure','invalid','invalid-money-count','invalid-period','invalid-calendar','invalid-alert']) {
      mode=failure;await page.evaluate(()=>window.mountDashboard());
      await page.waitForFunction(()=>document.getElementById('dashboardStatus')?.getAttribute('role')==='alert');
      assert.equal(await page.locator('[data-metric]').count(),0);
      assert.match(await page.locator('[data-dashboard-body]').textContent(),/Indicadores indisponíveis/);
    }
    mode='success';await page.getByRole('button',{name:'Tentar novamente',exact:true}).click();await ready();
    passed.push('Initial network and malformed-response failures show unavailable state instead of fabricated zero values');

    for(const [month,button] of [['1900-01','Mês anterior'],['2100-12','Próximo mês']]) {
      await page.locator('#dashboardMonth').fill(month);await page.locator('#dashboardMonth').dispatchEvent('change');await ready();
      assert.equal(await page.getByRole('button',{name:button,exact:true}).isDisabled(),true);
      await page.getByRole('button',{name:'Atualizar dados',exact:true}).click();await ready();
      assert.equal(await page.getByRole('button',{name:button,exact:true}).isDisabled(),true);
    }
    await page.locator('#dashboardMonth').fill('2026-10');await page.locator('#dashboardMonth').dispatchEvent('change');await ready();
    const editingCount=requests.length;
    await page.locator('#dashboardMonth').focus();await page.evaluate(()=>{window.testTimeShift+=31000;window.dispatchEvent(new Event('focus'));});
    await page.waitForTimeout(50);assert.equal(requests.length,editingCount);
    await page.locator('[data-metric="active_processes"]').focus();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await ready();
    assert.equal(requests.length,editingCount+1);
    assert.equal(await page.locator('[data-metric="active_processes"]').evaluate(el=>el===document.activeElement),true);
    passed.push('Supported month boundaries remain disabled after loading, editing period pauses refresh and card focus survives it');

    modalMode='failure';await page.getByRole('button',{name:'Ver todos os avisos',exact:true}).click();
    await page.locator('#dashboardRecords [role="alert"]').waitFor();
    assert.equal(await page.locator('#dashboardRecords .dashboard-alert').count(),0);
    modalMode='success';await page.locator('#dashboardRecords').getByRole('button',{name:'Tentar novamente',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#dashboardRecords')?.textContent.includes('Mostrando 1 a 20'));
    const modalCount=requests.length;await page.evaluate(()=>{window.testTimeShift+=31000;window.dispatchEvent(new Event('focus'));});
    await page.waitForTimeout(50);assert.equal(requests.length,modalCount);
    modalMode='forbidden';await page.getByRole('button',{name:'Próxima página',exact:true}).click();
    await page.locator('#dashboardRecords [role="alert"]').waitFor();assert.equal(await page.locator('[data-metric]').count(),0);
    await page.getByRole('button',{name:'Fechar',exact:true}).click();modalMode='success';
    await page.getByRole('button',{name:'Tentar novamente',exact:true}).click();await ready();
    passed.push('Modal retries failed queries, pauses background refresh and removes parent indicators when access is revoked');

    await page.evaluate(()=>{window.ignoreAbort=true;});holdNext=true;
    await page.evaluate(()=>{window.dashboardController.reload();});
    await page.waitForFunction(()=>document.querySelector('[data-dashboard-body]').getAttribute('aria-busy')==='true');
    while(!held)await new Promise(resolve=>setTimeout(resolve,10));
    const loadingCount=requests.length;await page.evaluate(()=>{window.testTimeShift+=31000;window.dispatchEvent(new Event('focus'));});
    await page.waitForTimeout(50);assert.equal(requests.length,loadingCount);
    revision=3;await page.evaluate(()=>{window.dashboardController.reload();});await ready();
    await held.route.fulfill({json:held.data});held=null;
    await page.waitForTimeout(75);
    assert.equal(await metric('active_processes').textContent(),'40');
    await page.evaluate(()=>{window.ignoreAbort=false;});
    passed.push('Late response cannot replace a more recent successful request even when cancellation is ignored');

    const beforeFocus=requests.length;
    await page.evaluate(()=>{window.testTimeShift+=31000;window.dispatchEvent(new Event('focus'));});
    await page.waitForFunction(()=>document.querySelector('time')?.dateTime==='2026-10-02T12:00:03Z'&&document.querySelector('[data-dashboard-body]').getAttribute('aria-busy')==='false');
    assert.equal(requests.length,beforeFocus+1);
    await page.evaluate(()=>{window.dashboardController.dispose();window.testTimeShift+=31000;window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForTimeout(75);assert.equal(requests.length,beforeFocus+1);
    const beforeRemount=requests.length;
    await page.evaluate(()=>window.mountDashboard(30));await ready();assert.equal(requests.length,beforeRemount+1);
    await page.evaluate(()=>{window.testTimeShift+=31000;});
    await page.waitForTimeout(100);assert.equal(requests.length,beforeRemount+2);
    await page.evaluate(()=>{document.querySelector('main').innerHTML='<h1>Outra seção</h1>';window.testTimeShift+=31000;});
    await page.waitForTimeout(100);assert.equal(requests.length,beforeRemount+2);
    await page.evaluate(()=>window.mountDashboard());await ready();
    passed.push('Focus and timed refresh fetch again; disposal and detached panels stop background activity; reopening fetches fresh data');

    await page.addScriptTag({content:dependency('axe-core').source});
    for(const theme of ['dark','light']) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      await page.setViewportSize({width:320,height:780});
      const widths=await page.evaluate(()=>({viewport:innerWidth,body:document.body.scrollWidth,document:document.documentElement.scrollWidth,panel:document.querySelector('#dashboardPanel').scrollWidth}));
      assert.ok(widths.body<=widths.viewport&&widths.document<=widths.viewport,JSON.stringify({theme,widths}));
      const violations=await page.evaluate(async()=> (await axe.run(document.querySelector('main'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}})).violations.map(({id,nodes})=>({id,targets:nodes.map(node=>node.target)})));
      assert.deepEqual(violations,[],`${theme} accessibility violations`);
    }
    passed.push('Dark and light themes pass automated WCAG checks and fit a 320px viewport without horizontal page overflow');
    const artifacts=path.resolve(root,'../back-end/var/test');await fs.mkdir(artifacts,{recursive:true});
    await page.evaluate(()=>document.documentElement.dataset.theme='dark');
    await page.setViewportSize({width:1280,height:900});await page.screenshot({path:path.join(artifacts,'dashboard-desktop.png'),fullPage:true});
    await page.setViewportSize({width:320,height:780});await page.screenshot({path:path.join(artifacts,'dashboard-mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,scenarios:passed.length,javascriptErrors:errors.length,coverage:passed}));
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>server.close());
