// Copied beside the frozen session-worker.mjs in an owned read-only fixture
// project. This creates only Node processes, never a Native/Chromium resource.
import {readFileSync,readlinkSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {request} from 'node:http';
import {runSessionWorker} from './session-worker.mjs';
import {collectLinuxRuntimeWitness} from './linux-runtime-witness.mjs';
const config=JSON.parse(readFileSync('/project/config.json','utf8')),role=process.argv.includes('--leaf')?'leaf':'main';
function stat(path){const value=readFileSync(path,'utf8'),n=value.lastIndexOf(') '),parts=value.slice(n+2).trim().split(/\s+/);return {pid:Number(value.slice(0,value.indexOf(' '))),ppid:Number(parts[1]),pgrp:Number(parts[2]),session:Number(parts[3]),startTicks:parts[19]};}
function witness(){
 const status=Object.fromEntries(readFileSync('/proc/self/status','utf8').trim().split('\n').map(s=>{const n=s.indexOf(':');return [s.slice(0,n),s.slice(n+1).trim()];}));
 const identity={event:'witness',role,self:stat('/proc/self/stat'),init:stat('/proc/1/stat'),namespace:readlinkSync('/proc/self/ns/pid'),initNamespace:readlinkSync('/proc/1/ns/pid'),capEff:status.CapEff,capBnd:status.CapBnd,noNewPrivs:status.NoNewPrivs,seccomp:status.Seccomp};
 const req=request({hostname:'host.docker.internal',port:config.port,path:'/witness',method:'POST',headers:{authorization:'Bearer '+config.nonce,'content-type':'application/x-ndjson'}},res=>res.resume());req.on('error',()=>{});req.write(JSON.stringify(identity)+'\n');const timer=setInterval(()=>{if(!req.destroyed)req.write(JSON.stringify({event:'heartbeat',pid:process.pid})+'\n');},100);return {end(){clearInterval(timer);req.end();}};
}
const observer=witness();
if(role==='main'){
 let leaf=null,starting,closing;
 const worker=runSessionWorker({runtimeWitness:collectLinuxRuntimeWitness,identity:{sessionId:process.env.REMOTE_PAINT_WORKER_SESSION,tenantId:process.env.REMOTE_PAINT_WORKER_TENANT,region:process.env.REMOTE_PAINT_WORKER_REGION,ownerKeyHash:process.env.REMOTE_PAINT_WORKER_OWNER_HASH},createResource:()=>({
  initialize:()=>starting??=(async()=>{leaf=spawn(process.execPath,['/project/worker.mjs','--leaf'],{detached:true,stdio:'ignore'});await once(leaf,'spawn');return {version:'node-private-attach-fixture-v1'};})(),
  close:()=>closing??=(async()=>{try{await starting;}catch{}if(leaf&&leaf.exitCode===null&&leaf.signalCode===null){const closed=once(leaf,'close');leaf.kill('SIGTERM');await closed;}return {status:'closed'};})()
 })});
 const outcome=await worker.done;observer.end();await new Promise(resolve=>process.stdout.write('',resolve));process.exit(outcome.exitCode);
}
