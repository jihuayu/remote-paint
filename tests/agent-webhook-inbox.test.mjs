import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,chmod,rename,link,symlink,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:https';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {createAgentWebhookInbox} from '../service/agent-webhook-inbox.mjs';
import {createAgentWebhookAuthenticator} from '../service/agent-webhook-auth.mjs';
import {createAgentWebhookDispatcher} from '../service/agent-webhook-dispatcher.mjs';
import {SqliteSessionStore,sessionStoreSupported} from '../service/session-store.mjs';
import {readyRecords,activate,uuid} from './fixtures/session-agent-records.mjs';
import {receiver,cert,secret,endpointId,authConfig,digest} from './fixtures/agent-webhook-https.mjs';
import {withOwnedTestChild} from './owned-test-child.mjs';
const enabled={skip:!sessionStoreSupported},code=c=>({code:'AGENT_WEBHOOK_INBOX_'+c}),at='2026-10-21T07:00:00.000Z';
const value=(n=1)=>({schema:'agent-webhook-v1',endpointId,subscriptionId:'awsub_'+uuid(1),event:{schema:'agent-event-v1',eventId:'aevt_'+uuid(n),agentRunId:'arun_'+uuid(1),sessionId:'ses_'+uuid(1),region:'test',version:'v1',sequence:n,observedAt:at,type:'run.updated',data:{state:'active',holdsWriter:true,beginDispatch:'confirmed',endDispatch:'not-requested',error:null,closeEvidenceKind:null,stateUpdatedAt:at}}});
const config=directory=>({directory,tenantId:'tenant-a',...authConfig});
function signed(v=value(),{body=Buffer.from(JSON.stringify(v)),eventId=v.event.eventId,auth=authConfig}={}){const a=createAgentWebhookAuthenticator(auth);try{const s=a.sign({eventId,body});return {eventId,signature:s.headers['remote-paint-signature'],body:s.body};}finally{a.close();}}
async function fixture(t,options={}){const root=await mkdtemp(join(tmpdir(),'remote-paint-inbox-')),directory=join(root,'receiver'),cfg={...config(directory),...options};let inbox;t.after(async()=>{inbox?.close();await rm(root,{recursive:true,force:true});});inbox=createAgentWebhookInbox(cfg);return {root,directory,cfg,get inbox(){return inbox;},reopen(){inbox.close();inbox=createAgentWebhookInbox(cfg);return inbox;}};}
function send(url,row){return new Promise((resolve,reject)=>{const req=request(url,{method:'POST',agent:false,ca:cert,headers:{'content-type':'application/json','content-length':row.body.length,'remote-paint-event-id':row.eventId,'remote-paint-signature':row.signature}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.end(row.body);});}

test('authenticated inbox commits exact raw bytes before ACK and reopens with the same durable identity and dedup record',enabled,async t=>{
 const f=await fixture(t),row=signed(),identity=f.inbox.identity(),result=f.inbox.accept(row);assert.deepEqual(result,{status:202,duplicate:false,ack:{schema:'agent-webhook-ack-v1',eventId:row.eventId,bodySha256:digest(row.body)}});assert.deepEqual(f.inbox.read().events[0].envelope,value());f.reopen();assert.deepEqual(f.inbox.identity(),identity);assert.deepEqual(f.inbox.accept(signed()),{...result,status:200,duplicate:true});assert.equal(f.inbox.read().events.length,1);
});
test('same event ID with changed valid signed bytes conflicts without replacing the original acknowledgment',enabled,async t=>{
 const f=await fixture(t),row=signed();f.inbox.accept(row);const other=value();other.event.observedAt='2026-10-21T07:01:00.000Z';assert.throws(()=>f.inbox.accept(signed(other)),code('CONFLICT'));assert.equal(f.inbox.accept(signed()).status,200);assert.equal(f.inbox.read().events[0].bodySha256,digest(row.body));
});
test('inbox rejects different event IDs for one run sequence and immutable run/subscription identity changes',enabled,async t=>{
 const f=await fixture(t);f.inbox.accept(signed());for(const change of [v=>v.event.sequence=1,v=>v.subscriptionId='awsub_'+uuid(2),v=>v.event.sessionId='ses_'+uuid(2),v=>v.event.region='other',v=>v.event.version='other']){const v=value(2);change(v);assert.throws(()=>f.inbox.accept(signed(v)),code('CONFLICT'));}assert.equal(f.inbox.read().events.length,1);
});
test('forged stale wrong-endpoint and mismatched raw body signatures create no inbox rows',enabled,async t=>{
 const f=await fixture(t),row=signed(),bad=[{...row,signature:row.signature.slice(0,-1)+(row.signature.endsWith('0')?'1':'0')},{...row,body:Buffer.from('{}')},signed(value(),{auth:{...authConfig,endpointId:'awh_'+uuid(2)}}),signed(value(),{auth:{...authConfig,clock:()=>0}}),{...row,eventId:'aevt_'+uuid(2)}];
 for(const item of bad)assert.throws(()=>f.inbox.accept(item),code('AUTH'));assert.equal(f.inbox.read().events.length,0);
});
test('valid HMAC cannot authorize extra private fields malformed metadata or mismatched wire identities',enabled,async t=>{
 const f=await fixture(t);for(const change of [v=>v.tenant='private',v=>v.event.data.action={text:'private'},v=>v.event.data.receipt={stage:'business-success'},v=>v.endpointId='awh_'+uuid(2),v=>v.subscriptionId='awsub_x',v=>v.event.sequence=0,v=>v.event.data.holdsWriter=false]){const v=value();change(v);assert.throws(()=>f.inbox.accept(signed(v)),code('BODY'));}
 assert.throws(()=>f.inbox.accept(signed(value(),{eventId:'aevt_'+uuid(2)})),code('BODY'));assert.equal(f.inbox.read().events.length,0);
});
test('receiver requires canonical unambiguous strict UTF8 envelope bytes including duplicate keys and BOM rejection',enabled,async t=>{
 const f=await fixture(t),text=JSON.stringify(value());for(const body of [Buffer.from(' '+text),Buffer.from(text.replace('"schema":','"schema":"wrong","schema":')),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(text)]),Buffer.from([0xff]),Buffer.from(text.replace('"version":"v1"','"version":"v1","version":"v2"'))])assert.throws(()=>f.inbox.accept(signed(value(),{body})),code('BODY'));assert.equal(f.inbox.read().events.length,0);
});
test('inbox accepts supported Unicode metadata without changing signed bytes or original event identity',enabled,async t=>{
 const f=await fixture(t),v=value();v.event.region='雪'.repeat(64);v.event.version='界'.repeat(256);const row=signed(v);f.inbox.accept(row);f.reopen();assert.deepEqual(f.inbox.read().events[0].envelope,v);assert.equal(f.inbox.accept(row).ack.bodySha256,digest(row.body));
});
test('retention capacity rejects new events while still deduplicating the original head after restart',enabled,async t=>{
 const f=await fixture(t,{maxEvents:1});f.inbox.accept(signed());assert.throws(()=>f.inbox.accept(signed(value(2))),code('CAPACITY'));f.reopen();assert.equal(f.inbox.accept(signed()).status,200);assert.throws(()=>f.inbox.accept(signed(value(2))),code('CAPACITY'));assert.equal(f.inbox.read().events.length,1);
});
test('persisted tenant endpoint and retention policies cannot be silently rebound on reopen',enabled,async t=>{
 const f=await fixture(t);f.inbox.accept(signed());f.inbox.close();for(const change of [{tenantId:'tenant-b'},{endpointId:'awh_'+uuid(2)},{maxEvents:2048},{maxDatabaseBytes:32*1024*1024}])assert.throws(()=>createAgentWebhookInbox({...f.cfg,...change}),code('BINDING'));f.reopen();assert.equal(f.inbox.read().events.length,1);
});
test('bounded inbox read cursor returns detached ordered pages and rejects invalid observation options',enabled,async t=>{
 const f=await fixture(t);for(let n=1;n<=6;n++)f.inbox.accept(signed(value(n)));let page=f.inbox.read();assert.equal(page.nextCursor,4);assert.equal(page.hasMore,true);page.events[0].envelope.event.region='private';page=f.inbox.read({after:4});assert.deepEqual(page.events.map(e=>e.position),[5,6]);assert.equal(page.hasMore,false);assert.equal(f.inbox.read().events[0].envelope.event.region,'test');
 for(const options of [null,[],{after:null},{after:undefined},{after:-1},{limit:0},{limit:5},{limit:null},{extra:true}])assert.throws(()=>f.inbox.read(options),code('INVALID'));assert.throws(()=>f.inbox.read({after:7}),code('CURSOR'));
});
test('inbox validates plain configuration and requests without invoking getters or retaining caller keys',enabled,async t=>{
 const f=await fixture(t);let calls=0;assert.throws(()=>f.inbox.accept(Object.defineProperty(signed(),'body',{get(){calls++;return Buffer.from('{}');}})),code('INVALID'));assert.throws(()=>createAgentWebhookInbox(Object.defineProperty({...f.cfg},'keys',{get(){calls++;return [];} })),code('INVALID'));assert.equal(calls,0);
 const privateKey=Buffer.from(secret),other=createAgentWebhookInbox({...config(join(f.root,'other')),keys:[{keyId:'fixture',secret:privateKey}]});try{privateKey.fill(0);assert.equal(other.accept(signed()).status,202);}finally{other.close();}assert.equal(f.inbox.accept(signed()).status,202);f.inbox.close();assert.throws(()=>f.inbox.accept(signed()),code('CLOSED'));
});
test('concurrent receiver owners cannot open the same ledger and closed ownership can be reacquired',enabled,async t=>{
 const f=await fixture(t);f.inbox.accept(signed());assert.throws(()=>createAgentWebhookInbox(f.cfg),code('OPEN'));assert.equal(f.inbox.accept(signed()).status,200);f.reopen();assert.equal(f.inbox.accept(signed()).status,200);
});
test('receiver refuses public directories symlink databases and multiply linked existing ledgers',enabled,async t=>{
 const f=await fixture(t),publicDir=join(f.root,'public');await mkdir(publicDir,{mode:0o755});assert.throws(()=>createAgentWebhookInbox(config(publicDir)),code('IDENTITY'));const linked=join(f.root,'linked');await mkdir(linked,{mode:0o700});await symlink(join(f.directory,'inbox.sqlite'),join(linked,'inbox.sqlite'));assert.throws(()=>createAgentWebhookInbox(config(linked)),code('IDENTITY'));
 f.inbox.close();await link(join(f.directory,'inbox.sqlite'),join(f.root,'alias.sqlite'));assert.throws(()=>createAgentWebhookInbox(f.cfg),code('IDENTITY'));
});
test('original inode replacement or permissions change fences the live receiver without acknowledging new work',enabled,async t=>{
 for(const mode of ['replace','permissions']){const f=await fixture(t);f.inbox.accept(signed());const path=join(f.directory,'inbox.sqlite');if(mode==='replace'){await rename(path,path+'.saved');await writeFile(path,'private',{mode:0o600});}else await chmod(path,0o644);assert.throws(()=>f.inbox.accept(signed(value(2))),code('IDENTITY'));assert.throws(()=>f.inbox.read(),code('FAULTED'));}
});
test('valid schema with corrupt retained body or unexpected schema objects fails reopen without resetting history',enabled,async t=>{
 for(const mode of ['body','index']){const f=await fixture(t);f.inbox.accept(signed());f.inbox.close();const db=new DatabaseSync(join(f.directory,'inbox.sqlite'));try{if(mode==='body')db.prepare('UPDATE inbox SET body_sha256=?').run('0'.repeat(64));else db.exec('CREATE INDEX unexpected ON inbox(sequence)');}finally{db.close();}assert.throws(()=>createAgentWebhookInbox(f.cfg),code(mode==='body'?'CORRUPT':'SCHEMA'));}
});
test('an uncertain actual commit is fenced and exact restart reconciliation deduplicates its committed row',enabled,async t=>{
 const f=await fixture(t),exec=DatabaseSync.prototype.exec;let armed=true;DatabaseSync.prototype.exec=function(sql){const result=exec.call(this,sql);if(armed&&sql==='COMMIT'){armed=false;throw Error('private post-commit uncertainty');}return result;};try{assert.throws(()=>f.inbox.accept(signed()),code('WRITE_UNKNOWN'));}finally{DatabaseSync.prototype.exec=exec;}assert.throws(()=>f.inbox.accept(signed()),code('FAULTED'));f.reopen();assert.equal(f.inbox.accept(signed()).status,200);assert.equal(f.inbox.read().events.length,1);
});
test('actual signed HTTPS retry after receiver stores the event but loses its ACK leaves one durable inbox row',enabled,async t=>{
 const f=await fixture(t);let lost=false;const peer=await receiver(t,row=>{const result=f.inbox.accept({eventId:row.eventId,signature:row.headers['remote-paint-signature'],body:row.body});if(!lost){lost=true;row.res.destroy();return;}row.res.writeHead(result.status,{'content-type':'application/json'});row.res.end(JSON.stringify(result.ack));});
 const owner=Symbol(),source=new SqliteSessionStore({path:join(f.root,'source.sqlite'),enableAgentWebhooks:true});source.commit(readyRecords());source.claimAgentController(owner);const run=activate(source,owner);const worker=createAgentWebhookDispatcher({...authConfig,store:source,owner,tenantId:'tenant-a',url:peer.url,ca:cert,retryBaseMs:10,timeoutMs:2000});
 try{const sub=worker.subscribe({agentRunId:run.agentRunId,after:0}),result=await worker.deliver(sub.subscriptionId);assert.equal(result.status,'accepted');assert.equal(result.attempts,2);assert.equal(peer.requests.length,2);assert.equal(f.inbox.read().events.length,1);assert.equal(source.findAgentWriter(run.sessionId,{owner}).reserved,true);f.reopen();assert.equal(f.inbox.read().events.length,1);}finally{await worker.close();source.releaseAgentController(owner);source.close();}
});
for(const mode of ['before-commit','after-commit'])test('actual HTTPS receiver writer SIGKILL '+mode+' cannot forge acceptance and restart preserves dedup',enabled,async t=>{
 const root=await mkdtemp(join(tmpdir(),'remote-paint-inbox-kill-')),directory=join(root,'receiver'),marker=join(root,'marker');t.after(()=>rm(root,{recursive:true,force:true}));let identity;
 const spawn=mode=>fork(new URL('./fixtures/agent-webhook-inbox-child.mjs',import.meta.url),[directory,mode,marker],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});
 await withOwnedTestChild(()=>spawn(mode),async child=>{const [ready]=await once(child,'message',{signal:AbortSignal.timeout(5000)});identity=ready.identity;const died=once(child,'close');await assert.rejects(send(ready.url,signed()));const [,signal]=await died;assert.equal(signal,'SIGKILL');assert.equal(await readFile(marker,'utf8'),mode+'\n');});
 await withOwnedTestChild(()=>spawn('normal'),async child=>{const [ready]=await once(child,'message',{signal:AbortSignal.timeout(5000)});assert.deepEqual(ready.identity,identity);const first=await send(ready.url,signed());assert.equal(first.status,mode==='before-commit'?202:200);assert.equal((await send(ready.url,signed())).status,200);assert.equal(first.body.bodySha256,digest(signed().body));});
});

test('a rejected second in-process opener cannot release the original SQLite owner lock to a third process',enabled,async t=>{
 const f=await fixture(t);f.inbox.accept(signed());assert.throws(()=>createAgentWebhookInbox(f.cfg),code('OPEN'));
 await withOwnedTestChild(()=>fork(new URL('./fixtures/agent-webhook-inbox-child.mjs',import.meta.url),[f.directory,'expect-locked','unused'],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']}),async child=>{const [message]=await once(child,'message',{signal:AbortSignal.timeout(5000)});assert.deepEqual(message,{event:'open-rejected',code:'AGENT_WEBHOOK_INBOX_OPEN'});});
 assert.equal(f.inbox.accept(signed()).status,200);
});
