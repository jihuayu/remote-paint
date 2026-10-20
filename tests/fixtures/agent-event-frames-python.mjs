import {request} from 'node:http';
import {fixture,tenantId} from './agent-executor-fixture.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../../service/session-http.mjs';
const cleanup=[],f=await fixture({after:fn=>cleanup.push(fn)}),{run,context}=await f.active(),key='fixture_python_sse_frame_backend_key_0000000000';
await f.invocation(f.perform(run,context,'python-parser-wire-invocation'));
const server=createSessionControlServer({registry:f.registry,agentExecutor:f.executor,authenticate:createApiKeyAuthenticator([{apiKey:key,tenantId,scopes:['agents:read']}]),agentEventStream:{pollIntervalMs:10,heartbeatMs:50,maxDurationMs:100,writeTimeoutMs:50,maxEvents:64,maxBytes:262144}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 const result=await new Promise((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/v1/agent-runs/'+run.agentRunId+'/events/stream',headers:{authorization:'Bearer '+key},agent:false},res=>{
   const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>262144){req.destroy(Error('Owned producer exceeded body bound'));return;}chunks.push(chunk);});res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,requestId:res.headers['x-request-id'],bodyBase64:Buffer.concat(chunks).toString('base64')}));
  });req.on('error',reject);req.end();
 });
 process.stdout.write(JSON.stringify({agentRunId:run.agentRunId,sessionId:run.sessionId,...result})+'\n');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));for(const fn of cleanup.reverse())await fn();}
