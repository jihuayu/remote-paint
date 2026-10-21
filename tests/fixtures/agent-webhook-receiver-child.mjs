import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {createAgentWebhookReceiver} from '../../service/agent-webhook-receiver.mjs';
const [directory,mode,marker]=process.argv.slice(2),endpointId='awh_00000000-0000-4000-8000-000000000001';
const receiver=createAgentWebhookReceiver({directory,tenantId:'tenant-a',endpointId,keys:[{keyId:'fixture',secret:Buffer.alloc(32,0x57)}],activeKeyId:'fixture',cert:readFileSync(new URL('./webhook-localhost-cert.pem',import.meta.url)),key:readFileSync(new URL('./webhook-localhost-key.pem',import.meta.url))});
const exec=DatabaseSync.prototype.exec;let armed=false;
function killed(){writeFileSync(marker,mode+'\n',{flag:'wx',mode:0o600});process.kill(process.pid,'SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
DatabaseSync.prototype.exec=function(sql){if(armed&&sql==='COMMIT'&&mode==='before-commit')killed();const value=exec.call(this,sql);if(armed&&sql==='COMMIT'&&mode==='after-commit')killed();return value;};
const address=await receiver.listen();armed=true;process.send({event:'listening',url:'https://127.0.0.1:'+address.port+address.path,identity:receiver.identity()});
