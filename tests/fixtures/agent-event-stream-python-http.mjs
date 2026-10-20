import {createInterface} from 'node:readline';
import {fixture,deferred,tenantId} from './agent-executor-fixture.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../../service/session-http.mjs';
const cleanup=[],f=await fixture({after:fn=>cleanup.push(fn)}),{run,context}=await f.active(),keys={all:'fixture_python_stream_backend_key_0000000000',read:'fixture_python_stream_read_only_key_0000000',end:'fixture_python_stream_end_only_key_00000000'};
let revoked=false,server,port=0,requests=0,drops=0,drop=false,gate=null;
const auth=createApiKeyAuthenticator([{apiKey:keys.all,tenantId,scopes:['agents:read','agents:write','agents:end']},{apiKey:keys.read,tenantId,scopes:['agents:read']},{apiKey:keys.end,tenantId,scopes:['agents:end']}]);
async function start(){
 server=createSessionControlServer({registry:f.registry,agentExecutor:f.executor,authenticate:r=>revoked?null:auth(r),agentEventStream:{pollIntervalMs:10,heartbeatMs:50,maxDurationMs:100,writeTimeoutMs:50,maxEvents:2,maxBytes:262144}});
 server.on('request',(req,res)=>{if(req.url.includes('/events/stream')){requests++;if(drop){drop=false;let dropped=false;const write=res.write;res.write=function(chunk,...args){const result=write.call(this,chunk,...args);if(!dropped&&/^event: agent$/m.test(String(chunk))){dropped=true;drops++;setImmediate(()=>res.destroy());}return result;};}}});
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));port=server.address().port;
}
await start();const print=v=>process.stdout.write(JSON.stringify(v)+'\n');let index=0;
const perform=async()=>f.invocation(f.perform(run,context,'stream-fixture-'+index++));
const stats=()=>({requests,drops,effects:f.effects.length,run:f.executor.getRun(f.runRef(run)),work:f.executor.status()});
print({port,agentRunId:run.agentRunId,sessionId:run.sessionId,keys});
try{for await(const line of createInterface({input:process.stdin})){
 if(line==='close')break;
 if(line==='perform')print(await perform());
 else if(line==='burst'){for(let i=0;i<24;i++)await perform();print(stats());}
 else if(line==='revoke'){revoked=true;print(stats());}
 else if(line==='hold'){gate=deferred();f.hooks.context=()=>gate.promise;print(stats());}
 else if(line==='settle'){gate?.resolve(context);gate=null;print(stats());}
 else if(line==='drop'){drop=true;print(stats());}
 else if(line==='restart'){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await start();print(stats());}
 else if(line==='stats')print(stats());
 else throw Error('Unknown owned stream fixture command');
}}finally{gate?.resolve(context);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const fn of cleanup.reverse())await fn();}
