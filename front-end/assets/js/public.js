/* Public information uses the same catalog as the authenticated workspace. */
(() => {
  'use strict';
  const plans = document.getElementById('publicPlans');
  if (!plans) return;
  const summary = document.getElementById('publicPlanSummary');
  const header = document.querySelector('.public-header');
  const links = [...document.querySelectorAll('.public-nav a')];
  const targets = links.map(link => document.querySelector(link.hash));
  const formatMoney = new Intl.NumberFormat('pt-BR', {style:'currency',currency:'BRL'});
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let catalog = null, loading = false, observer;
  const motion = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  function focusSection(target) {
    target.focus({preventScroll:true});
    target.scrollIntoView({block:'start',behavior:motion()});
  }

  function observeSections() {
    const height = Math.ceil(header.getBoundingClientRect().height);
    document.body.style.setProperty('--public-header-height', `${height}px`);
    observer?.disconnect();
    observer = new IntersectionObserver(entries => {
      const visible = targets.filter(target => {
        const rect = target.getBoundingClientRect();
        return rect.top < innerHeight * .5 && rect.bottom > height;
      });
      const current = visible[visible.length - 1];
      links.forEach((link, index) => {
        if (targets[index] === current) link.setAttribute('aria-current','location');
        else link.removeAttribute('aria-current');
      });
    }, {rootMargin:`-${height}px 0px -50% 0px`,threshold:0});
    targets.forEach(target => observer.observe(target));
  }
  new ResizeObserver(observeSections).observe(header);
  document.querySelectorAll('.public-nav a, .public-hero-actions a, .footer-nav a:not([data-access-help]), .login-jump').forEach(link => {
    link.addEventListener('click', event => {
      const target = document.querySelector(link.hash);
      if (!target) return;
      event.preventDefault();
      history.replaceState(null, '', link.hash);
      focusSection(target);
    });
  });

  async function loadPlans() {
    if (loading) return;
    loading = true;
    plans.setAttribute('aria-busy','true');
    plans.innerHTML = '<p class="commercial-status" role="status">Carregando planos…</p>';
    try {
      catalog = await window.SemperfiCommercial.loadCatalog();
      plans.innerHTML = `<div class="commercial-plans">${catalog.plans.map(plan => `<article class="commercial-plan public-plan ${plan.featured ? 'commercial-plan-featured' : ''}" data-plan-card="${plan.key}">
        ${plan.featured ? '<span class="commercial-badge">Em destaque</span>' : ''}<h3>${escape(plan.name)}</h3>
        <p class="commercial-price">${plan.price === null ? 'Sob proposta' : `${formatMoney.format(plan.price)}<span class="commercial-price-unit">/mês</span>`}</p>
        ${window.SemperfiCommercial.planFeatures(plan)}
        <div class="commercial-actions"><button class="commercial-btn commercial-btn-primary" type="button" data-public-plan="${plan.key}" aria-pressed="false" aria-controls="publicPlanSummary" aria-label="Conhecer o plano ${escape(plan.name)}">${plan.price === null ? 'Conhecer Corporate' : 'Conhecer este plano'}</button></div>
      </article>`).join('')}</div>`;
    } catch (_) {
      plans.innerHTML = '<div class="commercial-error"><p role="status">Não foi possível carregar os planos. Os formulários de acesso continuam disponíveis.</p><button class="commercial-btn commercial-btn-secondary" type="button" data-public-retry>Tentar novamente</button></div>';
    } finally {
      loading = false;
      plans.setAttribute('aria-busy','false');
    }
  }
  plans.addEventListener('click', event => {
    if (event.target.closest('[data-public-retry]')) { loadPlans(); return; }
    const button = event.target.closest('[data-public-plan]');
    if (!button || !catalog) return;
    const plan = catalog.plans.find(item => item.key === button.dataset.publicPlan);
    if (!plan) return;
    plans.querySelectorAll('[data-public-plan]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    plans.querySelectorAll('[data-plan-card]').forEach(item => item.classList.toggle('public-plan-selected', item.dataset.planCard === plan.key));
    document.getElementById('publicPlanHeading').textContent = `${plan.name} · ${plan.price === null ? 'Sob proposta' : `${formatMoney.format(plan.price)}/mês`}`;
    document.getElementById('publicPlanDescription').textContent = plan.price === null
      ? 'Capacidade e condições personalizadas para sua organização. O canal para solicitar uma proposta ainda não está disponível.'
      : `Este plano prevê ${plan.seats} ${plan.seats === 1 ? 'usuário' : 'usuários'} e ${new Intl.NumberFormat('pt-BR').format(plan.storedProcesses)} processos armazenados. A contratação ainda não está disponível.`;
    summary.hidden = false;
    focusSection(summary);
  });
  loadPlans();
})();
