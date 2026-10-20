import {createInterface} from 'node:readline';
import {downloadFixture} from './public-download-fixture.mjs';
import {deferred,until} from './agent-executor-fixture.mjs';
import {AgentRpcError} from '../../service/agent-rpc.mjs';
const cleanup=[],h=await downloadFixture({after:fn=>cleanup.push(fn)},{http:{requestTimeoutMs:50}}),{run,context}=await h.active();let gate=null;
const print=v=>process.stdout.write(JSON.stringify(v)+'\n');print({base:h.base,keys:h.keys,run,context});
try{for await(const line of createInterface({input:process.stdin})){
 if(line==='stats')print({effects:h.effects.length,ordinary:h.executor.status().ordinary,run:h.executor.getRun(h.runRef(run)),calls:h.calls.map(c=>c.command.op)});
 else if(line==='emit'){await h.emit(Buffer.from([0,255,128,17,9]));print({emitted:true});}
 else if(line==='empty'){await h.emit(Buffer.alloc(0));print({emitted:true});}
 else if(line==='unknown'){h.hooks.perform=()=>{throw new AgentRpcError('AGENT_RPC_TIMEOUT','unknown');};print({invocation:await h.invocation(h.perform(run,context))});}
 else if(line==='hold'){gate=deferred();h.hooks['read-download']=async(req,writer)=>{await gate.promise;return h.chunkReply(req,writer);};print({holding:true});}
 else if(line==='release'){gate?.resolve();await until(()=>h.executor.status().ordinary===0);print({released:true});}
 else if(line==='close')break;else throw Error('Unknown download fixture command');
}}finally{gate?.resolve();for(const fn of cleanup.reverse())await fn();}
