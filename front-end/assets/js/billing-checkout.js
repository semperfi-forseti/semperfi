/* Asaas Sandbox only. Payment state always comes from the backend. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value);
  const requests = new Map();
  const loads = new WeakMap();
  const planNames = {lite:'Lite',profissional:'Profissional',escritorio:'Escritório',equipe:'Equipe'};
  const statuses = {creating:'Em preparação',unknown:'Aguardando confirmação',open:'Aguardando pagamento',
    paid:'Pagamento de teste confirmado',canceled:'Cancelado',expired:'Expirado',failed:'Não concluído'};

  function safeCheckoutUrl(value) {
    try {
      const url = new URL(value);
      const queryId = url.searchParams.get('id');
      const validPath = /^\/checkoutSession\/show\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname)
        || (url.pathname === '/checkoutSession/show' && url.searchParams.getAll('id').length === 1
          && /^[A-Za-z0-9_-]{1,128}$/.test(queryId || ''));
      return url.protocol === 'https:' && url.hostname === 'sandbox.asaas.com' && !url.username && !url.password
        && !url.port && validPath ? url.href : null;
    } catch (_) { return null; }
  }

  function paymentError(error) {
    const code = error?.detail?.policy_code || error?.detail?.code;
    if (code === 'MFA_REAUTH_REQUIRED') return 'Por segurança, entre novamente antes de iniciar o pagamento de teste.';
    if (code === 'CHECKOUT_ALREADY_EXISTS') return 'Já existe um pedido em andamento. Atualize a situação para acompanhá-lo.';
    if (code === 'CHECKOUT_RECONCILIATION_REQUIRED' || code === 'CHECKOUT_UNAVAILABLE') {
      return 'Ainda não foi possível confirmar o pedido. Atualize a situação antes de tentar novamente.';
    }
    // Provider messages, stack traces, configuration paths and IDs are never
    // rendered, even when the current user is an administrator.
    return 'Não foi possível concluir o pedido. Atualize a situação antes de tentar novamente.';
  }

  function render() {
    return '<section class="panel mt-20" id="billingCheckout" aria-labelledby="billingCheckoutTitle"><h2 id="billingCheckoutTitle">Pagamentos de teste · Asaas Sandbox</h2><p>Este é um ambiente de teste, sem cobrança real. Os testes não ativam uma assinatura nem liberam créditos para uso real.</p><div data-billing-content role="status">Consultando pagamentos…</div></section>';
  }

  function historyMarkup(rows, canManage) {
    if (!rows.length) return '<p>Nenhum pedido de teste registrado.</p>';
    return `<h3>Pedidos de teste</h3><ul>${rows.map(row => {
      const url = row.status === 'open' && canManage ? safeCheckoutUrl(row.checkout_url) : null;
      const amount = Number.isSafeInteger(row.amount_cents) && row.amount_cents >= 0 ? ` · ${money(row.amount_cents / 100)}` : '';
      return `<li><strong>${esc(Object.hasOwn(planNames,row.plan_key) ? planNames[row.plan_key] : 'Plano')}</strong>${esc(amount)} · ${esc(Object.hasOwn(statuses,row.status) ? statuses[row.status] : 'Situação indisponível')}${url ? ` <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Continuar pagamento de teste</a>` : ''}</li>`;
    }).join('')}</ul>`;
  }

  function adminMarkup(state) {
    return `<details class="mt-12" data-billing-administration><summary>Administração dos pagamentos</summary><p>${state.enabled === true
      ? 'A conexão de pagamentos está disponível no Asaas Sandbox.'
      : 'A conexão com o Asaas Sandbox precisa ser concluída nas configurações de pagamentos da hospedagem.'}</p><p>Pedidos que aguardam confirmação devem ser conferidos no painel Asaas Sandbox antes de iniciar outro teste. Alterações, renovação e cancelamento da assinatura ainda dependem desse painel.</p></details>`;
  }

  async function mount(request) {
    const panel = document.getElementById('billingCheckout');
    if (!panel) return;
    const version = (loads.get(panel) || 0) + 1;
    loads.set(panel, version);
    const current = () => panel.isConnected && loads.get(panel) === version;
    const content = panel.querySelector('[data-billing-content]');
    content.setAttribute('aria-busy','true');
    try {
      const state = await request('/billing/status');
      if (!current()) return;
      if (state.environment !== 'sandbox' || state.sandbox_only !== true) throw new Error('Unexpected payment environment');
      const canManage = state.can_manage === true;
      const enabled = state.enabled === true;
      const rows = Array.isArray(state.checkouts) ? state.checkouts.filter(row => row && typeof row === 'object') : [];
      content.removeAttribute('role');
      content.innerHTML = `<p role="status">${enabled ? 'Pagamentos de teste disponíveis.' : 'Os pagamentos de teste ainda não estão disponíveis. Você pode consultar os planos.'}</p>${canManage ? historyMarkup(rows, true) : ''}${canManage ? adminMarkup(state) : ''}`;
      const reload = document.createElement('button');
      reload.type = 'button'; reload.className = 'btn btn-secondary'; reload.textContent = 'Atualizar situação';
      reload.onclick = () => mount(request);
      content.append(reload);
      if (!enabled || !canManage || state.can_checkout !== true) {
        if (enabled) {
          const message = document.createElement('p');
          message.textContent = canManage ? 'Acompanhe o pedido existente antes de iniciar outro teste.'
            : 'O administrador da conta pode gerenciar os pagamentos de teste.';
          content.append(message);
        }
        return;
      }
      const catalog = await request('/billing/catalog');
      if (!current()) return;
      const plans = Array.isArray(catalog.plans) ? catalog.plans.filter(plan => plan && Object.hasOwn(planNames,plan.key)
        && Number.isFinite(plan.price) && plan.price > 0) : [];
      if (!plans.length || catalog.environment !== 'sandbox' || catalog.sandbox_only !== true) throw new Error('Unavailable payment catalog');
      const form = document.createElement('form');
      form.innerHTML = `<label class="form-label" for="billingPlan">Plano mensal para teste</label><select class="form-select" id="billingPlan" required>${plans.map(plan => `<option value="${esc(plan.key)}">${esc(planNames[plan.key])} · ${esc(money(plan.price))}/mês</option>`).join('')}</select><p><label><input type="checkbox" required> Entendo que este pagamento é um teste no Asaas Sandbox.</label></p><button class="btn btn-primary" type="submit">Iniciar pagamento de teste</button><div data-checkout-result role="status" class="mt-12"></div>`;
      form.onsubmit = async event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const button = form.querySelector('button'), result = form.querySelector('[data-checkout-result]');
        if (button.disabled) return;
        const key = form.querySelector('select').value;
        if (!requests.has(key)) requests.set(key,crypto.randomUUID());
        button.disabled = true;
        result.setAttribute('role','status');
        result.textContent = 'Preparando pagamento de teste…';
        try {
          const order = await request('/billing/checkouts',{method:'POST',body:JSON.stringify({plan_key:key,request_id:requests.get(key)})});
          if (!current() || !form.isConnected) return;
          if (order.environment !== 'sandbox' || order.sandbox_only !== true) throw new Error('Unexpected payment environment');
          const url = safeCheckoutUrl(order.checkout_url);
          if (order.status === 'open' && !url) throw new Error('Invalid checkout address');
          if (order.status === 'paid') {
            result.textContent = 'Pagamento de teste confirmado. Atualize a situação para consultar o pedido.';
          } else if (url && order.status === 'open') {
            result.innerHTML = `<p>Seu pedido de teste está pronto. Continue no Asaas Sandbox e, ao retornar, atualize a situação para acompanhar a confirmação.</p><a class="btn btn-primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Continuar no Asaas Sandbox</a>`;
          } else {
            result.textContent = 'Consulte a situação do pedido antes de iniciar outro teste.';
          }
          form.querySelectorAll('input,select').forEach(control => { control.disabled = true; });
        } catch (error) {
          if (!current() || !form.isConnected) return;
          result.setAttribute('role','alert');
          result.textContent = paymentError(error);
          button.disabled = false;
        }
      };
      content.append(form);
    } catch (_) {
      if (!current()) return;
      content.setAttribute('role','status');
      content.textContent = 'Não foi possível consultar os pagamentos de teste. Tente novamente.';
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'btn btn-secondary'; retry.textContent = 'Tentar novamente';
      retry.onclick = () => mount(request);
      content.append(retry);
    } finally {
      if (current()) content.setAttribute('aria-busy','false');
    }
  }
  window.SemperfiBillingCheckout = {render,mount,safeCheckoutUrl};
})();
