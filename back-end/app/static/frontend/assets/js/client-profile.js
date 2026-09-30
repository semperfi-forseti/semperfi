/* Client 360: operator supplied profile, persisted through the authenticated API. */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const field = (key, label, type = 'text', required = false, max = 255) => ({key,label,type,required,max});
  const sourceFields = [field('fonte','Fonte'),field('url','Link da fonte','url',false,2048)];
  const groups = [
    {key:'professionalHistory',label:'Histórico profissional',fields:[field('cargo','Cargo ou atividade','text',true),field('organizacao','Organização'),field('periodo','Período'),field('descricao','Descrição','textarea',false,5000),...sourceFields]},
    {key:'politicalHistory',label:'Candidaturas informadas',fields:[field('ano','Ano','year',true),field('cargo','Cargo','text',true),field('partido','Partido'),field('situacao','Situação'),...sourceFields]},
    {key:'publicOffices',label:'Cargos públicos informados',fields:[field('cargo','Cargo','text',true),field('orgao','Órgão'),field('periodo','Período'),...sourceFields]},
    {key:'assets',label:'Bens declarados',fields:[field('tipo','Tipo de bem','text',true),field('descricao','Descrição','textarea',false,5000),field('valor','Valor declarado (R$)','money'),field('ano','Ano','year'),...sourceFields]},
    {key:'companies',label:'Empresas e vínculos',fields:[field('nome','Nome da empresa','text',true),field('cnpj','CNPJ','text',false,18),field('qualificacao','Vínculo ou qualificação'),field('status','Situação'),...sourceFields]},
    {key:'newsMentions',label:'Notícias registradas',fields:[field('titulo','Título','text',true),field('data','Data','date'),field('snippet','Resumo','textarea',false,5000),...sourceFields]},
    {key:'sources',label:'Outras fontes',fields:[field('titulo','Nome da fonte','text',true),field('url','Link da fonte','url',false,2048),field('observacoes','Observações','textarea',false,5000)]}
  ];
  const basicFields = [field('profession','Profissão'),field('nationality','Nacionalidade'),field('maritalStatus','Estado civil'),field('birthDate','Data de nascimento','date'),field('biography','Biografia','textarea',false,20000),field('notes','Notas complementares','textarea',false,5000)];
  function emptyProfile() {
    return {biography:'',profession:'',nationality:'',maritalStatus:'',birthDate:null,notes:'',...Object.fromEntries(groups.map(group=>[group.key,[]]))};
  }
  function safeURL(value) {
    const raw = String(value || '');
    if (!raw || /[\s\\\x00-\x1f]/.test(raw)) return '';
    try { const url = new URL(raw); return ['https:','http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
    catch (_) { return ''; }
  }
  function documentLabel(value) {
    if (!value) return 'Não informado';
    if (typeof window.maskDoc === 'function') return window.maskDoc(value);
    return `**.***.***/****-${String(value).replace(/\D/g,'').slice(-2)}`;
  }
  function displayValue(item, value) {
    if (value === '' || value == null) return 'Não informado';
    if (item.key === 'cnpj') return escape(documentLabel(value));
    if (item.type === 'url') {
      const url = safeURL(value);
      return url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">Consultar fonte <span class="sr-only">(abre em outra aba)</span></a>` : 'Link indisponível';
    }
    if (item.type === 'money') return escape(new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(value)));
    if (item.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) return escape(String(value).split('-').reverse().join('/'));
    return escape(value);
  }
  function renderProfile(profile) {
    const data = {...emptyProfile(),...profile};
    return `<div class="form-row">${basicFields.filter(item=>data[item.key] !== '' && data[item.key] != null).map(item=>`<div class="form-group"><h3>${escape(item.label)}</h3><p style="white-space:pre-wrap;overflow-wrap:anywhere">${displayValue(item,data[item.key])}</p></div>`).join('') || '<p>Nenhuma informação complementar registrada.</p>'}</div>${groups.map(group=>{
      const rows = Array.isArray(data[group.key]) ? data[group.key] : [];
      return `<details class="mt-20"${rows.length ? ' open' : ''}><summary>${escape(group.label)} (${rows.length})</summary>${rows.length ? rows.map((row,index)=>`<article class="panel mt-12" aria-label="${escape(group.label)}: registro ${index+1}"><dl>${group.fields.filter(item=>row[item.key] !== '' && row[item.key] != null).map(item=>`<dt>${escape(item.label)}</dt><dd style="white-space:pre-wrap;overflow-wrap:anywhere">${displayValue(item,row[item.key])}</dd>`).join('')}</dl></article>`).join('') : '<p>Nenhum registro informado.</p>'}</details>`;
    }).join('')}`;
  }
  function render() {
    return '<section id="clientProfilePanel" aria-labelledby="clientProfileTitle"><h3 id="clientProfileTitle">Perfil complementar</h3><p>Registre informações fornecidas e revisadas pela equipe, com suas fontes. O sistema não confirma automaticamente os fatos descritos.</p><p id="clientProfileStatus" role="status" aria-live="polite" aria-atomic="true">Carregando perfil…</p><div id="clientProfileContent" aria-busy="true"></div></section>';
  }
  const mounted = new WeakMap();
  async function mount({clientId,canEdit=false,onSaved,onLoaded,request=window.backendApi} = {}) {
    const panel = document.getElementById('clientProfilePanel');
    if (!panel) return null;
    if (mounted.has(panel)) return mounted.get(panel);
    const content = panel.querySelector('#clientProfileContent');
    const status = panel.querySelector('#clientProfileStatus');
    const state = {version:0,profile:emptyProfile(),editing:false,dirty:false,busy:false};
    const path = `/clients/${encodeURIComponent(clientId)}/profile`;
    function announce(message, error=false) { status.textContent=message;status.setAttribute('role',error?'alert':'status'); }
    function errorMessage(error) {
      if (error?.status===409) return 'Outra pessoa atualizou este perfil. Suas alterações continuam no formulário. Recarregue os dados e revise antes de salvar novamente.';
      if (error?.status===403) return 'Seu perfil não tem permissão para esta operação.';
      if (error?.status===404) return 'Este cliente não está mais disponível. Feche o perfil e atualize a lista de clientes.';
      if (error?.status===401) return 'Sua sessão expirou. Entre novamente.';
      if (error?.status===422) return 'Revise os campos: textos, datas, valores, CNPJ e links. Nenhuma alteração foi salva.';
      return 'Não foi possível confirmar a operação. Seus dados digitados foram mantidos. Confira a conexão e recarregue o perfil antes de tentar salvar novamente.';
    }
    function actions() {
      return `<div class="filter-bar mt-20">${canEdit?'<button type="button" class="btn btn-primary" data-profile-edit>Editar perfil complementar</button>':''}<button type="button" class="btn btn-secondary" data-profile-reload>Recarregar perfil</button></div>`;
    }
    function show() { content.innerHTML=renderProfile(state.profile)+actions(); }
    function input(item,value,id) {
      const required = item.required?' required':'';
      const limit = ['text','textarea','url'].includes(item.type)?` maxlength="${item.max}"`:'';
      const label = `<label class="form-label" for="${id}">${escape(item.label)}${item.required?' *':''}</label>`;
      if (item.type==='textarea') return `<div class="form-group">${label}<textarea class="form-textarea" id="${id}" data-field="${item.key}" rows="4"${required}${limit}>${escape(value)}</textarea></div>`;
      const type = ['year','money'].includes(item.type)?'number':item.type;
      const bounds = item.type==='year'?' min="1900" max="2100" step="1"':item.type==='money'?' min="0" max="99999999999999.99" step="0.01"':item.key==='birthDate'?' min="1800-01-01"':'';
      return `<div class="form-group">${label}<input class="form-input" type="${type}" id="${id}" data-field="${item.key}" value="${escape(value)}"${required}${limit}${bounds}></div>`;
    }
    function edit(profile) {
      state.editing=true;
      content.innerHTML=`<form id="clientProfileForm"><p>As alterações serão gravadas ao selecionar “Salvar perfil”. Campos com * são obrigatórios.</p><fieldset data-profile-fields><legend>Dados complementares</legend><div class="form-row">${basicFields.map(item=>input(item,profile[item.key],`cp-${item.key}`)).join('')}</div></fieldset>${groups.map(group=>`<details class="mt-20"${profile[group.key]?.length?' open':''}><summary>${escape(group.label)}</summary><div data-group="${group.key}">${(profile[group.key]||[]).map((row,index)=>`<fieldset class="mt-12" data-profile-row="${group.key}"><legend>${escape(group.label)}: registro ${index+1}</legend><div class="form-row">${group.fields.map(item=>input(item,row[item.key],`cp-${group.key}-${index}-${item.key}`)).join('')}</div><button type="button" class="btn btn-secondary" data-remove-row="${group.key}" data-row-index="${index}" aria-label="Remover registro ${index+1} de ${escape(group.label)}">Remover registro</button></fieldset>`).join('')}</div><button type="button" class="btn btn-secondary mt-12" data-add-row="${group.key}"${(profile[group.key]||[]).length>=100?' disabled':''}>Adicionar registro em ${escape(group.label.toLowerCase())}</button><p class="text-muted">Até 100 registros.</p></details>`).join('')}<div class="filter-bar mt-20"><button type="submit" class="btn btn-primary">Salvar perfil</button><button type="button" class="btn btn-secondary" data-profile-cancel>Cancelar edição</button><button type="button" class="btn btn-secondary" data-profile-reload>Recarregar perfil</button></div></form>`;
    }
    function readFields(node,fields) {
      return Object.fromEntries(fields.map(item=>{
        const raw=node.querySelector(`[data-field="${item.key}"]`).value.trim();
        return [item.key,item.type==='year'?(raw===''?null:Number(raw)):['date','money'].includes(item.type)?(raw||null):raw];
      }));
    }
    function readForm() {
      const profile=readFields(content.querySelector('[data-profile-fields]'),basicFields);
      for (const group of groups) profile[group.key]=[...content.querySelectorAll(`[data-profile-row="${group.key}"]`)].map(row=>readFields(row,group.fields));
      return profile;
    }
    function lock(value) {
      state.busy=value;content.setAttribute('aria-busy',String(value));
      content.querySelectorAll('button,input,textarea').forEach(control=>{control.disabled=value;});
      if (!value) content.querySelectorAll('[data-add-row]').forEach(button=>{
        button.disabled=content.querySelectorAll(`[data-profile-row="${button.dataset.addRow}"]`).length>=100;
      });
    }
    async function reload(force=false) {
      if (state.busy) return;
      if (!force && state.dirty && !window.confirm('Descartar as alterações ainda não salvas e carregar o perfil do servidor?')) return;
      lock(true);announce('Carregando perfil…');
      try {
        if (typeof request!=='function') throw new Error('API unavailable');
        const result=await request(path);
        state.version=result.version;state.profile={...emptyProfile(),...result.profile};state.editing=false;state.dirty=false;
        show();announce(state.version?'Perfil carregado.':'Nenhuma informação complementar registrada.');
        if (typeof onLoaded==='function') onLoaded(clone(state.profile));
      } catch(error) {
        if (!state.editing) content.innerHTML='<button type="button" class="btn btn-secondary" data-profile-reload>Tentar carregar novamente</button>';
        announce(errorMessage(error),true);
      } finally {lock(false);}
    }
    panel.addEventListener('input',event=>{if(event.target.closest('#clientProfileForm'))state.dirty=true;});
    panel.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button || state.busy)return;
      if (button.hasAttribute('data-profile-reload')) { void reload();return; }
      if (button.hasAttribute('data-profile-edit') && canEdit) {edit(clone(state.profile));content.querySelector('input,textarea')?.focus();announce('Edição iniciada. As alterações ainda não foram salvas.');return;}
      if (button.hasAttribute('data-profile-cancel')) {
        if(state.dirty&&!window.confirm('Descartar as alterações ainda não salvas?'))return;
        state.editing=false;state.dirty=false;show();announce('Edição cancelada. O perfil salvo foi mantido.');content.querySelector('[data-profile-edit]')?.focus();return;
      }
      const key=button.dataset.addRow || button.dataset.removeRow;
      if (!key || !canEdit || !groups.some(group=>group.key===key))return;
      const profile=readForm();const adding=button.hasAttribute('data-add-row');
      if (adding) {if(profile[key].length>=100)return;profile[key].push({});}
      else profile[key].splice(Number(button.dataset.rowIndex),1);
      state.dirty=true;edit(profile);
      const section=content.querySelector(`[data-group="${key}"]`).closest('details');section.open=true;
      if(adding)section.querySelector('fieldset:last-child input,fieldset:last-child textarea')?.focus();
      else section.querySelector('[data-add-row]')?.focus();
      announce(adding?'Registro adicionado ao formulário. Salve o perfil para confirmar.':'Registro removido do formulário. Salve o perfil para confirmar.');
    });
    panel.addEventListener('submit',async event=>{
      if(event.target.id!=='clientProfileForm')return;
      event.preventDefault();if(state.busy || !canEdit || !event.target.reportValidity())return;
      const profile=readForm();lock(true);announce('Salvando perfil…');
      try {
        const result=await request(path,{method:'PUT',body:JSON.stringify({version:state.version,profile})});
        state.profile={...emptyProfile(),...result.profile};state.version=result.version;state.editing=false;state.dirty=false;
        show();announce('Perfil salvo. As informações estarão disponíveis ao reabrir o cliente.');
        content.querySelector('[data-profile-edit]')?.focus();
        if(typeof onSaved==='function')onSaved(clone(state.profile));
      }catch(error){announce(errorMessage(error),true);}
      finally{lock(false);}
    });
    const controller={reload,isDirty:()=>state.dirty};mounted.set(panel,controller);
    await reload(true);
    return controller;
  }
  window.SemperClientProfile={render,mount,renderProfile};
})();
