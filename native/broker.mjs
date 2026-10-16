import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
export class NativeBroker extends EventEmitter {
 constructor({binary=process.env.REMOTE_PAINT_BROKER??fileURLToPath(new URL('./bin/remote-paint-broker',import.meta.url))}={}){
  super();this.pending=new Map();this.seq=0;this.closed=false;this.stderr='';this.queue=Promise.resolve();
  this.child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});let buffer=Buffer.alloc(0);
  this.child.stdout.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const size=buffer.readUInt32BE();if(size>90*1024*1024){this.child.kill();return;}if(buffer.length<size+4)break;const packet=buffer.subarray(4,size+4);buffer=buffer.subarray(size+4);try{const message=JSON.parse(packet);if(message.event){this.emit('event',message);continue;}const pending=this.pending.get(message.id);if(!pending)continue;this.pending.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(new Error(message.error)):pending.resolve(message.result);}catch(error){this.fail(error);}}});
  this.child.stderr.on('data',bytes=>{this.stderr=(this.stderr+bytes.toString()).slice(-8192);});
  this.child.on('error',error=>this.fail(error));this.child.on('exit',(code,signal)=>this.fail(new Error(`Native Broker exited (${code??signal}): ${this.stderr}`)));
 }
 fail(error){for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();if(!this.closed){this.closed=true;this.emit('failure',error);}}
 request(op,args={}){
  if(this.closed)return Promise.reject(new Error('Native Broker closed'));if(this.pending.size>=64)return Promise.reject(new Error('Native Broker queue limit'));
  const id=++this.seq,bytes=Buffer.from(JSON.stringify({id,op,...args}));if(bytes.length>90*1024*1024)return Promise.reject(new Error('Native Broker packet limit'));
  const header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);const packet=Buffer.concat([header,bytes]);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Native Broker ${op} timeout`));this.child.kill();},15000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(packet,error=>{if(error){this.pending.delete(id);clearTimeout(timer);reject(error);}});});
 }
 async map(capture,{epoch,viewport,viewportVersion,inputSeq=0}){
  const result=await this.request('map',{capture,epoch,viewport,viewportVersion,inputSeq});
  return {...result.metadata,scene:result.scene,brokerSerial:result.serial,payloads:new Map(result.resources.map(item=>[item.id,{length:item.bytes,byteLength:item.bytes}]))};
 }
 reset(){return this.request('reset');}
 resetScene(){return this.request('resetScene');}
 async close(){if(this.closed)return;this.closed=true;this.child.stdin.end();await new Promise(resolve=>{if(this.child.exitCode!==null)return resolve();this.child.once('exit',resolve);const timer=setTimeout(()=>this.child.kill(),2000);timer.unref();});}
}
