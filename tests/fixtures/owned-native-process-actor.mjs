// Opt-in actor run only by the host verifier in its exact owned fullCID.
// It reads no argv, environment, socket credentials or unrelated PID tree.
import assert from 'node:assert/strict';
import {readFileSync,readlinkSync} from 'node:fs';
const value=JSON.parse(process.argv[2]);
function row(pid){const text=readFileSync('/proc/'+pid+'/stat','utf8'),n=text.lastIndexOf(') '),fields=text.slice(n+2).trim().split(/\s+/);return {pid,ppid:Number(fields[1]),startTicks:fields[19],namespace:readlinkSync('/proc/'+pid+'/ns/pid'),exe:readlinkSync('/proc/'+pid+'/exe')};}
const bootId=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),root=row(value.root.pid);
assert.equal(bootId,value.bootId);assert.equal(root.startTicks,value.root.startTicks);assert.equal(root.namespace,value.root.pidNamespace);assert.equal(readlinkSync('/proc/self/ns/pid'),root.namespace);assert.equal(root.ppid,1);
if(value.action==='snapshot'){
 const children=readFileSync('/proc/'+root.pid+'/task/'+root.pid+'/children','utf8').trim().split(/\s+/).filter(Boolean).map(Number).map(row);assert.ok(children.length>=2&&children.length<=16);assert.ok(children.every(x=>x.ppid===root.pid&&x.namespace===root.namespace));console.log(JSON.stringify({scope:'actual direct children of witnessed worker only',bootId,root,children}));
}else{
 assert.equal(value.action,'terminate-browser');const target=row(value.target.pid);assert.equal(target.ppid,root.pid);assert.equal(target.startTicks,value.target.startTicks);assert.equal(target.namespace,root.namespace);assert.equal(target.exe,'/browser/headless_shell');assert.equal(value.target.exe,target.exe);process.kill(target.pid,'SIGKILL');console.log(JSON.stringify({scope:'exact owned browser process identity revalidated before signal',bootId,root,target,signal:'SIGKILL',signalDelivered:true}));
}
