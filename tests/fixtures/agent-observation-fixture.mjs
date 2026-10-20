import {EventEmitter} from 'node:events';
import {ControlLease} from '../../live/input.mjs';
import {createManagedAgentRun} from '../../live/managed-agent-run.mjs';
export const sessionId='ses_00000000-0000-4000-8000-000000000001',version='chromium:fixture;wasm:'+'a'.repeat(64),uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
export const row=(handle='elh_'+uuid(8),patch={})=>({elementId:handle,tag:'button',id:'submit',role:'button',name:'Submit',text:'Submit',value:null,redacted:false,...patch});
export const body=(handles,patch={})=>({ok:true,revision:1,url:'https://fixture.test/',title:'Fixture',visited:1,truncated:false,nodes:[row(handles[0])],...patch});
export function observationFixture(t){
 const calls=[],gates=[],source=Object.assign(new EventEmitter(),{page:{isClosed:()=>false},pageEpoch:1,viewportVersion:1,viewport:{cssWidth:640,cssHeight:480},transitioning:false,latest:{}}),control=new ControlLease(source,{send:async()=>{},detach:async()=>{}});source.control=control;let permitted=true,readAllowed=true,writeAllowed=true,handler=null;
 source.capture={page:source.page,world:3,documentToken:'native-document',revision:1,stopped:false,transitioning:false,token:'c'.repeat(64),binding:{world:3,revision:1,config:{id:'b'.repeat(32),documentToken:'native-document',pageEpoch:1,viewportVersion:1}},cdp:{async send(method,params){calls.push({method,params});if(handler){const reply=await handler(method,params);if(reply!==undefined)return reply;}if(method==='Runtime.evaluate')return {result:{objectId:'owned-realm'}};if(method==='Runtime.callFunctionOn')return {result:{value:body(params.arguments[1].value)}};return {};}}};
 const subjects=[],run=createManagedAgentRun(control,{tenantId:'tenant',sessionId,version,authorize:s=>{subjects.push(s);return permitted&&(s.permission==='agent:observe'?readAllowed:writeAllowed);}});
 const hold=method=>{let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);gates.push(release);handler=async(m,p)=>{if(m===method){entered();await gate;}};return {started,release};};
 t.after(async()=>{gates.forEach(fn=>fn());await run.close();await control.close();});return {source,control,run,calls,subjects,hold,set permitted(v){permitted=v;},set readAllowed(v){readAllowed=v;},set writeAllowed(v){writeAllowed=v;},set handler(v){handler=v;}};
}
