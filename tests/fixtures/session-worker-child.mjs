import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {runSessionWorker} from '../../service/session-worker.mjs';
import {witness} from './runtime-witness-records.mjs';
const mode=process.argv[2]??'normal',key='a'.repeat(64),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let closes=0,initializes=0,reentries=0,reentryHadFence=false,leaf=null,worker;
const runtimeWitness=mode==='witness-invalid'?()=>({...witness(),security:{...witness().security,noNewPrivs:0}}):mode==='witness-throw'?()=>{throw Error('private-proof-secret');}:mode==='witness-async'?()=>Promise.reject(Error('private-proof-secret')):null;
const result=runSessionWorker({runtimeWitness,identity:{sessionId:'ses_fixture',tenantId:'a',region:'test',ownerKeyHash:createHash('sha256').update(key).digest('hex')},
 startTimeoutMs:mode==='handshake-timeout'?80:2000,ownerLeaseMs:mode==='lease-expiry'?100:2000,initializationTimeoutMs:mode==='startup-timeout'?80:2000,closeTimeoutMs:mode==='close-timeout'?80:1000,
 createResource:context=>{
  if(mode==='factory-fail')throw new Error('private-start-secret');
  if(mode==='async-factory')return Promise.reject(new Error('private-async-secret'));
  let starting,initialized=false,closePromise;
  if(mode==='abort-reentrant')context.signal.addEventListener('abort',()=>{reentries++;const fence=worker.stop();reentryHadFence=typeof fence?.then==='function';},{once:true});
  const initialize=()=>starting??=(async()=>{
   initializes++;
   if(mode==='startup-fail')throw new Error('private-initialize-secret');
   if(['startup-timeout','late-start','early-close'].includes(mode))await delay(mode==='startup-timeout'?140:100);
   if(mode==='owned-child'){
    leaf=spawn(process.execPath,['-e',"const timer=setInterval(()=>{},1000);process.stdin.once('end',()=>clearInterval(timer));process.stdin.resume();"],{stdio:['pipe','ignore','ignore']});
    await once(leaf,'spawn');process.stderr.write(JSON.stringify({event:'OwnedLeaf',pid:leaf.pid})+'\n');
   }
   initialized=true;return {version:'fixture-worker-v1'};
  })();
  return {initialize,close:()=>closePromise??=(async()=>{
   closes++;
   if(mode==='close-timeout')await new Promise(()=>{});
   if(mode==='early-close')return {status:'closed'};
   try{await starting;}catch{}
   if(leaf){const exited=once(leaf,'close');leaf.stdin.end();leaf.kill('SIGTERM');await exited;}
   if(mode==='close-fail')throw new Error('private-close-secret');
   return {status:mode==='unconfirmed'?'unconfirmed':'closed'};
  })()};
 }});
worker=result;
const outcome=await result.done;
// Non-secret fixture counts/owned PID are test-only stderr, never production Ready.
process.stderr.write(JSON.stringify({closes,initializes,reentries,reentryHadFence,leafPid:leaf?.pid??null,leafReaped:leaf?leaf.exitCode!==null||leaf.signalCode!==null:true,outcome})+'\n');
await new Promise(resolve=>process.stdout.write('',resolve));process.exit(outcome.exitCode);
