/* Keyboard, mobile navigation and empty states. No business data is stored here. */
(() => {
  'use strict';
  const sidebar = document.getElementById('sidebar');
  const navigation = document.getElementById('sidebarNav');
  const main = document.querySelector('.main-wrapper');
  const content = document.getElementById('contentWrapper');
  const mobileButton = document.getElementById('mobileMenuToggle');
  const backdrop = document.getElementById('sidebarBackdrop');
  const modal = document.getElementById('modal');
  const modalContent = document.getElementById('modalContent');
  const mobile = matchMedia('(max-width:800px)');
  let returnFocus = null;
  let modalWasOpen = false;
  let previousSection = null;
  let focusSectionRequested = false;
  let generatedId = 0;
  const preferencesOpen = () => window.SemperfiAccessibility?.isOpen() === true;
  const visible = element => element.getClientRects().length && !element.closest('[inert]');
  const focusable = scope => [...scope.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex="0"]')].filter(visible);
  const sectionStatus = document.createElement('p');
  sectionStatus.className = 'sr-only';
  sectionStatus.setAttribute('role', 'status');
  sectionStatus.setAttribute('aria-live', 'polite');
  sectionStatus.setAttribute('aria-atomic', 'true');
  document.body.append(sectionStatus);

  function updateInertState() {
    const modalOpen = modal.classList.contains('active');
    const menuOpen = mobile.matches && sidebar.classList.contains('mobile-open');
    main.inert = modalOpen || menuOpen;
    sidebar.inert = modalOpen || (mobile.matches && !menuOpen);
  }

  function enhanceNavigation() {
    navigation.querySelectorAll('.nav-link').forEach(link => {
      // CSS can hide the visible text, but the compact sidebar still needs names.
      const label = link.querySelector('span:last-child')?.textContent.trim();
      if (label) { link.setAttribute('aria-label', label); link.title = label; }
    });
    const toggle = document.getElementById('sidebarToggle');
    const expanded = mobile.matches ? sidebar.classList.contains('mobile-open') : !sidebar.classList.contains('collapsed');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', mobile.matches ? 'Fechar navegação' : expanded ? 'Recolher navegação' : 'Expandir navegação');
    toggle.title = toggle.getAttribute('aria-label');
  }

  function setMobileMenu(open) {
    const wasOpen = sidebar.classList.contains('mobile-open');
    sidebar.classList.toggle('mobile-open', open);
    backdrop.classList.toggle('active', open);
    mobileButton.setAttribute('aria-expanded', String(open));
    updateInertState();
    enhanceNavigation();
    if (preferencesOpen() || modal.classList.contains('active')) return;
    if (open) sidebar.querySelector('.nav-link')?.focus();
    else if (wasOpen && mobile.matches) mobileButton.focus();
  }
  mobileButton.addEventListener('click', () => setMobileMenu(!sidebar.classList.contains('mobile-open')));
  backdrop.addEventListener('click', () => setMobileMenu(false));
  document.getElementById('sidebarToggle').addEventListener('click', () => {
    if (mobile.matches) setMobileMenu(false);
    requestAnimationFrame(enhanceNavigation);
  });
  document.getElementById('sidebarNav').addEventListener('click', event => {
    if (event.target.closest('a') && mobile.matches) setMobileMenu(false);
  });
  mobile.addEventListener('change', () => setMobileMenu(false));
  new MutationObserver(enhanceNavigation).observe(sidebar,{attributes:true,attributeFilter:['class']});
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
  function enhanceModal() {
    if (modal.classList.contains('active')) {
      if (!modalWasOpen) returnFocus = document.activeElement;
      const justOpened = !modalWasOpen;
      modalWasOpen = true;
      const heading = modal.querySelector('.modal-title');
      if (heading) { heading.id = 'activeModalTitle'; modal.setAttribute('aria-labelledby', heading.id); }
      modal.querySelector('.modal-close')?.setAttribute('aria-label', 'Fechar janela');
      updateInertState();
      // Ordinary updates must not move focus away from the field being edited.
      if (!preferencesOpen() && (justOpened || !modal.contains(document.activeElement))) {
        (focusable(modal)[0] || modalContent).focus();
      }
    } else if (modalWasOpen) {
      modalWasOpen = false;
      updateInertState();
      if (!preferencesOpen() && returnFocus?.isConnected && visible(returnFocus)) returnFocus.focus();
      returnFocus = null;
    }
  }
  new MutationObserver(enhanceModal).observe(modal,{attributes:true,attributeFilter:['class']});
  document.addEventListener('keydown', event => {
    // Escape and Tab belong to the native accessibility dialog while it is open.
    if (preferencesOpen()) return;
    if (event.key === 'Escape') {
      if (modal.classList.contains('active')) window.closeModal();
      else if (sidebar.classList.contains('mobile-open')) setMobileMenu(false);
      for (const [panelId, buttonId] of [['profileMenu','profileBtn'],['notifPanel','notificationBtn']]) {
        const panel = document.getElementById(panelId);
        const focusInside = panel.contains(document.activeElement);
        panel.classList.remove('active');
        if (focusInside && !modal.classList.contains('active')) document.getElementById(buttonId).focus();
      }
    }
    const scope = modal.classList.contains('active') ? modal : mobile.matches && sidebar.classList.contains('mobile-open') ? sidebar : null;
    if (scope && event.key === 'Tab') {
      const items = focusable(scope), first = items[0], last = items.at(-1);
      if (!items.length) { event.preventDefault(); (scope === modal ? modalContent : mobileButton).focus(); }
      else if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !scope) { event.preventDefault(); document.getElementById('globalSearch').focus(); }
    const target = event.target.closest('[role="button"][tabindex="0"]');
    if (target && !event.target.closest('input,select,textarea,button,a[href]') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); target.click(); }
  });
  const controlNames = {
    cliSearch:'Buscar clientes', cliType:'Filtrar clientes por tipo', cliStatus:'Filtrar clientes por status',
    proSearch:'Buscar processos', proArea:'Filtrar processos por área', proStatus:'Filtrar processos por status',
    dlFilter:'Filtrar prazos por situação', dlSearch:'Buscar prazos', agDate:'Data da agenda',
    finType:'Filtrar lançamentos por tipo', finStatus:'Filtrar lançamentos por status',
    audModule:'Filtrar auditoria por módulo', audAction:'Filtrar auditoria por ação', audActor:'Filtrar auditoria por autor',
    osStatus:'Filtrar investigações por status', osCategory:'Filtrar investigações por categoria', osOwner:'Filtrar investigações por responsável',
    f_linkProcess:'Processo para vincular o arquivo', radTipo:'Tipo de documento da consulta', radQuery:'Documento para consulta societária',
    apiSearch:'Buscar APIs', conhSearch:'Buscar referências de conhecimento', bioText:'Biografia do cliente',
    docKind:'Tipo de documento', docFile:'Arquivo do documento', fileInput:'Selecionar arquivos'
  };
  const iconNames = {'×':'Excluir item', '✕':'Fechar', '←':'Anterior', '→':'Próximo', '📋':'Copiar', '🗑':'Excluir item', '🗑️':'Excluir item'};
  const hasName = element => element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby') || element.labels?.length;
  function ensureId(element) {
    if (!element.id) {
      do { generatedId += 1; element.id = `interface-control-${generatedId}`; }
      while (document.querySelectorAll(`#${element.id}`).length > 1);
    }
    return element.id;
  }

  function enhanceElements(scope) {
    scope.querySelectorAll('.form-group').forEach(group => {
      const controls = group.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]),select,textarea');
      if (controls.length !== 1) return;
      const control = controls[0];
      const label = group.querySelector('label');
      if (label && !label.hasAttribute('for') && !label.control) label.htmlFor = ensureId(control);
      if (label?.textContent.includes('*') && !control.hasAttribute('aria-required')) control.setAttribute('aria-required', 'true');
      const help = group.querySelector(':scope > .text-muted');
      if (help && !control.hasAttribute('aria-describedby')) control.setAttribute('aria-describedby', ensureId(help));
    });
    scope.querySelectorAll('input,select,textarea').forEach(control => {
      if (hasName(control)) return;
      const name = controlNames[control.id] || control.getAttribute('placeholder');
      if (name) control.setAttribute('aria-label', name);
    });
    scope.querySelectorAll('button').forEach(button => {
      if (hasName(button)) return;
      const text = button.textContent.trim();
      const name = button.id === 'calPrev' ? 'Mês anterior' : button.id === 'calNext' ? 'Próximo mês' : iconNames[text];
      if (name) button.setAttribute('aria-label', name);
      else if (!/[\p{L}\p{N}]/u.test(text) && button.title) button.setAttribute('aria-label', button.title);
    });
    scope.querySelectorAll('[onclick]:not(button):not(a):not(input):not(select):not(textarea),.calendar-date[data-date],.notif-item[data-section]').forEach(element => {
      if (!element.querySelector('button,a,input,select,textarea')) { element.setAttribute('role','button'); element.tabIndex=0; }
    });
    scope.querySelectorAll('.calendar-date[data-date]').forEach(day => {
      const date = new Date(`${day.dataset.date}T12:00:00`);
      if (Number.isNaN(date.getTime())) return;
      const label = new Intl.DateTimeFormat('pt-BR', {dateStyle:'full'}).format(date);
      day.setAttribute('aria-label', `Ver dia: ${label}${day.title ? `. ${day.title}` : ''}`);
      if (day.classList.contains('today')) day.setAttribute('aria-current', 'date');
    });
    scope.querySelectorAll('thead th').forEach(header => {
      if (!header.hasAttribute('scope')) header.setAttribute('scope', 'col');
      if (!header.textContent.trim() && !hasName(header)) header.setAttribute('aria-label', 'Ações');
    });
    scope.querySelectorAll('tbody th:not([scope])').forEach(header => header.setAttribute('scope', 'row'));
    scope.querySelectorAll('.table-scroll,.panel').forEach(panel => {
      if (!panel.querySelector('table') || panel.matches('[role="button"]')) return;
      if (!panel.hasAttribute('tabindex')) panel.tabIndex = 0;
      if (!panel.hasAttribute('role')) panel.setAttribute('role', 'region');
      if (!hasName(panel)) panel.setAttribute('aria-label', 'Tabela de registros; use as setas para rolar');
    });
  }

  // Application handlers sometimes replace controls. Restore only the same
  // control in the same section, without interrupting focus on another field.
  function preserveReplacedControl(event) {
    const control = event.target.closest('input[id],select[id],textarea[id],button[id]');
    if (!control || (!content.contains(control) && !modalContent.contains(control))) return;
    const originalSection = navigation.querySelector('[aria-current="page"]')?.dataset.section;
    const originalModalOpen = modal.classList.contains('active');
    const start = typeof control.selectionStart === 'number' ? control.selectionStart : null;
    const end = typeof control.selectionEnd === 'number' ? control.selectionEnd : null;
    requestAnimationFrame(() => {
      if (control.isConnected || preferencesOpen() || originalModalOpen !== modal.classList.contains('active')) return;
      if (originalSection !== navigation.querySelector('[aria-current="page"]')?.dataset.section) return;
      const replacement = document.getElementById(control.id);
      if (!replacement || replacement.tagName !== control.tagName || !visible(replacement)) return;
      if (document.activeElement !== document.body && document.activeElement !== replacement) return;
      replacement.focus({preventScroll:true});
      if (start !== null && typeof replacement.setSelectionRange === 'function') replacement.setSelectionRange(start, end);
    });
  }
  for (const eventName of ['input','change','click']) document.addEventListener(eventName, preserveReplacedControl, true);
  document.addEventListener('click', event => {
    focusSectionRequested = event.detail === 0 && !!event.target.closest('a,button,[role="button"]');
    setTimeout(() => { focusSectionRequested = false; }, 0);
  }, true);

  function enhance() {
    enhanceElements(content);
    enhanceNavigation();
    if (content.querySelector('.page-title')?.textContent === 'Visão Geral' && !DB.clients.length && !DB.processes.length && !content.querySelector('.welcome-panel')) {
      const welcome = document.createElement('section');
      welcome.className = 'welcome-panel';
      welcome.innerHTML = '<div><span class="eyebrow">COMECE POR AQUI</span><h2>Seu espaço está pronto para começar</h2><p>Cadastre o primeiro cliente e organize os processos, prazos e documentos da sua organização.</p></div><button class="btn btn-primary" type="button">Cadastrar primeiro cliente →</button>';
      welcome.querySelector('button').addEventListener('click',()=>window.openClientForm());
      content.prepend(welcome);
    }
    document.getElementById('maskToggle').setAttribute('aria-pressed',String(SETTINGS.masked));
    const activeLink = navigation.querySelector('[aria-current="page"]');
    const section = activeLink?.dataset.section;
    if (section && section !== previousSection) {
      if (previousSection !== null) {
        sectionStatus.textContent = `Seção: ${activeLink.getAttribute('aria-label')}.`;
        if (focusSectionRequested) {
          const heading = content.querySelector('.page-title');
          requestAnimationFrame(() => {
            if (!heading?.isConnected || preferencesOpen() || modal.classList.contains('active')) return;
            if (document.activeElement.matches('input,select,textarea,[contenteditable="true"]')) return;
            heading.tabIndex = -1;
            heading.focus({preventScroll:true});
          });
        }
      }
      previousSection = section;
    }
  }
  let enhancementFrame = 0;
  function scheduleEnhancements() {
    if (enhancementFrame) return;
    enhancementFrame = requestAnimationFrame(() => {
      enhancementFrame = 0;
      enhanceElements(content);
      enhanceElements(modalContent);
      enhanceElements(document.getElementById('notifList'));
      enhanceNavigation();
      enhanceModal();
    });
  }
  const contentObserver = new MutationObserver(scheduleEnhancements);
  for (const element of [content,modalContent,navigation,document.getElementById('notifList')]) {
    contentObserver.observe(element, {childList:true,subtree:true});
  }
  document.addEventListener('semperfi:render',enhance);
  document.addEventListener('semperfi:ready',()=>{ updateInertState(); scheduleEnhancements(); });
})();
