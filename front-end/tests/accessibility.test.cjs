const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const source = readFileSync(join(__dirname,'../assets/js/accessibility.js'),'utf8');

function boot({stored=null,blocked=false,dark=false,contrast=false,motion=false}={}) {
  const values=new Map(stored===null?[]:[['semperfi_accessibility_v1',stored]]);
  const events={},queries={},root={dataset:{},style:{setProperty(name,value){this[name]=value;}}};
  const context={
    window:{addEventListener(name,callback){events[name]=callback;}},
    document:{documentElement:root,readyState:'loading',querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},dispatchEvent(){}},
    localStorage:{getItem(key){if(blocked)throw Error('Blocked');return values.get(key)??null;},setItem(key,value){if(blocked)throw Error('Blocked');values.set(key,value);}},
    matchMedia(query){const item={matches:query.includes('color-scheme')?dark:query.includes('contrast')?contrast:motion,addEventListener(_,fn){this.change=fn;}};queries[query]=item;return item;},
    CustomEvent:class{constructor(name,options){this.type=name;this.detail=options?.detail;}}
  };
  vm.runInNewContext(source,context);
  return {api:context.window.SemperfiAccessibility,values,root,events,queries};
}

test('invalid saved appearance cannot inject attributes or identity into preferences',()=>{
  const state=boot({stored:JSON.stringify({theme:'bad" value',textSize:999,contrast:null,spacing:'true',password:'must-not-be-retained'})});
  assert.equal(state.root.dataset.theme,'light');
  assert.equal(state.root.dataset.textSize,'100');
  assert.equal(state.api.getPreferences().spacing,false);
  assert.equal('password' in state.api.getPreferences(),false);
  assert.doesNotThrow(()=>boot({stored:'{not json'}));
});

test('appearance preferences persist separately and restore before body initialization',()=>{
  const first=boot();
  first.api.setPreferences({theme:'dark',contrast:'high',textSize:200,spacing:true,keepNotices:true,email:'must-not-be-retained'});
  assert.deepEqual([...first.values.keys()],['semperfi_accessibility_v1']);
  const second=boot({stored:first.values.get('semperfi_accessibility_v1')});
  assert.equal(second.root.dataset.theme,'dark');
  assert.equal(second.root.dataset.contrast,'high');
  assert.equal(second.root.dataset.textSize,'200');
  assert.equal(second.root.style['--a11y-scale'],'2');
  assert.equal(second.api.getPreferences().keepNotices,true);
  assert.equal('email' in second.api.getPreferences(),false);
});

test('system appearance follows changes while explicit selection remains stable',()=>{
  const state=boot();
  const query=state.queries['(prefers-color-scheme: dark)'];
  query.matches=true;query.change();
  assert.equal(state.root.dataset.theme,'dark');
  state.api.setPreferences({theme:'light'});
  query.change();
  assert.equal(state.root.dataset.theme,'light');
});

test('system reduced motion and contrast are honored without writing browser storage',()=>{
  const state=boot({contrast:true,motion:true});
  assert.equal(state.root.dataset.contrast,'high');
  assert.equal(state.root.dataset.reducedMotion,'true');
  assert.equal(state.api.shouldReduceMotion(),true);
  assert.equal(state.values.size,0);
});

test('blocked storage still allows usable visual controls and isolated preference copies',()=>{
  const state=boot({blocked:true});
  assert.doesNotThrow(()=>state.api.setPreferences({theme:'dark',textSize:150}));
  assert.equal(state.root.dataset.theme,'dark');
  assert.equal(state.root.dataset.textSize,'150');
  const copy=state.api.getPreferences();copy.theme='light';
  assert.equal(state.api.getPreferences().theme,'dark');
});

test('clearing settings in another tab restores system defaults without saving again',()=>{
  const state=boot({stored:JSON.stringify({theme:'dark',textSize:200})});
  state.values.clear();state.events.storage({key:null});
  assert.equal(state.root.dataset.theme,'light');
  assert.equal(state.root.dataset.textSize,'100');
  assert.equal(state.values.size,0);
});
