// Test-only virtual worker resources over an owned Node IPC channel. This is
// not a remote RPC listener or a Native browser/runtime retirement verifier.
import {ClusterWorkerFence} from '../../service/cluster-worker-fence.mjs';
const nodeId=process.argv[2],incarnation=process.argv[3];
let observation,calls=0,cleanups=0;const owned=new Set();
const fence=new ClusterWorkerFence({nodeId,incarnation,onExpired:()=>{owned.clear();cleanups++;}});
process.on('message',async message=>{
 const {id,method,data}=message;
 try{
  let result;
  if(method==='begin'){observation=fence.beginHeartbeat();result={started:true};}
  else if(method==='lease'){result=fence.acceptLease(observation,data.lease,{leaseMs:data.leaseMs});observation=null;}
  else if(method==='admit'){result=fence.admit(data);owned.add(data.sessionId);}
  else if(method==='work')result=await fence.run(data,async signal=>{if(signal.aborted)throw new Error('Owner aborted');return {calls:++calls,nodeId};});
  else if(method==='status')result={...fence.status(),ownerAborted:fence.signal.aborted,owned:owned.size,calls,cleanups};
  else if(method==='settled'){if(!fence.terminal)throw new Error('Owner is still active');await fence.terminal;result={owned:owned.size,cleanups};}
  else if(method==='close'){await fence.close();result={closed:true};}
  else throw new Error('Unsupported test method');
  process.send({id,ok:true,data:result});
 }catch(error){process.send({id,ok:false,error:{code:error.code??'FIXTURE_ERROR',outcome:error.outcome??'unknown'}});}
});
process.on('disconnect',()=>{void fence.close().finally(()=>process.exit(0));});
