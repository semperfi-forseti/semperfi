/* Component browser coverage; API persistence is covered by backend integration tests. */
'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
const {createRequire}=require('node:module');
function dependency(name){
  try{return require(name);}catch(_){return createRequire(path.join(os.tmpdir(),'semperfi-review-tools','package.json'))(name);}
}
const {chromium}=dependency('playwright');
(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<main></main>');
    await page.addScriptTag({path:path.resolve(__dirname,'../../assets/js/client-profile.js')});
    await page.evaluate(async()=>{
      window.profileSaved={version:0,profile:{}};
      window.profileWrites=[];
      window.profileMode='success';
      window.profileRequest=async(path,options={})=>{
        if(options.method==='PUT'){
          window.profileWrites.push(JSON.parse(options.body));
          if(window.profileMode==='conflict')throw {status:409};
          if(window.profileMode==='network')throw new Error('Network unavailable');
          const body=JSON.parse(options.body);
          window.profileSaved={version:body.version+1,profile:body.profile};
        }
        return JSON.parse(JSON.stringify(window.profileSaved));
      };
      document.querySelector('main').innerHTML=SemperClientProfile.render();
      await SemperClientProfile.mount({clientId:'test-client',canEdit:true,request:window.profileRequest});
    });
    assert.match(await page.locator('#clientProfileStatus').textContent(),/Nenhuma informação/);
    await page.getByRole('button',{name:'Editar perfil complementar'}).click();
    await page.getByLabel('Biografia',{exact:true}).fill('Biografia revisada com acentuação ⚖️ <img src=x onerror=alert(1)>');
    await page.getByLabel('Profissão',{exact:true}).fill('Advogado');
    await page.locator('summary').filter({hasText:'Histórico profissional'}).click();
    await page.getByRole('button',{name:'Adicionar registro em histórico profissional'}).click();
    await page.getByLabel('Cargo ou atividade *',{exact:true}).fill('Consultor');
    await page.getByLabel('Organização',{exact:true}).fill('Instituição informada');
    await page.getByRole('button',{name:'Salvar perfil',exact:true}).click();
    assert.match(await page.locator('#clientProfileStatus').textContent(),/Perfil salvo/);
    assert.equal(await page.locator('#clientProfileContent img').count(),0);
    assert.match(await page.locator('#clientProfileContent').textContent(),/Instituição informada/);
    const saved=await page.evaluate(()=>window.profileWrites[0]);
    assert.equal(saved.version,0);assert.equal(saved.profile.profession,'Advogado');
    assert.equal(saved.profile.professionalHistory[0].cargo,'Consultor');
    // Recreate the panel to prove its state comes from the request, not a DOM cache.
    await page.evaluate(async()=>{
      document.querySelector('main').innerHTML=SemperClientProfile.render();
      await SemperClientProfile.mount({clientId:'test-client',canEdit:true,request:window.profileRequest});
    });
    assert.match(await page.locator('#clientProfileContent').textContent(),/Biografia revisada/);
    await page.getByRole('button',{name:'Editar perfil complementar'}).click();
    await page.getByLabel('Profissão',{exact:true}).fill('Valor ainda não salvo');
    await page.evaluate(()=>{window.profileMode='conflict';});
    await page.getByRole('button',{name:'Salvar perfil',exact:true}).click();
    assert.match(await page.locator('#clientProfileStatus').textContent(),/Outra pessoa atualizou/);
    assert.equal(await page.getByLabel('Profissão',{exact:true}).inputValue(),'Valor ainda não salvo');
    assert.equal(await page.evaluate(()=>window.profileSaved.profile.profession),'Advogado');
    assert.equal(await page.getByRole('button',{name:'Salvar perfil',exact:true}).isEnabled(),true);
    await page.evaluate(()=>{window.profileMode='network';});
    await page.getByRole('button',{name:'Salvar perfil',exact:true}).click();
    assert.match(await page.locator('#clientProfileStatus').textContent(),/Seus dados digitados foram mantidos/);
    assert.equal(await page.getByLabel('Profissão',{exact:true}).inputValue(),'Valor ainda não salvo');
    page.once('dialog',dialog=>dialog.dismiss());
    await page.getByRole('button',{name:'Recarregar perfil',exact:true}).click();
    assert.equal(await page.getByLabel('Profissão',{exact:true}).inputValue(),'Valor ainda não salvo');
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'Recarregar perfil',exact:true}).click();
    assert.match(await page.locator('#clientProfileContent').textContent(),/Advogado/);
    assert.doesNotMatch(await page.locator('#clientProfileContent').textContent(),/Valor ainda não salvo/);
    // An auditor can read supplied content but is not offered mutation controls.
    await page.evaluate(async()=>{
      document.querySelector('main').innerHTML=SemperClientProfile.render();
      await SemperClientProfile.mount({clientId:'test-client',canEdit:false,request:window.profileRequest});
    });
    assert.equal(await page.getByRole('button',{name:'Editar perfil complementar'}).count(),0);
    assert.match(await page.locator('#clientProfileContent').textContent(),/Instituição informada/);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,scenarios:5,javascriptErrors:errors.length,coverage:['save and reload','HTML escaping','version conflict retains draft','network failure and reload confirmation','read-only role']}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
