import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {SqliteSessionStore} from '../../service/session-store.mjs';
import {runIntent,unknown} from './session-agent-records.mjs';
const [path,mode,marker]=process.argv.slice(2),exec=DatabaseSync.prototype.exec;let armed=false;
DatabaseSync.prototype.exec=function(sql){
 if(armed&&sql==='COMMIT'){
  writeFileSync(marker,'state-and-event-before-commit\n',{flag:'wx',mode:0o600});process.kill(process.pid,'SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 }
 const result=exec.call(this,sql);
 if(mode==='migration-state'&&sql.includes('CREATE TABLE agent_event_heads'))armed=true;
 if(mode==='migration'&&sql.includes('CREATE TABLE agent_event_heads')){
  writeFileSync(marker,'event-tables-before-commit\n',{flag:'wx',mode:0o600});process.kill(process.pid,'SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 }
 return result;
};
const store=new SqliteSessionStore({path}),owner=Symbol('owned event test');store.claimAgentController(owner);
if(mode==='intent-rollback'){armed=true;store.commitAgentRun(runIntent(),{owner});}
else{
 const row=store.listAgentRecords('invocations',{limit:1},{owner}).records[0];if(!row)throw Error('Missing original requested invocation');
 if(mode==='state-rollback')armed=true;
 store.commitAgentInvocation(unknown(row),{owner});process.send({event:'state-and-event-committed'});
}
setInterval(()=>{},1000);
