import assert from 'node:assert/strict';
import {runtime} from './viewer-runtime-harness.mjs';
import {audience} from './viewer-access-harness.mjs';

// Explicit DOM, shadow-root, navigation and MutationObserver scheduler fixture.
// MessageChannel transfer, saved child entry points and the network are real.
export function dom(h,{workerMode=false,autoLoad=true,configFetch,realInput=false,drawError,initError}={}){
 const frames=[],runtimes=[],observers=new Set();let mutations=false;
 function target(){const listeners=new Map();return {addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},dispatchEvent(event){for(const fn of [...listeners.get(event.type)??[]])fn(event);},listenerCount(){return [...listeners.values()].reduce((n,set)=>n+set.size,0);}};}
 function changed(){if(mutations)return;mutations=true;queueMicrotask(()=>{mutations=false;for(const observer of [...observers])observer.callback();});}
 const owner={...target()};owner.MutationObserver=class {constructor(callback){this.callback=callback;}observe(){observers.add(this);}disconnect(){observers.delete(this);}};
 const document={defaultView:owner,createElement:tag=>new Element(tag)};
 function walk(node,fn){fn(node);for(const child of [...node.children,...node.shadow?.children??[]])walk(child,fn);}
 function retire(frame){if(!frame.runtime)return;frame.runtime.window.dispatchEvent({type:'pagehide',persisted:false});frame.runtime=null;}
 function navigate(frame){
  if(!frame.isConnected)return;retire(frame);
  const build='b'.repeat(64),r=runtime(workerMode,{publicMode:true,viewerBuild:build,parentWindow:owner,realInput,drawError,initError,configFetch:configFetch??(async()=>new Response(JSON.stringify({schema:'public-viewer-v1',gatewayOrigin:h.base,allowedParentOrigins:['https://host.example'],viewerBuild:build}),{headers:{'content-type':'application/json'}}))});
  runtimes.push(r);frame.runtime=r;frame.contentWindow=r.window;
  r.window.postMessage=(data,targetOrigin,ports)=>{assert.equal(targetOrigin,audience);const transferred=structuredClone({data,ports},{transfer:ports});queueMicrotask(()=>{if(frame.runtime===r)r.window.dispatchEvent({type:'message',...transferred,origin:'https://host.example',source:owner});else for(const port of transferred.ports)port.close();});};
  frame.dispatchEvent({type:'load'});
 }
 class Element {
  constructor(tag){Object.assign(this,target());this.tag=tag;this.ownerDocument=document;this.parentNode=null;this.children=[];this.attributes=new Map();this.style={};if(tag==='iframe')frames.push(this);}
  get isConnected(){return this===document.documentElement||this.parentNode?.isConnected===true;}
  attachShadow({mode}){assert.equal(mode,'closed');const root=new Element('shadow-root');root.parentNode=this;this.shadow=root;return root;}
  setAttribute(name,value){this.attributes.set(name,value);}
  getAttribute(name){return this.attributes.get(name)??null;}
  appendChild(child){if(child.parentNode&&child.parentNode!==this)child.remove();child.parentNode=this;this.children.push(child);if(this.isConnected&&autoLoad)walk(child,node=>{if(node.tag==='iframe'&&!node.runtime)queueMicrotask(()=>navigate(node));});changed();return child;}
  remove(){if(!this.parentNode)return;const list=this.parentNode.children,index=list.indexOf(this);if(index>=0)list.splice(index,1);this.parentNode=null;walk(this,node=>{if(node.tag==='iframe')retire(node);});changed();}
 }
 document.documentElement=new Element('html');const container=document.createElement('div');document.documentElement.appendChild(container);
 return {document,owner,container,frames,runtimes,observers,reload:frame=>navigate(frame),frame:()=>frames.findLast(frame=>frame.isConnected)};
}
