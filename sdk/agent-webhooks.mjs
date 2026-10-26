// Fixed trusted endpoint management; delivery remains owned by the backend.
import {types} from 'node:util';
const plain=v=>v!==null&&typeof v==='object'&&!types.isProxy(v)&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const id=(v,prefix)=>typeof v==='string'&&v.length===prefix.length+36&&new RegExp('^'+prefix+uuid+'$').test(v);
const integer=(v,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
function sequence(value,run){
 if(typeof value!=='string'||value.length>run.length+22||!value.startsWith('aec1.'+run+'.'))return null;
 const n=Number(value.slice(run.length+6));
 return integer(n,0)&&value==='aec1.'+run+'.'+n?n:null;
}
export function captureWebhookRun(run,invalid){if(!id(run,'arun_'))invalid();return run;}
export function captureWebhookSubscriptionId(value,invalid){if(!id(value,'awsub_'))invalid();return value;}
export function captureWebhookSubscription(value,run,invalid){
 if(!exact(value,['endpointId','after']))invalid();
 const {endpointId,after}=value;
 if(!id(endpointId,'awh_')||sequence(after,run)===null)invalid();
 return {endpointId,after};
}
export function validateWebhookReply(status,v,e,headers){
 if(status!==200||v?.agentRunId!==e.id)return false;
 if(e.kind==='agent-webhook-endpoints'){
  if(!exact(v,['schema','agentRunId','endpoints'])||v.schema!=='agent-webhook-endpoints-v1'||!Array.isArray(v.endpoints)||v.endpoints.length>4)return false;
  return v.endpoints.every((row,i)=>exact(row,['endpointId','available'])&&id(row.endpointId,'awh_')&&typeof row.available==='boolean'&&(i===0||v.endpoints[i-1].endpointId<row.endpointId));
 }
 if(!['agent-webhook-subscribe','agent-webhook-subscription'].includes(e.kind)||!exact(v,['schema','subscriptionId','agentRunId','sessionId','endpointId','after','acceptedThrough','queuedThrough','observedLatest','pending','reconciliationRequired','missingFrom','missingThrough','head'])||v.schema!=='agent-webhook-subscription-v1'||!id(v.subscriptionId,'awsub_')||!id(v.sessionId,'ses_')||!id(v.endpointId,'awh_')||!integer(v.pending,0,64)||typeof v.reconciliationRequired!=='boolean')return false;
 if(e.kind==='agent-webhook-subscribe'&&(v.endpointId!==e.endpointId||v.after!==e.after||headers.get('location')!=='/v1/agent-runs/'+e.id+'/webhook-subscriptions/'+v.subscriptionId)||e.kind==='agent-webhook-subscription'&&v.subscriptionId!==e.subscriptionId)return false;
 const after=sequence(v.after,e.id),accepted=sequence(v.acceptedThrough,e.id),queued=sequence(v.queuedThrough,e.id),latest=sequence(v.observedLatest,e.id);
 if([after,accepted,queued,latest].some(n=>n===null)||after>accepted||accepted>queued||queued>latest||v.pending!==queued-accepted)return false;
 if(v.reconciliationRequired){if(queued>=latest||sequence(v.missingFrom,e.id)!==queued+1||v.missingThrough!==v.observedLatest)return false;}
 else if(queued!==latest||v.missingFrom!==null||v.missingThrough!==null)return false;
 if(v.pending===0)return v.head===null;
 const h=v.head;
 return exact(h,['eventId','sequence','attempts','lastOutcome','cursor'])&&id(h.eventId,'aevt_')&&h.sequence===accepted+1&&integer(h.sequence,1)&&integer(h.attempts,0,8)&&(h.attempts===0?h.lastOutcome===null:['requested','unknown','not-accepted'].includes(h.lastOutcome))&&sequence(h.cursor,e.id)===h.sequence;
}
