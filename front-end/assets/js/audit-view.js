/* Persisted organization audit events. No browser activity is presented as server evidence. */
(() => {
  'use strict';
  const mounted = new WeakSet();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const count = value => new Intl.NumberFormat('pt-BR').format(value);
  const formatDate = value => {
    // SQLite may serialize UTC timestamps without an explicit timezone suffix.
    const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? `${value}Z` : value;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? 'Data não informada' : date.toLocaleString('pt-BR');
  };
  const resultLabel = value => ({success:'Sucesso',denied:'Negado',error:'Erro',failure:'Falha'}[value] || value);

  async function request(path, method = 'GET') {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30000);
    try {
      let response;
      try {
        response = await fetch(`/v1${path}`, {method,credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal:controller.signal});
      } catch (_) { throw new Error('Não foi possível conectar ao serviço de auditoria. Tente novamente.'); }
      let payload;
      try { payload = await response.json(); }
      catch (_) { throw new Error('O serviço de auditoria retornou uma resposta inválida. Tente novamente.'); }
      if (!response.ok) {
        const detail = payload?.detail;
        if (response.status === 401) throw new Error('Sua sessão expirou. Entre novamente para consultar a auditoria.');
        if (detail?.policy_code === 'MFA_REAUTH_REQUIRED') throw new Error('A verificação exige confirmação de acesso recente. Saia da conta e entre novamente com o código de segurança.');
        if (response.status === 403) throw new Error(typeof detail === 'string' ? detail : typeof detail?.reason === 'string' ? detail.reason : 'Seu perfil não tem permissão para esta operação de auditoria.');
        if (response.status === 429) throw new Error('Muitas solicitações. Aguarde antes de tentar novamente.');
        throw new Error('Não foi possível concluir a operação de auditoria. Tente novamente.');
      }
      return payload;
    } finally { window.clearTimeout(timer); }
  }

  function render() {
    return `<section id="auditPanel" aria-labelledby="auditTitle">
      <h1 class="page-title" id="auditTitle">Auditoria</h1>
      <p class="page-subtitle">Eventos persistidos no servidor para sua organização.</p>
      <div class="panel">
        <div class="filter-bar">
          <div class="form-group"><label class="form-label" for="auditLimit">Eventos mais recentes</label><select class="form-select" id="auditLimit"><option value="100">Até 100 eventos</option><option value="250">Até 250 eventos</option><option value="500">Até 500 eventos</option></select></div>
          <button class="btn btn-secondary" id="auditReload" type="button">Atualizar eventos</button>
        </div>
        <p id="auditLoadStatus" role="status" aria-live="polite" aria-atomic="true">Aguardando consulta ao servidor.</p>
        <p class="text-muted">A leitura e a verificação também geram eventos de auditoria. Os filtros abaixo se aplicam somente aos registros carregados.</p>
        <div id="auditFilters" class="filter-bar mt-20">
          <div class="form-group"><label class="form-label" for="auditResource">Tipo de recurso</label><select class="form-select" id="auditResource" disabled><option value="">Todos</option></select></div>
          <div class="form-group"><label class="form-label" for="auditAction">Ação registrada</label><select class="form-select" id="auditAction" disabled><option value="">Todas</option></select></div>
          <div class="form-group"><label class="form-label" for="auditResult">Resultado</label><select class="form-select" id="auditResult" disabled><option value="">Todos</option></select></div>
          <div class="form-group grow"><label class="form-label" for="auditSearch">Buscar nos eventos carregados</label><input class="form-input" id="auditSearch" type="search" placeholder="Ação, recurso, ID ou correlação" autocomplete="off" disabled></div>
          <button class="btn btn-secondary" id="auditClearFilters" type="button" disabled>Limpar filtros</button>
        </div>
        <p id="auditCount" role="status" aria-live="polite" aria-atomic="true"></p>
        <div id="auditRows" aria-busy="false"></div>
      </div>
      <section class="panel mt-20" aria-labelledby="auditIntegrityTitle">
        <h2 id="auditIntegrityTitle" class="panel-title">Integridade da cadeia de auditoria</h2>
        <p>Confere a sequência e os hashes dos eventos de auditoria da organização no servidor, independentemente dos filtros e do limite da lista. Não verifica outros logs técnicos, avisos do navegador ou a veracidade das informações registradas.</p>
        <p class="text-muted">Disponível para administradores e auditores com confirmação de acesso recente.</p>
        <button class="btn btn-secondary mt-12" id="auditVerify" type="button">Verificar integridade</button>
        <div id="auditVerifyStatus" role="status" aria-live="polite" aria-atomic="true" class="mt-12">A integridade ainda não foi consultada nesta tela.</div>
      </section>
    </section>`;
  }

  function validEvents(payload) {
    if (!Array.isArray(payload) || payload.some(item => !item || ['id','action','resource_type','result','correlation_id','occurred_at','event_hash'].some(field => typeof item[field] !== 'string') || !(item.resource_id == null || typeof item.resource_id === 'string'))) {
      throw new Error('O serviço de auditoria retornou eventos em um formato inválido. Tente novamente.');
    }
    return payload;
  }

  async function mount(panel = document.getElementById('auditPanel')) {
    if (!panel || mounted.has(panel)) return;
    mounted.add(panel);
    const get = id => panel.querySelector(`#${id}`);
    const state = {events:[],loading:false,verifying:false,limit:100,loaded:false};
    const controls = ['auditResource','auditAction','auditResult','auditSearch','auditClearFilters'];
    function message(id, text, error = false) {
      const target = get(id);
      target.setAttribute('role', error ? 'alert' : 'status');
      target.textContent = text;
      target.classList.toggle('text-danger', error);
    }
    function busy() {
      get('auditReload').disabled = state.loading || state.verifying;
      get('auditLimit').disabled = state.loading || state.verifying;
      get('auditVerify').disabled = state.loading || state.verifying;
      get('auditRows').setAttribute('aria-busy', String(state.loading));
      get('auditReload').textContent = state.loading ? 'Consultando…' : 'Atualizar eventos';
      get('auditVerify').textContent = state.verifying ? 'Verificando…' : 'Verificar integridade';
      for (const id of controls) get(id).disabled = !state.loaded || state.loading;
    }
    function options(id, field, all) {
      const select = get(id), previous = select.value;
      const values = [...new Set(state.events.map(event => event[field]))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
      select.innerHTML = `<option value="">${all}</option>${values.map(value=>`<option value="${escape(value)}">${escape(field === 'result' ? resultLabel(value) : value)}</option>`).join('')}`;
      select.value = values.includes(previous) ? previous : '';
    }
    function updateRows() {
      const resource = get('auditResource').value, action = get('auditAction').value, result = get('auditResult').value;
      const query = get('auditSearch').value.trim().toLocaleLowerCase('pt-BR');
      const rows = state.events.filter(event => (!resource || event.resource_type === resource) && (!action || event.action === action) && (!result || event.result === result) && (!query || [event.id,event.action,event.resource_type,event.resource_id,event.correlation_id,event.event_hash].some(value=>String(value ?? '').toLocaleLowerCase('pt-BR').includes(query))));
      get('auditCount').textContent = `${count(rows.length)} de ${count(state.events.length)} eventos carregados exibidos.`;
      const target = get('auditRows');
      if (!rows.length) {
        target.innerHTML = `<p class="empty-state">${state.events.length ? 'Nenhum evento corresponde aos filtros informados.' : 'Nenhum evento foi retornado nesta consulta. Novas operações registradas no servidor aparecerão após atualizar.'}</p>`;
        return;
      }
      target.innerHTML = `<div class="table-scroll" role="region" aria-label="Eventos persistidos de auditoria, tabela com rolagem horizontal" tabindex="0" style="overflow-x:auto;max-width:100%"><table>
        <caption class="sr-only">Eventos de auditoria retornados pelo servidor, do mais recente para o mais antigo</caption>
        <thead><tr><th scope="col">Data e hora</th><th scope="col">Ação</th><th scope="col">Recurso</th><th scope="col">ID do recurso</th><th scope="col">Resultado</th><th scope="col">Identificação e hash</th></tr></thead>
        <tbody>${rows.map(event=>`<tr><td><time datetime="${escape(event.occurred_at)}">${escape(formatDate(event.occurred_at))}</time></td><td>${escape(event.action)}</td><td>${escape(event.resource_type)}</td><td style="overflow-wrap:anywhere">${escape(event.resource_id || 'Não se aplica')}</td><td>${escape(resultLabel(event.result))}</td><td><details><summary>Detalhes do evento</summary><dl><dt>ID do evento</dt><dd style="overflow-wrap:anywhere">${escape(event.id)}</dd><dt>ID de correlação</dt><dd style="overflow-wrap:anywhere">${escape(event.correlation_id)}</dd><dt>Hash do evento</dt><dd style="overflow-wrap:anywhere">${escape(event.event_hash)}</dd></dl></details></td></tr>`).join('')}</tbody>
      </table></div>`;
    }
    async function load() {
      if (state.loading || state.verifying) return;
      state.loading = true;
      state.limit = [100,250,500].includes(Number(get('auditLimit').value)) ? Number(get('auditLimit').value) : 100;
      busy(); message('auditLoadStatus','Consultando os eventos persistidos no servidor…');
      try {
        const events = validEvents(await request(`/audit-events?limit=${state.limit}`));
        if (!panel.isConnected) return;
        state.events = events; state.loaded = true;
        options('auditResource','resource_type','Todos'); options('auditAction','action','Todas'); options('auditResult','result','Todos');
        updateRows();
        message('auditLoadStatus',`${count(events.length)} eventos recebidos do servidor. Limite desta consulta: ${count(state.limit)}.${events.length >= state.limit ? ' Podem existir eventos anteriores fora deste recorte.' : ''}`);
      } catch (error) {
        if (!panel.isConnected) return;
        message('auditLoadStatus',`${error.message}${state.loaded ? ' Os dados da última consulta continuam visíveis e podem estar desatualizados.' : ''}`,true);
      } finally { state.loading = false; if (panel.isConnected) busy(); }
    }
    async function verify() {
      if (state.loading || state.verifying) return;
      state.verifying = true; busy(); message('auditVerifyStatus','Verificando a cadeia de auditoria da organização no servidor…');
      try {
        const result = await request('/audit-events/verify-chain','POST');
        if (!panel.isConnected) return;
        if (typeof result?.valid !== 'boolean' || !Number.isInteger(result.checked) || result.checked < 0 || (!result.valid && typeof result.broken_event_id !== 'string') || (result.valid && !(result.head_hash == null || typeof result.head_hash === 'string'))) throw new Error('O serviço retornou uma verificação em formato inválido. Tente novamente.');
        if (!result.valid) message('auditVerifyStatus',`Inconsistência encontrada após verificar ${count(result.checked)} eventos. Primeiro evento com divergência: ${result.broken_event_id}. Solicite a revisão do administrador.`,true);
        else {
          const text = result.checked ? `Cadeia consistente na verificação do servidor: ${count(result.checked)} eventos conferidos.${result.head_hash ? ` Hash final: ${result.head_hash}.` : ''}` : 'Nenhum evento existia na cadeia no momento da verificação.';
          message('auditVerifyStatus',`${text} Resultado obtido em ${new Date().toLocaleString('pt-BR')}. Esta consulta não comprova a veracidade do conteúdo nem verifica outros logs.`);
        }
      } catch (error) { if (panel.isConnected) message('auditVerifyStatus',error.message,true); }
      finally { state.verifying = false; if (panel.isConnected) busy(); }
    }
    for (const id of ['auditResource','auditAction','auditResult']) get(id).addEventListener('change',updateRows);
    get('auditSearch').addEventListener('input',updateRows);
    get('auditClearFilters').addEventListener('click',()=>{ for (const id of ['auditResource','auditAction','auditResult','auditSearch']) get(id).value = ''; updateRows(); get('auditSearch').focus(); });
    get('auditReload').addEventListener('click',load);
    get('auditLimit').addEventListener('change',load);
    get('auditVerify').addEventListener('click',verify);
    await load();
  }
  window.SemperfiAudit = Object.freeze({render,mount});
})();
