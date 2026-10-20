import assert from 'node:assert/strict';
import {createServer} from 'node:http';
export async function processWitnessObserver(nonce){
 const witnesses=new Map(),sockets=new Set(),errors=[];
 const server=createServer((req,res)=>{
  if(req.method!=='POST'||req.url!=='/witness'||req.headers.authorization!=='Bearer '+nonce||sockets.size>2){res.writeHead(403);res.end();return;}
  let pending='',role=null,count=0;req.setEncoding('utf8');res.writeHead(200,{'content-type':'text/plain'});res.flushHeaders();
  req.on('data',chunk=>{pending+=chunk;if(Buffer.byteLength(pending)>16384){errors.push('line-limit');req.destroy();return;}let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);try{const value=JSON.parse(line);if(value.event==='witness'){assert.ok(['main','leaf'].includes(value.role)&&!witnesses.has(value.role));role=value.role;witnesses.set(role,{identity:value,heartbeats:0,closed:false});}else{assert.ok(role&&value.event==='heartbeat'&&value.pid===witnesses.get(role).identity.self.pid);witnesses.get(role).heartbeats++;}assert.ok(++count<=1000);}catch{errors.push('invalid-witness');req.destroy();}}});
  req.on('error',()=>{});req.socket.once('close',()=>{if(role)witnesses.get(role).closed=true;});
 });
 server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {port:server.address().port,witnesses,errors,async wait(check,ms=10000){const end=performance.now()+ms;while(!check()){assert.ok(performance.now()<end,'Process witness observation deadline exceeded');await new Promise(r=>setTimeout(r,20));}},async close(){for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
