// Actual Native owning controller. Parent receives identities and booleans only;
// private owner/transport credentials remain in this process's memory.
import assert from 'node:assert/strict';
import {readFile,open} from 'node:fs/promises';
import {join} from 'node:path';
import {SqliteSessionStore} from '../../service/session-store.mjs';
import {DockerMetadataClient} from '../../service/docker-metadata-client.mjs';
import {DockerEffectClient} from '../../service/docker-effect-session.mjs';
import {DockerAttachClient} from '../../service/docker-attach-client.mjs';
import {DockerSessionProvider} from '../../service/docker-session-provider.mjs';
import {RuntimeDeploymentBindingStore} from '../../service/runtime-deployment-binding.mjs';
import {RuntimeWitnessStore} from '../../service/runtime-witness-store.mjs';
import {RuntimeRetirementStore} from '../../service/runtime-retirement-store.mjs';
import {SessionRegistry} from '../../service/session-registry.mjs';
const [directory,manifestPath]=process.argv.slice(2),m=JSON.parse(await readFile(manifestPath,'utf8')),configuration=JSON.parse(await readFile(join(directory,'configuration.json'),'utf8')),store=new SqliteSessionStore({path:join(directory,'journal.sqlite')}),metadata=new DockerMetadataClient({socketPath:m.socketPath,daemonId:m.daemonId}),effects=new DockerEffectClient({socketPath:m.socketPath,daemonId:m.daemonId}),attach=new DockerAttachClient({socketPath:m.socketPath,daemonId:m.daemonId,maxConcurrent:2}),witnessStore=new RuntimeWitnessStore({directory:join(directory,'namespace')}),retirementStore=new RuntimeRetirementStore({directory:join(directory,'retirement'),witnessStore}),events=[];
let registry;
const provider=new DockerSessionProvider({store,configuration,deploymentBinding:new RuntimeDeploymentBindingStore({directory:join(directory,'binding')}),metadata,effects,attach,witnessStore,retirementStore,projectManifest:m.runtimeProjectManifest,browserManifest:m.runtimeBrowserManifest,onEvent:e=>events.push(e)});
try{
 await provider.initialize();registry=new SessionRegistry({providers:new Map([[configuration.region,provider]]),defaultRegion:configuration.region,store,globalQuota:2,tenantQuota:2});const tenantId='native-cold-recovery-fixture',created=registry.create(tenantId,{url:'about:blank',ttlSeconds:120},{idempotencyKey:'writer-death'});let completed;
 const end=performance.now()+60000;while(performance.now()<end){completed=registry.getOperation(tenantId,created.operationId);if(completed.status!=='pending')break;await new Promise(r=>setTimeout(r,10));}assert.equal(completed.status,'succeeded');const ready=registry.requireReady(tenantId,created.sessionId);assert.match(ready.version,/^chromium:155\..+;wasm:[a-f0-9]{64}$/);let target=await provider.resolveSource({tenantId,sessionId:ready.sessionId,region:ready.region,version:ready.version});assert.equal(Object.keys(target).length,7);target=null;
 const marker={at:new Date().toISOString(),pid:process.pid,identity:store.identity(),created,ready,containerId:events.find(e=>e.type==='created').containerId,proxyPid:events.find(e=>e.type==='attached').proxyPid,events,registry:registry.stats(),privateEndpointResolved:true};const fd=await open(join(directory,'writer-death-marker.json'),'wx',0o600);try{await fd.writeFile(JSON.stringify(marker,null,2)+'\n');await fd.sync();}finally{await fd.close();}const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}process.send({event:'actual-Native-ready-for-owner-death',pid:process.pid,containerId:marker.containerId});
 // A parent observation failure still owns and kills this exact child. The
 // fallback is bounded and cleans resources if the parent never delivers death.
 setTimeout(()=>{void registry.shutdown().then(()=>provider.shutdown()).finally(()=>process.exit(2));},30000);
}catch{
 try{await registry?.shutdown();}catch{}try{await provider.shutdown();}catch{}await attach.close();await effects.close();await metadata.close();try{store.close();}catch{}process.exitCode=1;process.disconnect();
}
