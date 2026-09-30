(function(root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const ready = item => ['preserved','validated'].includes(item.validation_status);
  function render() {
    return '<section id="legalDocumentsPanel" aria-label="Documentos vinculados"><p role="status">Carregando documentos…</p></section>';
  }
  async function mount({targetKind, targetId, canEdit=false, request=root.backendApi, onFiles, onCount}) {
    const panel = document.getElementById('legalDocumentsPanel');
    if (!panel || !['client','process'].includes(targetKind)) return;
    const path = `/${targetKind === 'client' ? 'clients' : 'processes'}/${encodeURIComponent(targetId)}/documents`;
    let links=[], candidates=[], busy=false;
    const message = (text, failed=false) => {
      const node=panel.querySelector('[data-status]');
      if(node) { node.textContent=text; node.setAttribute('role', failed ? 'alert' : 'status'); }
    };
    async function load() {
      const result = await Promise.all([request(path), canEdit ? request('/evidences') : Promise.resolve([])]);
      links=result[0]; candidates=result[1];
      if(!panel.isConnected) return;
      onCount?.(links.length); draw();
    }
    function draw() {
      const available=candidates.filter(item=>!links.some(link=>link.evidence_id===item.id));
      panel.innerHTML=`<h3>Documentos vinculados</h3><p>Associe arquivos já enviados à organização. Remover um vínculo mantém o arquivo original e seu histórico.</p>
        <p data-status role="status" aria-live="polite"></p>
        ${canEdit ? `<form data-link-form><div class="form-group"><label class="form-label" for="legalDocumentSelect">Arquivo *</label><select id="legalDocumentSelect" class="form-select" required ${available.length?'':'disabled'}><option value="">Selecione um arquivo</option>${available.map(item=>`<option value="${escape(item.id)}">${escape(item.original_filename)}${ready(item)?'':' — preservação pendente'}</option>`).join('')}</select></div><div class="form-group"><label for="legalDocumentLabel" class="form-label">Descrição do vínculo (opcional)</label><input id="legalDocumentLabel" class="form-input" maxlength="180"></div><button class="btn btn-primary" type="submit" ${available.length?'':'disabled'}>Vincular arquivo</button></form>`:''}
        <div class="filter-bar mt-12"><button type="button" class="btn btn-secondary" data-files>Abrir Arquivos</button><button type="button" class="btn btn-secondary" data-reload>Atualizar lista</button></div>
        ${links.length ? links.map(item=>`<article class="panel mt-12"><h4>${escape(item.filename)}</h4>${item.label?`<p>${escape(item.label)}</p>`:''}<p>${ready(item)?'Preservação concluída':'Preservação pendente — consulte Arquivos'}</p><div class="filter-bar">${ready(item)?`<button type="button" class="btn btn-secondary" data-download="${escape(item.evidence_id)}">Baixar arquivo</button>`:''}${canEdit?`<button type="button" class="btn btn-secondary" data-unlink="${escape(item.id)}">Remover vínculo</button>`:''}</div></article>`).join(''):'<p>Nenhum documento vinculado. Envie arquivos na aba Arquivos e volte para associá-los aqui.</p>'}`;
      panel.querySelector('[data-files]').onclick=()=>onFiles?.();
      panel.querySelector('[data-reload]').onclick=()=>perform(load);
      panel.querySelector('[data-link-form]')?.addEventListener('submit', event=>{
        event.preventDefault();
        if(!event.currentTarget.reportValidity()) return;
        const body={evidence_id:panel.querySelector('#legalDocumentSelect').value,label:panel.querySelector('#legalDocumentLabel').value.trim()||null};
        perform(async()=>{ await request(path,{method:'POST',body:JSON.stringify(body)}); await load(); message('Vínculo salvo.'); });
      });
      panel.querySelectorAll('[data-unlink]').forEach(button=>button.onclick=()=>{
        if(root.confirm('Remover este vínculo? O arquivo original será mantido.')) perform(async()=>{
          await request(`${path}/${encodeURIComponent(button.dataset.unlink)}`,{method:'DELETE'}); await load(); message('Vínculo removido. O arquivo foi mantido.');
        });
      });
      panel.querySelectorAll('[data-download]').forEach(button=>button.onclick=()=>perform(async()=>{
        const result=await request(`/evidences/${encodeURIComponent(button.dataset.download)}/download`);
        const url=new URL(result.url);
        if(!['https:','http:'].includes(url.protocol)) throw new Error('Link de download inválido.');
        const anchor=document.createElement('a'); anchor.href=url.href; anchor.target='_blank'; anchor.rel='noopener noreferrer'; anchor.textContent='Baixar arquivo'; anchor.click();
      }));
    }
    async function perform(action) {
      if(busy) return;
      busy=true;
      const controls=[...panel.querySelectorAll('button,input,select')].map(control=>[control,control.disabled]);
      controls.forEach(([control])=>control.disabled=true);
      try { await action(); }
      catch(error) { message(root.apiErrorMessage?.(error)||error.message||'Não foi possível concluir. Tente novamente.',true); }
      finally { busy=false; controls.forEach(([control,disabled])=>{if(control.isConnected) control.disabled=disabled;}); }
    }
    try { await load(); }
    catch(error) { panel.innerHTML='<p data-status role="alert"></p><button class="btn btn-secondary" type="button">Tentar novamente</button>'; message('Não foi possível carregar os documentos.',true); panel.querySelector('button').onclick=()=>perform(load); }
  }
  root.SemperfiLegalDocuments={render,mount};
})(window);
