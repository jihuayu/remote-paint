import {SqliteSessionStore} from '../../service/session-store.mjs';
import {records} from './session-store-records.mjs';
const store=new SqliteSessionStore({path:process.argv[2]});if(process.argv[3]==='commit')store.commit(records());
process.send({event:'identity-acknowledged',identity:store.identity(),revision:store.load().revision});
setInterval(()=>{},1000);
