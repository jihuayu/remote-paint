// An end report is an observation of the original durable calls. It does not
// roll back page effects or certify an entire Browser/Engine namespace retired.
export const AGENT_CANCELLATION_LIMITS=Object.freeze({pageInvocations:4,pageBytes:16384});
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const pattern=new RegExp('^acc1\\.(arun_'+uuid+')\\.([1-9][0-9]{0,15})\\.(ainv_'+uuid+')$');
export function agentCancellationAfter(agentRunId,value){
 if(value===undefined)return {};
 const match=typeof value==='string'&&pattern.exec(value);
 if(!match||match[1]!==agentRunId||!Number.isSafeInteger(Number(match[2])))throw TypeError('Invalid original Run cancellation cursor');
 return {eventSequence:Number(match[2]),afterId:match[3]};
}
export function agentCancellationReport(snapshot,work){
 const {run,eventSequence,historyOrigin,records,hasMore,afterId}=snapshot,id=run.agentRunId;
 const eventCursor='aec1.'+id+'.'+eventSequence;
 const cursor=invocationId=>'acc1.'+id+'.'+eventSequence+'.'+invocationId;
 const status=run.state==='closed'?(work.ordinaryPending||work.endPending?'settling':'closed'):work.endPending||run.state==='closing'?'pending':work.recoveryRequired||run.state==='recovery-required'?'reconciliation-required':'not-requested';
 const result={schema:'agent-cancellation-v1',agentRunId:id,sessionId:run.sessionId,region:run.region,version:run.version,observedAt:new Date().toISOString(),status,
  run:{state:run.state,holdsWriter:run.reserved,beginDispatch:run.beginDispatch,endDispatch:run.endDispatch,closeEvidenceKind:run.closeEvidence?.kind??null,error:run.error},
  work:{...work},scope:'original-agent-run',rollbackSupported:false,rollbackPerformed:false,businessSuccessConfirmed:false,
  page:{generation:eventCursor,historyOrigin,after:afterId?cursor(afterId):null,nextCursor:hasMore?cursor(records.at(-1).invocationId):null,hasMore,completeRun:!afterId&&!hasMore},
  invocations:records.map(row=>({invocationId:row.invocationId,tool:row.tool,state:row.state,dispatchStarted:row.dispatchStarted,
   effect:row.state==='injected'?'input-injected':row.state==='rejected'?'not-dispatched':row.state==='intent'?'not-dispatched-yet':'unknown',
   receipt:row.receipt&&{stage:row.receipt.stage,inputs:row.receipt.inputs},error:row.error,updatedAt:row.updatedAt}))};
 if(Buffer.byteLength(JSON.stringify(result))>AGENT_CANCELLATION_LIMITS.pageBytes)throw Error('Cancellation report exceeds its bounded projection');
 return structuredClone(result);
}
