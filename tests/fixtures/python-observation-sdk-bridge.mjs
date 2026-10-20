// Test-only adapter to exercise a separate installed Python SDK process.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export async function pythonObservationBridge({python,script,base,keys}){
 const env={...process.env,PYTHONDONTWRITEBYTECODE:'1'};for(const key of ['PYTHONPATH','PYTHONHOME','MYPYPATH'])delete env[key];
 const child=spawn(python,[script],{env,stdio:['pipe','pipe','pipe']}),pending=new Map();let counter=0,stderr='',closed=false,actualExit=null;
 const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{actualExit={code,signal};for(const item of pending.values())item.reject(Error('Python SDK driver exited'));pending.clear();code===0?resolve(actualExit):reject(Error('Python SDK driver failed: '+stderr));});});completion.catch(()=>{});
 child.stderr.on('data',bytes=>{assert.ok(stderr.length+bytes.length<=8192);stderr+=bytes.toString();});
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{assert.ok(line.length<=131072);const row=JSON.parse(line),item=pending.get(row.id);assert.ok(item);pending.delete(row.id);item.cleanup?.();if(row.error){const error=Object.assign(Error('Installed Python Agent SDK request failed'),row.error);item.reject(error);}else item.resolve(freeze(row.value));});
 const rpc=(op,role,args={},signal)=>new Promise((resolve,reject)=>{const id=++counter,abort=()=>{void rpc('cancel',role,{target:id}).catch(()=>{});};pending.set(id,{resolve,reject,cleanup:()=>signal?.removeEventListener('abort',abort)});child.stdin.write(JSON.stringify({id,op,role,args,...(op==='init'?{base,keys}:{})})+'\n',error=>{if(error){pending.delete(id);signal?.removeEventListener('abort',abort);reject(error);}});signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
 let origin;try{origin=await rpc('init');}catch(error){child.kill('SIGTERM');await completion.catch(()=>{});throw error;}
 return {pid:child.pid,origin,agent:role=>Object.freeze({
  runs:Object.freeze({create:(sessionId,input,{idempotencyKey})=>rpc('run-create',role,{sessionId,input,key:idempotencyKey}),get:id=>rpc('run-get',role,{id}),context:run=>rpc('context',role,{run}),end:id=>rpc('end',role,{id})}),
  invocations:Object.freeze({create:(context,action,{idempotencyKey})=>rpc('invocation-create',role,{context,action,key:idempotencyKey}),get:id=>rpc('invocation-get',role,{id})}),
  observations:Object.freeze({context:run=>rpc('observation-context',role,{run}),read:(context,input,{signal}={})=>rpc('observe',role,{context,input},signal)}),
  transportStatus:()=>rpc('status',role)

 }),close:async()=>{if(!closed){closed=true;await rpc('close');child.stdin.end();}await completion;assert.deepEqual(actualExit,{code:0,signal:null});return actualExit;}};
}
