// Explicit observer-host pause,not an organic application stall.
import {sampleLinuxProcessTree} from '../../native/process-memory-linux.mjs';
process.send({event:'ready'},()=>{
 const sample=sampleLinuxProcessTree();process.kill(process.pid,'SIGSTOP');
 sample.then(value=>process.send({event:'result',passed:true,sampling:value.sampling}),error=>process.send({event:'result',passed:false,code:error.code,message:error.message}));
});
setInterval(()=>{},1000);
