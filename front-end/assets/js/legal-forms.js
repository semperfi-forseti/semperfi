/* Validation shared by the legal workspace. The API remains authoritative. */
(() => {
  'use strict';
  const definitions = {
    saveClient: {f_name:{required:true,minLength:2,maxLength:255},f_document:{required:true,maxLength:32},f_email:{type:'email',maxLength:320},f_phone:{maxLength:64},f_address:{maxLength:512},f_responsible:{maxLength:160}},
    saveProcess: {f_number:{required:true,minLength:5,maxLength:32},f_clientId:{required:true},f_value:{min:'0',max:'999999999999.99',step:'0.01'},f_court:{maxLength:120},f_responsible:{maxLength:160}},
    saveDeadline: {f_title:{required:true,minLength:2,maxLength:255},f_processId:{required:true},f_date:{required:true},f_responsible:{maxLength:160}},
    saveAppointment: {f_title:{required:true,minLength:2,maxLength:255},f_date:{required:true},f_location:{maxLength:255}},
    saveIntimation: {f_content:{required:true,minLength:3},f_receivedAt:{required:true}},
    saveFinancial: {f_description:{required:true,minLength:2,maxLength:255},f_date:{required:true},f_amount:{required:true,min:'0.01',max:'999999999999.99',step:'0.01'}},
    saveMovement: {mvDesc:{required:true,minLength:3},mvDate:{required:true}},
    confirmLancamentoIntimacao: {launchDescription:{required:true,minLength:3},launchDate:{required:true}}
  };

  function enhance(modal, {processes=[]}={}) {
    const submit = [...modal.querySelectorAll('.modal-footer button[onclick]')].find(button =>
      Object.keys(definitions).some(name => button.getAttribute('onclick').trim().startsWith(`${name}(`)));
    if (!submit) return;
    const action = submit.getAttribute('onclick').split('(')[0].trim();
    const body = modal.querySelector('.modal-body');
    if (!body || body.querySelector('form')) return;
    const form = document.createElement('form');
    form.id = 'legalOperationForm';
    form.dataset.action = action;
    while (body.firstChild) form.append(body.firstChild);
    body.append(form);
    for (const button of form.querySelectorAll('button')) button.type = 'button';
    for (const [id, attributes] of Object.entries(definitions[action])) {
      const field = form.querySelector(`#${id}`);
      if (field) Object.assign(field, attributes);
    }
    // Keep the existing handler and its arguments, while adding native Enter submission.
    form.addEventListener('submit', event => { event.preventDefault(); if (!submit.disabled) submit.click(); });
    const implicitSubmit = document.createElement('button');
    implicitSubmit.type = 'submit'; implicitSubmit.hidden = true;
    form.append(implicitSubmit);
    const client = form.querySelector('#f_clientId');
    const process = form.querySelector('#f_processId');
    const alignClient = () => {
      const selected = processes.find(item => item.id === process?.value);
      if (client && selected) client.value = selected.clientId;
      if (client) client.disabled = Boolean(selected);
    };
    if (client && process) { alignClient(); process.addEventListener('change', alignClient); }
    if (action === 'saveFinancial') {
      const type = form.querySelector('#f_type'), status = form.querySelector('#f_status');
      const alignStatus = () => {
        for (const option of status.options) option.disabled = (type.value === 'receita' && option.value === 'pago') || (type.value === 'despesa' && option.value === 'recebido');
        if (status.selectedOptions[0]?.disabled) status.value = type.value === 'receita' ? 'recebido' : 'pago';
      };
      alignStatus(); type.addEventListener('change', alignStatus);
    }
    // Validation precedes inline click handlers, including calls from Enter.
    submit.addEventListener('click', event => {
      if (!form.reportValidity()) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
  }

  async function submit(button, operation) {
    if (button?.disabled) return;
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    try { return await operation(); }
    finally { if (button) { button.disabled = false; button.removeAttribute('aria-busy'); } }
  }

  window.SemperfiLegalForms = {enhance, submit};
})();
