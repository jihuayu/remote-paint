import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {stat,readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {NativeBroker} from '../native/broker.mjs';

const binary=fileURLToPath(new URL('../native/bin/remote-paint-broker',import.meta.url)),before=await stat(binary),oldHash=createHash('sha256').update(await readFile(binary)).digest('hex');
const broker=new NativeBroker({binary}),pid=broker.child.pid;
let running=true,roundTrips=0,failure;
const probe=(async()=>{while(running){try{await broker.resetScene();roundTrips++;}catch(error){failure=error;break;}await new Promise(resolve=>setTimeout(resolve,2));}})();
try{
 await new Promise((resolve,reject)=>{const build=spawn(process.execPath,['native/build-broker.mjs'],{stdio:['ignore','ignore','pipe']});let stderr='';build.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-4096);});build.on('error',reject);build.on('exit',code=>code===0?resolve():reject(new Error(stderr)));});
 running=false;await probe;assert.equal(failure,undefined);assert.ok(roundTrips>0);assert.equal(broker.child.pid,pid);assert.equal(broker.child.exitCode,null);
 const after=await stat(binary);assert.notEqual(after.ino,before.ino,'Publishing replaces the inode instead of truncating a running executable');
 const listener=await broker.request('listen',{config:{host:'127.0.0.1',port:0,origin:'http://127.0.0.1',key:'atomic-test-local',renderer:{},producer:{}}});assert.ok(listener.port>0);
 const report={at:new Date().toISOString(),scope:'Actual host native broker serving IPC throughout a Cargo rebuild and atomic artifact replacement; preexisting process then starts its Gateway',roundTrips,preexistingProcessSurvived:true,inodeChanged:true,oldHash,newHash:createHash('sha256').update(await readFile(binary)).digest('hex')};
 await mkdir('artifacts/build',{recursive:true});await writeFile('artifacts/build/atomic-broker.json',JSON.stringify(report,null,2));console.log(report);
}finally{running=false;await probe;await broker.close();}
