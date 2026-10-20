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
const [output,target]=process.argv.slice(2),configuration=JSON.parse(readFileSync(join(output,'configuration.json'))),socketPath=process.env.REMOTE_PAINT_DOCKER_SOCKET,daemonId=configuration.daemonId,store=new SqliteSessionStore({path:join(output,'journal.sqlite')}),metadata=new DockerMetadataClient({socketPath,daemonId}),effects=new DockerEffectClient({socketPath,daemonId}),attach=new DockerAttachClient({socketPath,daemonId}),witnessStore=new RuntimeWitnessStore({directory:join(output,'namespace-evidence')}),retirementStore=new RuntimeRetirementStore({directory:join(output,'retirement-evidence'),witnessStore});
let registry;
const provider=new DockerSessionProvider({store,configuration,deploymentBinding:new RuntimeDeploymentBindingStore({directory:join(output,'deployment-binding')}),metadata,effects,attach,witnessStore,retirementStore,projectManifest:join(output,'project-manifest.json'),browserManifest:join(output,'browser-manifest.json'),onEvent:event=>{
 if(event.type!==target)return;
 const fd=openSync(join(output,'writer-death-marker.json'),'wx',0o600);try{writeFileSync(fd,JSON.stringify({pid:process.pid,event,identity:store.identity(),registry:registry.stats(),at:new Date().toISOString()})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 const dir=openSync(output,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 process.kill(process.pid,'SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
}});
await provider.initialize();registry=new SessionRegistry({providers:new Map([[configuration.region,provider]]),defaultRegion:configuration.region,store});registry.create('recovery-fixture',{},{idempotencyKey:'writer-death'});
setTimeout(()=>{process.exitCode=2;void registry.shutdown().then(()=>provider.shutdown()).then(()=>process.exit(2));},15000);
