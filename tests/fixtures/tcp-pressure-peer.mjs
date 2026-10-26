import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('./tcp-pressure-peer.py',import.meta.url));
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned TCP fixture observation deadline')),3000);})]);}finally{clearTimeout(timer);}}
function own(t,mode,args=[],socket=null){
 const child=spawn(process.env.PYTHON??'python3',[script,mode,...args],{stdio:['pipe','pipe','pipe',...(socket?[socket]:[])]});
 let outputBytes=0,stderr='',spawnError=null;
 child.stdout.on('data',b=>{outputBytes+=b.length;if(outputBytes>4096)child.kill('SIGKILL');});
 child.stderr.on('data',b=>{if(stderr.length<4096)stderr+=b.toString().slice(0,4096-stderr.length);});child.on('error',e=>{spawnError=e;});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal}))),lines=createInterface({input:child.stdout}),iterator=lines[Symbol.asyncIterator]();
 const check=async()=>{const result=await bounded(closed);if(spawnError)throw spawnError;assert.equal(result.code,0,stderr);assert.equal(result.signal,null);return result;};
 let closing=null;
 const close=()=>closing??=(async()=>{if(child.exitCode===null&&child.signalCode===null){child.stdin.on('error',()=>{});child.stdin.end('close\n');}try{return await check();}catch(error){child.kill('SIGKILL');await bounded(closed);throw error;}finally{lines.close();}})();
 t.after(close);
 return {child,check,close,async next(){const r=await bounded(iterator.next());assert.equal(r.done,false,stderr);return JSON.parse(r.value);}};
}

export async function tcpPressurePeer(t,server,url,{headers,body}){
 const parsed=new URL(url);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.protocol,'http:');
 let acceptedResolve;const accepted=new Promise(resolve=>{acceptedResolve=resolve;});
 const connection=socket=>acceptedResolve(socket);server.once('connection',connection);
 const receiver=own(t,'receiver',[parsed.port]);let sender;
 try{
  const [connected,socket]=await Promise.all([receiver.next(),bounded(accepted)]);assert.equal(connected.stage,'connected');
  const wasPaused=socket.isPaused();sender=own(t,'sender',[],socket);const configured=await sender.next();await sender.check();if(!wasPaused)socket.resume();assert.ok(configured.sendBuffer>0&&configured.sendBuffer<=262144);
  const payload=Buffer.from(JSON.stringify(body)),raw=Buffer.concat([Buffer.from('POST '+parsed.pathname+' HTTP/1.1\r\nHost: '+parsed.host+'\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: '+payload.length+'\r\n'+Object.entries(headers).map(([k,v])=>k+': '+v+'\r\n').join('')+'\r\n'),payload]);assert.ok(raw.length<=8192);
  receiver.child.stdin.write(JSON.stringify({request:raw.toString('base64')})+'\n');const response=await receiver.next();assert.equal(response.stage,'headers');assert.ok(response.receiveBuffer>0&&response.receiveBuffer<=65536,JSON.stringify(response));
  return {statusCode:response.statusCode,sendBuffer:configured.sendBuffer,receiveBuffer:response.receiveBuffer,close:receiver.close};
 }catch(error){const cleanup=await Promise.allSettled([receiver.close(),...(sender?[sender.close()]:[])]),failures=cleanup.filter(r=>r.status==='rejected').map(r=>r.reason);if(failures.length)throw new AggregateError([error,...failures],'Owned TCP fixture and cleanup failed');throw error;}finally{server.off('connection',connection);}
}
