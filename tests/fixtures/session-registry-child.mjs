import {appendFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {SessionRegistry} from '../../service/session-registry.mjs';
import {SqliteSessionStore} from '../../service/session-store.mjs';
const [path,resources,mode]=process.argv.slice(2);let released;
const provider={
 create(args){
  appendFileSync(join(resources,'allocations.log'),args.sessionId+'\n');writeFileSync(join(resources,args.sessionId),'fixture resource',{mode:0o600});
  if(mode==='creating'){process.send({event:'creating',sessionId:args.sessionId});return new Promise(()=>{});}
  return {version:'fixture-v1'};
 },
 close(args){
  if(mode==='closing'){process.send({event:'closing',sessionId:args.sessionId,operationId:released.operationId});return new Promise(()=>{});}
  try{unlinkSync(join(resources,args.sessionId));}catch(error){if(error.code!=='ENOENT')throw error;}return {status:'closed'};
 }
};
const store=new SqliteSessionStore({path}),registry=new SessionRegistry({providers:new Map([['test',provider]]),defaultRegion:'test',store}),created=registry.create('tenant-a',{url:'https://example.test/'},{idempotencyKey:'key'});
if(mode==='ready')setImmediate(()=>{if(registry.getOperation('tenant-a',created.operationId).status!=='succeeded')throw new Error('Fixture failed to reach committed ready');process.send({event:'ready',sessionId:created.sessionId,operationId:created.operationId});});
else if(mode==='closing')setImmediate(()=>{released=registry.release('tenant-a',created.sessionId);});
else if(mode!=='creating')throw new Error('Unknown restart fixture mode');
setInterval(()=>{},1000);
