/* Persisted planning and human review. No external collection or AI inference. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const engines = {tacer:'TACER · Plano de investigação',siera:'SIERA · Roteiro de revisão'};
  const types = {person:'Pessoa física',company:'Pessoa jurídica',domain:'Domínio',process:'Processo',asset:'Bem',other:'Outro'};
  const reviews = {pending:'Aguardando revisão',reviewed:'Revisão registrada',rejected:'Requer reformulação'};
  const scopes = {empresarial:'Empresarial',corporate:'Empresarial',judicial_publico:'Judicial público',public_records:'Registros públicos',integridade_publica:'Integridade pública',mercado_companhias_abertas:'Companhias abertas',territorial_cadastral:'Territorial e cadastral',prova_digital:'Prova digital',seguranca_digital_defensiva:'Segurança digital defensiva',digital_defensive:'Segurança digital defensiva'};
  const connectors = {brasilapi:'BrasilAPI',datajud:'DataJud',transparency:'Portal da Transparência',rdap_dns:'Registros públicos de domínio'};
  const bases = {exercicio_regular_de_direito:'Exercício regular de direitos',consentimento:'Consentimento',legitimo_interesse:'Legítimo interesse',cumprimento_obrigacao:'Cumprimento de obrigação legal'};
  const stageNames = {T:'Triagem',A:'Aquisição',C:'Correlação',E:'Preservação',R:'Relatório'};
  const hypothesisNames = {identity_consistency:'Conferir a consistência dos identificadores declarados.',public_record_alignment:'Comparar os fatos declarados com registros públicos autorizados.',corporate_linkage:'Conferir vínculos societários e identificar relações que precisam de validação.',digital_footprint:'Conferir os registros públicos do domínio dentro do escopo autorizado.',seed_fact_corroboration:'Corroborar os fatos fornecidos antes de utilizá-los em uma conclusão.'};
  const activeStates = new Set(['em_coleta','pendente_revisao','active']);
  const mounts = new WeakMap(), pendingRequests = new Map();
  const own = (dict,key,fallback) => Object.hasOwn(dict,key) ? dict[key] : fallback;
  const dateText = value => {const d = new Date(typeof value === 'string' && !/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value+'Z' : value);return Number.isNaN(d.getTime())?'Data indisponível':d.toLocaleString('pt-BR');};
  const mask = (value,enabled=true) => enabled ? String(value ?? '').replace(/\b(?:\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}|\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/g, document => document.replace(/\d/g,'*')) : String(value ?? '');
  const opts = dict => Object.entries(dict).map(([value,label])=>`<option value="${esc(value)}">${esc(label)}</option>`).join('');
  const errorText = error => {
    if(error?.detail?.status==='approval_required'||error?.detail?.policy_code==='HIGH_RISK_REVIEW')return 'O escopo de risco alto exige aprovação de um gestor. Nenhum planejamento foi criado.';
    if(error?.status===403)return 'Seu perfil ou o escopo aprovado não permite esta operação.';
    if(error?.status===409)return 'A investigação ou revisão mudou. Atualize o histórico e confira o registro antes de tentar novamente.';
    if(error?.status===422)return 'Confira os campos: finalidade, autorização e ao menos um escopo são obrigatórios.';
    return 'Não foi possível concluir a operação. Atualize o histórico antes de tentar novamente.';
  };

  function render({investigations=[],canWrite=false}={}) {
    const available=investigations.filter(row=>activeStates.has(row.status));
    return `<section class="panel mt-20" aria-labelledby="enginesTitle"><h2 id="enginesTitle">Planejamento e revisão da investigação</h2>
      <p>TACER organiza as etapas de trabalho. SIERA organiza pontos para conferência. Ambos usam regras fixas sobre os dados declarados: não consultam fontes, não usam IA e não produzem provas ou conclusões sobre pessoas.</p>
      ${canWrite?`<details><summary>Criar planejamento</summary><form data-engine-form class="mt-12">
        <div class="form-row"><div class="form-group"><label class="form-label" for="engineChoice">Método</label><select class="form-select" id="engineChoice" name="engine">${opts(engines)}</select></div>
        <div class="form-group"><label class="form-label" for="engineInvestigation">Investigação vinculada</label><select class="form-select" id="engineInvestigation" name="investigation_id"><option value="">Planejamento sem vínculo</option>${available.map(row=>`<option value="${esc(row.id)}">${esc(row.title)}</option>`).join('')}</select></div></div>
        <div class="form-row"><div class="form-group"><label class="form-label" for="engineTarget">Objeto do planejamento *</label><input id="engineTarget" class="form-input" name="target" minlength="3" maxlength="255" required autocomplete="off"></div>
        <div class="form-group"><label class="form-label" for="engineType">Tipo de objeto</label><select class="form-select" id="engineType" name="target_type">${opts(types)}</select></div></div>
        <div class="form-group"><label class="form-label" for="enginePurpose">Finalidade profissional *</label><textarea id="enginePurpose" class="form-textarea" name="purpose" minlength="10" maxlength="2000" required></textarea></div>
        <div class="form-row"><div class="form-group"><label class="form-label" for="engineBasis">Base legal *</label><select id="engineBasis" class="form-select" name="legal_basis" required><option value="">Selecione</option>${opts(bases)}</select></div>
        <div class="form-group"><label class="form-label" for="engineReference">Referência da autorização *</label><input id="engineReference" class="form-input" name="authorization_reference" minlength="3" maxlength="255" required autocomplete="off"></div></div>
        <fieldset class="form-group"><legend>Escopo declarado *</legend><p>Selecione apenas o escopo autorizado. Ao vincular uma investigação, use o escopo aprovado no dossiê.</p><div data-engine-scopes></div></fieldset>
        <fieldset class="form-group"><legend>Fontes a considerar no plano</legend><p>Selecionar uma fonte não executa uma consulta nem confirma sua disponibilidade.</p>${Object.entries(connectors).map(([key,label])=>`<label style="display:block"><input type="checkbox" name="connectors_allowed" value="${esc(key)}"> ${esc(label)}</label>`).join('')}</fieldset>
        <div class="form-group"><label class="form-label" for="engineRisk">Risco operacional declarado</label><select id="engineRisk" class="form-select" name="risk_level"><option value="low">Baixo</option><option value="medium" selected>Médio</option><option value="high">Alto · exige gestor</option></select></div>
        <div class="form-group"><label class="form-label" for="engineFacts">Fatos declarados para orientar a revisão</label><textarea id="engineFacts" class="form-textarea" name="facts" maxlength="3000"></textarea><p>Estes dados serão protegidos no registro; não serão tratados como fatos comprovados.</p></div>
        <p><label><input type="checkbox" name="acknowledge" required> Entendo que o resultado é um planejamento e precisa de revisão humana.</label></p>
        <button type="submit" class="btn btn-primary">Gerar e salvar planejamento</button><p data-engine-submit-status role="status"></p></form></details>`:'<p>Seu acesso permite consultar os planejamentos e suas revisões.</p>'}
      <h3 class="mt-20">Histórico de planejamentos</h3><div class="form-row"><div class="form-group"><label class="form-label" for="engineHistoryFilter">Filtrar método</label><select id="engineHistoryFilter" class="form-select"><option value="">Todos</option>${opts(engines)}</select></div><div class="form-group"><label class="form-label" for="engineHistoryInvestigation">Filtrar investigação</label><select id="engineHistoryInvestigation" class="form-select"><option value="">Todas</option>${investigations.map(row=>`<option value="${esc(row.id)}">${esc(row.title)}</option>`).join('')}</select></div></div>
      <button type="button" class="btn btn-secondary" data-engine-reload>Atualizar histórico</button><div data-engine-history class="mt-12" aria-live="polite"></div>
      <div class="mt-12"><button type="button" class="btn btn-secondary" data-engine-previous disabled>Mais recentes</button> <button type="button" class="btn btn-secondary" data-engine-next disabled>Mais antigos</button></div>
      <div data-engine-detail class="mt-20" aria-live="polite"></div></section>`;
  }

  function renderDetail(row,{masked=true,canWrite=false}={}) {
    const text=value=>esc(mask(value,masked)), result=row.result||{}, input=row.input_safe||{};
    const stages=Array.isArray(result.stages)?result.stages:[], hypotheses=Array.isArray(result.hypotheses)?result.hypotheses:[];
    const plan=Array.isArray(result.connector_plan)?result.connector_plan:[];
    return `<h3 tabindex="-1" data-engine-detail-title>${text(own(engines,row.engine,'Planejamento registrado'))}</h3>
      <p>${text(dateText(row.created_at))} · ${text(own(reviews,row.review_status,'Situação indisponível'))}</p>
      <dl><dt>Objeto declarado</dt><dd style="overflow-wrap:anywhere">${text(input.target||result.target||'Não informado')}</dd><dt>Finalidade</dt><dd style="white-space:pre-wrap;overflow-wrap:anywhere">${text(input.purpose||'Não informada')}</dd><dt>Escopo</dt><dd>${text((input.declared_scope||[]).map(code=>own(scopes,code,'Escopo autorizado no dossiê')).join(', ')||'Não informado')}</dd></dl>
      <p><strong>Planejamento sujeito a conferência.</strong> As etapas e sugestões não indicam que houve coleta, preservação ou comprovação. Este registro não debita créditos.</p>
      ${stages.length?`<h4>Etapas propostas</h4><ol>${stages.map(stage=>`<li><strong>${text(own(stageNames,stage.code,'Etapa do plano'))}</strong><p>${text(stage.objective)}</p></li>`).join('')}</ol>`:''}
      ${plan.length?`<h4>Fontes sugeridas para avaliação</h4><ul>${plan.map(item=>`<li>${text(own(connectors,item.connector_id,'Fonte autorizada'))}</li>`).join('')}</ul><p>A consulta deve ser solicitada separadamente, com autorização e disponibilidade da fonte.</p>`:''}
      ${hypotheses.length?`<h4>Pontos para conferência</h4><ul>${hypotheses.map(item=>`<li>${text(own(hypothesisNames,item.code,'Revisar a sugestão no contexto dos dados declarados.'))}</li>`).join('')}</ul><p>Esta lista usa regras fixas. Não é uma pontuação validada de risco, culpa ou responsabilidade.</p>`:''}
      ${row.review_status!=='pending'?`<h4>Revisão humana registrada</h4><p>${text(dateText(row.reviewed_at))}</p><p style="white-space:pre-wrap;overflow-wrap:anywhere">${text(row.review_notes||'Sem observações disponíveis.')}</p><p>A revisão registra a avaliação deste planejamento; não transforma sugestões em evidências.</p>`:canWrite?`<form data-engine-review><h4>Registrar revisão humana</h4><div class="form-group"><label class="form-label" for="engineReviewDecision">Decisão</label><select id="engineReviewDecision" class="form-select" name="decision"><option value="reviewed">Planejamento revisado</option><option value="rejected">Solicitar reformulação</option></select></div><div class="form-group"><label class="form-label" for="engineReviewNotes">Observações da revisão *</label><textarea id="engineReviewNotes" class="form-textarea" name="notes" required minlength="10" maxlength="4000"></textarea></div><p>A revisão fica registrada sem sobrescrever o planejamento. Para reformular, crie um novo planejamento.</p><button type="submit" class="btn btn-primary">Salvar revisão</button><p data-engine-review-status role="status"></p></form>`:'<p>Aguardando revisão por um profissional autorizado.</p>'}`;
  }

  async function mount(container,{api,investigations=[],canWrite=false,masked=true}={}) {
    if(!container||typeof api!=='function')return;
    const token={};mounts.set(container,token);container.innerHTML=render({investigations,canWrite});
    const current=()=>container.isConnected&&mounts.get(container)===token;
    const find=selector=>container.querySelector(selector), history=find('[data-engine-history]'), detail=find('[data-engine-detail]');
    const filter=find('#engineHistoryFilter'), invFilter=find('#engineHistoryInvestigation'), prev=find('[data-engine-previous]'), next=find('[data-engine-next]');
    let offset=0, historyVersion=0, detailVersion=0;
    const privacy=()=>typeof masked==='function'?masked():masked!==false;
    const detailOptions=row=>({masked:privacy(),canWrite:canWrite&&(!row.investigation_id||investigations.some(item=>item.id===row.investigation_id&&activeStates.has(item.status)))});

    async function show(id,focus=false) {
      const version=++detailVersion;detail.textContent='Carregando planejamento…';
      try {
        const row=await api('/investigation-engines/runs/'+encodeURIComponent(id));
        if(!current()||version!==detailVersion)return;
        paint(row);if(focus)detail.querySelector('[data-engine-detail-title]')?.focus();
      } catch(error){if(current()&&version===detailVersion)detail.textContent=errorText(error);}
    }
    function paint(row) {
      detail.innerHTML=renderDetail(row,detailOptions(row));
      const form=detail.querySelector('[data-engine-review]');if(!form)return;
      form.onsubmit=async event=>{
        event.preventDefault();const button=form.querySelector('button'),status=form.querySelector('[data-engine-review-status]');
        if(button.disabled||!form.reportValidity())return;
        const notes=form.elements.notes.value.trim();if(notes.length<10){status.textContent='Descreva a revisão com pelo menos 10 caracteres.';return;}
        button.disabled=true;status.textContent='Salvando revisão…';
        try {
          const updated=await api('/investigation-engines/runs/'+encodeURIComponent(row.id)+'/review',{method:'PATCH',body:JSON.stringify({decision:form.elements.decision.value,notes})});
          if(!current()||!form.isConnected)return;
          paint(updated);detail.querySelector('[data-engine-detail-title]')?.focus();await load();
        } catch(error){if(current()&&form.isConnected){status.textContent=errorText(error);button.disabled=false;}}
      };
    }
    async function load() {
      const version=++historyVersion;history.setAttribute('aria-busy','true');prev.disabled=next.disabled=true;
      const query=new URLSearchParams({limit:'20',offset:String(offset)});
      if(filter.value)query.set('engine',filter.value);if(invFilter.value)query.set('investigation_id',invFilter.value);
      try {
        const rows=await api('/investigation-engines/runs?'+query);
        if(!current()||version!==historyVersion)return;
        if(!Array.isArray(rows))throw new Error('Unexpected history');
        history.innerHTML=rows.length?`<ul>${rows.map(row=>`<li><strong>${esc(own(engines,row.engine,'Planejamento'))}</strong> · ${esc(dateText(row.created_at))} · ${esc(own(reviews,row.review_status,'Situação indisponível'))} <button type="button" class="btn btn-secondary" data-engine-open="${esc(row.id)}" aria-label="${esc('Abrir '+own(engines,row.engine,'planejamento')+' de '+dateText(row.created_at))}">Abrir planejamento</button></li>`).join('')}</ul>`:'<p>Nenhum planejamento nesta página.</p>';
        history.querySelectorAll('[data-engine-open]').forEach(button=>{button.onclick=()=>show(button.dataset.engineOpen,true);});
        prev.disabled=offset===0;next.disabled=rows.length<20;
      } catch(error){if(current()&&version===historyVersion){history.textContent=errorText(error);prev.disabled=offset===0;}}
      finally {if(current()&&version===historyVersion)history.setAttribute('aria-busy','false');}
    }
    find('[data-engine-reload]').onclick=()=>load();
    filter.onchange=invFilter.onchange=()=>{offset=0;load();};
    prev.onclick=()=>{offset=Math.max(0,offset-20);load();};next.onclick=()=>{offset+=20;load();};
    const form=find('[data-engine-form]');
    if(form) {
      function setScopes() {
        const inv=investigations.find(item=>item.id===form.elements.investigation_id.value);
        const values=inv?(inv.scope_codes||inv.scope||[]):['empresarial','judicial_publico','integridade_publica','territorial_cadastral','prova_digital','digital_defensive'];
        form.querySelector('[data-engine-scopes]').innerHTML=values.length?values.map(code=>`<label style="display:block"><input type="checkbox" name="declared_scope" value="${esc(code)}"> ${esc(own(scopes,code,'Escopo autorizado no dossiê'))}</label>`).join(''):'<p>Esta investigação não tem escopo disponível. Confira o dossiê antes de gerar um planejamento.</p>';
      }
      form.elements.investigation_id.onchange=setScopes;setScopes();
      form.onsubmit=async event=>{
        event.preventDefault();const button=form.querySelector('button'),status=form.querySelector('[data-engine-submit-status]');
        if(button.disabled||!form.reportValidity())return;
        const value=name=>form.elements[name].value.trim(), selected=name=>Array.from(form.querySelectorAll('input[name="'+name+'"]:checked'),node=>node.value);
        const declared=selected('declared_scope');
        if(!declared.length){status.textContent='Selecione pelo menos um escopo autorizado.';form.querySelector('input[name="declared_scope"]')?.focus();return;}
        const body={target:value('target'),target_type:value('target_type'),investigation_id:value('investigation_id')||null,purpose:value('purpose'),legal_basis:value('legal_basis'),authorization_reference:value('authorization_reference'),declared_scope:declared,connectors_allowed:selected('connectors_allowed'),risk_level:value('risk_level'),seed_facts:value('facts')?{observacoes:value('facts')}:{}};
        if(body.target.length<3||body.purpose.length<10||body.authorization_reference.length<3){status.textContent='Preencha o objeto, a finalidade e a referência com informações válidas.';return;}
        const engine=value('engine'),key=JSON.stringify({engine,...body});
        if(!pendingRequests.has(key))pendingRequests.set(key,crypto.randomUUID());
        button.disabled=true;status.textContent='Gerando e salvando planejamento…';
        try {
          const row=await api('/investigation-engines/'+engine+'/run',{method:'POST',body:JSON.stringify({...body,request_id:pendingRequests.get(key)})});
          if(!current())return;
          if(!row.run_id){if(row.detail?.status==='approval_required'){status.textContent=errorText(row);return;}throw new Error('Planning was not saved');}
          pendingRequests.delete(key);status.textContent='Planejamento salvo. Abra o resultado e registre a revisão.';
          offset=0;filter.value='';invFilter.value=body.investigation_id||'';await Promise.all([load(),show(row.run_id,true)]);
        } catch(error){if(current())status.textContent=errorText(error);}
        finally {if(current())button.disabled=false;}
      };
    }
    if(investigations.length===1) {
      invFilter.value=investigations[0].id;
      const selection=form?.elements.investigation_id;
      if(selection && [...selection.options].some(option=>option.value===investigations[0].id)) {
        selection.value=investigations[0].id;
        selection.dispatchEvent(new Event('change'));
      }
    }
    await load();
  }
  window.SemperfiInvestigationEngines={render,renderDetail,mount};
})();
