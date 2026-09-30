(function () {
  'use strict';

  const scriptUrl = document.currentScript?.src || new URL('assets/js/commercial.js', document.baseURI).href;
  const catalogUrl = new URL('../../data/commercial.json', scriptUrl).href;
  const moneyFormat = new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL'});
  const countFormat = new Intl.NumberFormat('pt-BR');
  const boundPanels = new WeakSet();
  let catalog = null;
  let loading = null;

  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const money = value => moneyFormat.format(value);
  const count = value => countFormat.format(value);
  const button = (label, action, primary = false, extra = '') => `<button type="button" class="commercial-btn commercial-btn-${primary ? 'primary' : 'secondary'}" data-commercial-action="${action}" ${extra}>${escape(label)}</button>`;
  const notice = '<p class="commercial-note">A contratação ainda não está disponível. A seleção serve para consultar valores e condições do catálogo; não ativa planos, adiciona saldo nem gera cobranças.</p>';

  function validateCatalog(data) {
    const positive = value => Number.isFinite(value) && value > 0;
    const integer = value => Number.isInteger(value) && value > 0;
    const text = value => typeof value === 'string' && value.trim().length > 0;
    const groups = ['plans','addons','creditPackages','diligenceRecharges','creditOperations'];
    if (!data || data.currency !== 'BRL') throw new Error('Catálogo inválido.');
    for (const group of groups) {
      if (!Array.isArray(data[group]) || !data[group].length) throw new Error('Catálogo incompleto.');
      const keys = new Set();
      for (const item of data[group]) {
        if (!item || !/^[a-z0-9_]+$/.test(item.key) || keys.has(item.key)) throw new Error('Item de catálogo inválido.');
        keys.add(item.key);
      }
    }
    for (const plan of data.plans) {
      if (!text(plan.name) || !(plan.price === null || positive(plan.price))) throw new Error('Plano inválido.');
      for (const field of ['seats','storedProcesses','monitoredProcesses','evidenceGB','credits']) {
        if (!(plan[field] === null || integer(plan[field]))) throw new Error('Limite inválido.');
      }
    }
    for (const addon of data.addons) {
      if (!text(addon.name) || !positive(addon.price) || !integer(addon.unit)) throw new Error('Adicional inválido.');
    }
    for (const pack of data.creditPackages) {
      if (!integer(pack.credits) || !positive(pack.price) || !positive(pack.unit)) throw new Error('Pacote inválido.');
    }
    for (const recharge of data.diligenceRecharges) {
      if (!text(recharge.name) || !positive(recharge.amount)) throw new Error('Recarga inválida.');
    }
    for (const operation of data.creditOperations) {
      if (!text(operation.label) || !integer(operation.credits)) throw new Error('Operação inválida.');
    }
    if (!positive(data.diligenceFee?.rate) || data.diligenceFee.rate > 1 || !positive(data.diligenceFee?.minimum)) throw new Error('Taxa inválida.');
    return data;
  }

  async function requestCatalog() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(catalogUrl, {credentials:'same-origin', signal:controller.signal, cache:'no-cache'});
      if (!response.ok) throw new Error('Não foi possível carregar o catálogo.');
      return validateCatalog(await response.json());
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function loadCatalog() {
    if (catalog) return Promise.resolve(catalog);
    if (!loading) {
      loading = (async () => {
        try {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try { catalog = await requestCatalog(); return catalog; }
            catch (error) { if (attempt === 1) throw error; }
          }
        } finally {
          loading = null;
        }
      })();
    }
    return loading;
  }

  function overviewCard(title, status, description, label, action) {
    return `<article class="commercial-card"><h2>${escape(title)}</h2><p class="commercial-status">${escape(status)}</p><p>${escape(description)}</p><div class="commercial-actions">${button(label, action, action === 'plans')}</div></article>`;
  }

  function renderOverview() {
    return `<div class="commercial-grid">
      ${overviewCard('Planos da plataforma', 'Compare as op??es', 'Consulte mensalidades, usu?rios e capacidade de cada plano.', 'Comparar planos', 'plans')}
    </div>`;
  }

  function render() {
    return `<section class="commercial-shell" id="commercialPanel" aria-labelledby="commercialTitle">
      <header class="commercial-heading"><p class="commercial-eyebrow">Catálogo comercial</p><h1 id="commercialTitle">Plano &amp; Consumo</h1><p>Assinatura da plataforma, créditos investigativos e diligências externas. Informações separadas do financeiro jurídico do escritório.</p></header>
      ${notice}
      <div data-commercial-content aria-busy="${catalog ? 'false' : 'true'}">${catalog ? renderOverview() : '<p class="commercial-status" role="status">Carregando catálogo comercial…</p>'}</div>
    </section>`;
  }

  async function mount() {
    const panel = document.getElementById('commercialPanel');
    if (!panel) return;
    if (!boundPanels.has(panel)) {
      boundPanels.add(panel);
      panel.addEventListener('click', event => {
        const trigger = event.target.closest('[data-commercial-action]');
        if (!trigger || !panel.contains(trigger)) return;
        const action = trigger.dataset.commercialAction;
        if (action === 'retry') { mount(); return; }
        if (!catalog) return;
        if (action === 'plans') openPlans();
      });
    }
    if (catalog) return;
    const content = panel.querySelector('[data-commercial-content]');
    content.setAttribute('aria-busy', 'true');
    content.innerHTML = '<p class="commercial-status" role="status">Carregando catálogo comercial…</p>';
    try {
      await loadCatalog();
      if (panel.isConnected) content.innerHTML = renderOverview();
    } catch (_) {
      if (panel.isConnected) content.innerHTML = `<div class="commercial-error"><p role="status">O catálogo comercial não está disponível no momento.</p><p>Você pode continuar usando as demais áreas do sistema.</p>${button('Tentar novamente', 'retry')}</div>`;
    } finally {
      if (panel.isConnected) content.setAttribute('aria-busy', 'false');
    }
  }

  function dialog(title, body, actions, onAction, onChange) {
    openModal({
      title:escape(title), wide:true,
      body:`<div class="commercial-dialog">${body}</div>`,
      footer:`${actions}${button('Fechar', 'close')}`,
      onMount(container) {
        const root = container;
        const handleClick = event => {
          const trigger = event.target.closest('[data-commercial-action]');
          if (!trigger || !root.contains(trigger)) return;
          if (trigger.dataset.commercialAction === 'close') { closeModal(); return; }
          if (onAction) onAction(trigger.dataset.commercialAction, trigger, root);
        };
        root.querySelectorAll('.modal-body, .modal-footer').forEach(area => area.addEventListener('click', handleClick));
        if (onChange) {
          const body = root.querySelector('.modal-body');
          body.addEventListener('input', event => onChange(event, root));
          body.addEventListener('change', event => onChange(event, root));
        }
      }
    });
  }

  function planFeatures(plan) {
    const rows = [
      plan.seats === null ? 'Usuários personalizados' : `${count(plan.seats)} usuário(s)`,
      plan.storedProcesses === null ? 'Armazenamento personalizado' : `${count(plan.storedProcesses)} processos armazenados`,
      plan.monitoredProcesses === null ? 'Monitoramento personalizado' : `${count(plan.monitoredProcesses)} processos monitorados`,
      plan.evidenceGB === null ? 'Evidências com capacidade personalizada' : `${count(plan.evidenceGB)} GB de evidências`,
      plan.credits === null ? 'Créditos personalizados' : `${count(plan.credits)} créditos por mês`
    ];
    return `<ul class="commercial-features">${rows.map(row => `<li>${escape(row)}</li>`).join('')}</ul>`;
  }

  function openPlans() {
    dialog('Comparar planos', `<p class="commercial-note">Mensalidades e franquias do catálogo. Abra os detalhes para conhecer cada plano.</p>
      <div class="commercial-plans">${catalog.plans.map(plan => `<article class="commercial-plan ${plan.featured ? 'commercial-plan-featured' : ''}">
        ${plan.featured ? '<span class="commercial-badge">Em destaque</span>' : ''}<h3>${escape(plan.name)}</h3>
        <p class="commercial-price">${plan.price === null ? 'Sob proposta' : money(plan.price)}${plan.price === null ? '' : '<span class="commercial-price-unit">/mês</span>'}</p>
        ${planFeatures(plan)}<div class="commercial-actions">${button('Ver detalhes', 'select-plan', true, `data-commercial-key="${escape(plan.key)}" aria-label="${escape(`Ver detalhes do plano ${plan.name}`)}"`)}</div>
      </article>`).join('')}</div>`, '', (action, trigger) => {
        if (action !== 'select-plan') return;
        const plan = catalog.plans.find(item => item.key === trigger.dataset.commercialKey);
        if (plan) openPlanSummary(plan);
      });
  }

  function openPlanSummary(plan) {
    const custom = plan.price === null;
    dialog(custom ? 'Plano Corporate' : `Resumo · ${plan.name}`, `<section class="commercial-selection"><h3>${escape(plan.name)}</h3><p class="commercial-price">${custom ? 'Sob proposta' : `${money(plan.price)}<span class="commercial-price-unit">/mês</span>`}</p>${planFeatures(plan)}</section>
      ${custom ? '<p class="commercial-note">Capacidade e condições personalizadas para sua organização. A contratação real ainda não está disponível.</p>' : notice}`,
      button('Voltar aos planos', 'back'), action => { if (action === 'back') openPlans(); });
  }

  window.SemperfiCommercial = Object.freeze({render, mount, loadCatalog, planFeatures});
})();
