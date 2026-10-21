// Pure bounded projection contract shared by the Source journal and receiver.
// Shape and state consistency do not authenticate an event or prove a side effect.
export const AGENT_EVENT_MAX_BYTES=3072;
const integer=(v,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const id=(v,prefix)=>typeof v==='string'&&new RegExp('^'+prefix+'_'+uuid+'$').test(v);
const date=v=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const plain=(v,keys)=>!!v&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const error=v=>v===null||plain(v,['code','outcome'])&&typeof v.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(v.code)&&['not-dispatched','unknown'].includes(v.outcome);
const dispatch=new Set(['not-requested','requested','confirmed']);
const runStates=new Set(['intent','starting','active','closing','recovery-required','closed']);
const invocationStates=new Set(['intent','requested','injected','rejected','unknown']);
const tools=new Set(['click','move','drag','scroll','press','insertText','composition']);
const closures=new Set(['never-dispatched','begin-rejected','worker-run-closed','session-terminal']);

const invalid=()=>{throw new TypeError('Invalid Agent event projection');};
export function parseAgentEventBody(body){
 if(typeof body!=='string'||Buffer.byteLength(body)>AGENT_EVENT_MAX_BYTES)invalid();
 let e;try{e=JSON.parse(body);}catch{invalid();}
 if(!plain(e,['schema','eventId','agentRunId','sessionId','region','version','sequence','observedAt','type','data'])||e.schema!=='agent-event-v1'||!id(e.eventId,'aevt')||!id(e.agentRunId,'arun')||typeof e.sessionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(e.sessionId)||typeof e.region!=='string'||e.region.length<1||e.region.length>64||typeof e.version!=='string'||e.version.length<1||e.version.length>256||!integer(e.sequence,1)||!date(e.observedAt))invalid();
 const d=e.data;
 if(['run.updated','run.snapshot'].includes(e.type)){
  if(!plain(d,['state','holdsWriter','beginDispatch','endDispatch','error','closeEvidenceKind','stateUpdatedAt'])||!runStates.has(d.state)||typeof d.holdsWriter!=='boolean'||(d.state==='closed')===d.holdsWriter||!dispatch.has(d.beginDispatch)||!dispatch.has(d.endDispatch)||!error(d.error)||!date(d.stateUpdatedAt)||(d.closeEvidenceKind===null?d.state==='closed':d.state!=='closed'||!closures.has(d.closeEvidenceKind)))invalid();
  if(d.state==='intent'&&(d.beginDispatch!=='not-requested'||d.endDispatch!=='not-requested'||d.error!==null)||d.state==='starting'&&(d.beginDispatch!=='requested'||d.endDispatch!=='not-requested'||d.error!==null)||d.state==='active'&&(d.beginDispatch!=='confirmed'||d.endDispatch!=='not-requested'||d.error!==null)||d.endDispatch!=='not-requested'&&d.beginDispatch!=='confirmed'||d.endDispatch==='requested'&&!['closing','recovery-required','closed'].includes(d.state)||d.endDispatch==='confirmed'&&(d.state!=='closed'||d.closeEvidenceKind!=='worker-run-closed')||d.state!=='closed'&&d.error!==null&&(!['closing','recovery-required'].includes(d.state)||d.error.outcome!=='unknown'))invalid();
  if(d.closeEvidenceKind==='never-dispatched'&&(d.beginDispatch!=='not-requested'||d.endDispatch!=='not-requested'||d.error!==null)||d.closeEvidenceKind==='begin-rejected'&&(d.beginDispatch!=='requested'||d.endDispatch!=='not-requested'||d.error?.outcome!=='not-dispatched')||d.closeEvidenceKind==='worker-run-closed'&&(d.beginDispatch!=='confirmed'||d.endDispatch!=='confirmed'))invalid();
 }else if(['invocation.updated','invocation.snapshot'].includes(e.type)){
  if(!plain(d,['invocationId','tool','state','dispatchStarted','receipt','error','stateUpdatedAt'])||!id(d.invocationId,'ainv')||!tools.has(d.tool)||!invocationStates.has(d.state)||typeof d.dispatchStarted!=='boolean'||!error(d.error)||!date(d.stateUpdatedAt)||d.receipt!==null&&(!plain(d.receipt,['stage','inputs'])||d.receipt.stage!=='input-injected'||!integer(d.receipt.inputs,1,32))||(d.state==='injected')!==(d.receipt!==null))invalid();
  if(d.state==='intent'&&(d.dispatchStarted||d.error!==null)||d.state==='requested'&&(!d.dispatchStarted||d.error!==null)||d.state==='injected'&&(!d.dispatchStarted||d.error!==null)||d.state==='rejected'&&d.error?.outcome!=='not-dispatched'||d.state==='unknown'&&(!d.dispatchStarted||d.error?.outcome!=='unknown'))invalid();
 }else invalid();
 return e;
}
