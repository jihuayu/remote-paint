import {createInterface} from 'node:readline';
import {fixture} from './agent-executor-fixture.mjs';
import {AgentRpcError} from '../../service/agent-rpc.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../../service/session-http.mjs';
const cleanup=[],f=await fixture({after:fn=>cleanup.push(fn)}),key='fixture_python_agent_backend_key_0000000000',read='fixture_python_agent_readonly_key_00000000';
const server=createSessionControlServer({registry:f.registry,agentExecutor:f.executor,authenticate:createApiKeyAuthenticator([{apiKey:key,tenantId:'tenant-executor',scopes:['agents:read','agents:write','agents:end']},{apiKey:read,tenantId:'tenant-executor',scopes:['agents:read']}])});let drop=false;
server.on('request',(_req,res)=>{if(drop){drop=false;res.end=()=>{res.socket?.destroy();return res;};}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const print=value=>process.stdout.write(JSON.stringify(value)+'\n');print({port:server.address().port,sessionId:f.ready.sessionId,version:f.ready.version});
for await(const line of createInterface({input:process.stdin})){if(line==='stats')print({effects:f.effects.length,performCalls:f.calls.filter(r=>r.command.op==='perform').length});else if(line==='drop'){drop=true;print({drop:true});}else if(line==='unknown'){f.hooks.perform=()=>{throw new AgentRpcError('AGENT_RPC_TIMEOUT','unknown');};print({unknown:true});}else if(line==='close')break;else throw Error('Unknown fixture command');}
server.closeAllConnections();await new Promise(r=>server.close(r));for(const fn of cleanup.reverse())await fn();
