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
      ${overviewCard('Assinatura', 'Nenhum plano configurado', 'Compare as franquias mensais para diferentes estruturas de trabalho.', 'Ver planos', 'plans')}
      ${overviewCard('Capacidade', 'Adicionais mensais', 'Consulte ampliações de processos, evidências e usuários.', 'Consultar adicionais', 'addons')}
      ${overviewCard('Créditos Forseti', 'Carteira indisponível', 'Consulte os pacotes avulsos e os valores das operações no catálogo.', 'Ver pacotes de créditos', 'credits')}
      ${overviewCard('Diligências externas', 'Carteira indisponível', 'Consulte recargas em reais para cartórios, certidões e outros serviços externos.', 'Ver opções de recarga', 'recharges')}
    </div>
    <div class="commercial-grid">
      <section class="commercial-card"><h2>Histórico de consumo</h2><p class="commercial-muted">Nenhum consumo comercial registrado.</p></section>
      <section class="commercial-card"><h2>Histórico de cobranças</h2><p class="commercial-muted">Nenhuma cobrança registrada.</p></section>
    </div>
    <details class="commercial-card"><summary class="commercial-summary">Catálogo de operações · ${count(catalog.creditOperations.length)} operações</summary>
      <p class="commercial-note">Valores de referência em créditos. Esta tabela não executa operações nem registra consumo.</p>
      <div class="commercial-table-wrap" tabindex="0" role="region" aria-label="Catálogo de operações em créditos">
        <table><caption class="commercial-sr-only">Operações e créditos por execução no catálogo</caption><thead><tr><th scope="col">Operação</th><th scope="col">Créditos</th></tr></thead><tbody>
          ${catalog.creditOperations.map(operation => `<tr><th scope="row">${escape(operation.label)}</th><td>${count(operation.credits)}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <p class="commercial-note">Diligências externas utilizam valores em reais, separados dos créditos. Taxa de referência: ${count(catalog.diligenceFee.rate * 100)}% do custo externo ou ${money(catalog.diligenceFee.minimum)}, o maior valor.</p>
    </details>`;
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
        if (action === 'addons') openAddons();
        if (action === 'credits') openPackages('credits');
        if (action === 'recharges') openPackages('recharges');
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
    dialog('Comparar planos', `<p class="commercial-note">Mensalidades e franquias do catálogo. Selecione um plano para consultar o resumo.</p>
      <div class="commercial-plans">${catalog.plans.map(plan => `<article class="commercial-plan ${plan.featured ? 'commercial-plan-featured' : ''}">
        ${plan.featured ? '<span class="commercial-badge">Em destaque</span>' : ''}<h3>${escape(plan.name)}</h3>
        <p class="commercial-price">${plan.price === null ? 'Sob proposta' : money(plan.price)}${plan.price === null ? '' : '<span class="commercial-price-unit">/mês</span>'}</p>
        ${planFeatures(plan)}<div class="commercial-actions">${button(plan.price === null ? 'Consultar proposta' : 'Selecionar', 'select-plan', true, `data-commercial-key="${escape(plan.key)}" aria-label="${escape(plan.price === null ? 'Consultar proposta Corporate' : `Selecionar plano ${plan.name}`)}"`)}</div>
      </article>`).join('')}</div>`, '', (action, trigger) => {
        if (action !== 'select-plan') return;
        const plan = catalog.plans.find(item => item.key === trigger.dataset.commercialKey);
        if (plan) openPlanSummary(plan);
      });
  }

  function openPlanSummary(plan) {
    const custom = plan.price === null;
    dialog(custom ? 'Proposta Corporate' : `Resumo · ${plan.name}`, `<section class="commercial-selection"><h3>${escape(plan.name)}</h3><p class="commercial-price">${custom ? 'Sob proposta' : `${money(plan.price)}<span class="commercial-price-unit">/mês</span>`}</p>${planFeatures(plan)}</section>
      ${custom ? '<p class="commercial-note">O plano Corporate prevê uma proposta com capacidade e condições personalizadas. O canal comercial ainda não está disponível para solicitar essa proposta.</p>' : notice}
      <p class="commercial-status" role="status">${custom ? 'Nenhuma proposta solicitada.' : 'Contratação indisponível. Nenhum plano foi ativado.'}</p>`, button('Voltar aos planos', 'back'), action => { if (action === 'back') openPlans(); });
  }

  function normalizeQuantity(input) {
    const raw = Number(input.value);
    const quantity = Number.isFinite(raw) ? Math.min(100, Math.max(0, Math.trunc(raw))) : 0;
    if (input.value !== '') input.value = String(quantity);
    return quantity;
  }

  function openAddons(previous = {}) {
    const quantities = {...previous};
    const subtotal = addon => Math.round(addon.price * 100) * (quantities[addon.key] || 0);
    const total = () => catalog.addons.reduce((sum, addon) => sum + subtotal(addon), 0) / 100;
    dialog('Expandir capacidade', `<p class="commercial-note">Adicionais recorrentes mensais. Ajuste a quantidade de cada item, entre 0 e 100, para consultar o total.</p>
      <div class="commercial-table-wrap" tabindex="0" role="region" aria-label="Adicionais de capacidade e quantidades"><table><caption class="commercial-sr-only">Adicionais com valor unitário mensal, quantidade e subtotal</caption><thead><tr><th scope="col">Adicional</th><th scope="col">Unitário/mês</th><th scope="col">Quantidade</th><th scope="col">Subtotal/mês</th></tr></thead><tbody>
        ${catalog.addons.map(addon => `<tr><th scope="row">${escape(addon.name)}</th><td>${money(addon.price)}</td><td><label class="commercial-sr-only" for="commercial-qty-${addon.key}">Quantidade: ${escape(addon.name)}</label><input class="commercial-quantity" id="commercial-qty-${addon.key}" type="number" inputmode="numeric" min="0" max="100" step="1" value="${quantities[addon.key] || 0}" data-commercial-addon="${addon.key}"></td><td data-commercial-subtotal="${addon.key}">${money(subtotal(addon) / 100)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="commercial-total" role="status" aria-live="polite" aria-atomic="true">Total mensal adicional: <strong data-commercial-total>${money(total())}</strong></p>
      <p class="commercial-status" data-commercial-validation role="status"></p>${notice}`, button('Revisar seleção', 'review', true), (action, _, root) => {
        if (action !== 'review') return;
        const selected = catalog.addons.filter(addon => quantities[addon.key] > 0);
        if (!selected.length) {
          root.querySelector('[data-commercial-validation]').textContent = 'Informe a quantidade de pelo menos um adicional.';
          root.querySelector('.commercial-quantity')?.focus();
          return;
        }
        openAddonSummary(selected, quantities, total());
      }, (event, root) => {
        const input = event.target.closest('[data-commercial-addon]');
        if (!input) return;
        const addon = catalog.addons.find(item => item.key === input.dataset.commercialAddon);
        if (!addon) return;
        quantities[addon.key] = normalizeQuantity(input);
        root.querySelector(`[data-commercial-subtotal="${addon.key}"]`).textContent = money(subtotal(addon) / 100);
        root.querySelector('[data-commercial-total]').textContent = money(total());
        root.querySelector('[data-commercial-validation]').textContent = '';
      });
  }

  function openAddonSummary(selected, quantities, total) {
    dialog('Resumo dos adicionais', `<ul class="commercial-features">${selected.map(addon => `<li>${escape(addon.name)} × ${count(quantities[addon.key])} — ${money(Math.round(addon.price * 100) * quantities[addon.key] / 100)}/mês</li>`).join('')}</ul>
      <p class="commercial-total">Total mensal adicional: <strong>${money(total)}</strong></p>${notice}<p class="commercial-status" role="status">Nenhum adicional foi contratado.</p>`, button('Voltar aos adicionais', 'back'), action => { if (action === 'back') openAddons(quantities); });
  }

  function openPackages(kind, initialKey = '') {
    const credits = kind === 'credits';
    const items = credits ? catalog.creditPackages : catalog.diligenceRecharges;
    let selectedKey = initialKey;
    const title = credits ? 'Pacotes de Créditos Forseti' : 'Opções de recarga de diligências';
    const label = item => credits ? `${count(item.credits)} créditos` : item.name;
    const price = item => credits ? item.price : item.amount;
    const selected = () => items.find(item => item.key === selectedKey);
    const selectionText = () => selected() ? `Selecionado: ${label(selected())} · ${money(price(selected()))}` : 'Nenhuma opção selecionada.';
    dialog(title, `<p class="commercial-note">${credits ? 'Pacotes avulsos do catálogo. Os créditos comprados são previstos para uso após os créditos incluídos do mês.' : `Valores do catálogo para serviços externos, como cartórios, certidões e protestos. Taxa por diligência: ${count(catalog.diligenceFee.rate * 100)}% do custo externo ou ${money(catalog.diligenceFee.minimum)}, o maior valor.`}</p>
      <fieldset class="commercial-fieldset"><legend class="commercial-legend">${credits ? 'Selecione um pacote' : 'Selecione uma opção de recarga'}</legend><div class="commercial-grid">
        ${items.map(item => `<label class="commercial-pack ${item.key === selectedKey ? 'commercial-pack-selected' : ''}"><input type="radio" name="commercial-package" value="${item.key}" ${item.key === selectedKey ? 'checked' : ''}><span>${escape(label(item))}</span><strong class="commercial-price">${money(price(item))}</strong>${credits ? `<span class="commercial-muted">${money(item.unit)} por crédito</span>` : ''}</label>`).join('')}
      </div></fieldset><p class="commercial-total" data-commercial-selection role="status" aria-live="polite" aria-atomic="true">${escape(selectionText())}</p>${notice}`, button('Revisar seleção', 'review', true), (action, _, root) => {
        if (action !== 'review') return;
        const item = selected();
        if (!item) {
          root.querySelector('[data-commercial-selection]').textContent = credits ? 'Selecione um pacote para revisar.' : 'Selecione uma opção de recarga para revisar.';
          root.querySelector('input[type="radio"]')?.focus();
          return;
        }
        dialog('Resumo da seleção', `<section class="commercial-selection"><h3>${escape(label(item))}</h3><p class="commercial-price">${money(price(item))}</p>${credits ? `<p>${money(item.unit)} por crédito</p>` : '<p>Valor de recarga para diligências externas.</p>'}</section>${notice}<p class="commercial-status" role="status">Nenhum pagamento registrado. ${credits ? 'Nenhum crédito adicionado.' : 'Nenhum saldo adicionado.'}</p>`, button('Voltar às opções', 'back'), next => { if (next === 'back') openPackages(kind, selectedKey); });
      }, (event, root) => {
        if (!event.target.matches('input[type="radio"][name="commercial-package"]')) return;
        selectedKey = event.target.value;
        root.querySelectorAll('.commercial-pack').forEach(pack => pack.classList.toggle('commercial-pack-selected', pack.querySelector('input').checked));
        root.querySelector('[data-commercial-selection]').textContent = selectionText();
      });
  }

  window.SemperfiCommercial = Object.freeze({render, mount, loadCatalog, planFeatures});
})();
