/* Public account forms and authenticated entry. Secrets are never stored in browser storage. */
(() => {
  'use strict';
  const base = new URL('../../', document.currentScript.src);
  const isLogin = document.body.dataset.page === 'login';
  const status = document.getElementById('authStatus');
  const retry = document.getElementById('authRetry');
  const institutional = document.getElementById('institutionalLogin');
  const development = document.getElementById('developmentLogin');
  let capabilities = {}, busy = false, scriptsStarted = false;
  let pendingVerification = null, verificationTimer = null, expiresAt = 0, resendAt = 0;

  function announce(message, error = false) {
    status.textContent = message;
    status.classList.toggle('is-error', error);
    status.setAttribute('role', error ? 'alert' : 'status');
  }
  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(`/v1${path}`, {
        ...options, credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.timeout(15000)
      });
    } catch (_) { throw new Error('Não foi possível conectar ao serviço. Confira sua conexão e tente novamente.'); }
    if (!response.ok) {
      let payload;
      try { payload = await response.json(); } catch (_) { /* Gateway may return HTML. */ }
      const message = typeof payload?.detail === 'string' ? payload.detail
        : response.status === 422 ? (path === '/auth/verify' ? 'Informe um código válido com seis dígitos.' : 'Confira os campos informados. Use um e-mail válido e uma senha de 12 a 128 caracteres.')
        : response.status === 429 ? 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
        : response.status === 401 ? 'E-mail ou senha inválidos. Tente novamente.'
        : 'O serviço está indisponível no momento. Tente novamente.';
      const error = new Error(message); error.status = response.status; throw error;
    }
    return response.status === 204 ? null : response.json();
  }
  function rememberSection() {
    if (/^#[a-z]+$/.test(location.hash)) {
      try { sessionStorage.setItem('semperfi_return_section', location.hash); } catch (_) { /* Optional preference. */ }
    }
  }
  function enterWorkspace() {
    let hash = '#dashboard';
    try {
      const saved = sessionStorage.getItem('semperfi_return_section');
      if (/^#[a-z]+$/.test(saved || '')) hash = saved;
      sessionStorage.removeItem('semperfi_return_section');
    } catch (_) { /* Storage may be disabled. */ }
    location.replace(new URL(`index.html${hash}`, base).href);
  }
  function requireLogin() {
    rememberSection(); document.body.classList.add('auth-pending');
    location.replace(new URL('login.html', base).href);
  }
  window.SemperfiAuth = {
    requireLogin,
    async logout() {
      try {
        await request('/auth/logout', { method: 'POST' });
        document.body.classList.add('auth-pending');
        location.replace(new URL('login.html', base).href);
      } catch (error) { window.toast?.(error.message, 'error'); }
    }
  };
  function loadScript(path) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL(path, base).href; script.onload = resolve;
      script.onerror = () => reject(new Error('Não foi possível carregar a aplicação. Tente novamente.'));
      document.body.append(script);
    });
  }
  function refreshControls() {
    if (!isLogin) return;
    document.getElementById('passwordLogin').disabled = busy || !capabilities.password_enabled;
    document.getElementById('createAccount').disabled = busy || !capabilities.registration_enabled;
    institutional.disabled = busy || !capabilities.oidc_enabled;
    development.disabled = busy || !capabilities.development_enabled;
    document.querySelectorAll('[role="tab"], [data-access-tab]').forEach(button=>{ button.disabled=busy; });
    document.querySelectorAll('.account-type input').forEach(input=>{ input.disabled=busy; });
    updateRegistrationType();
    document.getElementById('verifyAccount').disabled = busy || !pendingVerification || pendingVerification.delivery_failed || Date.now() >= expiresAt;
    document.getElementById('resendCode').disabled = busy || !pendingVerification || Date.now() >= expiresAt || Date.now() < resendAt;
    document.getElementById('cancelVerification').disabled = busy;
  }
  function focusDestination(target, section = target) {
    target.focus({preventScroll:true});
    section.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  }
  function updateRegistrationType() {
    const corporate = document.querySelector('[name="register_account_type"]:checked').value === 'PJ';
    document.getElementById('registerOrganizationGroup').hidden = !corporate;
    const organization = document.getElementById('registerOrganization');
    organization.required = corporate; organization.disabled = !corporate || busy;
    document.getElementById('registerNameLabel').textContent = corporate ? 'Nome completo do responsável' : 'Nome completo';
    document.getElementById('registrationContext').textContent = corporate
      ? 'O espaço da pessoa jurídica será criado após confirmar o código enviado ao e-mail do responsável.'
      : 'Sua conta individual será criada após confirmar o código enviado ao seu e-mail.';
  }
  function renderAccessPanels() {
    const register = document.getElementById('registerTab').getAttribute('aria-selected') === 'true';
    document.querySelector('.auth-tabs').hidden = !!pendingVerification;
    document.getElementById('verificationPanel').hidden = !pendingVerification;
    document.getElementById('loginPanel').hidden = !!pendingVerification || register;
    document.getElementById('registerPanel').hidden = !!pendingVerification || !register;
    document.getElementById('developmentAccess').hidden = !!pendingVerification || !capabilities.development_enabled;
    document.getElementById('oidcAccess').hidden = !capabilities.oidc_enabled;
    document.getElementById('registerForm').hidden = !capabilities.registration_enabled;
    document.getElementById('registrationUnavailable').hidden = !!capabilities.registration_enabled;
    document.getElementById('loginForm').hidden = !capabilities.password_enabled;
  }
  function tickVerification() {
    if (!pendingVerification) return;
    const remaining = Math.max(0,Math.ceil((expiresAt-Date.now())/1000));
    const wait = Math.max(0,Math.ceil((resendAt-Date.now())/1000));
    document.getElementById('verificationHelp').textContent = remaining
      ? `Código válido por ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}.`
      : 'O código expirou. Inicie novamente para confirmar seus dados e receber outro código.';
    document.getElementById('resendCode').textContent = wait ? `Reenviar em ${wait}s` : 'Reenviar código';
    document.getElementById('cancelVerification').textContent = remaining ? 'Usar outros dados' : 'Iniciar novamente';
    refreshControls();
  }
  function showVerification(pending, focus = true) {
    clearInterval(verificationTimer);
    pendingVerification = pending;
    expiresAt = Date.now()+Math.max(0,Number(pending.expires_in)||0)*1000;
    resendAt = Date.now()+Math.max(0,Number(pending.resend_after)||0)*1000;
    document.getElementById('verificationForm').reset();
    document.getElementById('verificationDestination').textContent = `Digite o código enviado ${pending.channel === 'sms' ? 'por SMS para' : 'para o e-mail'} ${pending.masked_destination}.`;
    document.getElementById('access-heading').textContent = pending.purpose === 'register' ? 'Confirme seu cadastro' : 'Confirme seu acesso';
    document.getElementById('accessDescription').textContent = 'Sua segurança em mais uma etapa.';
    document.title = 'Verificar acesso · SEMPER-FI';
    renderAccessPanels(); tickVerification();
    verificationTimer = setInterval(tickVerification,1000);
    announce(pending.delivery_failed ? 'O último envio falhou. Aguarde o intervalo e reenvie o código.' : 'Aguardando seu código de verificação.', !!pending.delivery_failed);
    if (focus) focusDestination(document.getElementById('verificationCode'),document.getElementById('account-access'));
  }
  async function cancelPending() {
    if (busy) return false;
    if (!pendingVerification) return true;
    busy = true; refreshControls();
    try {
      await request('/auth/cancel',{method:'POST'});
      clearInterval(verificationTimer); pendingVerification = null;
      document.getElementById('verificationForm').reset(); renderAccessPanels();
      return true;
    } catch (error) { announce(error.message,true); return false; }
    finally { busy = false; refreshControls(); }
  }
  async function checkAccess() {
    if (scriptsStarted) { location.reload(); return; }
    retry.hidden = true; capabilities = {}; refreshControls();
    announce('Verificando as opções de acesso…');
    try {
      capabilities = await request('/auth/status');
      if (capabilities.authenticated) {
        if (isLogin) return enterWorkspace();
        window.SEMPERFI_OSINT_CONFIG = {mode:'production',apiBaseUrl:'/v1',enableMockData:false};
        const catalog = await fetch(new URL('data/sources.json', base), {signal:AbortSignal.timeout(15000)});
        if (!catalog.ok) throw new Error('Não foi possível carregar o catálogo de fontes.');
        window.SEMPERFI_SOURCE_CATALOG = await catalog.json();
        scriptsStarted = true;
        await loadScript('assets/js/interface.js'); await loadScript('assets/js/app.js');
        return;
      }
      if (!isLogin) return requireLogin();
      if (capabilities.pending_verification) { showVerification(capabilities.pending_verification); return; }
      clearInterval(verificationTimer); pendingVerification = null;
      renderAccessPanels();
      refreshControls();
      announce(capabilities.password_enabled ? 'Entre com seu e-mail e senha.' : capabilities.oidc_enabled
        ? 'Entre pelo provedor da sua organização.' : 'O acesso por conta ainda não está disponível. Procure o administrador.');
    } catch (error) {
      announce(error.message, true); retry.hidden = false;
      if (isLogin) {
        capabilities = {}; refreshControls();
        document.getElementById('developmentAccess').hidden = true;
        document.getElementById('oidcAccess').hidden = true;
      }
    }
  }
  function switchTab(register) {
    if (busy || pendingVerification) return;
    for (const [id, active] of [['login',!register],['register',register]]) {
      const tab = document.getElementById(`${id}Tab`);
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex=active?0:-1;
      document.getElementById(`${id}Panel`).hidden = !active;
    }
    document.getElementById('access-heading').textContent = register ? 'Crie sua conta' : 'Bem-vindo de volta';
    document.getElementById('accessDescription').textContent = register ? 'Um espaço para sua atuação individual ou seu escritório.' : 'Acesse sua conta para continuar de onde parou.';
    document.title = `${register ? 'Criar conta' : 'Entrar'} · SEMPER-FI`;
    if (register) announce(capabilities.registration_enabled ? 'Preencha seus dados para começar.' : capabilities.registration_enabled === false ? 'Novos cadastros estão fechados. Solicite acesso ao administrador.' : 'Verifique a conexão para consultar as opções de cadastro.');
    else announce(capabilities.password_enabled ? 'Entre com seu e-mail e senha.' : capabilities.oidc_enabled
      ? 'Entre pelo provedor da sua organização.' : 'O acesso por conta ainda não está disponível. Procure o administrador.');
  }
  async function submitAccount(form, path, payload) {
    if (busy || pendingVerification || !form.reportValidity()) return;
    busy = true; refreshControls(); form.setAttribute('aria-busy','true');
    announce(path === '/auth/register' ? 'Preparando a verificação do cadastro…' : 'Validando seus dados de acesso…');
    try {
      const result = await request(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if (!result.verification_required || !result.pending_verification) throw new Error('Não foi possível iniciar a verificação. Tente novamente.');
      for (const id of ['loginPassword','registerPassword','registerConfirmation']) document.getElementById(id).value='';
      document.getElementById('registerConfirmation').setCustomValidity('');
      showVerification(result.pending_verification);
    } catch (error) { announce(error.message, true); }
    finally { busy=false; form.removeAttribute('aria-busy'); refreshControls(); }
  }
  if (isLogin) {
    document.querySelectorAll('[data-access-tab]').forEach(button=>button.addEventListener('click',async()=>{
      if (!await cancelPending()) return;
      const register = button.dataset.accessTab === 'register';
      switchTab(register);
      focusDestination(document.getElementById(register?'registerTab':'loginTab'),document.getElementById('account-access'));
    }));
    document.querySelectorAll('a[href="#login-top"]').forEach(link=>link.addEventListener('click',event=>{
      event.preventDefault();
      document.getElementById('login-top').focus({preventScroll:true});
      window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
    }));
    document.querySelectorAll('[name="register_account_type"]').forEach(input=>input.addEventListener('change',updateRegistrationType));
    document.querySelector('[data-access-help]').addEventListener('click',event=>{
      event.preventDefault();
      const help = document.getElementById('access-help');
      help.open = true;
      focusDestination(help.querySelector('summary'),help);
    });
    document.getElementById('loginTab').addEventListener('click',()=>switchTab(false));
    document.getElementById('registerTab').addEventListener('click',()=>switchTab(true));
    document.querySelector('.auth-tabs').addEventListener('keydown',event=>{
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || busy) return;
      event.preventDefault();
      const register = event.key === 'End' || (event.key !== 'Home' && document.getElementById('loginTab').getAttribute('aria-selected') === 'true');
      switchTab(register); document.getElementById(register?'registerTab':'loginTab').focus();
    });
    document.querySelectorAll('[data-password]').forEach(button=>button.addEventListener('click',()=>{
      const input = document.getElementById(button.dataset.password), visible = input.type === 'password';
      input.type=visible?'text':'password'; button.textContent=visible?'Ocultar':'Mostrar';
      button.setAttribute('aria-pressed',String(visible)); button.setAttribute('aria-label',visible?'Ocultar senha':'Mostrar senha');
    }));
    document.getElementById('loginForm').addEventListener('submit',event=>{
      event.preventDefault();
      if (!capabilities.password_enabled) return;
      submitAccount(event.currentTarget,'/auth/login',{email:document.getElementById('loginEmail').value.trim(),password:document.getElementById('loginPassword').value,account_type:document.querySelector('[name="login_account_type"]:checked').value});
    });
    const confirmation = document.getElementById('registerConfirmation');
    const validateConfirmation = () => confirmation.setCustomValidity(confirmation.value && confirmation.value !== document.getElementById('registerPassword').value ? 'As senhas precisam ser iguais.' : '');
    confirmation.addEventListener('input',validateConfirmation);
    document.getElementById('registerPassword').addEventListener('input',validateConfirmation);
    document.getElementById('registerForm').addEventListener('submit',event=>{
      event.preventDefault(); validateConfirmation();
      if (!capabilities.registration_enabled) return;
      submitAccount(event.currentTarget,'/auth/register',{
        account_type:document.querySelector('[name="register_account_type"]:checked').value,
        display_name:document.getElementById('registerName').value.trim(),
        organization_name:document.querySelector('[name="register_account_type"]:checked').value === 'PJ' ? document.getElementById('registerOrganization').value.trim() : undefined,
        email:document.getElementById('registerEmail').value.trim(),password:document.getElementById('registerPassword').value
      });
    });
    document.getElementById('verificationForm').addEventListener('submit',async event=>{
      event.preventDefault();
      const form = event.currentTarget;
      if (busy || !pendingVerification || !form.reportValidity()) return;
      busy=true; refreshControls(); form.setAttribute('aria-busy','true'); announce('Confirmando seu código…');
      try {
        const result = await request('/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:document.getElementById('verificationCode').value.trim()})});
        if (!result.authenticated) throw new Error('Não foi possível confirmar o acesso. Tente novamente.');
        clearInterval(verificationTimer); form.reset(); enterWorkspace();
      } catch (error) { announce(error.message,true); }
      finally { busy=false; form.removeAttribute('aria-busy'); refreshControls(); }
    });
    document.getElementById('resendCode').addEventListener('click',async()=>{
      if (busy || !pendingVerification || Date.now()>=expiresAt || Date.now()<resendAt) return;
      busy=true; refreshControls(); announce('Enviando um novo código…');
      try {
        const result = await request('/auth/resend',{method:'POST'});
        if (!result.pending_verification) throw new Error('Inicie novamente o acesso para receber outro código.');
        showVerification(result.pending_verification);
      } catch (error) { announce(error.message,true); }
      finally { busy=false; refreshControls(); }
    });
    document.getElementById('cancelVerification').addEventListener('click',async()=>{
      const register = pendingVerification?.purpose === 'register';
      if (!await cancelPending()) return;
      switchTab(register); focusDestination(document.getElementById(register?'registerTab':'loginTab'),document.getElementById('account-access'));
    });
    institutional.addEventListener('click',()=>{
      busy=true; refreshControls(); announce('Redirecionando para o acesso institucional…');
      location.assign('/v1/auth/oidc/login');
    });
    development.addEventListener('click',async()=>{
      busy=true; refreshControls(); announce('Iniciando sessão técnica…');
      try { await request('/auth/session',{method:'POST'}); enterWorkspace(); }
      catch(error) { announce(error.message,true); busy=false; refreshControls(); }
    });
  }
  retry.addEventListener('click',checkAccess);
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  checkAccess();
})();
