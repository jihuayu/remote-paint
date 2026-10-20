import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {SqliteSessionStore} from '../../service/session-store.mjs';
const [path,marker]=process.argv.slice(2),prepare=DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare=function(sql){
 const statement=prepare.call(this,sql);
 if(sql==='UPDATE runtimes SET body=? WHERE session_id=?'){
  const run=statement.run.bind(statement);
  statement.run=(...args)=>{const result=run(...args);writeFileSync(marker,'row-written-before-commit\n',{flag:'wx',mode:0o600});process.kill(process.pid,'SIGKILL');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);return result;};
 }
 return statement;
};
new SqliteSessionStore({path});
throw Error('Fixture failed to stop before migration commit');
