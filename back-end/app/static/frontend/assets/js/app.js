/* ============================================================
   SEMPER-FI — Central Jurídica Operacional
   Sistema de gestão jurídica com sessão autenticada
   Persistência operacional: API /v1 | Preferências visuais: localStorage
   ============================================================ */

const STORAGE_KEY = 'semperfi_db_v1';
const SETTINGS_KEY = 'semperfi_settings_v1';

// Calendário visual: dias da semana; feriados do juízo são informados nas calculadoras.
const isWeekend = d => d.getDay()===0 || d.getDay()===6;

function toISO(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fromISO(s){ const [y,m,dd]=s.split('-').map(Number); return new Date(y, m-1, dd); }
function fmtDate(s){ if(!s) return '—'; const d=typeof s==='string'?fromISO(s):s; return d.toLocaleDateString('pt-BR'); }
function fmtDateTime(s){ if(!s) return '—'; const d=new Date(s); return d.toLocaleString('pt-BR'); }
function fmtMoney(v){ return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v||0); }
function uid(prefix='id'){ return prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7); }
function daysBetween(a,b){ const ms=fromISO(b)-fromISO(a); return Math.round(ms/86400000); }

function addCalendarDays(start, n){
  const d = new Date(start); d.setDate(d.getDate()+n);
  return d;
}

// ---------- Storage ----------
function isBackendMode(){ return true; }
function loadDB(){ return createEmptyDB(); }
function saveDB(){ /* Operational records are persisted through /v1 only. */ }
function loadSettings(){
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {masked:saved.masked !== false,sidebarCollapsed:saved.sidebarCollapsed === true};
  } catch (_) { return {masked:true,sidebarCollapsed:false}; }
}
function saveSettings(){
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({masked:SETTINGS.masked,sidebarCollapsed:SETTINGS.sidebarCollapsed})); }
  catch (_) { /* The workspace also works with browser storage disabled. */ }
}

function createEmptyDB(){
  return {
    clients:[],
    processes:[],
    deadlines:[],
    appointments:[],
    intimations:[],
    financial:[],
    files:[],
    audit:[],
    processMovements:[],
    investigations:[],
    osintEntities:[],
    osintRuns:[],
    osintFindings:[],
    osintRelations:[],
    evidence:[],
    evidenceEvents:[],
    addons:[],
    billingLedger:[],
    usageEvents:[],
    enrichedQueries:[],
    sourceCatalog: window.SEMPERFI_SOURCE_CATALOG || [],
    subscription:{planKey:null,status:'nao_configurada',assignedUsers:[]},
    entitlements:{}, usage:{},
    creditWallet:{includedMonthlyTotal:0,includedMonthlyUsed:0,purchasedBalance:0,purchasedUsed:0,totalAvailable:0},
    diligenceWallet:{balance:0,totalRecharged:0,totalSpent:0,pendingCommitted:0}
  };
}

let DB = loadDB();
let SETTINGS = loadSettings();

// ENTITLEMENTS
const BILLING_VISIBLE_ROLES = new Set(['administrador','financeiro','advogado','investigador','auditor']);

function normalizeProfileRole(profile=''){
  const raw = String(profile || '').toLowerCase();
  if (raw.includes('admin')) return 'administrador';
  if (raw.includes('financ')) return 'financeiro';
  if (raw.includes('audit')) return 'auditor';
  if (raw.includes('invest')) return 'investigador';
  if (raw.includes('client') || raw.includes('cliente')) return 'cliente';
  if (raw.includes('assist')) return 'assistente';
  return 'advogado';
}
function currentUserRole(){ return normalizeProfileRole(SETTINGS.userProfile || 'Advogado'); }
function canViewBilling(){ return BILLING_VISIBLE_ROLES.has(currentUserRole()); }
function canEditLegalRecords(){ return String(SETTINGS.userProfile||'').split(',').some(role=>['administrator','manager','lawyer','investigator','analyst'].includes(role.trim())); }

function formatBytes(bytes){
  if (bytes == null || !Number.isFinite(bytes)) return 'Personalizado';
  const units = ['B','KB','MB','GB','TB'];
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1){ value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? value.toFixed(unit === 0 ? 0 : 1) : value.toFixed(2)} ${units[unit]}`;
}
function formatPercent(value){ return `${Math.max(0, Math.round(value || 0))}%`; }

function getEvidencePayloadBytes(){
  const encoder = new TextEncoder();
  return (DB.evidence || []).reduce((sum, item) => sum + encoder.encode(item.rawPayloadReference || '').length, 0);
}

function computeUsageSnapshot(){
  return {
    storedProcesses: (DB.processes || []).length,
    monitoredProcesses: (DB.processes || []).filter(process => process.monitoringEnabled === true && process.status !== 'arquivado').length,
    evidenceBytes: (DB.files || []).reduce((sum, file) => sum + (file.size || 0), 0) + getEvidencePayloadBytes(),
    seatsUsed: Math.max((DB.subscription?.assignedUsers || []).length || 0, 1)
  };
}
function getIncludedCreditsRemaining(){
  const total = DB.creditWallet?.includedMonthlyTotal;
  if (total == null) return Number.POSITIVE_INFINITY;
  return Math.max((total || 0) - (DB.creditWallet?.includedMonthlyUsed || 0), 0);
}
function getPurchasedCreditsRemaining(){ return Math.max(DB.creditWallet?.purchasedBalance || 0, 0); }
function getAvailableCredits(){
  const included = getIncludedCreditsRemaining();
  if (!Number.isFinite(included)) return Number.POSITIVE_INFINITY;
  return included + getPurchasedCreditsRemaining();
}

function getUsageStatusClass(percent){
  if (percent >= 95) return 'critical';
  if (percent >= 80) return 'warn';
  return '';
}
function getUsageStateLabel(percent){
  if (percent >= 100) return 'Limite atingido';
  if (percent >= 95) return 'Crítico';
  if (percent >= 80) return 'Atenção';
  return 'Normal';
}
function isSubscriptionRestricted(){
  return ['expirada','vencida','suspensa','cancelada'].includes(String(DB.subscription?.status || '').toLowerCase());
}
function syncCommercialState(){
  DB.usage = computeUsageSnapshot();
  DB.entitlements = {storedProcesses:null,monitoredProcesses:null,evidenceBytes:null,users:null,monthlyCredits:0};
  return DB;
}

function renderTopbarMeters(){
  const meters = document.getElementById('topbarMeters');
  meters.innerHTML = canViewBilling()
    ? '<button class="btn btn-secondary commercial-shortcut" type="button" aria-label="Consultar planos e consumo">💳 Plano &amp; Consumo</button>'
    : '<span class="workspace-state">Dados da organização</span>';
  meters.querySelector('button')?.addEventListener('click', () => navigateSection('billing'));
}
function renderSubscriptionBanner(){ return ''; }
function openUpgradePrompt(title, description, actionHint=''){
  openModal({
    title,
    body: `
      <div class="alert alert-warning"><span>⚠</span><span>${escapeHTML(description)}</span></div>
      <div class="billing-note">${escapeHTML(actionHint || 'Consulte o administrador sobre a capacidade disponível para esta operação.')}</div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal()">Fechar</button>
      <button class="btn btn-secondary" onclick="closeModal();navigateSection('billing')">Plano &amp; Consumo</button>

    `
  });
}
function ensureSubscriptionActive(message){
  if (!isSubscriptionRestricted()) return true;
  toast(message || 'Assinatura em modo leitura. Regularize para executar novas operações.','warning');
  navigateSection('billing');
  return false;
}

// CREDITS
// DILIGENCE WALLET
// USAGE METERING
syncCommercialState({persist:false});

// ---------- OSINT migration (adiciona coleções a DBs antigos) ----------
['investigations','osintEntities','osintRuns','osintFindings','osintRelations','evidence','evidenceEvents','sourceCatalog','processMovements'].forEach(k => {
  if (!DB[k]) DB[k] = (k === 'sourceCatalog') ? createEmptyDB().sourceCatalog : [];
});
syncCommercialState({persist:true});

// ---------- Config global OSINT ----------
window.SEMPERFI_OSINT_CONFIG = {mode:'production',apiBaseUrl:'/v1',enableMockData:false};

const backendState = { sessionReady:false, bootstrapLoaded:false, bootstrapPromise:null };

function backendUrl(path){
  const base = (window.SEMPERFI_OSINT_CONFIG.apiBaseUrl || '/v1').replace(/\/$/,'');
  return `${base}${path}`;
}
function apiErrorMessage(err){
  const fallback = 'Não foi possível concluir a operação. Tente novamente; se o problema continuar, procure o administrador.';
  if (!err) return fallback;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'A resposta demorou mais que o esperado. Confira o registro antes de tentar novamente.';
  if (Array.isArray(err.detail)) {
    const fields = {name:'Nome',document:'Documento',email:'E-mail',phone:'Telefone',client_id:'Cliente',clientId:'Cliente',process_id:'Processo',processId:'Processo',number:'Número do processo',title:'Título',amount:'Valor',claim_value:'Valor da causa',value:'Valor',due_date:'Vencimento',appointment_date:'Data do compromisso',received_at:'Data de recebimento',entry_date:'Data do lançamento',date:'Data',content:'Conteúdo',description:'Descrição',purpose:'Finalidade',legal_basis:'Base legal',authorization_reference:'Autorização',id:'Referência do registro'};
    return [...new Set(err.detail.map(item => {
      const field = fields[(item.loc || []).at(-1)] || 'Dados informados';
      const message = item.type === 'missing' ? 'preenchimento obrigatório' : item.type === 'string_too_short' ? 'texto muito curto' : item.type === 'string_too_long' ? 'texto acima do tamanho permitido' : 'verifique o valor informado';
      return `${field}: ${message}.`;
    }))].join(' ');
  }
  const message = typeof err === 'string' ? err : err.detail?.reason || (typeof err.detail === 'string' ? err.detail : err.message);
  if (!message || /(?:Traceback|SQLAlchemy|IntegrityError|asyncpg|sqlite|\bSELECT\b|\bINSERT\b|\/v1\/|https?:\/\/|[A-Z]{2,}_[A-Z_]{2,}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9-]{20,}|\$aact_|Failed to fetch|NetworkError)/i.test(message)) return fallback;
  return message;
}
function mapApiRisk(value){ return ({baixo:'low', medio:'medium', alto:'high'})[value] || value; }
function mapApiEntityType(value){
  return ({
    pessoa_fisica:'person', pessoa_juridica:'company', processo:'process',
    dominio:'domain', endereco:'address', telefone:'phone', banco:'bank',
    documento:'document', pagina_web:'web_page', municipio:'municipality'
  })[value] || value;
}
function mapApiDeadlineStatus(value){ return ({pendente:'pending', concluido:'completed'})[value] || value; }
function mapApiAppointmentStatus(value){ return ({confirmado:'confirmed', pendente:'pending', concluido:'completed', cancelado:'cancelled'})[value] || value; }
function mapApiIntimationStatus(value){ return ({recebida:'received', triagem:'triage', associada:'associated', concluida:'concluded'})[value] || value; }
function mapApiFinancialType(value){ return ({receita:'revenue', despesa:'expense'})[value] || value; }
function mapFrontendClientStatus(value){ return ({active:'ativo', pending:'atencao', inactive:'inativo'})[value] || value; }
function mapFrontendDeadlineStatus(value){ return ({pending:'pendente', completed:'concluido'})[value] || value; }
function mapFrontendIntimationStatus(value){ return ({received:'recebida', triage:'triagem', associated:'associada', concluded:'concluida'})[value] || value; }
function mapFrontendEvidenceStatus(value){ return ({pending:'pendente', validated:'validada', preserved:'validada', integrity_failed:'falha_integridade'})[value] || value; }
function looksLikeUuid(value){ return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value||'')); }

async function ensureBackendSession(){
  if (backendState.sessionReady) return;
  const response = await fetch(backendUrl('/auth/status'), {credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(12000)});
  if (!response.ok) throw new Error('Não foi possível verificar a sessão.');
  const status = await response.json();
  if (!status.authenticated) { window.SemperfiAuth.requireLogin(); throw new Error('Entre novamente para continuar.'); }
  backendState.sessionReady = true;
}
async function backendApi(path, options = {}){
  await ensureBackendSession();
  const headers = { ...(options.headers || {}) };
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (!isForm && options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(backendUrl(path), { credentials:'include', signal:AbortSignal.timeout(30000), ...options, headers });
  if (res.status === 401) { backendState.sessionReady = false; window.SemperfiAuth.requireLogin(); throw new Error('Sua sessão expirou.'); }
  if (!res.ok){
    let payload = null;
    try { payload = await res.json(); } catch(e){ payload = { message:`HTTP ${res.status}` }; }
    throw Object.assign(payload && typeof payload === 'object' ? payload : {message:'A operação não pôde ser concluída.'}, {status:res.status});
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
function mergeBootstrapData(payload){
  const base = createEmptyDB();
  const preserved = {
    files: DB.files || [],
    subscription: DB.subscription || base.subscription,
    addons: DB.addons || base.addons,
    entitlements: DB.entitlements || base.entitlements,
    usage: DB.usage || base.usage,
    creditWallet: DB.creditWallet || base.creditWallet,
    diligenceWallet: DB.diligenceWallet || base.diligenceWallet,
    billingLedger: DB.billingLedger || base.billingLedger,
    usageEvents: DB.usageEvents || base.usageEvents,
    enrichedQueries: DB.enrichedQueries || base.enrichedQueries
  };
  DB = {
    ...base,
    ...payload.data,
    ...preserved,
    sourceCatalog: (DB.sourceCatalog && DB.sourceCatalog.length) ? DB.sourceCatalog : base.sourceCatalog
  };
  SETTINGS.userName = payload.me.display_name;
  SETTINGS.userEmail = payload.me.email;
  SETTINGS.userProfile = (payload.me.roles || []).join(', ') || SETTINGS.userProfile;
  syncCommercialState({persist:false});
}
async function hydrateFromBackend(){
  if (!isBackendMode()) return;
  if (!backendState.bootstrapPromise){
    backendState.bootstrapPromise = (async () => {
      const payload = await backendApi('/frontend/bootstrap');
      mergeBootstrapData(payload);
      backendState.bootstrapLoaded = true;
    })();
  }
  return backendState.bootstrapPromise;
}
async function refreshBackendBootstrap(){
  if (!isBackendMode()) return;
  backendState.bootstrapPromise = null;
  backendState.bootstrapLoaded = false;
  await hydrateFromBackend();
}

async function persistClient(data, id=''){
  const body = { kind:data.type, name:data.name, document:data.document, email:data.email || null, phone:data.phone || null, address:data.address || null, responsible:data.responsible || null, status:data.status, notes:data.notes || null };
  if (id) await backendApi(`/clients/${id}`, { method:'PATCH', body: JSON.stringify(body) });
  else id = (await backendApi('/clients', { method:'POST', body: JSON.stringify(body) })).id;
  const detail = await backendApi(`/clients/${id}`);
  return { id:String(detail.id), name:detail.name, type:detail.kind, document:detail.document || '', responsible:detail.responsible || '', email:detail.email || '', phone:detail.phone || '', address:detail.address || '', notes:detail.notes || '', status:mapFrontendClientStatus(detail.status || data.status), createdAt:(dbGet('clients', String(detail.id))?.createdAt || Date.now()) };
}
async function persistProcess(data, id=''){
  const body = { client_id:data.clientId, number:data.number, court:data.court || null, area:data.area || null, phase:data.phase || null, status:data.status, responsible:data.responsible || null, claim_value:data.value || null, notes:data.notes || null };
  const saved = id ? (await backendApi(`/processes/${id}`, { method:'PATCH', body: JSON.stringify(body) }), { id }) : await backendApi('/processes', { method:'POST', body: JSON.stringify(body) });
  return { ...data, id:String(saved.id || id), createdAt:(dbGet('processes', String(saved.id || id))?.createdAt || Date.now()) };
}
async function persistDeadline(data, id=''){
  const body = { process_id:data.processId, title:data.title, due_date:data.date, deadline_type:data.type, responsible:data.responsible || null, status:mapApiDeadlineStatus(data.status), notes:data.notes || null };
  const saved = id ? await backendApi(`/deadlines/${id}`, { method:'PATCH', body: JSON.stringify(body) }) : await backendApi('/deadlines', { method:'POST', body: JSON.stringify(body) });
  return { ...data, id:String(saved.id || id), status:mapFrontendDeadlineStatus(saved.status || data.status), createdAt:(dbGet('deadlines', String(saved.id || id))?.createdAt || Date.now()) };
}
async function persistAppointment(data, id=''){
  const body = { title:data.title, appointment_date:data.date, appointment_time:data.time || null, appointment_type:data.type, client_id:data.clientId || null, process_id:data.processId || null, status:mapApiAppointmentStatus(data.status), location:data.location || null, notes:data.notes || null };
  const saved = id ? await backendApi(`/appointments/${id}`, { method:'PATCH', body: JSON.stringify(body) }) : await backendApi('/appointments', { method:'POST', body: JSON.stringify(body) });
  return { ...data, id:String(saved.id || id), createdAt:(dbGet('appointments', String(saved.id || id))?.createdAt || Date.now()) };
}
async function persistIntimation(data, id=''){
  const body = { source:data.source, intimation_type:data.type, process_id:data.processId || null, received_at:new Date(data.receivedAt).toISOString(), confidence:({alta:'high', media:'medium', baixa:'low'})[data.confidence] || data.confidence, status:mapApiIntimationStatus(data.status), content:data.content };
  const saved = id ? await backendApi(`/intimations/${id}`, { method:'PATCH', body: JSON.stringify(body) }) : await backendApi('/intimations', { method:'POST', body: JSON.stringify(body) });
  return { ...data, id:String(saved.id || id), status:mapFrontendIntimationStatus(saved.status || data.status), createdAt:(dbGet('intimations', String(saved.id || id))?.createdAt || Date.now()) };
}
async function persistFinancial(data, id=''){
  const body = { entry_date:data.date, entry_type:mapApiFinancialType(data.type), description:data.description, amount:data.amount, status:data.status, category:data.category || null, client_id:data.clientId || null, process_id:data.processId || null };
  const saved = id ? await backendApi(`/financial-entries/${id}`, { method:'PATCH', body: JSON.stringify(body) }) : await backendApi('/financial-entries', { method:'POST', body: JSON.stringify(body) });
  return { ...data, id:String(saved.id || id), createdAt:(dbGet('financial', String(saved.id || id))?.createdAt || Date.now()) };
}
async function persistMovement(processId, data, id=''){
  const body = { occurred_on:data.date, movement_type:data.type, description:data.description, source:data.source || 'manual', payload:data.payload || {} };
  const saved = id ? await backendApi(`/process-movements/${id}`, { method:'PATCH', body: JSON.stringify(body) }) : await backendApi(`/processes/${processId}/movements`, { method:'POST', body: JSON.stringify(body) });
  return { ...data, id:String(saved.id || id), processId, createdAt:(dbGet('processMovements', String(saved.id || id))?.createdAt || Date.now()), attachments:[] };
}
// Receipts only, retained for this session so a failed finalization reuses its upload.
const evidenceTransfers = new Map();
async function createBackendEvidenceRecord({ investigationId, sourceName, sourceType='manual_upload', sourceUrl='', collectionMethod='manual_upload', content, filename='evidence.txt', mimeType='text/plain', findingId=null, autoAttest=false, existingEvidenceId=null }){
  const serializedContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const key = await sha256Hex(JSON.stringify([investigationId,sourceName,sourceType,sourceUrl,collectionMethod,mimeType,findingId,serializedContent]));
  const transfer = evidenceTransfers.get(key) || {};
  evidenceTransfers.set(key, transfer);
  if (transfer.job) return transfer.job;
  if (existingEvidenceId && !transfer.evidenceId) { transfer.evidenceId=String(existingEvidenceId); transfer.uploadUncertain=false; }
  if (transfer.uploadUncertain) throw new Error('O recebimento do arquivo ainda não foi confirmado. Confira a aba Arquivos antes de enviar novamente.');
  transfer.job = (async () => {
  const form = new FormData();
  form.append('file', new File([serializedContent], filename, { type:mimeType }));
  if (investigationId) form.append('investigation_id', investigationId);
  form.append('purpose', 'Preservacao de evidencia com cadeia de custodia no fluxo SEMPER-FI');
  form.append('legal_basis', 'legitimo_interesse');
  form.append('authorization_reference', 'Fluxo autenticado da interface SEMPER-FI');
  form.append('collection_method', collectionMethod);
  form.append('source_name', sourceName || filename);
  form.append('source_type', sourceType || 'manual_upload');
  form.append('payload_preview', serializedContent.slice(0, 2000));
  if (sourceUrl) form.append('source_url', sourceUrl);

  if (!transfer.evidenceId) {
    try {
      const created = await backendApi('/evidences/uploads', { method:'POST', body: form });
      if (!created?.evidence_id) throw new Error('Não foi possível confirmar o recebimento do arquivo.');
      transfer.evidenceId = String(created.evidence_id);
    } catch (error) {
      // A lost response can hide a successful POST. Do not submit a duplicate blindly.
      transfer.uploadUncertain = !error?.status || error.status >= 500;
      throw error;
    }
  }
  let warning = '';
  let preserved = false;
  try {
    const finalized = await backendApi(`/evidences/${transfer.evidenceId}/finalize`, { method:'POST' });
    preserved = ['preserved','validated'].includes(finalized?.status);
    if (!preserved) throw new Error('O cofre ainda não confirmou a preservação do arquivo.');
  } catch(err){
    warning = apiErrorMessage(err);
  }
  if (autoAttest && preserved){
    try {
      await backendApi(`/evidences/${transfer.evidenceId}/attest`, { method:'POST' });
    } catch(err){
      warning = warning || apiErrorMessage(err);
    }
  }
  if (findingId){
    try { await backendApi(`/findings/${findingId}`, {
      method:'PATCH',
      body: JSON.stringify({ evidence_id: transfer.evidenceId, ...(preserved ? {classification:'achado'} : {}) })
    }); } catch (err) { warning = warning || apiErrorMessage(err); }
  }
  try { await refreshBackendBootstrap(); } catch (_) { warning = warning || 'Atualize a lista de arquivos para conferir o registro.'; }
  return { evidenceId:transfer.evidenceId, preserved, warning };
  })();
  try { return await transfer.job; } finally { transfer.job = null; }
}

// ---------- Audit ----------
function audit(){ /* Audit events are created by authenticated backend operations. */ }

// ---------- CRUD genéricos ----------
function dbCreate(collection, item){
  if (!item.id) item.id = uid(collection.slice(0,3));
  if (!item.createdAt) item.createdAt = Date.now();
  DB[collection].push(item);
  saveDB();
  audit(collection, 'criacao', item.id);
  return item;
}
function dbUpdate(collection, id, patch){
  const i = DB[collection].findIndex(x=>x.id===id);
  if (i>=0){
    DB[collection][i] = {...DB[collection][i], ...patch, updatedAt:Date.now()};
    saveDB();
    audit(collection, 'edicao', id);
    return DB[collection][i];
  }
}
function dbDelete(collection, id){
  const i = DB[collection].findIndex(x=>x.id===id);
  if (i>=0){
    const removed = DB[collection].splice(i,1)[0];
    saveDB();
    audit(collection, 'exclusao', id, 'sucesso');
    return removed;
  }
}
function dbGet(collection, id){ return DB[collection].find(x=>x.id===id); }

// ---------- Helpers de máscara ----------
function maskDoc(doc){
  if (!SETTINGS.masked || !doc) return doc;
  const value = String(doc);
  let remaining = (value.match(/\d/g) || []).length;
  return value.replace(/\d/g, digit => --remaining < 2 ? digit : '*');
}
function maskHash(h){
  if (!SETTINGS.masked || !h) return h;
  return h.slice(0,8)+'...';
}

// ---------- Toast ----------
function toast(msg, type='info'){
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast '+type;
  const icon = {success:'✓', error:'✕', warning:'⚠', info:'ℹ'}[type] || 'ℹ';
  const label = {success:'Sucesso',error:'Erro',warning:'Atenção',info:'Informação'}[type] || 'Informação';
  t.setAttribute('role',type === 'error' ? 'alert' : 'status');
  t.setAttribute('aria-atomic','true');
  t.innerHTML = `<span aria-hidden="true">${icon}</span><span class="toast-message"><strong>${label}:</strong> ${escapeHTML(msg)}</span><button class="toast-close" type="button" aria-label="Fechar aviso de ${label.toLowerCase()}">×</button>`;
  c.appendChild(t);
  c.tabIndex = 0;
  let timer;
  const remove = () => {
    clearTimeout(timer);
    const hadFocus = t.contains(document.activeElement);
    t.remove();
    if (!c.children.length) c.removeAttribute('tabindex');
    if (hadFocus) (c.querySelector('button') || document.getElementById('mainContent')).focus({preventScroll:true});
  };
  t.querySelector('button').addEventListener('click',remove);
  t.addEventListener('mouseenter',()=>clearTimeout(timer));
  t.addEventListener('focusin',()=>clearTimeout(timer));
  if (!['error','warning'].includes(type) && !window.SemperfiAccessibility?.getPreferences().keepNotices) timer = setTimeout(remove,12000);
}

// ---------- Notifications from persisted server records ----------
let notificationsVersion = 0;
async function renderNotifications(){
  const version = ++notificationsVersion;
  const badge = document.getElementById('notifBadge');
  const list = document.getElementById('notifList');
  list.setAttribute('aria-busy','true');
  try {
    const result = await backendApi('/dashboard/alerts?limit=20',{cache:'no-store'});
    if (version !== notificationsVersion) return;
    if (!Number.isSafeInteger(result.total) || result.total < 0 || !Array.isArray(result.items)) throw Error('Invalid alerts');
    badge.textContent = result.total;
    badge.style.display = result.total ? 'flex' : 'none';
    document.getElementById('notificationBtn').setAttribute('aria-label',`Notificações: ${result.total} aviso(s)`);
    list.innerHTML = result.items.length
      ? `${result.total > result.items.length ? `<p class="text-muted notif-summary">${result.items.length} de ${result.total} avisos. Consulte todos na Visão Geral.</p>` : ''}${result.items.map(item => `<button type="button" class="notif-item" data-section="${['deadlines','intimations','financial'].includes(item.section)?item.section:'dashboard'}"><span class="notif-item-title">${escapeHTML(item.title)}</span><span class="text-muted">${escapeHTML(item.description)}${item.amount?' · '+escapeHTML(fmtMoney(Number(item.amount))):''}</span><span class="notif-item-time">${escapeHTML(fmtDate(item.date))}</span></button>`).join('')}`
      : '<p class="empty-state">Nenhum alerta pendente nos registros consultados.</p>';
    list.querySelectorAll('.notif-item').forEach(button=>button.onclick=()=>{
      openDashboardRecords(button.dataset.section);
      document.getElementById('notifPanel').classList.remove('active');
    });
  } catch (_) {
    if (version !== notificationsVersion) return;
    badge.textContent = '?';badge.style.display = 'flex';
    document.getElementById('notificationBtn').setAttribute('aria-label','Notificações indisponíveis. Abrir para tentar novamente.');
    list.innerHTML = '<p role="alert">Não foi possível consultar os avisos.</p><button type="button" class="btn btn-secondary" data-notif-retry>Tentar novamente</button>';
    list.querySelector('[data-notif-retry]').onclick=renderNotifications;
  } finally { if(version===notificationsVersion)list.setAttribute('aria-busy','false'); }
}
// ---------- Navigation ----------
const SECTIONS = [
  {id:'billing',    icon:'💳', label:'Plano & Consumo'},
  {id:'dashboard',  icon:'📊', label:'Visão Geral'},
  {id:'clients',    icon:'👥', label:'Clientes'},
  {id:'processes',  icon:'📋', label:'Processos'},
  {id:'agenda',     icon:'📅', label:'Agenda'},
  {id:'deadlines',  icon:'⏰', label:'Prazos'},
  {id:'intimations',icon:'📧', label:'Intimações'},
  {id:'financial',  icon:'💰', label:'Financeiro'},
  {id:'queries',    icon:'🔍', label:'Consultas'},
  {id:'osint',      icon:'🕵️', label:'Investigação OSINT'},
  {id:'osinttools', icon:'⚒️', label:'OSINT Tools'},
  {id:'agentes',    icon:'🤖', label:'Agentes IA'},
  {id:'societario', icon:'🏢', label:'Radar Societário'},
  {id:'transparencia',icon:'🏛️', label:'Transparência'},
  {id:'apiexplorer',icon:'🌐', label:'API Explorer'},
  {id:'conhecimento',icon:'📚', label:'ISO & Legislação'},
  {id:'metadata',   icon:'📂', label:'Arquivos'},
  {id:'calculators',icon:'🧮', label:'Calculadoras'},
  {id:'reports',    icon:'📄', label:'Relatórios'},
  {id:'audit',      icon:'🔐', label:'Auditoria'},
  {id:'settings',   icon:'⚙️',  label:'Configurações'}
];

function renderSidebar(){
  const orderedSections = [...SECTIONS];
  const billingIndex = orderedSections.findIndex(section => section.id === 'billing');
  if (billingIndex >= 0){
    const [billingSection] = orderedSections.splice(billingIndex, 1);
    const financialIndex = orderedSections.findIndex(section => section.id === 'financial');
    orderedSections.splice(financialIndex >= 0 ? financialIndex + 1 : 0, 0, billingSection);
  }
  const html = orderedSections.map(s => `<li class="nav-item"><a class="nav-link${s.id===appState.currentSection?' active':''}" data-section="${s.id}" href="#${s.id}" ${s.id===appState.currentSection?'aria-current="page"':''}><span aria-hidden="true">${s.icon}</span><span>${s.label}</span></a></li>`).join('');
  document.getElementById('sidebarNav').innerHTML = html;
  document.querySelectorAll('#sidebarNav .nav-link').forEach(link=>{
    link.addEventListener('click', e=>{ e.preventDefault(); navigateSection(link.dataset.section); });
  });
}

function resolveInitialSection(){
  const requested = (location.hash || '').replace('#', '').trim();
  return SECTIONS.some(section => section.id === requested) ? requested : 'dashboard';
}

const appState = { currentSection: resolveInitialSection() };

function navigateSection(id){
  if (!SECTIONS.some(section => section.id === id)) id = 'dashboard';
  appState.currentSection = id;
  if (location.hash !== `#${id}`) history.pushState(null, '', `#${id}`);
  renderSidebar();
  renderSection(id);
}

let dashboardController = null;
let sectionRenderVersion = 0;
let dashboardNavigationPending = false;
async function openDashboardRecords(id){
  if (!['processes','deadlines','agenda','intimations','financial'].includes(id)) { navigateSection(id); return; }
  if (dashboardNavigationPending) return;
  dashboardNavigationPending = true;
  const version = sectionRenderVersion;
  const status = document.getElementById('dashboardStatus');
  if(status) {status.setAttribute('role','status');status.textContent='Consultando registros para abrir a seção…';}
  try {
    await refreshBackendBootstrap();
    if(version===sectionRenderVersion && !document.getElementById('modal').classList.contains('active')) navigateSection(id);
  } catch(error) {
    if(version===sectionRenderVersion) {
      toast('Não foi possível atualizar a lista. Tente abrir a seção novamente.','error');
      if(error?.status===401||error?.status===403)dashboardController?.reload();
      else if(status?.isConnected){status.setAttribute('role','alert');status.textContent='Não foi possível abrir a lista atualizada. Os indicadores mantêm a última consulta indicada abaixo.';}
    }
  } finally {dashboardNavigationPending=false;}
}
function renderSection(id){
  sectionRenderVersion++;
  dashboardController?.dispose();
  dashboardController = null;
  syncCommercialState({persist:false});
  const wrapper = document.getElementById('contentWrapper');
  const renderer = SECTION_RENDERERS[id];
  if (renderer){
    wrapper.innerHTML = `${canViewBilling() ? renderSubscriptionBanner() : ''}${renderer()}`;
    SECTION_AFTER[id] && SECTION_AFTER[id]();
  }
  else { wrapper.innerHTML = `<h1 class="page-title">${id}</h1><p>Seção em desenvolvimento.</p>`; }
  renderTopbarMeters();
  document.querySelector('.content-area').scrollTo({top:0,behavior:(window.SemperfiAccessibility?.shouldReduceMotion() ?? matchMedia('(prefers-reduced-motion: reduce)').matches)?'instant':'smooth'});
  document.dispatchEvent(new Event('semperfi:render'));
}

const SECTION_RENDERERS = {};
const SECTION_AFTER = {};

// ---------- Modal helpers ----------
function confirmModalLeave(){
  const panel=document.getElementById('clientProfilePanel');
  if(panel?._profileController?.isDirty() && !confirm('Há alterações não salvas no perfil. Deseja descartá-las?')) return false;
  if(panel) panel._profileController=null;
  return true;
}
function openModal({title, body, footer, wide=false, onMount}){
  if(!confirmModalLeave()) return;
  const c = document.getElementById('modalContent');
  c.className = 'modal-content' + (wide?' wide':'');
  c.innerHTML = `
    <div class="modal-header"><h2 class="modal-title">${title}</h2><div class="modal-heading-tools"><button class="btn btn-secondary" type="button" data-a11y-open aria-controls="a11yDialog" aria-haspopup="dialog" aria-expanded="false">Acessibilidade</button><button class="modal-close" id="modalCloseBtn" aria-label="Fechar janela">×</button></div></div>
    <div class="modal-body">${body}</div>
    ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
  `;
  document.getElementById('modal').classList.add('active');
  document.getElementById('modalCloseBtn').onclick = closeModal;
  if (onMount) onMount(c);
  window.SemperfiLegalForms?.enhance(c, {processes:DB.processes});
}
function closeModal(){ if(!confirmModalLeave()) return false; document.getElementById('modal').classList.remove('active'); return true; }
window.addEventListener('beforeunload',event=>{
  if(document.getElementById('clientProfilePanel')?._profileController?.isDirty()) {event.preventDefault();event.returnValue='';}
});
document.getElementById('modal').addEventListener('click', e => { if (e.target.id==='modal') closeModal(); });

// ============================================================
//                        DASHBOARD
// ============================================================
SECTION_RENDERERS.dashboard = () => window.SemperfiDashboard.render();
SECTION_AFTER.dashboard = () => {
  dashboardController = window.SemperfiDashboard.mount({request:backendApi,navigate:openDashboardRecords,openModal,closeModal});
};
// ---------- Mini Calendar ----------
let calendarState = { year: new Date().getFullYear(), month: new Date().getMonth() };

function renderMiniCalendar(container){
  if (!container) return;
  const {year, month} = calendarState;
  const monthNames = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const first = new Date(year, month, 1);
  const dim = new Date(year, month+1, 0).getDate();
  const startDay = first.getDay();
  const today = toISO(new Date());
  const eventsByDate = {};
  DB.appointments.forEach(a => { (eventsByDate[a.date] = eventsByDate[a.date]||[]).push(a); });
  DB.deadlines.forEach(d => { (eventsByDate[d.date] = eventsByDate[d.date]||[]).push(d); });

  let cells = '';
  for (let i=0;i<startDay;i++) cells += '<div class="calendar-date empty"></div>';
  for (let d=1; d<=dim; d++){
    const iso = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dateObj = fromISO(iso);
    const classes = ['calendar-date'];
    if (iso===today) classes.push('today');
    if (eventsByDate[iso]) classes.push('has-event');
    if (isWeekend(dateObj)) classes.push('weekend');
    cells += `<div class="${classes.join(' ')}" data-date="${iso}" title="${eventsByDate[iso]?eventsByDate[iso].length+' evento(s)':''}">${d}</div>`;
  }
  container.innerHTML = `
    <div class="mini-calendar">
      <div class="calendar-header">
        <button class="calendar-nav-btn" id="calPrev">←</button>
        <strong>${monthNames[month]} ${year}</strong>
        <button class="calendar-nav-btn" id="calNext">→</button>
      </div>
      <div class="calendar-days">
        <div class="calendar-day">Dom</div><div class="calendar-day">Seg</div><div class="calendar-day">Ter</div><div class="calendar-day">Qua</div><div class="calendar-day">Qui</div><div class="calendar-day">Sex</div><div class="calendar-day">Sab</div>
      </div>
      <div class="calendar-dates">${cells}</div>
    </div>`;
  container.querySelector('#calPrev').onclick = () => { calendarState.month--; if (calendarState.month<0){calendarState.month=11;calendarState.year--;} renderMiniCalendar(container); };
  container.querySelector('#calNext').onclick = () => { calendarState.month++; if (calendarState.month>11){calendarState.month=0;calendarState.year++;} renderMiniCalendar(container); };
  container.querySelectorAll('.calendar-date[data-date]').forEach(el=>{
    el.onclick = () => { showDayDetail(el.dataset.date); };
  });
}

function showDayDetail(iso){
  const appts = DB.appointments.filter(a=>a.date===iso);
  const deads = DB.deadlines.filter(d=>d.date===iso);
  let body = `<div class="detail-row"><span class="detail-label">Data:</span><span class="detail-value">${fmtDate(iso)}</span></div>`;
  body += `<h4 style="margin:16px 0 8px;color:var(--teal-accent)">Compromissos (${appts.length})</h4>`;
  body += appts.length ? appts.map(a=>`<div style="padding:8px;background:var(--obsidian);border-radius:4px;margin-bottom:6px"><strong>${escapeHTML(a.time)}</strong> — ${escapeHTML(a.title)}<br><small class="text-muted">${escapeHTML(a.location||'')}</small></div>`).join('') : '<div class="text-muted">Nenhum</div>';
  body += `<h4 style="margin:16px 0 8px;color:var(--gold-accent)">Prazos (${deads.length})</h4>`;
  body += deads.length ? deads.map(d=>{const p=dbGet('processes',d.processId);return `<div style="padding:8px;background:var(--obsidian);border-radius:4px;margin-bottom:6px">${escapeHTML(d.title)}<br><small class="text-muted">${escapeHTML(p?.number||'—')}</small></div>`;}).join('') : '<div class="text-muted">Nenhum</div>';
  openModal({ title:'Detalhes do dia', body, footer:'<button class="btn btn-secondary" onclick="closeModal()">Fechar</button>' });
}

// ============================================================
//                        CLIENTS
// ============================================================
const clientsState = { search:'', type:'todos', status:'todos' };

SECTION_RENDERERS.clients = () => {
  const filtered = DB.clients.filter(c => {
    if (clientsState.search){
      const q = clientsState.search.toLowerCase();
      if (!c.name.toLowerCase().includes(q) && !c.document.includes(clientsState.search) && !(c.email||'').toLowerCase().includes(q)) return false;
    }
    if (clientsState.type!=='todos' && c.type!==clientsState.type) return false;
    if (clientsState.status!=='todos' && c.status!==clientsState.status) return false;
    return true;
  });
  return `
    <h1 class="page-title">Clientes</h1>
    <p class="page-subtitle">${DB.clients.length} cadastrados | ${filtered.length} exibidos</p>
    <div class="panel">
      <div class="filter-bar">
        <input type="text" class="form-input grow" id="cliSearch" placeholder="Buscar por nome, documento, e-mail..." value="${escapeHTML(clientsState.search)}">
        <select class="form-select" id="cliType"><option value="todos">Tipo: Todos</option><option value="PF" ${clientsState.type==='PF'?'selected':''}>Pessoa Física</option><option value="PJ" ${clientsState.type==='PJ'?'selected':''}>Pessoa Jurídica</option></select>
        <select class="form-select" id="cliStatus"><option value="todos">Status: Todos</option><option value="ativo" ${clientsState.status==='ativo'?'selected':''}>Ativo</option><option value="atencao" ${clientsState.status==='atencao'?'selected':''}>Atenção</option><option value="inativo" ${clientsState.status==='inativo'?'selected':''}>Inativo</option></select>
        <button class="btn btn-primary" onclick="openClientForm()">+ Novo cliente</button>
      </div>
      ${filtered.length ? `
        <table><thead><tr><th>Nome/Razão Social</th><th>Tipo</th><th>Documento</th><th>Responsável</th><th>Processos</th><th>Status</th><th></th></tr></thead><tbody>
          ${filtered.map(c=>{
            const procs = DB.processes.filter(p=>p.clientId===c.id).length;
            const statusMap = {ativo:'active',atencao:'pending',inativo:'critical'};
            const statusLbl = {ativo:'Ativo',atencao:'Atenção',inativo:'Inativo'};
            return `<tr>
              <td style="font-weight:600;cursor:pointer" onclick="showClientDetail('${c.id}')">${escapeHTML(c.name)}</td>
              <td>${c.type==='PF'?'Pessoa Física':'Pessoa Jurídica'}</td>
              <td class="masked">${maskDoc(c.document)}</td>
              <td>${escapeHTML(c.responsible||'—')}</td>
              <td>${procs}</td>
              <td><span class="status-chip ${statusMap[c.status]||'active'}">${statusLbl[c.status]||c.status}</span></td>
              <td><div class="row-actions">
                <button class="btn btn-small btn-secondary" onclick="showClientDetail('${c.id}')">Abrir</button>
                <button class="btn btn-small btn-secondary" onclick="openClientForm('${c.id}')">Editar</button>
                <button class="btn btn-small btn-danger" onclick="deleteClient('${c.id}')">×</button>
              </div></td></tr>`;
          }).join('')}
        </tbody></table>
      ` : '<div class="empty-state"><div class="empty-state-icon">👥</div><div class="empty-state-title">Nenhum cliente</div><div class="empty-state-text">Ajuste os filtros ou cadastre um novo cliente.</div></div>'}
    </div>
  `;
};
SECTION_AFTER.clients = () => {
  document.getElementById('cliSearch').addEventListener('input', e=>{ clientsState.search=e.target.value; renderSection('clients'); document.getElementById('cliSearch').focus(); });
  document.getElementById('cliType').onchange = e => { clientsState.type=e.target.value; renderSection('clients'); };
  document.getElementById('cliStatus').onchange = e => { clientsState.status=e.target.value; renderSection('clients'); };
};

function openClientForm(id){
  const c = id ? dbGet('clients', id) : {type:'PF',status:'ativo'};
  openModal({
    title: id ? 'Editar cliente' : 'Novo cliente',
    body: `
      <div class="form-row">
        <div class="form-group"><label class="form-label">Tipo</label><select class="form-select" id="f_type"><option value="PF" ${c.type==='PF'?'selected':''}>Pessoa Física</option><option value="PJ" ${c.type==='PJ'?'selected':''}>Pessoa Jurídica</option></select></div>
        <div class="form-group"><label class="form-label">Status</label><select class="form-select" id="f_status"><option value="ativo" ${c.status==='ativo'?'selected':''}>Ativo</option><option value="atencao" ${c.status==='atencao'?'selected':''}>Atenção</option><option value="inativo" ${c.status==='inativo'?'selected':''}>Inativo</option></select></div>
      </div>
      <div class="form-group"><label class="form-label" for="f_name">Nome / Razão Social *</label><input class="form-input" id="f_name" value="${escapeHTML(c.name||'')}"></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label" for="f_document">CPF / CNPJ *</label><input class="form-input" id="f_document" value="${escapeHTML(c.document||'')}"></div>
        <div class="form-group"><label class="form-label" for="f_responsible">Responsável</label><input class="form-input" id="f_responsible" value="${escapeHTML(c.responsible||'')}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label" for="f_email">E-mail</label><input class="form-input" id="f_email" type="email" value="${escapeHTML(c.email||'')}"></div>
        <div class="form-group"><label class="form-label" for="f_phone">Telefone</label><input class="form-input" id="f_phone" value="${escapeHTML(c.phone||'')}"></div>
      </div>
      <div class="form-group"><label class="form-label" for="f_address">Endereço</label><input class="form-input" id="f_address" value="${escapeHTML(c.address||'')}"></div>
      <div class="form-group"><label class="form-label" for="f_notes">Observações</label><textarea class="form-textarea" id="f_notes">${escapeHTML(c.notes||'')}</textarea></div>
    `,
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveClient('${id||''}')">Salvar</button>`
  });
}
async function saveClient(id){
  const data = {
    name: document.getElementById('f_name').value.trim(),
    type: document.getElementById('f_type').value,
    document: document.getElementById('f_document').value.trim(),
    responsible: document.getElementById('f_responsible').value.trim(),
    email: document.getElementById('f_email').value.trim(),
    phone: document.getElementById('f_phone').value.trim(),
    address: document.getElementById('f_address').value.trim(),
    notes: document.getElementById('f_notes').value.trim(),
    status: document.getElementById('f_status').value
  };
  if (!data.name || !data.document){ toast('Nome e documento são obrigatórios','error'); return; }
  try {
    if (isBackendMode()){
      const saved = await persistClient(data, id);
      if (id) dbUpdate('clients', id, saved); else dbCreate('clients', saved);
    } else if (id){ dbUpdate('clients', id, data); }
    else { dbCreate('clients', data); }
  } catch(err){
    toast(apiErrorMessage(err),'error');
    return;
  }
  toast(id?'Cliente atualizado':'Cliente cadastrado','success');
  closeModal(); renderSection('clients'); renderNotifications();
}
async function deleteClient(id){
  const c = dbGet('clients', id);
  const procs = DB.processes.filter(p=>p.clientId===id).length;
  if (procs>0){ toast(`Cliente possui ${procs} processo(s). Remova ou reatribua antes.`,'error'); return; }
  if (!confirm(`Excluir cliente "${c.name}"? Esta ação será auditada.`)) return;
  if (isBackendMode()){
    try { await backendApi(`/clients/${id}`, { method:'DELETE' }); }
    catch(err){ toast(apiErrorMessage(err),'error'); return; }
  }
  dbDelete('clients', id); toast('Cliente excluído','success'); renderSection('clients');
}
// showClientDetail substituído por versão 360° — ver bloco "PERFIL 360°" antes do BOOT
function showClientDetail(id){ showClientDetail360(id); }

// ============================================================
//                        PROCESSES
// ============================================================
const procState = { search:'', area:'todas', status:'todos' };
SECTION_RENDERERS.processes = () => {
  const filtered = DB.processes.filter(p=>{
    if (procState.search && !p.number.includes(procState.search) && !(p.notes||'').toLowerCase().includes(procState.search.toLowerCase())) return false;
    if (procState.area!=='todas' && p.area!==procState.area) return false;
    if (procState.status!=='todos' && p.status!==procState.status) return false;
    return true;
  });
  return `
    <h1 class="page-title">Processos</h1>
    <p class="page-subtitle">${DB.processes.length} cadastrados | ${filtered.length} exibidos</p>
    <div class="panel">
      <div class="filter-bar">
        <input type="text" class="form-input grow" id="proSearch" placeholder="Número do processo ou palavra-chave..." value="${escapeHTML(procState.search)}">
        <select class="form-select" id="proArea"><option value="todas">Área: Todas</option><option value="Civel">Cível</option><option value="Penal">Penal</option><option value="Trabalhista">Trabalhista</option><option value="Comercial">Comercial</option><option value="Administrativo">Administrativo</option></select>
        <select class="form-select" id="proStatus"><option value="todos">Status: Todos</option><option value="ativo">Ativo</option><option value="critico">Crítico</option><option value="arquivado">Arquivado</option></select>
        <button class="btn btn-primary" onclick="openProcessForm()">+ Novo processo</button>
      </div>
      ${filtered.length?`
        <table><thead><tr><th>Número</th><th>Cliente</th><th>Tribunal</th><th>Área</th><th>Fase</th><th>Responsável</th><th>Próximo Prazo</th><th></th></tr></thead><tbody>
          ${filtered.map(p=>{
            const cli = dbGet('clients', p.clientId);
            const nextDl = DB.deadlines.filter(d=>d.processId===p.id&&d.status==='pendente').sort((a,b)=>a.date.localeCompare(b.date))[0];
            const phaseMap = {ativa:'active',critica:'critical',sentenciada:'completed',arquivada:'pending'};
            return `<tr>
              <td style="font-weight:600;font-family:'JetBrains Mono';cursor:pointer" onclick="showProcessDetail('${p.id}')">${escapeHTML(p.number)}</td>
              <td>${escapeHTML(cli?.name||'—')}</td>
              <td>${escapeHTML(p.court)}</td>
              <td>${escapeHTML(p.area)}</td>
              <td><span class="status-chip ${phaseMap[p.phase]||'active'}">${escapeHTML(p.phase)}</span></td>
              <td>${escapeHTML(p.responsible)}</td>
              <td>${nextDl?fmtDate(nextDl.date):'—'}</td>
              <td><div class="row-actions">
                <button class="btn btn-small btn-secondary" onclick="showProcessDetail('${p.id}')">Abrir</button>
                <button class="btn btn-small btn-secondary" onclick="openProcessForm('${p.id}')">Editar</button>
                <button class="btn btn-small btn-danger" onclick="deleteProcess('${p.id}')">×</button>
              </div></td></tr>`;
          }).join('')}
        </tbody></table>
      `:'<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-title">Nenhum processo</div></div>'}
    </div>
  `;
};
SECTION_AFTER.processes = () => {
  document.getElementById('proSearch').addEventListener('input', e=>{procState.search=e.target.value;renderSection('processes');document.getElementById('proSearch').focus();});
  document.getElementById('proArea').onchange = e=>{procState.area=e.target.value;renderSection('processes');};
  document.getElementById('proStatus').onchange = e=>{procState.status=e.target.value;renderSection('processes');};
};

function openProcessForm(id){
  const p = id ? dbGet('processes', id) : {area:'Civel',phase:'ativa',status:'ativo'};
  const cliOpts = DB.clients.map(c=>`<option value="${c.id}" ${c.id===p.clientId?'selected':''}>${escapeHTML(c.name)}</option>`).join('');
  openModal({ title: id?'Editar processo':'Novo processo', body:`
    <div class="form-row">
      <div class="form-group"><label class="form-label">Número *</label><input class="form-input" id="f_number" value="${escapeHTML(p.number||'')}" placeholder="0000000-00.0000.0.00.0000"></div>
      <div class="form-group"><label class="form-label">Cliente *</label><select class="form-select" id="f_clientId"><option value="">— selecionar —</option>${cliOpts}</select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Tribunal</label><input class="form-input" id="f_court" value="${escapeHTML(p.court||'')}"></div>
      <div class="form-group"><label class="form-label">Área</label><select class="form-select" id="f_area"><option ${p.area==='Civel'?'selected':''}>Civel</option><option ${p.area==='Penal'?'selected':''}>Penal</option><option ${p.area==='Trabalhista'?'selected':''}>Trabalhista</option><option ${p.area==='Comercial'?'selected':''}>Comercial</option><option ${p.area==='Administrativo'?'selected':''}>Administrativo</option></select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Fase</label><select class="form-select" id="f_phase"><option value="ativa" ${p.phase==='ativa'?'selected':''}>Ativa</option><option value="critica" ${p.phase==='critica'?'selected':''}>Crítica</option><option value="sentenciada" ${p.phase==='sentenciada'?'selected':''}>Sentenciada</option><option value="arquivada" ${p.phase==='arquivada'?'selected':''}>Arquivada</option></select></div>
      <div class="form-group"><label class="form-label">Responsável</label><input class="form-input" id="f_responsible" value="${escapeHTML(p.responsible||'')}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Valor da causa</label><input class="form-input" id="f_value" type="number" step="0.01" value="${p.value||0}"></div>
      <div class="form-group"><label class="form-label">Status</label><select class="form-select" id="f_status"><option value="ativo" ${p.status==='ativo'?'selected':''}>Ativo</option><option value="critico" ${p.status==='critico'?'selected':''}>Crítico</option><option value="arquivado" ${p.status==='arquivado'?'selected':''}>Arquivado</option></select></div>
    </div>
    <div class="form-group"><label class="form-label">Observações</label><textarea class="form-textarea" id="f_notes">${escapeHTML(p.notes||'')}</textarea></div>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveProcess('${id||''}')">Salvar</button>` });
}
async function saveProcess(id){
  const data = {
    number: document.getElementById('f_number').value.trim(),
    clientId: document.getElementById('f_clientId').value,
    court: document.getElementById('f_court').value.trim(),
    area: document.getElementById('f_area').value,
    phase: document.getElementById('f_phase').value,
    responsible: document.getElementById('f_responsible').value.trim(),
    value: parseFloat(document.getElementById('f_value').value)||0,
    status: document.getElementById('f_status').value,
    notes: document.getElementById('f_notes').value.trim()
  };
  if (!data.number || !data.clientId){ toast('Número e cliente são obrigatórios','error'); return; }
  try {
    if (isBackendMode()){
      const saved = await persistProcess(data, id);
      if (id) dbUpdate('processes', id, saved); else dbCreate('processes', saved);
    } else if (id) dbUpdate('processes', id, data); else dbCreate('processes', data);
  } catch(err){
    toast(apiErrorMessage(err),'error');
    return;
  }
  toast('Processo salvo','success'); closeModal(); renderSection('processes');
}
async function deleteProcess(id){
  const p = dbGet('processes', id);
  if (!confirm(`Excluir processo ${p.number}?`)) return;
  if (isBackendMode()){
    try { await backendApi(`/processes/${id}`, { method:'DELETE' }); }
    catch(err){ toast(apiErrorMessage(err),'error'); return; }
  }
  dbDelete('processes', id); toast('Processo excluído','success'); renderSection('processes');
}
// showProcessDetail substituído por versão com Andamentos — ver bloco "PROCESSO COMPLETO" antes do BOOT
function showProcessDetail(id){ showProcessDetailFull(id); }

SECTION_RENDERERS.processes = () => {
  const filtered = DB.processes.filter(p=>{
    if (procState.search && !p.number.includes(procState.search) && !(p.notes||'').toLowerCase().includes(procState.search.toLowerCase())) return false;
    if (procState.area!=='todas' && p.area!==procState.area) return false;
    if (procState.status!=='todos' && p.status!==procState.status) return false;
    return true;
  });
  return `
    <h1 class="page-title">Processos</h1>
    <p class="page-subtitle">${DB.processes.length} cadastrados | ${filtered.length} exibidos</p>
    <div class="panel">
      <div class="filter-bar">
        <input type="text" class="form-input grow" id="proSearch" placeholder="Número do processo ou palavra-chave..." value="${escapeHTML(procState.search)}">
        <select class="form-select" id="proArea"><option value="todas">Área: Todas</option><option value="Civel">Cível</option><option value="Penal">Penal</option><option value="Trabalhista">Trabalhista</option><option value="Comercial">Comercial</option><option value="Administrativo">Administrativo</option></select>
        <select class="form-select" id="proStatus"><option value="todos">Status: Todos</option><option value="ativo">Ativo</option><option value="critico">Crítico</option><option value="arquivado">Arquivado</option></select>
        <button class="btn btn-primary" onclick="openProcessForm()">+ Novo processo</button>
      </div>
      <div class="pricing-note">O cadastro e os andamentos manuais ficam salvos. O monitoramento automático depende da integração e da rotina de coleta do tribunal.</div>
      ${filtered.length?`
        <table><thead><tr><th>Número</th><th>Cliente</th><th>Tribunal</th><th>Área</th><th>Fase</th><th>Monitoramento</th><th>Responsável</th><th>Próximo Prazo</th><th></th></tr></thead><tbody>
          ${filtered.map(p=>{
            const cli = dbGet('clients', p.clientId);
            const nextDl = DB.deadlines.filter(d=>d.processId===p.id&&d.status==='pendente').sort((a,b)=>a.date.localeCompare(b.date))[0];
            const phaseMap = {ativa:'active',critica:'critical',sentenciada:'completed',arquivada:'pending'};
            const monitoringActive = p.monitoringEnabled === true && p.status !== 'arquivado';
            return `<tr>
              <td style="font-weight:600;font-family:'JetBrains Mono';cursor:pointer" onclick="showProcessDetail('${p.id}')">${escapeHTML(p.number)}</td>
              <td>${escapeHTML(cli?.name||'—')}</td>
              <td>${escapeHTML(p.court)}</td>
              <td>${escapeHTML(p.area)}</td>
              <td><span class="status-chip ${phaseMap[p.phase]||'active'}">${escapeHTML(p.phase)}</span></td>
              <td><span class="status-chip ${monitoringActive ? 'completed' : 'pending'}">${monitoringActive ? 'Ativo' : 'Desligado'}</span></td>
              <td>${escapeHTML(p.responsible)}</td>
              <td>${nextDl?fmtDate(nextDl.date):'—'}</td>
              <td><div class="row-actions">
                <button class="btn btn-small btn-secondary" onclick="showProcessDetail('${p.id}')">Abrir</button>
                <button class="btn btn-small btn-secondary" onclick="openProcessForm('${p.id}')">Editar</button>
                <button class="btn btn-small btn-danger" onclick="deleteProcess('${p.id}')">×</button>
              </div></td></tr>`;
          }).join('')}
        </tbody></table>
      `:'<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-title">Nenhum processo</div></div>'}
    </div>
  `;
};
SECTION_AFTER.processes = () => {
  document.getElementById('proSearch').addEventListener('input', e=>{procState.search=e.target.value;renderSection('processes');document.getElementById('proSearch').focus();});
  document.getElementById('proArea').onchange = e=>{procState.area=e.target.value;renderSection('processes');};
  document.getElementById('proStatus').onchange = e=>{procState.status=e.target.value;renderSection('processes');};
};
openProcessForm = function(id){
  const p = id ? dbGet('processes', id) : {area:'Civel',phase:'ativa',status:'ativo', monitoringEnabled:true};
  const cliOpts = DB.clients.map(c=>`<option value="${c.id}" ${c.id===p.clientId?'selected':''}>${escapeHTML(c.name)}</option>`).join('');
  const monitoringChecked = '';
  openModal({ title: id?'Editar processo':'Novo processo', body:`
    <div class="form-row">
      <div class="form-group"><label class="form-label">Número *</label><input class="form-input" id="f_number" value="${escapeHTML(p.number||'')}" placeholder="0000000-00.0000.0.00.0000"></div>
      <div class="form-group"><label class="form-label">Cliente *</label><select class="form-select" id="f_clientId"><option value="">— selecionar —</option>${cliOpts}</select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Tribunal</label><input class="form-input" id="f_court" value="${escapeHTML(p.court||'')}"></div>
      <div class="form-group"><label class="form-label">Área</label><select class="form-select" id="f_area"><option ${p.area==='Civel'?'selected':''}>Civel</option><option ${p.area==='Penal'?'selected':''}>Penal</option><option ${p.area==='Trabalhista'?'selected':''}>Trabalhista</option><option ${p.area==='Comercial'?'selected':''}>Comercial</option><option ${p.area==='Administrativo'?'selected':''}>Administrativo</option></select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Fase</label><select class="form-select" id="f_phase"><option value="ativa" ${p.phase==='ativa'?'selected':''}>Ativa</option><option value="critica" ${p.phase==='critica'?'selected':''}>Crítica</option><option value="sentenciada" ${p.phase==='sentenciada'?'selected':''}>Sentenciada</option><option value="arquivada" ${p.phase==='arquivada'?'selected':''}>Arquivada</option></select></div>
      <div class="form-group"><label class="form-label">Responsável</label><input class="form-input" id="f_responsible" value="${escapeHTML(p.responsible||'')}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Valor da causa</label><input class="form-input" id="f_value" type="number" step="0.01" value="${p.value||0}"></div>
      <div class="form-group"><label class="form-label">Status</label><select class="form-select" id="f_status"><option value="ativo" ${p.status==='ativo'?'selected':''}>Ativo</option><option value="critico" ${p.status==='critico'?'selected':''}>Crítico</option><option value="arquivado" ${p.status==='arquivado'?'selected':''}>Arquivado</option></select></div>
    </div>
    <div class="form-group">
      <label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="f_monitoringEnabled" disabled ${monitoringChecked}> Monitoramento automático ainda não configurado</label>
      <div class="pricing-note">O cadastro e os andamentos manuais ficam salvos. O monitoramento automático depende da integração e da rotina de coleta do tribunal.</div>
    </div>
    <div class="form-group"><label class="form-label">Observações</label><textarea class="form-textarea" id="f_notes">${escapeHTML(p.notes||'')}</textarea></div>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveProcess('${id||''}')">Salvar</button>` });
};
saveProcess = async function(id){
  if (!ensureSubscriptionActive('A assinatura está em modo leitura. Novos processos foram bloqueados.')) return;
  const current = id ? dbGet('processes', id) : null;
  const status = document.getElementById('f_status').value;
  const monitoringEnabled = status === 'arquivado' ? false : document.getElementById('f_monitoringEnabled').checked;
  const data = {
    number: document.getElementById('f_number').value.trim(),
    clientId: document.getElementById('f_clientId').value,
    court: document.getElementById('f_court').value.trim(),
    area: document.getElementById('f_area').value,
    phase: document.getElementById('f_phase').value,
    responsible: document.getElementById('f_responsible').value.trim(),
    value: parseFloat(document.getElementById('f_value').value)||0,
    status,
    monitoringEnabled,
    notes: document.getElementById('f_notes').value.trim()
  };
  if (!data.number || !data.clientId){ toast('Número e cliente são obrigatórios','error'); return; }
  syncCommercialState({persist:false});
  const projectedStored = id ? DB.usage.storedProcesses : DB.usage.storedProcesses + 1;
  if (DB.entitlements.storedProcesses != null && projectedStored > DB.entitlements.storedProcesses){
    openUpgradePrompt('Limite de processos armazenados', 'A conta atingiu o limite de processos armazenados ou arquivados.', 'Você pode ampliar a capacidade, arquivar um processo existente ou reorganizar a base sem apagar histórico.');
    return;
  }
  const currentMonitoring = current && current.monitoringEnabled !== false && current.status !== 'arquivado' ? 1 : 0;
  const projectedMonitoring = DB.usage.monitoredProcesses - currentMonitoring + (monitoringEnabled ? 1 : 0);
  if (DB.entitlements.monitoredProcesses != null && projectedMonitoring > DB.entitlements.monitoredProcesses){
    openUpgradePrompt('Limite de processos monitorados', 'Ativar este monitoramento excede a capacidade configurada.', 'Consulte o administrador sobre a capacidade de monitoramento antes de prosseguir.');
    return;
  }
  try {
    if (isBackendMode()){
      const saved = await persistProcess(data, id);
      if (id) dbUpdate('processes', id, {...saved, monitoringEnabled:data.monitoringEnabled});
      else dbCreate('processes', {...saved, monitoringEnabled:data.monitoringEnabled});
    } else if (id) dbUpdate('processes', id, data); else dbCreate('processes', data);
  } catch(err){
    toast(apiErrorMessage(err),'error');
    return;
  }
  syncCommercialState({persist:true});
  toast('Processo salvo','success');
  closeModal();
  renderSection('processes');
};

// ============================================================
//                        DEADLINES
// ============================================================
const dlState = { filter:'todos', search:'' };
SECTION_RENDERERS.deadlines = () => {
  const today = toISO(new Date());
  const filtered = DB.deadlines.filter(d=>{
    const diff = daysBetween(today, d.date);
    if (dlState.filter==='critico' && !(d.status==='pendente' && diff<=2 && diff>=0)) return false;
    if (dlState.filter==='hoje' && d.date!==today) return false;
    if (dlState.filter==='semana' && (diff<0 || diff>7)) return false;
    if (dlState.filter==='vencido' && !(diff<0 && d.status==='pendente')) return false;
    if (dlState.filter==='concluido' && d.status!=='concluido') return false;
    if (dlState.search){
      const proc = dbGet('processes', d.processId);
      const q = dlState.search.toLowerCase();
      if (!d.title.toLowerCase().includes(q) && !(proc?.number||'').includes(dlState.search)) return false;
    }
    return true;
  }).sort((a,b)=>a.date.localeCompare(b.date));

  return `
    <h1 class="page-title">Prazos</h1>
    <p class="page-subtitle">Central de prazos processuais e administrativos</p>
    <div class="panel">
      <div class="filter-bar">
        <select class="form-select" id="dlFilter">
          <option value="todos">Status: Todos</option><option value="critico" ${dlState.filter==='critico'?'selected':''}>Crítico</option>
          <option value="hoje" ${dlState.filter==='hoje'?'selected':''}>Hoje</option><option value="semana" ${dlState.filter==='semana'?'selected':''}>Esta semana</option>
          <option value="vencido" ${dlState.filter==='vencido'?'selected':''}>Vencido</option><option value="concluido" ${dlState.filter==='concluido'?'selected':''}>Concluído</option>
        </select>
        <input type="text" class="form-input grow" id="dlSearch" placeholder="Filtrar..." value="${escapeHTML(dlState.search)}">
        <button class="btn btn-primary" onclick="openDeadlineForm()">+ Novo prazo</button>
      </div>
      ${filtered.length?`
        <table><thead><tr><th>Prazo</th><th>Processo</th><th>Cliente</th><th>Data</th><th>Dias até</th><th>Responsável</th><th>Status</th><th></th></tr></thead><tbody>
          ${filtered.map(d=>{
            const proc = dbGet('processes', d.processId);
            const cli = dbGet('clients', proc?.clientId);
            const diff = daysBetween(today, d.date);
            let chip = 'active', diffLbl = `${diff} dias`, diffColor = 'var(--text-primary)';
            if (d.status==='concluido'){ chip='completed'; }
            else if (diff<0){ chip='critical'; diffLbl=`Vencido ${-diff}d`; diffColor='var(--danger)'; }
            else if (diff===0){ chip='critical'; diffLbl='HOJE'; diffColor='var(--danger)'; }
            else if (diff<=2){ chip='pending'; diffColor='var(--warning)'; }
            else if (diff<=7){ chip='pending'; }
            return `<tr>
              <td>${escapeHTML(d.title)}</td><td style="font-family:'JetBrains Mono';font-size:12px">${escapeHTML(proc?.number||'—')}</td>
              <td>${escapeHTML(cli?.name||'—')}</td><td>${fmtDate(d.date)}</td>
              <td style="font-weight:700;color:${diffColor}">${diffLbl}</td>
              <td>${escapeHTML(d.responsible||'—')}</td><td><span class="status-chip ${chip}">${escapeHTML(d.status)}</span></td>
              <td><div class="row-actions">
                ${d.status==='pendente'?`<button class="btn btn-small btn-primary" onclick="completeDeadline('${d.id}')">Concluir</button>`:''}
                <button class="btn btn-small btn-secondary" onclick="openDeadlineForm('${d.id}')">Editar</button>
                <button class="btn btn-small btn-danger" onclick="deleteDeadline('${d.id}')">×</button>
              </div></td></tr>`;
          }).join('')}
        </tbody></table>
      `:'<div class="empty-state"><div class="empty-state-icon">⏰</div><div class="empty-state-title">Nenhum prazo</div></div>'}
    </div>
    <div class="alert alert-info"><span>ℹ️</span><span><strong>Aviso de validação jurídica:</strong> Todo prazo calculado é resultado de apoio técnico. Valide a regra processual aplicável, o calendário local e a legislação em vigor antes de usar como base para ação processual.</span></div>
  `;
};
SECTION_AFTER.deadlines = () => {
  document.getElementById('dlFilter').onchange = e=>{dlState.filter=e.target.value;renderSection('deadlines');};
  document.getElementById('dlSearch').addEventListener('input', e=>{dlState.search=e.target.value;renderSection('deadlines');document.getElementById('dlSearch').focus();});
};

function openDeadlineForm(id){
  const d = id ? dbGet('deadlines', id) : {status:'pendente', type:'manifestacao', date:toISO(new Date())};
  const procOpts = DB.processes.map(p=>`<option value="${p.id}" ${p.id===d.processId?'selected':''}>${escapeHTML(p.number)}</option>`).join('');
  openModal({ title:id?'Editar prazo':'Novo prazo', body:`
    <div class="form-group"><label class="form-label">Título *</label><input class="form-input" id="f_title" value="${escapeHTML(d.title||'')}" placeholder="Ex: Manifestação sobre laudo"></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Processo *</label><select class="form-select" id="f_processId">${procOpts}</select></div>
      <div class="form-group"><label class="form-label">Tipo</label><select class="form-select" id="f_type"><option value="manifestacao" ${d.type==='manifestacao'?'selected':''}>Manifestação</option><option value="recurso" ${d.type==='recurso'?'selected':''}>Recurso</option><option value="peticao" ${d.type==='peticao'?'selected':''}>Petição</option><option value="audiencia" ${d.type==='audiencia'?'selected':''}>Audiência</option><option value="contestacao" ${d.type==='contestacao'?'selected':''}>Contestação</option></select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Data *</label><input class="form-input" id="f_date" type="date" value="${escapeHTML(d.date)}"></div>
      <div class="form-group"><label class="form-label">Responsável</label><input class="form-input" id="f_responsible" value="${escapeHTML(d.responsible||'')}"></div>
    </div>
    <div class="form-group"><label class="form-label">Status</label><select class="form-select" id="f_status"><option value="pendente" ${d.status==='pendente'?'selected':''}>Pendente</option><option value="concluido" ${d.status==='concluido'?'selected':''}>Concluído</option></select></div>
    <div class="form-group"><label class="form-label">Notas</label><textarea class="form-textarea" id="f_notes">${escapeHTML(d.notes||'')}</textarea></div>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveDeadline('${id||''}')">Salvar</button>` });
}
async function saveDeadline(id){
  const data = {
    title:document.getElementById('f_title').value.trim(),
    processId:document.getElementById('f_processId').value,
    type:document.getElementById('f_type').value,
    date:document.getElementById('f_date').value,
    responsible:document.getElementById('f_responsible').value.trim(),
    status:document.getElementById('f_status').value,
    notes:document.getElementById('f_notes').value.trim()
  };
  if (!data.title||!data.processId||!data.date){ toast('Preencha campos obrigatórios','error'); return; }
  try {
    if (isBackendMode()){
      const saved = await persistDeadline(data, id);
      if (id) dbUpdate('deadlines', id, saved); else dbCreate('deadlines', saved);
    } else if (id) dbUpdate('deadlines', id, data); else dbCreate('deadlines', data);
  } catch(err){
    toast(apiErrorMessage(err),'error');
    return;
  }
  toast('Prazo salvo','success'); closeModal(); renderSection('deadlines'); renderNotifications();
}
async function completeDeadline(id){
  if (isBackendMode()){
    const current = dbGet('deadlines', id);
    try {
      const saved = await persistDeadline({ ...current, status:'concluido' }, id);
      dbUpdate('deadlines', id, saved);
    } catch(err){
      toast(apiErrorMessage(err),'error');
      return;
    }
  } else {
    dbUpdate('deadlines', id, {status:'concluido'});
  }
  toast('Prazo concluído','success'); renderSection('deadlines'); renderNotifications();
}
async function deleteDeadline(id){
  if (!confirm('Excluir prazo?')) return;
  if (isBackendMode()){
    try { await backendApi(`/deadlines/${id}`, { method:'DELETE' }); }
    catch(err){ toast(apiErrorMessage(err),'error'); return; }
  }
  dbDelete('deadlines', id); toast('Prazo excluído','success'); renderSection('deadlines');
}

// ============================================================
//                        AGENDA
// ============================================================
const agState = { view:'dia', date: toISO(new Date()) };
SECTION_RENDERERS.agenda = () => {
  return `
    <h1 class="page-title">Agenda</h1>
    <p class="page-subtitle">Calendário de compromissos e eventos</p>
    <div class="panel">
      <div class="filter-bar">
        <div class="pill-group">
          <div class="pill ${agState.view==='dia'?'active':''}" data-view="dia">Dia</div>
          <div class="pill ${agState.view==='semana'?'active':''}" data-view="semana">Semana</div>
          <div class="pill ${agState.view==='mes'?'active':''}" data-view="mes">Mês</div>
          <div class="pill ${agState.view==='lista'?'active':''}" data-view="lista">Lista</div>
        </div>
        <input type="date" class="form-input" id="agDate" value="${escapeHTML(agState.date)}">
        <button class="btn btn-primary" onclick="openAppointmentForm()">+ Novo compromisso</button>
      </div>
      <div id="agView"></div>
    </div>
  `;
};
SECTION_AFTER.agenda = () => {
  document.querySelectorAll('.pill[data-view]').forEach(p=>p.onclick=()=>{agState.view=p.dataset.view;renderSection('agenda');});
  document.getElementById('agDate').onchange = e=>{agState.date=e.target.value;renderSection('agenda');};
  renderAgendaView();
};

function renderAgendaView(){
  const v = document.getElementById('agView');
  if (agState.view==='dia') v.innerHTML = renderAgendaDay(agState.date);
  else if (agState.view==='semana') v.innerHTML = renderAgendaWeek(agState.date);
  else if (agState.view==='mes') v.innerHTML = renderAgendaMonth(agState.date);
  else v.innerHTML = renderAgendaList();
}

function renderAgendaDay(iso){
  const appts = DB.appointments.filter(a=>a.date===iso).sort((a,b)=>(a.time||'').localeCompare(b.time||''));
  const deads = DB.deadlines.filter(d=>d.date===iso);
  return `<h3 style="margin-bottom:14px">${fmtDate(iso)}</h3>
    ${appts.length?appts.map(a=>{
      const cli = dbGet('clients',a.clientId);
      const colorMap = {reuniao:'teal-accent', audiencia:'gold-accent', prazo:'warning', atendimento:'info'};
      return `<div style="padding:12px;background:var(--obsidian);border-radius:6px;margin-bottom:8px;border-left:3px solid var(--${colorMap[a.type]||'teal-accent'});cursor:pointer" onclick="openAppointmentForm('${a.id}')">
        <div style="font-weight:600">${escapeHTML(a.time||'')} — ${escapeHTML(a.title)}</div>
        <div class="text-muted" style="font-size:12px;margin-top:4px">${escapeHTML(cli?.name||'')} ${cli&&a.location?'|':''} ${escapeHTML(a.location||'')}</div>
        ${a.notes?`<div class="text-muted" style="font-size:11px;margin-top:4px">${escapeHTML(a.notes)}</div>`:''}
      </div>`;
    }).join(''):'<div class="text-muted">Nenhum compromisso</div>'}
    ${deads.length?`<h4 style="margin:16px 0 8px;color:var(--gold-accent)">Prazos no dia</h4>${deads.map(d=>{const p=dbGet('processes',d.processId);return `<div style="padding:8px;background:var(--obsidian);border-radius:4px;margin-bottom:4px">⏰ ${escapeHTML(d.title)} — ${escapeHTML(p?.number||'')}</div>`;}).join('')}`:''}`;
}
function renderAgendaWeek(iso){
  const d = fromISO(iso);
  const monday = new Date(d); monday.setDate(d.getDate() - d.getDay());
  let html = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px">';
  for (let i=0;i<7;i++){
    const day = new Date(monday); day.setDate(monday.getDate()+i);
    const dayISO = toISO(day);
    const dayAppts = DB.appointments.filter(a=>a.date===dayISO);
    const dayDeads = DB.deadlines.filter(x=>x.date===dayISO);
    html += `<div style="background:var(--obsidian);border-radius:6px;padding:8px;min-height:120px">
      <div style="font-weight:700;font-size:12px;margin-bottom:6px;color:${dayISO===toISO(new Date())?'var(--teal-accent)':'var(--text-primary)'}">${['Dom','Seg','Ter','Qua','Qui','Sex','Sab'][day.getDay()]} ${day.getDate()}</div>
      ${dayAppts.map(a=>`<div style="font-size:10px;padding:3px 5px;background:var(--obsidian-lighter);border-radius:3px;margin-bottom:3px;cursor:pointer" onclick="openAppointmentForm('${a.id}')">${escapeHTML(a.time)} ${escapeHTML(a.title.slice(0,18))}</div>`).join('')}
      ${dayDeads.map(d=>`<div style="font-size:10px;padding:3px 5px;background:rgba(212,169,116,.2);border-radius:3px;margin-bottom:3px">⏰ ${escapeHTML(d.title.slice(0,18))}</div>`).join('')}
    </div>`;
  }
  return html+'</div>';
}
function renderAgendaMonth(iso){
  const target = fromISO(iso);
  calendarState = { year: target.getFullYear(), month: target.getMonth() };
  const div = document.createElement('div');
  renderMiniCalendar(div);
  return div.innerHTML;
}
function renderAgendaList(){
  const all = [...DB.appointments.map(a=>({...a,_kind:'apt'})),...DB.deadlines.map(d=>({...d,_kind:'dl'}))].sort((a,b)=>a.date.localeCompare(b.date));
  return `<table><thead><tr><th>Data</th><th>Hora</th><th>Tipo</th><th>Título</th><th>Cliente/Processo</th><th>Status</th></tr></thead><tbody>
    ${all.map(e=>{
      const cli = e._kind==='apt'?dbGet('clients',e.clientId):null;
      const proc = dbGet('processes', e.processId);
      return `<tr><td>${fmtDate(e.date)}</td><td>${escapeHTML(e.time||'—')}</td><td>${e._kind==='apt'?e.type:'prazo'}</td><td>${escapeHTML(e.title)}</td><td>${escapeHTML(cli?.name||proc?.number||'—')}</td><td><span class="status-chip ${e.status==='concluido'?'completed':'pending'}">${escapeHTML(e.status)}</span></td></tr>`;
    }).join('')}
  </tbody></table>`;
}

function openAppointmentForm(id){
  const a = id?dbGet('appointments',id):{status:'confirmado',type:'reuniao',date:toISO(new Date()),time:'09:00'};
  const cliOpts = DB.clients.map(c=>`<option value="${c.id}" ${c.id===a.clientId?'selected':''}>${escapeHTML(c.name)}</option>`).join('');
  const procOpts = DB.processes.map(p=>`<option value="${p.id}" ${p.id===a.processId?'selected':''}>${escapeHTML(p.number)}</option>`).join('');
  openModal({ title:id?'Editar compromisso':'Novo compromisso', body:`
    <div class="form-group"><label class="form-label">Título *</label><input class="form-input" id="f_title" value="${escapeHTML(a.title||'')}"></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Data *</label><input class="form-input" id="f_date" type="date" value="${escapeHTML(a.date)}"></div>
      <div class="form-group"><label class="form-label">Hora</label><input class="form-input" id="f_time" type="time" value="${escapeHTML(a.time||'')}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Tipo</label><select class="form-select" id="f_type"><option value="reuniao" ${a.type==='reuniao'?'selected':''}>Reunião</option><option value="audiencia" ${a.type==='audiencia'?'selected':''}>Audiência</option><option value="prazo" ${a.type==='prazo'?'selected':''}>Prazo</option><option value="atendimento" ${a.type==='atendimento'?'selected':''}>Atendimento</option></select></div>
      <div class="form-group"><label class="form-label">Status</label><select class="form-select" id="f_status"><option value="confirmado" ${a.status==='confirmado'?'selected':''}>Confirmado</option><option value="pendente" ${a.status==='pendente'?'selected':''}>Pendente</option><option value="concluido" ${a.status==='concluido'?'selected':''}>Concluído</option><option value="cancelado" ${a.status==='cancelado'?'selected':''}>Cancelado</option></select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Cliente</label><select class="form-select" id="f_clientId"><option value="">—</option>${cliOpts}</select></div>
      <div class="form-group"><label class="form-label">Processo</label><select class="form-select" id="f_processId"><option value="">—</option>${procOpts}</select></div>
    </div>
    <div class="form-group"><label class="form-label">Local</label><input class="form-input" id="f_location" value="${escapeHTML(a.location||'')}"></div>
    <div class="form-group"><label class="form-label">Notas</label><textarea class="form-textarea" id="f_notes">${escapeHTML(a.notes||'')}</textarea></div>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>${id?`<button class="btn btn-danger" onclick="deleteAppointment('${id}')">Excluir</button>`:''}<button class="btn btn-primary" onclick="saveAppointment('${id||''}')">Salvar</button>` });
}
async function saveAppointment(id){
  const data = {
    title:document.getElementById('f_title').value.trim(),
    date:document.getElementById('f_date').value,
    time:document.getElementById('f_time').value,
    type:document.getElementById('f_type').value,
    status:document.getElementById('f_status').value,
    clientId:document.getElementById('f_clientId').value||null,
    processId:document.getElementById('f_processId').value||null,
    location:document.getElementById('f_location').value.trim(),
    notes:document.getElementById('f_notes').value.trim()
  };
  if (!data.title||!data.date){ toast('Preencha campos obrigatórios','error'); return; }
  try {
    if (isBackendMode()){
      const saved = await persistAppointment(data, id);
      if (id) dbUpdate('appointments', id, saved); else dbCreate('appointments', saved);
    } else if (id) dbUpdate('appointments', id, data); else dbCreate('appointments', data);
  } catch(err){
    toast(apiErrorMessage(err),'error');
    return;
  }
  toast('Compromisso salvo','success'); closeModal(); renderSection('agenda');
}
async function deleteAppointment(id){
  if (!confirm('Excluir compromisso?')) return;
  if (isBackendMode()){
    try { await backendApi(`/appointments/${id}`, { method:'DELETE' }); }
    catch(err){ toast(apiErrorMessage(err),'error'); return; }
  }
  dbDelete('appointments', id);
  toast('Compromisso excluído','success');
  closeModal();
  renderSection('agenda');
}

// ============================================================
//                        INTIMATIONS
// ============================================================
const intState = { tab:'recebidas' };
SECTION_RENDERERS.intimations = () => {
  const tabs = ['recebidas','triagem','associadas','erro','concluidas'];
  return `
    <h1 class="page-title">Intimações</h1>
    <p class="page-subtitle">Caixa de entrada de intimações e correspondências oficiais</p>
    <div class="panel">
      <div class="tabs">${tabs.map(t=>`<button class="tab ${intState.tab===t?'active':''}" data-tab="${t}">${t.charAt(0).toUpperCase()+t.slice(1)}</button>`).join('')}</div>
      <div class="filter-bar"><button class="btn btn-primary" onclick="openIntimationForm()">+ Nova intimação manual</button></div>
      <div id="intTabContent"></div>
    </div>
    <div class="alert alert-info"><span>ℹ️</span><span><strong>Agentes supervisionados:</strong> Agentes automatizados podem sugerir associação, prazo e organização. Toda ação jurídica exige confirmação humana explícita.</span></div>
  `;
};
SECTION_AFTER.intimations = () => {
  document.querySelectorAll('.tab[data-tab]').forEach(t=>t.onclick=()=>{intState.tab=t.dataset.tab;renderSection('intimations');});
  renderIntimationsTab();
};

function renderIntimationsTab(){
  let list = DB.intimations;
  if (intState.tab==='recebidas') list = list.filter(i=>i.status==='recebida');
  else if (intState.tab==='triagem') list = list.filter(i=>i.status==='triagem');
  else if (intState.tab==='associadas') list = list.filter(i=>i.status==='associada');
  else if (intState.tab==='erro') list = list.filter(i=>i.status==='erro');
  else if (intState.tab==='concluidas') list = list.filter(i=>i.status==='concluida');

  const html = list.length ? `<table><thead><tr><th>Conteúdo</th><th>Fonte</th><th>Tipo</th><th>Recebido</th><th>Processo</th><th>Confiança</th><th>Ações</th></tr></thead><tbody>
    ${list.map(i=>{
      const p = dbGet('processes', i.processId);
      return `<tr>
        <td>${escapeHTML(i.content.slice(0,70))}${i.content.length>70?'…':''}</td>
        <td>${escapeHTML(i.source)}</td><td>${escapeHTML(i.type)}</td><td>${fmtDateTime(i.receivedAt)}</td>
        <td style="font-family:'JetBrains Mono';font-size:11px">${escapeHTML(p?.number||'—')}</td>
        <td><span class="status-chip ${i.confidence==='alta'?'active':'pending'}">${escapeHTML(i.confidence)}</span></td>
        <td><div class="row-actions">
          <button class="btn btn-small btn-secondary" onclick="showIntimationDetail('${i.id}')">Revisar</button>
          ${!i.processId?`<button class="btn btn-small btn-primary" onclick="openIntimationForm('${i.id}')">Associar</button>`:''}
          ${i.processId&&i.status!=='concluida'?`<button class="btn btn-small btn-primary" onclick="lancarIntimacaoNoAndamento('${i.id}')" title="Cria andamento + prazo + compromisso">⚡ Lançar</button>`:''}
          ${i.status!=='concluida'?`<button class="btn btn-small btn-primary" onclick="concludeIntimation('${i.id}')">Concluir</button>`:''}
        </div></td></tr>`;
    }).join('')}
  </tbody></table>` : `<div class="empty-state"><div class="empty-state-icon">📧</div><div class="empty-state-title">Sem intimações nesta categoria</div></div>`;
  document.getElementById('intTabContent').innerHTML = html;
}

function showIntimationDetail(id){
  const i = dbGet('intimations', id);
  const p = dbGet('processes', i.processId);
  openModal({ title:'Revisar intimação', body:`
    <div class="detail-row"><span class="detail-label">Fonte:</span><span class="detail-value">${escapeHTML(i.source)}</span></div>
    <div class="detail-row"><span class="detail-label">Tipo:</span><span class="detail-value">${escapeHTML(i.type)}</span></div>
    <div class="detail-row"><span class="detail-label">Recebido:</span><span class="detail-value">${fmtDateTime(i.receivedAt)}</span></div>
    <div class="detail-row"><span class="detail-label">Processo:</span><span class="detail-value">${escapeHTML(p?.number||'(não associada)')}</span></div>
    <div class="detail-row"><span class="detail-label">Confiança:</span><span class="detail-value">${escapeHTML(i.confidence)}</span></div>
    <div class="detail-row"><span class="detail-label">Status:</span><span class="detail-value">${escapeHTML(i.status)}</span></div>
    <h4 style="margin:16px 0 6px">Conteúdo</h4>
    <div style="padding:12px;background:var(--obsidian);border-radius:6px">${escapeHTML(i.content)}</div>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Fechar</button><button class="btn btn-primary" onclick="closeModal();openIntimationForm('${id}')">Editar</button>` });
}
function openIntimationForm(id){
  const i = id?dbGet('intimations',id):{source:'Manual',type:'intimacao',confidence:'media',status:'triagem',receivedAt:Date.now()};
  const procOpts = DB.processes.map(p=>`<option value="${p.id}" ${p.id===i.processId?'selected':''}>${escapeHTML(p.number)}</option>`).join('');
  openModal({ title:id?'Editar intimação':'Nova intimação', body:`
    <div class="form-row">
      <div class="form-group"><label class="form-label">Fonte</label><select class="form-select" id="f_source"><option ${i.source==='DJe SP'?'selected':''}>DJe SP</option><option ${i.source==='API CNJ'?'selected':''}>API CNJ</option><option ${i.source==='Manual'?'selected':''}>Manual</option><option ${i.source==='E-mail'?'selected':''}>E-mail</option></select></div>
      <div class="form-group"><label class="form-label">Tipo</label><select class="form-select" id="f_type"><option value="intimacao" ${i.type==='intimacao'?'selected':''}>Intimação</option><option value="decisao" ${i.type==='decisao'?'selected':''}>Decisão</option><option value="andamento" ${i.type==='andamento'?'selected':''}>Andamento</option><option value="despacho" ${i.type==='despacho'?'selected':''}>Despacho</option></select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Processo</label><select class="form-select" id="f_processId"><option value="">— não associar —</option>${procOpts}</select></div>
      <div class="form-group"><label class="form-label">Status</label><select class="form-select" id="f_status"><option value="recebida" ${i.status==='recebida'?'selected':''}>Recebida</option><option value="triagem" ${i.status==='triagem'?'selected':''}>Triagem</option><option value="associada" ${i.status==='associada'?'selected':''}>Associada</option><option value="concluida" ${i.status==='concluida'?'selected':''}>Concluída</option></select></div>
    </div>
    <div class="form-row"><div class="form-group"><label class="form-label" for="f_receivedAt">Recebido em *</label><input class="form-input" id="f_receivedAt" type="datetime-local" value="${toLocalISO(new Date(i.receivedAt)).slice(0,16)}"></div><div class="form-group"><label class="form-label" for="f_confidence">Confiança atribuída na revisão</label><select class="form-select" id="f_confidence"><option value="baixa" ${i.confidence==='baixa'?'selected':''}>Baixa</option><option value="media" ${i.confidence==='media'?'selected':''}>Média</option><option value="alta" ${i.confidence==='alta'?'selected':''}>Alta</option></select></div></div>
    <div class="form-group"><label class="form-label">Conteúdo *</label><textarea class="form-textarea" id="f_content" style="min-height:120px">${escapeHTML(i.content||'')}</textarea></div>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveIntimation('${id||''}')">Salvar</button>` });
}
async function saveIntimation(id){
  const pid = document.getElementById('f_processId').value || null;
  const data = {
    source:document.getElementById('f_source').value,
    type:document.getElementById('f_type').value,
    processId: pid,
    status: pid ? (document.getElementById('f_status').value==='triagem'?'associada':document.getElementById('f_status').value) : document.getElementById('f_status').value,
    confidence:document.getElementById('f_confidence').value,
    content:document.getElementById('f_content').value.trim(),
    receivedAt:new Date(document.getElementById('f_receivedAt').value).toISOString()
  };
  if (!data.content){ toast('Conteúdo obrigatório','error'); return; }
  try {
    if (isBackendMode()){
      const saved = await persistIntimation(data, id);
      if (id) dbUpdate('intimations', id, saved); else dbCreate('intimations', saved);
    } else if (id) dbUpdate('intimations', id, data); else dbCreate('intimations', data);
  } catch(err){
    toast(apiErrorMessage(err),'error');
    return;
  }
  toast('Intimação salva','success'); closeModal(); renderSection('intimations'); renderNotifications();
}
async function concludeIntimation(id){
  if (isBackendMode()){
    const current = dbGet('intimations', id);
    try {
      const saved = await persistIntimation({ ...current, status:'concluida' }, id);
      dbUpdate('intimations', id, saved);
    } catch(err){
      toast(apiErrorMessage(err),'error');
      return;
    }
  } else {
    dbUpdate('intimations', id, {status:'concluida'});
  }
  toast('Intimação concluída','success'); renderSection('intimations'); renderNotifications();
}

// ============================================================
//                        FINANCIAL
// ============================================================
const finState = { type:'todos', status:'todos' };
SECTION_RENDERERS.financial = () => {
  const filtered = DB.financial.filter(f=>{
    if (finState.type!=='todos' && f.type!==finState.type) return false;
    if (finState.status!=='todos' && f.status!==finState.status) return false;
    return true;
  }).sort((a,b)=>b.date.localeCompare(a.date));

  const month = new Date().getMonth(), year = new Date().getFullYear();
  const monthData = DB.financial.filter(f=>{const d=fromISO(f.date);return d.getMonth()===month && d.getFullYear()===year;});
  const monthReceitas = monthData.filter(f=>f.type==='receita' && f.status==='recebido').reduce((s,f)=>s+f.amount,0);
  const monthDespesas = monthData.filter(f=>f.type==='despesa' && f.status==='pago').reduce((s,f)=>s+f.amount,0);

  // Bar chart: últimos 6 meses
  const bars = [];
  for (let i=5;i>=0;i--){
    const d = new Date(); d.setMonth(d.getMonth()-i);
    const m = d.getMonth(), y = d.getFullYear();
    const sum = DB.financial.filter(f=>{const x=fromISO(f.date);return x.getMonth()===m&&x.getFullYear()===y && f.type==='receita' && f.status==='recebido';}).reduce((s,f)=>s+f.amount,0);
    bars.push({label:d.toLocaleString('pt-BR',{month:'short'}), value:sum});
  }
  const maxBar = Math.max(...bars.map(b=>b.value), 1);

  return `
    <h1 class="page-title">Financeiro</h1>
    <p class="page-subtitle">Controle de receitas, despesas e fluxo de caixa</p>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-label">Receitas (mês)</div><div class="kpi-value" style="color:var(--success);font-size:22px">${fmtMoney(monthReceitas)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Despesas (mês)</div><div class="kpi-value" style="color:var(--danger);font-size:22px">${fmtMoney(monthDespesas)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Saldo líquido</div><div class="kpi-value" style="color:var(--teal-accent);font-size:22px">${fmtMoney(monthReceitas-monthDespesas)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Total a receber</div><div class="kpi-value" style="color:var(--gold-accent);font-size:22px">${fmtMoney(DB.financial.filter(f=>f.status==='previsto').reduce((s,f)=>s+f.amount,0))}</div></div>
    </div>
    <div class="grid-2x2">
      <div class="panel">
        <div class="panel-title">Receitas últimos 6 meses</div>
        <div class="chart-bars">
          ${bars.map(b=>`<div class="chart-bar" style="height:${(b.value/maxBar)*100}%">
            <div class="chart-bar-value">${fmtMoney(b.value)}</div>
            <div class="chart-bar-label">${b.label}</div>
          </div>`).join('')}
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">Contas a receber</div>
        <table style="font-size:12px"><thead><tr><th>Cliente</th><th>Valor</th><th>Vencimento</th><th>Status</th></tr></thead><tbody>
          ${DB.financial.filter(f=>f.type==='receita'&&(f.status==='previsto'||f.status==='vencido')).sort((a,b)=>a.date.localeCompare(b.date)).map(f=>{
            const cli = dbGet('clients', f.clientId);
            return `<tr><td>${escapeHTML(cli?.name||'—')}</td><td style="font-weight:700">${fmtMoney(f.amount)}</td><td>${fmtDate(f.date)}</td><td><span class="status-chip ${f.status==='vencido'?'critical':'active'}">${escapeHTML(f.status)}</span></td></tr>`;
          }).join('')}
        </tbody></table>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">Lançamentos <button class="btn btn-primary btn-small" onclick="openFinancialForm()">+ Novo lançamento</button></div>
      <div class="filter-bar">
        <select class="form-select" id="finType"><option value="todos">Tipo: Todos</option><option value="receita" ${finState.type==='receita'?'selected':''}>Receita</option><option value="despesa" ${finState.type==='despesa'?'selected':''}>Despesa</option></select>
        <select class="form-select" id="finStatus"><option value="todos">Status: Todos</option><option value="recebido">Recebido</option><option value="pago">Pago</option><option value="previsto">Previsto</option><option value="vencido">Vencido</option></select>
      </div>
      <table><thead><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Cliente</th><th>Categoria</th><th>Valor</th><th>Status</th><th></th></tr></thead><tbody>
        ${filtered.map(f=>{const cli=dbGet('clients',f.clientId);return `<tr>
          <td>${fmtDate(f.date)}</td>
          <td><span class="badge ${f.type==='receita'?'badge-primary':'badge-warning'}">${escapeHTML(f.type)}</span></td>
          <td>${escapeHTML(f.description)}</td><td>${escapeHTML(cli?.name||'—')}</td><td>${f.category||'—'}</td>
          <td style="font-weight:700;color:${f.type==='receita'?'var(--success)':'var(--danger)'}">${fmtMoney(f.amount)}</td>
          <td><span class="status-chip ${f.status==='recebido'||f.status==='pago'?'active':f.status==='vencido'?'critical':'pending'}">${escapeHTML(f.status)}</span></td>
          <td><div class="row-actions"><button class="btn btn-small btn-secondary" onclick="openFinancialForm('${f.id}')">Editar</button><button class="btn btn-small btn-danger" onclick="deleteFinancial('${f.id}')">×</button></div></td>
        </tr>`;}).join('')}
      </tbody></table>
    </div>
  `;
};
SECTION_AFTER.financial = () => {
  document.getElementById('finType').onchange = e=>{finState.type=e.target.value;renderSection('financial');};
  document.getElementById('finStatus').onchange = e=>{finState.status=e.target.value;renderSection('financial');};
};
function openFinancialForm(id){
  const f = id?dbGet('financial',id):{type:'receita',status:'previsto',category:'honorarios',date:toISO(new Date())};
  const cliOpts = DB.clients.map(c=>`<option value="${c.id}" ${c.id===f.clientId?'selected':''}>${escapeHTML(c.name)}</option>`).join('');
  const procOpts = DB.processes.map(p=>`<option value="${p.id}" ${p.id===f.processId?'selected':''}>${escapeHTML(p.number)}</option>`).join('');
  openModal({ title:id?'Editar lançamento':'Novo lançamento', body:`
    <div class="form-row">
      <div class="form-group"><label class="form-label">Tipo</label><select class="form-select" id="f_type"><option value="receita" ${f.type==='receita'?'selected':''}>Receita</option><option value="despesa" ${f.type==='despesa'?'selected':''}>Despesa</option></select></div>
      <div class="form-group"><label class="form-label">Data *</label><input class="form-input" id="f_date" type="date" value="${escapeHTML(f.date)}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Valor (R$) *</label><input class="form-input" id="f_amount" type="number" step="0.01" value="${f.amount||0}"></div>
      <div class="form-group"><label class="form-label">Status</label><select class="form-select" id="f_status"><option value="previsto" ${f.status==='previsto'?'selected':''}>Previsto</option><option value="recebido" ${f.status==='recebido'?'selected':''}>Recebido</option><option value="pago" ${f.status==='pago'?'selected':''}>Pago</option><option value="vencido" ${f.status==='vencido'?'selected':''}>Vencido</option></select></div>
    </div>
    <div class="form-group"><label class="form-label">Descrição *</label><input class="form-input" id="f_description" value="${escapeHTML(f.description||'')}"></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Cliente</label><select class="form-select" id="f_clientId"><option value="">—</option>${cliOpts}</select></div>
      <div class="form-group"><label class="form-label">Processo</label><select class="form-select" id="f_processId"><option value="">—</option>${procOpts}</select></div>
    </div>
    <div class="form-group"><label class="form-label">Categoria</label><select class="form-select" id="f_category"><option value="honorarios" ${f.category==='honorarios'?'selected':''}>Honorários</option><option value="custas" ${f.category==='custas'?'selected':''}>Custas</option><option value="despesa_operacional" ${f.category==='despesa_operacional'?'selected':''}>Despesa Operacional</option><option value="outro" ${f.category==='outro'?'selected':''}>Outro</option></select></div>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>${id?`<button class="btn btn-danger" onclick="deleteFinancial('${id}')">Excluir</button>`:''}<button class="btn btn-primary" onclick="saveFinancial('${id||''}')">Salvar</button>` });
}
async function saveFinancial(id){
  const data = {
    type:document.getElementById('f_type').value,
    date:document.getElementById('f_date').value,
    amount:parseFloat(document.getElementById('f_amount').value)||0,
    status:document.getElementById('f_status').value,
    description:document.getElementById('f_description').value.trim(),
    clientId:document.getElementById('f_clientId').value||null,
    processId:document.getElementById('f_processId').value||null,
    category:document.getElementById('f_category').value
  };
  if (!data.description||!data.amount){ toast('Descrição e valor são obrigatórios','error'); return; }
  try {
    if (isBackendMode()){
      const saved = await persistFinancial(data, id);
      if (id) dbUpdate('financial', id, saved); else dbCreate('financial', saved);
    } else if (id) dbUpdate('financial', id, data); else dbCreate('financial', data);
  } catch(err){
    toast(apiErrorMessage(err),'error');
    return;
  }
  toast('Lançamento salvo','success'); closeModal(); renderSection('financial'); renderNotifications();
}
async function deleteFinancial(id){
  if (!confirm('Excluir lançamento?')) return;
  if (isBackendMode()){
    try { await backendApi(`/financial-entries/${id}`, { method:'DELETE' }); }
    catch(err){ toast(apiErrorMessage(err),'error'); return; }
  }
  dbDelete('financial', id);
  toast('Excluído','success');
  closeModal();
  renderSection('financial');
  renderNotifications();
}

// ============================================================
//                        BILLING
// ============================================================
const billingUiState = { pendingAction:null };

function normalizeLimit(limit){ return limit == null ? null : Math.max(limit, 0); }
function calculateUsagePercent(current, limit){
  if (limit == null || !Number.isFinite(limit) || limit <= 0) return 0;
  return (current / limit) * 100;
}
function formatUsageValue(current, limit, kind='count'){
  if (kind === 'bytes') return `${formatBytes(current)} / ${formatBytes(limit)}`;
  return `${current} / ${limit == null ? 'Personalizado' : limit}`;
}
function renderUsageCard({title, current, limit, kind='count', description, action}){
  const percent = calculateUsagePercent(current, limit);
  const stateClass = limit == null ? '' : getUsageStatusClass(percent);
  const chipClass = stateClass === 'warn' ? 'pending' : (stateClass || 'active');
  const stateLabel = limit == null ? 'Personalizado' : getUsageStateLabel(percent);
  const actionLabel = limit == null ? 'Sob contrato' : percent >= 100 ? action.limit : percent >= 80 ? action.warn : action.normal;
  return `
    <div class="usage-card">
      <div class="usage-head">
        <div>
          <div class="usage-title">${title}</div>
          <div class="usage-meta">${description}</div>
        </div>
        <div class="usage-value">${formatUsageValue(current, limit, kind)}</div>
      </div>
      <div class="usage-bar"><div class="usage-bar-fill ${stateClass}" style="width:${Math.min(percent, 100)}%"></div></div>
      <div class="usage-actions">
        <span class="status-chip ${chipClass}">${stateLabel} ${limit == null ? '' : `• ${formatPercent(percent)}`}</span>
        <span class="usage-hint">${actionLabel}</span>
      </div>
    </div>
  `;
}

function openCreditConsumptionModal(operationKey, options = {}){
  billingUiState.pendingAction = async () => {
    closeModal();
    if (typeof options.onConfirmed === 'function') await options.onConfirmed({ok:true,creditsConsumed:0});
  };
  openModal({title:'Confirmar operação',
    body:`<p>${escapeHTML(options.description || 'Executar a operação com os dados informados?')}</p>`,
    footer:'<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="executePendingBillingAction()">Confirmar</button>'});
  return true;
}
async function executePendingBillingAction(){
  const action = billingUiState.pendingAction;
  billingUiState.pendingAction = null;
  if (action) { try { await action(); } catch(error) { toast(apiErrorMessage(error),'error'); } }
}

SECTION_RENDERERS.billing = () => window.SemperfiCommercial?.render() || `
  <h1 class="page-title">Plano & Consumo</h1>
  <p class="page-subtitle">Informações comerciais da organização</p>
  <div class="panel empty-state"><div class="empty-state-icon">◇</div>
    <h2 class="empty-state-title">Nenhum plano configurado</h2>
    <p>Assinaturas, créditos e diligências estarão disponíveis após a integração comercial.</p>
    <p class="text-muted">Não há cobranças, saldos ou pagamentos registrados nesta versão.</p>
  </div>`;
SECTION_AFTER.billing = () => window.SemperfiCommercial?.mount();

// ============================================================
//                        QUERIES (Consultas Públicas)
// ============================================================
const queryState = { kind:'cnpj', result:null, loading:false };
SECTION_RENDERERS.queries = () => `
  <h1 class="page-title">Consultas Públicas</h1>
  <p class="page-subtitle">Integração com BrasilAPI (CEP, CNPJ, Bancos) e fontes públicas</p>
  <div class="panel">
    <h3 style="margin-bottom:14px">Tipo de consulta</h3>
    <div class="pill-group mb-20">
      <div class="pill ${queryState.kind==='cnpj'?'active':''}" data-kind="cnpj">🏢 CNPJ (BrasilAPI)</div>
      <div class="pill ${queryState.kind==='cep'?'active':''}" data-kind="cep">📮 CEP (BrasilAPI)</div>
      <div class="pill ${queryState.kind==='banco'?'active':''}" data-kind="banco">🏦 Banco (BrasilAPI)</div>
      <div class="pill ${queryState.kind==='ddd'?'active':''}" data-kind="ddd">📞 DDD (BrasilAPI)</div>
      <div class="pill ${queryState.kind==='feriados'?'active':''}" data-kind="feriados">🗓 Feriados (BrasilAPI)</div>
    </div>
    <div id="queryForm"></div>
    <div id="queryResult" class="mt-20"></div>
    <div class="alert alert-warning mt-20"><span>⚠️</span><span><strong>Ética e LGPD:</strong> Consultas realizadas com finalidade legítima profissional. Dados de PJ são públicos (Receita Federal). Não realize scraping, contorno de CAPTCHA ou acesso a dados privados sem autorização.</span></div>
  </div>
`;
SECTION_AFTER.queries = () => {
  document.querySelectorAll('.pill[data-kind]').forEach(p=>p.onclick=()=>{if(queryState.loading)return;queryState.runId=null;queryState.kind=p.dataset.kind;queryState.result=null;renderSection('queries');});
  renderQueryForm();
};
function renderQueryForm(){
  const formEl = document.getElementById('queryForm');
  if (!formEl) return;
  const inputs = {
    cnpj: {label:'CNPJ', placeholder:'00.000.000/0001-00', help:'Apenas números ou formato com pontuação'},
    cep: {label:'CEP', placeholder:'00000-000', help:'Endereço completo'},
    banco: {label:'Código do banco', placeholder:'001', help:'Código COMPE (3 dígitos)'},
    ddd: {label:'DDD', placeholder:'11', help:'2 dígitos'},
    feriados: {label:'Ano', placeholder:'2026', help:'Feriados nacionais brasileiros'}
  };
  const i = inputs[queryState.kind];
  formEl.innerHTML = `
    <div class="form-group"><label class="form-label">${i.label}</label><input class="form-input" id="queryInput" value="${escapeHTML(queryState.value || '')}" placeholder="${i.placeholder}"><div class="text-muted" style="font-size:11px;margin-top:4px">${i.help}</div></div>
    <div class="form-group"><label class="form-label">Finalidade</label><input class="form-input" id="queryPurpose" value="${escapeHTML(queryState.purpose || '')}" placeholder="Ex: due diligence de cliente, validação de processo"></div>
    <div class="form-group"><label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--text-secondary);cursor:pointer"><input type="checkbox" id="queryConsent" ${queryState.consent ? 'checked' : ''}> Declaro possuir finalidade legítima e autorização quando necessária.</label></div>
    <button class="btn btn-primary" id="btnQuery" ${queryState.loading ? 'disabled' : ''}>${queryState.loading?'<span class="spinner"></span> Consultando...':'Consultar'}</button>
  `;
  document.getElementById('btnQuery').onclick = () => doQuery(false);
  if (queryState.runId && !queryState.loading) {
    const resume = document.createElement('button'); resume.className = 'btn btn-secondary';
    resume.type = 'button'; resume.textContent = 'Acompanhar execução existente';
    resume.onclick = () => doQuery(true); formEl.append(resume);
  }
  const r = document.getElementById('queryResult');
  if (queryState.result) r.innerHTML = renderQueryResult();
}
async function doQuery(resume=false){
  if (queryState.loading) return;
  const val = document.getElementById('queryInput').value.trim();
  const purpose = document.getElementById('queryPurpose').value.trim();
  const consent = document.getElementById('queryConsent').checked;
  if (!resume && !val){ toast('Informe o valor para consulta','error'); return; }
  if (!resume && !consent){ toast('Marque a declaração de finalidade legítima','error'); return; }
  if (!resume && purpose.length < 10){ toast('Descreva a finalidade com pelo menos 10 caracteres.','error'); return; }
  const kind = queryState.kind;
  const kindMap = {cnpj:'cnpj',cep:'cep',banco:'bank',ddd:'ddd',feriados:'holidays'};
  queryState.value=val; queryState.purpose=purpose; queryState.consent=consent;
  queryState.loading=true;
  const button=document.getElementById('btnQuery'); button.disabled=true;
  const options={onProgress(event){
    if(event.runId) queryState.runId=event.runId;
    const current=document.getElementById('btnQuery');
    if(current) current.textContent=event.status==='queued' ? 'Na fila de processamento…' : 'Consultando…';
  }};
  try {
    const result = resume
      ? await window.SemperfiConnectorJobs.resume(backendApi,queryState.runId,options)
      : await window.SemperfiConnectorJobs.run(backendApi,{
          connector_id:'brasilapi',payload:{kind:kindMap[kind],value:val.replace(/\D/g,'')},purpose,
          legal_basis:'legitimo_interesse',authorization_reference:'Consulta autorizada pelo operador na interface SEMPER-FI',
          scope_codes:[kind==='cnpj'||kind==='banco'?'empresarial':'territorial_cadastral'],risk_level:'low'
        },options);
    queryState.result={ok:true,data:result.raw_snapshot ?? result.normalized_result ?? {},at:Date.now(),purpose,runId:result.run_id};
    queryState.runId=null;
    toast('Consulta concluída','success');
  } catch(error){
    const resumable=['TIMEOUT','REQUEST_FAILED','ABORTED'].includes(error.code);
    queryState.runId=resumable ? error.runId || queryState.runId : null;
    queryState.result={ok:false,error:apiErrorMessage(error)+(queryState.runId ? ' A execução pode continuar no servidor. Use Acompanhar execução existente.' : ''),at:Date.now()};
    toast(queryState.result.error,'error');
  } finally { queryState.loading=false; renderQueryForm(); }
}
function renderQueryResult(){
  const result = queryState.result;
  if (!result?.ok) return `<div class="alert alert-danger"><span>${escapeHTML(result?.error || 'Consulta indisponível.')}</span></div>`;
  return `<section class="panel"><h3>Resultado da consulta</h3>${window.SemperfiIntegrations.renderResult(result.data)}</section>`;
}
function enrichPublicQueryResult(){
  toast('O registro de consultas no dossiê ainda não está disponível. Nenhuma consulta foi gravada.', 'warning');
}

// ============================================================
//                        METADATA / FILES
// ============================================================
SECTION_RENDERERS.metadata = () => `
  <h1 class="page-title">Metadados e Arquivos</h1>
  <p class="page-subtitle">Análise local de arquivos com hash SHA-256 e metadados básicos</p>
  <div class="panel mb-20">
    <div class="panel-title">Selecionar arquivos para análise local</div>
    <div class="upload-zone" id="uploadZone">
      <div style="font-size:36px;margin-bottom:8px">📁</div>
      <div style="font-weight:600">Arraste arquivos aqui ou clique para selecionar</div>
      <div class="text-muted" style="font-size:12px;margin-top:8px">PDF, JPG, PNG, TIFF, MP4, MOV (máx. 50 MB por arquivo)</div>
      <input type="file" id="fileInput" multiple style="display:none">
    </div>
    <div id="uploadProgress"></div>
  </div>
  <div class="panel">
    <div class="panel-title">Análises temporárias (${DB.files.length})</div>
    ${DB.files.length?`<table><thead><tr><th>ID</th><th>Nome</th><th>Tipo</th><th>Tamanho</th><th>Hash SHA-256</th><th>Data</th><th></th></tr></thead><tbody>
      ${DB.files.map(f=>`<tr>
        <td style="font-family:'JetBrains Mono';font-size:11px">${f.id}</td>
        <td>${escapeHTML(f.name)}</td><td>${escapeHTML(f.type)}</td><td>${(f.size/1024/1024).toFixed(2)} MB</td>
        <td class="masked" style="font-size:11px" title="${f.hash}">${maskHash(f.hash)}</td>
        <td>${fmtDateTime(f.uploadedAt)}</td>
        <td><div class="row-actions">
          <button class="btn btn-small btn-secondary" onclick="showFileDetail('${f.id}')">Detalhes</button>
          <button class="btn btn-small btn-danger" onclick="if(confirm('Remover esta análise temporária?')){dbDelete('files','${f.id}');toast('Excluído','success');renderSection('metadata');}">×</button>
        </div></td>
      </tr>`).join('')}
    </tbody></table>`:'<div class="empty-state"><div class="empty-state-icon">📂</div><div class="empty-state-title">Sem arquivos</div></div>'}
  </div>
  <div class="alert alert-info mt-20"><span>ℹ️</span><span><strong>Análise local:</strong> o hash SHA-256 identifica o conteúdo selecionado. Esta análise não armazena o arquivo nem cria uma cadeia de custódia.</span></div>
`;
SECTION_AFTER.metadata = () => {
  const zone = document.getElementById('uploadZone');
  const input = document.getElementById('fileInput');
  zone.onclick = () => input.click();
  input.onchange = e => handleFiles(e.target.files);
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('dragover'); };
  zone.ondragleave = () => zone.classList.remove('dragover');
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove('dragover'); handleFiles(e.dataTransfer.files); };
};

function readImageDimensions(file){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    const finish = (error) => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve({width:img.naturalWidth, height:img.naturalHeight});
    };
    const timer = setTimeout(() => finish(new Error('A imagem demorou demais para ser lida.')), 10000);
    img.onload = () => finish();
    img.onerror = () => finish(new Error('Não foi possível ler esta imagem. Confira se o formato é válido.'));
    img.src = url;
  });
}

async function handleFiles(files){
  const prog = document.getElementById('uploadProgress');
  for (const file of files){
    if (file.size > 50*1024*1024){ toast(`${file.name}: arquivo > 50MB`,'error'); continue; }
    prog.innerHTML = `<div style="padding:10px;margin-top:10px;background:var(--obsidian);border-radius:6px"><span class="spinner"></span> Processando ${escapeHTML(file.name)}...</div>`;
    try {
      const buf = await file.arrayBuffer();
      const hashBuf = await crypto.subtle.digest('SHA-256', buf);
      const hash = Array.from(new Uint8Array(hashBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
      const meta = {};
      if (file.type.startsWith('image/')) Object.assign(meta, await readImageDimensions(file));
      dbCreate('files', { name:file.name, type:file.type, size:file.size, hash, uploadedAt:Date.now(), metadata:meta, processId:null, clientId:null });
      toast(`${file.name}: análise temporária concluída`,'info');
    } catch(e){ toast('Erro: '+e.message,'error'); }
  }
  prog.innerHTML = '';
  renderSection('metadata');
}

function showFileDetail(id){
  const f = dbGet('files', id);
  if (!f) { toast('Arquivo não encontrado.', 'warning'); return; }
  openModal({wide:true, title:`Arquivo: ${escapeHTML(f.name)}`, body:`
    <div class="detail-row"><span class="detail-label">Formato:</span><span class="detail-value">${escapeHTML(f.type || 'Não identificado')}</span></div>
    <div class="detail-row"><span class="detail-label">Tamanho:</span><span class="detail-value">${(f.size/1024/1024).toFixed(3)} MB</span></div>
    <div class="detail-row"><span class="detail-label">Analisado em:</span><span class="detail-value">${fmtDateTime(f.uploadedAt)}</span></div>
    ${Object.keys(f.metadata||{}).length ? `<h3 class="mt-20">Informações do arquivo</h3>${Object.entries(f.metadata).map(([key,value])=>`<div class="detail-row"><span class="detail-label">${escapeHTML(({width:'Largura',height:'Altura',error:'Resultado'})[key] || key)}:</span><span class="detail-value">${escapeHTML(value)}</span></div>`).join('')}` : ''}
    <details class="mt-20"><summary>Conferência de integridade</summary><p>Compare este código com o de outra cópia para verificar se os arquivos são idênticos.</p><p style="overflow-wrap:anywhere">SHA-256: <code>${escapeHTML(f.hash)}</code></p></details>
    <p class="mt-20">Esta inspeção é temporária. Para guardar o original, envie o arquivo pelo formulário no início da página Arquivos.</p>`,
    footer:`<button class="btn btn-secondary" onclick="closeModal()">Fechar</button><button class="btn btn-primary" onclick="closeModal();navigateSection('metadata')">Abrir envio de arquivo</button>`});
}

SECTION_RENDERERS.metadata = () => {
  syncCommercialState({persist:false});
  return `
    <h1 class="page-title">Metadados e Arquivos</h1>
    <p class="page-subtitle">Análise local de arquivos com hash SHA-256 e metadados básicos</p>
    <div class="alert alert-info mb-20"><span>ℹ️</span><span>Esta inspeção não salva o arquivo e será descartada ao recarregar. Para guardar o original, use o formulário de envio no início desta página.</span></div>
    <div class="panel mb-20">
      <div class="panel-title">Selecionar arquivos para análise local</div>
      <div class="upload-zone" id="uploadZone">
        <div style="font-size:36px;margin-bottom:8px">📁</div>
        <div style="font-weight:600">Arraste arquivos aqui ou clique para selecionar</div>
        <div class="text-muted" style="font-size:12px;margin-top:8px">PDF, JPG, PNG, TIFF, MP4, MOV (máx. 50 MB por arquivo)</div>
        <input type="file" id="fileInput" multiple style="display:none">
      </div>
      <div id="uploadProgress"></div>
    </div>
    <div class="panel">
      <div class="panel-title">Análises temporárias (${DB.files.length})</div>
      ${DB.files.length?`<table><thead><tr><th>ID</th><th>Nome</th><th>Tipo</th><th>Tamanho</th><th>Hash SHA-256</th><th>Data</th><th></th></tr></thead><tbody>
        ${DB.files.map(f=>`<tr>
          <td style="font-family:'JetBrains Mono';font-size:11px">${f.id}</td>
          <td>${escapeHTML(f.name)}</td><td>${escapeHTML(f.type)}</td><td>${(f.size/1024/1024).toFixed(2)} MB</td>
          <td class="masked" style="font-size:11px" title="${f.hash}">${maskHash(f.hash)}</td>
          <td>${fmtDateTime(f.uploadedAt)}</td>
          <td><div class="row-actions">
            <button class="btn btn-small btn-secondary" onclick="showFileDetail('${f.id}')">Detalhes</button>
            <button class="btn btn-small btn-danger" onclick="if(confirm('Remover esta análise temporária?')){dbDelete('files','${f.id}');syncCommercialState({persist:true});toast('Análise temporária removida','info');renderSection('metadata');}">×</button>
          </div></td>
        </tr>`).join('')}
      </tbody></table>`:'<div class="empty-state"><div class="empty-state-icon">📂</div><div class="empty-state-title">Sem arquivos</div></div>'}
    </div>
    <div class="alert alert-info mt-20"><span>ℹ️</span><span><strong>Análise local:</strong> o hash SHA-256 identifica o conteúdo selecionado. Esta análise não armazena o arquivo nem cria uma cadeia de custódia.</span></div>
  `;
};
SECTION_AFTER.metadata = () => {
  const zone = document.getElementById('uploadZone');
  const input = document.getElementById('fileInput');
  zone.onclick = () => input.click();
  input.onchange = e => handleFiles(e.target.files);
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('dragover'); };
  zone.ondragleave = () => zone.classList.remove('dragover');
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove('dragover'); handleFiles(e.dataTransfer.files); };
};
handleFiles = async function(files){
  if (!ensureSubscriptionActive('A assinatura está em modo leitura. Uploads novos foram bloqueados.')) return;
  const prog = document.getElementById('uploadProgress');
  for (const file of files){
    syncCommercialState({persist:false});
    if (file.size > 50*1024*1024){ toast(`${file.name}: arquivo > 50MB`,'error'); continue; }
    const projected = (DB.usage.evidenceBytes || 0) + file.size;
    if (DB.entitlements.evidenceBytes != null && projected > DB.entitlements.evidenceBytes){
      openUpgradePrompt('Limite de evidências atingido', 'O arquivo excede a capacidade configurada.', 'Consulte o administrador sobre a capacidade disponível antes de prosseguir.');
      break;
    }
    prog.innerHTML = `<div style="padding:10px;margin-top:10px;background:var(--obsidian);border-radius:6px"><span class="spinner"></span> Processando ${escapeHTML(file.name)}...</div>`;
    try {
      const buf = await file.arrayBuffer();
      const hashBuf = await crypto.subtle.digest('SHA-256', buf);
      const hash = Array.from(new Uint8Array(hashBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
      const meta = {};
      if (file.type.startsWith('image/')) Object.assign(meta, await readImageDimensions(file));
      dbCreate('files', { name:file.name, type:file.type, size:file.size, hash, uploadedAt:Date.now(), metadata:meta, processId:null, clientId:null });
      syncCommercialState({persist:true});
      toast(`${file.name}: análise temporária concluída`,'info');
    } catch(e){ toast('Erro: '+e.message,'error'); }
  }
  prog.innerHTML = '';
  renderSection('metadata');
};

// ============================================================
//                        CALCULATORS
// ============================================================
SECTION_RENDERERS.calculators = () => window.SemperfiCalculators.render();
SECTION_AFTER.calculators = () => window.SemperfiCalculators.mount();

// ============================================================
//                        REPORTS
// ============================================================
SECTION_RENDERERS.reports = () => `
  <h1 class="page-title">Relatórios</h1>
  <p class="page-subtitle">Geração e exportação de relatórios operacionais</p>
  <div class="panel">
    <div class="panel-title">Modelos disponíveis</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:14px">
      <button class="btn btn-secondary" onclick="generateReport('processos')">📋 Resumo de Processos</button>
      <button class="btn btn-secondary" onclick="generateReport('prazos')">⏰ Prazos e Agenda</button>
      <button class="btn btn-secondary" onclick="generateReport('financeiro')">💰 Financeiro</button>
      <button class="btn btn-secondary" onclick="generateReport('intimacoes')">📧 Intimações</button>
      <button class="btn btn-secondary" onclick="generateReport('clientes')">👥 Clientes</button>
      <button class="btn btn-secondary" onclick="generateReport('auditoria')">🔐 Auditoria</button>
    </div>
  </div>
  <div class="panel mt-20">
    <div class="panel-title">Exportação rápida</div>
    <div class="filter-bar">
      <button class="btn btn-primary" onclick="exportCSV('clients')">📤 Clientes (CSV)</button>
      <button class="btn btn-primary" onclick="exportCSV('processes')">📤 Processos (CSV)</button>
      <button class="btn btn-primary" onclick="exportCSV('deadlines')">📤 Prazos (CSV)</button>
      <button class="btn btn-primary" onclick="exportCSV('financial')">📤 Financeiro (CSV)</button>
      <button class="btn btn-secondary" onclick="exportAllJSON()">💾 Exportar dados carregados (JSON)</button>
    </div>
  </div>
`;

function generateReport(kind){
  if (kind === 'auditoria') return window.SemperfiAudit.printReport();
  const now = new Date().toLocaleString('pt-BR');
  let html = `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório ${escapeHTML(kind)}</title><style>body{font-family:Arial,sans-serif;padding:30px;color:#000}h1{border-bottom:2px solid #000;padding-bottom:8px}table{width:100%;border-collapse:collapse;margin:14px 0}th,td{border:1px solid #999;padding:6px;text-align:left;font-size:12px}th{background:#eee}.meta{color:#666;font-size:11px;margin-bottom:14px}</style></head><body>`;
  html += `<h1>SEMPER-FI — Relatório de ${escapeHTML(kind)}</h1><div class="meta">Gerado em ${now} por ${escapeHTML(SETTINGS.userName||'')}</div>`;
  if (kind==='processos'){
    html += `<table><tr><th>Número</th><th>Cliente</th><th>Tribunal</th><th>Área</th><th>Fase</th><th>Responsável</th><th>Valor</th></tr>`;
    DB.processes.forEach(p=>{const c=dbGet('clients',p.clientId);html+=`<tr><td>${escapeHTML(p.number)}</td><td>${escapeHTML(c?.name||'')}</td><td>${escapeHTML(p.court)}</td><td>${escapeHTML(p.area)}</td><td>${escapeHTML(p.phase)}</td><td>${escapeHTML(p.responsible)}</td><td>${fmtMoney(p.value)}</td></tr>`;});
    html += `</table>`;
  } else if (kind==='prazos'){
    html += `<table><tr><th>Data</th><th>Título</th><th>Processo</th><th>Responsável</th><th>Status</th></tr>`;
    DB.deadlines.sort((a,b)=>a.date.localeCompare(b.date)).forEach(d=>{const p=dbGet('processes',d.processId);html+=`<tr><td>${fmtDate(d.date)}</td><td>${escapeHTML(d.title)}</td><td>${escapeHTML(p?.number||'')}</td><td>${escapeHTML(d.responsible||'')}</td><td>${escapeHTML(d.status)}</td></tr>`;});
    html += `</table>`;
  } else if (kind==='financeiro'){
    const tot = DB.financial.reduce((acc,f)=>{ acc[f.type] = (acc[f.type]||0) + f.amount; return acc; }, {});
    html += `<p><strong>Receitas:</strong> ${fmtMoney(tot.receita||0)} | <strong>Despesas:</strong> ${fmtMoney(tot.despesa||0)} | <strong>Saldo:</strong> ${fmtMoney((tot.receita||0)-(tot.despesa||0))}</p>`;
    html += `<table><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Valor</th><th>Status</th></tr>`;
    DB.financial.forEach(f=>html+=`<tr><td>${fmtDate(f.date)}</td><td>${escapeHTML(f.type)}</td><td>${escapeHTML(f.description)}</td><td>${fmtMoney(f.amount)}</td><td>${escapeHTML(f.status)}</td></tr>`);
    html += `</table>`;
  } else if (kind==='intimacoes'){
    html += `<table><tr><th>Conteúdo</th><th>Fonte</th><th>Tipo</th><th>Recebido</th><th>Processo</th><th>Status</th></tr>`;
    DB.intimations.forEach(i=>{const p=dbGet('processes',i.processId);html+=`<tr><td>${escapeHTML(i.content.slice(0,100))}</td><td>${escapeHTML(i.source)}</td><td>${escapeHTML(i.type)}</td><td>${fmtDateTime(i.receivedAt)}</td><td>${escapeHTML(p?.number||'—')}</td><td>${escapeHTML(i.status)}</td></tr>`;});
    html += `</table>`;
  } else if (kind==='clientes'){
    html += `<table><tr><th>Nome</th><th>Tipo</th><th>Documento</th><th>Responsável</th><th>Status</th><th>Processos</th></tr>`;
    DB.clients.forEach(c=>html+=`<tr><td>${escapeHTML(c.name)}</td><td>${escapeHTML(c.type)}</td><td>${escapeHTML(c.document)}</td><td>${escapeHTML(c.responsible||'')}</td><td>${escapeHTML(c.status)}</td><td>${DB.processes.filter(p=>p.clientId===c.id).length}</td></tr>`);
    html += `</table>`;
  }
  html += `<div style="margin-top:30px;font-size:10px;color:#666;border-top:1px solid #ccc;padding-top:10px">SEMPER-FI — Central Jurídica Operacional | Relatório técnico, sem valor probatório autônomo</div></body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('Permita abrir a janela de impressão para gerar o relatório.', 'warning'); return; }
  w.opener = null;
  w.document.write(html); w.document.close();
  setTimeout(()=>w.print(), 500);
  audit('reports','geracao',kind);
  toast('Relatório aberto — pronto para impressão/PDF','success');
}
function csvCell(value){
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function exportCSV(collection){
  const data = DB[collection];
  if (!data.length){ toast('Sem dados','warning'); return; }
  const keys = Object.keys(data[0]);
  const csv = '\uFEFF' + [keys.map(csvCell).join(','), ...data.map(row=>keys.map(k=>csvCell(row[k])).join(','))].join('\r\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `semperfi_${collection}_${toISO(new Date())}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
  audit('reports','exportacao_csv',collection);
  toast('CSV baixado','success');
}
function exportAllJSON(){
  const blob = new Blob([JSON.stringify(DB,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `semperfi_exportacao_${toISO(new Date())}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  audit('reports','backup_completo','json');
  toast('Dados carregados exportados. Arquivos originais e banco de dados não estão incluídos.','info');
}

// ============================================================
//                        AUDIT
// ============================================================
const auditState = { module:'todos', action:'todas', actor:'' };
SECTION_RENDERERS.audit = () => window.SemperfiAudit.render();
SECTION_AFTER.audit = () => window.SemperfiAudit.mount();

// ============================================================
//                        SETTINGS
// ============================================================
SECTION_RENDERERS.settings = () => `
  <h1 class="page-title">Configurações</h1>
  <p class="page-subtitle">Personalização e gerenciamento do sistema</p>
  <div class="grid-2x2">
    <div class="panel">
      <div class="panel-title">👤 Conta</div>
      <div class="form-group"><label class="form-label">Nome</label><input class="form-input" id="s_name" readonly value="${escapeHTML(SETTINGS.userName||'')}"></div>
      <div class="form-group"><label class="form-label">E-mail</label><input class="form-input" type="email" id="s_email" readonly value="${escapeHTML(SETTINGS.userEmail||'')}"></div>
      <div class="form-group"><label class="form-label">Perfil</label><input class="form-input" id="s_profile" readonly value="${escapeHTML(String(SETTINGS.userProfile||'').split(',').map(role=>({administrator:'Administrador',manager:'Gestor',lawyer:'Advogado',investigator:'Investigador',analyst:'Analista',auditor:'Auditor'})[role.trim()]||'Perfil da organização').join(', '))}"></div>
      <p class="text-muted">A conta e as permissões são gerenciadas pelo administrador.</p>
    </div>
    <div class="panel">
      <div class="panel-title">🔒 Privacidade e Segurança</div>
      <div class="form-group"><label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="s_mask" ${SETTINGS.masked?'checked':''}> Mascarar dados sensíveis por padrão</label></div>
<p class="text-muted">Para recuperar o acesso, procure o administrador ou o provedor de acesso institucional da organização.</p>
      <button class="btn btn-secondary mt-12" onclick="saveAccountSettings()" style="width:100%">Salvar preferências</button>
      <button class="btn btn-secondary mt-12" type="button" data-a11y-open aria-controls="a11yDialog" aria-haspopup="dialog" aria-expanded="false">Aparência e acessibilidade</button>
    </div>
    <div class="panel">
      <div class="panel-title">Serviços da organização</div>
      <p>Consulte a disponibilidade e acompanhe os resultados na área de cada serviço.</p>
      <div class="filter-bar"><button class="btn btn-secondary" onclick="navigateSection('queries')">Consultas públicas</button><button class="btn btn-secondary" onclick="navigateSection('agentes')">Assistência de IA</button><button class="btn btn-secondary" onclick="navigateSection('metadata')">Arquivos e evidências</button></div>
    </div>
    <div class="panel">
      <div class="panel-title">💾 Dados</div>
      <div style="font-size:13px;line-height:1.8">
        <div class="detail-row"><span class="detail-label">Clientes:</span><span class="detail-value">${DB.clients.length}</span></div>
        <div class="detail-row"><span class="detail-label">Processos:</span><span class="detail-value">${DB.processes.length}</span></div>
        <div class="detail-row"><span class="detail-label">Prazos:</span><span class="detail-value">${DB.deadlines.length}</span></div>
        <div class="detail-row"><span class="detail-label">Compromissos:</span><span class="detail-value">${DB.appointments.length}</span></div>
        <div class="detail-row"><span class="detail-label">Intimações:</span><span class="detail-value">${DB.intimations.length}</span></div>
        <div class="detail-row"><span class="detail-label">Lançamentos:</span><span class="detail-value">${DB.financial.length}</span></div>
      </div>
      <div class="filter-bar mt-12">
        <button class="btn btn-primary btn-small" onclick="exportAllJSON()">Exportar dados carregados</button>
        <button class="btn btn-secondary btn-small" onclick="document.getElementById('fileImport').click()">Importar clientes e processos</button>
      </div>
    </div>
  </div>
`;
function saveAccountSettings(){
  SETTINGS.masked = document.getElementById('s_mask').checked;
  saveSettings(); toast('Preferências atualizadas.','success'); renderSection('settings');
}

async function importJSON(file){
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.clients) || !Array.isArray(data.processes)) throw new Error('O arquivo deve conter listas de clientes e processos.');
    if (!confirm('Importar os clientes e processos do arquivo para a organização atual?')) return;
    await backendApi('/imports/frontend-demo', {method:'POST',body:JSON.stringify({payload:{clients:data.clients,processes:data.processes}})});
    await refreshBackendBootstrap();
    toast('Clientes e processos importados.','success'); navigateSection('dashboard');
  } catch(error) { toast(apiErrorMessage(error),'error'); }
}

// ============================================================
//                        TOPBAR ACTIONS
// ============================================================
document.getElementById('sidebarToggle').onclick = () => {
  document.getElementById('sidebar').classList.toggle('collapsed');
  SETTINGS.sidebarCollapsed = !SETTINGS.sidebarCollapsed; saveSettings();
};
document.getElementById('maskToggle').onclick = () => {
  SETTINGS.masked = !SETTINGS.masked; saveSettings();
  toast(SETTINGS.masked?'Dados sensíveis mascarados':'Dados sensíveis exibidos','info');
  renderSection(appState.currentSection);
};
document.getElementById('notificationBtn').onclick = (e) => {
  e.stopPropagation();
  document.getElementById('notifPanel').classList.toggle('active');
  if(document.getElementById('notifPanel').classList.contains('active')) renderNotifications();
  document.getElementById('profileMenu').classList.remove('active');
};
document.getElementById('clearNotifs').onclick = () => {
  document.getElementById('notifPanel').classList.remove('active');
};
document.getElementById('profileBtn').onclick = (e) => {
  e.stopPropagation();
  document.getElementById('profileMenu').classList.toggle('active');
  document.getElementById('notifPanel').classList.remove('active');
};
document.addEventListener('click', () => {
  document.getElementById('profileMenu').classList.remove('active');
  document.getElementById('notifPanel').classList.remove('active');
});
document.getElementById('profileMenu').addEventListener('click', e=>e.stopPropagation());
document.getElementById('notifPanel').addEventListener('click', e=>e.stopPropagation());

document.querySelectorAll('#profileMenu .dropdown-item').forEach(item=>{
  item.onclick = () => {
    const act = item.dataset.action;
    document.getElementById('profileMenu').classList.remove('active');
    if (act==='profile' || act==='prefs') navigateSection('settings');
    else if (act==='export') exportAllJSON();
    else if (act==='import') document.getElementById('fileImport').click();
    else if (act==='logout') window.SemperfiAuth.logout();
  };
});
document.getElementById('fileImport').onchange = e => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value=''; };

// ---------- New Record button ----------
document.getElementById('btnNew').onclick = () => {
  openModal({ title:'Novo registro', body:`
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px">
      <button class="btn btn-secondary" style="padding:16px;justify-content:center" onclick="closeModal();openClientForm()">👥 Cliente</button>
      <button class="btn btn-secondary" style="padding:16px;justify-content:center" onclick="closeModal();openProcessForm()">📋 Processo</button>
      <button class="btn btn-secondary" style="padding:16px;justify-content:center" onclick="closeModal();openAppointmentForm()">📅 Compromisso</button>
      <button class="btn btn-secondary" style="padding:16px;justify-content:center" onclick="closeModal();openDeadlineForm()">⏰ Prazo</button>
      <button class="btn btn-secondary" style="padding:16px;justify-content:center" onclick="closeModal();openIntimationForm()">📧 Intimação</button>
      <button class="btn btn-secondary" style="padding:16px;justify-content:center" onclick="closeModal();openFinancialForm()">💰 Lançamento</button>
    </div>
  `, footer:'<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>' });
};

// ---------- Global search ----------
let searchTimeout;
document.getElementById('globalSearch').addEventListener('input', e=>{
  clearTimeout(searchTimeout);
  const q = e.target.value.trim().toLowerCase();
  searchTimeout = setTimeout(()=>{ if (q.length>=2) runGlobalSearch(q); }, 250);
});
function runGlobalSearch(q){
  q = String(q || '').trim().toLowerCase();
  const contains = value => String(value || '').toLowerCase().includes(q);
  const results = [];
  DB.clients.forEach(c=>{ if (contains(c.name)||contains(c.document)||contains(c.email)) results.push({section:'clients',label:`👥 ${c.name || 'Cliente'}`,sub:maskDoc(c.document || ''),id:c.id}); });
  DB.processes.forEach(p=>{ if (contains(p.number)||contains(p.notes)) results.push({section:'processes',label:`📋 ${p.number}`,sub:[p.area,p.responsible].filter(Boolean).join(' • '),id:p.id}); });
  DB.deadlines.forEach(d=>{ if (contains(d.title)) results.push({section:'deadlines',label:`⏰ ${d.title}`,sub:fmtDate(d.date),id:d.id}); });
  DB.intimations.forEach(i=>{ if (contains(i.content)||contains(i.source)) results.push({section:'intimations',label:`📧 ${i.source || 'Intimação'}`,sub:String(i.content || '').slice(0,50),id:i.id}); });
  openModal({ title:`Busca: "${escapeHTML(q)}" — ${results.length} resultado(s)`, body: results.length?results.slice(0,30).map(r=>`<button type="button" class="btn btn-secondary" style="display:block;width:100%;padding:10px;margin-bottom:6px;text-align:left;white-space:normal" onclick="closeModal();navigateSection('${r.section}')"><span style="display:block;font-weight:600">${escapeHTML(r.label)}</span><span class="text-muted" style="font-size:12px">${escapeHTML(r.sub)}</span></button>`).join(''):'<div class="empty-state"><div class="empty-state-icon">🔍</div><div class="empty-state-title">Nada encontrado</div></div>', footer:'<button class="btn btn-secondary" onclick="closeModal()">Fechar</button>' });
}

// ============================================================
//          OSINT — Detetive Virtual (módulo investigativo)
// ============================================================

// ---------- Helpers de segurança ----------
function escapeHTML(v){
  if (v == null) return '';
  return String(v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function toLocalISO(d){
  const x = (d instanceof Date) ? d : new Date(d);
  const off = x.getTimezoneOffset()*60000;
  return new Date(x.getTime()-off).toISOString().slice(0,19);
}
async function sha256Hex(str){
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function maskAndFingerprint(value){
  if (!value) return { masked:'', fingerprint:'' };
  const v = String(value);
  const masked = v.length<=4 ? v.replace(/./g,'*') : v.slice(0,2)+'*'.repeat(Math.max(1,v.length-4))+v.slice(-2);
  const fingerprint = (await sha256Hex(v+'_semperfi_salt_v1')).slice(0,12);
  return { masked, fingerprint };
}

// ---------- Auditoria OSINT (encadeada por investigação) ----------
async function osintAudit(){ /* No browser-generated audit records. */ }

// ---------- Estado UI OSINT ----------
const osintState = {
  filter: { status:'todos', category:'todas', owner:'' },
  currentInvestigation: null,
  workspaceTab: 'overview',
  wizard: { step:1, data:{} }
};

// ---------- Vocabulários ----------
const OSINT_VOCAB = {
  status: {
    rascunho:           {label:'Rascunho',           chip:'pending'},
    aguardando_aprovacao:{label:'Aguardando aprovação',chip:'pending'},
    em_coleta:          {label:'Em coleta',          chip:'active'},
    pendente_revisao:   {label:'Pendente revisão',   chip:'warning'},
    concluida:          {label:'Concluída',          chip:'completed'},
    arquivada:          {label:'Arquivada',          chip:'pending'},
    bloqueada:          {label:'Bloqueada',          chip:'critical'}
  },
  category: {
    processual:'Processual', patrimonial:'Patrimonial', societaria:'Societária',
    fraude:'Fraude', compliance:'Compliance', reputacao:'Reputação institucional',
    prova_digital:'Prova digital', ciberseguranca_defensiva:'Cibersegurança defensiva'
  },
  legalBasis: {
    consentimento:'Consentimento (LGPD art.7,I)',
    cumprimento_obrigacao:'Cumprimento de obrigação legal (art.7,II)',
    exercicio_regular_de_direito:'Exercício regular de direito (art.7,VI)',
    legitimo_interesse:'Legítimo interesse (art.7,IX)',
    tutela_de_saude:'Tutela da saúde (art.7,VIII)',
    protecao_credito:'Proteção ao crédito (art.7,X)',
    dever_legal:'Dever legal do controlador'
  },
  scope: {
    empresarial:'Empresarial', judicial_publico:'Judicial público',
    integridade_publica:'Integridade pública', mercado_companhias_abertas:'Mercado/Companhias abertas',
    territorial_cadastral:'Territorial/Cadastral', prova_digital:'Prova digital',
    seguranca_digital_defensiva:'Segurança digital defensiva'
  },
  entityType: {
    pessoa_fisica:'Pessoa física', pessoa_juridica:'Pessoa jurídica',
    processo:'Processo', dominio:'Domínio', endereco:'Endereço',
    telefone:'Telefone', municipio:'Município', banco:'Banco',
    documento:'Documento', pagina_web:'Página web'
  },
  classification: {
    dado_bruto:           {label:'Dado bruto',           icon:'📥', color:'#8b949e'},
    indicio:              {label:'Indício',              icon:'🔍', color:'#79c0ff'},
    achado:               {label:'Achado',               icon:'📌', color:'#d4a574'},
    evidencia_corroborada:{label:'Evidência corroborada',icon:'🔒', color:'#00d9ff'},
    conclusao_humana:     {label:'Conclusão humana',     icon:'✅', color:'#3fb950'}
  },
  relationType: {
    socio:'Sócio', administrador:'Administrador', empresa:'Empresa',
    filial:'Filial', processo:'Processo', endereco_empresarial:'Endereço empresarial',
    documento:'Documento', dominio_autorizado:'Domínio autorizado',
    representante:'Representante', fonte_comum:'Fonte comum',
    pendente_validacao:'Pendente validação'
  }
};

function classChip(classification){
  const c = OSINT_VOCAB.classification[classification] || OSINT_VOCAB.classification.dado_bruto;
  return `<span class="status-chip" style="background:${c.color}22;color:${c.color}">${c.icon} ${c.label}</span>`;
}
function statusChip(status){
  const s = OSINT_VOCAB.status[status] || {label:status, chip:'active'};
  return `<span class="status-chip ${s.chip}">${escapeHTML(s.label)}</span>`;
}

// ============================================================
//          OSINT — Render principal
// ============================================================
SECTION_RENDERERS.osint = () => {
  const investigations = DB.investigations.filter(i => {
    if (osintState.filter.status!=='todos' && i.status!==osintState.filter.status) return false;
    if (osintState.filter.category!=='todas' && i.category!==osintState.filter.category) return false;
    if (osintState.filter.owner && !i.owner.toLowerCase().includes(osintState.filter.owner.toLowerCase())) return false;
    return true;
  });
  const activas = DB.investigations.filter(i=>['em_coleta','pendente_revisao'].includes(i.status)).length;
  const coletasAtivas = DB.osintRuns.filter(r=>r.status==='em_execucao').length;
  const evidPend = DB.evidence.filter(e=>e.validationStatus==='pendente').length;
  const achadosCorr = DB.osintFindings.filter(f=>f.classification==='evidencia_corroborada'||f.classification==='conclusao_humana').length;
  const relatorios = DB.audit.filter(a=>a.module==='osint' && a.action==='geracao_relatorio').length;


  return `
    <h1 class="page-title">🕵️ Investigação OSINT — Detetive Virtual</h1>
    <p class="page-subtitle">Dossiês investigativos com coleta pública, cadeia de custódia e validação humana</p>


    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-label">Investigações ativas</div><div class="kpi-value">${activas}</div><div class="kpi-change">de ${DB.investigations.length} totais</div></div>
      <div class="kpi-card"><div class="kpi-label">Coletas em execução</div><div class="kpi-value" style="color:var(--teal-accent)">${coletasAtivas}</div><div class="kpi-change">Agentes ativos</div></div>
      <div class="kpi-card"><div class="kpi-label">Evidências p/ revisão</div><div class="kpi-value" style="color:${evidPend?'var(--warning)':'var(--success)'}">${evidPend}</div><div class="kpi-change">${evidPend?'⚠ Requer revisão':'✓ Sob controle'}</div></div>
      <div class="kpi-card"><div class="kpi-label">Achados corroborados</div><div class="kpi-value" style="color:var(--success)">${achadosCorr}</div><div class="kpi-change">Com evidência</div></div>
      <div class="kpi-card"><div class="kpi-label">Relatórios gerados</div><div class="kpi-value">${relatorios}</div><div class="kpi-change">Histórico</div></div>
    </div>

    <div class="panel">
      <div class="filter-bar">
        <select class="form-select" id="osStatus">
          <option value="todos">Status: Todos</option>
          ${Object.entries(OSINT_VOCAB.status).map(([k,v])=>`<option value="${k}" ${osintState.filter.status===k?'selected':''}>${v.label}</option>`).join('')}
        </select>
        <select class="form-select" id="osCategory">
          <option value="todas">Categoria: Todas</option>
          ${Object.entries(OSINT_VOCAB.category).map(([k,v])=>`<option value="${k}" ${osintState.filter.category===k?'selected':''}>${v}</option>`).join('')}
        </select>
        <input class="form-input grow" id="osOwner" placeholder="Filtrar por responsável..." value="${escapeHTML(osintState.filter.owner)}">
        <button class="btn btn-primary" onclick="openInvestigationWizard()">+ Nova investigação</button>
        <button class="btn btn-secondary" onclick="navigateSection('osint');renderOsintSourceCatalog()">📚 Catálogo de fontes</button>
      </div>

      ${investigations.length ? `
        <table><thead><tr><th>Título</th><th>Categoria</th><th>Cliente</th><th>Processo</th><th>Responsável</th><th>Escopo</th><th>Status</th><th></th></tr></thead><tbody>
          ${investigations.map(i=>{
            const cli = dbGet('clients', i.clientId);
            const pro = dbGet('processes', i.processId);
            return `<tr>
              <td style="font-weight:600;cursor:pointer" onclick="openInvestigationWorkspace('${i.id}')">${escapeHTML(i.title)}</td>
              <td>${escapeHTML(OSINT_VOCAB.category[i.category]||i.category)}</td>
              <td>${escapeHTML(cli?.name||'—')}</td>
              <td style="font-family:'JetBrains Mono';font-size:11px">${escapeHTML(pro?.number||'—')}</td>
              <td>${escapeHTML(i.owner)}</td>
              <td style="font-size:11px">${(i.scope||[]).map(s=>`<span class="badge badge-primary" style="margin-right:2px">${escapeHTML(OSINT_VOCAB.scope[s]||s)}</span>`).join('')}</td>
              <td>${statusChip(i.status)}</td>
              <td><div class="row-actions">
                <button class="btn btn-small btn-secondary" onclick="openInvestigationWorkspace('${i.id}')">Abrir</button>
                <button class="btn btn-small btn-danger" onclick="deleteInvestigation('${i.id}')">×</button>
              </div></td></tr>`;
          }).join('')}
        </tbody></table>
      ` : `<div class="empty-state"><div class="empty-state-icon">🕵️</div><div class="empty-state-title">Nenhuma investigação</div><div class="empty-state-text">Crie sua primeira investigação para começar.</div><button class="btn btn-primary" onclick="openInvestigationWizard()">+ Nova investigação</button></div>`}
    </div>

    <div class="grid-2x2 mt-20">
      <div class="panel">
        <div class="panel-title">⚠ Alertas investigativos</div>
        ${(() => {
          const alerts = [];
          DB.evidence.filter(e=>e.validationStatus==='pendente').slice(0,3).forEach(e=>{
            const inv = dbGet('investigations', e.investigationId);
            alerts.push(`<div style="padding:10px;background:var(--obsidian);border-radius:6px;margin-bottom:6px;border-left:3px solid var(--warning)"><strong>Evidência pendente</strong><div class="text-muted" style="font-size:12px">${escapeHTML(inv?.title||'—')} — ${escapeHTML(e.sourceName)}</div></div>`);
          });
          DB.investigations.filter(i=>i.status==='bloqueada').forEach(i=>{
            alerts.push(`<div style="padding:10px;background:var(--obsidian);border-radius:6px;margin-bottom:6px;border-left:3px solid var(--danger)"><strong>Investigação bloqueada</strong><div class="text-muted" style="font-size:12px">${escapeHTML(i.title)}</div></div>`);
          });
          return alerts.length ? alerts.join('') : '<div class="text-muted">Nenhum alerta no momento.</div>';
        })()}
      </div>
      <div class="panel">
        <div class="panel-title">🔒 Evidências aguardando revisão</div>
        ${(() => {
          const pend = DB.evidence.filter(e=>e.validationStatus==='pendente').slice(0,5);
          return pend.length ? pend.map(e=>{
            const inv = dbGet('investigations', e.investigationId);
            return `<div style="padding:10px;background:var(--obsidian);border-radius:6px;margin-bottom:6px;cursor:pointer" onclick="openInvestigationWorkspace('${e.investigationId}');setTimeout(()=>switchOsintTab('evidencias'),100)">
              <strong>${escapeHTML(e.sourceName)}</strong>
              <div class="text-muted" style="font-size:11px">${escapeHTML(inv?.title||'—')} • ${fmtDateTime(e.collectedAt)}</div>
              <div style="font-family:'JetBrains Mono';font-size:10px;margin-top:4px">${escapeHTML(e.sha256.slice(0,32))}...</div>
            </div>`;
          }).join('') : '<div class="text-muted">Nenhuma evidência aguardando.</div>';
        })()}
      </div>
    </div>
  `;
};
SECTION_AFTER.osint = () => {
  document.getElementById('osStatus').onchange = e=>{osintState.filter.status=e.target.value;renderSection('osint');};
  document.getElementById('osCategory').onchange = e=>{osintState.filter.category=e.target.value;renderSection('osint');};
  document.getElementById('osOwner').addEventListener('input', e=>{osintState.filter.owner=e.target.value;renderSection('osint');document.getElementById('osOwner').focus();});
  const subtitle = document.querySelector('#contentWrapper .page-subtitle');
  if (subtitle){
    const note = document.createElement('div');
    note.className = 'pricing-note';
    note.textContent = 'Sugestões automatizadas exigem revisão humana e não constituem evidência corroborada por si só.';
    subtitle.insertAdjacentElement('afterend', note);
  }
};

async function deleteInvestigation(id){
  const inv = dbGet('investigations', id);
  if (!confirm(`Excluir investigação "${inv.title}"? Evidências vinculadas serão preservadas para auditoria.`)) return;
  if (isBackendMode()){
    try {
      await backendApi(`/investigations/${id}`, { method:'DELETE' });
      await refreshBackendBootstrap();
    }
    catch(err){ toast(apiErrorMessage(err),'error'); return; }
    toast('Investigação excluída','success');
    renderSection('osint');
    return;
  }
  dbDelete('investigations', id);
  osintAudit('exclusao_logica', id, {title: inv.title});
  toast('Investigação excluída','success');
  renderSection('osint');
}

// ---------- Catálogo de fontes (modal) ----------
function renderOsintSourceCatalog(){
  openModal({ wide:true, title:'📚 Catálogo de fontes OSINT', body:`
    <p class="text-muted mb-20" style="font-size:12px">Cada fonte indica categoria, requisitos, limites e nível de confiabilidade. Em modo produção, conectores marcados <code>backend</code> só funcionam com gateway configurado.</p>
    <table style="font-size:12px"><thead><tr><th>Fonte</th><th>Categoria</th><th>Tipo</th><th>Token?</th><th>Confiança</th><th>Status</th></tr></thead><tbody>
      ${DB.sourceCatalog.map(s=>`<tr>
        <td><strong>${escapeHTML(s.name)}</strong><div class="text-muted" style="font-size:11px">${escapeHTML(s.legalNotes)}</div></td>
        <td>${escapeHTML(OSINT_VOCAB.scope[s.category]||s.category)}</td>
        <td><span class="badge ${s.connectorType==='rest'?'badge-primary':s.connectorType==='backend'?'badge-warning':''}">${escapeHTML(s.connectorType)}</span></td>
        <td>${s.requiresToken?'🔑 Sim':'—'}</td>
        <td>${(s.confidenceWeight*100).toFixed(0)}%</td>
        <td>${s.enabled?'<span class="status-chip active">Ativo</span>':'<span class="status-chip pending">Desativado</span>'}</td>
      </tr>`).join('')}
    </tbody></table>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Fechar</button>` });
}

// ============================================================
//          OSINT — Wizard de nova investigação (4 etapas)
// ============================================================
function openInvestigationWizard(){
  osintState.wizard = { step:1, data:{ scope:[], status:'rascunho' } };
  renderWizardStep();
}
function renderWizardStep(){
  const s = osintState.wizard.step, d = osintState.wizard.data;
  const stepIndicator = `<div style="display:flex;gap:8px;margin-bottom:18px;font-size:11px">${[1,2,3,4].map(n=>`<div style="flex:1;padding:8px;text-align:center;border-radius:4px;background:${n===s?'var(--teal-accent)':'var(--obsidian)'};color:${n===s?'var(--obsidian)':'var(--text-secondary)'};font-weight:${n===s?700:400}">${n}. ${['Identificação','Objetivo','Escopo','Declaração'][n-1]}</div>`).join('')}</div>`;
  let body = stepIndicator, footer = '';

  if (s===1){
    const cliOpts = DB.clients.map(c=>`<option value="${c.id}" ${c.id===d.clientId?'selected':''}>${escapeHTML(c.name)}</option>`).join('');
    const proOpts = DB.processes.map(p=>`<option value="${p.id}" ${p.id===d.processId?'selected':''}>${escapeHTML(p.number)}</option>`).join('');
    body += `
      <div class="form-group"><label class="form-label">Título da investigação *</label><input class="form-input" id="wz_title" value="${escapeHTML(d.title||'')}" placeholder="Ex: Due diligence Empresa XYZ"></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Categoria *</label><select class="form-select" id="wz_category">${Object.entries(OSINT_VOCAB.category).map(([k,v])=>`<option value="${k}" ${d.category===k?'selected':''}>${v}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label" for="wz_priority">Prioridade</label><select class="form-select" id="wz_priority">${[['baixa','Baixa'],['media','Média'],['alta','Alta'],['critica','Crítica']].map(([value,label])=>`<option value="${value}" ${value===(d.priority||'media')?'selected':''}>${label}</option>`).join('')}</select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Cliente *</label><select class="form-select" id="wz_clientId"><option value="">— selecionar —</option>${cliOpts}</select></div>
        <div class="form-group"><label class="form-label">Processo</label><select class="form-select" id="wz_processId"><option value="">— opcional —</option>${proOpts}</select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Responsável *</label><input class="form-input" id="wz_owner" value="${escapeHTML(d.owner||SETTINGS.userName||'')}"></div>
        <div class="form-group"><label class="form-label">Prazo interno</label><input class="form-input" id="wz_deadline" type="date" value="${d.deadline||''}"></div>
      </div>
    `;
    footer = `<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="wizardNext()">Avançar →</button>`;
  } else if (s===2){
    body += `
      <div class="form-group"><label class="form-label">Objetivo investigativo * (mín. 50 caracteres)</label><textarea class="form-textarea" id="wz_objective" style="min-height:80px" placeholder="Descreva o que se busca verificar.">${escapeHTML(d.objective||'')}</textarea></div>
      <div class="form-group"><label class="form-label">Hipótese inicial</label><textarea class="form-textarea" id="wz_hypothesis">${escapeHTML(d.hypothesis||'')}</textarea></div>
      <div class="form-group"><label class="form-label">Perguntas investigativas (uma por linha)</label><textarea class="form-textarea" id="wz_questions" style="min-height:100px">${escapeHTML((d.questions||[]).join('\n'))}</textarea></div>
      <div class="form-group"><label class="form-label">Resultado esperado</label><input class="form-input" id="wz_expected" value="${escapeHTML(d.expected||'')}" placeholder="Ex: Relatório de integridade pública e estrutura societária"></div>
    `;
    footer = `<button class="btn btn-secondary" onclick="wizardBack()">← Voltar</button><button class="btn btn-primary" onclick="wizardNext()">Avançar →</button>`;
  } else if (s===3){
    body += `
      <div class="form-group"><label class="form-label">Finalidade concreta *</label><textarea class="form-textarea" id="wz_purpose">${escapeHTML(d.purpose||'')}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Fundamento jurídico *</label><select class="form-select" id="wz_legalBasis">${Object.entries(OSINT_VOCAB.legalBasis).map(([k,v])=>`<option value="${k}" ${d.legalBasis===k?'selected':''}>${v}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">Nível de risco</label><select class="form-select" id="wz_riskLevel"><option value="baixo" ${d.riskLevel==='baixo'?'selected':''}>Baixo</option><option value="medio" ${d.riskLevel==='medio'?'selected':''}>Médio</option><option value="alto" ${d.riskLevel==='alto'?'selected':''}>Alto</option></select></div>
      </div>
      <div class="form-group"><label class="form-label">Referência de autorização *</label><input class="form-input" id="wz_authRef" value="${escapeHTML(d.authorizationReference||'')}" placeholder="Mandato, processo, contrato, solicitação nº..."></div>
      <div class="form-group"><label class="form-label">Avaliação de necessidade e proporcionalidade *</label><textarea class="form-textarea" id="wz_liaText">${escapeHTML(d.legitimateInterestAssessment||'')}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Prazo de retenção (anos)</label><input class="form-input" id="wz_retention" type="number" min="1" max="20" value="${d.retentionYears||5}"></div>
      </div>
      <div class="form-group"><label class="form-label">Escopos permitidos * (selecione ao menos um)</label>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px">
          ${Object.entries(OSINT_VOCAB.scope).map(([k,v])=>`<label style="display:flex;gap:6px;align-items:center;padding:6px;background:var(--obsidian);border-radius:4px;cursor:pointer;font-size:12px"><input type="checkbox" class="wz_scope" value="${k}" ${(d.scope||[]).includes(k)?'checked':''}> ${v}</label>`).join('')}
        </div>
      </div>
    `;
    footer = `<button class="btn btn-secondary" onclick="wizardBack()">← Voltar</button><button class="btn btn-primary" onclick="wizardNext()">Avançar →</button>`;
  } else if (s===4){
    const cli = dbGet('clients', d.clientId);
    const pro = dbGet('processes', d.processId);
    body += `
      <div class="alert alert-info"><span>📋</span><span>Revise a investigação antes de confirmar. Após criada, alterações de escopo são auditadas.</span></div>
      <div class="detail-row"><span class="detail-label">Título:</span><span class="detail-value">${escapeHTML(d.title)}</span></div>
      <div class="detail-row"><span class="detail-label">Categoria:</span><span class="detail-value">${escapeHTML(OSINT_VOCAB.category[d.category])}</span></div>
      <div class="detail-row"><span class="detail-label">Cliente:</span><span class="detail-value">${escapeHTML(cli?.name||'—')}</span></div>
      <div class="detail-row"><span class="detail-label">Processo:</span><span class="detail-value">${escapeHTML(pro?.number||'—')}</span></div>
      <div class="detail-row"><span class="detail-label">Responsável:</span><span class="detail-value">${escapeHTML(d.owner)}</span></div>
      <div class="detail-row"><span class="detail-label">Fundamento:</span><span class="detail-value">${escapeHTML(OSINT_VOCAB.legalBasis[d.legalBasis])}</span></div>
      <div class="detail-row"><span class="detail-label">Escopos:</span><span class="detail-value">${(d.scope||[]).map(s=>escapeHTML(OSINT_VOCAB.scope[s])).join(', ')||'(nenhum)'}</span></div>
      <div class="detail-row"><span class="detail-label">Retenção:</span><span class="detail-value">${d.retentionYears||5} ano(s)</span></div>
      <div class="form-group mt-20" style="padding:14px;background:var(--obsidian);border-radius:6px;border-left:3px solid var(--gold-accent)">
        <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;font-size:13px">
          <input type="checkbox" id="wz_declaration" style="margin-top:3px">
          <span>Declaro que esta investigação tem <strong>finalidade legítima</strong>, é <strong>proporcional</strong> ao objetivo, respeita a privacidade e os direitos dos titulares de dados, e <strong>não envolve nenhuma das práticas vedadas</strong> pelo sistema (quebra de CAPTCHA, scraping de login, acesso a contas privadas, vazamentos, reconhecimento facial, perfil psicológico, localização em tempo real).</span>
        </label>
      </div>
    `;
    footer = `<button class="btn btn-secondary" onclick="wizardBack()">← Voltar</button><button class="btn btn-primary" onclick="wizardFinish()">Criar investigação</button>`;
  }

  openModal({ wide:s>=2, title:`Nova investigação OSINT — Etapa ${s}/4`, body, footer });
}
function wizardCaptureStep(){
  const s = osintState.wizard.step, d = osintState.wizard.data;
  if (s===1){
    d.title = document.getElementById('wz_title').value.trim();
    d.category = document.getElementById('wz_category').value;
    d.priority = document.getElementById('wz_priority').value;
    d.clientId = document.getElementById('wz_clientId').value;
    d.processId = document.getElementById('wz_processId').value || null;
    d.owner = document.getElementById('wz_owner').value.trim();
    d.deadline = document.getElementById('wz_deadline').value;
    if (!d.title || !d.clientId || !d.owner){ toast('Título, cliente e responsável são obrigatórios','error'); return false; }
  } else if (s===2){
    d.objective = document.getElementById('wz_objective').value.trim();
    d.hypothesis = document.getElementById('wz_hypothesis').value.trim();
    d.questions = document.getElementById('wz_questions').value.split('\n').map(x=>x.trim()).filter(Boolean);
    d.expected = document.getElementById('wz_expected').value.trim();
    if (d.objective.length < 50){ toast('Objetivo deve ter ao menos 50 caracteres','error'); return false; }
  } else if (s===3){
    d.purpose = document.getElementById('wz_purpose').value.trim();
    d.legalBasis = document.getElementById('wz_legalBasis').value;
    d.riskLevel = document.getElementById('wz_riskLevel').value;
    d.authorizationReference = document.getElementById('wz_authRef').value.trim();
    d.legitimateInterestAssessment = document.getElementById('wz_liaText').value.trim();
    d.retentionYears = parseInt(document.getElementById('wz_retention').value)||5;
    d.scope = Array.from(document.querySelectorAll('.wz_scope:checked')).map(c=>c.value);
    if (!d.purpose || !d.authorizationReference || !d.legitimateInterestAssessment){ toast('Finalidade, autorização e avaliação são obrigatórios','error'); return false; }
    if (d.scope.length===0){ toast('Selecione ao menos um escopo','error'); return false; }
  }
  return true;
}
function wizardNext(){ if (wizardCaptureStep()) { osintState.wizard.step++; renderWizardStep(); } }
function wizardBack(){ wizardCaptureStep(); osintState.wizard.step--; renderWizardStep(); }
async function wizardFinish(){
  if (!document.getElementById('wz_declaration').checked){
    toast('A declaração de finalidade legítima é obrigatória. Sem ela, nenhum agente pode ser disparado.','error');
    return;
  }
  const d = osintState.wizard.data;
  const investigation = {
    id: uid('inv'),
    title: d.title, objective: d.objective, hypothesis: d.hypothesis,
    category: d.category, legalBasis: d.legalBasis,
    legitimateInterestAssessment: d.legitimateInterestAssessment,
    authorizationReference: d.authorizationReference,
    clientId: d.clientId, processId: d.processId,
    owner: d.owner, status: 'em_coleta', riskLevel: d.riskLevel,
    scope: d.scope, priority: d.priority,
    questions: d.questions, expected: d.expected,
    purpose: d.purpose, deadline: d.deadline,
    createdAt: Date.now(), updatedAt: Date.now(), closedAt: null,
    retentionUntil: toISO(addCalendarDays(new Date(), (d.retentionYears||5)*365))
  };
  try {
    if (isBackendMode()){
      const saved = await backendApi('/investigations', {
        method:'POST',
        body: JSON.stringify({
          title: d.title,
          category: d.category,
          objective: d.objective,
          purpose: d.purpose,
          legal_basis: d.legalBasis,
          authorization_reference: d.authorizationReference,
          proportionality_assessment: d.legitimateInterestAssessment,
          risk_level: mapApiRisk(d.riskLevel),
          client_id: d.clientId || null,
          process_id: d.processId || null,
          hypothesis: d.hypothesis || null,
          operational_owner: d.owner || null,
          priority: d.priority,
          deadline: d.deadline || null,
          questions: d.questions || [],
          expected_result: d.expected || null,
          scope_codes: d.scope,
          retention_until: new Date(addCalendarDays(new Date(), (d.retentionYears||5)*365)).toISOString()
        })
      });
      investigation.id = String(saved.id);
      investigation.status = saved.status || investigation.status;
      await refreshBackendBootstrap();
    } else {
      DB.investigations.push(investigation);
      saveDB();
    }
  } catch(err){
    toast(apiErrorMessage(err),'error');
    return;
  }
  osintAudit('criacao_investigacao', investigation.id, {title:d.title, scope:d.scope});
  osintAudit('aprovacao_escopo', investigation.id, {scope:d.scope, declaration:true});
  toast('Investigação criada','success');
  closeModal();
  openInvestigationWorkspace(investigation.id);
}

// ============================================================
//          OSINT — Workspace (10 abas)
// ============================================================
function openInvestigationWorkspace(id){
  osintState.currentInvestigation = id;
  osintState.workspaceTab = 'overview';
  renderWorkspace();
}
function switchOsintTab(tab){
  osintState.workspaceTab = tab;
  renderWorkspace();
}
function renderWorkspace(){
  const inv = dbGet('investigations', osintState.currentInvestigation);
  if (!inv){ toast('Investigação não encontrada','error'); closeModal(); return; }
  const tabs = [
    {id:'overview', label:'Visão Geral'},
    {id:'plano', label:'Plano de Coleta'},
    {id:'motores', label:'Planos TACER / SIERA'},
    {id:'entidades', label:'Entidades'},
    {id:'coletas', label:'Coletas'},
    {id:'achados', label:'Achados'},
    {id:'timeline', label:'Timeline'},
    {id:'vinculos', label:'Mapa de Vínculos'},
    {id:'evidencias', label:'Cofre de Evidências'},
    {id:'relatorio', label:'Relatório'},
    {id:'auditoria', label:'Auditoria'}
  ];
  const tabsHTML = `<div class="tabs">${tabs.map(t=>`<button class="tab ${t.id===osintState.workspaceTab?'active':''}" onclick="switchOsintTab('${t.id}')">${t.label}</button>`).join('')}</div>`;
  const cli = dbGet('clients', inv.clientId);
  const pro = dbGet('processes', inv.processId);
  const isReadOnly = ['concluida','arquivada'].includes(inv.status);
  let content = '';
  const r = WORKSPACE_RENDERERS[osintState.workspaceTab];
  if (r) content = r(inv, {cli, pro, isReadOnly});

  openModal({ wide:true, title:`🕵️ ${escapeHTML(inv.title)} ${statusChip(inv.status)} ${isReadOnly?'<span class="badge badge-warning">Somente leitura</span>':''}`, body: tabsHTML + content, footer:`<button class="btn btn-secondary" onclick="closeModal()">Fechar</button>`,
    onMount(modal){
      if(osintState.workspaceTab==='motores') window.SemperfiInvestigationEngines.mount(modal.querySelector('#investigationEngines'),{api:backendApi,investigations:[{...inv,scope_codes:inv.scope||[]}],canWrite:!isReadOnly&&canEditLegalRecords(),masked:SETTINGS.masked});
      if(osintState.workspaceTab==='timeline') mountInvestigationTimeline(modal.querySelector('#investigationTimeline'),inv.id);
    }
  });
}

const WORKSPACE_RENDERERS = {};
WORKSPACE_RENDERERS.motores = () => '<section id="investigationEngines" aria-label="Planos TACER e SIERA"></section>';

WORKSPACE_RENDERERS.overview = (inv, ctx) => {
  const ents = DB.osintEntities.filter(e=>e.investigationId===inv.id).length;
  const runs = DB.osintRuns.filter(r=>r.investigationId===inv.id).length;
  const finds = DB.osintFindings.filter(f=>f.investigationId===inv.id).length;
  const evid = DB.evidence.filter(e=>e.investigationId===inv.id).length;
  return `
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-label">Entidades</div><div class="kpi-value" style="font-size:22px">${ents}</div></div>
      <div class="kpi-card"><div class="kpi-label">Coletas</div><div class="kpi-value" style="font-size:22px">${runs}</div></div>
      <div class="kpi-card"><div class="kpi-label">Achados</div><div class="kpi-value" style="font-size:22px">${finds}</div></div>
      <div class="kpi-card"><div class="kpi-label">Evidências</div><div class="kpi-value" style="font-size:22px">${evid}</div></div>
    </div>
    <div class="detail-row"><span class="detail-label">Objetivo:</span><span class="detail-value" style="max-width:60%">${escapeHTML(inv.objective)}</span></div>
    <div class="detail-row"><span class="detail-label">Hipótese:</span><span class="detail-value" style="max-width:60%">${escapeHTML(inv.hypothesis||'—')}</span></div>
    <div class="detail-row"><span class="detail-label">Categoria:</span><span class="detail-value">${escapeHTML(OSINT_VOCAB.category[inv.category])}</span></div>
    <div class="detail-row"><span class="detail-label">Cliente:</span><span class="detail-value">${escapeHTML(ctx.cli?.name||'—')}</span></div>
    <div class="detail-row"><span class="detail-label">Processo:</span><span class="detail-value">${escapeHTML(ctx.pro?.number||'—')}</span></div>
    <div class="detail-row"><span class="detail-label">Responsável:</span><span class="detail-value">${escapeHTML(inv.owner)}</span></div>
    <div class="detail-row"><span class="detail-label">Fundamento:</span><span class="detail-value">${escapeHTML(OSINT_VOCAB.legalBasis[inv.legalBasis]||inv.legalBasis)}</span></div>
    <div class="detail-row"><span class="detail-label">Autorização:</span><span class="detail-value">${escapeHTML(inv.authorizationReference)}</span></div>
    <div class="detail-row"><span class="detail-label">Escopo:</span><span class="detail-value">${(inv.scope||[]).map(s=>`<span class="badge badge-primary" style="margin:2px">${escapeHTML(OSINT_VOCAB.scope[s]||s)}</span>`).join('')}</span></div>
    <div class="detail-row"><span class="detail-label">Retenção até:</span><span class="detail-value">${fmtDate(inv.retentionUntil)}</span></div>
    ${!ctx.isReadOnly?`
      <div class="filter-bar mt-20">
        <button class="btn btn-primary" onclick="quickPlannerAgent('${inv.id}')">🧠 Executar Planejador</button>
        <button class="btn btn-secondary" onclick="updateInvestigationStatus('${inv.id}','concluida')">✓ Concluir investigação</button>
        <button class="btn btn-secondary" onclick="updateInvestigationStatus('${inv.id}','arquivada')">📦 Arquivar</button>
        <button class="btn btn-danger" onclick="updateInvestigationStatus('${inv.id}','bloqueada')">🚫 Bloquear</button>
      </div>
    `:''}
    <div class="alert alert-info mt-20" style="font-size:11px"><span>ℹ️</span><span><strong>Avaliação LIA:</strong> ${escapeHTML(inv.legitimateInterestAssessment)}</span></div>
  `;
};

WORKSPACE_RENDERERS.plano = (inv, ctx) => {
  const runs = DB.osintRuns.filter(r=>r.investigationId===inv.id);
  return `
    <p class="text-muted mb-12" style="font-size:12px">O plano de coleta organiza tarefas investigativas. Cada tarefa vira uma execução de agente.</p>
    ${!ctx.isReadOnly?`<button class="btn btn-primary mb-20" onclick="quickPlannerAgent('${inv.id}')">🧠 Gerar plano via Planejador Investigativo</button>`:''}
    ${runs.length?`<table style="font-size:12px"><thead><tr><th>Tarefa</th><th>Fonte</th><th>Status</th><th>Data</th></tr></thead><tbody>${runs.map(r=>{const src=DB.sourceCatalog.find(s=>s.id===r.connectorId);return `<tr><td>${escapeHTML(r.purpose)}</td><td>${escapeHTML(src?.name||r.connectorId)}</td><td>${statusChip(r.status==='ok'?'concluida':r.status==='erro'?'bloqueada':'em_coleta')}</td><td>${fmtDateTime(r.startedAt)}</td></tr>`;}).join('')}</tbody></table>`:'<div class="empty-state" style="padding:24px"><div class="text-muted">Nenhuma tarefa planejada. Use o Planejador.</div></div>'}
  `;
};

WORKSPACE_RENDERERS.entidades = (inv, ctx) => {
  const ents = DB.osintEntities.filter(e=>e.investigationId===inv.id);
  return `
    ${!ctx.isReadOnly?`<button class="btn btn-primary mb-20" onclick="openEntityForm('${inv.id}')">+ Adicionar entidade</button>`:''}
    ${ents.length?`<table style="font-size:12px"><thead><tr><th>Tipo</th><th>Nome</th><th>Documento</th><th>Fingerprint</th><th>Status</th><th>Confiança</th><th></th></tr></thead><tbody>
      ${ents.map(e=>`<tr>
        <td>${escapeHTML(OSINT_VOCAB.entityType[e.entityType]||e.entityType)}</td>
        <td><strong>${escapeHTML(e.displayName)}</strong></td>
        <td class="masked">${escapeHTML(e.documentMasked||'—')}</td>
        <td style="font-family:'JetBrains Mono';font-size:10px">${escapeHTML(e.documentFingerprint||'—')}</td>
        <td>${escapeHTML(e.verificationStatus||'—')}</td>
        <td>${((e.confidence||0)*100).toFixed(0)}%</td>
        <td><div class="row-actions">
          ${!ctx.isReadOnly?`<button class="btn btn-small btn-primary" onclick="runAgentsForEntity('${inv.id}','${e.id}')">▶ Coletar</button>`:''}
        </div></td>
      </tr>`).join('')}
    </tbody></table>`:'<div class="empty-state" style="padding:24px"><div class="text-muted">Nenhuma entidade. Adicione um alvo investigado.</div></div>'}
  `;
};

WORKSPACE_RENDERERS.coletas = (inv) => {
  const runs = DB.osintRuns.filter(r=>r.investigationId===inv.id).sort((a,b)=>b.startedAt-a.startedAt);
  return runs.length?`<table style="font-size:12px"><thead><tr><th>Data</th><th>Conector</th><th>Alvo</th><th>Status</th><th>Resumo</th><th></th></tr></thead><tbody>
    ${runs.map(r=>{const src=DB.sourceCatalog.find(s=>s.id===r.connectorId);const ent=dbGet('osintEntities',r.targetEntityId);return `<tr>
      <td>${fmtDateTime(r.startedAt)}</td>
      <td>${escapeHTML(src?.name||r.connectorId)}</td>
      <td>${escapeHTML(ent?.displayName||'—')}</td>
      <td>${r.status==='ok'?'<span class="status-chip active">OK</span>':r.status==='erro'?'<span class="status-chip critical">Erro</span>':'<span class="status-chip pending">'+escapeHTML(r.status)+'</span>'}</td>
      <td style="max-width:300px;font-size:11px">${escapeHTML((r.resultSummary||r.errorMessage||'').slice(0,80))}</td>
      <td><button class="btn btn-small btn-secondary" onclick="showRunDetail('${r.id}')">Ver</button></td>
    </tr>`;}).join('')}
  </tbody></table>`:'<div class="empty-state" style="padding:24px"><div class="text-muted">Nenhuma coleta. Execute agentes a partir das entidades.</div></div>';
};

WORKSPACE_RENDERERS.achados = (inv, ctx) => {
  const finds = DB.osintFindings.filter(f=>f.investigationId===inv.id);
  return finds.length?`<table style="font-size:12px"><thead><tr><th>Classificação</th><th>Título</th><th>Confiança</th><th>Fontes</th><th>Validado</th><th></th></tr></thead><tbody>
    ${finds.map(f=>`<tr>
      <td>${classChip(f.classification)}</td>
      <td><strong>${escapeHTML(f.title)}</strong><div class="text-muted" style="font-size:11px">${escapeHTML(f.statement.slice(0,80))}</div></td>
      <td>${((f.confidenceScore||0)*100).toFixed(0)}%</td>
      <td>${f.sourceCount||0}</td>
      <td>${f.humanValidated?'<span class="status-chip active">✓ '+escapeHTML(f.reviewer||'')+'</span>':'<span class="status-chip pending">Pendente</span>'}</td>
      <td><div class="row-actions">
        <button class="btn btn-small btn-secondary" onclick="showFindingDetail('${f.id}')">Detalhe</button>
        ${!ctx.isReadOnly && !f.humanValidated?`<button class="btn btn-small btn-primary" onclick="validateFinding('${f.id}')">Validar</button>`:''}
        ${!ctx.isReadOnly?`<button class="btn btn-small btn-primary" onclick="promoteFindingToEvidence('${f.id}')">→ Evidência</button>`:''}
      </div></td>
    </tr>`).join('')}
  </tbody></table>`:'<div class="empty-state" style="padding:24px"><div class="text-muted">Nenhum achado. Execute coletas e os agentes gerarão achados.</div></div>';
};

WORKSPACE_RENDERERS.timeline = () => '<section id="investigationTimeline"><p role="status">Consultando atividades registradas…</p></section>';
function mountInvestigationTimeline(container,investigationId){
  let version=0;
  async function load(){
    const ticket=++version;container.innerHTML='<p role="status">Consultando atividades registradas…</p>';
    try {
      const payload=await backendApi('/frontend/bootstrap',{cache:'no-store'});
      if(!container.isConnected||ticket!==version)return;
      if(!Array.isArray(payload?.data?.audit))throw Error('Invalid audit response');
      const events=payload.data.audit.filter(item=>item.module==='osint'&&item.osintMeta?.investigationId===investigationId);
      if(events.some(item=>typeof item.action!=='string'||!Number.isFinite(Date.parse(item.timestamp))))throw Error('Invalid audit records');
      events.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
      container.innerHTML=`<p class="text-muted">Recorte dos 500 eventos mais recentes da organização, filtrado para esta investigação. Eventos anteriores podem não aparecer nesta consulta.</p>${events.length?`<div class="timeline">${events.map(item=>`<div class="timeline-item"><div class="timeline-date">${escapeHTML(fmtDateTime(item.timestamp))} — ${escapeHTML(item.actor)}</div><div class="timeline-content"><strong>${escapeHTML(item.action)}</strong></div></div>`).join('')}</div>`:'<p>Nenhum evento desta investigação na consulta atual.</p>'}<button class="btn btn-secondary" type="button" data-timeline-refresh>Atualizar histórico</button>`;
      container.querySelector('[data-timeline-refresh]').onclick=load;
    } catch(_) {
      if(!container.isConnected||ticket!==version)return;
      container.innerHTML='<p role="alert">Não foi possível consultar as atividades registradas.</p><button class="btn btn-secondary" type="button" data-timeline-refresh>Tentar novamente</button>';
      container.querySelector('[data-timeline-refresh]').onclick=load;
    }
  }
  load();
}

WORKSPACE_RENDERERS.vinculos = (inv) => {
  const ents = DB.osintEntities.filter(e=>e.investigationId===inv.id);
  const rels = DB.osintRelations.filter(r=>r.investigationId===inv.id);
  if (!ents.length) return '<div class="text-muted">Adicione entidades para visualizar vínculos.</div>';
  // Layout radial
  const W=640, H=420, cx=W/2, cy=H/2, r=Math.min(W,H)/2.5;
  const positions = {};
  ents.forEach((e,i)=>{
    const a = (i/ents.length)*Math.PI*2 - Math.PI/2;
    positions[e.id] = {x: cx+Math.cos(a)*r, y: cy+Math.sin(a)*r};
  });
  const edges = rels.map(r=>{
    const a=positions[r.fromEntityId], b=positions[r.toEntityId];
    if (!a||!b) return '';
    const dashed = r.status!=='validada';
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${dashed?'#8b949e':'#00d9ff'}" stroke-width="2" ${dashed?'stroke-dasharray="4,4"':''}>
      <title>${escapeHTML(OSINT_VOCAB.relationType[r.relationType]||r.relationType)} — Confiança ${((r.confidenceScore||0)*100).toFixed(0)}% — ${r.evidenceIds?.length||0} evidência(s) — ${escapeHTML(r.status)}</title>
    </line>`;
  }).join('');
  const nodes = ents.map(e=>{
    const p = positions[e.id];
    const color = e.entityType==='pessoa_juridica'?'#d4a574':e.entityType==='pessoa_fisica'?'#79c0ff':'#00d9ff';
    return `<g transform="translate(${p.x},${p.y})">
      <circle r="22" fill="${color}22" stroke="${color}" stroke-width="2"/>
      <text text-anchor="middle" dy="4" fill="#e6edf3" font-size="11" font-weight="700">${escapeHTML(e.displayName.slice(0,12))}</text>
      <title>${escapeHTML(e.displayName)} — ${escapeHTML(OSINT_VOCAB.entityType[e.entityType])}</title>
    </g>`;
  }).join('');
  return `
    <p class="text-muted mb-12" style="font-size:11px">Linhas pontilhadas = vínculo pendente de validação humana. Cores: ouro = PJ, azul = PF, ciano = outros.</p>
    <svg width="${W}" height="${H}" style="background:var(--obsidian);border:1px solid var(--border-color);border-radius:6px">${edges}${nodes}</svg>
    <h4 class="mt-20" style="font-size:13px">Relações (${rels.length})</h4>
    ${rels.length?`<table style="font-size:11px"><thead><tr><th>De</th><th>Para</th><th>Tipo</th><th>Confiança</th><th>Evidências</th><th>Status</th></tr></thead><tbody>
      ${rels.map(r=>{const f=dbGet('osintEntities',r.fromEntityId),t=dbGet('osintEntities',r.toEntityId);return `<tr><td>${escapeHTML(f?.displayName||'—')}</td><td>${escapeHTML(t?.displayName||'—')}</td><td>${escapeHTML(OSINT_VOCAB.relationType[r.relationType]||r.relationType)}</td><td>${((r.confidenceScore||0)*100).toFixed(0)}%</td><td>${r.evidenceIds?.length||0}</td><td>${escapeHTML(r.status)}</td></tr>`;}).join('')}
    </tbody></table>`:'<div class="text-muted" style="font-size:12px">Nenhuma relação cadastrada.</div>'}
  `;
};

WORKSPACE_RENDERERS.evidencias = (inv, ctx) => {
  const evid = DB.evidence.filter(e=>e.investigationId===inv.id);
  return `
    ${!ctx.isReadOnly?`<button class="btn btn-primary mb-20" onclick="openManualEvidenceForm('${inv.id}')">+ Evidência manual</button>`:''}
    ${evid.length?`<table style="font-size:11px"><thead><tr><th>Data</th><th>Fonte</th><th>Tipo</th><th>SHA-256</th><th>Hash chain</th><th>Validação</th><th></th></tr></thead><tbody>
      ${evid.map(e=>`<tr>
        <td>${fmtDateTime(e.collectedAt)}</td>
        <td>${escapeHTML(e.sourceName)}</td>
        <td>${escapeHTML(e.sourceType||'—')}</td>
        <td style="font-family:'JetBrains Mono';font-size:10px" title="${escapeHTML(e.sha256)}">${escapeHTML(e.sha256.slice(0,16))}...</td>
        <td style="font-family:'JetBrains Mono';font-size:10px" title="${escapeHTML(e.eventHash)}">${escapeHTML((e.eventHash||'').slice(0,12))}</td>
        <td>${e.validationStatus==='validada'?'<span class="status-chip active">✓ '+escapeHTML(e.reviewer||'')+'</span>':'<span class="status-chip pending">Pendente</span>'}</td>
        <td><div class="row-actions">
          <button class="btn btn-small btn-secondary" onclick="showEvidenceDetail('${e.id}')">Ver</button>
          ${!ctx.isReadOnly && e.validationStatus==='pendente'?`<button class="btn btn-small btn-primary" onclick="validateEvidence('${e.id}')">Validar</button>`:''}
        </div></td>
      </tr>`).join('')}
    </tbody></table>`:'<div class="empty-state" style="padding:24px"><div class="text-muted">Sem evidências no cofre.</div></div>'}
  `;
};

WORKSPACE_RENDERERS.relatorio = (inv) => {
  return `
    <p class="text-muted mb-12">Cria um rascunho a partir dos registros salvos. Revise na aba Relatórios; a aprovação gera o PDF final e o preserva no cofre.</p>
    <button class="btn btn-primary" onclick="generateOsintReport('${inv.id}')">📄 Criar rascunho investigativo</button>
    <div class="alert alert-warning mt-20"><span>⚠️</span><span>O relatório organiza dados de fontes públicas e registros técnicos. Não substitui validação jurídica, contraditório, perícia oficial ou decisão judicial.</span></div>
  `;
};

WORKSPACE_RENDERERS.auditoria = (inv) => {
  return '<h3>Histórico de atividades</h3><p>Consulte os registros da organização na área de auditoria. O acesso depende das permissões da sua conta.</p><button class="btn btn-secondary" onclick="closeModal();navigateSection(\'audit\')">Abrir auditoria</button>';
};

// ============================================================
//          OSINT — Operações (entidades, agentes, evidências)
// ============================================================
async function updateInvestigationStatus(id, status){
  if (!confirm(`Mudar status para "${OSINT_VOCAB.status[status]?.label||status}"?`)) return;
  if (isBackendMode()){
    try { await backendApi(`/investigations/${id}`, { method:'PATCH', body: JSON.stringify({ status }) }); }
    catch(err){ toast(apiErrorMessage(err),'error'); return; }
  }
  dbUpdate('investigations', id, {status, updatedAt:Date.now(), closedAt: ['concluida','arquivada'].includes(status)?Date.now():null});
  osintAudit('mudanca_status', id, {newStatus:status});
  toast('Status atualizado','success');
  renderWorkspace();
}

function openEntityForm(investigationId){
  openModal({ title:'Adicionar entidade', body:`
    <div class="form-row">
      <div class="form-group"><label class="form-label">Tipo *</label><select class="form-select" id="ent_type">${Object.entries(OSINT_VOCAB.entityType).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label">Confiança inicial</label><select class="form-select" id="ent_conf"><option value="0.5">50% — preliminar</option><option value="0.7" selected>70% — esperada</option><option value="0.9">90% — alta</option></select></div>
    </div>
    <div class="form-group"><label class="form-label">Nome / Razão Social *</label><input class="form-input" id="ent_name"></div>
    <div class="form-group"><label class="form-label">Documento (CPF/CNPJ/processo/domínio)</label><input class="form-input" id="ent_doc" placeholder="Informe o documento ou domínio do alvo"></div>
    <div class="form-group"><label class="form-label">Aliases (separados por vírgula)</label><input class="form-input" id="ent_aliases"></div>
    <div class="form-group"><label class="form-label">Notas</label><textarea class="form-textarea" id="ent_notes"></textarea></div>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveEntity('${investigationId}')">Salvar</button>` });
}
async function saveEntity(investigationId){
  const name = document.getElementById('ent_name').value.trim();
  const doc = document.getElementById('ent_doc').value.trim();
  if (!name){ toast('Nome obrigatório','error'); return; }
  const {masked, fingerprint} = await maskAndFingerprint(doc);
  const ent = {
    id: uid('oent'),
    investigationId,
    entityType: document.getElementById('ent_type').value,
    displayName: name,
    normalizedName: name.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g,''),
    documentMasked: masked,
    documentFingerprint: fingerprint,
    aliases: document.getElementById('ent_aliases').value.split(',').map(x=>x.trim()).filter(Boolean),
    verificationStatus: 'preliminar',
    confidence: parseFloat(document.getElementById('ent_conf').value),
    notes: document.getElementById('ent_notes').value.trim(),
    createdAt: Date.now()
  };
  try {
    if (isBackendMode()){
      const saved = await backendApi(`/investigations/${investigationId}/entities`, {
        method:'POST',
        body: JSON.stringify({
          entity_type: mapApiEntityType(ent.entityType),
          display_name: ent.displayName,
          normalized_name: ent.normalizedName,
          aliases: ent.aliases,
          identifiers: doc ? [{ type:'document', value:doc, primary:true }] : [],
          verification_status: 'preliminary',
          confidence: ent.confidence,
          notes: ent.notes || null
        })
      });
      ent.id = String(saved.id);
    }
    await refreshBackendBootstrap();
  } catch(err){
    toast(apiErrorMessage(err),'error');
    return;
  }
  osintAudit('adicao_entidade', investigationId, {entityId:ent.id, type:ent.entityType, fingerprint});
  toast('Entidade adicionada','success');
  closeModal(); renderWorkspace();
}

// ============================================================
//          OSINT — Agentes (saída padronizada)
// ============================================================
async function osintConnectorExecute(connectorId, payload, investigationId){
  const cfg = window.SEMPERFI_OSINT_CONFIG;
  const connector = DB.sourceCatalog.find(s=>s.id===connectorId);
  if (!connector) throw new Error('Conector não encontrado');
  if (!connector.enabled) throw new Error(`Conector ${connector.name} está desativado`);

  if (cfg.mode === 'production'){
    const kindMap = {
      brasilapi_cnpj:{ connector_id:'brasilapi', payload:{ kind:'cnpj', value:(payload.target||'').replace(/\D/g,'') }, scope_codes:['empresarial'] },
      brasilapi_cep:{ connector_id:'brasilapi', payload:{ kind:'cep', value:(payload.target||'').replace(/\D/g,'') }, scope_codes:['territorial_cadastral'] },
      brasilapi_ddd:{ connector_id:'brasilapi', payload:{ kind:'ddd', value:(payload.target||'').replace(/\D/g,'') }, scope_codes:['territorial_cadastral'] },
      brasilapi_bancos:{ connector_id:'brasilapi', payload:{ kind:'bank', value:(payload.target||'').replace(/\D/g,'') }, scope_codes:['empresarial'] },
      datajud_cnj:{ connector_id:'datajud', payload:{ process_number: payload.target || '', tribunal_alias: payload.tribunalAlias || 'tjsp' }, scope_codes:['judicial_publico'] },
      rdap_dns:{ connector_id:'rdap_dns', payload:{ domain: payload.target || '', authorized:true }, scope_codes:['digital_defensive'] }
    };
    const mapped = kindMap[connectorId];
    if (!mapped) throw new Error(`Conector ${connectorId} ainda não foi liberado para produção nesta UI.`);
    const investigation = investigationId ? dbGet('investigations', investigationId) : null;
    let res;
    try {
      res = await window.SemperfiConnectorJobs.run(backendApi, {
          connector_id:mapped.connector_id,
          investigation_id: investigationId || null,
          target_entity_id: payload.entityId || null,
          payload:mapped.payload,
          purpose:investigation?.purpose || `Consulta ${connector.name} via interface SEMPER-FI`,
          legal_basis:investigation?.legalBasis || 'legitimo_interesse',
          authorization_reference:investigation?.authorizationReference || 'Fluxo autenticado da interface SEMPER-FI',
          scope_codes:mapped.scope_codes,
          risk_level:mapApiRisk(investigation?.riskLevel || 'low')
      });
    } catch(err){
      throw new Error(apiErrorMessage(err));
    }
    const rawData = res.raw_snapshot || res.normalized_result || {};
    return {
      runId: String(res.run_id),
      summary: Object.values(rawData).filter(v=>typeof v !== 'object').slice(0,3).join(' | ') || `Coleta ${connector.name} concluída`,
      rawData,
      confidence: connector.confidenceWeight || 0.7,
      limitations: res.limitations || [],
      correlationId: res.correlation_id
    };
  }

  throw new Error('Modo inválido ou sem backend');
}

// ---------- Agente 1 — Planejador Investigativo ----------
async function quickPlannerAgent(investigationId, skipBilling=false){
  const previewInv = dbGet('investigations', investigationId);
  const previewEnts = DB.osintEntities.filter(e=>e.investigationId===investigationId);
  if (!previewEnts.length){ toast('Adicione entidades antes de planejar coletas','warning'); return; }
  const previewScope = previewInv.scope || [];
  let previewRecommended = 0;
  previewEnts.forEach(ent => {
    DB.sourceCatalog.filter(s=>s.enabled && (s.allowedTargetTypes.includes(ent.entityType) || s.allowedTargetTypes.includes('endereco'))).forEach(src => {
      const inScope = previewScope.some(sc => src.category===sc);
      if (inScope || src.category==='prova_digital') previewRecommended += 1;
    });
  });
  if (!previewRecommended){ toast('Nenhuma fonte compatível com escopo atual','warning'); return; }
  if (!skipBilling){
    openCreditConsumptionModal('risk_hypothesis', {
      module:'osint',
      reference:`planner-${investigationId}`,
      title:'Confirmar planejamento investigativo',
      description:'O planejamento estruturado registra hipóteses investigativas, prioriza coletas e alimenta a trilha técnica da investigação.',
      onConfirmed: async () => { await quickPlannerAgent(investigationId, true); }
    });
    return;
  }
  const inv = dbGet('investigations', investigationId);
  const ents = DB.osintEntities.filter(e=>e.investigationId===investigationId);
  if (!ents.length){ toast('Adicione entidades antes de planejar coletas','warning'); return; }
  const scope = inv.scope || [];
  const recommended = [];
  ents.forEach(ent => {
    DB.sourceCatalog.filter(s=>s.enabled && (s.allowedTargetTypes.includes(ent.entityType) || s.allowedTargetTypes.includes('endereco'))).forEach(src => {
      const inScope = scope.some(sc => src.category===sc);
      if (inScope || src.category==='prova_digital') recommended.push({entityId:ent.id, connectorId:src.id, purpose:`Coletar ${src.name} para ${ent.displayName}`});
    });
  });
  if (!recommended.length){ toast('Nenhuma fonte compatível com escopo atual','warning'); return; }
  if (!confirm(`Executar ${recommended.length} coleta(s)?`)) return;
  await collectInvestigationFindings(investigationId, recommended.map(task=>({entityId:task.entityId,connectorId:task.connectorId})));
}

const investigationCollections = new Set();
async function collectInvestigationFindings(investigationId, tasks){
  if(investigationCollections.has(investigationId)){toast('Já existe uma coleta em andamento nesta investigação.','info');return;}
  investigationCollections.add(investigationId);
  let succeeded=0,failed=0;
  try{
    for(const task of tasks){
      try{
        const result=await osintConnectorExecute(task.connectorId,{entityId:task.entityId},investigationId);
        await backendApi(`/investigations/${investigationId}/findings`,{method:'POST',body:JSON.stringify({
          entity_id:task.entityId,connector_run_id:result.runId,classification:'dado_bruto',
          title:result.summary.slice(0,255),statement:JSON.stringify(result.rawData).slice(0,500),
          source_name:DB.sourceCatalog.find(source=>source.id===task.connectorId)?.name||task.connectorId,
          source_url:null,method:'connector_run',collected_at:new Date().toISOString(),
          reliability_score:result.confidence||0.7,limitations:result.limitations||[]
        })});
        succeeded++;
      }catch(error){failed++;}
    }
    try{await refreshBackendBootstrap();}
    catch(error){toast('Atualize a investigação para conferir as coletas e os achados salvos.','warning');}
    toast(`Coletas: ${succeeded} com achado salvo; ${failed} sem confirmação. Confira as execuções antes de repetir.`,failed?'warning':'success');
    if(appState.currentSection==='osint'&&osintState.currentInvestigation===investigationId)renderWorkspace();
  }finally{investigationCollections.delete(investigationId);}
}

// Coleta de uma entidade específica (todas as fontes compatíveis em escopo)
async function runAgentsForEntity(investigationId, entityId, skipBilling=false){
  const ent = dbGet('osintEntities', entityId);
  const previewInv = dbGet('investigations', investigationId);
  const previewScope = previewInv.scope||[];
  const previewFontes = DB.sourceCatalog.filter(s=>s.enabled && s.allowedTargetTypes.includes(ent.entityType) && previewScope.some(sc=>s.category===sc));
  if (!previewFontes.length){ toast('Nenhuma fonte em escopo para esta entidade','warning'); return; }
  if (!skipBilling){
    const operationKey = ent?.entityType === 'pessoa_juridica' ? 'company_360'
      : ent?.entityType === 'pessoa_fisica' ? 'person_360'
      : ent?.entityType === 'dominio' || ent?.entityType === 'pagina_web' ? 'digital_trace'
      : 'relationship_map_advanced';
    openCreditConsumptionModal(operationKey, {
      module:'osint',
      reference:`entity-${entityId}`,
      title:'Confirmar operação tarifada de OSINT',
      description:`Alvo: ${ent?.displayName || 'Entidade selecionada'}. Resultados automatizados exigem revisão humana antes de conclusão.`,
      onConfirmed: async () => { await runAgentsForEntity(investigationId, entityId, true); }
    });
    return;
  }
  const inv = dbGet('investigations', investigationId);
  const scope = inv.scope||[];
  const fontes = DB.sourceCatalog.filter(s=>s.enabled && s.allowedTargetTypes.includes(ent.entityType) && scope.some(sc=>s.category===sc));
  await collectInvestigationFindings(investigationId,fontes.map(src=>({entityId,connectorId:src.id})));
}

function showRunDetail(runId){
  const r = DB.osintRuns.find(x=>x.id===runId);
  if (!r) return;
  const src = DB.sourceCatalog.find(s=>s.id===r.connectorId);
  const ent = dbGet('osintEntities', r.targetEntityId);
  const pre = document.createElement('pre');
  pre.style.cssText = 'font-size:11px;white-space:pre-wrap;max-height:300px;overflow:auto;padding:10px;background:var(--obsidian);border-radius:6px';
  pre.textContent = JSON.stringify(r.rawData||{}, null, 2);
  openModal({ wide:true, title:`Coleta ${r.id}`, body:`
    <div class="detail-row"><span class="detail-label">Conector:</span><span class="detail-value">${escapeHTML(src?.name||r.connectorId)}</span></div>
    <div class="detail-row"><span class="detail-label">Alvo:</span><span class="detail-value">${escapeHTML(ent?.displayName||'—')}</span></div>
    <div class="detail-row"><span class="detail-label">Status:</span><span class="detail-value">${escapeHTML(r.status)}</span></div>
    <div class="detail-row"><span class="detail-label">Iniciada:</span><span class="detail-value">${fmtDateTime(r.startedAt)}</span></div>
    <div class="detail-row"><span class="detail-label">Finalizada:</span><span class="detail-value">${r.finishedAt?fmtDateTime(r.finishedAt):'—'}</span></div>
    <div class="detail-row"><span class="detail-label">Resumo:</span><span class="detail-value">${escapeHTML(r.resultSummary||'—')}</span></div>
    <h4 class="mt-20" style="font-size:13px">Resposta bruta</h4>
    <div id="runRawWrap"></div>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Fechar</button>`, onMount:()=>{ document.getElementById('runRawWrap').appendChild(pre); } });
}

function showFindingDetail(findingId){
  const f = DB.osintFindings.find(x=>x.id===findingId);
  if (!f) return;
  openModal({ wide:true, title:`Achado: ${escapeHTML(f.title)}`, body:`
    ${classChip(f.classification)}
    <div class="detail-row mt-12"><span class="detail-label">Confiança:</span><span class="detail-value">${((f.confidenceScore||0)*100).toFixed(0)}%</span></div>
    <div class="detail-row"><span class="detail-label">Fontes:</span><span class="detail-value">${f.sourceCount||0}</span></div>
    <div class="detail-row"><span class="detail-label">Validação humana:</span><span class="detail-value">${f.humanValidated?'✓ '+escapeHTML(f.reviewer||''):'Pendente'}</span></div>
    <h4 class="mt-20" style="font-size:13px">Declaração</h4>
    <div style="padding:10px;background:var(--obsidian);border-radius:6px;font-size:12px">${escapeHTML(f.statement)}</div>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Fechar</button>` });
}

async function validateFinding(findingId){
  const reviewer = SETTINGS.userName || '';
  if (isBackendMode()){
    try { await backendApi(`/findings/${findingId}`, { method:'PATCH', body: JSON.stringify({ human_validated:true, classification:'conclusao_humana' }) }); }
    catch(err){ toast(apiErrorMessage(err),'error'); return; }
  }
  dbUpdate('osintFindings', findingId, {humanValidated:true, reviewer, classification:'conclusao_humana', updatedAt:Date.now()});
  const f = DB.osintFindings.find(x=>x.id===findingId);
  osintAudit('validacao_achado', f.investigationId, {findingId, reviewer});
  toast('Achado validado','success');
  renderWorkspace();
}

async function promoteFindingToEvidence(findingId){
  const f = DB.osintFindings.find(x=>x.id===findingId);
  if (!f){ toast('Achado não encontrado','error'); return; }
  const inv = dbGet('investigations', f.investigationId);
  const run = DB.osintRuns.find(r=>r.id===f.runId);
  const src = DB.sourceCatalog.find(s=>s.id===f.type);
  const rawString = JSON.stringify(run?.rawData || f.statement);
  if (isBackendMode()){
    try {
      if(!f.runId && !f.evidenceIds?.[0])throw new Error('Este achado antigo não possui vínculo com a coleta original. Consulte a fonte novamente antes de preservar o resultado completo.');
      let storedContent = rawString;
      if(f.runId){
        const source = await backendApi(`/osint/runs/${encodeURIComponent(f.runId)}`,{cache:'no-store'});
        if(source.status!=='completed'||source.investigation_id!==f.investigationId||source.raw_snapshot==null)throw new Error('O resultado completo da coleta não está disponível para preservação.');
        storedContent = JSON.stringify(source.raw_snapshot);
      }
      const result = await createBackendEvidenceRecord({
        investigationId: f.investigationId,
        findingId,
        existingEvidenceId: f.evidenceIds?.[0] || null,
        sourceName: src?.name || f.title || f.type,
        sourceType: src?.connectorType || 'connector_output',
        sourceUrl: run?.sourceUrl || '',
        collectionMethod: 'agente_automatico',
        content: storedContent,
        filename: `finding-${findingId}.json`,
        mimeType: 'application/json'
      });
      toast(result.warning ? `Arquivo recebido, com etapa pendente: ${result.warning}` : 'Achado promovido a evidência', result.warning ? 'warning' : 'success');
      renderWorkspace();
    } catch(err){
      toast(apiErrorMessage(err),'error');
    }
    return;
  }
  const sha256 = await sha256Hex(rawString);
  const previousEventHash = (DB.evidenceEvents[DB.evidenceEvents.length-1]?.currentHash) || '0'.repeat(64);
  const collectedAt = run?.finishedAt || Date.now();
  const evid = {
    id: uid('evd'),
    investigationId: f.investigationId, findingId, entityId: f.entityId,
    sourceName: src?.name || f.type, sourceType: src?.connectorType || 'manual',
    sourceUrl: f.sourceUrl || '', collectionMethod: 'agente_automatico',
    collectedAt, collectedAtUtc: new Date(collectedAt).toISOString(),
    actor: SETTINGS.userName || '',
    rawPayloadReference: rawString.slice(0, 2000),
    visualSnapshotReference: null, originalFileId: null,
    sha256, previousEventHash, eventHash: null,
    timestampTokenReference: null,
    validationStatus: 'pendente', reviewer: null, notes: null,
    retentionUntil: inv.retentionUntil
  };
  evid.eventHash = await sha256Hex(previousEventHash + JSON.stringify({sha256, sourceName:evid.sourceName, collectedAt}));
  DB.evidence.push(evid);
  DB.evidenceEvents.push({ id:uid('evev'), evidenceId:evid.id, investigationId:f.investigationId, action:'criacao', actor:evid.actor, timestamp:Date.now(), previousHash:previousEventHash, currentHash:evid.eventHash, details:{sha256, source:evid.sourceName} });
  dbUpdate('osintFindings', findingId, {evidenceIds: [...(f.evidenceIds||[]), evid.id], classification:'achado', updatedAt:Date.now()});
  saveDB();
  osintAudit('inclusao_evidencia', f.investigationId, {evidenceId:evid.id, findingId, sha256:sha256.slice(0,16)});
  toast('Achado promovido a evidência','success');
  renderWorkspace();
}

function openManualEvidenceForm(investigationId){
  openModal({ title:'Evidência manual', body:`
    <div class="form-group"><label class="form-label">Fonte (nome) *</label><input class="form-input" id="ev_source"></div>
    <div class="form-group"><label class="form-label">URL de origem</label><input class="form-input" id="ev_url" placeholder="https://..."></div>
    <div class="form-group"><label class="form-label">Tipo</label><select class="form-select" id="ev_type"><option>pagina_web</option><option>documento</option><option>imagem</option><option>video</option><option>resposta_api</option></select></div>
    <div class="form-group"><label class="form-label">Conteúdo / observação *</label><textarea class="form-textarea" id="ev_content" style="min-height:120px" placeholder="Cole texto, descrição ou referência. O conteúdo gera o hash SHA-256."></textarea></div>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveManualEvidence('${investigationId}')">Registrar</button>` });
}
async function saveManualEvidence(investigationId){
  const source = document.getElementById('ev_source').value.trim();
  const url = document.getElementById('ev_url').value.trim();
  const type = document.getElementById('ev_type').value;
  const content = document.getElementById('ev_content').value;
  if (!source || !content){ toast('Fonte e conteúdo obrigatórios','error'); return; }
  if (isBackendMode()){
    try {
      const result = await createBackendEvidenceRecord({
        investigationId,
        sourceName: source,
        sourceType: type,
        sourceUrl: url,
        collectionMethod: 'captura_manual',
        content,
        filename: `manual-${Date.now()}.txt`,
        mimeType: 'text/plain'
      });
      toast(result.warning ? `Arquivo recebido, com etapa pendente: ${result.warning}` : 'Evidência preservada', result.warning ? 'warning' : 'success');
      closeModal();
      renderWorkspace();
    } catch(err){
      toast(apiErrorMessage(err),'error');
    }
    return;
  }
  const inv = dbGet('investigations', investigationId);
  const sha256 = await sha256Hex(content);
  const previousEventHash = (DB.evidenceEvents[DB.evidenceEvents.length-1]?.currentHash) || '0'.repeat(64);
  const evid = {
    id: uid('evd'), investigationId, findingId:null, entityId:null,
    sourceName:source, sourceType:type, sourceUrl:url,
    collectionMethod:'captura_manual',
    collectedAt:Date.now(), collectedAtUtc:new Date().toISOString(),
    actor:SETTINGS.userName||'',
    rawPayloadReference:content.slice(0,2000),
    visualSnapshotReference:null, originalFileId:null,
    sha256, previousEventHash, eventHash:null, timestampTokenReference:null,
    validationStatus:'pendente', reviewer:null, notes:null,
    retentionUntil:inv.retentionUntil
  };
  evid.eventHash = await sha256Hex(previousEventHash + JSON.stringify({sha256, sourceName:source, collectedAt:evid.collectedAt}));
  DB.evidence.push(evid);
  DB.evidenceEvents.push({ id:uid('evev'), evidenceId:evid.id, investigationId, action:'criacao_manual', actor:evid.actor, timestamp:Date.now(), previousHash:previousEventHash, currentHash:evid.eventHash, details:{source, url} });
  saveDB();
  osintAudit('inclusao_evidencia', investigationId, {evidenceId:evid.id, method:'manual'});
  toast('Evidência registrada','success'); closeModal(); renderWorkspace();
}

async function validateEvidence(evidenceId){
  const evid = DB.evidence.find(e=>e.id===evidenceId);
  if (!evid) return;
  if (isBackendMode()){
    try {
      await backendApi(`/evidences/${evidenceId}/attest`, { method:'POST' });
      await refreshBackendBootstrap();
      toast('Evidência validada','success');
      renderWorkspace();
    } catch(err){
      toast(apiErrorMessage(err),'error');
    }
    return;
  }
  const reviewer = SETTINGS.userName||'';
  const previousEventHash = evid.eventHash;
  const newHash = await sha256Hex(previousEventHash + JSON.stringify({action:'validacao', reviewer, at:Date.now()}));
  evid.validationStatus = 'validada'; evid.reviewer = reviewer; evid.eventHash = newHash;
  DB.evidenceEvents.push({ id:uid('evev'), evidenceId, investigationId:evid.investigationId, action:'validacao_humana', actor:reviewer, timestamp:Date.now(), previousHash:previousEventHash, currentHash:newHash, details:{reviewer} });
  saveDB();
  osintAudit('validacao_evidencia', evid.investigationId, {evidenceId, reviewer});
  toast('Evidência validada','success');
  renderWorkspace();
}

function showEvidenceDetail(evidenceId){
  const e = DB.evidence.find(x=>x.id===evidenceId);
  if (!e) return;
  const events = DB.evidenceEvents.filter(ev=>ev.evidenceId===evidenceId).sort((a,b)=>a.timestamp-b.timestamp);
  openModal({ wide:true, title:`Evidência ${e.id}`, body:`
    <div class="detail-row"><span class="detail-label">Fonte:</span><span class="detail-value">${escapeHTML(e.sourceName)}</span></div>
    <div class="detail-row"><span class="detail-label">URL:</span><span class="detail-value">${escapeHTML(e.sourceUrl||'—')}</span></div>
    <div class="detail-row"><span class="detail-label">Método:</span><span class="detail-value">${escapeHTML(e.collectionMethod)}</span></div>
    <div class="detail-row"><span class="detail-label">Coletor:</span><span class="detail-value">${escapeHTML(e.actor)}</span></div>
    <div class="detail-row"><span class="detail-label">Data local:</span><span class="detail-value">${fmtDateTime(e.collectedAt)}</span></div>
    <div class="detail-row"><span class="detail-label">Data UTC:</span><span class="detail-value">${escapeHTML(e.collectedAtUtc)}</span></div>
    <div class="detail-row"><span class="detail-label">Validação:</span><span class="detail-value">${escapeHTML(e.validationStatus)} ${e.reviewer?'— '+escapeHTML(e.reviewer):''}</span></div>
    <div class="detail-row"><span class="detail-label">Retenção até:</span><span class="detail-value">${fmtDate(e.retentionUntil)}</span></div>
    <h4 class="mt-20" style="font-size:13px">Hashes</h4>
    <div style="font-family:'JetBrains Mono';font-size:10px;padding:10px;background:var(--obsidian);border-radius:6px;word-break:break-all">
      <div><strong>SHA-256:</strong> ${escapeHTML(e.sha256)}</div>
      <div style="margin-top:6px"><strong>Hash anterior:</strong> ${escapeHTML(e.previousEventHash)}</div>
      <div style="margin-top:6px"><strong>Hash atual:</strong> ${escapeHTML(e.eventHash)}</div>
    </div>
    <h4 class="mt-20" style="font-size:13px">Cadeia de eventos</h4>
    <div class="timeline">${events.map(ev=>`<div class="timeline-item"><div class="timeline-date">${fmtDateTime(ev.timestamp)} — ${escapeHTML(ev.actor)}</div><div class="timeline-content"><strong>${escapeHTML(ev.action)}</strong><div style="font-family:'JetBrains Mono';font-size:10px;margin-top:4px;color:var(--text-secondary)">${escapeHTML((ev.currentHash||'').slice(0,40))}...</div></div></div>`).join('')}</div>
    <h4 class="mt-20" style="font-size:13px">Payload (primeiros 2KB)</h4>
    <div id="evidPayloadWrap"></div>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Fechar</button>`, onMount:()=>{
    const pre = document.createElement('pre');
    pre.style.cssText = 'font-size:10px;white-space:pre-wrap;max-height:200px;overflow:auto;padding:10px;background:var(--obsidian);border-radius:6px';
    pre.textContent = e.rawPayloadReference || '(vazio)';
    document.getElementById('evidPayloadWrap').appendChild(pre);
  } });
}

// ============================================================
//          OSINT — Relatório técnico investigativo
// ============================================================
const reportCommands = new Map();
async function generateOsintReport(investigationId, confirmed=false){
  if(!confirmed){
    openCreditConsumptionModal('report_pdf_hash',{description:'Criar um rascunho com os registros salvos desta investigação? A aprovação e o PDF final serão realizados na aba Relatórios.',onConfirmed:()=>generateOsintReport(investigationId,true)});
    return;
  }
  let command=reportCommands.get(investigationId);
  if(command?.pending)return;
  if(!command){command={requestId:crypto.randomUUID()};reportCommands.set(investigationId,command);}
  command.pending=true;
  try{
    const result=await backendApi(`/investigations/${encodeURIComponent(investigationId)}/report-draft`,{method:'POST',body:JSON.stringify({request_id:command.requestId})});
    if(!result.report_id||!['DRAFT','FINAL'].includes(result.status)||!/^[a-f0-9]{64}$/.test(result.content_hash||''))throw Error('Resposta do relatório inválida.');
    reportCommands.delete(investigationId);closeModal();navigateSection('reports');
    toast('Rascunho salvo. Revise o conteúdo na lista antes de aprovar o PDF.','success');
  }catch(error){toast('Não foi possível confirmar o rascunho. Consulte Relatórios ou tente novamente; a mesma solicitação será retomada.','error');}
  finally{command.pending=false;}
}
// ============================================================
//          OSINT TOOLS — Conjunto rápido de ferramentas
//          Arquitetura híbrida: determinístico primeiro, IA opcional
// ============================================================

const OSINT_TOOLS = [
  {id:'domain', icon:'🌐', name:'Domain Lookup', desc:'DNS, certificados SSL via crt.sh, histórico Wayback', kind:'domain'},
  {id:'ip', icon:'🖥️', name:'IP Geolocation', desc:'Localização aproximada da rede, ISP e ASN', kind:'ip'},
  {id:'email', icon:'✉️', name:'Email Validation', desc:'Formato e registros MX, sem confirmar a caixa postal', kind:'email'},
  {id:'github', icon:'🐙', name:'GitHub Profile', desc:'Perfil público e contagem de repositórios', kind:'github'},
  {id:'cep', icon:'📍', name:'CEP / Endereço', desc:'Dados de endereço disponíveis na BrasilAPI', kind:'cep'},
  {id:'phone', icon:'📱', name:'Phone Validation', desc:'Formato brasileiro e DDD, sem confirmar titularidade', kind:'phone'},
  {id:'urlthreat', icon:'⚠️', name:'URL Threat Check', desc:'URLhaus — base de URLs maliciosas', kind:'urlthreat'},
  {id:'username', icon:'👤', name:'Username Search', desc:'Perfis públicos no GitHub e GitLab', kind:'username'},
  {id:'headers', icon:'🔍', name:'HTTP Headers', desc:'Cabeçalhos HTTPS públicos de endereço autorizado', kind:'headers'},
  {id:'dns', icon:'📡', name:'DNS Records', desc:'A/MX/NS/TXT via Google DNS-over-HTTPS', kind:'dns'},
  {id:'crt', icon:'🔐', name:'Certificate Transparency', desc:'Subdomínios via crt.sh', kind:'crt'},
  {id:'wayback', icon:'🕰️', name:'Wayback Machine', desc:'Snapshots históricos', kind:'wayback'}
];

const osintToolsState = { selected:null, lastResult:null, loading:false };

SECTION_RENDERERS.osinttools = () => `
  <h1 class="page-title">⚒️ OSINT Tools</h1>
  <p class="page-subtitle">Consulte informações públicas e revise os resultados antes de utilizá-los na investigação.</p>
  <p>“Analisar com IA” prepara o resultado para revisão na área de assistência. A análise começa somente após sua confirmação nessa área.</p>
  <div class="panel mb-20">
    <div class="panel-title">Selecione a ferramenta</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
      ${OSINT_TOOLS.map(t=>`<button type="button" onclick="selectOsintTool('${t.id}')" style="padding:14px;color:var(--text-primary);text-align:left;background:var(--obsidian);border-radius:8px;cursor:pointer;border:2px solid ${osintToolsState.selected===t.id?'var(--teal-accent)':'var(--border-color)'};transition:all .15s">
        <div style="font-size:22px;margin-bottom:6px">${t.icon}</div>
        <div style="font-weight:700;font-size:13px;margin-bottom:4px">${escapeHTML(t.name)}</div>
        <div class="text-muted" style="font-size:11px">${escapeHTML(t.desc)}</div>
      </button>`).join('')}
    </div>
  </div>
  ${osintToolsState.selected ? renderOsintToolPanel() : ''}
  <section class="panel mt-20"><h2>Histórico de consultas</h2><p>Execuções registradas no servidor. Abrir ou acompanhar uma execução não repete a consulta.</p><button class="btn btn-secondary" type="button" onclick="loadOsintToolHistory()">Atualizar histórico</button><div id="otHistory"></div></section>
`;
SECTION_AFTER.osinttools = () => {loadOsintToolHistory();};

function selectOsintTool(id){ if(osintToolsState.loading || osintToolsState.preserving)return; osintToolsState.selected = id; osintToolsState.lastResult=null; osintToolsState.target=''; osintToolsState.consent=false; renderSection('osinttools'); }

function renderOsintToolPanel(){
  const t = OSINT_TOOLS.find(x=>x.id===osintToolsState.selected);
  const placeholders = {
    domain:'exemplo.com.br', ip:'8.8.8.8', email:'user@dominio.com',
    github:'octocat', cep:'01310-100', phone:'+5511987654321',
    urlthreat:'https://url-suspeita.com', username:'octocat',
    headers:'https://example.com', dns:'google.com', crt:'cloudflare.com',
    wayback:'https://wikipedia.org'
  };
  return `
    <div class="panel">
      <div class="panel-title">${t.icon} ${escapeHTML(t.name)}</div>
      <div class="form-group"><label class="form-label" for="otTarget">Alvo</label>
        <input class="form-input" id="otTarget" value="${escapeHTML(osintToolsState.target || '')}" placeholder="${placeholders[t.kind]||''}">
      </div>
      <div class="form-group"><label class="form-label" for="otPurpose">Finalidade *</label><textarea class="form-textarea" id="otPurpose" minlength="10" maxlength="4000">${escapeHTML(osintToolsState.purpose||'')}</textarea></div>
      <div class="form-group"><label class="form-label" for="otBasis">Base legal *</label><select class="form-select" id="otBasis">${['contrato','legitimo_interesse','obrigacao_legal','consentimento'].map(value=>`<option value="${value}" ${value===(osintToolsState.legalBasis||'contrato')?'selected':''}>${escapeHTML(OSINT_VOCAB.legalBasis[value]||value.replaceAll('_',' '))}</option>`).join('')}</select></div>
      <div class="form-group"><label class="form-label" for="otReference">Referência de autorização *</label><input class="form-input" id="otReference" maxlength="255" value="${escapeHTML(osintToolsState.authorizationReference||'')}"></div>
      <div class="form-group"><label class="form-label" for="otInvestigation">Investigação vinculada</label><select class="form-select" id="otInvestigation"><option value="">Sem vínculo</option>${DB.investigations.filter(item=>!['deleted','arquivada','bloqueada'].includes(item.status)).map(item=>`<option value="${escapeHTML(item.id)}" ${item.id===osintToolsState.investigationId?'selected':''}>${escapeHTML(item.title)}</option>`).join('')}</select></div>
      <div class="form-group"><label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text-secondary);cursor:pointer">
        <input type="checkbox" id="otConsent" ${osintToolsState.consent ? 'checked' : ''}> Confirmo finalidade legítima e autorização para consultar o alvo; consultas de rede têm escopo defensivo.
      </label></div>
      <button class="btn btn-primary" onclick="runOsintTool()" ${osintToolsState.loading?'disabled':''}>${osintToolsState.loading?'<span class="spinner"></span> Consultando...':'Executar'}</button>
      <p id="otProgress" role="status">${osintToolsState.loading?'Acompanhando consulta registrada no servidor…':''}</p><div id="otResult" class="mt-20">${osintToolsState.lastResult?renderOsintToolResult():''}</div>
    </div>
  `;
}

async function runOsintTool(){
  if (osintToolsState.loading || osintToolsState.preserving) return;
  const t = OSINT_TOOLS.find(x=>x.id===osintToolsState.selected);
  const val = document.getElementById('otTarget').value.trim();
  const consent = document.getElementById('otConsent').checked;
  osintToolsState.purpose=document.getElementById('otPurpose').value.trim();
  osintToolsState.legalBasis=document.getElementById('otBasis').value;
  osintToolsState.authorizationReference=document.getElementById('otReference').value.trim();
  osintToolsState.investigationId=document.getElementById('otInvestigation').value;
  if(osintToolsState.purpose.length<10||osintToolsState.authorizationReference.length<3){toast('Informe a finalidade e a referência de autorização.','error');return;}
  if (!val){ toast('Informe o alvo','error'); return; }
  if (!consent){ toast('Marque a declaração','error'); return; }
  osintToolsState.target=val; osintToolsState.consent=consent;
  osintToolsState.loading = true; osintToolsState.lastResult=null; renderSection('osinttools');
  try {
    const result = await dispatchOsintTool(t.kind, val);
    osintToolsState.lastResult = acceptOsintToolResult(result);
    toast(osintToolsState.lastResult.data.partial ? 'Consulta parcial. Confira as limitações.' : 'Consulta concluída e registrada.', osintToolsState.lastResult.data.partial ? 'warning' : 'success');
  } catch(e){
    osintToolsState.lastResult = { tool:t, target:val, error:e.serverCode==='ProviderNotConfigured'?'A fonte aguarda configuração da credencial pelo administrador.':'Não foi possível concluir o acompanhamento. Consulte o histórico antes de iniciar outra consulta.', ok:false };
    audit('osinttools', t.kind, val, 'erro');
    toast(osintToolsState.lastResult.error,'error');
  }
  osintToolsState.loading = false;
  if (appState.currentSection === 'osinttools') renderSection('osinttools');
}

async function dispatchOsintTool(kind,value){
  return window.SemperfiConnectorJobs.run(backendApi,{
    connector_id:'osint_tools',investigation_id:osintToolsState.investigationId||null,
    payload:{tool:kind,value,authorized:osintToolsState.consent===true},
    purpose:osintToolsState.purpose,legal_basis:osintToolsState.legalBasis,
    authorization_reference:osintToolsState.authorizationReference,
    scope_codes:['digital_defensive'],risk_level:'low'
  },{onProgress(progress){osintToolsState.runId=progress.runId;const el=document.getElementById('otProgress');if(el)el.textContent=progress.status==='submitting'?'Enviando consulta…':progress.status==='queued'?'Consulta registrada; aguardando execução.':'Acompanhando consulta…';}});
}
function acceptOsintToolResult(response){
  const data=response.raw_snapshot;
  if(response.connector_id!=='osint_tools'||response.status!=='completed'||!data||!data.tool||!OSINT_TOOLS.some(tool=>tool.id===data.tool)||!data.data)throw Error('Resultado de consulta inválido.');
  return {runId:response.id||response.run_id,tool:OSINT_TOOLS.find(tool=>tool.id===data.tool),target:data.target,data,at:response.created_at,investigationId:response.investigation_id,ok:true};
}
async function openOsintToolRun(id){
  if(osintToolsState.loading||osintToolsState.preserving)return;
  osintToolsState.loading=true;
  try{
    const result=await window.SemperfiConnectorJobs.resume(backendApi,id);
    osintToolsState.lastResult=acceptOsintToolResult(result);osintToolsState.selected=osintToolsState.lastResult.tool.id;
    osintToolsState.target=osintToolsState.lastResult.target;osintToolsState.investigationId=result.investigation_id||'';
    osintToolsState.purpose=result.purpose||'';osintToolsState.legalBasis=result.legal_basis||'contrato';osintToolsState.authorizationReference='';osintToolsState.consent=false;
  }catch(error){osintToolsState.lastResult={ok:false,error:'A consulta não foi concluída. Confira a configuração da fonte e a fila de processamento antes de iniciar outra consulta.'};}
  finally{osintToolsState.loading=false;if(appState.currentSection==='osinttools')renderSection('osinttools');}
}
async function loadOsintToolHistory(){
  const container=document.getElementById('otHistory');if(!container)return;
  const ticket={};osintToolsState.historyRequest=ticket;
  container.innerHTML='<p role="status">Consultando histórico salvo…</p>';
  const offset=osintToolsState.historyOffset||0;
  try{
    const rows=await backendApi(`/osint/runs?connector_id=osint_tools&limit=20&offset=${offset}`,{cache:'no-store'});
    if(!container.isConnected||osintToolsState.historyRequest!==ticket)return;
    if(!Array.isArray(rows))throw Error('Histórico inválido.');
    const statuses={queued:'Aguardando execução',running:'Em execução',completed:'Concluída',failed:'Falhou'};
    container.innerHTML=rows.length?rows.map(row=>`<article class="panel mt-12"><h3>${escapeHTML(OSINT_TOOLS.find(tool=>tool.id===row.tool)?.name||'Consulta registrada')}</h3><p>${escapeHTML(row.purpose)} · ${escapeHTML(fmtDateTime(row.created_at))} · ${escapeHTML(statuses[row.status]||'Situação indisponível')}</p><button type="button" class="btn btn-secondary" data-tool-run="${escapeHTML(row.id)}">${row.status==='completed'?'Abrir resultado':'Acompanhar execução'}</button></article>`).join(''):'<p>Nenhuma consulta nesta página do histórico.</p>';
    container.innerHTML+=`<div class="filter-bar mt-12"><button type="button" class="btn btn-secondary" data-history-prev ${offset===0?'disabled':''}>Mais recentes</button><button type="button" class="btn btn-secondary" data-history-next ${rows.length<20?'disabled':''}>Mais antigas</button></div>`;
    container.querySelectorAll('[data-tool-run]').forEach(button=>button.onclick=()=>openOsintToolRun(button.dataset.toolRun));
    container.querySelector('[data-history-prev]').onclick=()=>{osintToolsState.historyOffset=Math.max(0,offset-20);loadOsintToolHistory();};
    container.querySelector('[data-history-next]').onclick=()=>{osintToolsState.historyOffset=offset+20;loadOsintToolHistory();};
  }catch(error){if(container.isConnected){container.innerHTML='<p role="alert">Não foi possível consultar o histórico.</p><button type="button" class="btn btn-secondary">Tentar novamente</button>';container.querySelector('button').onclick=loadOsintToolHistory;}}
}
function renderOsintToolResult(){
  const r = osintToolsState.lastResult;
  if (!r.ok) return `<div class="alert alert-danger"><span>✕</span><span>${escapeHTML(apiErrorMessage(r.error))}</span></div>`;
  return `
    <div class="alert ${r.data.partial ? 'alert-warning' : 'alert-success'}"><span>${r.data.partial ? '⚠' : '✓'}</span><span>${r.data.partial ? 'Consulta parcial' : 'Consulta concluída'} em ${new Date(r.at).toLocaleTimeString('pt-BR')} • Alvo: <strong>${escapeHTML(r.target)}</strong></span></div>
    <div class="filter-bar">
      <button class="btn btn-secondary btn-small" onclick="preserveOsintResult()" ${osintToolsState.preserving || r.preserved ? 'disabled' : ''}>${r.preserved ? '✓ Evidência preservada' : osintToolsState.preserving ? 'Preservando…' : r.evidenceId ? 'Retomar preservação' : '🔒 Preservar como evidência'}</button>
      <button class="btn btn-primary btn-small" onclick="analyzeWithAI()">🤖 Analisar com IA</button>
    </div>
    <div id="otRawWrap" class="mt-12">${window.SemperfiIntegrations.renderResult(r.data)}</div>
  `;
}

async function preserveOsintResult(){
  const r = osintToolsState.lastResult;
  if (!r?.ok || osintToolsState.preserving || r.preserved) return;
  if (isBackendMode()){
    osintToolsState.preserving = true; renderSection('osinttools');
    try {
      const source=await backendApi(`/osint/runs/${encodeURIComponent(r.runId)}`,{cache:'no-store'});
      if(source.status!=='completed'||source.raw_snapshot==null)throw Error('O resultado salvo da consulta não está disponível.');
      const content=JSON.stringify(source.raw_snapshot);
      const result = await createBackendEvidenceRecord({
        investigationId: source.investigation_id || null,
        sourceName: `${r.tool.name} - ${r.target}`,
        sourceType: 'tool_result',
        sourceUrl: '',
        collectionMethod: 'captura_manual',
        content,
        filename: `osint-tool-${Date.now()}.json`,
        mimeType: 'application/json'
      });
      r.evidenceId = result.evidenceId; r.preserved = result.preserved;
      toast(result.warning ? `Arquivo recebido, com etapa pendente: ${result.warning}` : 'Evidência preservada', result.warning ? 'warning' : 'success');
      audit('osinttools','preservacao_evidencia',r.tool.kind+':'+r.target,result.preserved ? 'sucesso' : 'pendente');
    } catch(err){
      toast(apiErrorMessage(err),'error');
    } finally {
      osintToolsState.preserving = false;
      if (appState.currentSection === 'osinttools') renderSection('osinttools');
    }
    return;
  }
  toast('Conecte-se ao sistema para registrar e preservar a evidência.','warning');
}

function analyzeWithAI(){
  const result = osintToolsState.lastResult;
  if (!result?.ok) { toast('Faça uma consulta antes de preparar a análise.', 'warning'); return; }
  const text = JSON.stringify(result.data, null, 2);
  if (text.length > 12000) { toast('O resultado excede o limite de análise. Selecione um trecho de até 12.000 caracteres em Agentes IA.', 'warning'); return; }
  navigateSection('agentes');
  document.getElementById('agentType').value = 'correlation';
  const input = document.getElementById('agentInput');
  input.value = text; input.focus();
  toast('Revise o conteúdo e informe a finalidade e a autorização antes de iniciar a análise.', 'info');
}
// ============================================================
//          CENTRAL DE AGENTES IA — 16 agentes especializados
//          Cada agente decide internamente: determinístico ou LLM
// ============================================================

const AGENTES_IA = [
  {id:'osint_web', icon:'🌐', cat:'OSINT', name:'OSINT Web', desc:'Busca em fontes abertas + extração de entidades. Determinístico (DuckDuckGo HTML)', stack:'regex+http', kind:'osint_web'},
  {id:'osint_network', icon:'🔌', cat:'OSINT', name:'OSINT Network', desc:'DNS, geo-IP, BGP/ASN, RDAP. Zero IA.', stack:'http', kind:'network'},
  {id:'dns_recon', icon:'🔎', cat:'OSINT', name:'DNS Recon', desc:'Subdomínios via crt.sh + SPF/DMARC/DKIM', stack:'http', kind:'dns_recon'},
  {id:'shodan', icon:'📡', cat:'OSINT', name:'Shodan Intel', desc:'Portas, banners, CVEs. Requer API key.', stack:'http+key', kind:'shodan'},
  {id:'socmint_redes', icon:'👥', cat:'SOCMINT', name:'SOCMINT Redes', desc:'Análise de perfis em 40+ redes (manual_check links)', stack:'http+links', kind:'socmint_redes'},
  {id:'socmint_user', icon:'🔗', cat:'SOCMINT', name:'Username Enum', desc:'Cross-platform username search (método Sherlock)', stack:'http-parallel', kind:'socmint_user'},
  {id:'dark_web', icon:'🕶️', cat:'SOCMINT', name:'Dark Web Monitor', desc:'Stub: requer backend Tor proxy + watchlist', stack:'backend-only', kind:'dark_web'},
  {id:'finint_fiscal', icon:'💰', cat:'FININT', name:'FININT Fiscal BR', desc:'CNPJ completo via BrasilAPI + validação CPF (mod 11)', stack:'http+regex', kind:'finint_fiscal'},
  {id:'finint_cripto', icon:'₿', cat:'FININT', name:'FININT Cripto', desc:'BTC saldo+tx via blockchain.info', stack:'http', kind:'finint_cripto'},
  {id:'finint_coaf', icon:'🏦', cat:'FININT', name:'FININT COAF/AML', desc:'Padrões suspeitos + cross-check OFAC/ONU (stub)', stack:'rule+ai', kind:'finint_coaf'},
  {id:'meta_exif', icon:'📷', cat:'METADATA', name:'Metadata EXIF', desc:'GPS, dispositivo, timestamps (lib client-side)', stack:'client-side', kind:'meta_exif'},
  {id:'email_headers', icon:'📧', cat:'METADATA', name:'Análise Email', desc:'Headers SMTP, DKIM/SPF/DMARC, IP real', stack:'regex', kind:'email_headers'},
  {id:'meta_doc', icon:'📄', cat:'METADATA', name:'Metadata Documento', desc:'PDF/DOCX/XLSX metadata extraction', stack:'client-side', kind:'meta_doc'},
  {id:'breach', icon:'🔓', cat:'BREACH', name:'Breach Scan', desc:'HIBP — requer API key', stack:'http+key', kind:'breach'},
  {id:'geoint', icon:'🗺️', cat:'GEOINT', name:'Geo-OSINT', desc:'Geocoding via Nominatim + EXIF GPS', stack:'http', kind:'geoint'},
  {id:'maltego', icon:'🕸️', cat:'GRAPH', name:'Maltego Grafo', desc:'Transformações entidade→entidade (grafo local)', stack:'graph-traversal', kind:'maltego'}
];

const agentesState = { selected:null, lastResult:null, loading:false, categoryFilter:'todas' };

SECTION_RENDERERS.agentes = () => {
  const categorias = ['todas', ...new Set(AGENTES_IA.map(a=>a.cat))];
  const filtered = AGENTES_IA.filter(a => agentesState.categoryFilter==='todas' || a.cat===agentesState.categoryFilter);
  return `
    <h1 class="page-title">🤖 Central de Agentes IA</h1>
    <p class="page-subtitle">16 agentes especializados. <strong>Stack visível em cada card</strong> — IA premium só é chamada onde agrega valor.</p>
    <div class="alert alert-info"><span>💡</span><span><strong>Princípio:</strong> "regex+http" custa frações de centavo. "rule+ai" usa heurística + LLM compacto. "backend-only" exige microserviço dedicado.</span></div>
    <div class="filter-bar mb-20">
      <div class="pill-group">${categorias.map(c=>`<div class="pill ${agentesState.categoryFilter===c?'active':''}" onclick="agentesState.categoryFilter='${c}';renderSection('agentes')">${c.toUpperCase()}</div>`).join('')}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
      ${filtered.map(a=>`<div class="panel" style="cursor:pointer;border:2px solid ${agentesState.selected===a.id?'var(--teal-accent)':'var(--border-color)'}" onclick="selectAgent('${a.id}')">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div style="font-size:26px">${a.icon}</div>
          <span class="badge badge-primary" style="font-size:9px">${escapeHTML(a.cat)}</span>
        </div>
        <div style="font-weight:700;margin-bottom:4px">${escapeHTML(a.name)}</div>
        <div class="text-muted" style="font-size:11px;margin-bottom:8px">${escapeHTML(a.desc)}</div>
        <div style="font-family:'JetBrains Mono';font-size:9px;color:var(--gold-accent)">⚙ ${a.stack}</div>
      </div>`).join('')}
    </div>
    ${agentesState.selected ? renderAgentePanel() : ''}
  `;
};
SECTION_AFTER.agentes = () => {};

function selectAgent(id){ agentesState.selected=id; agentesState.lastResult=null; renderSection('agentes'); }

function renderAgentePanel(){
  const a = AGENTES_IA.find(x=>x.id===agentesState.selected);
  return `
    <div class="panel mt-20">
      <div class="panel-title">${a.icon} ${escapeHTML(a.name)} — Execução</div>
      <div class="form-group"><label class="form-label">Entrada</label><input class="form-input" id="agInput" placeholder="${getAgentPlaceholder(a.kind)}"></div>
      <p class="text-muted mb-12">Resultados temporários. O registro dos resultados destes agentes em investigações ainda não está disponível.</p>
      <button class="btn btn-primary" onclick="executeAgent()" ${agentesState.loading?'disabled':''}>${agentesState.loading?'<span class="spinner"></span> Executando...':'▶ Executar agente'}</button>
      <div id="agResult" class="mt-20">${agentesState.lastResult?renderAgentResult():''}</div>
    </div>
  `;
}

function getAgentPlaceholder(kind){
  return ({osint_web:'palavra-chave', network:'google.com ou 8.8.8.8', dns_recon:'dominio.com',
    shodan:'IP ou hostname', socmint_redes:'username ou nome', socmint_user:'username',
    dark_web:'username/email/keyword', finint_fiscal:'CPF ou CNPJ',
    finint_cripto:'wallet BTC', finint_coaf:'nome/CPF/CNPJ', meta_exif:'(use upload em Arquivos)',
    email_headers:'cole o header completo', meta_doc:'(use upload em Arquivos)',
    breach:'email ou username', geoint:'endereço/coordenadas/IP', maltego:'qualquer entidade'})[kind] || '';
}

async function executeAgent(){
  const a = AGENTES_IA.find(x=>x.id===agentesState.selected);
  const input = document.getElementById('agInput').value.trim();
  if (!input){ toast('Informe a entrada','error'); return; }
  agentesState.loading = true; renderSection('agentes');
  const t0 = performance.now();
  try {
    const result = await runAgent(a.kind, input);
    const elapsed = ((performance.now()-t0)/1000).toFixed(2);
    agentesState.lastResult = { agente:a, input, data:result, elapsed, at:Date.now(), ok:true };
    audit('agentes', a.kind, input, 'sucesso');
    toast('Resultado temporário: exibido nesta página e não registrado em investigação.', 'info');
  } catch(e){
    agentesState.lastResult = { agente:a, input, error:e.message, at:Date.now(), ok:false };
    audit('agentes', a.kind, input, 'erro');
    toast('Erro: '+e.message,'error');
  }
  agentesState.loading = false; renderSection('agentes');
}

// Roteamento de agentes — note como CADA agente é determinístico até onde possível
async function runAgent(kind, input){
  const j = async u => { const r=await fetch(u); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); };
  switch(kind){
    case 'osint_web': {
      // Determinístico: dorks + links manuais
      return {
        method:'deterministic',
        dorks:[
          `site:linkedin.com "${input}"`, `site:facebook.com "${input}"`,
          `site:jusbrasil.com.br "${input}"`, `site:escavador.com "${input}"`,
          `"${input}" filetype:pdf`, `"${input}" intext:"telefone" OR intext:"email"`
        ].map(q=>({query:q, google:`https://www.google.com/search?q=${encodeURIComponent(q)}`,
          ddg:`https://duckduckgo.com/?q=${encodeURIComponent(q)}`})),
        manual_sources: ['google.com.br','duckduckgo.com','bing.com','jusbrasil.com.br','escavador.com.br','consultapublica.cnj.jus.br']
      };
    }
    case 'network': return await dispatchOsintTool(/^\d+\.\d+\.\d+\.\d+$/.test(input)?'ip':'dns', input);
    case 'dns_recon': return await dispatchOsintTool('crt', input);
    case 'finint_fiscal': {
      const clean = input.replace(/\D/g,'');
      if (clean.length===11){
        // Determinístico: validação mod 11
        return { tipo:'CPF', input, normalizado:clean, valido:validaCPF(clean), nota:'Validação local mod 11. Para dados cadastrais oficiais, requer convênio Receita Federal.' };
      } else if (clean.length===14){
        return await j(`https://brasilapi.com.br/api/cnpj/v1/${clean}`);
      }
      throw new Error('Formato inválido (esperado CPF 11 ou CNPJ 14 dígitos)');
    }
    case 'finint_cripto': {
      // blockchain.info público
      return await j(`https://blockchain.info/rawaddr/${encodeURIComponent(input)}?limit=10`);
    }
    case 'finint_coaf': {
      // Stub determinístico: gera checklist de padrões a verificar
      return {
        method:'rule_based_stub',
        input,
        verificacoes_recomendadas:[
          'OFAC SDN List (consulta backend)','ONU Sanctions List','PEPs Portal Transparência',
          'CEIS/CNEP/CEPIM','Operações fracionadas (>R$ 10k)','Movimentação atípica vs perfil declarado'
        ],
        next_step:'Execute Transparência → CEIS/CNEP/CEPIM para esta entidade'
      };
    }
    case 'socmint_user': return await dispatchOsintTool('username', input);
    case 'socmint_redes': {
      return {
        method:'link_aggregation',
        target:input,
        perfis_a_verificar:[
          {rede:'LinkedIn', url:`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(input)}`},
          {rede:'Facebook', url:`https://www.facebook.com/search/top?q=${encodeURIComponent(input)}`},
          {rede:'Instagram', url:`https://www.instagram.com/${input.replace(/\s/g,'')}`},
          {rede:'Twitter/X', url:`https://twitter.com/search?q=${encodeURIComponent(input)}`},
          {rede:'YouTube', url:`https://www.youtube.com/results?search_query=${encodeURIComponent(input)}`},
          {rede:'TikTok', url:`https://www.tiktok.com/search?q=${encodeURIComponent(input)}`}
        ]
      };
    }
    case 'dark_web': return { method:'backend_required', message:'Monitoramento de dark web exige backend com Tor proxy + watchlist controlada. Stub.', input };
    case 'shodan': return { method:'requires_api_key', message:'Configure SHODAN_API_KEY no backend. Consulta /shodan/host/{ip}.', input };
    case 'meta_exif': return { method:'client_side', message:'Use o módulo Arquivos para upload com extração EXIF.', input };
    case 'email_headers': {
      // Parse determinístico de headers SMTP
      const lines = input.split('\n');
      const headers = {};
      let cur=null;
      lines.forEach(l=>{
        const m = l.match(/^([A-Za-z\-]+):\s*(.*)$/);
        if (m){ cur=m[1]; headers[cur]=m[2]; }
        else if (cur && l.startsWith(' ')){ headers[cur] += ' '+l.trim(); }
      });
      const received = lines.filter(l=>l.startsWith('Received:'));
      const ips = (input.match(/\b\d+\.\d+\.\d+\.\d+\b/g)||[]);
      return { method:'regex', headers, received_count:received.length, ips_encontrados:[...new Set(ips)] };
    }
    case 'meta_doc': return { method:'client_side', message:'Use o módulo Arquivos. PDF.js extrai metadados in-browser.', input };
    case 'breach': return { method:'requires_api_key', message:'Configure HIBP_API_KEY no backend. Endpoint /breachedaccount/{email}.', input };
    case 'geoint': {
      try { return await j(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(input)}&format=json&limit=3`); }
      catch(e){ throw new Error('Nominatim: '+e.message); }
    }
    case 'maltego': {
      // Grafo local: busca entidade no DB
      const matches = {
        clientes: DB.clients.filter(c=>c.name.toLowerCase().includes(input.toLowerCase())||c.document.includes(input)),
        processos: DB.processes.filter(p=>p.number.includes(input)),
        osint_entities: DB.osintEntities.filter(e=>e.displayName.toLowerCase().includes(input.toLowerCase())),
        evidencias_com_match: DB.evidence.filter(e=>(e.sourceName||'').toLowerCase().includes(input.toLowerCase()))
      };
      return { method:'graph_traversal_local_db', input, matches };
    }
    default: throw new Error('Agente sem implementação');
  }
}

function validaCPF(cpf){
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  let s=0;
  for(let i=0;i<9;i++) s+=parseInt(cpf[i])*(10-i);
  let d1 = 11-(s%11); if (d1>=10) d1=0;
  if (d1!==parseInt(cpf[9])) return false;
  s=0; for(let i=0;i<10;i++) s+=parseInt(cpf[i])*(11-i);
  let d2 = 11-(s%11); if (d2>=10) d2=0;
  return d2===parseInt(cpf[10]);
}

function renderAgentResult(){
  const r = agentesState.lastResult;
  if (!r.ok) return `<div class="alert alert-danger"><span>✕</span><span>${escapeHTML(r.error)}</span></div>`;
  setTimeout(()=>{ const wrap=document.getElementById('agRawWrap'); if(wrap){ const pre=document.createElement('pre'); pre.style.cssText='font-size:11px;white-space:pre-wrap;max-height:400px;overflow:auto;padding:12px;background:var(--obsidian);border-radius:6px'; pre.textContent=JSON.stringify(r.data,null,2); wrap.innerHTML=''; wrap.appendChild(pre); } },0);
  return `
    <div class="alert alert-success"><span>✓</span><span>Executado em ${r.elapsed}s • Stack: <strong>${r.agente.stack}</strong></span></div>
    <div id="agRawWrap"></div>
  `;
}
// ============================================================
//          RADAR SOCIETÁRIO ABDCRIM
//          Grafo relacional empresarial: pessoas → empresas → grupos
//          Princípio: nenhuma relação afirmada sem fonte objetiva
// ============================================================

const RADAR_VOCAB = {
  vinculo: {
    forte: {label:'Forte', color:'#3fb950', desc:'Mesmo sócio administrador ou matriz/filial'},
    medio: {label:'Médio', color:'#d4a574', desc:'Mesmo endereço + CNAE semelhante'},
    fraco: {label:'Fraco', color:'#d29922', desc:'Apenas telefone, e-mail ou proximidade'},
    indeterminado: {label:'Indeterminado', color:'#8b949e', desc:'Indício isolado'}
  },
  classificacao: {
    confirmado: {label:'CONFIRMADO', color:'#3fb950'},
    provavel:   {label:'PROVÁVEL', color:'#d4a574'},
    indiciario: {label:'INDICIÁRIO', color:'#8b949e'}
  }
};

const radarState = {result:null};

async function buildRadarFromCNPJ(data){
  const socios = (data.qsa||[]).map(s => ({
    nome: s.nome_socio,
    qualificacao: s.qualificacao_socio,
    cpf_cnpj_socio: s.cnpj_cpf_do_socio || '—',
    data_entrada: s.data_entrada_sociedade,
    pais_socio: s.pais_socio_estrangeiro || 'BR',
    faixa_etaria: s.faixa_etaria,
    vinculo: 'forte', // sócio = vínculo forte
    classificacao: 'confirmado'
  }));
  const indicios = [];
  if (data.ddd_telefone_1 && data.email){
    indicios.push({tipo:'contato', desc:`Empresa registrou tel ${data.ddd_telefone_1} e email ${data.email}`, classificacao:'confirmado'});
  }
  if (data.cnae_fiscal_secundarias && data.cnae_fiscal_secundarias.length){
    indicios.push({tipo:'cnae', desc:`${data.cnae_fiscal_secundarias.length} CNAE(s) secundário(s) — cruzar com empresas do mesmo ramo`, classificacao:'indiciario'});
  }
  return {
    tipo:'cnpj_resultado',
    cnpj: data.cnpj,
    empresa:{
      razao_social: data.razao_social, nome_fantasia: data.nome_fantasia,
      situacao: data.descricao_situacao_cadastral,
      data_abertura: data.data_inicio_atividade,
      natureza_juridica: data.natureza_juridica,
      porte: data.porte,
      capital_social: data.capital_social,
      cnae_principal: `${data.cnae_fiscal} — ${data.cnae_fiscal_descricao}`,
      cnaes_secundarios: (data.cnaes_secundarios||data.cnae_fiscal_secundarias||[]).slice(0,8),
      endereco: `${data.descricao_tipo_de_logradouro||''} ${data.logradouro||''}, ${data.numero||''} ${data.complemento||''} — ${data.bairro||''}, ${data.municipio||''}/${data.uf||''} CEP ${data.cep||''}`,
      telefone: data.ddd_telefone_1,
      email: data.email
    },
    socios,
    indicios,
    sugestoes_de_cruzamento:[
      {fonte:'Portal Transparência — CEIS', acao:'Verificar inidoneidade', url:'https://portaldatransparencia.gov.br/sancoes/ceis'},
      {fonte:'Casa dos Dados', acao:'Buscar empresas dos mesmos sócios', url:`https://casadosdados.com.br/pesquisa-empresa/${data.cnpj}`},
      {fonte:'Jusbrasil — Processos', acao:'Histórico processual', url:`https://www.jusbrasil.com.br/busca?q=${data.razao_social}`},
      {fonte:'INPI — Marcas', acao:'Marcas registradas', url:`https://busca.inpi.gov.br/pePI/`},
      {fonte:'Receita Federal — Comprovante', acao:'Validação oficial', url:'https://solucoes.receita.fazenda.gov.br/servicos/cnpjreva/cnpjreva_solicitacao.asp'}
    ],
    grafo_local: buildLocalSocietaryGraph(data, socios)
  };
}

function buildLocalSocietaryGraph(empresa, socios){
  // Grafo simples: empresa central + sócios
  const nodes = [{id:'emp', type:'empresa', label:empresa.razao_social||empresa.cnpj, color:'#d4a574'}];
  const edges = [];
  socios.forEach((s,i) => {
    const sid = 'soc-'+i;
    nodes.push({id:sid, type:'pessoa', label:s.nome, color:'#79c0ff'});
    edges.push({from:sid, to:'emp', type:s.qualificacao, vinculo:s.vinculo});
  });
  return {nodes, edges};
}

function renderRadarResult(){
  const r = radarState.result;
  if (r.erro) return `<div class="alert alert-danger"><span>✕</span><span>${escapeHTML(r.erro)}</span></div>`;
  if (r.tipo !== 'cnpj_resultado'){
    return `<div class="panel">
      <div class="alert alert-info"><span>ℹ️</span><span>${escapeHTML(r.nota||'')}</span></div>
      ${r.sugestoes?`<h4>Fontes sugeridas para investigação</h4><ul style="font-size:13px;line-height:1.8">${r.sugestoes.map(s=>`<li>${escapeHTML(s.fonte)} — <a href="${escapeHTML(s.url)}" target="_blank" rel="noopener" style="color:var(--teal-accent)">abrir ↗</a></li>`).join('')}</ul>`:''}
      ${r.geocoding?`<h4 class="mt-20">Geocoding</h4><pre style="font-size:11px;padding:10px;background:var(--obsidian);border-radius:6px">${escapeHTML(JSON.stringify(r.geocoding,null,2))}</pre>`:''}
    </div>`;
  }
  const e = r.empresa;
  return `
    <div class="panel mb-20">
      <div class="panel-title">${escapeHTML(e.razao_social)} <span class="status-chip ${e.situacao==='ATIVA'?'active':'critical'}">${escapeHTML(e.situacao)}</span></div>
      <div class="form-row">
        <div>
          <div class="detail-row"><span class="detail-label">Nome fantasia:</span><span class="detail-value">${escapeHTML(e.nome_fantasia||'—')}</span></div>
          <div class="detail-row"><span class="detail-label">CNPJ:</span><span class="detail-value masked">${escapeHTML(maskDoc(r.cnpj))}</span></div>
          <div class="detail-row"><span class="detail-label">Data abertura:</span><span class="detail-value">${escapeHTML(e.data_abertura||'—')}</span></div>
          <div class="detail-row"><span class="detail-label">Porte:</span><span class="detail-value">${escapeHTML(e.porte||'—')}</span></div>
          <div class="detail-row"><span class="detail-label">Capital social:</span><span class="detail-value">${fmtMoney(e.capital_social||0)}</span></div>
        </div>
        <div>
          <div class="detail-row"><span class="detail-label">Natureza:</span><span class="detail-value">${escapeHTML(e.natureza_juridica||'—')}</span></div>
          <div class="detail-row"><span class="detail-label">CNAE principal:</span><span class="detail-value" style="max-width:60%">${escapeHTML(e.cnae_principal||'—')}</span></div>
          <div class="detail-row"><span class="detail-label">Telefone:</span><span class="detail-value">${escapeHTML(e.telefone||'—')}</span></div>
          <div class="detail-row"><span class="detail-label">Email:</span><span class="detail-value">${escapeHTML(e.email||'—')}</span></div>
        </div>
      </div>
      <div style="margin-top:12px;padding:10px;background:var(--obsidian);border-radius:6px;font-size:12px">
        <strong>Endereço:</strong> ${escapeHTML(e.endereco)}
      </div>
    </div>

    <div class="grid-2x2">
      <div class="panel">
        <div class="panel-title">👥 Quadro Societário (QSA) — ${r.socios.length}</div>
        ${r.socios.length?r.socios.map(s=>`<div style="padding:10px;background:var(--obsidian);border-radius:6px;margin-bottom:6px;border-left:3px solid ${RADAR_VOCAB.vinculo[s.vinculo].color}">
          <div style="font-weight:600">${escapeHTML(s.nome)} <span class="badge badge-primary" style="margin-left:6px">${RADAR_VOCAB.classificacao[s.classificacao].label}</span></div>
          <div class="text-muted" style="font-size:11px">${escapeHTML(s.qualificacao)} • desde ${escapeHTML(s.data_entrada||'—')}</div>
          ${s.cpf_cnpj_socio!=='—'?`<div style="font-family:'JetBrains Mono';font-size:10px;color:var(--gold-accent);margin-top:4px">${escapeHTML(maskDoc(s.cpf_cnpj_socio))}</div>`:''}
        </div>`).join(''):'<div class="text-muted">Sem sócios listados na BrasilAPI</div>'}
      </div>

      <div class="panel">
        <div class="panel-title">⚠️ Indícios e Sinalizações</div>
        ${r.indicios.length?r.indicios.map(i=>`<div style="padding:10px;background:var(--obsidian);border-radius:6px;margin-bottom:6px;border-left:3px solid ${RADAR_VOCAB.classificacao[i.classificacao].color}">
          <span class="badge badge-warning">${escapeHTML(i.tipo)}</span> <span class="badge badge-primary" style="margin-left:4px">${RADAR_VOCAB.classificacao[i.classificacao].label}</span>
          <div class="mt-12" style="font-size:12px">${escapeHTML(i.desc)}</div>
        </div>`).join(''):'<div class="text-muted">Nenhum indício automático</div>'}
        ${(e.cnaes_secundarios||[]).length?`<h4 class="mt-20">CNAEs secundários</h4>${(e.cnaes_secundarios||[]).map(c=>`<div style="padding:6px;background:var(--obsidian);border-radius:4px;margin-bottom:3px;font-size:11px"><code>${escapeHTML(c.codigo||c)}</code> ${escapeHTML(c.descricao||'')}</div>`).join('')}`:''}
      </div>
    </div>

    <div class="panel mt-20">
      <div class="panel-title">🕸️ Grafo Local</div>
      ${renderRadarGraph(r.grafo_local)}
    </div>

    <div class="panel mt-20">
      <div class="panel-title">🔗 Próximos passos (cruzamento externo)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px">
        ${r.sugestoes_de_cruzamento.map(s=>`<a href="${escapeHTML(s.url)}" target="_blank" rel="noopener" style="display:block;padding:12px;background:var(--obsidian);border-radius:6px;text-decoration:none;color:var(--text-primary);border-left:3px solid var(--teal-accent)">
          <div style="font-weight:600;font-size:13px">${escapeHTML(s.fonte)} ↗</div>
          <div class="text-muted" style="font-size:11px;margin-top:4px">${escapeHTML(s.acao)}</div>
        </a>`).join('')}
      </div>
    </div>

    <div class="filter-bar mt-20">
      <button class="btn btn-primary" onclick="radarParaInvestigacao()">🕵️ Preparar cadastro de investigação</button>
      <p>Abre o cadastro com o nome da empresa e o escopo sugerido para sua revisão.</p>
    </div>
  `;
}

function renderRadarGraph(g){
  const W=720, H=380, cx=W/2, cy=H/2, r=Math.min(W,H)/2.8;
  const pos = {};
  const periph = g.nodes.filter(n=>n.id!=='emp');
  periph.forEach((n,i)=>{ const a=(i/periph.length)*Math.PI*2 - Math.PI/2; pos[n.id]={x:cx+Math.cos(a)*r, y:cy+Math.sin(a)*r}; });
  pos.emp = {x:cx, y:cy};
  const edges = g.edges.map(e=>{ const a=pos[e.from], b=pos[e.to]; return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${RADAR_VOCAB.vinculo[e.vinculo].color}" stroke-width="2"><title>${escapeHTML(e.type)} (${RADAR_VOCAB.vinculo[e.vinculo].label})</title></line>`; }).join('');
  const nodes = g.nodes.map(n=>{ const p=pos[n.id]; const isMain=n.id==='emp'; return `<g transform="translate(${p.x},${p.y})">
    <circle r="${isMain?30:20}" fill="${n.color}22" stroke="${n.color}" stroke-width="${isMain?3:2}"/>
    <text text-anchor="middle" dy="4" fill="#e6edf3" font-size="${isMain?12:10}" font-weight="700">${escapeHTML((n.label||'').slice(0,18))}</text>
    <title>${escapeHTML(n.label)}</title>
  </g>`; }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Mapa dos sócios e da empresa consultada" style="background:var(--obsidian);border-radius:6px;width:100%;height:auto;max-width:${W}px">${edges}${nodes}</svg>`;
}

function radarParaInvestigacao(){
  const r = radarState.result;
  if (!r || r.tipo!=='cnpj_resultado'){ toast('Sem resultado para converter','warning'); return; }
  // Pré-popula wizard etapa 1
  osintState.wizard = { step:1, data:{
    title: `Due diligence ${r.empresa.razao_social}`,
    category: 'compliance',
    scope: ['empresarial','integridade_publica'],
    status: 'rascunho'
  }};
  renderWizardStep();
}
// ============================================================
//          TRANSPARÊNCIA PÚBLICA
//          Portal da Transparência Federal — requer token backend
// ============================================================

const TRANSP_ENDPOINTS = [
  {id:'servidores', icon:'👤', name:'Servidores Federais', desc:'Servidores do Executivo Federal por CPF', token:true, path:'servidores'},
  {id:'ceis', icon:'🚫', name:'CEIS — Empresas Inidôneas', desc:'Cadastro Nacional de Empresas Inidôneas e Suspensas', token:true, path:'ceis'},
  {id:'cnep', icon:'⚠️', name:'CNEP — Empresas Punidas', desc:'Cadastro Nacional de Empresas Punidas', token:true, path:'cnep'},
  {id:'cepim', icon:'🏢', name:'CEPIM — Entidades Impedidas', desc:'Entidades Privadas Sem Fins Lucrativos Impedidas', token:true, path:'cepim'},
  {id:'contratos', icon:'📄', name:'Contratos Federais', desc:'Contratos do Poder Executivo Federal', token:true, path:'contratos'},
  {id:'licitacoes', icon:'📋', name:'Licitações', desc:'Licitações do Executivo Federal', token:true, path:'licitacoes'},
  {id:'bolsa_familia', icon:'💰', name:'Bolsa Família', desc:'Beneficiários por município', token:true, path:'novo-bolsa-familia-disponivel-por-municipio'},
  {id:'bpc', icon:'👴', name:'BPC', desc:'Benefício de Prestação Continuada', token:true, path:'bpc'},
  {id:'despesas', icon:'💳', name:'Despesas', desc:'Documentos de despesas do Executivo', token:true, path:'despesas/por-orgao'},
  {id:'emendas', icon:'🏛️', name:'Emendas Parlamentares', desc:'Emendas e documentos relacionados', token:true, path:'emendas'},
  {id:'viagens', icon:'✈️', name:'Viagens a Serviço', desc:'Viagens de servidores por CPF/período', token:true, path:'viagens'},
  {id:'peps', icon:'⭐', name:'PEPs — Pessoas Expostas', desc:'Pessoas Politicamente Expostas', token:true, path:'peps'}
];

const transpState = { selected:null, result:null, loading:false };

SECTION_RENDERERS.transparencia = () => `
  <h1 class="page-title">🏛️ Transparência Pública</h1>
  <p class="page-subtitle">12 endpoints do Portal da Transparência Federal — requer token gov.br no backend.</p>
  <div class="alert alert-warning"><span>🔑</span><span><strong>Token necessário:</strong> em produção, o backend mantém o <code>chave-api-dados</code>. Aqui exibimos os endpoints e instruções; chamadas reais via proxy seguro.</span></div>
  <div class="panel mb-20">
    <div class="panel-title">Endpoints disponíveis</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px">
      ${TRANSP_ENDPOINTS.map(e=>`<div onclick="selectTransp('${e.id}')" style="padding:14px;background:var(--obsidian);border-radius:8px;cursor:pointer;border:2px solid ${transpState.selected===e.id?'var(--teal-accent)':'var(--border-color)'}">
        <div style="font-size:24px;margin-bottom:6px">${e.icon}</div>
        <div style="font-weight:700;font-size:13px;margin-bottom:4px">${escapeHTML(e.name)}</div>
        <div class="text-muted" style="font-size:11px">${escapeHTML(e.desc)}</div>
        <div style="font-family:'JetBrains Mono';font-size:10px;color:var(--gold-accent);margin-top:6px">api/${e.path}</div>
      </div>`).join('')}
    </div>
  </div>
  ${transpState.selected ? renderTranspPanel() : ''}
`;
SECTION_AFTER.transparencia = () => {};

function selectTransp(id){ transpState.selected=id; transpState.result=null; renderSection('transparencia'); }

function renderTranspPanel(){
  const e = TRANSP_ENDPOINTS.find(x=>x.id===transpState.selected);
  return `
    <div class="panel">
      <div class="panel-title">${e.icon} ${escapeHTML(e.name)}</div>
      <div class="alert alert-info"><span>ℹ️</span><span>Endpoint: <code>https://api.portaldatransparencia.gov.br/api-de-dados/${e.path}</code></span></div>
      <div class="form-group"><label class="form-label">Parâmetros (formato chave=valor por linha)</label>
        <textarea class="form-textarea" id="trParams" style="min-height:100px" placeholder="codigoIbge=3550308&pagina=1&mesAno=202601"></textarea>
      </div>
<p class="text-muted">Credenciais são configuradas pelo administrador no backend.</p>
      <button class="btn btn-primary" onclick="consultarTransp()">Ver disponibilidade</button>
      <div id="trResult" class="mt-20"></div>
    </div>
  `;
}

async function consultarTransp(){
  document.getElementById('trResult').textContent = 'Consultas deste catálogo ainda não estão conectadas nesta tela. Nenhuma consulta foi executada. Utilize os conectores disponíveis na investigação.';
}
// ============================================================
//          API EXPLORER — Catálogo navegável de 73+ APIs
// ============================================================

const API_CATALOG = [
  // Governo BR
  {cat:'Governo BR', name:'BrasilAPI — CNPJ', url:'https://brasilapi.com.br/api/cnpj/v1/{cnpj}', auth:'Sem auth', cors:true},
  {cat:'Governo BR', name:'BrasilAPI — CEP', url:'https://brasilapi.com.br/api/cep/v2/{cep}', auth:'Sem auth', cors:true},
  {cat:'Governo BR', name:'BrasilAPI — Bancos', url:'https://brasilapi.com.br/api/banks/v1', auth:'Sem auth', cors:true},
  {cat:'Governo BR', name:'BrasilAPI — Feriados', url:'https://brasilapi.com.br/api/feriados/v1/{ano}', auth:'Sem auth', cors:true},
  {cat:'Governo BR', name:'BrasilAPI — DDD', url:'https://brasilapi.com.br/api/ddd/v1/{ddd}', auth:'Sem auth', cors:true},
  {cat:'Governo BR', name:'BrasilAPI — FIPE', url:'https://brasilapi.com.br/api/fipe/marcas/v1/carros', auth:'Sem auth', cors:true},
  {cat:'Governo BR', name:'ReceitaWS — CNPJ', url:'https://www.receitaws.com.br/v1/cnpj/{cnpj}', auth:'Sem auth', cors:true},
  {cat:'Governo BR', name:'IBGE — Localidades', url:'https://servicodados.ibge.gov.br/api/v1/localidades', auth:'Sem auth', cors:true},
  {cat:'Governo BR', name:'IBGE — Notícias', url:'https://servicodados.ibge.gov.br/api/v3/noticias', auth:'Sem auth', cors:true},
  {cat:'Governo BR', name:'Câmara Deputados', url:'https://dadosabertos.camara.leg.br/api/v2', auth:'Sem auth', cors:true},
  {cat:'Governo BR', name:'Senado Federal', url:'https://legis.senado.leg.br/dadosabertos', auth:'Sem auth', cors:true},
  {cat:'Governo BR', name:'Portal Transparência', url:'https://api.portaldatransparencia.gov.br/api-de-dados', auth:'API Key', cors:true},
  // OSINT
  {cat:'OSINT', name:'DNS Google', url:'https://dns.google/resolve?name={domain}', auth:'Sem auth', cors:true},
  {cat:'OSINT', name:'crt.sh', url:'https://crt.sh/?q={domain}&output=json', auth:'Sem auth', cors:true},
  {cat:'OSINT', name:'Wayback Machine', url:'https://archive.org/wayback/available?url={url}', auth:'Sem auth', cors:true},
  {cat:'OSINT', name:'IP-API', url:'https://ip-api.com/json/{ip}', auth:'Sem auth', cors:true},
  {cat:'OSINT', name:'GitHub Users', url:'https://api.github.com/users/{username}', auth:'Sem auth', cors:true},
  {cat:'OSINT', name:'URLhaus', url:'https://urlhaus-api.abuse.ch/v1/url/', auth:'Sem auth', cors:true},
  {cat:'OSINT', name:'AbuseIPDB', url:'https://api.abuseipdb.com/api/v2/check', auth:'API Key', cors:true},
  {cat:'OSINT', name:'Cloudflare Trace', url:'https://www.cloudflare.com/cdn-cgi/trace', auth:'Sem auth', cors:true},
  {cat:'OSINT', name:'Have I Been Pwned', url:'https://haveibeenpwned.com/api/v3', auth:'API Key', cors:true},
  // Finanças
  {cat:'Finanças', name:'AwesomeAPI — Cotações', url:'https://economia.awesomeapi.com.br/json/last/USD-BRL,EUR-BRL,BTC-BRL', auth:'Sem auth', cors:true},
  {cat:'Finanças', name:'Frankfurter', url:'https://api.frankfurter.app/latest', auth:'Sem auth', cors:true},
  {cat:'Finanças', name:'CoinGecko', url:'https://api.coingecko.com/api/v3/simple/price', auth:'Sem auth', cors:true},
  {cat:'Finanças', name:'CoinCap', url:'https://api.coincap.io/v2/assets', auth:'Sem auth', cors:true},
  {cat:'Finanças', name:'Mempool BTC', url:'https://mempool.space/api/v1/fees/recommended', auth:'Sem auth', cors:true},
  // Geocoding
  {cat:'Geocoding', name:'Nominatim', url:'https://nominatim.openstreetmap.org/search?q={q}&format=json', auth:'Sem auth', cors:true},
  {cat:'Geocoding', name:'REST Countries', url:'https://restcountries.com/v3.1/all', auth:'Sem auth', cors:true},
  {cat:'Geocoding', name:'Country.is', url:'https://api.country.is/{ip}', auth:'Sem auth', cors:true},
  {cat:'Geocoding', name:'GeoJS', url:'https://get.geojs.io/v1/ip/geo.json', auth:'Sem auth', cors:true},
  {cat:'Geocoding', name:'BigDataCloud', url:'https://api.bigdatacloud.net/data/reverse-geocode-client', auth:'Sem auth', cors:true},
  // Email
  {cat:'Email', name:'Disify', url:'https://www.disify.com/api/email/{email}', auth:'Sem auth', cors:true},
  {cat:'Email', name:'EVA Validation', url:'https://api.eva.pingutil.com/email?email={email}', auth:'Sem auth', cors:true},
  // Clima
  {cat:'Clima', name:'Open-Meteo', url:'https://api.open-meteo.com/v1/forecast', auth:'Sem auth', cors:true},
  {cat:'Clima', name:'WTTR.in', url:'https://wttr.in/{city}?format=j1', auth:'Sem auth', cors:true},
  // Dev
  {cat:'Dev', name:'GitHub Repos', url:'https://api.github.com/repos/{owner}/{repo}', auth:'Sem auth', cors:true},
  {cat:'Dev', name:'GitHub Search', url:'https://api.github.com/search/repositories?q={q}', auth:'Sem auth', cors:true},
  {cat:'Dev', name:'NPM Registry', url:'https://registry.npmjs.org/{package}', auth:'Sem auth', cors:true},
  {cat:'Dev', name:'jsDelivr', url:'https://data.jsdelivr.com/v1/package/npm/{pkg}', auth:'Sem auth', cors:true},
  // Anti-Malware
  {cat:'Anti-Malware', name:'URLhaus Recent', url:'https://urlhaus-api.abuse.ch/v1/urls/recent/', auth:'Sem auth', cors:true},
  {cat:'Anti-Malware', name:'PhishTank', url:'http://data.phishtank.com/data/online-valid.json', auth:'Sem auth', cors:false},
  // Notícias
  {cat:'Notícias', name:'Hacker News', url:'https://hacker-news.firebaseio.com/v0/topstories.json', auth:'Sem auth', cors:true},
  {cat:'Notícias', name:'Spaceflight News', url:'https://api.spaceflightnewsapi.net/v4/articles', auth:'Sem auth', cors:true},
  // IA
  {cat:'IA', name:'Anthropic Claude', url:'https://api.anthropic.com/v1/messages', auth:'API Key', cors:false},
  {cat:'IA', name:'OpenAI GPT', url:'https://api.openai.com/v1/chat/completions', auth:'API Key', cors:false},
  // Referência
  {cat:'Referência', name:'Wikipedia', url:'https://en.wikipedia.org/api/rest_v1/page/summary/{title}', auth:'Sem auth', cors:true},
  {cat:'Referência', name:'Free Dictionary', url:'https://api.dictionaryapi.dev/api/v2/entries/en/{word}', auth:'Sem auth', cors:true},
  {cat:'Referência', name:'DuckDuckGo Instant', url:'https://api.duckduckgo.com/?q={q}&format=json', auth:'Sem auth', cors:true},
  {cat:'Referência', name:'Open Library', url:'https://openlibrary.org/search.json?q={q}', auth:'Sem auth', cors:true}
];

const apiState = { catFilter:'todas', search:'' };

SECTION_RENDERERS.apiexplorer = () => {
  const cats = ['todas', ...new Set(API_CATALOG.map(a=>a.cat))];
  const list = API_CATALOG.filter(a => {
    if (apiState.catFilter!=='todas' && a.cat!==apiState.catFilter) return false;
    if (apiState.search){ const q=apiState.search.toLowerCase(); if (!a.name.toLowerCase().includes(q) && !a.url.toLowerCase().includes(q)) return false; }
    return true;
  });
  return `
    <h1 class="page-title">🌐 API Explorer</h1>
    <p class="page-subtitle">Catálogo navegável de ${API_CATALOG.length} Referências de APIs públicas. Filtragem por categoria, autenticação e CORS.</p>
    <div class="panel">
      <div class="filter-bar">
        <input class="form-input grow" id="apiSearch" placeholder="Buscar API..." value="${escapeHTML(apiState.search)}">
        <div class="pill-group">${cats.map(c=>`<div class="pill ${apiState.catFilter===c?'active':''}" onclick="apiState.catFilter='${c}';renderSection('apiexplorer')">${c}</div>`).join('')}</div>
      </div>
      <table style="font-size:12px"><thead><tr><th>API</th><th>Categoria</th><th>Endpoint</th><th>Auth</th><th>CORS</th><th></th></tr></thead><tbody>
        ${list.map(a=>`<tr>
          <td><strong>${escapeHTML(a.name)}</strong></td>
          <td><span class="badge badge-primary">${escapeHTML(a.cat)}</span></td>
          <td style="font-family:'JetBrains Mono';font-size:10px;max-width:300px;overflow:hidden;text-overflow:ellipsis">${escapeHTML(a.url)}</td>
          <td>${a.auth==='Sem auth'?'<span class="status-chip active">Sem auth</span>':'<span class="status-chip pending">'+escapeHTML(a.auth)+'</span>'}</td>
          <td>${a.cors?'<span class="status-chip active">✓</span>':'<span class="status-chip critical">✕</span>'}</td>
          <td><button class="btn btn-small btn-secondary" onclick="navigator.clipboard.writeText('${a.url}');toast('URL copiada','success')">📋</button></td>
        </tr>`).join('')}
      </tbody></table>
      <div class="text-muted mt-12" style="font-size:11px">Mostrando ${list.length} de ${API_CATALOG.length} APIs</div>
    </div>
  `;
};
SECTION_AFTER.apiexplorer = () => {
  document.getElementById('apiSearch').addEventListener('input', e=>{ apiState.search=e.target.value; renderSection('apiexplorer'); document.getElementById('apiSearch').focus(); });
};
// ============================================================
//          ISO & LEGISLAÇÃO — Base normativa do framework TACER
// ============================================================

const ISO_REFS = [
  {cat:'Forense Digital', code:'ISO/IEC 27037:2012', desc:'Identificação, coleta, aquisição e preservação de evidência digital'},
  {cat:'Forense Digital', code:'ISO/IEC 27038:2014', desc:'Redação digital'},
  {cat:'Forense Digital', code:'ISO/IEC 27039:2015', desc:'Sistemas de detecção e prevenção de intrusão (IDPS)'},
  {cat:'Forense Digital', code:'ISO/IEC 27040:2024', desc:'Segurança de armazenamento'},
  {cat:'Forense Digital', code:'ISO/IEC 27041:2015', desc:'Adequação de métodos de investigação'},
  {cat:'Forense Digital', code:'ISO/IEC 27042:2015', desc:'Análise e interpretação de evidências'},
  {cat:'Forense Digital', code:'ISO/IEC 27043:2015', desc:'Princípios e processos de investigação de incidentes'},
  {cat:'Forense Digital', code:'ISO/IEC 27050-1 a -4', desc:'Descoberta eletrônica (eDiscovery)'},
  {cat:'Ciências Forenses', code:'ISO 21043-1', desc:'Termos e vocabulário'},
  {cat:'Ciências Forenses', code:'ISO 21043-2', desc:'Reconhecimento, coleta, transporte, armazenamento'},
  {cat:'Ciências Forenses', code:'ISO 21043-3', desc:'Análise'},
  {cat:'Ciências Forenses', code:'ISO 21043-4', desc:'Interpretação'},
  {cat:'Ciências Forenses', code:'ISO 21043-5', desc:'Relatórios'},
  {cat:'Cadeia de Custódia', code:'ISO 22095-2', desc:'Balanço de massa'},
  {cat:'Cadeia de Custódia', code:'ISO 22095-3', desc:'Reserva e reclamação'},
  {cat:'Cadeia de Custódia', code:'ISO/IEC 11179-1', desc:'Registros de metadados (MDR)'},
  {cat:'SGSI Núcleo', code:'ISO/IEC 27000:2018', desc:'Vocabulário SGSI'},
  {cat:'SGSI Núcleo', code:'ISO/IEC 27001:2022', desc:'Requisitos do SGSI + Emenda 2024'},
  {cat:'SGSI Núcleo', code:'ISO/IEC 27002:2022', desc:'93 controles (4 temas: organizacional, pessoas, físico, tecnológico)'},
  {cat:'SGSI Núcleo', code:'ISO/IEC 27003', desc:'Implementação do SGSI'},
  {cat:'SGSI Núcleo', code:'ISO/IEC 27004:2016', desc:'Monitoramento, medição e métricas (GQM)'},
  {cat:'SGSI Núcleo', code:'ISO/IEC 27005:2022', desc:'Gestão de riscos de segurança da informação'},
  {cat:'SGSI Núcleo', code:'ISO/IEC 27006-1:2024', desc:'Requisitos para auditoria e certificação'},
  {cat:'SGSI Núcleo', code:'ISO/IEC 27007', desc:'Diretrizes para auditoria de SGSI'},
  {cat:'Setoriais', code:'ISO/IEC 27011:2024', desc:'Telecomunicações'},
  {cat:'Setoriais', code:'ISO/IEC 27017', desc:'Segurança em serviços de nuvem'},
  {cat:'Setoriais', code:'ISO/IEC 27018:2025', desc:'Proteção de PII em nuvem pública'},
  {cat:'Setoriais', code:'ISO/IEC 27019:2024', desc:'Setor de energia elétrica'},
  {cat:'Setoriais', code:'ISO 27799:2025', desc:'Saúde'},
  {cat:'Cibersegurança', code:'ISO/IEC 27031:2025', desc:'Continuidade de TIC'},
  {cat:'Cibersegurança', code:'ISO/IEC 27032:2023', desc:'Cibersegurança da Internet'},
  {cat:'Cibersegurança', code:'ISO/IEC 27033-1 a -7', desc:'Segurança de redes'},
  {cat:'Cibersegurança', code:'ISO/IEC 27034-1 a -7', desc:'Segurança de aplicações'},
  {cat:'Cibersegurança', code:'ISO/IEC 27035-1 a -4', desc:'Gestão de incidentes'},
  {cat:'Cibersegurança', code:'ISO/IEC 27036-1 a -4', desc:'Segurança em relacionamentos com fornecedores'},
  {cat:'Privacidade', code:'ISO/IEC 27701:2025', desc:'PIMS — Sistema de Gestão de Privacidade da Informação'},
  {cat:'Privacidade', code:'ISO/IEC 27706:2025', desc:'Certificação PIMS'},
  {cat:'Privacidade', code:'ISO/IEC TR 27550', desc:'Engenharia de privacidade'},
  {cat:'Privacidade', code:'ISO/IEC 29100', desc:'Estrutura de privacidade'},
  {cat:'Privacidade', code:'ISO/IEC 20889', desc:'Desidentificação'},
  {cat:'Gestão de Risco', code:'ISO 31000:2018', desc:'Princípios e diretrizes (norma-mãe)'},
  {cat:'Gestão de Risco', code:'IEC 31010', desc:'Técnicas de avaliação (FMEA, HAZOP, Bayes, Monte Carlo)'},
  {cat:'Gestão de Risco', code:'ISO 31022', desc:'Riscos jurídicos'},
  {cat:'Gestão de Risco', code:'ISO 31030', desc:'Riscos em viagens'},
  {cat:'Gestão de Risco', code:'ISO 31073', desc:'Vocabulário'},
  {cat:'Governança', code:'ISO 37001', desc:'Sistema de gestão antissuborno'},
  {cat:'Governança', code:'ISO 37002', desc:'Sistema de gestão de denúncias (whistleblowing)'},
  {cat:'Governança', code:'ISO 37003', desc:'Gestão de riscos de fraude'},
  {cat:'Governança', code:'ISO 45003', desc:'Gestão de riscos psicossociais'},
  {cat:'Resiliência', code:'ISO 22300', desc:'Vocabulário'},
  {cat:'Resiliência', code:'ISO 22320', desc:'Gestão de emergências'},
  {cat:'Resiliência', code:'ISO 22341', desc:'CPTED — Prevenção do crime pelo ambiente'},
  {cat:'Resiliência', code:'ISO 22361', desc:'Gestão de crises'},
  {cat:'Resiliência', code:'ISO 22378', desc:'Autenticidade de produtos'},
  {cat:'Resiliência', code:'ISO 22388', desc:'Autenticidade de documentos'},
  {cat:'Resiliência', code:'ISO 28000', desc:'Gestão de segurança'},
  {cat:'Investigação', code:'ISO 18788', desc:'Operações de segurança privada'},
  {cat:'Investigação', code:'IWA 49', desc:'Diretrizes para investigações'},
  {cat:'Investigação', code:'ISO 16678', desc:'Autenticação e rastreabilidade'},
  {cat:'Engenharia', code:'ISO/IEC 21827', desc:'SSE-CMM — Maturidade em engenharia de segurança'},
  {cat:'Engenharia', code:'ISO/IEC 15408-1/-2/-3', desc:'Common Criteria'},
  {cat:'Engenharia', code:'ISO/IEC 18045', desc:'Metodologia de avaliação CC'},
  {cat:'Engenharia', code:'ISO/IEC 19790', desc:'Módulos criptográficos (FIPS 140 equivalente)'},
  {cat:'Engenharia', code:'ISO/IEC 24759', desc:'Teste de módulos criptográficos'},
  {cat:'Identidade', code:'ISO/IEC 24760-1', desc:'Gestão de identidades'},
  {cat:'Identidade', code:'ISO/IEC TS 23220-2', desc:'Identidade móvel'},
  {cat:'Identidade', code:'ISO/IEC 29794-5', desc:'Qualidade biométrica facial'},
  {cat:'Identidade', code:'ISO/IEC TS 18013-6', desc:'mDL — Carteira de motorista digital'},
  {cat:'Capital Humano', code:'ISO 30414', desc:'Diretrizes de gestão de capital humano'},
  {cat:'Big Data/IoT', code:'ISO/IEC 27045', desc:'Big Data — segurança'},
  {cat:'Big Data/IoT', code:'ISO/IEC 27400/27402', desc:'IoT — privacidade e segurança'},
  {cat:'Big Data/IoT', code:'ISO/IEC 27090/27091', desc:'IA — segurança e privacidade (rascunhos)'},
  {cat:'Big Data/IoT', code:'ISO/IEC TS 27110:2021', desc:'Quadro de cibersegurança'}
];

const LEIS_BR = [
  {area:'Processo Penal', code:'CPP Arts. 158-A a 158-F', desc:'Cadeia de custódia — Lei 13.964/2019 (Pacote Anticrime)'},
  {area:'Processo Penal', code:'CPP Arts. 155-184', desc:'Provas em geral'},
  {area:'Processo Penal', code:'Lei 13.964/2019', desc:'Pacote Anticrime — modifica CP, CPP e LEP'},
  {area:'Internet', code:'Lei 12.965/2014', desc:'Marco Civil da Internet'},
  {area:'Internet', code:'Decreto 8.771/2016', desc:'Regulamenta MCI — guarda de registros'},
  {area:'Privacidade', code:'Lei 13.709/2018', desc:'LGPD — Lei Geral de Proteção de Dados'},
  {area:'Privacidade', code:'Decreto 11.483/2023', desc:'ANPD — Estrutura regimental'},
  {area:'Constitucional', code:'CF/88 Art. 5°, XII', desc:'Inviolabilidade de comunicações'},
  {area:'Constitucional', code:'CF/88 Art. 5°, LVI', desc:'Inadmissibilidade de prova ilícita'},
  {area:'CNJ', code:'Resolução CNJ 396/2021', desc:'Estratégia Nacional de Segurança Cibernética do Poder Judiciário'},
  {area:'CNJ', code:'Resolução CNJ 335/2020', desc:'PJe e tramitação eletrônica'},
  {area:'Penal', code:'Código Penal', desc:'Decreto-Lei 2.848/1940 + alterações'},
  {area:'Penal', code:'Lei 8.069/1990', desc:'ECA — Estatuto da Criança e do Adolescente'},
  {area:'Penal', code:'Lei 10.741/2003', desc:'Estatuto do Idoso'},
  {area:'Penal', code:'Lei 11.340/2006', desc:'Lei Maria da Penha'},
  {area:'Penal', code:'Lei 11.343/2006', desc:'Lei de Drogas'},
  {area:'Penal', code:'Lei 10.826/2003', desc:'Estatuto do Desarmamento'},
  {area:'Anticorrupção', code:'Lei 12.846/2013', desc:'Lei Anticorrupção (responsabilidade administrativa de PJ)'},
  {area:'Anticorrupção', code:'Lei 8.429/1992', desc:'Improbidade Administrativa (+ reforma 14.230/2021)'},
  {area:'Sigilo', code:'LC 105/2001', desc:'Sigilo bancário'},
  {area:'Convenções', code:'Convenção de Budapeste', desc:'Cibercrime — Decreto 11.491/2023'},
  {area:'Convenções', code:'Convenção de Palermo', desc:'Crime organizado transnacional'},
  {area:'Convenções', code:'Convenção de Mérida', desc:'Anticorrupção (UNCAC)'}
];

const conhState = { tab:'iso', search:'', catFilter:'todas' };

SECTION_RENDERERS.conhecimento = () => {
  const isISO = conhState.tab==='iso';
  const data = isISO ? ISO_REFS : LEIS_BR;
  const catKey = isISO ? 'cat' : 'area';
  const cats = ['todas', ...new Set(data.map(d=>d[catKey]))];
  const filtered = data.filter(d=>{
    if (conhState.catFilter!=='todas' && d[catKey]!==conhState.catFilter) return false;
    if (conhState.search){ const q=conhState.search.toLowerCase(); if (!d.code.toLowerCase().includes(q) && !d.desc.toLowerCase().includes(q)) return false; }
    return true;
  });
  return `
    <h1 class="page-title">📚 Base Normativa</h1>
    <p class="page-subtitle">${ISO_REFS.length} normas ISO/IEC catalogadas + ${LEIS_BR.length} instrumentos legislativos brasileiros. Base do framework TACER.</p>
    <div class="panel">
      <div class="tabs">
        <button class="tab ${conhState.tab==='iso'?'active':''}" onclick="conhState.tab='iso';conhState.catFilter='todas';renderSection('conhecimento')">📘 Normas ISO/IEC (${ISO_REFS.length})</button>
        <button class="tab ${conhState.tab==='leis'?'active':''}" onclick="conhState.tab='leis';conhState.catFilter='todas';renderSection('conhecimento')">⚖️ Legislação BR (${LEIS_BR.length})</button>
      </div>
      <div class="filter-bar">
        <input class="form-input grow" id="conhSearch" placeholder="Buscar código ou descrição..." value="${escapeHTML(conhState.search)}">
        <div class="pill-group">${cats.map(c=>`<div class="pill ${conhState.catFilter===c?'active':''}" onclick="conhState.catFilter='${c}';renderSection('conhecimento')">${c}</div>`).join('')}</div>
      </div>
      <table style="font-size:12px"><thead><tr><th>${isISO?'Categoria':'Área'}</th><th>Código</th><th>Descrição</th></tr></thead><tbody>
        ${filtered.map(d=>`<tr>
          <td><span class="badge badge-primary">${escapeHTML(d[catKey])}</span></td>
          <td style="font-family:'JetBrains Mono';font-weight:700">${escapeHTML(d.code)}</td>
          <td>${escapeHTML(d.desc)}</td>
        </tr>`).join('')}
      </tbody></table>
      <div class="text-muted mt-12" style="font-size:11px">${filtered.length} de ${data.length}</div>
    </div>
    <p class="text-muted mt-20">Referências para consulta profissional. Confira a edição, a vigência e a aplicabilidade na fonte oficial antes de utilizar. O catálogo não certifica conformidade do sistema nem substitui o texto integral.</p>
  `;
};
SECTION_AFTER.conhecimento = () => {
  document.getElementById('conhSearch').addEventListener('input', e=>{ conhState.search=e.target.value; renderSection('conhecimento'); document.getElementById('conhSearch').focus(); });
};
// ============================================================
//          TACER + ACH — extensão do workspace de investigação
//          Adiciona aba TACER e aba ACH ao workspace existente
// ============================================================

const TACER_PHASES = [
  {id:'target', icon:'🎯', name:'TARGET', desc:'Definição do Alvo', iso:'ISO/IEC 27037 §5 | ISO 21043-1',
   checklist:['Objetivo investigativo definido','Amparo legal identificado','Alvos principais e secundários listados','ToR (Terms of Reference) assinado','Prazos e limites estabelecidos']},
  {id:'acquire', icon:'📡', name:'ACQUIRE', desc:'Aquisição de Dados', iso:'ISO/IEC 27037 §8-9 | ISO 21043-2',
   checklist:['Fontes OSINT identificadas','Agentes OSINT executados com custódia','Dados voláteis adquiridos prioritariamente','SHA-256 calculado para cada evidência','Escala NATO Admiralty atribuída']},
  {id:'correlate', icon:'🕸️', name:'CORRELATE', desc:'Correlação de Entidades', iso:'ISO/IEC 27042:2015 | ISO 21043-3',
   checklist:['Grafo de entidades atualizado','Correlações temporais mapeadas','Conexões ocultas investigadas','Clusters identificados','Análise de padrões documentada']},
  {id:'evaluate', icon:'🧠', name:'EVALUATE', desc:'Análise Estruturada', iso:'ISO/IEC 27042 §7 | ISO/IEC 27005',
   checklist:['Hipóteses ACH formuladas','Evidências avaliadas na matriz ACH',"Devil's Advocacy aplicada",'Key Assumptions verificadas','Score NATO atribuído a cada hipótese']},
  {id:'report', icon:'📄', name:'REPORT', desc:'Relatório TACER', iso:'ISO 21043-5 | CPP Art. 158-A/F',
   checklist:['Relatório PDF gerado','Cadeia de custódia exportada','Timeline cronológica incluída','Conclusão técnica redigida','Normas e legislação citadas']}
];

const NATO_ADMIRALTY = {
  source:{ A:'Confiável',B:'Geralmente confiável',C:'Razoavelmente confiável',D:'Geralmente não confiável',E:'Não confiável',F:'Não pode ser julgado'},
  info:  {'1':'Confirmada','2':'Provavelmente verdadeira','3':'Possivelmente verdadeira','4':'Duvidosa','5':'Improvável','6':'Não pode ser julgada'}
};

WORKSPACE_RENDERERS.plano = inv => {
  const runs = DB.osintRuns.filter(run=>run.investigationId===inv.id);
  return `<h3>Roteiro de investigação</h3><p>Referência para revisar as etapas do trabalho. As coletas registradas aparecem abaixo.</p>
    ${TACER_PHASES.map(phase=>`<details class="panel mb-12"><summary>${escapeHTML(phase.name)} — ${escapeHTML(phase.desc)}</summary><ul>${phase.checklist.map(item=>`<li>${escapeHTML(item)}</li>`).join('')}</ul></details>`).join('')}
    <h3 class="mt-20">Coletas registradas</h3>${runs.length ? `<table><thead><tr><th>Fonte</th><th>Situação</th><th>Resumo</th></tr></thead><tbody>${runs.map(run=>`<tr><td>${escapeHTML(DB.sourceCatalog.find(item=>item.id===run.connectorId)?.name || 'Fonte consultada')}</td><td>${escapeHTML(({ok:'Concluída',erro:'Falhou',em_execucao:'Em andamento'})[run.status] || run.status)}</td><td>${escapeHTML(run.resultSummary || '')}</td></tr>`).join('')}</tbody></table>` : '<p>Nenhuma coleta registrada.</p>'}`;
};



const CLIENT_TAB_STATE = { tab:'visao' };
const PROCESS_TAB_STATE = { tab:'visao' };

function ensureClientExtended(c){
  c.biography      = c.biography      || '';
  c.profession     = c.profession     || '';
  c.nationality    = c.nationality    || '';
  c.maritalStatus  = c.maritalStatus  || '';
  c.birthDate      = c.birthDate      || '';
  c.politicalHistory= c.politicalHistory|| [];   // [{ano,cargo,partido,situacao,fonte}]
  c.publicOffices  = c.publicOffices  || [];     // [{cargo,orgao,periodo,fonte}]
  c.assets         = c.assets         || [];     // [{tipo,descricao,valor,ano,fonte}]
  c.companies      = c.companies      || [];     // [{cnpj,nome,qualificacao,status}]
  c.newsMentions   = c.newsMentions   || [];     // [{titulo,url,fonte,data,snippet}]
  c.documents      = c.documents      || [];     // [{kind,fileId,addedAt}]  -- fileId vincula à coleção files
  c.publicLinksAuto= true;
  return c;
}

function clientPublicLinks(c){
  const q = encodeURIComponent(c.name);
  const doc = (c.document||'').replace(/\D/g,'');
  const isPJ = c.type==='PJ';
  const base = [
    {label:'Google', url:`https://www.google.com/search?q=${q}`},
    {label:'Google News', url:`https://news.google.com/search?q=${q}`},
    {label:'Jusbrasil', url:`https://www.jusbrasil.com.br/busca?q=${q}`},
    {label:'Escavador', url:`https://www.escavador.com/sobre/pesquisar?q=${q}`},
    {label:'JusBR — CNJ', url:`https://www.cnj.jus.br/jus-br-cnj/`}
  ];
  if (isPJ){
    base.push(
      {label:'Casa dos Dados (CNPJ)', url:`https://casadosdados.com.br/pesquisa-empresa/${doc||q}`},
      {label:'Receita Federal', url:'https://solucoes.receita.fazenda.gov.br/servicos/cnpjreva/cnpjreva_solicitacao.asp'},
      {label:'Portal Transparência — CEIS', url:`https://portaldatransparencia.gov.br/sancoes/ceis?paginacaoSimples=true&direcaoOrdenacao=asc&nome=${q}`},
      {label:'INPI — Marcas', url:`https://busca.inpi.gov.br/pePI/`}
    );
  } else {
    base.push(
      {label:'TSE — Candidatos', url:`https://divulgacandcontas.tse.jus.br/divulga/#/candidato/${doc||''}`},
      {label:'Portal Transparência — Servidores', url:`https://portaldatransparencia.gov.br/servidores?paginacaoSimples=true&palavraChave=${q}`},
      {label:'Portal Transparência — PEPs', url:`https://portaldatransparencia.gov.br/pessoa-politicamente-exposta?paginacaoSimples=true&nome=${q}`},
      {label:'OAB — Cadastro Nacional', url:`https://cna.oab.org.br/`},
      {label:'LinkedIn', url:`https://www.linkedin.com/search/results/people/?keywords=${q}`}
    );
  }
  return base;
}

function clientStat(c){
  const procs = DB.processes.filter(p=>p.clientId===c.id);
  const fin   = DB.financial.filter(f=>f.clientId===c.id);
  const ints  = DB.intimations.filter(i=>{const p=dbGet('processes',i.processId); return p&&p.clientId===c.id;});
  return {
    procs, fin, ints,
    procAtivos: procs.filter(p=>p.status!=='arquivado').length,
    recebido: fin.filter(f=>f.type==='receita'&&f.status==='recebido').reduce((s,f)=>s+f.amount,0),
    aReceber: fin.filter(f=>f.status==='previsto').reduce((s,f)=>s+f.amount,0),
    vencido: fin.filter(f=>f.status==='vencido').reduce((s,f)=>s+f.amount,0)
  };
}

// =================== PERFIL 360° ===================
function showClientDetail360(id){
  const client = dbGet('clients', id);
  if (!client) { toast('Cliente não encontrado.', 'warning'); return; }
  ensureClientExtended(client);
  CLIENT_TAB_STATE.tab = 'visao';
  CLIENT_TAB_STATE.id = id;
  renderClient360();
}
function switchClientTab(t){ if(!confirmModalLeave()) return; CLIENT_TAB_STATE.tab = t; renderClient360(); }

function renderClient360(){
  const c = dbGet('clients', CLIENT_TAB_STATE.id);
  if (!c) return;
  ensureClientExtended(c);
  const tabs = [
    {id:'visao',     label:'👤 Visão Geral'},
    {id:'perfil', label:'📖 Perfil complementar'},
    {id:'processos', label:'📋 Processos'},
    {id:'documentos',label:'📂 Documentos'},
    {id:'links',     label:'🔗 Links Públicos'},
    {id:'osint',     label:'🕵️ OSINT'}
  ];
  const available = {};
  const visibleTabs = tabs.filter(tab => available[tab.id] !== false);
  if (!visibleTabs.some(tab=>tab.id===CLIENT_TAB_STATE.tab)) CLIENT_TAB_STATE.tab='visao';
  const tabsHTML = `<div class="tabs">${visibleTabs.map(t=>`<button class="tab ${CLIENT_TAB_STATE.tab===t.id?'active':''}" onclick="switchClientTab('${t.id}')">${t.label}</button>`).join('')}</div>`;
  const body = tabsHTML + (CLIENT_TAB_RENDER[CLIENT_TAB_STATE.tab]||(()=>''))(c);
  const titleBadge = `<span class="badge ${c.type==='PJ'?'badge-warning':'badge-primary'}" style="margin-left:8px">${c.type==='PJ'?'PJ':'PF'}</span>`;
  openModal({ wide:true, title:`${escapeHTML(c.name)} ${titleBadge}`, body,
    footer:`<button class="btn btn-secondary" onclick="closeModal()">Fechar</button>${canEditLegalRecords()?`<button class="btn btn-primary" onclick="closeModal();openClientForm('${c.id}')">Editar dados básicos</button>`:''}`,
    onMount(){
      if(CLIENT_TAB_STATE.tab==='perfil') {
        const panel=document.getElementById('clientProfilePanel');
        window.SemperClientProfile.mount({clientId:c.id,canEdit:canEditLegalRecords(),request:backendApi}).then(controller=>{if(panel.isConnected) panel._profileController=controller;});
      }
      if(CLIENT_TAB_STATE.tab==='documentos') window.SemperfiLegalDocuments.mount({targetKind:'client',targetId:c.id,canEdit:canEditLegalRecords(),request:backendApi,onFiles(){closeModal();navigateSection('metadata');}});
    }
  });
}

const CLIENT_TAB_RENDER = {};
CLIENT_TAB_RENDER.perfil = () => window.SemperClientProfile.render();

CLIENT_TAB_RENDER.visao = (c) => {
  const s = clientStat(c);
  return `
    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">
      <div class="kpi-card"><div class="kpi-label">Processos ativos</div><div class="kpi-value" style="font-size:22px">${s.procAtivos}</div></div>
      <div class="kpi-card"><div class="kpi-label">Recebido</div><div class="kpi-value" style="font-size:18px;color:var(--success)">${fmtMoney(s.recebido)}</div></div>
      <div class="kpi-card"><div class="kpi-label">A receber</div><div class="kpi-value" style="font-size:18px;color:var(--teal-accent)">${fmtMoney(s.aReceber)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Vencido</div><div class="kpi-value" style="font-size:18px;color:${s.vencido?'var(--danger)':'var(--success)'}">${fmtMoney(s.vencido)}</div></div>
    </div>
    <div class="form-row">
      <div>
        <div class="detail-row"><span class="detail-label">Documento:</span><span class="detail-value masked">${escapeHTML(maskDoc(c.document))}</span></div>
        <div class="detail-row"><span class="detail-label">E-mail:</span><span class="detail-value">${escapeHTML(c.email||'—')}</span></div>
        <div class="detail-row"><span class="detail-label">Telefone:</span><span class="detail-value">${escapeHTML(c.phone||'—')}</span></div>
        <div class="detail-row"><span class="detail-label">Profissão:</span><span class="detail-value">${escapeHTML(c.profession||'—')}</span></div>
      </div>
      <div>
        <div class="detail-row"><span class="detail-label">Responsável:</span><span class="detail-value">${escapeHTML(c.responsible||'—')}</span></div>
        <div class="detail-row"><span class="detail-label">Status:</span><span class="detail-value">${escapeHTML(c.status||'—')}</span></div>
        <div class="detail-row"><span class="detail-label">Nascimento:</span><span class="detail-value">${escapeHTML(c.birthDate||'—')}</span></div>
        <div class="detail-row"><span class="detail-label">Cadastrado:</span><span class="detail-value">${fmtDate(toISO(new Date(c.createdAt)))}</span></div>
      </div>
    </div>
    ${c.address?`<div style="margin-top:12px;padding:10px;background:var(--obsidian);border-radius:6px"><strong>Endereço:</strong> ${escapeHTML(c.address)}</div>`:''}
    ${c.notes?`<div style="margin-top:8px;padding:10px;background:var(--obsidian);border-radius:6px"><strong>Notas:</strong> ${escapeHTML(c.notes)}</div>`:''}
    <div class="alert alert-info mt-20"><span>💡</span><span>Registre biografia, histórico, bens, empresas e fontes no Perfil complementar. Consulte os processos e vincule arquivos na aba Documentos.</span></div>
  `;
};

function clientReadOnlyTable(title, headings, rows){
  if (!rows.length) return '';
  return `<section class="mt-20"><h3>${escapeHTML(title)}</h3><table><thead><tr>${headings.map(label=>`<th>${escapeHTML(label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(value=>`<td>${escapeHTML(value ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></section>`;
}
CLIENT_TAB_RENDER.biografia = c => `<h3>Biografia registrada</h3><p style="white-space:pre-wrap">${escapeHTML(c.biography || '')}</p>`;
CLIENT_TAB_RENDER.politico = c => clientReadOnlyTable('Candidaturas registradas',['Ano','Cargo','Partido','Situação','Fonte'],c.politicalHistory.map(row=>[row.ano,row.cargo,row.partido,row.situacao,row.fonte])) + clientReadOnlyTable('Cargos públicos registrados',['Cargo','Órgão','Período','Fonte'],c.publicOffices.map(row=>[row.cargo,row.orgao,row.periodo,row.fonte]));
CLIENT_TAB_RENDER.bens = c => clientReadOnlyTable('Bens declarados',['Tipo','Descrição','Valor','Ano','Fonte'],c.assets.map(row=>[row.tipo,row.descricao,fmtMoney(row.valor),row.ano,row.fonte]));
CLIENT_TAB_RENDER.empresas = c => clientReadOnlyTable('Empresas vinculadas',['CNPJ','Nome','Qualificação','Situação'],c.companies.map(row=>[maskDoc(row.cnpj||''),row.nome,row.qualificacao,row.status]));

CLIENT_TAB_RENDER.processos = (c) => {
  const procs = DB.processes.filter(p=>p.clientId===c.id);
  return procs.length?`<h3 style="margin-bottom:10px">📋 Processos (${procs.length})</h3>
    <table><thead><tr><th>Número</th><th>Tribunal</th><th>Área</th><th>Fase</th><th>Valor</th><th></th></tr></thead><tbody>
    ${procs.map(p=>`<tr><td style="font-family:'JetBrains Mono';font-size:12px">${escapeHTML(p.number)}</td><td>${escapeHTML(p.court||'')}</td><td>${escapeHTML(p.area||'')}</td><td>${escapeHTML(p.phase||'')}</td><td>${fmtMoney(p.value||0)}</td><td><button class="btn btn-small btn-secondary" onclick="closeModal();setTimeout(()=>showProcessDetail('${p.id}'),100)">Abrir</button></td></tr>`).join('')}
    </tbody></table>`:'<div class="text-muted">Nenhum processo</div>';
};

CLIENT_TAB_RENDER.documentos = () => window.SemperfiLegalDocuments.render();
CLIENT_TAB_RENDER.noticias = c => clientReadOnlyTable('Notícias registradas',['Título','Fonte','Data','Resumo'],c.newsMentions.map(row=>[row.titulo,row.fonte,row.data,row.snippet]));

CLIENT_TAB_RENDER.links = (c) => {
  const links = clientPublicLinks(c);
  return `<h3 style="margin-bottom:10px">🔗 Links de Fontes Públicas</h3>
    <div class="alert alert-info" style="font-size:12px"><span>ℹ️</span><span>Links determinísticos pré-gerados a partir do nome/documento. Nenhuma chamada de IA — abertura em nova aba.</span></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-top:12px">
      ${links.map(l=>`<a href="${escapeHTML(l.url)}" target="_blank" rel="noopener" style="display:block;padding:12px;background:var(--obsidian);border-radius:6px;text-decoration:none;color:var(--text-primary);border-left:3px solid var(--teal-accent)">
        <div style="font-weight:600;font-size:13px">${escapeHTML(l.label)} ↗</div>
        <div class="text-muted" style="font-size:10px;margin-top:4px;word-break:break-all">${escapeHTML(l.url)}</div>
      </a>`).join('')}
    </div>`;
};

CLIENT_TAB_RENDER.osint = (c) => `
  <h3 style="margin-bottom:10px">🕵️ Investigação OSINT do cliente</h3>
  <div class="filter-bar">
    <button class="btn btn-primary" onclick="closeModal();setTimeout(()=>{osintState.wizard={step:1,data:{title:'Investigação — ${escapeHTML(c.name).replace(/'/g,'')}',clientId:'${c.id}',scope:[],status:'rascunho'}};renderWizardStep();},150)">+ Nova investigação OSINT</button>
    <button class="btn btn-secondary" onclick="closeModal();setTimeout(()=>navigateSection('osinttools'),150)">⚒️ Abrir OSINT Tools</button>
    <button class="btn btn-secondary" onclick="closeModal();setTimeout(()=>navigateSection('agentes'),150)">🤖 Abrir Agentes IA</button>
  </div>
  ${(() => {
    const invs = DB.investigations.filter(i=>i.clientId===c.id);
    return invs.length?`<table style="font-size:12px;margin-top:12px"><thead><tr><th>Investigação</th><th>Categoria</th><th>Status</th><th></th></tr></thead><tbody>
      ${invs.map(i=>`<tr><td><strong>${escapeHTML(i.title)}</strong></td><td>${escapeHTML(OSINT_VOCAB.category[i.category]||i.category)}</td><td>${statusChip(i.status)}</td><td><button class="btn btn-small btn-secondary" onclick="closeModal();setTimeout(()=>{navigateSection('osint');setTimeout(()=>openInvestigationWorkspace('${i.id}'),100);},150)">Abrir</button></td></tr>`).join('')}
    </tbody></table>`:'<div class="text-muted mt-12">Nenhuma investigação OSINT criada para este cliente.</div>';
  })()}
`;

// Complementary profile records are consulted only when supplied by the server.
function openClientInvestigation(id){
  const client = dbGet('clients', id);
  if (!client) return;
  closeModal();
  osintState.wizard = {step:1,data:{title:`Investigação — ${client.name}`,clientId:id,scope:[],status:'rascunho'}};
  renderWizardStep();
}

// =================== PROCESSO COMPLETO ===================
function showProcessDetailFull(id){
  PROCESS_TAB_STATE.id = id;
  PROCESS_TAB_STATE.tab = 'visao';
  renderProcessFull();
}
function switchProcessTab(t){ PROCESS_TAB_STATE.tab = t; renderProcessFull(); }

function renderProcessFull(){
  const p = dbGet('processes', PROCESS_TAB_STATE.id);
  const cli = dbGet('clients', p.clientId);
  const tabs = [
    {id:'visao',     label:'📋 Visão Geral'},
    {id:'andamentos',label:'📜 Andamentos'},
    {id:'prazos',    label:'⏰ Prazos'},
    {id:'intimacoes',label:'📧 Intimações'},
    {id:'arquivos',  label:'📂 Arquivos'},
    {id:'financeiro',label:'💰 Financeiro'}
  ];
  const tabsHTML = `<div class="tabs">${tabs.map(t=>`<button class="tab ${PROCESS_TAB_STATE.tab===t.id?'active':''}" onclick="switchProcessTab('${t.id}')">${t.label}</button>`).join('')}</div>`;
  const body = tabsHTML + (PROCESS_TAB_RENDER[PROCESS_TAB_STATE.tab]||(()=>''))(p, cli);
  openModal({ wide:true, title:`Processo ${escapeHTML(p.number)}`, body,
    footer:`<button class="btn btn-secondary" onclick="closeModal()">Fechar</button>${canEditLegalRecords()?`<button class="btn btn-primary" onclick="closeModal();openProcessForm('${p.id}')">Editar</button>`:''}`,
    onMount(){
      if(PROCESS_TAB_STATE.tab==='arquivos') window.SemperfiLegalDocuments.mount({targetKind:'process',targetId:p.id,canEdit:canEditLegalRecords(),request:backendApi,onCount(count){p.documentCount=count;},onFiles(){closeModal();navigateSection('metadata');}});
    }
  });
}

const PROCESS_TAB_RENDER = {};
PROCESS_TAB_RENDER.visao = (p, cli) => `
  <div class="form-row">
    <div>
      <div class="detail-row"><span class="detail-label">Cliente:</span><span class="detail-value">${escapeHTML(cli?.name||'—')}</span></div>
      <div class="detail-row"><span class="detail-label">Tribunal:</span><span class="detail-value">${escapeHTML(p.court||'—')}</span></div>
      <div class="detail-row"><span class="detail-label">Área:</span><span class="detail-value">${escapeHTML(p.area||'—')}</span></div>
    </div>
    <div>
      <div class="detail-row"><span class="detail-label">Fase:</span><span class="detail-value">${escapeHTML(p.phase||'—')}</span></div>
      <div class="detail-row"><span class="detail-label">Responsável:</span><span class="detail-value">${escapeHTML(p.responsible||'—')}</span></div>
      <div class="detail-row"><span class="detail-label">Valor:</span><span class="detail-value">${fmtMoney(p.value||0)}</span></div>
    </div>
  </div>
  ${p.notes?`<div style="margin-top:12px;padding:10px;background:var(--obsidian);border-radius:6px"><strong>Notas:</strong> ${escapeHTML(p.notes)}</div>`:''}
  <div class="kpi-grid mt-20" style="grid-template-columns:repeat(4,1fr)">
    <div class="kpi-card"><div class="kpi-label">Andamentos</div><div class="kpi-value" style="font-size:22px">${DB.processMovements.filter(m=>m.processId===p.id).length}</div></div>
    <div class="kpi-card"><div class="kpi-label">Prazos pendentes</div><div class="kpi-value" style="font-size:22px">${DB.deadlines.filter(d=>d.processId===p.id&&d.status==='pendente').length}</div></div>
    <div class="kpi-card"><div class="kpi-label">Intimações</div><div class="kpi-value" style="font-size:22px">${DB.intimations.filter(i=>i.processId===p.id).length}</div></div>
    <div class="kpi-card"><div class="kpi-label">Arquivos vinculados</div><div class="kpi-value" style="font-size:22px">${p.documentCount ?? '—'}</div><small>Consulte a aba Arquivos</small></div>
  </div>
`;

const MOV_TYPES = [
  {id:'peticao_inicial', label:'Petição Inicial'},
  {id:'despacho', label:'Despacho'},
  {id:'decisao', label:'Decisão'},
  {id:'sentenca', label:'Sentença'},
  {id:'audiencia', label:'Audiência'},
  {id:'intimacao', label:'Intimação'},
  {id:'manifestacao', label:'Manifestação'},
  {id:'recurso', label:'Recurso'},
  {id:'contestacao', label:'Contestação'},
  {id:'juntada', label:'Juntada de documento'},
  {id:'transito', label:'Trânsito em julgado'},
  {id:'arquivamento', label:'Arquivamento'},
  {id:'observacao', label:'Observação interna'}
];

PROCESS_TAB_RENDER.andamentos = (p) => {
  const movs = DB.processMovements.filter(m=>m.processId===p.id).sort((a,b)=>b.date.localeCompare(a.date));
  return `
    <div class="filter-bar">
      <button class="btn btn-primary" onclick="openMovementForm('${p.id}')">+ Novo andamento</button>
      <button class="btn btn-secondary" onclick="exportMovementsCSV('${p.id}')">📤 Exportar CSV</button>
      <span class="text-muted" style="font-size:12px">${movs.length} registro(s)</span>
    </div>
    ${movs.length?`<div class="timeline mt-20">
      ${movs.map(m=>{
        const sourceBadge = m.source==='diario_oficial'?'<span class="badge badge-warning">📰 Diário Oficial</span>':
          m.source==='manual'?'<span class="badge badge-primary">✋ Manual</span>':
          '<span class="badge">⚙️ Automático</span>';
        const typeLabel = MOV_TYPES.find(t=>t.id===m.type)?.label || m.type;
        return `<div class="timeline-item">
          <div class="timeline-date">${fmtDate(m.date)} • ${escapeHTML(m.authorId||'—')} ${sourceBadge}</div>
          <div class="timeline-content">
            <strong>${escapeHTML(typeLabel)}</strong>
            <div style="margin-top:6px;font-size:13px">${escapeHTML(m.description)}</div>
            ${m.intimationId?`<div class="text-muted" style="font-size:11px;margin-top:4px">↳ vinculado à intimação <code>${escapeHTML(m.intimationId)}</code></div>`:''}
            ${(m.attachments||[]).length?`<div class="text-muted" style="font-size:11px;margin-top:4px">📎 ${m.attachments.length} anexo(s)</div>`:''}
            <div class="row-actions mt-12">
              <button class="btn btn-small btn-secondary" onclick="openMovementForm('${p.id}','${m.id}')">Editar</button>
              <button class="btn btn-small btn-danger" onclick="deleteMovement('${m.id}')">×</button>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`:'<div class="empty-state" style="padding:32px"><div class="empty-state-icon">📜</div><div class="empty-state-title">Nenhum andamento registrado</div><div class="empty-state-text">Adicione manualmente ou aguarde lançamento automático pelo Diário Oficial.</div></div>'}
  `;
};

PROCESS_TAB_RENDER.prazos = (p) => {
  const deads = DB.deadlines.filter(d=>d.processId===p.id);
  return deads.length?`<table><thead><tr><th>Título</th><th>Data</th><th>Status</th><th>Responsável</th></tr></thead><tbody>
    ${deads.map(d=>`<tr><td>${escapeHTML(d.title)}</td><td>${fmtDate(d.date)}</td><td>${escapeHTML(d.status)}</td><td>${escapeHTML(d.responsible||'—')}</td></tr>`).join('')}
  </tbody></table>`:'<div class="text-muted">Nenhum prazo cadastrado.</div>';
};

PROCESS_TAB_RENDER.intimacoes = (p) => {
  const ints = DB.intimations.filter(i=>i.processId===p.id);
  return `<div class="filter-bar">
    <button class="btn btn-secondary btn-small" onclick="closeModal();setTimeout(()=>navigateSection('intimations'),150)">📰 Abrir Diário Oficial</button>
  </div>
  ${ints.length?ints.map(i=>{
    const movLinked = DB.processMovements.find(m=>m.intimationId===i.id);
    return `<div style="padding:12px;background:var(--obsidian);border-radius:6px;margin-bottom:8px;border-left:3px solid ${movLinked?'var(--success)':'var(--warning)'}">
      <div style="display:flex;justify-content:space-between"><strong>${escapeHTML(i.source)} — ${escapeHTML(i.type)}</strong>${movLinked?'<span class="badge badge-primary">✓ Lançada no andamento</span>':'<button class="btn btn-small btn-primary" onclick="lancarIntimacaoNoAndamento(\''+i.id+'\')">⚡ Lançar</button>'}</div>
      <div class="text-muted" style="font-size:11px;margin-top:4px">${fmtDateTime(i.receivedAt)}</div>
      <div style="font-size:13px;margin-top:6px">${escapeHTML(i.content)}</div>
    </div>`;
  }).join(''):'<div class="text-muted mt-12">Nenhuma intimação para este processo.</div>'}`;
};

PROCESS_TAB_RENDER.arquivos = () => window.SemperfiLegalDocuments.render();

PROCESS_TAB_RENDER.financeiro = (p) => {
  const fin = DB.financial.filter(f=>f.processId===p.id);
  return fin.length?`<table><thead><tr><th>Data</th><th>Descrição</th><th>Valor</th><th>Status</th></tr></thead><tbody>${fin.map(f=>`<tr><td>${fmtDate(f.date)}</td><td>${escapeHTML(f.description)}</td><td style="color:${f.type==='receita'?'var(--success)':'var(--danger)'}">${fmtMoney(f.amount)}</td><td>${escapeHTML(f.status)}</td></tr>`).join('')}</tbody></table>`:'<div class="text-muted">Nenhum lançamento</div>';
};

// --------- Andamentos: CRUD ---------
function openMovementForm(processId, id){
  const m = id ? DB.processMovements.find(x=>x.id===id) : {processId, date:toISO(new Date()), type:'despacho', source:'manual', authorId:SETTINGS.userName||'', description:'', attachments:[]};
  openModal({title: id?'Editar andamento':'Novo andamento', body:`
    <div class="form-row">
      <div class="form-group"><label class="form-label">Data *</label><input class="form-input" id="mvDate" type="date" value="${escapeHTML(m.date)}"></div>
      <div class="form-group"><label class="form-label">Tipo *</label><select class="form-select" id="mvType">${MOV_TYPES.map(t=>`<option value="${t.id}" ${m.type===t.id?'selected':''}>${escapeHTML(t.label)}</option>`).join('')}</select></div>
    </div>
    <div class="form-group"><label class="form-label">Descrição *</label><textarea class="form-textarea" id="mvDesc" style="min-height:100px">${escapeHTML(m.description)}</textarea></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Autor registrado</label><input class="form-input" id="mvAuthor" readonly value="${escapeHTML(m.authorId||SETTINGS.userName||'')}"><p class="text-muted">A autoria é registrada pelo servidor a partir da sessão.</p></div>
      <div class="form-group"><label class="form-label">Fonte</label><select class="form-select" id="mvSource"><option value="manual" ${m.source==='manual'?'selected':''}>Manual</option><option value="diario_oficial" ${m.source==='diario_oficial'?'selected':''}>Diário Oficial</option><option value="automatico" ${m.source==='automatico'?'selected':''}>Automático</option></select></div>
    </div>
  `, footer:`<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>${id?`<button class="btn btn-danger" onclick="deleteMovement('${id}');closeModal()">Excluir</button>`:''}<button class="btn btn-primary" onclick="saveMovement('${processId}','${id||''}')">Salvar</button>`});
}
async function saveMovement(processId, id){
  const data = {
    processId,
    date: document.getElementById('mvDate').value,
    type: document.getElementById('mvType').value,
    description: document.getElementById('mvDesc').value.trim(),
    authorId: document.getElementById('mvAuthor').value.trim(),
    source: document.getElementById('mvSource').value
  };
  if (!data.date || !data.description){ toast('Data e descrição são obrigatórias','error'); return; }
  try {
    if (isBackendMode()){
      const saved = await persistMovement(processId, data, id);
      if (id){
        const i = DB.processMovements.findIndex(x=>x.id===id);
        if (i>=0){ DB.processMovements[i] = {...DB.processMovements[i], ...saved, updatedAt:Date.now()}; }
      } else {
        DB.processMovements.push(saved);
      }
    } else if (id){
      const i = DB.processMovements.findIndex(x=>x.id===id);
      if (i>=0){ DB.processMovements[i] = {...DB.processMovements[i], ...data, updatedAt:Date.now()}; }
    } else {
      DB.processMovements.push({...data, id:uid('mov'), attachments:[], createdAt:Date.now()});
    }
  } catch(err){
    toast(apiErrorMessage(err),'error');
    return;
  }
  saveDB();
  audit('processes', id?'edicao_andamento':'criacao_andamento', processId);
  toast('Andamento salvo','success');
  closeModal(); renderProcessFull();
}
async function deleteMovement(id){
  if (!confirm('Excluir andamento?')) return;
  const m = DB.processMovements.find(x=>x.id===id);
  const i = DB.processMovements.findIndex(x=>x.id===id);
  if (isBackendMode()){
    try { await backendApi(`/process-movements/${id}`, { method:'DELETE' }); }
    catch(err){ toast(apiErrorMessage(err),'error'); return; }
  }
  if (i>=0){ DB.processMovements.splice(i,1); saveDB(); audit('processes','exclusao_andamento',m?.processId||'—'); toast('Excluído','success'); renderProcessFull(); }
}
function exportMovementsCSV(processId){
  const movs = DB.processMovements.filter(m=>m.processId===processId);
  if (!movs.length){ toast('Sem andamentos','warning'); return; }
  const csv = '\uFEFF' + ['data,tipo,fonte,autor,descricao', ...movs.map(m=>[m.date, m.type, m.source, m.authorId, m.description].map(csvCell).join(','))].join('\r\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `andamentos_${processId}_${toISO(new Date())}.csv`; a.click(); URL.revokeObjectURL(a.href);
  toast('CSV baixado','success');
}

// =================== DIÁRIO OFICIAL → ANDAMENTO ===================
// Parser heurístico de prazo da intimação
function parsePrazoFromIntimacao(content){
  const m = content.match(/(\d+)\s*dias?\s*(úteis|uteis|corridos)?/i);
  if (!m) return null;
  return { dias: parseInt(m[1]), modo: /uteis|úteis/i.test(m[2]||'') ? 'uteis' : 'corridos' };
}

function lancarIntimacaoNoAndamento(intimationId){
  const item = dbGet('intimations', intimationId);
  if (!item?.processId || item.status === 'concluida') { toast('Associe uma intimação aberta a um processo antes de lançar.', 'warning'); return; }
  openModal({title:'Lançar intimação no processo', body:`
    <p>Revise os dados. O andamento e os registros opcionais serão salvos juntos, e a intimação será concluída.</p>
    <div class="form-group"><label for="launchDate" class="form-label">Data do andamento *</label><input id="launchDate" class="form-input" type="date" value="${toISO(new Date())}" required></div>
    <div class="form-group"><label for="launchDescription" class="form-label">Descrição do andamento *</label><textarea id="launchDescription" class="form-textarea" required minlength="3">${escapeHTML(item.content)}</textarea></div>
    <fieldset><legend><label><input id="launchDeadline" type="checkbox"> Criar prazo</label></legend>
      <p>Informe a data confirmada pelo responsável. A contagem processual não é presumida a partir do texto.</p>
      <div id="launchDeadlineFields" hidden><label for="launchDeadlineTitle" class="form-label">Título *</label><input id="launchDeadlineTitle" class="form-input" maxlength="255" value="Providência da intimação">
      <label for="launchDeadlineDate" class="form-label">Vencimento confirmado *</label><input id="launchDeadlineDate" class="form-input" type="date"></div>
    </fieldset>
    <fieldset><legend><label><input id="launchAppointment" type="checkbox"> Criar compromisso</label></legend>
      <div id="launchAppointmentFields" hidden><label for="launchAppointmentTitle" class="form-label">Título *</label><input id="launchAppointmentTitle" class="form-input" maxlength="255" value="Providência da intimação">
      <label for="launchAppointmentDate" class="form-label">Data *</label><input id="launchAppointmentDate" class="form-input" type="date">
      <label for="launchAppointmentTime" class="form-label">Hora</label><input id="launchAppointmentTime" class="form-input" type="time">
      <label for="launchAppointmentLocation" class="form-label">Local</label><input id="launchAppointmentLocation" class="form-input" maxlength="255"></div>
    </fieldset>`, footer:`<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="confirmLancamentoIntimacao('${intimationId}')">Confirmar lançamento</button>`,
    onMount(modal){
      for (const prefix of ['launchDeadline','launchAppointment']) {
        const checkbox = modal.querySelector('#'+prefix), fields = modal.querySelector('#'+prefix+'Fields');
        const update = () => { fields.hidden = !checkbox.checked; fields.querySelectorAll('input').forEach(input => { input.disabled = !checkbox.checked; input.required = checkbox.checked && /(?:Title|Date)$/.test(input.id); }); };
        checkbox.addEventListener('change', update); update();
      }
    }
  });
}

async function confirmLancamentoIntimacao(intimationId){
  const value = id => document.getElementById(id).value.trim();
  const payload = {
    movement:{occurred_on:value('launchDate'),movement_type:'intimacao',description:value('launchDescription')},
    deadline:document.getElementById('launchDeadline').checked ? {title:value('launchDeadlineTitle'),due_date:value('launchDeadlineDate'),deadline_type:'manifestation'} : null,
    appointment:document.getElementById('launchAppointment').checked ? {title:value('launchAppointmentTitle'),appointment_date:value('launchAppointmentDate'),appointment_time:value('launchAppointmentTime') || null,appointment_type:'meeting',location:value('launchAppointmentLocation') || null} : null
  };
  try {
    const result = await backendApi(`/intimations/${intimationId}/launch`, {method:'POST',body:JSON.stringify(payload)});
    closeModal();
    toast(result.already_launched ? 'Este lançamento já estava registrado.' : 'Intimação lançada e concluída.', 'success');
    try { await refreshBackendBootstrap(); renderSection('intimations'); renderNotifications(); }
    catch (_) { toast('O lançamento foi salvo. Recarregue a página para atualizar os registros.', 'warning'); }
  } catch(error) { toast(apiErrorMessage(error), 'error'); }
}
// ============================================================
//                        BOOT
// ============================================================
SECTION_RENDERERS.billing = () => window.SemperfiCommercial.render() + window.SemperfiBillingCheckout.render();
SECTION_AFTER.billing = () => { window.SemperfiCommercial.mount(); window.SemperfiBillingCheckout.mount(backendApi); };
SECTION_RENDERERS.transparencia = () => window.SemperfiIntegrations.renderTransparency(DB.investigations);
SECTION_AFTER.transparencia = () => window.SemperfiIntegrations.mountTransparency(backendApi);
SECTION_RENDERERS.agentes = () => window.SemperfiIntegrations.renderAgents(DB.investigations);
SECTION_AFTER.agentes = () => window.SemperfiIntegrations.mountAgents(backendApi);
SECTION_RENDERERS.societario = () => window.SemperfiRadar.render(DB.investigations);
SECTION_AFTER.societario = () => window.SemperfiRadar.mount(backendApi, buildRadarFromCNPJ, result => { radarState.result=result; return renderRadarResult(); });
const localReportsRenderer = SECTION_RENDERERS.reports;
SECTION_RENDERERS.reports = () => localReportsRenderer() + window.SemperfiIntegrations.renderReports();
SECTION_AFTER.reports = () => window.SemperfiIntegrations.mountReports(backendApi);
const localFilesRenderer = SECTION_RENDERERS.metadata;
const localFilesMount = SECTION_AFTER.metadata;
SECTION_RENDERERS.metadata = () => window.SemperfiIntegrations.renderFiles(DB.investigations) + `<details class="panel mt-20"><summary>Inspeção temporária de arquivos no navegador</summary>${localFilesRenderer()}</details>`;
SECTION_AFTER.metadata = () => { localFilesMount?.(); window.SemperfiIntegrations.mountFiles(backendApi); };
const settingsRenderer = SECTION_RENDERERS.settings;
const settingsMount = SECTION_AFTER.settings;
SECTION_RENDERERS.settings = () => settingsRenderer() + window.SemperfiOrganization.render();
SECTION_AFTER.settings = () => { settingsMount?.(); window.SemperfiOrganization.mount(backendApi); };

async function startWorkspace(){
  try {
    await hydrateFromBackend();
    if(window.SemperfiOrganization.hasPendingInvitation()) appState.currentSection='settings';
    if (SETTINGS.sidebarCollapsed) document.getElementById('sidebar').classList.add('collapsed');
    renderSidebar(); renderSection(appState.currentSection); renderNotifications(); renderTopbarMeters();
    document.body.classList.remove('auth-pending');
    document.dispatchEvent(new Event('semperfi:ready'));
    setInterval(()=>{if(!document.hidden)renderNotifications();}, 60000);
  } catch(error) {
    document.getElementById('authStatus').textContent = apiErrorMessage(error);
    const retry = document.getElementById('authRetry');
    retry.hidden = false; retry.onclick = () => location.reload();
  }
}
// Every save uses native validation and a single in-flight request per action.
for (const name of ['saveClient','saveProcess','saveDeadline','saveAppointment','saveIntimation','saveFinancial','saveMovement','confirmLancamentoIntimacao']) {
  const original = window[name];
  let pending = false;
  window[name] = async function(...args) {
    if (pending) return;
    const form = document.getElementById('legalOperationForm');
    if (form?.dataset.action === name && !form.reportValidity()) return;
    const button = [...document.querySelectorAll('#modalContent .modal-footer button[onclick]')].find(item => item.getAttribute('onclick').trim().startsWith(name+'('));
    pending = true;
    try { return await window.SemperfiLegalForms.submit(button, () => original(...args)); }
    finally { pending = false; }
  };
}
startWorkspace();
