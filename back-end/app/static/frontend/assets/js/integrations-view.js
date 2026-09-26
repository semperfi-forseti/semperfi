/* Screens backed by persisted API records; no operational data in browser storage. */
(() => {
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const errorText=error=>window.apiErrorMessage?.(error)||error.message||'A operação não pôde ser concluída.';
  const agentTypes={collection:'Planejamento da coleta',metadata:'Análise dos metadados fornecidos',timeline:'Organização cronológica',correlation:'Correlações',inconsistency:'Inconsistências',report:'Rascunho de relatório',legal_review:'Pontos para revisão jurídica'};
  const statusName=value=>({queued:'Na fila',running:'Em análise',pending_human_review:'Aguardando revisão humana',failed:'Falhou',DRAFT:'Rascunho',FINAL:'Final aprovado',pending:'Pendente',preserved:'Preservado',validated:'Validado'}[value]||value);
  function contextFields(investigations, prefix) {
    return `<div class="form-group"><label class="form-label" for="${prefix}Investigation">Investigação vinculada</label><select class="form-select" id="${prefix}Investigation"><option value="">Sem vínculo</option>${investigations.filter(i=>!['deleted','arquivada','closed'].includes(i.status)).map(i=>`<option value="${esc(i.id)}">${esc(i.title)}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label" for="${prefix}Purpose">Finalidade profissional *</label><input class="form-input" id="${prefix}Purpose" required minlength="10" maxlength="1000"></div>
      <div class="form-group"><label class="form-label" for="${prefix}Basis">Base legal *</label><select class="form-select" id="${prefix}Basis" required><option value="">Selecione</option><option value="exercicio_regular_direitos">Exercício regular de direitos</option><option value="consentimento">Consentimento</option><option value="legitimo_interesse">Legítimo interesse</option><option value="obrigacao_legal">Obrigação legal</option></select></div>
      <div class="form-group"><label class="form-label" for="${prefix}Reference">Referência da autorização *</label><input class="form-input" id="${prefix}Reference" required minlength="3" maxlength="255"></div>`;
  }
  function context(form,prefix) {
    const value=id=>form.querySelector('#'+prefix+id).value.trim();
    return {investigation_id:value('Investigation')||null,purpose:value('Purpose'),legal_basis:value('Basis'),authorization_reference:value('Reference')};
  }
  async function busy(button, operation) { if(button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');try{await operation();}finally{button.disabled=false;button.removeAttribute('aria-busy');} }

  function renderTransparency(investigations=[]) {
    return `<section id="transparencyPanel"><h1 class="page-title">Transparência Pública</h1><p class="page-subtitle">Consultas de integridade pública pelo backend, com registro da execução e finalidade.</p>
      <div class="panel"><form id="transparencyForm"><div class="form-group"><label class="form-label" for="transparencyDataset">Cadastro *</label><select id="transparencyDataset" class="form-select"><option value="ceis">CEIS · Empresas inidôneas e suspensas</option><option value="cnep">CNEP · Empresas punidas</option><option value="cepim">CEPIM · Entidades impedidas</option></select></div>
      <div class="form-group"><label class="form-label" for="transparencyDocument">CPF ou CNPJ</label><input id="transparencyDocument" class="form-input" maxlength="32"></div><div class="form-group"><label class="form-label" for="transparencyName">Nome ou razão social</label><input id="transparencyName" class="form-input" maxlength="255"><p>Informe ao menos um identificador. O resultado depende da atualização da fonte pública.</p></div>
      ${contextFields(investigations,'transparency')}<button class="btn btn-primary" type="submit">Consultar cadastro</button></form><div id="transparencyResult" class="mt-20" role="status"></div></div></section>`;
  }
  function mountTransparency(request) {
    const panel=document.getElementById('transparencyPanel');if(!panel)return;
    const form=panel.querySelector('form'),result=panel.querySelector('#transparencyResult');let runId=null;
    async function execute(resume=false){
      const button=form.querySelector('button');
      await busy(button,async()=>{
        try {
          const documentValue=form.querySelector('#transparencyDocument').value.replace(/[^a-z0-9]/gi,'');
          const name=form.querySelector('#transparencyName').value.trim();
          if(!resume && !documentValue && !name){result.textContent='Informe CPF/CNPJ ou nome para consultar.';form.querySelector('#transparencyDocument').focus();return;}
          result.textContent='Solicitando consulta…';
          const options={onProgress:event=>{if(event.runId)runId=event.runId;result.textContent=event.status==='queued'?'Consulta na fila do servidor…':'Consultando a fonte…';}};
          const response=resume ? await window.SemperfiConnectorJobs.resume(request,runId,options) : await window.SemperfiConnectorJobs.run(request,{...context(form,'transparency'),connector_id:'transparency',payload:{dataset:form.querySelector('#transparencyDataset').value,...(documentValue?{document:documentValue}:{}),...(name?{name}:{})},scope_codes:['integridade_publica'],risk_level:'low'},options);
          runId=null;
          result.innerHTML=`<p>Consulta concluída. Execução: ${esc(response.run_id)}</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(response.normalized_result??response.raw_snapshot,null,2))}</pre>`;
        } catch(error){
          result.textContent=errorText(error);
          if(error.runId && ['TIMEOUT','REQUEST_FAILED','ABORTED'].includes(error.code)){
            runId=error.runId;const retry=document.createElement('button');retry.type='button';retry.className='btn btn-secondary';retry.textContent='Acompanhar execução existente';retry.onclick=()=>execute(true);result.append(retry);
          }
        }
      });
    }
    form.onsubmit=event=>{event.preventDefault();if(form.reportValidity())execute();};
  }

  function renderAgents(investigations=[]) {
    return `<section id="agentsPanel"><h1 class="page-title">Agentes IA</h1><p class="page-subtitle">Assistência supervisionada pelo Ollama. As análises ficam registradas no backend e exigem revisão humana.</p><p id="agentsAvailability" role="status">Consultando disponibilidade da IA…</p>
      <div class="panel"><form id="agentRunForm"><div class="form-group"><label class="form-label" for="agentType">Tipo de assistência</label><select class="form-select" id="agentType">${Object.entries(agentTypes).map(([key,label])=>`<option value="${key}">${esc(label)}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label" for="agentInput">Texto ou metadados para análise *</label><textarea id="agentInput" class="form-textarea" minlength="1" maxlength="12000" required style="min-height:12rem"></textarea><p>O agente analisa apenas o conteúdo fornecido. Não coleta dados privados, acessa arquivos ou executa ações jurídicas automaticamente.</p></div>
      ${contextFields(investigations,'agent')}<p><label><input type="checkbox" required> Revisarei os fatos, as inferências e as recomendações antes de qualquer uso.</label></p><button type="submit" class="btn btn-primary" disabled>Iniciar análise</button><p id="agentSubmitStatus" role="status"></p></form></div>
      <div class="panel mt-20"><h2>Análises registradas</h2><button class="btn btn-secondary" type="button" id="agentsReload">Atualizar execuções</button><div id="agentRuns" class="mt-12" role="status">Carregando…</div></div></section>`;
  }
  async function mountAgents(request) {
    const panel=document.getElementById('agentsPanel');if(!panel)return;
    const form=panel.querySelector('form'),availability=panel.querySelector('#agentsAvailability'),runs=panel.querySelector('#agentRuns'),submit=form.querySelector('button'),message=panel.querySelector('#agentSubmitStatus');
    async function load(){
      try {
        const records=await request('/agents/runs?limit=100');if(!panel.isConnected)return;
        runs.innerHTML=records.length ? records.map(row=>`<article class="panel"><h3>${esc(agentTypes[row.agent_type]||row.agent_type)}</h3><p>${esc(statusName(row.status))} · ${esc(row.model_name||'Modelo não informado')}</p><code>${esc(row.id)}</code><details><summary>Entrada e resultado registrado</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify({entrada:row.input_safe,resultado:row.output,limitacoes:row.limitations},null,2))}</pre></details></article>`).join('') : '<p>Nenhuma análise registrada.</p>';
      } catch(error){if(panel.isConnected)runs.textContent=errorText(error);}
    }
    panel.querySelector('#agentsReload').onclick=event=>busy(event.currentTarget,load);
    form.onsubmit=event=>{
      event.preventDefault();if(!form.reportValidity())return;
      busy(submit,async()=>{
        try {
          message.textContent='Registrando análise…';
          const created=await request('/agents/runs',{method:'POST',body:JSON.stringify({...context(form,'agent'),agent_type:form.querySelector('#agentType').value,input_safe:{text:form.querySelector('#agentInput').value.trim()}})});
          if(!created.agent_run_id)throw new Error(created.detail?.reason||'A análise exige aprovação antes da execução.');
          message.textContent=`Análise registrada: ${created.agent_run_id}. Aguardando o processamento.`;
          await load();
          const deadline=Date.now()+120000;
          while(panel.isConnected && Date.now()<deadline){
            const current=await request(`/agents/runs/${encodeURIComponent(created.agent_run_id)}`);
            if(['pending_human_review','failed'].includes(current.status)) {message.textContent=current.status==='failed'?'A análise falhou. Consulte o motivo no registro.':'Análise concluída e disponível para revisão humana.';await load();return;}
            await new Promise(resolve=>setTimeout(resolve,2000));
          }
          if(panel.isConnected)message.textContent='A análise segue registrada. Use Atualizar execuções para acompanhar; não é necessário enviá-la novamente.';
        } catch(error){if(panel.isConnected)message.textContent=errorText(error);}
      });
    };
    await Promise.all([load(),(async()=>{
      try{const state=await request('/agents/status');if(!panel.isConnected)return;availability.textContent=state.enabled?`Ollama configurado · ${state.model||state.model_name||'modelo local'}.`:'A IA local aguarda configuração pelo administrador.';submit.disabled=!state.enabled;}
      catch(error){availability.textContent=errorText(error);}
    })()]);
  }

  function renderReports(){return '<section id="persistedReports" class="panel mt-20"><h2>Relatórios registrados no servidor</h2><p>Revise o conteúdo antes de aprovar. A aprovação gera o documento final no cofre e exige uma verificação de segurança recente.</p><button id="reportsReload" class="btn btn-secondary" type="button">Atualizar relatórios</button><div id="reportsStatus" role="status"></div><div id="reportsRecords" class="mt-12"></div></section>';}
  async function mountReports(request){
    const panel=document.getElementById('persistedReports');if(!panel)return;
    const records=panel.querySelector('#reportsRecords'),message=panel.querySelector('#reportsStatus');
    async function load(){
      try{const rows=await request('/reports');if(!panel.isConnected)return;
        records.innerHTML=rows.length?rows.map(row=>`<article class="panel"><h3>${esc(row.title)}</h3><p>${esc(statusName(row.status))} · versão ${esc(row.version)}</p><details><summary>Revisar conteúdo</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(row.body,null,2))}</pre></details>${row.status==='DRAFT'?`<button class="btn btn-primary" data-report-id="${esc(row.id)}" data-report-action="approve">Aprovar e gerar PDF final</button>`:''}${row.status==='FINAL'?`<button class="btn btn-secondary" data-report-id="${esc(row.id)}" data-report-action="download">Obter link do PDF</button>`:''}</article>`).join(''):'<p>Nenhum relatório registrado. Gere o rascunho no espaço de investigação OSINT.</p>';
      }catch(error){message.textContent=errorText(error);}
    }
    panel.querySelector('#reportsReload').onclick=event=>busy(event.currentTarget,load);
    records.onclick=event=>{
      const button=event.target.closest('[data-report-action]');if(!button)return;
      if(button.dataset.reportAction==='approve' && !confirm('Confirma que revisou o conteúdo e deseja aprovar este relatório?'))return;
      busy(button,async()=>{
        try{
          message.textContent='Processando…';const action=button.dataset.reportAction;
          const result=await request(`/reports/${encodeURIComponent(button.dataset.reportId)}/${action}`,action==='approve'?{method:'POST'}:{});
          if(action==='approve'){message.textContent='Relatório aprovado e preservado no cofre.';await load();}
          else{const url=new URL(result.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('Endereço de download inválido.');message.innerHTML=`<a class="btn btn-primary" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">Baixar PDF aprovado</a><p>Link temporário válido por ${esc(result.expires_in_seconds)} segundos.</p>`;}
        }catch(error){message.textContent=errorText(error);}
      });
    };
    await load();
  }
  function renderFiles(investigations=[]) {
    return `<section id="evidenceFilesPanel"><h1 class="page-title">Arquivos e evidências</h1><p class="page-subtitle">Envio, preservação e verificação dos arquivos da organização.</p><div class="panel"><form id="evidenceUploadForm"><label class="form-label" for="evidenceOriginal">Arquivo original *</label><input id="evidenceOriginal" class="form-input" type="file" required accept="application/pdf,image/jpeg,image/png,image/tiff,video/mp4,video/quicktime"><p>PDF, JPEG, PNG, TIFF, MP4 ou MOV. O servidor verifica o conteúdo, o tamanho e a política de ingestão antes de aceitar o arquivo.</p>${contextFields(investigations,'evidence')}<button type="submit" class="btn btn-primary">Enviar arquivo para verificação</button><p id="evidenceUploadStatus" role="status"></p></form></div><div class="panel mt-20"><h2>Arquivos registrados</h2><button id="evidenceReload" class="btn btn-secondary" type="button">Atualizar arquivos</button><p id="evidenceActionStatus" role="status"></p><div id="evidenceRecords"></div></div></section>`;
  }
  async function mountFiles(request){
    const panel=document.getElementById('evidenceFilesPanel');if(!panel)return;
    const form=panel.querySelector('form'),records=panel.querySelector('#evidenceRecords'),message=panel.querySelector('#evidenceActionStatus');
    async function load(){
      try{
        const rows=await request('/evidences');if(!panel.isConnected)return;
        records.innerHTML=rows.length?rows.map(row=>`<article class="panel mt-12"><h3>${esc(row.original_filename)}</h3><p>${esc(statusName(row.validation_status))} · ${esc(row.mime_type)} · ${esc(row.size_bytes)} bytes</p><p style="overflow-wrap:anywhere">SHA-256: <code>${esc(row.sha256)}</code></p><div class="filter-bar">
          ${row.validation_status==='pending'?`<button class="btn btn-primary" data-evidence-action="finalize" data-evidence-id="${esc(row.id)}">Preservar no cofre</button>`:''}
          ${row.storage_key?`<button class="btn btn-secondary" data-evidence-action="verify" data-evidence-id="${esc(row.id)}">Verificar integridade</button><button class="btn btn-secondary" data-evidence-action="download" data-evidence-id="${esc(row.id)}">Obter arquivo</button>`:''}
          <button class="btn btn-secondary" data-evidence-action="events" data-evidence-id="${esc(row.id)}">Histórico de custódia</button></div><div data-evidence-detail></div></article>`).join(''):'<p>Nenhum arquivo registrado no servidor.</p>';
      }catch(error){message.textContent=errorText(error);}
    }
    panel.querySelector('#evidenceReload').onclick=event=>busy(event.currentTarget,load);
    form.onsubmit=event=>{
      event.preventDefault();if(!form.reportValidity())return;
      busy(form.querySelector('button'),async()=>{
        const output=form.querySelector('#evidenceUploadStatus');
        try{
          const payload=new FormData(),values=context(form,'evidence');
          for(const [key,value] of Object.entries(values))if(value)payload.append(key,value);
          payload.append('file',form.querySelector('input[type=file]').files[0]);payload.append('collection_method','manual_upload');payload.append('source_type','manual_upload');
          output.textContent='Enviando arquivo…';
          const created=await request('/evidences/uploads',{method:'POST',body:payload});
          if(!created.evidence_id)throw new Error(created.detail?.reason||'O envio depende de aprovação.');
          output.textContent='Arquivo recebido para preservação. Use Preservar no cofre para concluir o armazenamento seguro.';
          form.querySelector('input[type=file]').value='';await load();
        }catch(error){output.textContent=errorText(error);}
      });
    };
    records.onclick=event=>{
      const button=event.target.closest('[data-evidence-action]');if(!button)return;
      busy(button,async()=>{
        try{
          const action=button.dataset.evidenceAction;message.textContent='Processando…';
          const result=await request(`/evidences/${encodeURIComponent(button.dataset.evidenceId)}/${action}`,['events','download'].includes(action)?{}:{method:'POST'});
          const detail=button.closest('article').querySelector('[data-evidence-detail]');
          if(action==='events'){message.textContent='Histórico consultado.';detail.innerHTML=`<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(result,null,2))}</pre>`;}
          else if(action==='download'){
            const url=new URL(result.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('Endereço de download inválido.');
            message.textContent='Link temporário de download disponível.';detail.innerHTML=`<a class="btn btn-primary" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">Baixar arquivo preservado</a>`;
          }else{message.textContent=action==='finalize'?'Arquivo preservado no cofre.':(result.manifest_valid?'Integridade verificada.':'Falha de integridade: o conteúdo remoto diverge do hash registrado.');await load();}
        }catch(error){message.textContent=errorText(error);}
      });
    };
    await load();
  }
  window.SemperfiIntegrations={renderTransparency,mountTransparency,renderAgents,mountAgents,renderReports,mountReports,renderFiles,mountFiles};
})();
