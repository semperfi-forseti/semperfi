/* Organization membership is persisted by the API; invitation secrets stay in memory. */
(() => {
  'use strict';
  const roles={administrator:'Administrador',manager:'Gestor',lawyer:'Advogado',investigator:'Investigador',auditor:'Auditor'};
  const states={pending:'Aguardando aceite',accepted:'Aceito',revoked:'Revogado',expired:'Expirado'};
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const roleOptions=selected=>Object.entries(roles).map(([value,label])=>`<option value="${value}"${value===selected?' selected':''}>${label}</option>`).join('');
  const parseToken=value=>{
    const text=String(value||'').trim();
    if(/^[A-Za-z0-9_-]{43}$/.test(text))return text;
    try{const url=new URL(text);if(!['http:','https:'].includes(url.protocol))return null;const token=new URLSearchParams(url.hash.slice(1)).get('organization_invite');return /^[A-Za-z0-9_-]{43}$/.test(token||'')?token:null;}catch{return null;}
  };
  let pendingToken=null;
  if(window.location?.hash?.startsWith('#organization_invite=')){
    pendingToken=parseToken(window.location.href);
    // Fragments are never transmitted as HTTP URLs. Also remove the secret from
    // the visible address/history once captured; never use browser storage.
    window.history?.replaceState(null,'',window.location.pathname+window.location.search);
  }
  const errorText=error=>{
    if(error?.detail?.policy_code==='MFA_REAUTH_REQUIRED')return 'Entre novamente e confirme o código de segurança para alterar acessos.';
    const message=typeof error?.detail==='string'?error.detail:error?.detail?.reason;
    if(message&&!/\.env\b|\/v1\/|https?:\/\/|Traceback|SQL|password_hash/i.test(message))return message;
    return 'Não foi possível concluir a operação. Confira seu acesso e tente novamente.';
  };
  const dateText=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'Data indisponível':date.toLocaleString('pt-BR');};
  async function busy(button,operation){if(button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');try{await operation();}finally{button.disabled=false;button.removeAttribute('aria-busy');}}
  function render(){
    return `<section id="organizationPanel" class="panel mt-20" aria-labelledby="organizationTitle"><h2 id="organizationTitle">Organização e equipe</h2>
      <p>Escolha o escritório ou conta em que deseja trabalhar. Os registros e acessos de cada organização são separados.</p>
      <p id="organizationStatus" role="status" aria-live="polite"></p><div id="organizationChoices">Carregando organizações…</div>
      <div id="organizationAdmin"></div>
      <details id="organizationAcceptDetails" class="mt-20"><summary>Recebi um convite para uma equipe</summary><p>Entre ou crie uma conta com o mesmo e-mail informado no convite, confirme o código de segurança e abra novamente o link. Você também pode colar o convite abaixo.</p>
        <form id="organizationAcceptForm"><label class="form-label" for="organizationInviteToken">Link ou código do convite</label><input class="form-input" id="organizationInviteToken" type="password" required autocomplete="off" spellcheck="false"><button class="btn btn-secondary mt-12" type="submit">Conferir convite</button></form><div id="organizationInvitePreview" role="status" aria-live="polite"></div>
      </details></section>`;
  }
  async function mount(request,{onSwitch=()=>window.location.reload()}={}){
    const panel=document.getElementById('organizationPanel');if(!panel)return;
    const message=panel.querySelector('#organizationStatus'),choices=panel.querySelector('#organizationChoices'),admin=panel.querySelector('#organizationAdmin');
    const acceptForm=panel.querySelector('#organizationAcceptForm'),preview=panel.querySelector('#organizationInvitePreview');
    let teamOffset=0,previewToken=null,canManage=false;
    function say(value){if(panel.isConnected)message.textContent=value;}
    async function switchTo(tenantId){
      await request('/organization/switch',{method:'POST',body:JSON.stringify({tenant_id:tenantId})});
      pendingToken=null;say('Organização alterada. Atualizando os registros…');onSwitch();
    }
    async function loadOrganizations(){
      const result=await request('/organization/mine');if(!panel.isConnected)return;
      canManage=result.can_manage===true;
      choices.innerHTML=`<ul>${result.items.map(item=>`<li><strong>${esc(item.name)}</strong> · ${esc(item.role_label)} ${item.current?'<span>(Organização atual)</span>':`<button class="btn btn-secondary btn-small" type="button" data-switch-organization="${esc(item.tenant_id)}">Trabalhar nesta organização</button>`}</li>`).join('')}</ul>`;
      if(canManage){
        admin.innerHTML=`<h3 class="mt-20">Equipe</h3><p>Alterar perfil ou suspender o acesso encerra as sessões desta pessoa nesta organização. A conta pessoal e outros escritórios são preservados. Para proteger a administração, seu próprio acesso é alterado por outro administrador.</p>
          <button id="organizationReload" class="btn btn-secondary" type="button">Atualizar equipe e convites</button><div id="organizationMembers" class="mt-12"></div>
          <h3 class="mt-20">Convidar integrante</h3><p>O convite vale por sete dias e só pode ser aceito pelo e-mail informado. O link será mostrado uma vez para você compartilhar; nenhum e-mail é enviado automaticamente.</p>
          <form id="organizationInviteForm"><div class="form-group"><label class="form-label" for="organizationInviteEmail">E-mail do integrante</label><input id="organizationInviteEmail" class="form-input" type="email" required maxlength="320" autocomplete="off"></div>
          <div class="form-group"><label class="form-label" for="organizationInviteRole">Perfil de acesso</label><select id="organizationInviteRole" class="form-select">${roleOptions('lawyer')}</select><p>Administrador gerencia os acessos. Gestor acompanha a operação; advogado atua no núcleo jurídico; investigador atua nas investigações; auditor consulta e verifica registros. As ações seguem as permissões do sistema.</p></div>
          <button type="submit" class="btn btn-primary">Gerar convite</button></form><div id="organizationShare" role="status" aria-live="polite"></div>
          <h3 class="mt-20">Convites recentes</h3><p>São apresentados os 100 convites mais recentes. Para gerar outro link para o mesmo e-mail, o anterior será revogado.</p><div id="organizationInvitations"></div>`;
        admin.querySelector('#organizationReload').onclick=event=>busy(event.currentTarget,()=>loadAdmin().catch(error=>say(errorText(error))));
        admin.querySelector('#organizationInviteForm').onsubmit=event=>{
          event.preventDefault();const form=event.currentTarget;if(!form.reportValidity())return;
          busy(form.querySelector('button'),async()=>{
            const share=admin.querySelector('#organizationShare');
            try{
              share.textContent='Gerando convite…';
              const result=await request('/organization/invitations',{method:'POST',body:JSON.stringify({email:form.querySelector('input').value.trim(),role:form.querySelector('select').value})});
              if(!/^[A-Za-z0-9_-]{43}$/.test(result.token||''))throw new Error('Invalid invitation response');
              const url=new URL(window.location.href);url.search='';url.hash='organization_invite='+result.token;
              share.innerHTML='<p>Convite criado. Compartilhe este link somente com o destinatário. Nenhum e-mail foi enviado.</p><label class="form-label" for="organizationShareLink">Link para compartilhar</label><input id="organizationShareLink" class="form-input" readonly autocomplete="off"><button class="btn btn-secondary mt-12" type="button">Copiar link do convite</button><p data-copy-status role="status"></p>';
              const input=share.querySelector('input');input.value=url.href;input.focus();input.select();
              share.querySelector('button').onclick=event=>busy(event.currentTarget,async()=>{
                const status=share.querySelector('[data-copy-status]');
                try{await navigator.clipboard.writeText(input.value);status.textContent='Link copiado.';}
                catch{input.focus();input.select();status.textContent='A cópia automática não está disponível. Copie o link selecionado usando o teclado ou o menu do navegador.';}
              });
              form.reset();await loadInvitations();
            }catch(error){share.textContent=errorText(error);}
          });
        };
        await loadAdmin();
      }else{admin.replaceChildren();}
    }
    async function loadMembers(){
      const result=await request(`/organization/members?offset=${teamOffset}&limit=100`);if(!panel.isConnected||!canManage)return;
      const records=admin.querySelector('#organizationMembers');
      records.innerHTML=result.items.length?result.items.map(member=>`<article class="panel mt-12"><h4>${esc(member.display_name)}${member.is_self?' (Você)':''}</h4><p>${esc(member.email)} · ${member.is_active?'Acesso ativo':'Acesso suspenso'}${member.account_active?'':' · Conta pessoal indisponível'}</p>
        ${member.is_self?`<p>Perfil: ${esc(member.role_label)}</p>`:`<form data-member-id="${esc(member.id)}"><label class="form-label" for="memberRole-${esc(member.id)}">Perfil de ${esc(member.display_name)}</label><select class="form-select" id="memberRole-${esc(member.id)}">${roleOptions(member.role)}</select><button class="btn btn-secondary mt-12" type="submit">Salvar perfil</button><button class="btn btn-secondary mt-12" type="button" data-member-toggle="${esc(member.id)}" data-active="${member.is_active?'false':'true'}"${!member.account_active&&!member.is_active?' disabled':''}>${member.is_active?'Suspender acesso':'Reativar acesso'}</button></form>`}</article>`).join(''):'<p>Nenhum integrante encontrado.</p>';
      records.insertAdjacentHTML('beforeend',`<p>${result.total} integrante(s) · página ${Math.floor(teamOffset/100)+1}</p><div class="filter-bar"><button type="button" class="btn btn-secondary" data-team-page="previous"${teamOffset===0?' disabled':''}>Página anterior</button><button type="button" class="btn btn-secondary" data-team-page="next"${teamOffset+result.items.length>=result.total?' disabled':''}>Próxima página</button></div>`);
      records.querySelectorAll('form[data-member-id]').forEach(form=>{form.onsubmit=event=>{
        event.preventDefault();busy(form.querySelector('button[type=submit]'),async()=>{
          try{await request(`/organization/members/${encodeURIComponent(form.dataset.memberId)}`,{method:'PATCH',body:JSON.stringify({role:form.querySelector('select').value})});say('Perfil atualizado. A pessoa deverá entrar novamente nesta organização.');await loadMembers();}
          catch(error){say(errorText(error));}
        });
      };});
    }
    async function loadInvitations(){
      const result=await request('/organization/invitations');if(!panel.isConnected||!canManage)return;
      admin.querySelector('#organizationInvitations').innerHTML=result.items.length?result.items.map(invite=>`<article class="panel mt-12"><h4>${esc(invite.email)}</h4><p>${esc(invite.role_label)} · ${esc(states[invite.status]||'Situação indisponível')}</p><p>Válido até ${esc(dateText(invite.expires_at))}</p>${invite.status==='pending'?`<button type="button" class="btn btn-secondary" data-revoke-invitation="${esc(invite.id)}">Revogar convite</button>`:''}</article>`).join(''):'<p>Nenhum convite registrado.</p>';
    }
    async function loadAdmin(){await Promise.all([loadMembers(),loadInvitations()]);}
    panel.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      if(button.dataset.switchOrganization){busy(button,()=>switchTo(button.dataset.switchOrganization).catch(error=>say(errorText(error))));}
      if(button.dataset.memberToggle){
        const activating=button.dataset.active==='true';
        if(!activating&&!window.confirm('Suspender o acesso desta pessoa nesta organização? Suas sessões neste escritório serão encerradas.'))return;
        busy(button,async()=>{try{await request(`/organization/members/${encodeURIComponent(button.dataset.memberToggle)}`,{method:'PATCH',body:JSON.stringify({is_active:activating})});say(activating?'Acesso reativado. A pessoa precisa entrar novamente.':'Acesso suspenso nesta organização.');await loadMembers();}catch(error){say(errorText(error));}});
      }
      if(button.dataset.revokeInvitation){
        if(!window.confirm('Revogar este convite? O link deixará de funcionar.'))return;
        busy(button,async()=>{try{await request(`/organization/invitations/${encodeURIComponent(button.dataset.revokeInvitation)}`,{method:'DELETE'});say('Convite revogado.');await loadInvitations();}catch(error){say(errorText(error));}});
      }
      if(button.dataset.teamPage){busy(button,async()=>{teamOffset=Math.max(0,teamOffset+(button.dataset.teamPage==='next'?100:-100));try{await loadMembers();}catch(error){say(errorText(error));}});}
    });
    acceptForm.onsubmit=event=>{
      event.preventDefault();if(!acceptForm.reportValidity())return;
      busy(acceptForm.querySelector('button'),async()=>{
        previewToken=parseToken(acceptForm.querySelector('input').value);preview.replaceChildren();
        if(!previewToken){preview.textContent='Cole um link de convite válido ou o código completo.';return;}
        try{
          const result=await request('/organization/invitations/preview',{method:'POST',body:JSON.stringify({token:previewToken})});
          preview.innerHTML=`<h3>Participar de ${esc(result.organization_name)}</h3><p>Perfil: ${esc(result.role_label)}. Válido até ${esc(dateText(result.expires_at))}.</p><p>O aceite cria um vínculo com esta organização e preserva seus outros acessos.</p><button class="btn btn-primary" type="button">Aceitar convite</button>`;
          const token=previewToken;
          preview.querySelector('button').onclick=event=>busy(event.currentTarget,async()=>{
            try{
              const accepted=await request('/organization/invitations/accept',{method:'POST',body:JSON.stringify({token})});
              pendingToken=null;previewToken=null;acceptForm.reset();
              preview.innerHTML=`<p>Convite aceito para ${esc(accepted.organization_name)}.</p><button type="button" class="btn btn-primary">Entrar nesta organização</button>`;
              preview.querySelector('button').onclick=event=>busy(event.currentTarget,()=>switchTo(accepted.tenant_id).catch(error=>say(errorText(error))));
              await loadOrganizations();
            }catch(error){say(errorText(error));}
          });
        }catch(error){preview.textContent=errorText(error);}
      });
    };
    if(pendingToken){panel.querySelector('#organizationAcceptDetails').open=true;acceptForm.querySelector('input').value=pendingToken;}
    try{await loadOrganizations();}catch(error){choices.textContent='Não foi possível carregar as organizações.';say(errorText(error));}
  }
  window.SemperfiOrganization={render,mount,hasPendingInvitation:()=>Boolean(pendingToken)};
})();
