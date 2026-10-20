import {openSync,readSync,closeSync,readlinkSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value'));
const integer=value=>Number.isSafeInteger(value)&&value>=0&&value<=2147483647;
const ticks=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value)&&BigInt(value)<=0xffffffffffffffffn;
const namespace=value=>typeof value==='string'&&/^pid:\[[1-9][0-9]{0,19}\]$/.test(value)&&BigInt(value.slice(5,-1))<=0xffffffffffffffffn;
const zero='0000000000000000';
export class RuntimeWitnessError extends Error {constructor(code='RUNTIME_WITNESS_INVALID'){super('Runtime namespace witness is unavailable');this.name='RuntimeWitnessError';this.code=code;}}
const reject=code=>{throw new RuntimeWitnessError(code);};
const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);
export function validateLinuxRuntimeWitness(value){
 if(!exact(value,['schema','bootId','self','init','security'])||value.schema!=='linux-private-pidns-v1'||typeof value.bootId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.bootId))reject();
 for(const row of [value.self,value.init])if(!exact(row,['pid','ppid','pgrp','session','startTicks','pidNamespace'])||!['pid','ppid','pgrp','session'].every(k=>integer(row[k]))||row.pid<1||row.pgrp<1||row.session<1||!ticks(row.startTicks)||!namespace(row.pidNamespace))reject();
 if(value.self.pid<=1||value.self.ppid!==1||value.init.pid!==1||value.init.ppid!==0||value.self.pidNamespace!==value.init.pidNamespace||BigInt(value.self.startTicks)<BigInt(value.init.startTicks))reject('RUNTIME_WITNESS_NAMESPACE');
 const security=value.security;if(!exact(security,['uid','gid','capInh','capPrm','capEff','capBnd','capAmb','noNewPrivs','seccomp'])||security.uid!=='0:0:0:0'||security.gid!=='0:0:0:0'||['capInh','capPrm','capEff','capBnd','capAmb'].some(k=>security[k]!==zero)||security.noNewPrivs!==1||security.seccomp!==2)reject('RUNTIME_WITNESS_SECURITY');
 const copy=structuredClone(value);Object.freeze(copy.self);Object.freeze(copy.init);Object.freeze(copy.security);return Object.freeze(copy);
}
export function runtimeWitnessSha256(value){return createHash('sha256').update(canonical(validateLinuxRuntimeWitness(value))).digest('hex');}
function stat(text,pid){
 if(typeof text!=='string'||Buffer.byteLength(text)>4096||!text.endsWith('\n'))reject();const end=text.lastIndexOf(') '),match=text.slice(0,end).match(/^([1-9][0-9]*) \([\s\S]*$/);if(end<0||!match)reject();const fields=text.slice(end+2).trim().split(/\s+/);if(fields.length<20||!['R','S','D','I'].includes(fields[0])||![match[1],fields[1],fields[2],fields[3]].every(v=>/^(0|[1-9][0-9]*)$/.test(v)))reject();const row={pid:Number(match[1]),ppid:Number(fields[1]),pgrp:Number(fields[2]),session:Number(fields[3]),startTicks:fields[19],pidNamespace:pid};return row;
}
export function parseLinuxRuntimeWitnessSample(sample){
 if(!exact(sample,['bootId','selfStat','initStat','status','selfNamespace','initNamespace'])||typeof sample.status!=='string'||Buffer.byteLength(sample.status)>16384||typeof sample.bootId!=='string'||sample.bootId.length>64)reject();
 const fields={};for(const line of sample.status.trim().split('\n')){const n=line.indexOf(':');if(n<=0)reject();const key=line.slice(0,n);if(Object.hasOwn(fields,key))reject();fields[key]=line.slice(n+1).trim();}
 const numbers=key=>{const text=fields[key];if(typeof text!=='string'||!/^0\s+0\s+0\s+0$/.test(text))reject('RUNTIME_WITNESS_SECURITY');return text.split(/\s+/).join(':');};
 return validateLinuxRuntimeWitness({schema:'linux-private-pidns-v1',bootId:sample.bootId.trim(),self:stat(sample.selfStat,sample.selfNamespace),init:stat(sample.initStat,sample.initNamespace),security:{uid:numbers('Uid'),gid:numbers('Gid'),capInh:fields.CapInh,capPrm:fields.CapPrm,capEff:fields.CapEff,capBnd:fields.CapBnd,capAmb:fields.CapAmb,noNewPrivs:fields.NoNewPrivs==='1'?1:0,seccomp:fields.Seccomp==='2'?2:0}});
}
function read(path,limit){
 const buffer=Buffer.alloc(limit+1);let fd;
 try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let used=0;while(used<buffer.length){const count=readSync(fd,buffer,used,buffer.length-used,null);if(count===0)break;used+=count;}if(used>limit)reject('RUNTIME_WITNESS_LIMIT');return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used));}
 finally{buffer.fill(0);if(fd!==undefined)closeSync(fd);}
}
export function collectLinuxRuntimeWitness(){
 if(process.platform!=='linux')reject('RUNTIME_WITNESS_PLATFORM');const deadline=performance.now()+5000;
 try{
  const bootId=read('/proc/sys/kernel/random/boot_id',64),selfStat=read('/proc/self/stat',4096),initStat=read('/proc/1/stat',4096),selfNamespace=readlinkSync('/proc/self/ns/pid'),initNamespace=readlinkSync('/proc/1/ns/pid'),status=read('/proc/self/status',16384);
  const proof=parseLinuxRuntimeWitnessSample({bootId,selfStat,initStat,status,selfNamespace,initNamespace}),afterSelf=stat(read('/proc/self/stat',4096),readlinkSync('/proc/self/ns/pid')),afterInit=stat(read('/proc/1/stat',4096),readlinkSync('/proc/1/ns/pid'));
  if(canonical(proof.self)!==canonical(afterSelf)||canonical(proof.init)!==canonical(afterInit)||read('/proc/sys/kernel/random/boot_id',64).trim()!==proof.bootId||readlinkSync('/proc/1/ns/pid')!==proof.init.pidNamespace)reject('RUNTIME_WITNESS_CHANGED');if(performance.now()>=deadline)reject('RUNTIME_WITNESS_DEADLINE');return proof;
 }catch(error){throw error instanceof RuntimeWitnessError?error:new RuntimeWitnessError('RUNTIME_WITNESS_READ');}
}
