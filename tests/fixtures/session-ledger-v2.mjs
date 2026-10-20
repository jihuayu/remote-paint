// Build an actual old-format database for migration contracts,not production.
export function legacyV2(db,{withoutIdentity=false}={}){
 for(const row of db.prepare('SELECT session_id,body FROM runtimes').all()){
  const value=JSON.parse(row.body);delete value.startDispatch;
  db.prepare('UPDATE runtimes SET body=? WHERE session_id=?').run(JSON.stringify(value),row.session_id);
 }
 db.prepare("UPDATE metadata SET value='remote-paint-session-ledger-v2' WHERE name='format'").run();db.exec('PRAGMA user_version=2');
 if(withoutIdentity)db.exec("DELETE FROM metadata WHERE name='instance_id'");
}
