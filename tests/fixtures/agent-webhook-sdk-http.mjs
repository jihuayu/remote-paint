import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,tenantId} from './agent-executor-fixture.mjs';
import {authConfig,cert,endpointId} from './agent-webhook-https.mjs';
import {createAgentWebhookReceiver} from '../../service/agent-webhook-receiver.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../../service/session-http.mjs';
export const key='fixture_sdk_webhook_backend_key_000000000000';
export const readKey='fixture_sdk_webhook_read_key_000000000000000';
export const otherKey='fixture_sdk_webhook_other_key_00000000000000';
export async function webhookSdkFixture(t){
 const f=await fixture(t,{storeOptions:{enableAgentWebhooks:true}}),privateKey=readFileSync(new URL('./webhook-localhost-key.pem',import.meta.url));
 const receiver=createAgentWebhookReceiver({directory:join(f.directory,'receiver'),tenantId,...authConfig,key:privateKey,cert}),address=await receiver.listen();t.after(()=>receiver.close());
 const worker=f.executor.registerWebhookEndpoint({tenantId,...authConfig,url:'https://127.0.0.1:'+address.port+address.path,ca:cert,pollIntervalMs:10,retryBaseMs:10,timeoutMs:2000});
 const server=createSessionControlServer({registry:f.registry,agentExecutor:f.executor,authenticate:createApiKeyAuthenticator([
  {apiKey:key,tenantId,scopes:['agents:read','agents:end','agents:webhooks:read','agents:webhooks:write']},
  {apiKey:readKey,tenantId,scopes:['agents:webhooks:read']},
  {apiKey:otherKey,tenantId:'tenant-other',scopes:['agents:webhooks:read','agents:webhooks:write']}
 ])});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const {run,context}=await f.active();
 return {...f,run,context,receiver,worker,endpointId,key,readKey,otherKey,baseUrl:'http://127.0.0.1:'+server.address().port};
}
