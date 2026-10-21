import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';

export const AGENT_WEBHOOK_FORMAT='remote-paint-agent-webhooks-v2';
export const AGENT_WEBHOOK_LIMITS=Object.freeze({subscriptions:64,perRun:4,pending:64,bodyBytes:4096,page:4,attempts:8});
export const agentWebhookSchemaSql=`
 CREATE TABLE agent_webhooks(subscription_id TEXT PRIMARY KEY,agent_run_id TEXT NOT NULL,tenant TEXT NOT NULL,session_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,start_after INTEGER NOT NULL,queued_through INTEGER NOT NULL,observed_latest INTEGER NOT NULL,missing_from INTEGER,accepted_through INTEGER NOT NULL DEFAULT 0,last_ack TEXT,UNIQUE(agent_run_id,endpoint_id),UNIQUE(subscription_id,agent_run_id,tenant,session_id),FOREIGN KEY(agent_run_id,tenant,session_id) REFERENCES agent_runs(agent_run_id,tenant,session_id)) STRICT;
 CREATE TABLE agent_webhook_deliveries(subscription_id TEXT NOT NULL,agent_run_id TEXT NOT NULL,tenant TEXT NOT NULL,session_id TEXT NOT NULL,sequence INTEGER NOT NULL,event_id TEXT NOT NULL,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=4096),body_sha256 TEXT NOT NULL,delivery_id TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,attempt_id TEXT,last_outcome TEXT,PRIMARY KEY(subscription_id,sequence),UNIQUE(subscription_id,event_id),FOREIGN KEY(subscription_id,agent_run_id,tenant,session_id) REFERENCES agent_webhooks(subscription_id,agent_run_id,tenant,session_id)) STRICT;
 CREATE UNIQUE INDEX agent_webhook_delivery_identity ON agent_webhook_deliveries(delivery_id);
 CREATE UNIQUE INDEX agent_webhook_attempt_identity ON agent_webhook_deliveries(attempt_id);`;
const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const id=(v,prefix)=>typeof v==='string'&&new RegExp('^'+prefix+'_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$').test(v);
const digest=body=>createHash('sha256').update(body).digest('hex');
const plain=(v,keys)=>!!v&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));

// Private transport bookkeeping. A trusted worker may report receiver
// acceptance only after its original transport settles. No Source/business
// outcome follows from that report; actual transport/dedup are separate layers.
export function createAgentWebhookJournal(db,{fail,isStoreError,events}){
 const corrupt=()=>fail('STATE_CORRUPT','Invalid stored Agent webhook capture');
 const reject=(code,message)=>fail('STATE_WEBHOOK_'+code,message);
 function revision(){const value=db.prepare("SELECT value FROM metadata WHERE name='agent_webhook_revision'").get()?.value,n=Number(value);if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||!integer(n))corrupt();return n;}
 function bump(){const next=revision()+1;if(!integer(next))reject('LIMIT','Webhook revision exhausted');db.prepare("UPDATE metadata SET value=? WHERE name='agent_webhook_revision'").run(String(next));}
 function transaction(action){try{db.exec('BEGIN IMMEDIATE');const value=action();db.exec('COMMIT');return structuredClone(value);}catch(error){try{db.exec('ROLLBACK');}catch{}if(isStoreError(error))throw error;fail('STATE_WEBHOOK_WRITE','Webhook capture transaction failed',error);}}
 function parent(s){const r=db.prepare('SELECT body FROM agent_runs WHERE agent_run_id=? AND tenant=? AND session_id=?').get(s.agent_run_id,s.tenant,s.session_id);if(!r)corrupt();return JSON.parse(r.body);}
 function rows(s){return db.prepare('SELECT * FROM agent_webhook_deliveries WHERE subscription_id=? ORDER BY sequence LIMIT 65').all(s.subscription_id);}
 function body(s,e){const text=JSON.stringify({schema:'agent-webhook-v1',endpointId:s.endpoint_id,subscriptionId:s.subscription_id,event:e});if(Buffer.byteLength(text)>AGENT_WEBHOOK_LIMITS.bodyBytes)reject('LIMIT','Webhook body exceeds its byte limit');return text;}
 function validate(s){
  if(!id(s.subscription_id,'awsub')||!id(s.endpoint_id,'awh')||!integer(s.start_after)||!integer(s.accepted_through,s.start_after)||!integer(s.queued_through,s.accepted_through)||!integer(s.observed_latest,s.queued_through)||s.queued_through-s.accepted_through>AGENT_WEBHOOK_LIMITS.pending||!(s.missing_from===null?s.observed_latest===s.queued_through:s.missing_from===s.queued_through+1&&s.observed_latest>=s.missing_from))corrupt();
  let ack=null;if(s.last_ack!==null){try{if(typeof s.last_ack!=='string'||Buffer.byteLength(s.last_ack)>512)corrupt();ack=JSON.parse(s.last_ack);}catch{corrupt();}if(!plain(ack,['deliveryId','attemptId','eventId','sequence','bodySha256','attempts'])||!id(ack.deliveryId,'awdl')||!id(ack.attemptId,'awat')||!id(ack.eventId,'aevt')||!integer(ack.sequence,1)||ack.sequence!==s.accepted_through||typeof ack.bodySha256!=='string'||!/^([a-f0-9]{64})$/.test(ack.bodySha256)||!integer(ack.attempts,1)||ack.attempts>AGENT_WEBHOOK_LIMITS.attempts||JSON.stringify(ack)!==s.last_ack)corrupt();}
  if((s.accepted_through===s.start_after)!==(ack===null))corrupt();
  const run=parent(s),head=events.captureWindow(run);if(s.observed_latest!==head.latestSequence)corrupt();
  const pending=rows(s);if(pending.length!==s.queued_through-s.accepted_through)corrupt();
  for(const [i,r]of pending.entries()){
   if(r.sequence!==s.accepted_through+i+1||r.agent_run_id!==s.agent_run_id||r.tenant!==s.tenant||r.session_id!==s.session_id||typeof r.body!=='string'||Buffer.byteLength(r.body)>AGENT_WEBHOOK_LIMITS.bodyBytes||r.body_sha256!==digest(r.body)||!id(r.delivery_id,'awdl')||!integer(r.attempts)||r.attempts>AGENT_WEBHOOK_LIMITS.attempts||i>0&&r.attempts!==0||!(r.attempts===0?r.attempt_id===null&&r.last_outcome===null:id(r.attempt_id,'awat')&&['requested','unknown','not-accepted'].includes(r.last_outcome))||ack&&(r.delivery_id===ack.deliveryId||r.attempt_id===ack.attemptId||r.event_id===ack.eventId))corrupt();
   let value;try{value=JSON.parse(r.body);}catch{corrupt();}
   if(!plain(value,['schema','endpointId','subscriptionId','event'])||value.schema!=='agent-webhook-v1'||value.endpointId!==s.endpoint_id||value.subscriptionId!==s.subscription_id||value.event?.eventId!==r.event_id||value.event?.sequence!==r.sequence||body(s,value.event)!==r.body)corrupt();
   events.validateCaptured(run,value.event);
   const retained=head.events.find(e=>e.sequence===r.sequence);if(retained&&JSON.stringify(retained)!==JSON.stringify(value.event))corrupt();
  }
  return pending;
 }
 function info(s){return {schema:'agent-webhook-capture-v2',subscriptionId:s.subscription_id,agentRunId:s.agent_run_id,sessionId:s.session_id,endpointId:s.endpoint_id,after:s.start_after,acceptedThrough:s.accepted_through,queuedThrough:s.queued_through,observedLatest:s.observed_latest,pending:s.queued_through-s.accepted_through,reconciliationRequired:s.missing_from!==null,missingFrom:s.missing_from,missingThrough:s.missing_from===null?null:s.observed_latest};}
 function enqueue(s,e){const text=body(s,e);db.prepare('INSERT INTO agent_webhook_deliveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(s.subscription_id,s.agent_run_id,s.tenant,s.session_id,e.sequence,e.eventId,text,digest(text),'awdl_'+randomUUID(),0,null,null);s.queued_through=e.sequence;}
 function subscription(subscriptionId,tenant){if(!id(subscriptionId,'awsub')||typeof tenant!=='string')reject('INVALID','Invalid fixed webhook reference');const s=db.prepare('SELECT * FROM agent_webhooks WHERE subscription_id=? AND tenant=?').get(subscriptionId,tenant);if(!s)reject('REFERENCE','Webhook capture is unavailable');return s;}
 function attempt(r){return {deliveryId:r.delivery_id,attemptId:r.attempt_id,eventId:r.event_id,sequence:r.sequence,bodySha256:r.body_sha256,attempts:r.attempts};}
 return {
  validate(){revision();const all=db.prepare('SELECT * FROM agent_webhooks ORDER BY subscription_id LIMIT 65').all();if(all.length>AGENT_WEBHOOK_LIMITS.subscriptions)corrupt();const counts=new Map();for(const s of all){const n=(counts.get(s.agent_run_id)??0)+1;counts.set(s.agent_run_id,n);if(n>AGENT_WEBHOOK_LIMITS.perRun)corrupt();validate(s);}if(db.prepare('SELECT 1 FROM agent_webhook_deliveries d LEFT JOIN agent_webhooks s USING(subscription_id) WHERE s.subscription_id IS NULL LIMIT 1').get())corrupt();},
  head(){return {revision:revision()};},
  list(tenant,options){
   let keys;try{if(!options||types.isProxy(options))throw Error();keys=Reflect.ownKeys(options);if(!plain(options,keys)||!Object.hasOwn(options,'endpointId')||keys.some(k=>!['endpointId','after','limit'].includes(k)))throw Error();}catch{reject('INVALID','Invalid bounded endpoint subscription page');}
   const endpointId=options.endpointId,after=Object.hasOwn(options,'after')?options.after:'',limit=Object.hasOwn(options,'limit')?options.limit:AGENT_WEBHOOK_LIMITS.page;
   if(typeof tenant!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(tenant)||!id(endpointId,'awh')||typeof after!=='string'||after!==''&&!id(after,'awsub')||!integer(limit,1)||limit>AGENT_WEBHOOK_LIMITS.page)reject('INVALID','Invalid bounded endpoint subscription cursor');
   if(after&&subscription(after,tenant).endpoint_id!==endpointId)reject('REFERENCE','Subscription cursor belongs to another endpoint');
   const rows=db.prepare('SELECT * FROM agent_webhooks WHERE tenant=? AND endpoint_id=? AND subscription_id>? ORDER BY subscription_id LIMIT ?').all(tenant,endpointId,after,limit+1),selected=rows.slice(0,limit);
   const subscriptions=selected.map(s=>{const head=validate(s)[0];return {...info(s),head:head?{eventId:head.event_id,sequence:head.sequence,attempts:head.attempts,lastOutcome:head.last_outcome}:null};});
   return structuredClone({schema:'agent-webhook-subscriptions-v1',endpointId,revision:revision(),after,subscriptions,nextCursor:selected.at(-1)?.subscription_id??after,hasMore:rows.length>selected.length});
  },
  assertRelease(){if(db.prepare("SELECT 1 FROM agent_webhook_deliveries WHERE last_outcome='requested' LIMIT 1").get())reject('IN_FLIGHT','Original webhook attempt has not settled');},
  recover(){if(!db.prepare("SELECT 1 FROM agent_webhook_deliveries WHERE last_outcome='requested' LIMIT 1").get())return;transaction(()=>{db.exec("UPDATE agent_webhook_deliveries SET last_outcome='unknown' WHERE last_outcome='requested'");bump();});},
  begin(subscriptionId,tenant){return transaction(()=>{const s=subscription(subscriptionId,tenant),r=validate(s)[0];if(!r)return {capture:info(s),attempt:null};if(r.last_outcome==='requested')reject('IN_FLIGHT','Original webhook attempt has not settled');if(r.attempts>=AGENT_WEBHOOK_LIMITS.attempts)reject('EXHAUSTED','Original webhook head exhausted its attempts');r.attempts++;r.attempt_id='awat_'+randomUUID();db.prepare("UPDATE agent_webhook_deliveries SET attempts=?,attempt_id=?,last_outcome='requested' WHERE delivery_id=?").run(r.attempts,r.attempt_id,r.delivery_id);bump();return {capture:info(s),attempt:{...attempt(r),body:r.body}};});},
  settle(subscriptionId,tenant,options){
   if(!plain(options,['deliveryId','attemptId','bodySha256','outcome','transportSettled'])||!id(options.deliveryId,'awdl')||!id(options.attemptId,'awat')||typeof options.bodySha256!=='string'||!/^([a-f0-9]{64})$/.test(options.bodySha256)||!['accepted','not-accepted','unknown'].includes(options.outcome)||options.transportSettled!==true)reject('INVALID','Invalid original settled webhook attempt');
   return transaction(()=>{const s=subscription(subscriptionId,tenant),r=validate(s)[0],ack=s.last_ack===null?null:JSON.parse(s.last_ack);const matches=x=>x&&x.deliveryId===options.deliveryId&&x.attemptId===options.attemptId&&x.bodySha256===options.bodySha256;
    if(matches(ack)&&options.outcome==='accepted')return {capture:info(s),duplicate:true};
    if(!r||!matches(attempt(r)))reject('STALE_ATTEMPT','Webhook receipt does not own the original head');
    if(r.last_outcome!=='requested'){if(r.last_outcome===options.outcome)return {capture:info(s),duplicate:true};reject('STALE_ATTEMPT','Webhook receipt cannot rewrite a settled attempt');}
    if(options.outcome==='accepted'){s.accepted_through=r.sequence;s.last_ack=JSON.stringify(attempt(r));db.prepare('DELETE FROM agent_webhook_deliveries WHERE delivery_id=?').run(r.delivery_id);db.prepare('UPDATE agent_webhooks SET accepted_through=?,last_ack=? WHERE subscription_id=?').run(s.accepted_through,s.last_ack,s.subscription_id);}
    else db.prepare('UPDATE agent_webhook_deliveries SET last_outcome=? WHERE delivery_id=?').run(options.outcome,r.delivery_id);
    bump();return {capture:info(s),duplicate:false};
   });
  },
  subscribe(run,options){
   if(!plain(options,['endpointId','after'])||!id(options.endpointId,'awh')||!integer(options.after))reject('INVALID','Invalid fixed webhook subscription');
   return transaction(()=>{
    const old=db.prepare('SELECT * FROM agent_webhooks WHERE agent_run_id=? AND endpoint_id=?').get(run.agentRunId,options.endpointId);
    if(old){validate(old);if(old.start_after!==options.after)reject('CONFLICT','Webhook subscription cursor is immutable');return info(old);}
    const head=events.captureWindow(run);if(options.after>head.latestSequence||options.after<head.oldestSequence-1)reject('CURSOR','Webhook capture requires available contiguous original history');
    if(db.prepare('SELECT count(*) AS n FROM agent_webhooks').get().n>=AGENT_WEBHOOK_LIMITS.subscriptions||db.prepare('SELECT count(*) AS n FROM agent_webhooks WHERE agent_run_id=?').get(run.agentRunId).n>=AGENT_WEBHOOK_LIMITS.perRun)reject('LIMIT','Webhook subscription capacity exceeded');
    const s={subscription_id:'awsub_'+randomUUID(),agent_run_id:run.agentRunId,tenant:run.tenant,session_id:run.sessionId,endpoint_id:options.endpointId,start_after:options.after,queued_through:options.after,observed_latest:head.latestSequence,missing_from:null,accepted_through:options.after,last_ack:null};
    db.prepare('INSERT INTO agent_webhooks VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(s.subscription_id,s.agent_run_id,s.tenant,s.session_id,s.endpoint_id,s.start_after,s.queued_through,s.observed_latest,s.missing_from,s.accepted_through,s.last_ack);
    for(const e of head.events)if(e.sequence>options.after)enqueue(s,e);
    db.prepare('UPDATE agent_webhooks SET queued_through=? WHERE subscription_id=?').run(s.queued_through,s.subscription_id);bump();return info(s);
   });
  },
  append(run,e){
   // Called inside the original Agent state/event transaction, never nested.
   const subscriptions=db.prepare('SELECT * FROM agent_webhooks WHERE agent_run_id=? ORDER BY subscription_id LIMIT 5').all(run.agentRunId);if(subscriptions.length>AGENT_WEBHOOK_LIMITS.perRun)corrupt();
   for(const s of subscriptions){
    validate(s);
    if(s.tenant!==run.tenant||s.session_id!==run.sessionId||s.observed_latest!==e.sequence-1)corrupt();
    if(s.missing_from===null){if(s.queued_through-s.accepted_through===AGENT_WEBHOOK_LIMITS.pending)s.missing_from=e.sequence;else enqueue(s,e);}
    db.prepare('UPDATE agent_webhooks SET queued_through=?,observed_latest=?,missing_from=? WHERE subscription_id=?').run(s.queued_through,e.sequence,s.missing_from,s.subscription_id);
   }
   if(subscriptions.length)bump();
  },
  read(subscriptionId,tenant,options={}){
   let keys;try{keys=options&&Reflect.ownKeys(options);if(!keys||!plain(options,keys)||keys.some(k=>!['after','limit'].includes(k)))throw Error();}catch{reject('INVALID','Invalid webhook capture page');}
   const s=subscription(subscriptionId,tenant);
   const after=Object.hasOwn(options,'after')?options.after:s.accepted_through,limit=Object.hasOwn(options,'limit')?options.limit:AGENT_WEBHOOK_LIMITS.page;if(!integer(after,s.accepted_through)||after>s.queued_through||!integer(limit,1)||limit>AGENT_WEBHOOK_LIMITS.page)reject('CURSOR','Invalid bounded webhook capture cursor');
   const pending=validate(s).filter(r=>r.sequence>after).slice(0,limit).map(r=>({...attempt(r),body:r.body,lastOutcome:r.last_outcome}));
   return structuredClone({...info(s),revision:revision(),deliveries:pending,nextCursor:pending.at(-1)?.sequence??after,hasMore:(pending.at(-1)?.sequence??after)<s.queued_through});
  }
 };
}
