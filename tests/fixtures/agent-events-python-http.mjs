import {createInterface} from 'node:readline';
import {fixture,deferred,tenantId} from './agent-executor-fixture.mjs';
import {AgentRpcError} from '../../service/agent-rpc.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../../service/session-http.mjs';
const cleanup=[],f=await fixture({after:fn=>cleanup.push(fn)}),{run,context}=await f.active();
const keys={all:'fixture_python_events_backend_key_0000000000',read:'fixture_python_events_readonly_key_000000000',end:'fixture_python_events_end_only_key_000000000',other:'fixture_python_events_other_tenant_key_000000'};
const server=createSessionControlServer({registry:f.registry,agentExecutor:f.executor,authenticate:createApiKeyAuthenticator([{apiKey:keys.all,tenantId,scopes:['agents:read','agents:write','agents:end']},{apiKey:keys.read,tenantId,scopes:['agents:read']},{apiKey:keys.end,tenantId,scopes:['agents:end']},{apiKey:keys.other,tenantId:'tenant-other',scopes:['agents:read','agents:end']}])});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const print=value=>process.stdout.write(JSON.stringify(value)+'\n');let index=0,gate=null,pending=null;
const perform=async()=>f.invocation(f.perform(run,context,'python-event-'+index++));
const stats=()=>({effects:f.effects.length,run:f.executor.getRun(f.runRef(run)),work:f.executor.status()});
print({port:server.address().port,agentRunId:run.agentRunId,sessionId:run.sessionId,keys});
try{
 for await(const line of createInterface({input:process.stdin})){
  if(line==='close')break;
  if(line==='perform')print(await perform());
  else if(line==='burst'){for(let i=0;i<24;i++)await perform();print(stats());}
  else if(line==='unknown'){f.hooks.perform=()=>{throw new AgentRpcError('AGENT_RPC_TIMEOUT','unknown');};try{print(await perform());}finally{delete f.hooks.perform;}}
  else if(line==='pending'){gate=deferred();const entered=deferred();f.hooks.context=()=>{entered.resolve();return gate.promise;};pending=f.executor.context(f.runRef(run)).catch(e=>e);await entered.promise;print(stats());}
  else if(line==='settle'){gate?.resolve(context);if(pending)await pending;pending=null;gate=null;print(stats());}
  else if(line==='stats')print(stats());
  else throw Error('Unknown owned event fixture command');
 }
}finally{
 gate?.resolve(context);if(pending)await pending;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const fn of cleanup.reverse())await fn();
}
