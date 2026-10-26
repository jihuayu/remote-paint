import {createInterface} from 'node:readline';
import {webhookSdkFixture} from './agent-webhook-sdk-http.mjs';
const cleanup=[],h=await webhookSdkFixture({after:fn=>cleanup.push(fn)});
const print=value=>process.stdout.write(JSON.stringify(value)+'\n');let index=0;
print({baseUrl:h.baseUrl,agentRunId:h.run.agentRunId,sessionId:h.run.sessionId,endpointId:h.endpointId,keys:{all:h.key,read:h.readKey,other:h.otherKey}});
try{
 for await(const line of createInterface({input:process.stdin})){
  if(line==='close')break;
  if(line==='perform')print(await h.invocation(h.perform(h.run,h.context,'python-webhook-'+index++)));
  else if(line==='inbox'){const first=h.receiver.read(),second=h.receiver.read({after:first.nextCursor});print({events:[...first.events,...second.events],effects:h.effects.length,subscriptions:h.worker.list().subscriptions.length});}
  else throw Error('Unknown owned Webhook fixture command');
 }
}finally{for(const fn of cleanup.reverse())await fn();}
