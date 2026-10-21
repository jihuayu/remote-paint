// Public test-only localhost certificate/key; never production credentials.
import {readFileSync} from 'node:fs';
import {createServer} from 'node:https';
import {once} from 'node:events';
import {createSocket} from 'node:dgram';
import {createHash} from 'node:crypto';
import {createAgentWebhookAuthenticator} from '../../service/agent-webhook-auth.mjs';
import {uuid} from './session-agent-records.mjs';
export const cert=readFileSync(new URL('./webhook-localhost-cert.pem',import.meta.url),'utf8');
const key=readFileSync(new URL('./webhook-localhost-key.pem',import.meta.url),'utf8');
export const endpointId='awh_'+uuid(1),secret=Buffer.alloc(32,0x57),authConfig={endpointId,keys:[{keyId:'fixture',secret}],activeKeyId:'fixture'};
export const digest=body=>createHash('sha256').update(body).digest('hex');
export function acknowledge(res,eventId,bodySha256,status=202){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({schema:'agent-webhook-ack-v1',eventId,bodySha256}));}
export async function dnsReceiver(t,{hold=false}={}){
 const socket=createSocket('udp4'),queries=[],pending=[];socket.on('error',()=>{});
 function answer(packet,rinfo){
  let offset=12;while(offset<packet.length&&packet[offset])offset+=packet[offset]+1;offset++;if(offset+4>packet.length)return;const type=packet.readUInt16BE(offset),end=offset+4,header=Buffer.alloc(12);packet.copy(header,0,0,2);header.writeUInt16BE(0x8180,2);header.writeUInt16BE(1,4);header.writeUInt16BE(type===1?1:0,6);const record=type===1?Buffer.from('c00c000100010000003c00047f000001','hex'):Buffer.alloc(0);socket.send(Buffer.concat([header,packet.subarray(12,end),record]),rinfo.port,rinfo.address,()=>{});
 }
 socket.on('message',(packet,rinfo)=>{queries.push(Buffer.from(packet));if(hold)pending.push([Buffer.from(packet),rinfo]);else answer(packet,rinfo);});
 await new Promise(resolve=>socket.bind(0,'127.0.0.1',resolve));let closed=false;const close=async()=>{if(closed)return;closed=true;await new Promise(resolve=>socket.close(resolve));};t.after(close);
 return {server:'127.0.0.1:'+socket.address().port,queries,respond(){hold=false;for(const [packet,rinfo]of pending.splice(0))answer(packet,rinfo);},close};
}
export async function receiver(t,handler=({res,eventId,bodySha256})=>acknowledge(res,eventId,bodySha256)){
 const auth=createAgentWebhookAuthenticator(authConfig),requests=[],sockets=new Set();let tlsErrors=0,connected=0;
 const server=createServer({key,cert},(req,res)=>{
  req.on('error',()=>{});res.on('error',()=>{});let size=0;const parts=[];
  req.on('data',part=>{size+=part.length;if(size>4096){req.destroy();return;}parts.push(part);});
  req.once('end',()=>{
   const body=Buffer.concat(parts),eventId=req.headers['remote-paint-event-id'],signature=req.headers['remote-paint-signature'];
   try{auth.verify({eventId,signature,body});}catch{res.writeHead(401);res.end();return;}
   const row={req,res,body,eventId,bodySha256:digest(body),headers:{...req.headers},event:JSON.parse(body.toString('utf8'))};requests.push(row);
   try{Promise.resolve(handler(row)).catch(()=>res.destroy());}catch{res.destroy();}
  });
 });
 server.on('tlsClientError',()=>{tlsErrors++;});server.on('clientError',(_e,socket)=>socket.destroy());server.on('connection',socket=>{connected++;sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 let closed=false;const close=async()=>{if(closed)return;closed=true;const ending=once(server,'close');server.close();server.closeAllConnections();for(const socket of sockets)socket.destroy();await ending;auth.close();};t.after(close);
 return {server,url:'https://127.0.0.1:'+server.address().port+'/hook',localhostUrl:'https://localhost:'+server.address().port+'/hook',requests,close,counts:()=>({connections:sockets.size,tlsErrors,connected})};
}
