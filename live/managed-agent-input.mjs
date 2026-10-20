import {ControlLease,InputError,AgentInputError,captureAgentFence} from './input.mjs';
export {AgentInputError} from './input.mjs';
const methods=new Set(['Input.insertText','Input.dispatchKeyEvent','Input.dispatchMouseEvent','Input.imeSetComposition']);
const fail=code=>{throw new AgentInputError(code,'not-dispatched');};
function data(value,allowed,required=allowed){
 try{
  if(!value||typeof value!=='object'||Array.isArray(value))fail('AGENT_INVALID_REQUEST');const prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value),descriptors=Object.getOwnPropertyDescriptors(value);
  if(prototype!==null&&prototype!==Object.prototype||keys.length>allowed.length||keys.some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(descriptors,key))||keys.some(key=>!Object.hasOwn(descriptors[key],'value')))fail('AGENT_INVALID_REQUEST');
  return Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
 }catch{fail('AGENT_INVALID_REQUEST');}
}
function parameters(value,allowed,required){
 const captured=data(value,allowed,required);
 for(const item of Object.values(captured))if(typeof item==='string'?item.length>8192:typeof item!=='number'||!Number.isFinite(item))fail('AGENT_INVALID_REQUEST');
 return captured;
}
function event(method,params){
 let value;
 if(method==='Input.insertText')value={kind:'text',...parameters(params,['text'])};
 else if(method==='Input.dispatchKeyEvent')value={kind:'key',...parameters(params,['type','key','code','modifiers','text','windowsVirtualKeyCode','nativeVirtualKeyCode'],['type','key','code'])};
 else if(method==='Input.imeSetComposition')value={kind:'composition',phase:'update',...parameters(params,['text','selectionStart','selectionEnd'])};
 else{
  // Capture caller data once before branching, never a caller getter.
  const initial=data(params,['type','x','y','button','buttons','clickCount','deltaX','deltaY','modifiers'],['type','x','y']);
  value=initial.type==='mouseWheel'?{kind:'wheel',...parameters(initial,['type','x','y','deltaX','deltaY','modifiers'],['type','x','y','deltaX','deltaY'])}:{kind:'mouse',...parameters(initial,['type','x','y','button','buttons','clickCount','modifiers'],['type','x','y','button','buttons','clickCount'])};
 }
 return Object.freeze(value);
}
function failure(error,submitted=false){
 if(error instanceof AgentInputError)return error;
 return new AgentInputError(!submitted&&error instanceof InputError?error.code:'AGENT_INPUT_FAILED',submitted?'unknown':'not-dispatched');
}
// Trusted Source-side factory. This is a small CDP input subset, not a raw CDP
// session, Playwright Page, authorization service or JavaScript sandbox.
export function createManagedAgentInput(control){
 if(!(control instanceof ControlLease))throw new TypeError('Configure an owned ControlLease');
 const capture=ControlLease.prototype.agentFence.bind(control),inject=ControlLease.prototype.agent.bind(control);
 return Object.freeze({
  fence(){try{return capture();}catch(error){throw failure(error);}},
  send(method,params,options){
   let submitted=false;
   try{
    if(control.closed||control.source.closed===true)throw new AgentInputError('SESSION_CLOSED','not-dispatched');
    if(typeof method!=='string'||!methods.has(method))fail('AGENT_METHOD_FORBIDDEN');
    const fence=captureAgentFence(data(options,['fence']).fence),current=capture();
    if(Object.keys(current).some(key=>current[key]!==fence[key]))throw new AgentInputError('STALE_AGENT_FENCE','not-dispatched');
    const captured=event(method,params);submitted=true;const work=inject(captured,{fence});
    return Promise.resolve(work).then(()=>Object.freeze({stage:'input-injected',fence}),error=>{throw failure(error,true);});
   }catch(error){return Promise.reject(failure(error,submitted));}
  }
 });
}
