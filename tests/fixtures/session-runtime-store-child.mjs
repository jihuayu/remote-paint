import {writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {SqliteSessionStore} from '../../service/session-store.mjs';
import {records} from './session-store-records.mjs';
import {provider,intent,requested,created,ready} from './session-runtime-records.mjs';
let rawOwner;const [path,mode,marker]=process.argv.slice(2),store=new SqliteSessionStore({path}),owner=Symbol('owned-runtime-child');store.claimRuntimeProvider(owner,provider);const batch=records();store.commit(batch);let row=intent(batch);store.commitRuntime(row,{owner});
if(mode==='requested'||mode==='created'||mode==='ready'||mode==='uncommitted'){row=requested(row);store.commitRuntime(row,{owner});}
if(mode==='created'||mode==='ready'){writeFileSync(marker,'one-fixture-effect\n',{flag:'wx',mode:0o600});row=created(row);store.commitRuntime(row,{owner});}
if(mode==='ready'){
 row=ready(row);store.commitRuntime(row,{owner});const op=structuredClone(batch.operations[0]);op.operation.status='succeeded';store.commit({sessions:[{...batch.sessions[0],state:'ready',version:row.version,readyAt:batch.sessions[0].createdAt,expiresAt:'2026-10-18T00:15:00.000Z'}],operations:[op]});
}
if(mode==='uncommitted'){
 store.releaseRuntimeProvider(owner);store.close();const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),db=rawOwner=new DatabaseSync(path);db.exec('PRAGMA locking_mode=EXCLUSIVE;PRAGMA synchronous=FULL;BEGIN EXCLUSIVE');const fake=created(row);db.prepare('UPDATE runtimes SET body=? WHERE session_id=?').run(JSON.stringify(fake),row.sessionId);db.prepare("UPDATE metadata SET value='999' WHERE name='runtime_revision'").run();
}
process.send({event:'durable-'+mode});setInterval(()=>rawOwner??store,1000);
