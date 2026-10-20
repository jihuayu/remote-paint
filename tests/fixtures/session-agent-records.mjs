import {createHash} from 'node:crypto';
import {records} from './session-store-records.mjs';
import {agentNeverDispatchedDigest} from '../../service/session-agent-journal.mjs';
export const hash=value=>createHash('sha256').update(String(value)).digest('hex');
export const uuid=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
export function readyRecords(suffix='a',tenant='tenant-a'){
 const batch=records(suffix,tenant),row=batch.sessions[0];
 Object.assign(row,{state:'ready',version:'fixture-agent-v1',readyAt:row.createdAt,expiresAt:'2026-10-18T00:15:00.000Z'});batch.operations[0].operation.status='succeeded';return batch;
}
export function runIntent(n=1,batch=readyRecords()){
 const row=batch.sessions[0];return {agentRunId:'arun_'+uuid(n),sessionId:row.sessionId,tenant:row.tenant,region:row.region,version:row.version,createKeyHash:hash('create-'+n),fingerprint:hash('run-fingerprint-'+n),state:'intent',reserved:true,beginDispatch:'not-requested',binding:null,beginResultHash:null,endDispatch:'not-requested',closeEvidence:null,error:null,createdAt:row.createdAt,updatedAt:row.createdAt};
}
export const starting=row=>({...row,state:'starting',beginDispatch:'requested'});
export const active=row=>({...starting(row),state:'active',beginDispatch:'confirmed',binding:{workerRunId:'run_'+uuid(10),targetId:'target_'+uuid(20),controlSessionId:uuid(30)},beginResultHash:hash('fixture-begin-receipt')});
export const closing=row=>({...row,state:'closing',endDispatch:row.binding?'requested':'not-requested'});
export const unstartedClosed=row=>({...row,state:'closed',reserved:false,closeEvidence:{kind:'never-dispatched',evidenceSha256:agentNeverDispatchedDigest(row)}});
export function invocationIntent(row,n=1){return {invocationId:'ainv_'+uuid(n),agentRunId:row.agentRunId,sessionId:row.sessionId,tenant:row.tenant,keyHash:hash('invoke-'+n),fingerprint:hash('action-fingerprint-'+n),tool:'insertText',fence:{controlSessionId:row.binding.controlSessionId,controlVersion:0,pageEpoch:1,viewportVersion:1},state:'intent',dispatchStarted:false,receipt:null,error:null,createdAt:row.createdAt,updatedAt:row.createdAt};}
export const requested=row=>({...row,state:'requested',dispatchStarted:true});
export const injected=row=>({...requested(row),state:'injected',receipt:{stage:'input-injected',inputs:1,evidenceSha256:hash('fixture-injection-receipt')}});
export const unknown=row=>({...requested(row),state:'unknown',error:{code:'AGENT_RPC_TIMEOUT',outcome:'unknown'}});
export const rejected=row=>({...row,state:'rejected',error:{code:'AGENT_PAUSED',outcome:'not-dispatched'}});
export function activate(store,owner,row=runIntent()){
 for(const value of [row,starting(row),active(row)])store.commitAgentRun(value,{owner});return active(row);
}
export function legacyV3(db){
 db.exec("DROP TABLE agent_invocations;DROP TABLE agent_runs;DELETE FROM metadata WHERE name='agent_revision';UPDATE metadata SET value='remote-paint-session-ledger-v3' WHERE name='format';PRAGMA user_version=3");
}
