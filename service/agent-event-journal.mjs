import {randomUUID} from 'node:crypto';
import {AGENT_EVENT_MAX_BYTES,parseAgentEventBody} from './agent-event-schema.mjs';

export const AGENT_EVENT_FORMAT='remote-paint-agent-events-v1';
export const AGENT_EVENT_LIMITS=Object.freeze({retainedPerRun:64,eventBytes:AGENT_EVENT_MAX_BYTES,pageEvents:4,pageBytes:16384});
export const agentEventSchemaSql=`
 CREATE TABLE agent_event_heads(agent_run_id TEXT PRIMARY KEY,tenant TEXT NOT NULL,session_id TEXT NOT NULL,last_sequence INTEGER NOT NULL CHECK(last_sequence>=0 AND last_sequence<=9007199254740991),origin TEXT NOT NULL CHECK(origin IN ('created','migration-snapshot')),UNIQUE(agent_run_id,tenant,session_id),FOREIGN KEY(agent_run_id,tenant,session_id) REFERENCES agent_runs(agent_run_id,tenant,session_id)) STRICT;
 CREATE TABLE agent_events(agent_run_id TEXT NOT NULL,tenant TEXT NOT NULL,session_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=1 AND sequence<=9007199254740991),event_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=3072),PRIMARY KEY(agent_run_id,sequence),FOREIGN KEY(agent_run_id,tenant,session_id) REFERENCES agent_event_heads(agent_run_id,tenant,session_id)) STRICT;`;
const integer=(v,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const plain=(v,keys)=>!!v&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const runData=r=>({state:r.state,holdsWriter:r.reserved,beginDispatch:r.beginDispatch,endDispatch:r.endDispatch,error:r.error,closeEvidenceKind:r.closeEvidence?.kind??null,stateUpdatedAt:r.updatedAt});
const invocationData=r=>({invocationId:r.invocationId,tool:r.tool,state:r.state,dispatchStarted:r.dispatchStarted,receipt:r.receipt&&{stage:r.receipt.stage,inputs:r.receipt.inputs},error:r.error,stateUpdatedAt:r.updatedAt});

// Called only inside the existing Agent state transaction. Rows entering the
// projection have already passed that journal's identity/evidence validation.
export function createAgentEventJournal(db,{fail,onAppend=null}){
 const corrupt=()=>fail('STATE_CORRUPT','Invalid stored Agent event history');
 // Pure projection parsing only: exact original bytes, at most one 64-event
 // window. Database affinity/current parent checks below are never cached
 // across operations. Public callers receive clones; internal capture reads
 // can share these recursively frozen values after fresh validation.
 const parsedBodies=new Map();
 function parsed(body){
  let event=parsedBodies.get(body);if(event){parsedBodies.delete(body);parsedBodies.set(body,event);return event;}
  event=parseAgentEventBody(body);const freeze=value=>{for(const v of Object.values(value))if(v&&typeof v==='object')freeze(v);return Object.freeze(value);};freeze(event);parsedBodies.set(body,event);if(parsedBodies.size>AGENT_EVENT_LIMITS.retainedPerRun)parsedBodies.delete(parsedBodies.keys().next().value);return event;
 }

 function encode(value){const body=JSON.stringify(value);if(Buffer.byteLength(body)>AGENT_EVENT_LIMITS.eventBytes)fail('STATE_AGENT_LIMIT','Agent event metadata exceeds its byte limit');return body;}
 function parent(id){const row=db.prepare('SELECT agent_run_id,tenant,session_id,body FROM agent_runs WHERE agent_run_id=?').get(id);if(!row)corrupt();const value=JSON.parse(row.body);if(value.agentRunId!==row.agent_run_id||value.tenant!==row.tenant||value.sessionId!==row.session_id)corrupt();return value;}
 function head(run){const h=db.prepare('SELECT * FROM agent_event_heads WHERE agent_run_id=?').get(run.agentRunId);if(!h||h.tenant!==run.tenant||h.session_id!==run.sessionId||!integer(h.last_sequence,1)||!['created','migration-snapshot'].includes(h.origin))corrupt();return h;}
 function decode(stored,run,owners=null,projection=null){
  try{
   const e=projection??parseAgentEventBody(stored.body),d=e.data;
   if(e.eventId!==stored.event_id||e.agentRunId!==run.agentRunId||e.sessionId!==run.sessionId||e.region!==run.region||e.version!==run.version||stored.agent_run_id!==run.agentRunId||stored.tenant!==run.tenant||stored.session_id!==run.sessionId||e.sequence!==stored.sequence)corrupt();
   if(['run.updated','run.snapshot'].includes(e.type)){
    if(d.beginDispatch==='confirmed'&&run.beginDispatch!=='confirmed'||d.endDispatch==='confirmed'&&run.endDispatch!=='confirmed'||d.stateUpdatedAt<run.createdAt)corrupt();
   }else if(['invocation.updated','invocation.snapshot'].includes(e.type)){
    let pair=owners?.get(d.invocationId);if(!pair){if(owners)corrupt();const row=db.prepare('SELECT agent_run_id,tenant,session_id,body FROM agent_invocations WHERE invocation_id=?').get(d.invocationId);if(!row)corrupt();pair={row,current:JSON.parse(row.body)};}const {row:owner,current}=pair;if(owner.agent_run_id!==run.agentRunId||owner.tenant!==run.tenant||owner.session_id!==run.sessionId)corrupt();if(d.tool!==current.tool||d.stateUpdatedAt<current.createdAt||d.dispatchStarted&&!current.dispatchStarted||['injected','rejected','unknown'].includes(d.state)&&d.state!==current.state)corrupt();
   }else corrupt();
   return e;
  }catch{corrupt();}
 }
 function window(run){
  const h=head(run),rows=db.prepare('SELECT * FROM agent_events WHERE agent_run_id=? ORDER BY sequence LIMIT 65').all(run.agentRunId),first=Math.max(1,h.last_sequence-AGENT_EVENT_LIMITS.retainedPerRun+1);
  if(rows.length!==Math.min(h.last_sequence,AGENT_EVENT_LIMITS.retainedPerRun))corrupt();
  // Parse the bounded window first, then read its current invocation parents
  // in one parameterized query. This map lives only for this synchronous read.
  const projected=rows.map((row,i)=>{if(row.sequence!==first+i)corrupt();try{return parsed(row.body);}catch{corrupt();}}),ids=[...new Set(projected.filter(e=>e.type.startsWith('invocation.')).map(e=>e.data.invocationId))],owners=new Map();
  if(ids.length)for(const row of db.prepare('SELECT invocation_id,agent_run_id,tenant,session_id,body FROM agent_invocations WHERE invocation_id IN ('+ids.map(()=>'?').join(',')+')').all(...ids)){let current;try{current=JSON.parse(row.body);}catch{corrupt();}if(owners.has(row.invocation_id))corrupt();owners.set(row.invocation_id,{row,current});}
  const events=rows.map((row,i)=>decode(row,run,owners,projected[i]));return {h,first,events};
 }
 function captureValidatedWindow(run){const {h,first,events}=window(run);return Object.freeze({oldestSequence:first,latestSequence:h.last_sequence,events:Object.freeze(events)});}
 function append(run,type,data){
  const h=db.prepare('SELECT * FROM agent_event_heads WHERE agent_run_id=?').get(run.agentRunId);if(!h||h.tenant!==run.tenant||h.session_id!==run.sessionId||!integer(h.last_sequence,0))corrupt();
  if(h.last_sequence)window(run);
  const next=h.last_sequence+1;if(!integer(next,1))fail('STATE_AGENT_LIMIT','Agent event cursor exhausted');
  const e={schema:'agent-event-v1',eventId:'aevt_'+randomUUID(),agentRunId:run.agentRunId,sessionId:run.sessionId,region:run.region,version:run.version,sequence:next,observedAt:new Date().toISOString(),type,data},body=encode(e);
  onAppend?.(run,e);
  db.prepare('DELETE FROM agent_events WHERE agent_run_id=? AND sequence<=?').run(run.agentRunId,next-AGENT_EVENT_LIMITS.retainedPerRun);
  db.prepare('INSERT INTO agent_events VALUES(?,?,?,?,?,?)').run(run.agentRunId,run.tenant,run.sessionId,next,e.eventId,body);
  db.prepare('UPDATE agent_event_heads SET last_sequence=? WHERE agent_run_id=?').run(next,run.agentRunId);
 }
 return {
  captureValidatedWindow,
  captureWindow(run){return structuredClone(captureValidatedWindow(run));},
  validateCaptured(run,event){return decode({agent_run_id:run.agentRunId,tenant:run.tenant,session_id:run.sessionId,sequence:event?.sequence,event_id:event?.eventId,body:encode(event)},run);},
  seedSnapshots(){
   // A pre-extension ledger cannot supply a missing transition history. Seed
   // explicit observed snapshots, preserving original rows/revisions/identity.
   for(const stored of db.prepare('SELECT body FROM agent_runs ORDER BY agent_run_id').iterate()){
    const run=JSON.parse(stored.body);db.prepare('INSERT INTO agent_event_heads VALUES(?,?,?,?,?)').run(run.agentRunId,run.tenant,run.sessionId,0,'migration-snapshot');append(run,'run.snapshot',runData(run));
   }
   for(const stored of db.prepare('SELECT body FROM agent_invocations ORDER BY agent_run_id,invocation_id').iterate()){
    const row=JSON.parse(stored.body);append(parent(row.agentRunId),'invocation.snapshot',invocationData(row));
   }
  },
  run(row,old){
   if(!old)db.prepare('INSERT INTO agent_event_heads VALUES(?,?,?,?,?)').run(row.agentRunId,row.tenant,row.sessionId,0,'created');else head(row);
   if(!old||JSON.stringify(runData(old))!==JSON.stringify(runData(row)))append(row,'run.updated',runData(row));
  },
  invocation(row,run,old){head(run);if(!old||JSON.stringify(invocationData(old))!==JSON.stringify(invocationData(row)))append(run,'invocation.updated',invocationData(row));},
  validate(){
   for(const row of db.prepare('SELECT agent_run_id FROM agent_runs').iterate())window(parent(row.agent_run_id));
   if(db.prepare('SELECT 1 FROM agent_event_heads h LEFT JOIN agent_runs r USING(agent_run_id) WHERE r.agent_run_id IS NULL LIMIT 1').get()||db.prepare('SELECT 1 FROM agent_events e LEFT JOIN agent_event_heads h USING(agent_run_id) WHERE h.agent_run_id IS NULL LIMIT 1').get())corrupt();
  },
  read(run,options={}){
   try{const keys=Reflect.ownKeys(options);if(!plain(options,keys)||keys.some(k=>!['after','limit'].includes(k)))throw Error();}catch{fail('STATE_AGENT_INVALID','Invalid Agent event page');}
   const after=Object.hasOwn(options,'after')?options.after:0,limit=Object.hasOwn(options,'limit')?options.limit:AGENT_EVENT_LIMITS.pageEvents;if(!integer(after,0)||!integer(limit,1,AGENT_EVENT_LIMITS.pageEvents))fail('STATE_AGENT_INVALID','Invalid bounded Agent event cursor');
   const {h,first,events}=window(run);if(after>h.last_sequence)fail('STATE_AGENT_EVENT_CURSOR','Agent event cursor is ahead of its fixed run');const gap=after<first-1,selected=gap?[]:events.filter(e=>e.sequence>after).slice(0,limit),nextCursor=selected.at(-1)?.sequence??after;
   const result={schema:'agent-event-page-v1',agentRunId:run.agentRunId,sessionId:run.sessionId,region:run.region,version:run.version,historyOrigin:h.origin,after,oldestSequence:first,latestSequence:h.last_sequence,gap,events:selected,nextCursor,hasMore:nextCursor<h.last_sequence};
   if(Buffer.byteLength(JSON.stringify(result))>AGENT_EVENT_LIMITS.pageBytes)fail('STATE_AGENT_LIMIT','Agent event page exceeds its byte limit');return structuredClone(result);
  }
 };
}
