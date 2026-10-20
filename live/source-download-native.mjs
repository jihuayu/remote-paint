// Trusted Source-only mode registration. A closed/unbound Native Page remains
// registered so no observer can silently select the legacy Download path.
import {AgentInputError} from './input.mjs';
import {createNativeAgentDownloadOwner} from './agent-download-native.mjs';
const roots=new WeakMap();
const fail=code=>{throw new AgentInputError(code,'not-dispatched');};
const token=value=>typeof value==='string'&&value.length>=32&&value.length<=256;

export function createSourceNativeDownloadRoot(page){
 if(!page||typeof page.on!=='function'||typeof page.off!=='function'||roots.has(page))fail('AGENT_OBSERVATION_UNAVAILABLE');
 const state={page,bound:null,owner:null,closed:false,closing:null,cleanupFailed:false};roots.set(page,state);
 return Object.freeze({
  bindCapture(capture){
   if(state.closed||state.bound||capture?.page!==page||typeof capture?.cdp?.send!=='function'||!token(capture.token)||capture.stopped)fail('AGENT_OBSERVATION_UNAVAILABLE');
   const transport=capture.cdp,method=transport.send;
   state.bound=Object.freeze({capture,transport,method,send:method.bind(transport),token:capture.token});
  },
  close(){
   if(state.closing)return state.closing;state.closed=true;
   state.closing=Promise.resolve().then(()=>state.owner?.closeObserver()).then(()=>{state.bound=null;},error=>{state.cleanupFailed=true;throw error;});
   return state.closing;
  },
  status:()=>Object.freeze({closed:state.closed,bound:state.bound!==null,owners:state.owner?1:0,cleanupFailed:state.cleanupFailed})
 });
}

// null means this original Page was never registered in Native mode. Every
// other failure throws, including before bindCapture and after Source close.
export function createSourceNativeAgentDownloadOwner({page,capture,transport,binding,version,closeObserver}){
 const state=roots.get(page);if(!state)return null;
 function bound(){
  const b=state.bound;
  if(state.closed)fail('AGENT_RUN_CLOSED');
  if(!b||b.capture!==capture||b.transport!==transport||capture.page!==page||capture.cdp!==transport||transport.send!==b.method||capture.token!==b.token||capture.stopped)fail('AGENT_OBSERVATION_UNAVAILABLE');
  return b;
 }
 const original=bound();if(state.owner)fail('AGENT_DOWNLOAD_BUSY');if(typeof closeObserver!=='function')fail('AGENT_OBSERVATION_UNAVAILABLE');
 const native=createNativeAgentDownloadOwner({page,binding,version,send:original.send,token:original.token});
 const slot={native,facade:null,closing:null,nativeClosed:false,closeObserver};
 function guard(expected,check){
  const b=bound();
  if(!expected||expected.capture!==capture||expected.cdp!==transport||expected.token!==b.token||expected.documentToken!==capture.documentToken||typeof expected.documentToken!=='string'||expected.documentToken.length<1||expected.documentToken.length>64)fail('STALE_AGENT_PAGE');
  check();bound();
  if(expected.documentToken!==capture.documentToken)fail('STALE_AGENT_PAGE');
 }
 slot.facade=Object.freeze({
  arm(context,request,check,expected){
   if(typeof check!=='function')fail('AGENT_INVALID_CONTEXT');guard(expected,check);
   return native.arm(context,request,()=>guard(expected,check),expected.documentToken);
  },
  info:(...args)=>native.info(...args),read:(...args)=>native.read(...args),release:(...args)=>native.release(...args),
  close(){
   if(slot.closing)return slot.closing;
   slot.closing=native.close().then(()=>{slot.nativeClosed=true;},error=>{state.cleanupFailed=true;throw error;});return slot.closing;
  },
  observerClosed(){if(!slot.nativeClosed)fail('AGENT_OBSERVATION_FAILED');if(state.owner===slot)state.owner=null;},
  observerFailed(){state.cleanupFailed=true;},
  status:()=>native.status()
 });
 state.owner=slot;return slot.facade;
}
