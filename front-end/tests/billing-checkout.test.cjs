const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const source = readFileSync(join(__dirname,'../assets/js/billing-checkout.js'),'utf8');

function fixture() {
  class Element {
    constructor() { this.attributes = new Map(); this.children = []; this._html = ''; this._text = ''; }
    setAttribute(key,value) { this.attributes.set(key,value); }
    removeAttribute(key) { this.attributes.delete(key); }
    set innerHTML(value) { this._html = value; this._text = ''; this.children = []; }
    get innerHTML() { return this._html; }
    set textContent(value) { this._text = value; this._html = ''; this.children = []; }
    get textContent() { return this._text; }
    append(child) { this.children.push(child); }
  }
  const content = new Element();
  const panel = {isConnected:true,querySelector:()=>content};
  const context = {window:{apiErrorMessage:error=>JSON.stringify(error)},URL,Intl,Map,WeakMap,
    document:{getElementById:()=>panel,createElement:()=>new Element()}};
  vm.runInNewContext(source,context);
  return {api:context.window.SemperfiBillingCheckout,content,panel};
}

const state = changes => ({environment:'sandbox',sandbox_only:true,enabled:true,can_manage:false,can_checkout:false,checkouts:[],...changes});

test('checkout accepts only an Asaas Sandbox payment address',()=>{
  const {api}=fixture();
  assert.ok(api.safeCheckoutUrl('https://sandbox.asaas.com/checkoutSession/show?id=test-order'));
  assert.ok(api.safeCheckoutUrl('https://sandbox.asaas.com/checkoutSession/show/test-order'));
  for(const link of ['https://asaas.com/checkoutSession/show?id=test','https://evil.test/',
    'https://sandbox.asaas.com:8443/checkoutSession/show?id=test','https://user@sandbox.asaas.com/checkoutSession/show?id=test',
    'https://sandbox.asaas.com/other','https://sandbox.asaas.com/checkoutSession/show?id=a&id=b',
    'javascript:alert(1)']) assert.equal(api.safeCheckoutUrl(link),null);
});

test('ordinary user sees no administration, internal order values or payment controls even if payload contains them',async()=>{
  const {api,content}=fixture();
  await api.mount(async()=>state({checkouts:[{id:'internal-id',plan_key:'escritorio',status:'unknown',checkout_url:'https://sandbox.asaas.com/checkoutSession/show?id=provider-id'}]}));
  assert.ok(!content.innerHTML.includes('data-billing-administration'));
  assert.ok(!content.innerHTML.includes('internal-id'));
  assert.ok(!content.innerHTML.includes('provider-id'));
  assert.ok(!content.innerHTML.includes('unknown'));
  assert.ok(content.children.some(item=>item.textContent.includes('administrador da conta')));
});

test('administration appears only with an explicit true permission from the server',async()=>{
  for(const canManage of [undefined,null,false,'true',1]) {
    const {api,content}=fixture();
    await api.mount(async()=>state({can_manage:canManage,enabled:false}));
    assert.ok(!content.innerHTML.includes('data-billing-administration'));
    assert.ok(!content.innerHTML.includes('hospedagem'));
  }
  const {api,content}=fixture();
  await api.mount(async()=>state({can_manage:true,enabled:false}));
  assert.ok(content.innerHTML.includes('data-billing-administration'));
  assert.ok(content.innerHTML.includes('configurações de pagamentos da hospedagem'));
  assert.ok(!content.innerHTML.includes('.env'));
});

test('admin history uses Portuguese names and states without internal IDs',async()=>{
  const {api,content}=fixture();
  await api.mount(async()=>state({can_manage:true,checkouts:[
    {id:'internal-id',plan_key:'escritorio',status:'unknown',amount_cents:32990},
    {id:'private-paid-id',plan_key:'profissional',status:'paid',checkout_url:'https://sandbox.asaas.com/checkoutSession/show?id=should-not-open'},
  ]}));
  assert.ok(content.innerHTML.includes('Escritório'));
  assert.ok(content.innerHTML.includes('Aguardando confirmação'));
  assert.ok(content.innerHTML.includes('Pagamento de teste confirmado'));
  for(const hidden of ['internal-id','private-paid-id','should-not-open','unknown']) assert.ok(!content.innerHTML.includes(hidden));
});

test('technical errors never appear in the payment panel and retry remains available',async()=>{
  const {api,content}=fixture();
  await api.mount(async()=>{throw {detail:'SMTP_TOKEN secret123 back-end/.env /v1/billing internal-stack'};});
  assert.equal(content.textContent,'Não foi possível consultar os pagamentos de teste. Tente novamente.');
  assert.ok(content.children.some(item=>item.textContent==='Tentar novamente'));
  assert.equal(content.attributes.get('aria-busy'),'false');
});

test('Sandbox remains explicit and unexpected environments fail closed',async()=>{
  const {api,content}=fixture();
  assert.ok(api.render().includes('Asaas Sandbox'));
  assert.ok(api.render().includes('sem cobrança real'));
  await api.mount(async()=>state({environment:'production',can_manage:true,can_checkout:true}));
  assert.ok(content.textContent.includes('Não foi possível consultar'));
  assert.ok(!content.innerHTML.includes('<form'));
});

test('a stale refresh cannot overwrite the latest permission response',async()=>{
  const {api,content}=fixture();
  let release;
  const old=api.mount(()=>new Promise(resolve=>{release=resolve;}));
  await api.mount(async()=>state({can_manage:false}));
  release(state({can_manage:true}));
  await old;
  assert.ok(!content.innerHTML.includes('data-billing-administration'));
});
