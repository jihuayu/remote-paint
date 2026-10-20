import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {SqliteSessionStore} from '../../service/session-store.mjs';
import {readyRecords,runIntent,starting,activate,invocationIntent,requested,injected} from './session-agent-records.mjs';
const [path,mode,marker]=process.argv.slice(2);
if(mode==='migration'){
 const exec=DatabaseSync.prototype.exec;
 DatabaseSync.prototype.exec=function(sql){const result=exec.call(this,sql);if(sql.includes('CREATE TABLE agent_invocations')){writeFileSync(marker,'agent-tables-before-commit\n',{flag:'wx',mode:0o600});process.kill(process.pid,'SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return result;};
 new SqliteSessionStore({path});throw Error('Migration fixture did not stop');
}else if(mode==='uncommitted'){
 const db=new DatabaseSync(path);db.exec('PRAGMA synchronous=FULL;BEGIN EXCLUSIVE');const row=JSON.parse(db.prepare('SELECT body FROM agent_invocations').get().body);db.prepare('UPDATE agent_invocations SET body=?').run(JSON.stringify(injected(row)));db.exec("UPDATE metadata SET value='999' WHERE name='agent_revision'");process.send({event:'durable-uncommitted'});
}else{
 const store=new SqliteSessionStore({path}),owner=Symbol('fixture');store.commit(readyRecords());store.claimAgentController(owner);const row=runIntent();
 if(mode==='intent')store.commitAgentRun(row,{owner});
 else if(mode==='begin'){store.commitAgentRun(row,{owner});store.commitAgentRun(starting(row),{owner});}
 else{
  const run=activate(store,owner),invocation=invocationIntent(run);store.commitAgentInvocation(invocation,{owner});store.commitAgentInvocation(requested(invocation),{owner});
  if(['effect','receipt'].includes(mode))writeFileSync(marker,'one-fixture-effect\n',{flag:'wx',mode:0o600});
  if(mode==='receipt')store.commitAgentInvocation(injected(invocation),{owner});
  if(!['requested','effect','receipt'].includes(mode))throw Error('Unknown fixture mode');
 }
 process.send({event:'durable-'+mode});
}
setInterval(()=>{},1000);
