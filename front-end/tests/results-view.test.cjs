const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const source=readFileSync(join(__dirname,'../assets/js/integrations-view.js'),'utf8');
function renderer(maskDoc){
  const context={window:{maskDoc}};vm.runInNewContext(source,context);
  return context.window.SemperfiIntegrations.renderResult;
}
test('results organize professional content without exposing internal identifiers or secrets',()=>{
  const data={razao_social:'Organização isolada',id:'internal-ref',token:'test-secret',nested:{password:'test-password',endpoint:'/v1/private',cpf:'00000000000'},confidence:0.5,limitations:['Revisar a fonte']};
  const html=renderer()(data);
  assert.match(html,/Razão social/);assert.match(html,/Organização isolada/);
  assert.match(html,/Confiança informada pela IA/);assert.match(html,/0.5/);assert.match(html,/Revisar a fonte/);
  assert.doesNotMatch(html,/internal-ref|test-secret|test-password|\/v1\/private|00000000000/);
  assert.equal(data.nested.cpf,'00000000000','visual masking does not modify the source record');
});
test('document masking honors the existing explicit privacy preference',()=>{
  assert.match(renderer(value=>value)({cnpj:'00000000000000'}),/00000000000000/);
  assert.doesNotMatch(renderer(()=> '***********00')({cpf:'00000000000'}),/00000000000/);
});
test('provider content cannot inject HTML and deeply nested content is bounded',()=>{
  const render=renderer();assert.doesNotMatch(render({summary:'<img src=x onerror=alert(1)>'}),/<img/);
  assert.match(render({summary:'<img>'}),/&lt;img&gt;/);
  let value={summary:'unreachable'};for(let i=0;i<20;i++)value={nested:value};
  const html=render(value);assert.match(html,/limite de exibição/);assert.doesNotMatch(html,/unreachable/);
});
