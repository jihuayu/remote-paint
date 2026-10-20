import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {retirement} from './runtime-retirement-records.mjs';
if(process.argv[3]==='kill-after-link'){
 const link=fs.linkSync;fs.linkSync=(...args)=>{const result=link(...args);if(String(args[1]).endsWith('.retirement.json'))process.kill(process.pid,'SIGKILL');return result;};syncBuiltinESMExports();
}
const {RuntimeRetirementStore}=await import('../../service/runtime-retirement-store.mjs');
const store=new RuntimeRetirementStore({directory:process.argv[2]});
if(process.argv[3]==='restrictive-umask')process.umask(0o777);
try{const receipt=store.persistNotDispatched(retirement({requested:false}));process.send({event:'persisted',receipt});}
catch(error){if(process.argv[3]!=='restrictive-umask')throw error;process.send({event:'rejected',code:error.code});}
setInterval(()=>{},1000);
