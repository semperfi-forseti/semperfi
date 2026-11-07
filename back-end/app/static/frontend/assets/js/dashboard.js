/* Only presents authenticated server projections. No local business aggregates. */
(() => {
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const countKeys=['active_processes','critical_deadlines','overdue_deadlines','appointments_today','completed_appointments_today','pending_intimations','triage_intimations','stored_files','pending_files','total_audit_events'];
  const moneyKeys=['forecast_revenue','overdue_receivables','overdue_payables','received_month','paid_month','net_month'];
  const sections=new Set(['processes','deadlines','agenda','intimations','financial','metadata','audit']);
  const mounts=new WeakMap();
  const money=value=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(value));
  const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')?value.split('-').reverse().join('/'):'Data indisponível';
  const monthLabel=value=>new Intl.DateTimeFormat('pt-BR',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(value+'-01T12:00:00Z'));
  const clock=data=>new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'medium',timeZone:data.timezone}).format(new Date(data.generated_at));
  const statuses={pending:'Pendente',pendente:'Pendente',confirmed:'Confirmado',confirmado:'Confirmado',completed:'Concluído',concluido:'Concluído'};
  const validCount=value=>Number.isSafeInteger(value)&&value>=0;
  const validMoney=value=>typeof value==='string'&&/^-?\d+\.\d{2}$/.test(value)&&Number.isFinite(Number(value));
  const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
  const optionalText=value=>value==null||typeof value==='string';
  function validAlert(item){return item&&typeof item.title==='string'&&typeof item.description==='string'&&validDate(item.date)&&['danger','warning'].includes(item.severity)&&['deadlines','intimations','financial'].includes(item.section)&&(item.amount==null||validMoney(item.amount));}
  function validate(data) {
    if(!data||!/^\d{4}-(0[1-9]|1[0-2])$/.test(data.month)||data.month<'1900-01'||data.month>'2100-12'||!validDate(data.today)||typeof data.generated_at!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(data.generated_at)||Number.isNaN(Date.parse(data.generated_at))||typeof data.timezone!=='string')throw Error('Invalid dashboard');
    if(countKeys.some(key=>!validCount(data.counts?.[key])))throw Error('Invalid counters');
    if(moneyKeys.some(key=>!validMoney(data.financial?.[key]))||!validCount(data.financial.overdue_receivables_count)||!validCount(data.financial.overdue_payables_count))throw Error('Invalid totals');
    const lastDay=new Date(Date.UTC(Number(data.month.slice(0,4)),Number(data.month.slice(5)),0)).toISOString().slice(0,10);
    if(data.financial.basis!=='entry_date'||data.financial.period_start!==data.month+'-01'||data.financial.period_end!==lastDay||!Array.isArray(data.calendar?.days))throw Error('Invalid period');
    const days=new Set();
    for(const day of data.calendar.days){if(!day||!validDate(day.date)||day.date.slice(0,7)!==data.month||!validCount(day.appointments)||!validCount(day.deadlines)||!validCount(day.appointments+day.deadlines)||days.has(day.date))throw Error('Invalid calendar');days.add(day.date);}
    validatePage(data.upcoming_deadlines,item=>item&&typeof item.title==='string'&&validDate(item.date)&&optionalText(item.process_number)&&Number.isSafeInteger(item.days_remaining));
    validatePage(data.urgent_actions,validAlert);clock(data);return data;
  }
  function validatePage(data,validItem=()=>true) {
    if(!data||!validCount(data.total)||!Array.isArray(data.items)||data.items.length>data.total||data.items.some(item=>!validItem(item)))throw Error('Invalid page');
    return data;
  }
  function render(){return '<section id="dashboardPanel" aria-labelledby="dashboardTitle"><h1 id="dashboardTitle" class="page-title">Visão Geral</h1><p id="dashboardStatus" role="status" aria-live="polite">Carregando indicadores do banco…</p><div data-dashboard-body aria-busy="true"></div></section>';}
  function card(key,label,value,sub,section,attention=false){return `<button type="button" class="kpi-card${attention?' dashboard-attention':''}" data-dashboard-nav="${section}" data-metric="${key}"><span class="kpi-label">${escape(label)}</span><span class="kpi-value">${escape(value)}</span><span class="kpi-change">${escape(sub)}</span></button>`;}
  function alertRows(items) {
    return items.map(item=>`<article class="dashboard-alert ${item.severity==='danger'?'dashboard-attention':''}"><h3>${escape(item.title)}</h3><p>${escape(item.description)}${item.amount?' · '+escape(money(item.amount)):''}</p><p class="text-muted">${escape(date(item.date))}</p>${sections.has(item.section)?`<button type="button" class="btn btn-secondary btn-small" data-dashboard-nav="${item.section}">Abrir ${escape(({deadlines:'Prazos',intimations:'Intimações',financial:'Financeiro'})[item.section]||'registros')}</button>`:''}</article>`).join('');
  }
  function calendar(data) {
    const [year,month]=data.month.split('-').map(Number), start=new Date(Date.UTC(year,month-1,1)).getUTCDay(),length=new Date(Date.UTC(year,month,0)).getUTCDate();
    const days=new Map(data.calendar.days.map(day=>[day.date,day]));
    let cells='<span class="calendar-date empty" aria-hidden="true"></span>'.repeat(start);
    for(let number=1;number<=length;number++) {
      const iso=data.month+'-'+String(number).padStart(2,'0'),item=days.get(iso),total=item?(item.appointments+item.deadlines):0;
      cells+=`<button type="button" class="calendar-date${iso===data.today?' today':''}${total?' has-event':''}" data-dashboard-day="${iso}"${iso===data.today?' aria-current="date"':''} aria-label="${escape(date(iso))}: ${total} registro(s)">${number}</button>`;
    }
    return `<div class="calendar-header"><button type="button" class="calendar-nav-btn" data-dashboard-month-step="-1" aria-label="Mês anterior"${data.month==='1900-01'?' disabled':''}>←</button><strong>${escape(monthLabel(data.month))}</strong><button type="button" class="calendar-nav-btn" data-dashboard-month-step="1" aria-label="Próximo mês"${data.month==='2100-12'?' disabled':''}>→</button></div><div class="calendar-days" aria-hidden="true">${['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].map(label=>`<span class="calendar-day">${label}</span>`).join('')}</div><div class="calendar-dates">${cells}</div><p class="text-muted mt-12">Compromissos não cancelados e prazos pendentes. Selecione um dia para consultar.</p>`;
  }
  function content(data) {
    const c=data.counts,f=data.financial,urgent=data.urgent_actions,deadlines=data.upcoming_deadlines;
    return `<div class="dashboard-toolbar"><p>Última consulta: <time datetime="${escape(data.generated_at)}">${escape(clock(data))}</time> · Horário de Brasília</p><button class="btn btn-secondary" type="button" data-dashboard-refresh>Atualizar dados</button></div>
      <div class="kpi-grid">
        ${card('active_processes','Processos ativos',c.active_processes,'Ativos e críticos','processes')}
        ${card('critical_deadlines','Prazos críticos',c.critical_deadlines,`${c.overdue_deadlines} vencido(s) · próximos 7 dias incluídos`,'deadlines',c.critical_deadlines>0)}
        ${card('appointments_today','Compromissos hoje',c.appointments_today,`${c.completed_appointments_today} concluído(s) · cancelados excluídos`,'agenda')}
        ${card('pending_intimations','Intimações pendentes',c.pending_intimations,`${c.triage_intimations} em triagem`,'intimations')}
        ${card('forecast_revenue','Receita prevista',money(f.forecast_revenue),'Receitas com situação prevista','financial')}
        ${card('overdue_receivables','Receitas vencidas',money(f.overdue_receivables),`${f.overdue_receivables_count} conta(s) a receber`,'financial',Number(f.overdue_receivables)>0)}
        ${card('stored_files','Arquivos armazenados',c.stored_files,`${c.pending_files} registro(s) sem preservação confirmada`,'metadata')}
        ${card('total_audit_events','Eventos auditados',c.total_audit_events,'Total registrado pela organização','audit')}
      </div>
      <div class="dashboard-period"><label class="form-label" for="dashboardMonth">Mês do calendário e do resumo financeiro</label><input class="form-input" id="dashboardMonth" type="month" min="1900-01" max="2100-12" required value="${data.month}"><p>Os indicadores “hoje” e “prazos críticos” consideram ${escape(date(data.today))}.</p></div>
      <div class="grid-2x2">
        <section class="panel"><h2 class="panel-title">Ação necessária agora</h2>${urgent.total?`<p>Mostrando ${urgent.items.length} de ${urgent.total} aviso(s).</p>${alertRows(urgent.items)}<button type="button" class="btn btn-secondary" data-dashboard-alerts>Ver todos os avisos</button>`:'<p>Nenhum alerta pendente nos registros consultados.</p>'}</section>
        <section class="panel"><h2 class="panel-title">Calendário</h2><div id="dashboardCalendar">${calendar(data)}</div></section>
        <section class="panel"><h2 class="panel-title">Prazos pendentes</h2>${deadlines.items.length?`<p>Mostrando ${deadlines.items.length} de ${deadlines.total} prazo(s), por vencimento.</p><div class="timeline">${deadlines.items.map(item=>`<article class="timeline-item"><div class="timeline-date">${escape(item.days_remaining<0?`Vencido há ${-item.days_remaining} dia(s)`:item.days_remaining===0?'Vence hoje':date(item.date))}</div><div class="timeline-content">${escape(item.title)} — ${escape(item.process_number||'Processo não disponível')}</div></article>`).join('')}</div>`:'<p>Nenhum prazo pendente.</p>'}<button class="btn btn-secondary" type="button" data-dashboard-nav="deadlines">Abrir Prazos</button></section>
        <section class="panel"><h2 class="panel-title">Resumo financeiro · ${escape(monthLabel(data.month))}</h2><p>Valores por <strong>data do lançamento</strong>. O cadastro atual não registra a data efetiva do pagamento.</p>
          ${[['Recebido no período',f.received_month],['Pago no período',f.paid_month],['Saldo dos lançamentos do período',f.net_month],['Receitas previstas (todos os períodos)',f.forecast_revenue],['Receitas vencidas (todos os períodos)',f.overdue_receivables],['Despesas vencidas (todos os períodos)',f.overdue_payables]].map(([label,value])=>`<div class="detail-row"><span class="detail-label">${escape(label)}:</span><span class="detail-value">${escape(money(value))}</span></div>`).join('')}
          <button class="btn btn-secondary mt-12" type="button" data-dashboard-nav="financial">Abrir Financeiro</button></section>
      </div>`;
  }
  function mount({request,navigate,openModal,closeModal=()=>{},intervalMs=60000}={}) {
    const panel=document.getElementById('dashboardPanel');if(!panel||typeof request!=='function')return;
    mounts.get(panel)?.dispose();
    const body=panel.querySelector('[data-dashboard-body]'),status=panel.querySelector('#dashboardStatus');
    const state={data:null,version:0,disposed:false,controller:null,lastLoad:0,modalVersion:0,modalController:null,modalOpen:()=>false,loading:false};
    const current=()=>!state.disposed&&panel.isConnected;
    function announce(message,failed=false){status.textContent=message;status.setAttribute('role',failed?'alert':'status');}
    function controls(disabled){panel.querySelectorAll('[data-dashboard-refresh],[data-dashboard-month-step],#dashboardMonth').forEach(button=>button.disabled=disabled||(button.dataset.dashboardMonthStep==='-1'&&state.data?.month==='1900-01')||(button.dataset.dashboardMonthStep==='1'&&state.data?.month==='2100-12'));}
    function focusSelector(){const active=document.activeElement;if(!panel.contains(active))return null;if(active.id==='dashboardMonth')return '#dashboardMonth';for(const name of ['data-metric','data-dashboard-day','data-dashboard-month-step','data-dashboard-nav']){if(active.hasAttribute(name))return `[${name}="${CSS.escape(active.getAttribute(name))}"]`;}for(const name of ['data-dashboard-refresh','data-dashboard-alerts'])if(active.hasAttribute(name))return `[${name}]`;return null;}
    async function load(month=state.data?.month,focus) {
      if(!current())return;
      const preferredFocus=focus||focusSelector();let restoreFocus=null;
      const captureFocus=()=>panel.contains(document.activeElement)||document.activeElement===document.body?(focusSelector()||preferredFocus):null;
      const version=++state.version;state.controller?.abort();state.controller=new AbortController();
      state.loading=true;controls(true);body.setAttribute('aria-busy','true');announce('Consultando registros no banco…');
      try {
        const result=validate(await request('/dashboard'+(month?'?month='+encodeURIComponent(month):''),{cache:'no-store',signal:AbortSignal.any([state.controller.signal,AbortSignal.timeout(30000)])}));
        if(!current()||version!==state.version)return;
        restoreFocus=captureFocus();state.data=result;state.lastLoad=Date.now();body.innerHTML=content(result);announce('Dados consultados com sucesso.');
      }catch(error) {
        if(!current()||version!==state.version)return;
        restoreFocus=captureFocus();
        if(error?.status===401||error?.status===403)state.data=null;
        body.innerHTML=state.data?content(state.data):'<p>Indicadores indisponíveis. Não foi possível consultar os registros.</p><button type="button" class="btn btn-secondary" data-dashboard-refresh>Tentar novamente</button>';
        announce(state.data?'Não foi possível atualizar. Os valores exibidos são da última consulta indicada abaixo.':error?.status===403?'Seu perfil não permite consultar este painel.':'Não foi possível carregar o dashboard. Verifique a conexão e tente novamente.',true);
      }finally{if(current()&&version===state.version){state.loading=false;body.setAttribute('aria-busy','false');controls(false);if(restoreFocus){const target=panel.querySelector(restoreFocus);(target&&!target.disabled?target:panel.querySelector('[data-dashboard-refresh]'))?.focus({preventScroll:true});}}}
    }
    function modal(kind,selectedDate) {
      if(typeof openModal!=='function')return;
      state.modalController?.abort();
      const modalVersion=++state.modalVersion;
      openModal({title:kind==='day'?'Registros de '+date(selectedDate):'Avisos da organização',body:'<section id="dashboardRecords" aria-live="polite"></section>',footer:'<button class="btn btn-secondary" type="button" data-dashboard-close>Fechar</button>',onMount(container){
        const records=container.querySelector('#dashboardRecords');if(!records)return;let version=0,closed=false;
        const alive=()=>current()&&!closed&&records.isConnected&&records.getClientRects().length>0&&state.modalVersion===modalVersion;
        state.modalOpen=alive;
        const leave=()=>{closed=true;state.modalController?.abort();closeModal();};
        const closeButton=container.querySelector('[data-dashboard-close]');if(closeButton)closeButton.onclick=leave;
        async function page(offset=0,restoreFocus) {
          const ticket=++version;records.innerHTML='<p role="status">Consultando registros…</p>';
          state.modalController?.abort();state.modalController=new AbortController();
          try {
            const path=kind==='day'?'/dashboard/day?date='+encodeURIComponent(selectedDate)+'&':'/dashboard/alerts?';
            const result=validatePage(await request(path+`offset=${offset}&limit=20`,{cache:'no-store',signal:AbortSignal.any([state.modalController.signal,AbortSignal.timeout(30000)])}),kind==='day'?item=>item&&['appointment','deadline'].includes(item.kind)&&typeof item.title==='string'&&typeof item.status==='string'&&item.date===selectedDate&&optionalText(item.time)&&optionalText(item.location)&&optionalText(item.process_number):validAlert);
            if(kind==='day'&&result.date!==selectedDate)throw Error('Invalid day');
            if(!alive()||ticket!==version)return;
            records.innerHTML=`<p>${result.total} registro(s). Mostrando ${result.items.length?offset+1:0} a ${offset+result.items.length}.</p>${result.items.length?(kind==='day'?result.items.map(item=>`<article class="dashboard-alert"><h3>${item.kind==='deadline'?'Prazo':'Compromisso'}: ${escape(item.title)}</h3><p>${escape(item.time?.slice(0,5)||'Sem horário')} · ${escape(statuses[item.status]||'Situação registrada')}</p>${item.location?`<p>${escape(item.location)}</p>`:''}${item.process_number?`<p>Processo: ${escape(item.process_number)}</p>`:''}<button class="btn btn-secondary" type="button" data-dashboard-nav="${item.kind==='deadline'?'deadlines':'agenda'}">Abrir ${item.kind==='deadline'?'Prazos':'Agenda'}</button></article>`).join(''):alertRows(result.items)):'<p>Nenhum registro encontrado.</p>'}<div class="filter-bar"><button class="btn btn-secondary" type="button" data-page-prev ${offset===0?'disabled':''}>Página anterior</button><button class="btn btn-secondary" type="button" data-page-next ${offset+result.items.length>=result.total?'disabled':''}>Próxima página</button></div>`;
            records.querySelector('[data-page-prev]').onclick=()=>page(Math.max(0,offset-20),'[data-page-prev]');records.querySelector('[data-page-next]').onclick=()=>page(offset+20,'[data-page-next]');
            records.querySelectorAll('[data-dashboard-nav]').forEach(button=>button.onclick=()=>{leave();navigate(button.dataset.dashboardNav);});
            if(restoreFocus)(records.querySelector(restoreFocus+':not(:disabled)')||records.querySelector('.filter-bar button:not(:disabled)'))?.focus({preventScroll:true});
          }catch(error){if(alive()&&ticket===version){if(error?.status===401||error?.status===403){state.data=null;state.version++;state.controller?.abort();state.loading=false;body.innerHTML='<p>Indicadores indisponíveis. Consulte novamente após verificar seu acesso.</p><button type="button" class="btn btn-secondary" data-dashboard-refresh>Tentar novamente</button>';body.setAttribute('aria-busy','false');announce('Seu acesso aos registros não está disponível. Verifique sua sessão e suas permissões.',true);}records.innerHTML='<p role="alert">Não foi possível consultar os registros.</p><button class="btn btn-secondary" type="button">Tentar novamente</button>';records.querySelector('button').onclick=()=>page(offset);}}
        }
        page();
      }});
    }
    function click(event) {
      const button=event.target.closest('button');if(!button||button.disabled)return;
      if(button.hasAttribute('data-dashboard-refresh'))load(state.data?.month,'[data-dashboard-refresh]');
      if(button.dataset.dashboardNav&&sections.has(button.dataset.dashboardNav))navigate(button.dataset.dashboardNav);
      if(button.hasAttribute('data-dashboard-alerts'))modal('alerts');
      if(button.dataset.dashboardDay)modal('day',button.dataset.dashboardDay);
      if(button.dataset.dashboardMonthStep&&state.data){const [year,month]=state.data.month.split('-').map(Number),next=new Date(Date.UTC(year,month-1+Number(button.dataset.dashboardMonthStep),1));const value=next.toISOString().slice(0,7);if(value>='1900-01'&&value<='2100-12')load(value,`[data-dashboard-month-step="${button.dataset.dashboardMonthStep}"]`);}
    }
    function change(event){if(event.target.id==='dashboardMonth'&&event.target.reportValidity())load(event.target.value,'#dashboardMonth');}
    function refreshVisible(){if(current()&&!state.loading&&!state.modalOpen()&&!document.hidden&&document.activeElement?.id!=='dashboardMonth'&&Date.now()-state.lastLoad>=30000)load();}
    panel.addEventListener('click',click);panel.addEventListener('change',change);
    window.addEventListener('focus',refreshVisible);document.addEventListener('visibilitychange',refreshVisible);
    const timer=setInterval(()=>{if(!current())dispose();else refreshVisible();},intervalMs);
    function dispose(){state.disposed=true;state.controller?.abort();state.modalController?.abort();clearInterval(timer);window.removeEventListener('focus',refreshVisible);document.removeEventListener('visibilitychange',refreshVisible);panel.removeEventListener('click',click);panel.removeEventListener('change',change);}
    const controller={dispose,reload:()=>load()};mounts.set(panel,controller);load();return controller;
  }
  window.SemperfiDashboard={render,mount};
})();
