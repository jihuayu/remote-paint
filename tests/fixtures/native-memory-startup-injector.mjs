// Explicit negative integration fixture, loaded ONLY with node --import.
// Substitute a silent Node child for this one helper launch. No positive native
// measurements or conclusions about the real startup cause can come from it.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {writeFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const original=childProcess.spawn,fixture=fileURLToPath(new URL('./native-memory-child.mjs',import.meta.url));let used=false;
childProcess.spawn=function(executable,args,options){
 if(/^process-memory-sampler-(arm64|x64)-darwin$/.test(basename(executable))){
  if(used)throw Error('Controlled startup fixture refuses a second helper');used=true;
  writeFileSync(join(process.env.REMOTE_PAINT_SESSION_LONG_DIR,'native-startup-controlled-fault.json'),JSON.stringify({scope:'Explicit silent startup substitute;not real helper startup cause or acceptance',expectedExecutable:executable,actualExecutable:process.execPath,fixture,mode:'startup-silent',driverPid:process.pid})+'\n',{flag:'wx',mode:0o600});
  return original(process.execPath,[fixture,'startup-silent'],options);
 }
 return original(executable,args,options);
};
syncBuiltinESMExports();
