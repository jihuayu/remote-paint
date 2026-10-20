// The only launcher is DockerAttachClient. Configuration comes from private fd3;
// fd4 carries one bounded transport notification. stdout is worker bytes only.
import {createReadStream,createWriteStream} from 'node:fs';
import {Agent,request} from 'node:http';
import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {captureDockerAttachConfig,DockerAttachError} from './docker-attach-config.mjs';
import {verifyDockerRuntime} from './docker-runtime-spec.mjs';
import {decodeDockerMultiplex} from './docker-multiplex.mjs';
const sink=()=>{},fail=code=>new DockerAttachError(code),started=performance.now();
let deadline=started+10000,startupTimer,eofTimer,agent,raw,activeRequest,inputTask,config,failure=null,closing=false,attached=false;
const aborter=new AbortController(),configuration=createReadStream(null,{fd:3,autoClose:true,highWaterMark:65536}),control=createWriteStream(null,{fd:4,autoClose:true});
for(const stream of [configuration,control,process.stdin,process.stdout])stream.on('error',sink);
function abort(code){if(closing)return;failure??=code;aborter.abort();configuration.destroy();activeRequest?.destroy();raw?.destroy();process.stdin.destroy();}
function check(){if(failure)throw fail(failure);if(performance.now()>=deadline)throw fail('ATTACH_DEADLINE');}
function arm(){clearTimeout(startupTimer);startupTimer=setTimeout(()=>{if(performance.now()<deadline)arm();else abort('ATTACH_DEADLINE');},Math.max(1,Math.ceil(deadline-performance.now())));}
arm();process.once('SIGTERM',()=>abort('ATTACH_STOPPED'));process.once('SIGINT',()=>abort('ATTACH_STOPPED'));
class OneConnection extends Agent {
 constructor(path){super({keepAlive:true,maxSockets:1,maxFreeSockets:1});this.path=path;this.created=false;this.socket=null;}
 createConnection(_options,callback){if(this.created){queueMicrotask(()=>callback(fail('ATTACH_CONNECTION_GONE')));return;}this.created=true;this.socket=createConnection({path:this.path,highWaterMark:65536});this.socket.on('error',sink);return this.socket;}
 shutdown(){this.socket?.destroy();this.destroy();}
}
const options=(method,path,headers={})=>({socketPath:config.socketPath,agent,method,path:'/v'+config.apiVersion+path,signal:aborter.signal,headers});
function get(path){
 check();return new Promise((resolve,reject)=>{
  let buffer=Buffer.allocUnsafeSlow(131072),used=0,res,finished=false;
  const finish=(error,value)=>{if(finished)return;finished=true;buffer.fill(0);buffer=null;if(error){res?.destroy();activeRequest?.destroy();reject(error);}else resolve(value);};
  const req=activeRequest=request(options('GET',path,{Accept:'application/json',Connection:'keep-alive'}),response=>{
   res=response;res.on('error',()=>finish(fail('ATTACH_ENGINE_IO')));res.on('aborted',()=>finish(fail('ATTACH_ENGINE_IO')));
   if(res.statusCode!==200){finish(fail('ATTACH_ENGINE_HTTP'));return;}
   const length=res.headers['content-length'];if(length!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>131072)){finish(fail('ATTACH_ENGINE_LIMIT'));return;}
   res.on('data',b=>{if(finished)return;if(!Buffer.isBuffer(b)||used+b.length>buffer.length){finish(fail('ATTACH_ENGINE_LIMIT'));return;}b.copy(buffer,used);used+=b.length;});
   res.on('end',()=>{if(finished)return;try{check();if(!res.complete)throw fail('ATTACH_ENGINE_IO');const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used)));if(!value||typeof value!=='object'||Array.isArray(value))throw fail('ATTACH_ENGINE_JSON');finish(null,value);}catch(e){finish(e instanceof DockerAttachError?e:fail('ATTACH_ENGINE_JSON'));}});
  });req.on('socket',s=>{if(s!==agent.socket)finish(fail('ATTACH_CONNECTION_CHANGED'));});req.on('error',()=>finish(fail(failure??'ATTACH_ENGINE_IO')));req.end();
 });
}
function upgrade(){
 check();return new Promise((resolve,reject)=>{
  let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;if(error){activeRequest?.destroy();reject(error);}else resolve(value);};
  const req=activeRequest=request(options('POST','/containers/'+config.containerId+'/attach?logs=1&stream=1&stdin=1&stdout=1&stderr=1',{Connection:'Upgrade',Upgrade:'tcp'}),res=>{res.destroy();finish(fail('ATTACH_UPGRADE_REJECTED'));});
  req.on('socket',s=>{if(s!==agent.socket)finish(fail('ATTACH_CONNECTION_CHANGED'));});req.on('error',()=>finish(fail(failure??'ATTACH_ENGINE_IO')));
  req.on('upgrade',(res,socket,head)=>{raw=socket;raw.on('error',sink);try{check();if(res.statusCode!==101||socket!==agent.socket||String(res.headers.upgrade).toLowerCase()!=='tcp'||!String(res.headers.connection).toLowerCase().split(',').map(v=>v.trim()).includes('upgrade')||!['application/vnd.docker.raw-stream','application/vnd.docker.multiplexed-stream'].includes(res.headers['content-type'])||head.length>131072)throw fail('ATTACH_UPGRADE_REJECTED');finish(null,{socket,head});}catch(e){socket.destroy();finish(e);}});req.end();
 });
}
const write=(stream,bytes)=>new Promise((resolve,reject)=>{try{stream.write(bytes,e=>e?reject(fail('ATTACH_WRITE_FAILED')):resolve());}catch{reject(fail('ATTACH_WRITE_FAILED'));}});
const notify=value=>new Promise((resolve,reject)=>{control.end(JSON.stringify({protocol:'docker-attach-v1',...value})+'\n',e=>e?reject(fail('ATTACH_CONTROL_FAILED')):resolve());});
// Explicit read(n) prevents Node's async iterator from coalescing an arbitrary
// number of buffered socket chunks into one decoder input.
async function* boundedSocket(socket,head){
 try{for(let n=0;n<head.length;n+=65536){const bytes=head.subarray(n,Math.min(n+65536,head.length));try{yield bytes;}finally{bytes.fill(0);}}}finally{head.fill(0);}
 while(true){
  if(socket.readableLength){const b=socket.read(Math.min(socket.readableLength,65536));if(b){try{yield b;}finally{b.fill(0);}continue;}}
  if(socket.readableEnded)return;if(socket.destroyed)throw fail('ATTACH_STREAM_IO');
  await new Promise((resolve,reject)=>{const clean=()=>{socket.off('readable',ready);socket.off('end',ready);socket.off('close',ended);socket.off('error',error);};const ready=()=>{clean();resolve();},ended=()=>{clean();socket.readableEnded?resolve():reject(fail('ATTACH_STREAM_IO'));},error=()=>{clean();reject(fail('ATTACH_STREAM_IO'));};socket.once('readable',ready);socket.once('end',ready);socket.once('close',ended);socket.once('error',error);socket.read(0);});
 }
}
async function pumpInput(socket){
 const buffer=Buffer.alloc(32769);let used=0;
 try{
  for await(const chunk of process.stdin){if(!Buffer.isBuffer(chunk)||chunk.length>65536)throw fail('ATTACH_INPUT_LIMIT');let offset=0;
   while(offset<chunk.length){const newline=chunk.indexOf(10,offset),end=newline<0?chunk.length:newline,length=end-offset;if(used+length>32768)throw fail('ATTACH_INPUT_LIMIT');chunk.copy(buffer,used,offset,end);used+=length;if(newline<0)break;buffer[used]=10;await write(socket,buffer.subarray(0,used+1));buffer.fill(0,0,used+1);used=0;offset=end+1;}chunk.fill(0);
  }
  if(used)throw fail('ATTACH_INPUT_TRUNCATED');socket.end();const end=performance.now()+config.eofTimeoutMs;const expire=()=>{if(performance.now()<end)eofTimer=setTimeout(expire,Math.max(1,Math.ceil(end-performance.now())));else abort('ATTACH_EOF_TIMEOUT');};eofTimer=setTimeout(expire,Math.max(1,Math.ceil(end-performance.now())));
 }finally{buffer.fill(0);}
}
let exitCode=1;
try{
 const bytes=Buffer.alloc(131072);let used=0;
 try{for await(const chunk of configuration){if(used+chunk.length>bytes.length)throw fail('ATTACH_CONFIGURATION');chunk.copy(bytes,used);used+=chunk.length;}config=captureDockerAttachConfig(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used))));}finally{bytes.fill(0);}
 deadline=started+config.connectTimeoutMs;check();arm();agent=new OneConnection(config.socketPath);
 const info=await get('/info'),architecture=({aarch64:'arm64',arm64:'arm64',x86_64:'amd64',amd64:'amd64'})[info.Architecture];if(info.ID!==config.daemonId||info.OSType!=='linux'||architecture!==config.architecture)throw fail('ATTACH_ENGINE_IDENTITY');
 const document=await get('/containers/'+config.containerId+'/json');let profile;try{profile=verifyDockerRuntime(config.plan,{found:true,daemon:{id:info.ID},document},{containerId:config.containerId});}catch{throw fail('ATTACH_PROFILE_REJECTED');}if(profile.state!=='running'||profile.running!==true||profile.pid<=0)throw fail('ATTACH_RUNTIME_NOT_RUNNING');
 const {socket,head}=await upgrade();check();clearTimeout(startupTimer);await notify({type:'Attached',containerId:config.containerId,daemonId:config.daemonId,connectionId:randomUUID()});attached=true;
 inputTask=pumpInput(socket).catch(e=>{if(!closing)abort(/^ATTACH_[A-Z_]+$/.test(e?.code)?e.code:'ATTACH_INPUT_FAILED');});let stderrBytes=0;
 for await(const frame of decodeDockerMultiplex(boundedSocket(socket,head))){try{if(frame.stream==='stdout')await write(process.stdout,frame.bytes);else{stderrBytes+=frame.bytes.length;if(stderrBytes>config.maxStderrBytes)throw fail('ATTACH_STDERR_LIMIT');}}finally{frame.bytes.fill(0);}}
 if(failure)throw fail(failure);exitCode=0;
}catch(error){failure??=/^ATTACH_[A-Z_]+$/.test(error?.code)?error.code:'ATTACH_PROXY_FAILED';}
finally{
 closing=true;clearTimeout(startupTimer);clearTimeout(eofTimer);configuration.destroy();raw?.destroy();agent?.shutdown();activeRequest?.destroy();process.stdin.destroy();
 if(inputTask){let timer;await Promise.race([inputTask,new Promise(resolve=>{timer=setTimeout(resolve,250);})]);clearTimeout(timer);}
 if(!attached)try{await notify({type:'Failed',code:failure??'ATTACH_PROXY_FAILED'});}catch{}
 control.destroy();
}
process.exit(exitCode);
