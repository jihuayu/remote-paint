// Serialized into the source page. Inspect eligibility before reading value.
// Annotations grant display feedback only; they confer no input authority.
export function readPublicEditor({namespace,event}){
 const element=document.activeElement;
 if(!(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement||element?.isContentEditable))return null;
 if(element.childNodes.length>64)return null;
 if(element.isContentEditable&&[...element.childNodes].some(node=>node.nodeType!==Node.TEXT_NODE))return null;
 if(element.closest('[data-remote-paint-sensitive]')||element.querySelector('[data-remote-paint-sensitive],input[type="password"]'))return null;
 if(element.closest('[data-remote-paint-preview]')?.getAttribute('data-remote-paint-preview')!=='plain-text')return null;
 if(element instanceof HTMLInputElement&&!['text','search'].includes(element.type)||element.disabled||element.readOnly)return null;
 const autocomplete=(element.getAttribute('autocomplete')??'').toLowerCase().split(/\s+/);
 if(autocomplete.some(token=>token&&!['on','off'].includes(token)))return null;
 const names=[element.id,element.getAttribute('name'),element.getAttribute('aria-label')].filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]+/g,' ').toLowerCase();
 if(/password|passcode|secret|credit.?card|card.?number|security.?code|verification.?code|api.?key|access.?key|private.?key|bank.?account|routing.?number|\b(token|otp|pin|cvv|cvc|ssn|iban)\b|密码|验证码|信用卡|安全码|密钥|令牌|身份证/.test(names))return null;
 let ancestor=element,depth=0;
 while(ancestor){
  if(++depth>64)return null;const style=getComputedStyle(ancestor);
  if(style.visibility!=='visible'||Number(style.opacity)!==1||style.filter!=='none'||style.webkitTextSecurity&&style.webkitTextSecurity!=='none')return null;
  if(style.transform!=='none'){const matrix=new DOMMatrixReadOnly(style.transform);if(!matrix.is2D||matrix.a!==1||matrix.b!==0||matrix.c!==0||matrix.d!==1)return null;}
  ancestor=ancestor.parentElement;
 }
 const rect=element.getBoundingClientRect();if(rect.width<=0||rect.height<=0)return null;
 const text=element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement?element.value:element.innerText;
 if(typeof text!=='string'||text.length>8192)return null;
 let selectionStart=typeof element.selectionStart==='number'?element.selectionStart:text.length,selectionEnd=typeof element.selectionEnd==='number'?element.selectionEnd:selectionStart;
 if(element.isContentEditable){
  if([...element.childNodes].some(node=>node.nodeType!==Node.TEXT_NODE)||element.textContent!==text)return null;
  const selection=getSelection();if(!selection?.rangeCount||!element.contains(selection.anchorNode)||!element.contains(selection.focusNode))return null;
  const offset=(node,at)=>{const range=document.createRange();range.selectNodeContents(element);range.setEnd(node,at);return range.toString().length;};
  const anchor=offset(selection.anchorNode,selection.anchorOffset),focus=offset(selection.focusNode,selection.focusOffset);selectionStart=Math.min(anchor,focus);selectionEnd=Math.max(anchor,focus);
 }
 const key=Symbol.for(`remote-paint-feedback:${namespace}`);let store=globalThis[key];if(!store){store={editors:new WeakMap(),next:0};Object.defineProperty(globalThis,key,{value:store,configurable:true});}
 if(!store.editors.has(element))store.editors.set(element,++store.next);
 const style=getComputedStyle(element),publicStyle=Object.fromEntries(['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','color','backgroundColor','border','borderRadius','padding','textAlign','whiteSpace','overflowWrap','wordBreak','direction'].filter(key=>typeof style[key]==='string'&&style[key].length<=256).map(key=>[key,style[key]]));
 let composition=null;
 if(event.kind==='composition'&&event.phase==='start')composition={start:selectionStart,end:selectionEnd};
 else if(event.kind==='composition'&&event.phase==='update'){
  const start=Math.max(0,selectionStart-(event.selectionStart??event.textLength));composition={start,end:start+event.textLength};
 }
 if(composition&&composition.end>text.length)composition=null;
 return {preview:'plain-text',editorId:`${namespace}:${store.editors.get(element)}`,kind:element instanceof HTMLTextAreaElement?'textarea':element instanceof HTMLInputElement?'input':'contenteditable',x:rect.x,y:rect.y,width:rect.width,height:rect.height,text,selectionStart,selectionEnd,composition,scrollLeft:element.scrollLeft,scrollTop:element.scrollTop,
  style:publicStyle};
}

export function readPointerFeedback({x,y}){
 const element=document.elementFromPoint(x,y);if(!element)return null;
 const target=element.closest('button,a[href],input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"],[role="button"]')??element,style=getComputedStyle(element);
 let cursor=style.cursor.split(',').at(-1).trim();
 if(cursor==='auto')cursor=target.matches('textarea,[contenteditable]')||target instanceof HTMLInputElement&&['text','search','email','url','tel','password','number'].includes(target.type)?'text':target.matches('a[href]')?'pointer':'default';
 const allowed=new Set(['default','pointer','text','vertical-text','crosshair','move','wait','progress','help','not-allowed','no-drop','grab','grabbing','copy','alias','cell','context-menu','all-scroll','col-resize','row-resize','n-resize','s-resize','e-resize','w-resize','ne-resize','nw-resize','se-resize','sw-resize','ew-resize','ns-resize','nesw-resize','nwse-resize','zoom-in','zoom-out']);
 if(!allowed.has(cursor))cursor='default';const rect=target.getBoundingClientRect(),interactive=target.matches('button,a[href],input,textarea,select,[contenteditable],[role="button"]');
 return {x,y,cursor,hover:interactive&&rect.width>0&&rect.height>0?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null};
}
