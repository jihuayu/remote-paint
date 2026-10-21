import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {SqliteSessionStore} from '../../service/session-store.mjs';
import {runIntent,unknown,uuid} from './session-agent-records.mjs';
const [path,mode,marker]=process.argv.slice(2),exec=DatabaseSync.prototype.exec;let armed=false;
DatabaseSync.prototype.exec=function(sql){
 if(armed&&sql==='COMMIT'){writeFileSync(marker,mode+'\n',{flag:'wx',mode:0o600});process.kill(process.pid,'SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
 const result=exec.call(this,sql);if(mode==='migration'&&sql.includes('CREATE TABLE agent_webhooks'))armed=true;return result;
};
const store=new SqliteSessionStore({path,enableAgentWebhooks:true}),owner=Symbol();store.claimAgentController(owner);armed=true;
if(mode==='subscribe')store.subscribeAgentWebhook(runIntent().agentRunId,runIntent().tenant,{endpointId:'awh_'+uuid(1),after:0},{owner});
if(mode==='outcome'){const row=store.listAgentRecords('invocations',{limit:1},{owner}).records[0];store.commitAgentInvocation(unknown(row),{owner});}
throw Error('Expected actual SIGKILL');
