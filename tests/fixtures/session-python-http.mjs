import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {SessionRegistry} from '../../service/session-registry.mjs';
import {SqliteSessionStore} from '../../service/session-store.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../../service/session-http.mjs';
const path=process.argv[2],mode=process.argv[3]??'normal',key='fixture_python_backend_api_key_00000000';
let creates=0,closes=0,requests=0,dropSocket;
const store=new SqliteSessionStore({path:join(path,'state.sqlite')});
const registry=new SessionRegistry({store,providers:new Map([['test',{create:async()=>{creates++;if(dropSocket){dropSocket.destroy();dropSocket=null;}return {version:'python-fixture-v1'};},close:async()=>{closes++;return {status:'closed'};}}]]),defaultRegion:'test'});
const scopes=['sessions:create','sessions:read','sessions:release'];
const server=createSessionControlServer({registry,authenticate:createApiKeyAuthenticator([{apiKey:key,tenantId:'a',scopes},{apiKey:'fixture_python_other_backend_key_000000',tenantId:'b',scopes}])});
server.on('request',req=>{requests++;if(requests===1&&mode==='drop-first')dropSocket=req.socket;});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
console.log(JSON.stringify({event:'ready',port:server.address().port}));
let closing;
async function close(){if(closing)return closing;closing=(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));const outcome=await registry.shutdown();store.close();console.log(JSON.stringify({event:'closed',creates,closes,outcome}));})();return closing;}
const input=createInterface({input:process.stdin});
input.on('line',line=>{if(line==='stats')console.log(JSON.stringify({event:'stats',creates,closes,requests,...registry.stats()}));else if(line==='close')void close().then(()=>input.close());});
input.on('close',()=>{void close();});process.once('SIGTERM',()=>{void close().then(()=>input.close());});
