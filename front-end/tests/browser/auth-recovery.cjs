/* Browser regression for password recovery. API and SMTP are never contacted. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
function dependency(name) {
  try { return require(name); }
  catch (_) { return createRequire(path.join(os.tmpdir(), 'semperfi-review-tools', 'package.json'))(name); }
}
const { chromium } = dependency('playwright');
const root = path.resolve(__dirname, '../..');
const errors = [], requests = [], passed = [];
let pending = null;
const metadata = purpose => ({purpose,channel:'email',masked_destination:'r***@example.test',expires_in:300,resend_after:0,delivery_failed:false});
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) || pathname.startsWith('/v1/')) { res.writeHead(403).end(); return; }
    const content = await fs.readFile(file);
    const type = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'}[path.extname(file)];
    res.writeHead(200, {'Content-Type':`${type || 'application/octet-stream'}; charset=utf-8`}).end(content);
  } catch (_) { res.writeHead(404).end(); }
});
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/v1/')) return route.continue();
      const body = req.postDataJSON(); requests.push({path:url.pathname,body});
      const reply = (json, status=200) => route.fulfill({json,status});
      if (url.pathname === '/v1/auth/status') return reply({authenticated:false,password_enabled:true,password_recovery_enabled:true,registration_enabled:true,pending_verification:pending});
      if (url.pathname === '/v1/billing/catalog') return reply({plans:[]});
      if (url.pathname === '/v1/auth/password/forgot') {pending=metadata('reset');return reply({verification_required:true,pending_verification:pending},202);}
      if (url.pathname === '/v1/auth/password/reset') {
        if(body.code!=='123456')return reply({detail:'Código inválido ou expirado.'},400);
        pending=null;return reply({password_reset:true,authenticated:false});
      }
      if (url.pathname === '/v1/auth/resend') return reply({verification_required:true,pending_verification:pending});
      if (url.pathname === '/v1/auth/cancel') {pending=null;return route.fulfill({status:204});}
      if (url.pathname === '/v1/auth/login') {pending=metadata('login');return reply({verification_required:true,pending_verification:pending});}
      if (url.pathname === '/v1/auth/register') {pending=metadata('register');return reply({verification_required:true,pending_verification:pending});}
      errors.push(`Unexpected API: ${url.pathname}`); return reply({detail:'Unexpected request'},500);
    });
    await page.goto(`${origin}/login.html`);
    await page.waitForFunction(() => !document.getElementById('forgotPassword').disabled);
    await page.locator('#loginEmail').fill('recovery@example.test');
    await page.locator('#forgotPassword').click();
    assert.equal(await page.locator('#recoveryEmail').inputValue(),'recovery@example.test');
    assert.equal(await page.locator('#recoveryEmail').evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.locator('#loginPanel').isVisible(),false);
    passed.push('Recuperação acessível pelo login, com e-mail preenchido e foco no formulário');

    await page.locator('#recoveryEmail').fill('not-an-email');
    await page.locator('#requestRecovery').click();
    assert.equal(requests.filter(r=>r.path.endsWith('/forgot')).length,0);
    await page.locator('#recoveryEmail').fill('recovery@example.test');
    await page.locator('#requestRecovery').click();
    await page.locator('#resetPassword').waitFor({state:'visible'});
    assert.match(await page.locator('#verificationDestination').textContent(),/Se houver uma conta elegível/);
    passed.push('Validação do e-mail e confirmação sem revelar existência da conta');

    await page.locator('#verificationCode').fill('111111');
    await page.locator('#resetPassword').fill('Nova frase de acesso 456!');
    await page.locator('#resetConfirmation').fill('Uma frase diferente 123!');
    await page.locator('#verifyAccount').click();
    assert.equal(requests.filter(r=>r.path.endsWith('/reset')).length,0);
    await page.locator('#resetConfirmation').fill('Nova frase de acesso 456!');
    await page.locator('#verifyAccount').click();
    await page.waitForFunction(()=>document.getElementById('authStatus').textContent.includes('Código inválido'));
    assert.equal(await page.locator('#resetPassword').isVisible(),true);
    passed.push('Senhas divergentes impedem envio; código inválido permite corrigir');

    await page.locator('#resendCode').click();
    await page.waitForFunction(()=>document.getElementById('resetPassword').value==='');
    await page.reload();
    await page.locator('#resetPassword').waitFor({state:'visible'});
    assert.equal(await page.locator('#resetPassword').inputValue(),'');
    passed.push('Reenvio limpa senhas e recarregamento restaura a etapa pelo backend');

    await page.locator('#verificationCode').fill('123456');
    await page.locator('#resetPassword').fill('Nova frase de acesso 456!');
    await page.locator('#resetConfirmation').fill('Nova frase de acesso 456!');
    await page.locator('#verifyAccount').click();
    await page.waitForFunction(()=>document.getElementById('authStatus').textContent.includes('Senha redefinida'));
    assert.equal(await page.locator('#loginPanel').isVisible(),true);
    assert.equal(await page.locator('#loginPassword').inputValue(),'');
    assert.equal(new URL(page.url()).pathname,'/login.html');
    assert.equal(await page.evaluate(()=>Object.values(localStorage).some(v=>v.includes('Nova frase')) || Object.values(sessionStorage).some(v=>v.includes('Nova frase'))),false);
    passed.push('Redefinição retorna ao login sem armazenar senha nem entrar automaticamente');

    await page.locator('#loginEmail').fill('recovery@example.test');
    await page.locator('#loginPassword').fill('Nova frase de acesso 456!');
    await page.locator('#passwordLogin').click();
    await page.locator('#verificationCode').waitFor({state:'visible'});
    assert.equal(await page.locator('#resetPasswordFields').isVisible(),false);
    assert.equal(await page.locator('#resetPassword').isDisabled(),true);
    assert.equal(await page.locator('#verificationForm').getAttribute('action'),'/v1/auth/verify');
    passed.push('Login continua exigindo código e não apresenta campos de redefinição');

    await page.locator('#cancelVerification').click();
    await page.locator('#forgotPassword').click();
    await page.locator('#requestRecovery').click();
    await page.locator('#verificationCode').waitFor({state:'visible'});
    await page.locator('#cancelVerification').click();
    await page.locator('#recoveryEmail').waitFor({state:'visible'});
    await page.locator('#cancelRecovery').click();
    assert.equal(await page.locator('#loginPanel').isVisible(),true);
    await page.locator('#registerTab').click();
    await page.locator('[name="register_account_type"][value="PJ"]').check();
    assert.equal(await page.locator('#registerOrganization').isVisible(),true);
    assert.equal(await page.locator('#recoveryPanel').isVisible(),false);
    passed.push('Cancelamento permite reiniciar e cadastro PJ continua disponível');

    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:passed.length,scenarios:passed,javascriptErrors:errors.length},null,2));
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
}
main().catch(error=>{console.error(error);server.close();process.exitCode=1;});
