import {containerOptions} from './container-options.mjs';
try{
 const options=containerOptions();
 for(const url of [`http://127.0.0.1:${options.port}/`,`http://127.0.0.1:${options.cdpPort}/json/version`]){
  const response=await fetch(url,{signal:AbortSignal.timeout(4000)});
  if(response.status!==200)throw new Error('Not ready');
  await response.body.cancel();
 }
}catch{process.exitCode=1;}
