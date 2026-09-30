/* Corporate queries use persisted connector runs; browser storage holds no results. */
(() => {
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state={runId:null,busy:false};
  const statuses={queued:'Na fila',running:'Em consulta',completed:'Concluída',failed:'Não concluída'};
  const dateText=value=>value ? new Date(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : value+'Z').toLocaleString('pt-BR') : 'Data não informada';
  const message=error=>error?.code==='EXECUTION_FAILED'?'A fonte não concluiu a consulta. Tente novamente mais tarde.':
    ['TIMEOUT','REQUEST_FAILED','ABORTED'].includes(error?.code)?'O acompanhamento foi interrompido. Reabra a consulta no histórico para continuar.':
    error?.detail?.reason||(typeof error?.detail==='string'?error.detail:null)||'Não foi possível concluir a operação. Confira os dados ou tente novamente.';
  function render(investigations=[]) {
    return `<section id="corporateRadar"><h1 class="page-title">Radar Societário</h1>
      <p class="page-subtitle">Consulte o cadastro e os sócios de uma empresa. As consultas ficam no histórico da organização.</p>
      <div class="alert alert-info">Dados de fonte pública exigem conferência. Relações cadastrais não demonstram responsabilidade ou irregularidade.</div>
      <div class="panel"><form id="radarForm">
      <div class="form-group"><label class="form-label" for="radarCnpj">CNPJ *</label><input class="form-input" id="radarCnpj" required inputmode="numeric" maxlength="18" pattern="(?:[0-9]{14}|[0-9]{2}[.][0-9]{3}[.][0-9]{3}/[0-9]{4}-[0-9]{2})" autocomplete="off"></div>
      <div class="form-group"><label class="form-label" for="radarInvestigation">Investigação vinculada</label><select class="form-select" id="radarInvestigation"><option value="">Sem vínculo</option>${investigations.filter(row=>!['closed','deleted','arquivada'].includes(row.status)).map(row=>`<option value="${esc(row.id)}">${esc(row.title)}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label" for="radarPurpose">Finalidade profissional *</label><input class="form-input" id="radarPurpose" required minlength="10" maxlength="1000"></div>
      <div class="form-group"><label class="form-label" for="radarBasis">Base legal *</label><select class="form-select" id="radarBasis" required><option value="">Selecione</option><option value="exercicio_regular_direitos">Exercício regular de direitos</option><option value="consentimento">Consentimento</option><option value="legitimo_interesse">Legítimo interesse</option><option value="obrigacao_legal">Obrigação legal</option></select></div>
      <div class="form-group"><label class="form-label" for="radarReference">Referência da autorização *</label><input class="form-input" id="radarReference" required minlength="3" maxlength="255"></div>
      <button class="btn btn-primary" type="submit">Consultar empresa</button></form>
      <p id="radarStatus" role="status" aria-live="polite"></p></div>
      <div id="radarResult" class="mt-20"></div>
      <section class="panel mt-20"><h2>Histórico de consultas de empresas</h2><button class="btn btn-secondary" id="radarReload" type="button">Atualizar histórico</button><div id="radarHistory" class="mt-12" aria-live="polite"></div></section>
      <p class="text-muted">Pesquisas por CPF, nome e endereço aguardam integração com fontes apropriadas.</p></section>`;
  }
  async function mount(request,build,renderResult) {
    const panel=document.getElementById('corporateRadar');if(!panel)return;
    const form=panel.querySelector('form'),status=panel.querySelector('#radarStatus'),result=panel.querySelector('#radarResult'),history=panel.querySelector('#radarHistory');
    const value=id=>form.querySelector('#radar'+id).value.trim();
    const setBusy=busy=>{
      form.querySelector('button').disabled=busy;
      history.querySelectorAll('button').forEach(button=>{button.disabled=busy;});
    };
    state.updateBusy=setBusy;
    async function load() {
      try {
        const rows=await request('/osint/runs?connector_id=brasilapi&kind=cnpj');
        if(!panel.isConnected)return;
        if(!Array.isArray(rows))throw new Error('Invalid history');
        history.innerHTML=rows.length?rows.map(row=>`<article class="panel"><h3>${esc(row.normalized_result?.razao_social || 'Consulta de empresa')}</h3><p>${esc(statuses[row.status]||'Situação em conferência')} · ${esc(dateText(row.created_at))}</p><p>${esc(row.purpose)}</p><button type="button" class="btn btn-secondary" data-radar-run="${esc(row.id)}" ${state.busy ? 'disabled' : ''}>${['queued','running'].includes(row.status)?'Acompanhar consulta':'Ver resultado'}</button></article>`).join(''):'<p>Nenhuma consulta de empresa registrada.</p>';
      } catch(error) {if(panel.isConnected)history.textContent=message(error);}
    }
    async function follow(runId,payload) {
      if(state.busy)return;
      state.busy=true;setBusy(true);status.textContent='Registrando consulta…';result.replaceChildren();
      try {
        const options={onProgress(event){
          state.runId=event.runId;
          if(panel.isConnected)status.textContent=event.status==='queued'?'Consulta registrada, aguardando processamento.':'Acompanhando a consulta…';
        }};
        const response=runId
          ? await window.SemperfiConnectorJobs.resume(request,runId,options)
          : await window.SemperfiConnectorJobs.run(request,payload,options);
        const data=response.raw_snapshot;
        if(!data || typeof data!=='object' || !data.cnpj)throw new Error('Invalid corporate response');
        const map=await build(data);
        if(!panel.isConnected)return;
        result.innerHTML=renderResult(map);
        status.textContent='Consulta concluída e registrada. Confira a fonte antes de utilizar os dados.';
      } catch(error) {if(panel.isConnected)status.textContent=message(error);}
      finally {state.busy=false;state.updateBusy?.(false);await state.reload?.();}
    }
    form.onsubmit=event=>{
      event.preventDefault();if(state.busy || !form.reportValidity())return;
      const cnpj=value('Cnpj').replace(/\D/g,'');
      if(cnpj.length!==14){status.textContent='Informe um CNPJ com 14 dígitos.';form.querySelector('#radarCnpj').focus();return;}
      void follow(null,{connector_id:'brasilapi',payload:{kind:'cnpj',value:cnpj},investigation_id:value('Investigation')||null,
        purpose:value('Purpose'),legal_basis:value('Basis'),authorization_reference:value('Reference'),scope_codes:['empresarial'],risk_level:'low'});
    };
    history.onclick=event=>{const button=event.target.closest('[data-radar-run]');if(button)void follow(button.dataset.radarRun);};
    panel.querySelector('#radarReload').onclick=()=>void load();
    state.reload=load;setBusy(state.busy);await load();
  }
  window.SemperfiRadar={render,mount};
})();
