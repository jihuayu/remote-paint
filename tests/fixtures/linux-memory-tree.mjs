import {fork} from 'node:child_process';
import {once} from 'node:events';
if(process.argv[2]==='leaf'){
 setInterval(()=>{},1000);process.send({event:'leaf-ready'});
}else{
 const child=fork(new URL(import.meta.url),['leaf'],{stdio:['ignore','ignore','ignore','ipc']});await once(child,'message');let stopping;
 const stopLeaf=async()=>{if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill('SIGKILL');await closed;}};
 const stop=()=>stopping??=(async()=>{await stopLeaf();process.exit(0);})();
 process.on('message',async message=>{if(message==='stop-leaf'){await stopLeaf();process.send({event:'leaf-stopped'});}else if(message==='close')void stop();});
 process.once('disconnect',()=>void stop());process.once('SIGTERM',()=>void stop());setInterval(()=>{},1000);process.send({event:'ready',leafPid:child.pid});
}
