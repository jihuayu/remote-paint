import net from 'node:net';
import {mkdtemp,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
const MAX=256*1024;
export async function startVizIPC(){
 const directory=await mkdtemp('/tmp/remote-paint-');await chmod(directory,0o700);
 const endpoint=join(directory,'viz.sock');const pending=new Map(),sockets=new Set();let closed=false;
 const stats={received:0,rejected:0,maxBufferedBytes:0};
 const server=net.createServer(socket=>{
  if(sockets.size>=4){socket.destroy();return;}sockets.add(socket);
  // Viz keeps one private connection open and sends one framed scene per
  // capture. A long idle period is still bounded so dead browser processes do
  // not leave sockets around forever.
  socket.setTimeout(15000,()=>socket.destroy());
  let bytes=Buffer.alloc(0),length;
  socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
  socket.on('data',chunk=>{
   if(bytes.length+chunk.length>MAX+4){stats.rejected++;socket.destroy();return;}
   bytes=Buffer.concat([bytes,chunk]);stats.maxBufferedBytes=Math.max(stats.maxBufferedBytes,bytes.length);
   while(true){
    if(length===undefined&&bytes.length>=4){length=bytes.readUInt32BE();if(!length||length>MAX){stats.rejected++;socket.destroy();return;}}
    if(length===undefined||bytes.length<length+4)return;
    const packet=bytes.subarray(4,length+4);bytes=bytes.subarray(length+4);length=undefined;
    try{
     const scene=JSON.parse(packet.toString('utf8'));
     if(scene.type!=='VizScene'||typeof scene.captureId!=='string')throw new Error('Invalid Viz message');
     const waiter=pending.get(scene.captureId);
     if(!waiter){stats.rejected++;continue;}
     pending.delete(scene.captureId);clearTimeout(waiter.timer);stats.received++;
     if(scene.error)waiter.reject(new Error(scene.error));else waiter.resolve(scene);
    }catch{stats.rejected++;}
   }
  });
 });
 try{
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(endpoint,ok);});await chmod(endpoint,0o600);
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
 return {endpoint,stats,
  waitFor(id,{timeout=6000}={}){
   if(closed||pending.has(id)||pending.size>=4)throw new Error('Viz IPC request unavailable');
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Viz did not aggregate the requested content frame'));},timeout);
    pending.set(id,{resolve,reject,timer});
   });
  },
  cancel(id){const waiter=pending.get(id);if(waiter){pending.delete(id);clearTimeout(waiter.timer);waiter.reject(new Error('Capture canceled'));}},
  async close(){closed=true;for(const id of pending.keys())this.cancel(id);for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});},
 };
}
