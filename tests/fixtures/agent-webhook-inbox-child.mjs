import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:https';
import {readFileSync,writeFileSync} from 'node:fs';
import {createAgentWebhookInbox} from '../../service/agent-webhook-inbox.mjs';
const [directory,mode,marker]=process.argv.slice(2),endpointId='awh_00000000-0000-4000-8000-000000000001';
let inbox;
try{inbox=createAgentWebhookInbox({directory,tenantId:'tenant-a',endpointId,keys:[{keyId:'fixture',secret:Buffer.alloc(32,0x57)}],activeKeyId:'fixture'});}catch(error){if(mode==='expect-locked'){process.send({event:'open-rejected',code:error.code},()=>process.exit(0));}else throw error;}
if(mode==='expect-locked'&&inbox){process.send({event:'unexpected-owner'},()=>{inbox.close();process.exit(1);});}
if(mode==='expect-locked'){await new Promise(()=>{});}

const exec=DatabaseSync.prototype.exec;let armed=false;
function killed(){writeFileSync(marker,mode+'\n',{flag:'wx',mode:0o600});process.kill(process.pid,'SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
DatabaseSync.prototype.exec=function(sql){if(armed&&sql==='COMMIT'&&mode==='before-commit')killed();const value=exec.call(this,sql);if(armed&&sql==='COMMIT'&&mode==='after-commit')killed();return value;};
const server=createServer({cert:readFileSync(new URL('./webhook-localhost-cert.pem',import.meta.url)),key:readFileSync(new URL('./webhook-localhost-key.pem',import.meta.url))},(req,res)=>{
 const chunks=[];let size=0;req.on('error',()=>{});req.on('data',chunk=>{size+=chunk.length;if(size>4096){req.destroy();return;}chunks.push(chunk);});
 req.on('end',()=>{try{armed=true;const result=inbox.accept({eventId:req.headers['remote-paint-event-id'],signature:req.headers['remote-paint-signature'],body:Buffer.concat(chunks)});armed=false;res.writeHead(result.status,{'content-type':'application/json'});res.end(JSON.stringify(result.ack));}catch{res.writeHead(400);res.end();}});
});server.on('clientError',(_e,socket)=>socket.destroy());
server.listen(0,'127.0.0.1',()=>process.send({event:'listening',url:'https://127.0.0.1:'+server.address().port+'/hook',identity:inbox.identity()}));
