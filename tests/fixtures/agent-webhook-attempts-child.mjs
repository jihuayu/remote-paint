import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {SqliteSessionStore} from '../../service/session-store.mjs';
const [path,mode,marker]=process.argv.slice(2),exec=DatabaseSync.prototype.exec;let armed=false;
function kill(){writeFileSync(marker,mode+'\n',{flag:'wx',mode:0o600});process.kill(process.pid,'SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
DatabaseSync.prototype.exec=function(sql){if(armed&&sql==='COMMIT')kill();const result=exec.call(this,sql);if(mode==='migration'&&sql.includes('ALTER TABLE agent_webhooks ADD COLUMN accepted_through'))armed=true;return result;};
const store=new SqliteSessionStore({path}),owner=Symbol();store.claimAgentController(owner);const run=store.listAgentRecords('runs',{limit:1},{owner}).records[0];
const dbNames=store.getAgentRun(run.agentRunId,{owner});if(!dbNames)throw Error('Missing original Run');
// The fixed fixture has one endpoint. Idempotent lookup does not change its
// original cursor or notification revision.
const sub=store.subscribeAgentWebhook(run.agentRunId,run.tenant,{endpointId:'awh_00000000-0000-4000-8000-000000000001',after:0},{owner});
if(mode==='begin-rollback')armed=true;
const a=store.beginAgentWebhookAttempt(sub.subscriptionId,run.tenant,{owner}).attempt;
if(mode==='begin-commit')kill();
if(mode==='ack-rollback')armed=true;
store.settleAgentWebhookAttempt(sub.subscriptionId,run.tenant,{deliveryId:a.deliveryId,attemptId:a.attemptId,bodySha256:a.bodySha256,outcome:'accepted',transportSettled:true},{owner});
if(mode==='ack-commit')kill();throw Error('Expected actual writer SIGKILL');
