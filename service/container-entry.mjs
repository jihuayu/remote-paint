import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {startLive} from '../live.mjs';
import {containerOptions} from './container-options.mjs';

const options=containerOptions();
await mkdir(process.env.HOME??'/tmp/remote-paint-home',{recursive:true,mode:0o700});
const live=await startLive(options);
// Direct CDP clients do not enter source.control.agent(). Keep the real page
// clock active explicitly while this trusted private-agent server is running.
const release=live.source.acquirePageRun();
const info=await live.source.capture.cdp.send('Target.getTargetInfo');
const ready={viewerUrl:live.url,cdpUrl:`http://127.0.0.1:${options.cdpPort}`,sourceTargetId:info.targetInfo.targetId};
await writeFile('/tmp/remote-paint-ready.json',JSON.stringify(ready)+'\n',{mode:0o600});
// The Viewer key stays in the private runtime file, never in image metadata.
console.log(`Remote Paint ready; Viewer and CDP bound to loopback (${options.port}/${options.nativePort}/${options.cdpPort})`);
let closing;
const stop=()=>closing??=(async()=>{
 release();
 try{await live.close();}finally{await unlink('/tmp/remote-paint-ready.json').catch(()=>{});}
})();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void stop().then(()=>process.exit(0),error=>{console.error(error.message);process.exit(1);});});
