import {createRequire} from 'node:module';
import {SqliteSessionStore} from '../../service/session-store.mjs';
import {records} from './session-store-records.mjs';
const [path,mode]=process.argv.slice(2);let owner;
if(mode==='commit'){
 owner=new SqliteSessionStore({path});owner.commit(records());process.send({event:'committed'});
}else if(mode==='uncommitted'){
 const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');owner=new DatabaseSync(path);owner.exec('PRAGMA locking_mode=EXCLUSIVE;PRAGMA synchronous=FULL;BEGIN EXCLUSIVE');
 const data=records().sessions[0];data.state='closing';data.closeReason='released';owner.prepare('UPDATE sessions SET body=? WHERE session_id=?').run(JSON.stringify(data),data.sessionId);process.send({event:'uncommitted'});
}else throw new Error('Unknown fixture mode');
setInterval(()=>{},1000);
