import {createHash} from 'node:crypto';

// Private control-plane metadata in the Session ledger. A stored receipt hash
// identifies caller-validated evidence; it does not prove a remote side effect.
export const agentSchemaSql=`
 CREATE TABLE agent_runs(agent_run_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,tenant TEXT NOT NULL,key_hash TEXT NOT NULL,reserved INTEGER NOT NULL CHECK(reserved IN (0,1)),body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=8192),UNIQUE(tenant,key_hash),UNIQUE(agent_run_id,tenant,session_id),FOREIGN KEY(session_id,tenant) REFERENCES sessions(session_id,tenant)) STRICT;
 CREATE UNIQUE INDEX agent_run_single_writer ON agent_runs(session_id) WHERE reserved=1;
 CREATE TABLE agent_invocations(invocation_id TEXT PRIMARY KEY,agent_run_id TEXT NOT NULL,tenant TEXT NOT NULL,session_id TEXT NOT NULL,key_hash TEXT NOT NULL,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=8192),UNIQUE(agent_run_id,tenant,key_hash),FOREIGN KEY(agent_run_id,tenant,session_id) REFERENCES agent_runs(agent_run_id,tenant,session_id),FOREIGN KEY(session_id,tenant) REFERENCES sessions(session_id,tenant)) STRICT;`;
const plain=(v,keys)=>!!v&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const prefixed=(v,prefix)=>typeof v==='string'&&v.startsWith(prefix)&&uuid(v.slice(prefix.length));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const tenant=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const bounded=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max;
const date=v=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const agentNeverDispatchedDigest=row=>digest({schema:'agent-run-never-dispatched-v1',agentRunId:row.agentRunId,tenant:row.tenant,sessionId:row.sessionId,createKeyHash:row.createKeyHash,fingerprint:row.fingerprint});
export const agentTerminalSessionDigest=row=>digest({schema:'agent-terminal-session-v1',session:row});
const runKeys=['agentRunId','sessionId','tenant','region','version','createKeyHash','fingerprint','state','reserved','beginDispatch','binding','beginResultHash','endDispatch','closeEvidence','error','createdAt','updatedAt'];
const invocationKeys=['invocationId','agentRunId','sessionId','tenant','keyHash','fingerprint','tool','fence','state','dispatchStarted','receipt','error','createdAt','updatedAt'];
const runImmutable=['agentRunId','sessionId','tenant','region','version','createKeyHash','fingerprint','createdAt'];
const invocationImmutable=['invocationId','agentRunId','sessionId','tenant','keyHash','fingerprint','tool','fence','createdAt'];
const transitions={intent:['starting','closed'],starting:['active','closing','recovery-required','closed'],active:['closing','recovery-required','closed'],closing:['closing','recovery-required','closed'],'recovery-required':['closing','recovery-required','closed'],closed:[]};
const terminalInvocation=new Set(['injected','rejected','unknown']);
const terminalSession=new Set(['closed','expired']);
const tools=new Set(['click','move','drag','scroll','press','insertText','composition']);
const dispatch=new Set(['not-requested','requested','confirmed']);
export function createSessionAgentJournal(db,{fail,isStoreError,validateSession,maxAgentRuns,maxAgentInvocations}){
 let owner=null,recoveryRuns=new Set(),recoveryParents=new Set();
 const reject=(code,message)=>fail('STATE_AGENT_'+code,message);
 const encode=row=>{const body=JSON.stringify(row);if(Buffer.byteLength(body)>8192)reject('LIMIT','Agent metadata exceeds 8192 bytes');return body;};
 function errorRecord(value){if(value===null)return null;if(!plain(value,['code','outcome'])||typeof value.code!=='string'||!/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)||!['not-dispatched','unknown'].includes(value.outcome))reject('INVALID','Invalid bounded Agent error');return {code:value.code,outcome:value.outcome};}
 function runRecord(row){
  if(!plain(row,runKeys)||!prefixed(row.agentRunId,'arun_')||!id(row.sessionId)||!tenant(row.tenant)||!bounded(row.region,64)||!bounded(row.version,256)||!hash(row.createKeyHash)||!hash(row.fingerprint)||typeof row.state!=='string'||!Object.hasOwn(transitions,row.state)||typeof row.reserved!=='boolean'||!dispatch.has(row.beginDispatch)||!dispatch.has(row.endDispatch)||!(row.beginResultHash===null||hash(row.beginResultHash))||!date(row.createdAt)||!date(row.updatedAt)||row.updatedAt<row.createdAt)reject('INVALID','Invalid Agent run metadata');
  if(row.binding!==null&&(!plain(row.binding,['workerRunId','targetId','controlSessionId'])||!prefixed(row.binding.workerRunId,'run_')||!prefixed(row.binding.targetId,'target_')||!uuid(row.binding.controlSessionId)))reject('INVALID','Invalid fixed worker run binding');
  if(row.closeEvidence!==null&&(!plain(row.closeEvidence,['kind','evidenceSha256'])||!['never-dispatched','begin-rejected','worker-run-closed','session-terminal'].includes(row.closeEvidence.kind)||!hash(row.closeEvidence.evidenceSha256)))reject('INVALID','Invalid Agent run closure evidence');
  const error=errorRecord(row.error);
  if((row.state==='closed')!==!row.reserved||(row.state==='closed')!==(row.closeEvidence!==null)||(row.beginDispatch==='confirmed')!==(row.binding!==null)||row.beginDispatch==='confirmed'&&!hash(row.beginResultHash)||row.beginDispatch!=='confirmed'&&row.beginResultHash!==null&&row.closeEvidence?.kind!=='begin-rejected'||row.endDispatch!=='not-requested'&&row.binding===null)reject('INVALID','Agent run phase and binding disagree');
  if(row.state==='intent'&&(row.beginDispatch!=='not-requested'||row.endDispatch!=='not-requested'||error!==null)||row.state==='starting'&&(row.beginDispatch!=='requested'||row.endDispatch!=='not-requested'||error!==null)||row.state==='active'&&(row.beginDispatch!=='confirmed'||row.endDispatch!=='not-requested'||error!==null)||row.endDispatch==='requested'&&!['closing','recovery-required','closed'].includes(row.state)||row.endDispatch==='confirmed'&&(row.state!=='closed'||row.closeEvidence.kind!=='worker-run-closed'))reject('INVALID','Agent dispatch and outcome disagree');
  if(row.state==='closed'){
   const kind=row.closeEvidence.kind;
   if(kind==='never-dispatched'&&(row.beginDispatch!=='not-requested'||row.endDispatch!=='not-requested'||error!==null||row.closeEvidence.evidenceSha256!==agentNeverDispatchedDigest(row))||kind==='begin-rejected'&&(row.beginDispatch!=='requested'||row.binding!==null||row.endDispatch!=='not-requested'||error?.outcome!=='not-dispatched'||row.beginResultHash!==row.closeEvidence.evidenceSha256)||kind==='worker-run-closed'&&(row.binding===null||row.endDispatch!=='confirmed'))reject('INVALID','Agent closure evidence disagrees with dispatch history');
  }else if(error!==null&&(!['closing','recovery-required'].includes(row.state)||error.outcome!=='unknown'))reject('INVALID','Uncertain Agent run must remain reserved');
  const copy={...Object.fromEntries(runKeys.map(k=>[k,row[k]])),binding:row.binding&&Object.fromEntries(['workerRunId','targetId','controlSessionId'].map(k=>[k,row.binding[k]])),closeEvidence:row.closeEvidence&&{kind:row.closeEvidence.kind,evidenceSha256:row.closeEvidence.evidenceSha256},error};encode(copy);return copy;
 }
 function invocationRecord(row){
  if(!plain(row,invocationKeys)||!prefixed(row.invocationId,'ainv_')||!prefixed(row.agentRunId,'arun_')||!id(row.sessionId)||!tenant(row.tenant)||!hash(row.keyHash)||!hash(row.fingerprint)||!tools.has(row.tool)||!plain(row.fence,['controlSessionId','controlVersion','pageEpoch','viewportVersion'])||!uuid(row.fence.controlSessionId)||!Number.isSafeInteger(row.fence.controlVersion)||row.fence.controlVersion<0||![row.fence.pageEpoch,row.fence.viewportVersion].every(n=>Number.isSafeInteger(n)&&n>=1)||!['intent','requested',...terminalInvocation].includes(row.state)||typeof row.dispatchStarted!=='boolean'||!date(row.createdAt)||!date(row.updatedAt)||row.updatedAt<row.createdAt)reject('INVALID','Invalid Agent invocation metadata');
  const error=errorRecord(row.error);
  if(row.state==='injected'){
   if(!row.dispatchStarted||error!==null||!plain(row.receipt,['stage','inputs','evidenceSha256'])||row.receipt.stage!=='input-injected'||!Number.isSafeInteger(row.receipt.inputs)||row.receipt.inputs<1||row.receipt.inputs>32||!hash(row.receipt.evidenceSha256))reject('INVALID','Injection receipt is not a business success assertion');
  }else if(row.receipt!==null)reject('INVALID','Only acknowledged injection can carry a receipt');
  if(row.state==='intent'&&(row.dispatchStarted||error!==null)||row.state==='requested'&&(!row.dispatchStarted||error!==null)||row.state==='rejected'&&error?.outcome!=='not-dispatched'||row.state==='unknown'&&(!row.dispatchStarted||error?.outcome!=='unknown'))reject('INVALID','Invocation dispatch and outcome disagree');
  const copy={...Object.fromEntries(invocationKeys.map(k=>[k,row[k]])),fence:Object.fromEntries(['controlSessionId','controlVersion','pageEpoch','viewportVersion'].map(k=>[k,row.fence[k]])),receipt:row.receipt&&{stage:row.receipt.stage,inputs:row.receipt.inputs,evidenceSha256:row.receipt.evidenceSha256},error};encode(copy);return copy;
 }
 function decode(body,validate){try{if(typeof body!=='string'||Buffer.byteLength(body)>8192)throw Error('Invalid record size');return validate(JSON.parse(body));}catch(error){fail('STATE_CORRUPT','Invalid stored Agent metadata',error);}}
 function revision(){const value=db.prepare("SELECT value FROM metadata WHERE name='agent_revision'").get()?.value,n=Number(value);if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||!Number.isSafeInteger(n))fail('STATE_CORRUPT','Invalid Agent ledger revision');return n;}
 function counts(){if(db.prepare('SELECT count(*) AS n FROM agent_runs').get().n>maxAgentRuns||db.prepare('SELECT count(*) AS n FROM agent_invocations').get().n>maxAgentInvocations)reject('LIMIT','Agent ledger retention capacity exceeded');}
 function session(id){const stored=db.prepare('SELECT session_id,tenant,body FROM sessions WHERE session_id=?').get(id);if(!stored)return null;const row=decode(stored.body,validateSession);if(row.sessionId!==stored.session_id||row.tenant!==stored.tenant)fail('STATE_CORRUPT','Agent parent Session index disagrees');return row;}
 function run(id){const stored=db.prepare('SELECT * FROM agent_runs WHERE agent_run_id=?').get(id);if(!stored)return null;const row=decode(stored.body,runRecord);if(row.agentRunId!==stored.agent_run_id||row.sessionId!==stored.session_id||row.tenant!==stored.tenant||row.createKeyHash!==stored.key_hash||Number(row.reserved)!==stored.reserved)fail('STATE_CORRUPT','Agent run index disagrees');return row;}
 function invocation(id){const stored=db.prepare('SELECT * FROM agent_invocations WHERE invocation_id=?').get(id);if(!stored)return null;const row=decode(stored.body,invocationRecord);if(row.invocationId!==stored.invocation_id||row.agentRunId!==stored.agent_run_id||row.sessionId!==stored.session_id||row.tenant!==stored.tenant||row.keyHash!==stored.key_hash)fail('STATE_CORRUPT','Agent invocation index disagrees');return row;}
 function runReference(row){const parent=session(row.sessionId);if(!parent||row.tenant!==parent.tenant||row.region!==parent.region||row.version!==parent.version)reject('REFERENCE','Agent run disagrees with its fixed Session');if(row.closeEvidence?.kind==='session-terminal'&&(!terminalSession.has(parent.state)||parent.reserved||row.closeEvidence.evidenceSha256!==agentTerminalSessionDigest(parent)))reject('REFERENCE','Agent closure requires actual terminal Session evidence');return parent;}
 function invocationReference(row){const parent=run(row.agentRunId);if(!parent||parent.sessionId!==row.sessionId||parent.tenant!==row.tenant||parent.binding?.controlSessionId!==row.fence.controlSessionId)reject('REFERENCE','Invocation disagrees with its fixed run and control identity');runReference(parent);return parent;}
 function ready(parent){if(parent.state!=='ready'||!parent.reserved)reject('REFERENCE','New Agent dispatch requires its current reserved Ready Session');}
 function authorize(value){if(typeof value!=='symbol'||owner!==value)reject('OWNER','Agent controller owner is missing or stale');}
 function readRun(id){const row=run(id);if(row)runReference(row);return row;}
 function readInvocation(id){const row=invocation(id);if(row)invocationReference(row);return row;}
 function uniqueRun(sql,...args){const values=db.prepare(sql).all(...args);if(values.length>1)fail('STATE_CORRUPT','Agent lookup has multiple identities');return values.length?readRun(values[0].agent_run_id):null;}
 function transaction(action){try{db.exec('BEGIN IMMEDIATE');const value=action();counts();const next=revision()+1;if(!Number.isSafeInteger(next))reject('LIMIT','Agent revision exhausted');db.prepare("UPDATE metadata SET value=? WHERE name='agent_revision'").run(String(next));db.exec('COMMIT');return structuredClone({revision:next,...value});}catch(error){try{db.exec('ROLLBACK');}catch{}if(isStoreError(error))throw error;fail('STATE_AGENT_WRITE','Agent metadata transaction failed',error);}}
 function validate(){counts();revision();for(const value of db.prepare('SELECT agent_run_id FROM agent_runs').iterate())runReference(run(value.agent_run_id));for(const value of db.prepare('SELECT invocation_id FROM agent_invocations').iterate())invocationReference(invocation(value.invocation_id));if(db.prepare('SELECT session_id FROM agent_runs WHERE reserved=1 GROUP BY session_id HAVING count(*)>1 LIMIT 1').get())fail('STATE_CORRUPT','Multiple Agent writers reserve the same Session');}
 return {
  get claimed(){return owner!==null;},validate,
  claim(value,{compact=false}={}){if(typeof value!=='symbol')throw TypeError('Expected an opaque Agent controller owner');if(owner!==null&&owner!==value)reject('OWNER','Agent controller already has an owner');validate();if(owner===null){recoveryRuns.clear();recoveryParents.clear();for(const row of db.prepare('SELECT agent_run_id,reserved FROM agent_runs').iterate()){recoveryParents.add(row.agent_run_id);if(row.reserved)recoveryRuns.add(row.agent_run_id);}owner=value;}return compact?{revision:revision(),recoveryRequired:[...recoveryRuns].sort()}:this.snapshot(value);},
  release(value){authorize(value);owner=null;recoveryRuns.clear();recoveryParents.clear();},
  head(value){authorize(value);return {revision:revision()};},
  getRun(id,value){authorize(value);return readRun(id);},
  findRun(tenant,keyHash,value){authorize(value);return uniqueRun('SELECT agent_run_id FROM agent_runs WHERE tenant=? AND key_hash=? LIMIT 2',tenant,keyHash);},
  writer(sessionId,value){authorize(value);return uniqueRun('SELECT agent_run_id FROM agent_runs WHERE session_id=? AND reserved=1 LIMIT 2',sessionId);},
  getInvocation(id,value){authorize(value);return readInvocation(id);},
  findInvocation(agentRunId,tenant,keyHash,value){authorize(value);const rows=db.prepare('SELECT invocation_id FROM agent_invocations WHERE agent_run_id=? AND tenant=? AND key_hash=? LIMIT 2').all(agentRunId,tenant,keyHash);if(rows.length>1)fail('STATE_CORRUPT','Invocation lookup has multiple identities');return rows.length?readInvocation(rows[0].invocation_id):null;},
  list(kind,{afterId='',limit=64,reservedOnly=false,unfinishedOnly=false}={},value){
   authorize(value);if(!['runs','invocations'].includes(kind)||typeof afterId!=='string'||afterId.length>128||!Number.isInteger(limit)||limit<1||limit>256||typeof reservedOnly!=='boolean'||typeof unfinishedOnly!=='boolean'||kind==='runs'&&unfinishedOnly||kind==='invocations'&&reservedOnly)reject('INVALID','Invalid bounded Agent history cursor');
   const rows=kind==='runs'?db.prepare('SELECT agent_run_id AS id FROM agent_runs WHERE agent_run_id>?'+(reservedOnly?' AND reserved=1':'')+' ORDER BY agent_run_id LIMIT ?').all(afterId,limit):db.prepare('SELECT invocation_id AS id FROM agent_invocations WHERE invocation_id>?'+(unfinishedOnly?" AND json_extract(body,'$.state') IN ('intent','requested')":'')+' ORDER BY invocation_id LIMIT ?').all(afterId,limit);
   return {records:rows.map(row=>kind==='runs'?readRun(row.id):readInvocation(row.id)),nextCursor:rows.length===limit?rows.at(-1).id:null};
  },
  snapshot(value){authorize(value);validate();return {revision:revision(),runs:db.prepare('SELECT agent_run_id FROM agent_runs ORDER BY agent_run_id').all().map(x=>run(x.agent_run_id)),invocations:db.prepare('SELECT invocation_id FROM agent_invocations ORDER BY invocation_id').all().map(x=>invocation(x.invocation_id)),recoveryRequired:[...recoveryRuns].filter(id=>run(id)?.reserved).sort()};},
  reconcileRun(id,token){
   authorize(token);const row=run(id);if(!row)reject('REFERENCE','Agent run does not exist');const parent=runReference(row);
   if(row.state==='closed')return {revision:revision(),run:row,confirmed:true};
   if(!terminalSession.has(parent.state)||parent.reserved)return {revision:revision(),run:row,confirmed:false};
   const result=this.commitRun({...row,state:'closed',reserved:false,closeEvidence:{kind:'session-terminal',evidenceSha256:agentTerminalSessionDigest(parent)},updatedAt:new Date(Math.max(Date.now(),Date.parse(row.updatedAt))).toISOString()},token);return {...result,confirmed:true};
  },
  commitRun(value,token){
   authorize(token);const row=runRecord(value);
   return transaction(()=>{
    const parent=runReference(row),old=run(row.agentRunId),key=db.prepare('SELECT agent_run_id FROM agent_runs WHERE tenant=? AND key_hash=?').get(row.tenant,row.createKeyHash);
    if(key&&key.agent_run_id!==row.agentRunId)reject('CONFLICT','Agent create idempotency key already has its fixed run');
    if(!old){ready(parent);if(row.state!=='intent'||row.beginDispatch!=='not-requested')reject('CONFLICT','A new Agent run requires an undispatched intent');}
    else{
     if(runImmutable.some(k=>!same(old[k],row[k]))||row.updatedAt<old.updatedAt||old.binding!==null&&!same(old.binding,row.binding)||old.beginResultHash!==null&&old.beginResultHash!==row.beginResultHash||old.error!==null&&!same(old.error,row.error)&&!(row.closeEvidence?.kind==='begin-rejected'&&old.error.outcome==='unknown'))reject('CONFLICT','Agent run identity and accepted evidence are immutable');
     if(old.state==='closed'){if(!same(old,row))reject('CONFLICT','Closed Agent history is immutable');return {run:old};}
     if(!transitions[old.state].includes(row.state))reject('CONFLICT','Agent run cannot repeat or reverse its phase');
     const recovered=recoveryRuns.has(row.agentRunId);
     if(recovered&&!['closing','recovery-required','closed'].includes(row.state))reject('RECOVERY_REQUIRED','Recovered Agent work may only close; it cannot reactivate');
     if(old.beginDispatch!==row.beginDispatch){
      if(old.beginDispatch==='not-requested'&&row.beginDispatch==='requested'&&old.state==='intent'&&row.state==='starting'&&!recovered)ready(parent);
      else if(old.beginDispatch==='requested'&&row.beginDispatch==='confirmed'&&!recovered&&(old.state==='starting'&&row.state==='active'||old.state==='closing'&&row.state==='closing')){if(row.state==='active')ready(parent);}
      else reject('CONFLICT','Agent begin dispatch requires its one-use durable fence');
     }
     if(old.beginResultHash===null&&row.beginResultHash!==null&&row.beginDispatch!=='confirmed'&&row.closeEvidence?.kind!=='begin-rejected')reject('CONFLICT','Begin evidence requires its matching accepted outcome');
     if(old.endDispatch!==row.endDispatch){
      if(old.endDispatch==='not-requested'&&row.endDispatch==='requested'&&row.state==='closing'&&old.binding!==null){}
      else if(old.endDispatch==='requested'&&row.endDispatch==='confirmed'&&row.closeEvidence?.kind==='worker-run-closed'){}
      else reject('CONFLICT','Agent end dispatch requires its one-use durable fence');
     }else if(row.endDispatch==='requested'&&row.state==='closing')reject('CONFLICT','Agent end dispatch marker cannot be reused');
     if(row.closeEvidence?.kind==='worker-run-closed'&&old.endDispatch!=='requested'||row.closeEvidence?.kind==='begin-rejected'&&(old.beginDispatch!=='requested'||recovered))reject('CONFLICT','Closure evidence lacks a matching current-owner dispatch');
    }
    const writer=db.prepare('SELECT agent_run_id FROM agent_runs WHERE session_id=? AND reserved=1 AND agent_run_id<>?').get(row.sessionId,row.agentRunId);if(row.reserved&&writer)reject('CONFLICT','Session already has a reserved Agent writer');
    db.prepare('INSERT INTO agent_runs VALUES(?,?,?,?,?,?) ON CONFLICT(agent_run_id) DO UPDATE SET reserved=excluded.reserved,body=excluded.body').run(row.agentRunId,row.sessionId,row.tenant,row.createKeyHash,Number(row.reserved),encode(row));return {run:row};
   });
  },
  commitInvocation(value,token){
   authorize(token);const row=invocationRecord(value);
   return transaction(()=>{
    const parent=invocationReference(row),old=invocation(row.invocationId),key=db.prepare('SELECT invocation_id FROM agent_invocations WHERE agent_run_id=? AND tenant=? AND key_hash=?').get(row.agentRunId,row.tenant,row.keyHash);
    if(key&&key.invocation_id!==row.invocationId)reject('CONFLICT','Invocation idempotency key already has its fixed action');
    const available=()=>{if(recoveryRuns.has(parent.agentRunId)||parent.state!=='active'||!parent.reserved)reject('RECOVERY_REQUIRED','Only the current active run may admit new Agent work');ready(runReference(parent));};
    if(!old){available();if(row.state!=='intent'||row.dispatchStarted)reject('CONFLICT','A new invocation requires an undispatched intent');}
    else{
     if(invocationImmutable.some(k=>!same(old[k],row[k]))||row.updatedAt<old.updatedAt)reject('CONFLICT','Invocation action and fence are immutable');
     if(terminalInvocation.has(old.state)){if(!same(old,row))reject('CONFLICT','Terminal invocation history is immutable and cannot be replayed');return {invocation:old};}
     if(recoveryParents.has(row.agentRunId)&&!(old.state==='intent'&&row.state==='rejected'&&!row.dispatchStarted||old.state==='requested'&&row.state==='unknown'))reject('RECOVERY_REQUIRED','Recovered invocation may only record an unstarted rejection or unknown result');
     if(old.state==='intent'&&row.state==='requested'){available();}
     else if(old.state==='intent'&&row.state==='rejected'&&!row.dispatchStarted){}
     else if(old.state==='requested'&&terminalInvocation.has(row.state)&&row.dispatchStarted){}
     else reject('CONFLICT','Invocation dispatch marker is one-use; no repeat or reversal');
    }
    db.prepare('INSERT INTO agent_invocations VALUES(?,?,?,?,?,?) ON CONFLICT(invocation_id) DO UPDATE SET body=excluded.body').run(row.invocationId,row.agentRunId,row.tenant,row.sessionId,row.keyHash,encode(row));return {invocation:row};
   });
  }
 };
}
