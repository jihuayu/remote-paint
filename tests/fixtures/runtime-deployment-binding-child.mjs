import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {deployment} from './runtime-deployment-records.mjs';
const [directory,path,socketPath,mode,configurationPath]=process.argv.slice(2),configuration=configurationPath?JSON.parse(fs.readFileSync(configurationPath,'utf8')):deployment();
if(mode==='kill-after-link'){
 const link=fs.linkSync;fs.linkSync=(...args)=>{const result=link(...args);if(String(args[1]).endsWith('.deployment.json'))process.kill(process.pid,'SIGKILL');return result;};syncBuiltinESMExports();
}
const {RuntimeDeploymentBindingStore}=await import('../../service/runtime-deployment-binding.mjs'),{SqliteSessionStore}=await import('../../service/session-store.mjs'),{DockerMetadataClient}=await import('../../service/docker-metadata-client.mjs');
const store=new SqliteSessionStore({path}),metadata=new DockerMetadataClient({socketPath,daemonId:configuration.daemonId});
if(mode==='restrictive-umask')process.umask(0o777);
try{const opened=await RuntimeDeploymentBindingStore.bootstrap({directory,store,metadata,configuration});process.send({event:'bootstrap-published',receipt:opened.receipt,identity:store.identity()});}
catch(error){if(mode!=='restrictive-umask')throw error;process.send({event:'bootstrap-rejected',code:error.code});}
setInterval(()=>{},1000);
