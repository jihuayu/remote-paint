import {runSessionWorker} from './session-worker.mjs';
import {collectLinuxRuntimeWitness} from './linux-runtime-witness.mjs';
import {NativeSessionResource} from './native-session-resource.mjs';
import {deriveNativeTransportKey} from './native-transport-key.mjs';
// Launched by a separately owned Linux runtime. Page URL/owner credential are
// received only over private stdin; neither appears in argv or stdout logs.
let exitCode=1;
try{
 if(process.platform!=='linux'||process.env.REMOTE_PAINT_WORKER_BOUNDARY!=='owned-container-v1'||process.env.REMOTE_PAINT_DATA_PLANE!=='native')throw new Error('Unsupported worker runtime');
 const identity={sessionId:process.env.REMOTE_PAINT_WORKER_SESSION,tenantId:process.env.REMOTE_PAINT_WORKER_TENANT,region:process.env.REMOTE_PAINT_WORKER_REGION,ownerKeyHash:process.env.REMOTE_PAINT_WORKER_OWNER_HASH};
 const worker=runSessionWorker({identity,runtimeWitness:collectLinuxRuntimeWitness,deriveResourceSecret:deriveNativeTransportKey,createResource:context=>{
  if(!/^[a-f0-9]{64}$/.test(context.resourceSecret??''))throw new Error('Private Native bootstrap unavailable');
  return new NativeSessionResource({...context,transportKey:context.resourceSecret,startLive:async options=>{
   const {startLive}=await import('../live.mjs');return startLive({...options,port:4175,nativePort:4176,host:'0.0.0.0'});
  }});
 }});
 const outcome=await worker.done;exitCode=outcome.exitCode;
}catch{
 process.stdout.write(JSON.stringify({type:'WorkerConfigurationFailed',protocol:'session-worker-v1',code:'WORKER_CONFIGURATION_FAILED'})+'\n');
}
// Bounded final flush. A failed close exits1 so the outer runtime must prove
// complete namespace retirement before a Registry can release its quota.
await new Promise(resolve=>{const timer=setTimeout(resolve,100);process.stdout.write('',()=>{clearTimeout(timer);resolve();});});
process.exit(exitCode);
