import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteSessionStore} from '../../service/session-store.mjs';
import {SessionRegistry} from '../../service/session-registry.mjs';
import {DurableAgentExecutor} from '../../service/agent-executor.mjs';
import {AgentRpcError} from '../../service/agent-rpc.mjs';
export const actionKey='a'.repeat(64),tenantId='tenant-executor';
export const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
export async function until(test){const deadline=performance.now()+3000;for(;;){const value=await test();if(value)return value;assert.ok(performance.now()<deadline,'Executor fixture observation deadline');await new Promise(setImmediate);}}
export async function fixture(t,{storeOptions={},executorOptions={},beforeReady=null}={}){
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-executor-')),path=join(directory,'state.sqlite'),store=new SqliteSessionStore({path,...storeOptions}),calls=[],effects=[],hooks={},contexts=new Map();let executor,created,createCount=0,closeCount=0;
 const provider={
  create(){createCount++;return {version:'fixture-executor-v1'};},close(){closeCount++;return {status:'closed'};},
  async agent(request){
   const {command}=request;calls.push(request);const context=contexts.get(request.sessionId);if(hooks[command.op])return hooks[command.op](request,context);
   if(command.op==='begin'){const result={binding:{tenantId:request.tenantId,sessionId:request.sessionId,targetId:'target_'+randomUUID(),runId:'run_'+randomUUID()},fence:{controlSessionId:randomUUID(),controlVersion:0,pageEpoch:1,viewportVersion:1}};contexts.set(request.sessionId,result);return result;}
   if(!context||command.runId!==context.binding.runId)throw new AgentRpcError('AGENT_RUN_NOT_FOUND','not-dispatched');
   if(command.op==='context')return context;
   if(command.op==='end'){contexts.delete(request.sessionId);return {stage:'run-closed',binding:context.binding};}
   effects.push(command);return {stage:'input-injected',binding:context.binding,fence:command.context.fence,inputs:1};
  }
 };
 const registry=new SessionRegistry({store,providers:new Map([['test',provider]]),defaultRegion:'test'});
 const createSession=async(key='executor-fixture-session')=>{const operation=registry.create(tenantId,{url:'https://fixture.example/'},{idempotencyKey:key});await until(()=>registry.getOperation(tenantId,operation.operationId).status==='succeeded');return registry.requireReady(tenantId,operation.sessionId);};
 const ready=await createSession();beforeReady?.({store,registry,provider,ready});executor=new DurableAgentExecutor({store,registry,providers:new Map([['test',provider]]),actionKey,...executorOptions});
 const create=(idempotencyKey='executor-create-run')=>{created=executor.create({tenantId,sessionId:ready.sessionId,region:'test',version:ready.version,idempotencyKey});return created;};
 const runRef=(run=created)=>({tenantId,agentRunId:run.agentRunId});
 const active=async()=>{const run=create();await until(()=>executor.getRun(runRef(run)).state==='active'&&executor.status().ordinary===0);return {run,context:await executor.context(runRef(run))};};
 const perform=(run,context,key='executor-action',params={text:'fixture-text'})=>executor.perform({...runRef(run),idempotencyKey:key,tool:'insertText',params,context});
 const invocation=async row=>until(()=>{const result=executor.getInvocation({tenantId,invocationId:row.invocationId});return ['injected','unknown','rejected'].includes(result.state)&&executor.status().ordinary===0?result:null;});
 const cleanup=async()=>{await executor.shutdown({timeoutMs:100});await registry.shutdown();await executor.shutdown({timeoutMs:100});store.close();await rm(directory,{recursive:true,force:true});};t.after(cleanup);
 return {directory,path,store,provider,registry,executor,ready,calls,effects,hooks,contexts,createSession,create,active,perform,invocation,runRef,counts:()=>({createCount,closeCount}),replaceExecutor(value){executor=value;this.executor=value;}};
}
