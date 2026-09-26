(function () {
  'use strict';

  // These are arithmetic tools. The professional supplies the applicable legal
  // parameters; no interest index, court calendar or eligibility rule is assumed.
  const DAY = 86400000;
  const MAX_CENTS = 100000000000n;
  const MAX_DATE = Date.UTC(2200, 11, 31);
  const mounted = new WeakSet();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const money = cents => new Intl.NumberFormat('pt-BR', {style:'currency',currency:'BRL'}).format(cents / 100);
  const displayDate = iso => iso.split('-').reverse().join('/');
  const isoDate = timestamp => new Date(timestamp).toISOString().slice(0, 10);

  function integer(value, label, min, max) {
    const raw = String(value ?? '').trim();
    if (raw.length > 16 || !/^\d+$/.test(raw)) throw new Error(`${label}: informe um número inteiro.`);
    const number = Number(raw);
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label}: informe um valor entre ${min} e ${max}.`);
    return number;
  }

  function decimal(value, label, min, max, places = 6) {
    const raw = String(value ?? '').trim().replace(',', '.');
    if (raw.length > 64 || !/^\d+(?:\.\d+)?$/.test(raw) || (raw.split('.')[1]?.length || 0) > places) {
      throw new Error(`${label}: informe um decimal com até ${places} casas, sem separador de milhar.`);
    }
    const number = Number(raw);
    if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label}: informe um valor entre ${min} e ${max}.`);
    const [whole, fraction = ''] = raw.split('.');
    return {number, numerator:BigInt(whole + fraction), denominator:10n ** BigInt(fraction.length)};
  }

  function cents(value, label) {
    const amount = decimal(value, label, 0, Number(MAX_CENTS) / 100, 2);
    return amount.numerator * 100n / amount.denominator;
  }

  function boundedCents(value) {
    if (value < -MAX_CENTS || value > MAX_CENTS) throw new Error('O resultado ultrapassa o limite de R$ 1 bilhão desta ferramenta.');
    return Number(value);
  }

  function roundedRatio(numerator, denominator) {
    return (2n * numerator + denominator) / (2n * denominator);
  }

  function date(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label}: informe uma data válida.`);
    const [year, month, day] = value.split('-').map(Number);
    const timestamp = Date.UTC(year, month - 1, day);
    if (year < 1900 || year > 2200 || isoDate(timestamp) !== value) throw new Error(`${label}: use uma data válida entre 1900 e 2200.`);
    return timestamp;
  }

  function period(start, end) {
    const first = date(start, 'Data inicial');
    const last = date(end, 'Data final');
    if (last < first) throw new Error('A data final não pode ser anterior à data inicial.');
    return (last - first) / DAY;
  }

  function choice(value, allowed, label) {
    if (!allowed.includes(value)) throw new Error(`${label}: selecione uma opção.`);
    return value;
  }

  function exclusions(value) {
    const values = Array.isArray(value) ? value : String(value ?? '').trim().split(/[\s,;]+/).filter(Boolean);
    if (values.length > 500) throw new Error('Informe no máximo 500 datas excluídas.');
    const unique = new Set();
    for (const entry of values) {
      date(entry, 'Data excluída');
      unique.add(entry);
    }
    return unique;
  }

  function calculateDeadline(input) {
    let timestamp = date(input.start, 'Data inicial');
    const start = timestamp;
    const days = integer(input.days, 'Quantidade de dias', 1, 3660);
    const mode = choice(input.mode, ['business','calendar'], 'Modalidade');
    if (typeof input.includeStart !== 'boolean' || typeof input.postpone !== 'boolean') throw new Error('Informe como contar o dia inicial e ajustar o vencimento.');
    const excluded = exclusions(input.excludedDates);
    const available = current => ![0,6].includes(new Date(current).getUTCDay()) && !excluded.has(isoDate(current));
    let counted = 0, skipped = 0, iterations = 0;
    if (!input.includeStart) timestamp += DAY;
    while (counted < days) {
      if (timestamp > MAX_DATE || ++iterations > 20000) throw new Error('O prazo ultrapassa o intervalo suportado.');
      if (mode === 'calendar' || available(timestamp)) counted += 1;
      else skipped += 1;
      if (counted < days) timestamp += DAY;
    }
    let adjustmentDays = 0;
    if (input.postpone) {
      while (!available(timestamp)) {
        timestamp += DAY;
        adjustmentDays += 1;
        if (timestamp > MAX_DATE || ++iterations > 20000) throw new Error('O ajuste ultrapassa o intervalo suportado.');
      }
    }
    return {date:isoDate(timestamp), days, mode, includeStart:input.includeStart,
      skippedDays:skipped, adjustmentDays, elapsedCalendarDays:(timestamp - start) / DAY,
      providedExclusions:excluded.size};
  }

  function calculateExecution(input) {
    const totalDays = integer(input.totalDays, 'Pena total em dias', 1, 365000);
    const completedDays = integer(input.completedDays, 'Dias reconhecidos como cumpridos', 0, totalDays);
    const numerator = integer(input.numerator, 'Numerador da fração', 1, 1000000);
    const denominator = integer(input.denominator, 'Denominador da fração', 1, 1000000);
    if (numerator > denominator) throw new Error('A fração não pode ser maior que 1.');
    const rounding = choice(input.rounding, ['ceil','floor','nearest'], 'Arredondamento');
    const product = BigInt(totalDays) * BigInt(numerator), divisor = BigInt(denominator);
    const targetDays = Number(rounding === 'ceil' ? (product + divisor - 1n) / divisor
      : rounding === 'floor' ? product / divisor : roundedRatio(product, divisor));
    return {totalDays, completedDays, numerator, denominator, rounding, targetDays,
      remainingDays:Math.max(0, targetDays - completedDays), arithmeticTargetReached:completedDays >= targetDays};
  }

  function calculateMonetary(input) {
    const elapsedDays = period(input.start, input.end);
    const original = cents(input.principal, 'Valor original');
    if (!original) throw new Error('O valor original deve ser maior que zero.');
    const factor = decimal(input.factor, 'Fator acumulado do período', 0.0000000001, 1000, 10);
    const updated = roundedRatio(original * factor.numerator, factor.denominator);
    boundedCents(updated);
    const interestMode = choice(input.interestMode, ['none','simple','compound'], 'Juros');
    let interest = 0n, interestRate = null, interestPeriods = null, interestBasis = null, periodUnit = null;
    if (interestMode !== 'none') {
      interestRate = decimal(input.interestRate, 'Taxa de juros por período (%)', 0, 100);
      interestPeriods = integer(input.interestPeriods, 'Quantidade de períodos de juros', 0, 1200);
      interestBasis = choice(input.interestBasis, ['original','updated'], 'Base dos juros');
      periodUnit = choice(input.periodUnit, ['day','month','year'], 'Unidade do período de juros');
      const basis = interestBasis === 'original' ? original : updated;
      if (interestMode === 'simple') {
        interest = roundedRatio(basis * interestRate.numerator * BigInt(interestPeriods), interestRate.denominator * 100n);
      } else {
        // Exponentiation is bounded by the validated number of periods. Integer
        // rationals avoid floating-point drift at a half-cent rounding boundary.
        const divisor = interestRate.denominator * 100n;
        const power = BigInt(interestPeriods);
        const factorNumerator = (divisor + interestRate.numerator) ** power;
        const factorDenominator = divisor ** power;
        interest = roundedRatio(basis * (factorNumerator - factorDenominator), factorDenominator);
      }
    }
    return {elapsedDays, originalCents:Number(original), correctionCents:boundedCents(updated - original),
      updatedCents:boundedCents(updated), interestCents:boundedCents(interest), totalCents:boundedCents(updated + interest),
      factor:factor.number, interestMode, interestRate:interestRate?.number ?? null,
      interestPeriods, interestBasis, periodUnit};
  }

  const RUBRICS = [
    ['salaryBalance','Saldo de salário apurado'], ['notice','Aviso prévio apurado'],
    ['thirteenth','13º apurado'], ['vacationDue','Férias vencidas apuradas, com adicionais'],
    ['vacationProportional','Férias proporcionais apuradas, com adicionais'], ['otherCredits','Outras verbas credoras apuradas']
  ];

  function calculateLabor(input) {
    const elapsedDays = period(input.admission, input.termination);
    const rows = RUBRICS.map(([key,label]) => ({key,label,amountCents:Number(cents(input[key], label))}));
    const deductions = cents(input.deductions, 'Descontos apurados');
    const fgtsMode = choice(input.fgtsMode, ['none','penalty'], 'Multa sobre FGTS');
    let fgtsBase = 0n, fgtsPenalty = 0n, fgtsRate = null;
    if (fgtsMode === 'penalty') {
      fgtsBase = cents(input.fgtsBase, 'Base real da multa sobre FGTS');
      fgtsRate = decimal(input.fgtsRate, 'Percentual informado da multa (%)', 0, 100);
      fgtsPenalty = roundedRatio(fgtsBase * fgtsRate.numerator, fgtsRate.denominator * 100n);
    }
    const gross = rows.reduce((sum,row) => sum + BigInt(row.amountCents), fgtsPenalty);
    return {elapsedDays, rows, grossCents:boundedCents(gross), deductionCents:Number(deductions),
      netCents:boundedCents(gross - deductions), fgtsBaseCents:Number(fgtsBase),
      fgtsPenaltyCents:boundedCents(fgtsPenalty), fgtsRate:fgtsRate?.number ?? null, fgtsMode};
  }

  function field(form, name, label, {type='number', min='0', max='', step='1', hint=''} = {}) {
    const id = `calculator_${form}_${name}`;
    return `<div class="form-group"><label class="form-label" for="${id}">${escape(label)}</label><input class="form-input" id="${id}" name="${name}" type="${type}" required ${type === 'number' ? `min="${min}" ${max ? `max="${max}"` : ''} step="${step}"` : 'min="1900-01-01" max="2200-12-31"'} ${hint ? `aria-describedby="${id}_hint"` : ''}>${hint ? `<p class="text-muted" id="${id}_hint">${escape(hint)}</p>` : ''}</div>`;
  }

  function select(form, name, label, options) {
    const id = `calculator_${form}_${name}`;
    return `<div class="form-group"><label class="form-label" for="${id}">${escape(label)}</label><select class="form-select" id="${id}" name="${name}" required><option value="">Selecione</option>${options.map(([value,text]) => `<option value="${value}">${escape(text)}</option>`).join('')}</select></div>`;
  }

  function panel(key, title, description, fields) {
    return `<section class="panel" aria-labelledby="calculator_${key}_title"><h2 class="panel-title" id="calculator_${key}_title">${title}</h2><p class="text-muted">${description}</p><form data-calculator="${key}" novalidate>${fields}<button class="btn btn-primary" type="submit">Calcular</button><button class="btn btn-secondary" type="reset">Limpar</button><div class="mt-12" data-calculator-result role="status" aria-live="polite" aria-atomic="true"></div></form></section>`;
  }

  function render() {
    return `<section id="calculatorWorkspace"><h1 class="page-title">Calculadoras</h1><p class="page-subtitle">Memórias de cálculo com parâmetros informados pelo profissional. Os dados permanecem nesta tela e não são salvos.</p><div class="grid-2x2">
      ${panel('deadline','Calendário de prazos','Informe o calendário aplicável. Dias úteis excluem sábado, domingo e as datas listadas abaixo; não há calendário de tribunal embutido.',
        field('deadline','start','Data inicial',{type:'date'}) + field('deadline','days','Quantidade de dias',{min:'1',max:'3660'}) +
        select('deadline','mode','Modalidade',[['business','Dias úteis do calendário informado'],['calendar','Dias corridos']]) +
        select('deadline','includeStart','Contagem do dia inicial',[['no','Começar no dia seguinte'],['yes','Incluir o dia inicial, se computável']]) +
        select('deadline','postpone','Ajuste do vencimento',[['no','Manter a data calculada'],['yes','Avançar até o próximo dia útil do calendário informado']]) +
        '<div class="form-group"><label class="form-label" for="calculator_deadline_excludedDates">Feriados e dias de suspensão aplicáveis</label><textarea class="form-textarea" id="calculator_deadline_excludedDates" name="excludedDates" rows="4" maxlength="5500" aria-describedby="calculator_deadline_calendar_hint"></textarea><p class="text-muted" id="calculator_deadline_calendar_hint">Opcional: uma data por linha, no formato AAAA-MM-DD, até 500 datas. Liste cada dia de uma suspensão. Sem datas, apenas fins de semana serão excluídos dos dias úteis.</p></div>')}
      ${panel('execution','Execução penal — fração informada','Calcule somente o marco numérico. Informe dias reconhecidos e a fração aplicável ao caso; alcançar o marco não determina elegibilidade jurídica.',
        field('execution','totalDays','Pena total em dias',{min:'1',max:'365000'}) +
        field('execution','completedDays','Dias reconhecidos como cumpridos',{max:'365000'}) +
        field('execution','numerator','Numerador da fração',{min:'1',max:'1000000'}) +
        field('execution','denominator','Denominador da fração',{min:'1',max:'1000000'}) +
        select('execution','rounding','Arredondamento do marco em dias',[['ceil','Para cima'],['floor','Para baixo'],['nearest','Mais próximo; meio dia para cima']]))}
      ${panel('monetary','Atualização monetária','Use o fator acumulado do período, obtido na fonte aplicável ao caso. A ferramenta não consulta índices nem presume juros legais. Arredondamento de cada parcela: centavo mais próximo, meio centavo para cima.',
        field('monetary','principal','Valor original (R$)',{min:'0.01',max:'1000000000',step:'0.01'}) +
        field('monetary','start','Data inicial',{type:'date'}) + field('monetary','end','Data final',{type:'date'}) +
        field('monetary','factor','Fator acumulado do período',{min:'0.0000000001',max:'1000',step:'0.0000000001',hint:'Multiplicador, não percentual. Informe 1 quando não houver correção.'}) +
        select('monetary','interestMode','Juros',[['none','Sem juros'],['simple','Juros simples'],['compound','Juros compostos']]) +
        `<div data-interest-fields hidden><fieldset disabled><legend>Parâmetros dos juros</legend>${field('monetary','interestRate','Taxa por período (%)',{max:'100',step:'0.000001'})}${field('monetary','interestPeriods','Quantidade inteira de períodos de juros',{max:'1200'})}${select('monetary','periodUnit','Unidade do período',[['day','Dia'],['month','Mês'],['year','Ano']])}${select('monetary','interestBasis','Base dos juros',[['original','Valor original'],['updated','Valor corrigido']])}<p class="text-muted">A quantidade de períodos é informada por você. As datas não geram meses ou juros automaticamente.</p></fieldset></div>`)}
      ${panel('labor','Composição de verbas trabalhistas','Informe valores apurados a partir dos documentos do caso; use zero quando a rubrica não se aplicar. Férias já devem incluir os adicionais cabíveis. Datas não geram direitos, avos ou depósitos presumidos.',
        field('labor','admission','Data de admissão',{type:'date'}) + field('labor','termination','Data de encerramento',{type:'date'}) +
        RUBRICS.map(([key,label]) => field('labor',key,`${label} (R$)`,{max:'1000000000',step:'0.01'})).join('') +
        field('labor','deductions','Descontos apurados (R$)',{max:'1000000000',step:'0.01'}) +
        select('labor','fgtsMode','Multa sobre FGTS',[['none','Não incluir multa nesta composição'],['penalty','Calcular sobre base documental informada']]) +
        `<div data-fgts-fields hidden><fieldset disabled><legend>Multa informada</legend>${field('labor','fgtsBase','Base real da multa sobre FGTS (R$)',{max:'1000000000',step:'0.01',hint:'Use a base documental aplicável, sem estimar depósitos pelo salário ou pelo tempo de vínculo.'})}${field('labor','fgtsRate','Percentual aplicável informado (%)',{max:'100',step:'0.000001'})}<p class="text-muted">Somente a multa entra na composição. O saldo de FGTS não é somado às verbas.</p></fieldset></div>`)}
      </div></section>`;
  }

  function resultRows(rows) {
    return `<dl>${rows.map(([label,value]) => `<div class="detail-row"><dt class="detail-label">${escape(label)}</dt><dd class="detail-value">${escape(value)}</dd></div>`).join('')}</dl>`;
  }

  function displayResult(key, result) {
    if (key === 'deadline') return resultRows([
      ['Data calculada',displayDate(result.date)], ['Dias computados',result.days],
      ['Dias excluídos durante a contagem',result.skippedDays], ['Dias adicionados no ajuste final',result.adjustmentDays],
      ['Datas excluídas informadas',result.providedExclusions], ['Calendário','Sábado, domingo e datas informadas; sem validação de tribunal']]);
    if (key === 'execution') return resultRows([
      ['Fração informada',`${result.numerator}/${result.denominator}`], ['Marco aritmético',`${result.targetDays} dias`],
      ['Arredondamento',({ceil:'Para cima',floor:'Para baixo',nearest:'Mais próximo; meio dia para cima'})[result.rounding]],
      ['Dias reconhecidos como cumpridos',result.completedDays], ['Dias faltantes para o marco',result.remainingDays],
      ['Resultado',result.arithmeticTargetReached ? 'Marco numérico alcançado. A elegibilidade jurídica depende de análise do caso.' : 'Marco numérico ainda não alcançado.']]);
    if (key === 'monetary') return resultRows([
      ['Intervalo entre as datas',`${result.elapsedDays} dias corridos; sem conversão automática em períodos de juros`],
      ['Fator informado',String(result.factor)], ['Valor original',money(result.originalCents)],
      ['Correção',money(result.correctionCents)], ['Valor corrigido',money(result.updatedCents)],
      ['Modalidade de juros',({none:'Sem juros',simple:'Simples',compound:'Compostos'})[result.interestMode]],
      ...(result.interestMode === 'none' ? [] : [
        ['Taxa e períodos',`${result.interestRate}% por ${({day:'dia',month:'mês',year:'ano'})[result.periodUnit]}; ${result.interestPeriods} períodos informados`],
        ['Base dos juros',result.interestBasis === 'original' ? 'Valor original' : 'Valor corrigido']]),
      ['Juros',money(result.interestCents)], ['Total',money(result.totalCents)]]);
    return resultRows([...result.rows.map(row => [row.label,money(row.amountCents)]),
      ...(result.fgtsMode === 'penalty' ? [
        ['Base documental de FGTS, fora do total',money(result.fgtsBaseCents)],
        ['Percentual informado da multa',`${result.fgtsRate}%`], ['Multa sobre FGTS informada',money(result.fgtsPenaltyCents)]]
        : [['Multa sobre FGTS','Não incluída por escolha do profissional']]),
      ['Total de verbas e multa',money(result.grossCents)], ['Descontos',money(result.deductionCents)],
      ['Resultado da composição',money(result.netCents)]]);
  }

  function mount() {
    const root = document.getElementById('calculatorWorkspace');
    if (!root || mounted.has(root)) return;
    mounted.add(root);
    const calculations = {deadline:calculateDeadline, execution:calculateExecution, monetary:calculateMonetary, labor:calculateLabor};
    function updateVisibility(form) {
      for (const [selector,visible] of [
        ['[data-interest-fields]', ['simple','compound'].includes(form.elements.namedItem('interestMode')?.value)],
        ['[data-fgts-fields]', form.elements.namedItem('fgtsMode')?.value === 'penalty']
      ]) {
        const group = form.querySelector(selector);
        if (group) { group.hidden = !visible; group.querySelector('fieldset').disabled = !visible; }
      }
    }
    function clearResult(form) {
      const target = form.querySelector('[data-calculator-result]');
      target.textContent = '';
      target.setAttribute('role','status');
    }
    root.addEventListener('input', event => { const form = event.target.closest('form'); if (form) clearResult(form); });
    root.addEventListener('change', event => { const form = event.target.closest('form'); if (form) { clearResult(form); updateVisibility(form); } });
    root.addEventListener('reset', event => {
      const form = event.target;
      clearResult(form);
      // The browser applies the native reset after dispatching the event. A
      // microtask can run before that default action and see the old selection.
      setTimeout(() => updateVisibility(form), 0);
    });
    root.addEventListener('submit', event => {
      const form = event.target;
      if (!form.dataset.calculator) return;
      event.preventDefault();
      clearResult(form);
      if (!form.reportValidity()) return;
      const result = form.querySelector('[data-calculator-result]');
      try {
        const input = Object.fromEntries(new FormData(form));
        if (form.dataset.calculator === 'deadline') {
          input.includeStart = input.includeStart === 'yes';
          input.postpone = input.postpone === 'yes';
        }
        result.innerHTML = displayResult(form.dataset.calculator, calculations[form.dataset.calculator](input));
      } catch (error) {
        result.setAttribute('role','alert');
        result.textContent = error.message || 'Confira os parâmetros informados.';
      }
    });
  }

  const api = Object.freeze({render,mount,calculateDeadline,calculateExecution,calculateMonetary,calculateLabor});
  if (typeof window !== 'undefined') window.SemperfiCalculators = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
