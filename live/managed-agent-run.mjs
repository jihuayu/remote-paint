import {randomUUID} from 'node:crypto';
import {ControlLease,InputError,AgentInputError,captureAgentFence,validateInput} from './input.mjs';
const owners=new WeakMap();
export const MANAGED_AGENT_TOOLS=Object.freeze(['move','click','drag','scroll','press','insertText','composition']);
const bindingKeys=['tenantId','sessionId','targetId','runId'];
const fail=code=>{throw new AgentInputError(code,'not-dispatched');};
function data(value,allowed,required=allowed,code='AGENT_INVALID_REQUEST'){
 try{
  if(!value||typeof value!=='object'||Array.isArray(value))fail(code);
  const prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value),descriptors=Object.getOwnPropertyDescriptors(value);
  if(prototype!==null&&prototype!==Object.prototype||keys.length>allowed.length||keys.some(key=>!allowed.includes(key))||required.some(key=>!Object.hasOwn(descriptors,key))||keys.some(key=>!Object.hasOwn(descriptors[key],'value')))fail(code);
  return Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
 }catch{fail(code);}
}
function action(tool,params){
 if(!MANAGED_AGENT_TOOLS.includes(tool))fail('AGENT_ACTION_FORBIDDEN');
 const fields={move:[['x','y','modifiers'],['x','y']],click:[['x','y','button','modifiers'],['x','y']],drag:[['fromX','fromY','toX','toY','steps','button','modifiers'],['fromX','fromY','toX','toY']],scroll:[['x','y','deltaX','deltaY','modifiers'],['x','y','deltaX','deltaY']],press:[['key','code','text','modifiers','windowsVirtualKeyCode','nativeVirtualKeyCode'],['key','code']],insertText:[['text'],['text']],composition:[['text','selectionStart','selectionEnd'],['text','selectionStart','selectionEnd']]}[tool];
 const value=data(params,...fields);
 for(const item of Object.values(value))if(typeof item==='string'?item.length>8192:typeof item!=='number'||!Number.isFinite(item))fail('AGENT_INVALID_REQUEST');
 return Object.freeze({tool,params:Object.freeze(value)});
}
function events({tool,params:p}){
 const pointer=(type,x,y,button='none',buttons=0)=>({kind:'mouse',type,x,y,button,buttons,clickCount:type==='mouseMoved'?0:1,modifiers:p.modifiers??0});
 if(tool==='insertText')return [{kind:'text',text:p.text}];
 if(tool==='composition')return [{kind:'composition',phase:'update',...p}];
 if(tool==='press')return [{kind:'key',type:'keyDown',...p},{kind:'key',type:'keyUp',...p,text:undefined}];
 if(tool==='scroll')return [{kind:'wheel',...p}];
 if(tool==='move')return [pointer('mouseMoved',p.x,p.y)];
 const button=p.button??'left',bits={left:1,middle:4,right:2}[button];if(!bits)fail('AGENT_INVALID_REQUEST');
 if(tool==='click')return [pointer('mouseMoved',p.x,p.y),pointer('mousePressed',p.x,p.y,button,bits),pointer('mouseReleased',p.x,p.y,button)];
 const steps=p.steps??4;if(!Number.isInteger(steps)||steps<1||steps>16)fail('AGENT_INVALID_REQUEST');
 return [pointer('mouseMoved',p.fromX,p.fromY),pointer('mousePressed',p.fromX,p.fromY,button,bits),...Array.from({length:steps},(_,i)=>pointer('mouseMoved',p.fromX+(p.toX-p.fromX)*(i+1)/steps,p.fromY+(p.toY-p.fromY)*(i+1)/steps,button,bits)),pointer('mouseReleased',p.toX,p.toY,button)];
}
function failure(error,submitted=false){return error instanceof AgentInputError?error:new AgentInputError(!submitted&&error instanceof InputError?error.code:'AGENT_INPUT_FAILED',submitted?'unknown':'not-dispatched');}
// Local trusted integration point. The authorizer must consult independently
// trusted state; this callback contract does not implement remote authentication.
export function createManagedAgentRun(control,configuration){
 if(!(control instanceof ControlLease))throw new TypeError('Configure an owned ControlLease');
 const config=data(configuration,['tenantId','sessionId','authorize']);
 if(typeof config.tenantId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(config.tenantId)||typeof config.sessionId!=='string'||!/^ses_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(config.sessionId)||typeof config.authorize!=='function')throw new TypeError('Configure a tenant, management Session and trusted synchronous authorizer');
 const source=control.source,page=source.page;
 const targetMatches=ControlLease.prototype.agentTargetMatches.bind(control);
 if(!page||typeof page.isClosed!=='function'||source.control!==control||!targetMatches(page))throw new TypeError('Configure the owned controlled Page');
 if(owners.has(control))fail('AGENT_RUN_BUSY');
 const binding=Object.freeze({tenantId:config.tenantId,sessionId:config.sessionId,targetId:control.targetId,runId:'run_'+randomUUID()}),owner={},capture=ControlLease.prototype.agentFence.bind(control),batch=ControlLease.prototype.agentBatch.bind(control),revoke=ControlLease.prototype.revoke.bind(control),fenceQueue=ControlLease.prototype.fence.bind(control);
 let closed=false,closing=null;owners.set(control,owner);
 function live(){if(closed)fail('AGENT_RUN_CLOSED');if(owners.get(control)!==owner||control.source!==source||source.control!==control||!targetMatches(page)||page.isClosed())fail('AGENT_TARGET_CHANGED');}
 function allowed(action=null){
  live();let result;
  try{result=config.authorize(Object.freeze({binding,permission:'agent:write',action}));}catch{fail('AGENT_NOT_AUTHORIZED');}
  if(result!==true){if(result instanceof Promise)void result.catch(()=>{});fail('AGENT_NOT_AUTHORIZED');}
  live();return true;
 }
 try{capture();allowed();capture();}catch(error){owners.delete(control);throw failure(error);}
 return Object.freeze({
  context(){try{allowed();return Object.freeze({binding,fence:capture()});}catch(error){throw failure(error);}},
  perform(tool,params,context){
   let submitted=false;
   try{
    allowed();const request=data(context,['binding','fence'],undefined,'AGENT_INVALID_CONTEXT'),supplied=data(request.binding,bindingKeys,undefined,'AGENT_INVALID_CONTEXT');
    if(bindingKeys.some(key=>supplied[key]!==binding[key]))fail('AGENT_INVALID_CONTEXT');
    const fence=captureAgentFence(request.fence),current=capture();if(Object.keys(current).some(key=>current[key]!==fence[key]))fail('STALE_AGENT_FENCE');
    const captured=action(tool,params),sequence=events(captured);for(const event of sequence)validateInput(event,source.viewport);allowed(captured);submitted=true;
    return Promise.resolve(batch(sequence,{fence},()=>allowed(captured))).then(()=>Object.freeze({stage:'input-injected',binding,fence,inputs:sequence.length}),error=>{throw failure(error,true);});
   }catch(error){return Promise.reject(failure(error,submitted));}
  },
  close(){
   if(closing)return closing;closed=true;
   // Revoke synchronously before awaiting active work. Keep ownership until
   // the shared queue and held-input cleanup fence have actually settled.
   const revoked=revoke('agent-run-closed'),idle=fenceQueue(()=>{});
   closing=Promise.all([revoked,idle]).then(()=>{if(owners.get(control)===owner)owners.delete(control);return Object.freeze({stage:'run-closed',binding});},error=>{throw failure(error,true);});
   return closing;
  }
 });
}
