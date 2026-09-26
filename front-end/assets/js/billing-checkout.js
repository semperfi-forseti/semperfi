/* Asaas Sandbox only. Payment state always comes from the backend. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value);
  const requests = new Map();
  function safeCheckoutUrl(value) {
    try { const url=new URL(value); return url.protocol==='https:' && url.hostname==='sandbox.asaas.com' && !url.username && !url.password ? url.href : null; }
    catch (_) { return null; }
  }
  function render() {
    return '<section class="panel mt-20" id="billingCheckout" aria-labelledby="billingCheckoutTitle"><h2 id="billingCheckoutTitle">Pagamentos · Asaas Sandbox</h2><p>Ambiente de homologação. Os pagamentos de teste não ativam uma assinatura de produção nem liberam créditos reais.</p><div data-billing-content role="status">Consultando disponibilidade…</div></section>';
  }
  async function mount(request) {
    const panel=document.getElementById('billingCheckout'); if(!panel)return;
    const content=panel.querySelector('[data-billing-content]');
    try {
      const state=await request('/billing/status');
      if(!panel.isConnected)return;
      if(state.environment!=='sandbox' || state.sandbox_only!==true) throw new Error('O ambiente retornado não é o Sandbox autorizado.');
      content.removeAttribute('role');
      content.innerHTML=`<p role="status">${state.enabled ? 'Asaas Sandbox configurado.' : 'Aguardando configuração da conta Sandbox pelo administrador.'}</p><div data-billing-history></div>`;
      const history=content.querySelector('[data-billing-history]');
      const rows=state.checkouts || [];
      history.innerHTML=rows.length ? `<h3>Pedidos de teste</h3><ul>${rows.map(row=>`<li>${esc(row.plan_key)} · ${esc(row.status)} ${safeCheckoutUrl(row.checkout_url) ? `<a href="${esc(safeCheckoutUrl(row.checkout_url))}" target="_blank" rel="noopener noreferrer">Abrir checkout de teste</a>` : ''}</li>`).join('')}</ul>` : '<p>Nenhum pedido de teste registrado.</p>';
      const reload=document.createElement('button');reload.type='button';reload.className='btn btn-secondary';reload.textContent='Atualizar situação';reload.onclick=()=>mount(request);content.append(reload);
      if(!state.enabled || !state.can_checkout) { const message=document.createElement('p');message.textContent=state.enabled ? 'Para iniciar outro checkout, é necessário acesso de administrador, verificação de segurança recente e nenhum pedido ativo.' : 'O catálogo continua disponível para consulta.';content.append(message);return; }
      const catalog=await request('/billing/catalog'); if(!panel.isConnected)return;
      const form=document.createElement('form');form.innerHTML=`<label class="form-label" for="billingPlan">Plano mensal para teste</label><select class="form-select" id="billingPlan" required>${catalog.plans.filter(plan=>plan.price!=null).map(plan=>`<option value="${esc(plan.key)}">${esc(plan.name)} · ${esc(money(plan.price))}/mês</option>`).join('')}</select><p><label><input type="checkbox" required> Entendo que este checkout é de teste no Asaas Sandbox.</label></p><button class="btn btn-primary" type="submit">Gerar checkout de teste</button><div data-checkout-result role="status" class="mt-12"></div>`;
      form.onsubmit=async event=>{
        event.preventDefault(); if(!form.reportValidity())return;
        const button=form.querySelector('button'),result=form.querySelector('[data-checkout-result]');if(button.disabled)return;
        const key=form.querySelector('select').value;
        if(!requests.has(key))requests.set(key,crypto.randomUUID());
        button.disabled=true;result.textContent='Criando pedido de teste…';
        try {
          const order=await request('/billing/checkouts',{method:'POST',body:JSON.stringify({plan_key:key,request_id:requests.get(key)})});
          const url=safeCheckoutUrl(order.checkout_url);if(!url || order.environment!=='sandbox')throw new Error('O checkout não retornou um endereço Sandbox válido. Atualize a situação antes de tentar novamente.');
          result.innerHTML=`<p>Pedido de teste criado. A confirmação será recebida pelo servidor após o pagamento no Sandbox.</p><a class="btn btn-primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Continuar no Asaas Sandbox</a>`;
        } catch(error) {result.textContent=window.apiErrorMessage?.(error)||error.message||'Não foi possível criar o checkout.';button.disabled=false;}
      };
      content.append(form);
    } catch(error) {
      if(!panel.isConnected)return;
      content.textContent=window.apiErrorMessage?.(error)||error.message||'Não foi possível consultar os pagamentos.';
      const retry=document.createElement('button');retry.type='button';retry.className='btn btn-secondary';retry.textContent='Tentar novamente';retry.onclick=()=>mount(request);content.append(retry);
    }
  }
  window.SemperfiBillingCheckout={render,mount,safeCheckoutUrl};
})();
