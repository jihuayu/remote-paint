// Structural provider effects are files. This is not a browser/Native proof.
import {writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteSessionStore} from '../../service/session-store.mjs';
import {SessionRegistry} from '../../service/session-registry.mjs';
import {DurableAgentExecutor} from '../../service/agent-executor.mjs';
import {actionKey,tenantId,until} from './agent-executor-fixture.mjs';
const [path,directory,mode]=process.argv.slice(2);let executor,run,invocation,context,ready;
function stop(){process.send({event:mode,run,invocation,context,ready});process.kill(process.pid,'SIGSTOP');}
const provider={
 create({sessionId}){writeFileSync(join(directory,'resource'),sessionId,{flag:'wx',mode:0o600});return {version:'fixture-executor-v1'};},
 close(){try{unlinkSync(join(directory,'resource'));}catch(e){if(e.code!=='ENOENT')throw e;}return {status:'closed'};},
 agent({command,sessionId}){
  if(command.op==='begin'){if(mode==='begin'){stop();return new Promise(()=>{});}context={binding:{tenantId,sessionId,targetId:'target_'+randomUUID(),runId:'run_'+randomUUID()},fence:{controlSessionId:randomUUID(),controlVersion:0,pageEpoch:1,viewportVersion:1}};return context;}
  if(command.op==='context')return context;
  if(command.op==='end')return {stage:'run-closed',binding:context.binding};
  if(mode==='requested'){stop();return new Promise(()=>{});}writeFileSync(join(directory,'effect'),'one-fixture-effect\n',{flag:'wx',mode:0o600});if(mode==='effect'){stop();return new Promise(()=>{});}return {stage:'input-injected',binding:context.binding,fence:context.fence,inputs:1};
 }
};
const store=new SqliteSessionStore({path}),registry=new SessionRegistry({store,providers:new Map([['test',provider]]),defaultRegion:'test'}),created=registry.create(tenantId,{url:'https://fixture.example/'},{idempotencyKey:'crash-session'});await until(()=>registry.getOperation(tenantId,created.operationId).status==='succeeded');ready=registry.requireReady(tenantId,created.sessionId);executor=new DurableAgentExecutor({store,registry,providers:new Map([['test',provider]]),actionKey});run=executor.create({tenantId,sessionId:ready.sessionId,region:'test',version:ready.version,idempotencyKey:'crash-run'});if(mode==='intent')stop();await until(()=>executor.getRun({tenantId,agentRunId:run.agentRunId}).state==='active'&&executor.status().ordinary===0);context=await executor.context({tenantId,agentRunId:run.agentRunId});invocation=executor.perform({tenantId,agentRunId:run.agentRunId,idempotencyKey:'crash-action',tool:'insertText',params:{text:'fixture-effect'},context});if(mode==='invocation-intent')stop();if(mode==='receipt'){await until(()=>executor.getInvocation({tenantId,invocationId:invocation.invocationId}).state==='injected');stop();}setInterval(()=>{},1000);
