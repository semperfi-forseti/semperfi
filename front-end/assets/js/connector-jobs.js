/* Follow an existing connector job; polling never submits another execution. */
(function (root) {
  'use strict';

  const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
  const pendingStatuses = new Set(['queued', 'running']);

  function makeError(code, message, state, cause) {
    const error = new Error(message);
    error.name = 'ConnectorJobError';
    error.code = code;
    error.runId = state.runId || null;
    error.jobId = state.jobId || null;
    error.status = state.status || null;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function recoveryHint(state) {
    return state.runId
      ? ` A execução ${state.runId} pode continuar no servidor. Use esse identificador para retomar o acompanhamento.`
      : ' A solicitação pode ter chegado ao servidor; confira o histórico antes de iniciar outra consulta.';
  }

  function positiveOption(value, fallback, name) {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value <= 0 || value > 2147483647) {
      throw new TypeError(`${name} deve ser um número positivo de milissegundos.`);
    }
    return value;
  }

  async function follow(request, payload, options, existingId) {
    if (typeof request !== 'function') throw new TypeError('Informe a função de acesso à API.');
    if (existingId !== undefined && (typeof existingId !== 'string' || !idPattern.test(existingId))) {
      throw new TypeError('Identificador de execução inválido.');
    }
    const timeoutMs = positiveOption(options.timeoutMs, 120000, 'timeoutMs');
    const pollIntervalMs = positiveOption(options.pollIntervalMs, 1500, 'pollIntervalMs');
    const state = {runId:existingId || null, jobId:null, status:existingId ? 'queued' : 'submitting'};
    const startedAt = Date.now();
    const controller = new AbortController();
    const externalSignal = options.signal;
    const cancel = () => controller.abort(makeError('ABORTED',
      `Acompanhamento interrompido.${recoveryHint(state)}`, state));
    const timer = setTimeout(() => controller.abort(makeError('TIMEOUT',
      `O tempo de acompanhamento terminou.${recoveryHint(state)}`, state)), timeoutMs);
    if (externalSignal?.aborted) cancel();
    else externalSignal?.addEventListener('abort', cancel, {once:true});

    const checkAbort = () => {
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    const progress = () => {
      if (typeof options.onProgress !== 'function') return;
      try {
        options.onProgress({runId:state.runId, jobId:state.jobId,
          status:state.status, elapsedMs:Date.now() - startedAt});
      } catch (_) { /* An observer must not change the execution result. */ }
    };

    // The explicit abort race also bounds adapters that do not honor AbortSignal.
    async function call(path, requestOptions) {
      checkAbort();
      let onAbort;
      const stopped = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, {once:true});
      });
      try {
        const operation = Promise.resolve().then(() => {
          checkAbort();
          return request(path, {...requestOptions, signal:controller.signal});
        });
        const response = await Promise.race([operation, stopped]);
        checkAbort();
        return response;
      } catch (error) {
        checkAbort();
        throw makeError('REQUEST_FAILED',
          `Não foi possível acompanhar a consulta.${recoveryHint(state)}`, state, error);
      } finally {
        controller.signal.removeEventListener('abort', onAbort);
      }
    }

    function pause() {
      checkAbort();
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(delay);
          controller.signal.removeEventListener('abort', onAbort);
          reject(controller.signal.reason);
        };
        const delay = setTimeout(() => {
          controller.signal.removeEventListener('abort', onAbort);
          resolve();
        }, pollIntervalMs);
        controller.signal.addEventListener('abort', onAbort, {once:true});
      });
    }

    function inspect(response) {
      const returnedStatus = response?.status || response?.detail?.status;
      if (returnedStatus === 'approval_required') {
        state.status = returnedStatus;
        throw makeError('APPROVAL_REQUIRED', 'A consulta exige aprovação antes de ser executada.', state);
      }
      const returnedId = response?.run_id || response?.id;
      if (!response || typeof returnedId !== 'string' || !idPattern.test(returnedId) ||
          (state.runId && state.runId !== returnedId)) {
        throw makeError('INVALID_RESPONSE',
          `A API retornou uma execução inválida.${recoveryHint(state)}`, state);
      }
      state.runId = returnedId;
      if (response.job_id) state.jobId = response.job_id;
      state.status = returnedStatus;
      if (returnedStatus === 'failed') {
        progress();
        const error = makeError('EXECUTION_FAILED', 'A consulta falhou no servidor. Nenhum resultado concluído foi recebido.', state);
        error.serverCode = typeof response.error_code === 'string' ? response.error_code.slice(0, 128) : null;
        throw error;
      }
      if (returnedStatus === 'cancelled' || returnedStatus === 'canceled') {
        progress();
        throw makeError('EXECUTION_CANCELLED', 'A consulta foi cancelada no servidor.', state);
      }
      if (!pendingStatuses.has(returnedStatus) && returnedStatus !== 'completed') {
        throw makeError('INVALID_RESPONSE',
          `A API retornou um estado de execução desconhecido.${recoveryHint(state)}`, state);
      }
      if (returnedStatus === 'completed') {
        const hasResult = [response.raw_snapshot, response.normalized_result]
          .some(value => value !== null && typeof value === 'object');
        if (!hasResult) throw makeError('INVALID_RESPONSE',
          'A API marcou a consulta como concluída, mas não retornou seus dados.', state);
      }
      progress();
      return response;
    }

    try {
      checkAbort();
      progress();
      let response;
      if (!existingId) {
        response = inspect(await call('/osint/runs', {method:'POST', body:JSON.stringify(payload)}));
      }
      while (!response || state.status !== 'completed') {
        response = inspect(await call(`/osint/runs/${encodeURIComponent(state.runId)}`, {method:'GET'}));
        if (state.status !== 'completed') await pause();
      }
      checkAbort();
      return {...response, run_id:state.runId, job_id:state.jobId, status:'completed'};
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', cancel);
    }
  }

  root.SemperfiConnectorJobs = Object.freeze({
    run(request, payload, options = {}) { return follow(request, payload, options); },
    async resume(request, runId, options = {}) {
      if (typeof runId !== 'string' || !idPattern.test(runId)) throw new TypeError('Identificador de execução inválido.');
      return follow(request, null, options, runId);
    }
  });
})(globalThis);
