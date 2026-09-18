/* Keyboard, mobile navigation and empty states. No business data is stored here. */
(() => {
  'use strict';
  const sidebar = document.getElementById('sidebar');
  const mobileButton = document.getElementById('mobileMenuToggle');
  const backdrop = document.getElementById('sidebarBackdrop');
  const modal = document.getElementById('modal');
  const mobile = matchMedia('(max-width:800px)');
  let returnFocus = null;
  let modalWasOpen = false;
  const focusable = scope => [...scope.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex="0"]')].filter(el=>el.getClientRects().length);

  function setMobileMenu(open) {
    sidebar.classList.toggle('mobile-open', open);
    backdrop.classList.toggle('active', open);
    mobileButton.setAttribute('aria-expanded', String(open));
    sidebar.inert = mobile.matches && !open;
    document.querySelector('.main-wrapper').inert = mobile.matches && open;
    if (open) sidebar.querySelector('.nav-link')?.focus();
    else if (mobile.matches) mobileButton.focus();
  }
  mobileButton.addEventListener('click', () => setMobileMenu(!sidebar.classList.contains('mobile-open')));
  backdrop.addEventListener('click', () => setMobileMenu(false));
  document.getElementById('sidebarToggle').addEventListener('click', () => {
    if (mobile.matches) setMobileMenu(false);
    requestAnimationFrame(()=>document.getElementById('sidebarToggle').setAttribute('aria-expanded', String(!sidebar.classList.contains('collapsed'))));
  });
  document.getElementById('sidebarNav').addEventListener('click', event => {
    if (event.target.closest('a') && mobile.matches) setMobileMenu(false);
  });
  mobile.addEventListener('change', () => setMobileMenu(false));
  window.addEventListener('popstate', () => {
    if (typeof navigateSection === 'function') navigateSection(location.hash.slice(1));
  });
  window.addEventListener('hashchange', () => {
    if (location.hash !== '#mainContent' && typeof navigateSection === 'function') navigateSection(location.hash.slice(1));
  });
  window.addEventListener('offline', ()=>window.toast?.('Sem conexão. Verifique sua rede antes de salvar.','warning'));
  window.addEventListener('online', ()=>window.toast?.('Conexão restabelecida.','success'));
  for (const [buttonId,panelId] of [['profileBtn','profileMenu'],['notificationBtn','notifPanel']]) {
    const panel = document.getElementById(panelId);
    new MutationObserver(()=>document.getElementById(buttonId).setAttribute('aria-expanded',String(panel.classList.contains('active')))).observe(panel,{attributes:true,attributeFilter:['class']});
  }
  new MutationObserver(() => {
    if (modal.classList.contains('active')) {
      if (!modalWasOpen) returnFocus = document.activeElement;
      modalWasOpen = true;
      const heading = modal.querySelector('.modal-title');
      if (heading) { heading.id = 'activeModalTitle'; modal.setAttribute('aria-labelledby', heading.id); }
      modal.querySelector('.modal-close')?.setAttribute('aria-label', 'Fechar janela');
      document.querySelector('.main-wrapper').inert = true;
      sidebar.inert = true;
      (focusable(modal)[0] || document.getElementById('modalContent')).focus();
    } else {
      modalWasOpen = false;
      document.querySelector('.main-wrapper').inert = false;
      sidebar.inert = mobile.matches && !sidebar.classList.contains('mobile-open');
      if (returnFocus?.isConnected) returnFocus.focus();
    }
  }).observe(modal,{attributes:true,attributeFilter:['class']});
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (modal.classList.contains('active')) window.closeModal();
      if (sidebar.classList.contains('mobile-open')) setMobileMenu(false);
      document.getElementById('profileMenu').classList.remove('active');
      document.getElementById('notifPanel').classList.remove('active');
    }
    const scope = modal.classList.contains('active') ? modal : mobile.matches && sidebar.classList.contains('mobile-open') ? sidebar : null;
    if (scope && event.key === 'Tab') {
      const items = focusable(scope), first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'k') { event.preventDefault(); document.getElementById('globalSearch').focus(); }
    const target = event.target.closest('[role="button"][tabindex="0"]');
    if (target && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); target.click(); }
  });
  function enhance() {
    const content = document.getElementById('contentWrapper');
    content.querySelectorAll('[onclick]:not(button):not(a):not(input):not(select):not(textarea)').forEach(el=>{
      if (!el.querySelector('button,a,input,select,textarea')) { el.setAttribute('role','button'); el.tabIndex=0; }
    });
    if (content.querySelector('.page-title')?.textContent === 'Visão Geral' && !DB.clients.length && !DB.processes.length) {
      const welcome = document.createElement('section');
      welcome.className = 'welcome-panel';
      welcome.innerHTML = '<div><span class="eyebrow">COMECE POR AQUI</span><h2>Seu espaço está pronto para começar</h2><p>Cadastre o primeiro cliente e organize os processos, prazos e documentos da sua organização.</p></div><button class="btn btn-primary" type="button">Cadastrar primeiro cliente →</button>';
      welcome.querySelector('button').addEventListener('click',()=>window.openClientForm());
      content.prepend(welcome);
    }
    document.getElementById('maskToggle').setAttribute('aria-pressed',String(SETTINGS.masked));
  }
  document.addEventListener('semperfi:render',enhance);
  document.addEventListener('semperfi:ready',()=>{ sidebar.inert = mobile.matches; });
})();
