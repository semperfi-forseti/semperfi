const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const vm=require('node:vm');
const source=readFileSync(join(__dirname,'../assets/js/client-profile.js'),'utf8');
function component(maskDoc){
  const context={window:{maskDoc},URL,Intl};vm.runInNewContext(source,context);
  return context.window.SemperClientProfile;
}
test('client profile has empty states and no invented personal data',()=>{
  const html=component().renderProfile({});
  assert.match(html,/Nenhuma informação complementar registrada/);
  assert.match(html,/Histórico profissional \(0\)/);
  assert.match(html,/Bens declarados \(0\)/);
  assert.doesNotMatch(html,/undefined|null|NaN/);
});
test('client profile escapes entered HTML and restricts source links to HTTP/S without credentials',()=>{
  const html=component().renderProfile({biography:'<img src=x onerror=alert(1)>',sources:[
    {titulo:'<script>unsafe</script>',url:'javascript:alert(1)'},
    {titulo:'Credenciais',url:'https://user:password@example.org'},
    {titulo:'Referência',url:'https://example.org?q=a&b=c'}
  ]});
  assert.doesNotMatch(html,/<img|<script|href="javascript|user:password/);
  assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);
  assert.match(html,/href="https:\/\/example.org\/\?q=a&amp;b=c"/);
  assert.match(html,/rel="noopener noreferrer"/);
});
test('client profile masks company documents by default and follows explicit privacy preference',()=>{
  const data={companies:[{nome:'Empresa informada',cnpj:'12345678000190'}]};
  assert.doesNotMatch(component().renderProfile(data),/12345678000190/);
  assert.match(component(value=>value).renderProfile(data),/12345678000190/);
  assert.equal(data.companies[0].cnpj,'12345678000190');
});
test('client profile shows supplied histories and precise declared values with field labels',()=>{
  const html=component().renderProfile({professionalHistory:[{cargo:'Consultor',organizacao:'Organização',periodo:'2021'}],assets:[{tipo:'Bem',valor:'10.50',ano:2020}],newsMentions:[{titulo:'Notícia',data:'2026-01-02'}]});
  assert.match(html,/Organização/);assert.match(html,/10,50/);assert.match(html,/02\/01\/2026/);
  assert.doesNotMatch(html,/<pre|profile_ciphertext|tenant_id/);
});
