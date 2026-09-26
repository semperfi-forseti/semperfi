/* Appearance and accessibility preferences; no identity or business data. */
(() => {
  'use strict';
  const key = 'semperfi_accessibility_v1';
  const root = document.documentElement;
  const defaults = Object.freeze({theme:'system',contrast:'system',textSize:100,spacing:false,underlineLinks:false,reduceMotion:false,keepNotices:false});
  const media = {dark:matchMedia('(prefers-color-scheme: dark)'),contrast:matchMedia('(prefers-contrast: more)'),motion:matchMedia('(prefers-reduced-motion: reduce)')};
  const choose = (value, options, fallback) => options.includes(value) ? value : fallback;
  function normalize(value) {
    const data = value && typeof value === 'object' ? value : {};
    return {
      theme:choose(data.theme,['system','dark','light'],defaults.theme),
      contrast:choose(data.contrast,['system','normal','high'],defaults.contrast),
      textSize:choose(data.textSize,[100,125,150,200],100),
      spacing:data.spacing === true,underlineLinks:data.underlineLinks === true,
      reduceMotion:data.reduceMotion === true,keepNotices:data.keepNotices === true
    };
  }
  function read() { try { return normalize(JSON.parse(localStorage.getItem(key))); } catch (_) { return {...defaults}; } }
  let preferences = read(), dialog = null, returnFocus = null;
  const shouldReduceMotion = () => preferences.reduceMotion || media.motion.matches;
  function apply() {
    root.dataset.theme = preferences.theme === 'system' ? (media.dark.matches ? 'dark' : 'light') : preferences.theme;
    root.dataset.contrast = preferences.contrast === 'system' ? (media.contrast.matches ? 'high' : 'normal') : preferences.contrast;
    root.dataset.textSize = String(preferences.textSize);
    root.style.setProperty('--a11y-scale',String(preferences.textSize / 100));
    root.dataset.spacing = String(preferences.spacing);
    root.dataset.underlineLinks = String(preferences.underlineLinks);
    root.dataset.reducedMotion = String(shouldReduceMotion());
    root.style.colorScheme = root.dataset.theme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content',root.dataset.theme);
    updateControls();
    document.dispatchEvent(new CustomEvent('semperfi:accessibility',{detail:{...preferences}}));
  }
  function setPreferences(changes, announce = true) {
    preferences = normalize({...preferences,...changes});
    let stored = true;
    try { localStorage.setItem(key,JSON.stringify(preferences)); } catch (_) { stored = false; }
    apply();
    if (announce && dialog?.open) document.getElementById('a11yStatus').textContent = stored
      ? 'Preferências aplicadas e salvas neste navegador.'
      : 'Preferências aplicadas nesta página. O navegador não permitiu salvar para o próximo acesso.';
    return {...preferences};
  }
  function updateControls() {
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      const label = root.dataset.theme === 'dark' ? 'Modo claro' : 'Modo escuro';
      button.setAttribute('aria-label',`Ativar ${label.toLowerCase()}`);
      const text = button.querySelector('[data-theme-label]');
      if (text) text.textContent = label;
      const icon = button.querySelector('[data-theme-icon]');
      if (icon) icon.textContent = root.dataset.theme === 'dark' ? '☀' : '☾';
    });
    if (!dialog) return;
    dialog.querySelectorAll('[name="a11yTheme"]').forEach(input => {input.checked = input.value === preferences.theme;});
    document.getElementById('a11yTextSize').value = String(preferences.textSize);
    document.getElementById('a11yContrast').value = preferences.contrast;
    for (const [id,setting] of [['a11ySpacing','spacing'],['a11yUnderline','underlineLinks'],['a11yMotion','reduceMotion'],['a11yNotices','keepNotices']]) {
      document.getElementById(id).checked = preferences[setting];
    }
  }
  function open() {
    if (!dialog || dialog.open) return;
    returnFocus = document.activeElement;
    updateControls();
    document.getElementById('a11yStatus').textContent = '';
    dialog.showModal();
    document.querySelectorAll('[data-a11y-open]').forEach(button => button.setAttribute('aria-expanded','true'));
    document.getElementById('a11yTitle').focus();
  }
  window.SemperfiAccessibility = Object.freeze({getPreferences:()=>({...preferences}),setPreferences,open,isOpen:()=>!!dialog?.open,shouldReduceMotion});
  // This script runs in the head, before styles paint the first frame.
  apply();
  Object.values(media).forEach(query => query.addEventListener('change',apply));
  window.addEventListener('storage',event => {if(event.key === key || event.key === null){preferences=read();apply();}});

  function initialize() {
    dialog = document.createElement('dialog');
    dialog.id = 'a11yDialog'; dialog.className = 'a11y-dialog';
    dialog.setAttribute('aria-labelledby','a11yTitle'); dialog.setAttribute('aria-describedby','a11yDescription');
    dialog.innerHTML = `
      <header class="a11y-dialog-header"><div><h2 id="a11yTitle" tabindex="-1">Aparência e acessibilidade</h2><p id="a11yDescription">Ajustes para sua leitura e navegação. São aplicados à tela de acesso e ao painel, neste navegador.</p></div><button id="a11yClose" class="a11y-close" type="button" aria-label="Fechar acessibilidade">×</button></header>
      <div class="a11y-dialog-body">
        <fieldset class="a11y-theme"><legend>Aparência</legend><div class="a11y-theme-options">
          <label><input type="radio" name="a11yTheme" value="light"><span>Claro</span></label>
          <label><input type="radio" name="a11yTheme" value="dark"><span>Escuro</span></label>
          <label><input type="radio" name="a11yTheme" value="system"><span>Usar sistema</span></label>
        </div></fieldset>
        <div class="a11y-select-row"><label for="a11yTextSize">Tamanho do texto</label><select id="a11yTextSize"><option value="100">100% · Padrão</option><option value="125">125% · Maior</option><option value="150">150% · Ampliado</option><option value="200">200% · Máximo</option></select></div>
        <div class="a11y-select-row"><label for="a11yContrast">Contraste</label><select id="a11yContrast"><option value="system">Usar preferência do sistema</option><option value="normal">Padrão do tema</option><option value="high">Alto contraste</option></select></div>
        <label class="a11y-option"><input id="a11ySpacing" type="checkbox"><span><strong>Mais espaço para leitura</strong><small>Aumenta a distância entre linhas, palavras e letras.</small></span></label>
        <label class="a11y-option"><input id="a11yUnderline" type="checkbox"><span><strong>Sublinhar links</strong><small>Facilita reconhecer os links além da cor.</small></span></label>
        <label class="a11y-option"><input id="a11yMotion" type="checkbox"><span><strong>Reduzir movimento</strong><small>Desativa animações e rolagem suave. A preferência de movimento reduzido do sistema também é respeitada.</small></span></label>
        <label class="a11y-option"><input id="a11yNotices" type="checkbox"><span><strong>Manter avisos na tela</strong><small>Os avisos do painel ficam visíveis até você fechá-los. Erros e alertas importantes sempre permitem fechamento manual.</small></span></label>
        <details class="a11y-help"><summary>Orientações de acessibilidade</summary><ul><li>Use Tab e Shift+Tab para navegar, Enter ou Espaço para acionar controles e Escape para fechar janelas.</li><li>No painel, Ctrl+K ou ⌘+K leva à busca. Os links de salto permitem ir direto ao conteúdo.</li><li>As mensagens de confirmação e erro são apresentadas em texto. O acesso não depende de sons.</li><li>Os formulários usam nomes e estados para leitores de tela. O código de e-mail aceita colar e preenchimento automático.</li><li>Você também pode usar o zoom do navegador. As preferências não alteram a conta ou suas permissões.</li></ul></details>
        <p id="a11yStatus" class="a11y-status" role="status" aria-live="polite"></p>
      </div>
      <footer class="a11y-dialog-footer"><button id="a11yReset" class="btn btn-secondary" type="button">Restaurar padrão</button><button id="a11yDone" class="btn btn-primary" type="button">Concluir</button></footer>`;
    document.body.append(dialog);
    updateControls();
    dialog.addEventListener('change',event => {
      const input=event.target;
      if(input.name==='a11yTheme')setPreferences({theme:input.value});
      if(input.id==='a11yTextSize')setPreferences({textSize:Number(input.value)});
      if(input.id==='a11yContrast')setPreferences({contrast:input.value});
      const setting={a11ySpacing:'spacing',a11yUnderline:'underlineLinks',a11yMotion:'reduceMotion',a11yNotices:'keepNotices'}[input.id];
      if(setting)setPreferences({[setting]:input.checked});
    });
    for(const id of ['a11yClose','a11yDone'])document.getElementById(id).addEventListener('click',()=>dialog.close());
    document.getElementById('a11yReset').addEventListener('click',()=>setPreferences(defaults));
    dialog.addEventListener('close',()=>{
      document.querySelectorAll('[data-a11y-open]').forEach(button => button.setAttribute('aria-expanded','false'));
      if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});
    });
    dialog.addEventListener('keydown',event=>{
      if(event.key!=='Tab')return;
      const controls=[...dialog.querySelectorAll('button,input,select,summary')].filter(item=>!item.disabled&&item.getClientRects().length);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&(document.activeElement===first||document.activeElement.id==='a11yTitle')){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    });
    document.addEventListener('click',event=>{
      if(event.target.closest('[data-a11y-open]'))open();
      else if(event.target.closest('[data-theme-toggle]'))setPreferences({theme:root.dataset.theme==='dark'?'light':'dark'});
    });
    // Legacy modules generate inline font sizes. Relative units let text grow
    // without changing record templates or scaling touch targets down.
    const adaptFonts = node => {
      if(!(node instanceof Element))return;
      const elements=[node,...node.querySelectorAll('[style]')];
      for(const element of elements){
        const size=element.style?.fontSize;
        if(size&&/^\d+(?:\.\d+)?px$/.test(size))element.style.fontSize=`${parseFloat(size)/16}rem`;
      }
    };
    adaptFonts(document.body);
    new MutationObserver(records=>{
      for(const record of records){
        if(record.type==='attributes')adaptFonts(record.target);
        else record.addedNodes.forEach(adaptFonts);
      }
    }).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['style']});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});
  else initialize();
})();
