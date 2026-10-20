// Stop exactly at a durable startup event. No asynchronous work can advance
// after the fsynced marker and self-SIGKILL; credentials never leave memory.
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
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
const [directory,manifestPath,target]=process.argv.slice(2),m=JSON.parse(readFileSync(manifestPath)),configuration=JSON.parse(readFileSync(join(directory,'configuration.json'))),store=new SqliteSessionStore({path:join(directory,'journal.sqlite')}),metadata=new DockerMetadataClient({socketPath:m.socketPath,daemonId:m.daemonId}),effects=new DockerEffectClient({socketPath:m.socketPath,daemonId:m.daemonId}),attach=new DockerAttachClient({socketPath:m.socketPath,daemonId:m.daemonId,maxConcurrent:2}),witnessStore=new RuntimeWitnessStore({directory:join(directory,'namespace')}),retirementStore=new RuntimeRetirementStore({directory:join(directory,'retirement'),witnessStore}),events=[];
let registry;
const provider=new DockerSessionProvider({store,configuration,deploymentBinding:new RuntimeDeploymentBindingStore({directory:join(directory,'binding')}),metadata,effects,attach,witnessStore,retirementStore,projectManifest:m.runtimeProjectManifest,browserManifest:m.runtimeBrowserManifest,onEvent:event=>{
 events.push(event);if(event.type!==target)return;
 const marker={at:new Date().toISOString(),pid:process.pid,target,event,events,identity:store.identity(),registry:registry.stats(),session:registry.getSession('native-startup-recovery-fixture',event.sessionId),provider:provider.sessionStatus({sessionId:event.sessionId,tenantId:'native-startup-recovery-fixture'})},fd=openSync(join(directory,'writer-death-marker.json'),'wx',0o600);try{writeFileSync(fd,JSON.stringify(marker,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}const dir=openSync(directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}process.kill(process.pid,'SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
}});
await provider.initialize();registry=new SessionRegistry({providers:new Map([[configuration.region,provider]]),defaultRegion:configuration.region,store,globalQuota:2,tenantQuota:2});registry.create('native-startup-recovery-fixture',{url:'about:blank',ttlSeconds:120},{idempotencyKey:'writer-death'});
setTimeout(()=>{void registry.shutdown().then(()=>provider.shutdown()).finally(()=>process.exit(2));},60000);
