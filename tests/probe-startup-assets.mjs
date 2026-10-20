// Diagnostic: run in separate Node processes for serial/parallel cold bundles.
import {createServer} from 'node:http';
import {startLive} from '../live.mjs';
import {startLiveSource} from '../live/source.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {createControl} from '../live/input.mjs';
const mode=process.argv[2];if(!['serial','parallel'].includes(mode))throw new Error('Expected serial or parallel');
const fixture=createServer((req,res)=>res.end('<!doctype html><p>Startup preparation probe</p>'));await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${fixture.address().port}`,started=performance.now();let live,source,transport;
try{
 if(mode==='parallel'){live=await startLive({url,port:0});source=live.source;}
 else{source=await startLiveSource({url});source.control=await createControl(source);transport=await startLiveTransport(source,{port:0});}
 console.log(JSON.stringify({mode,sessionReadyMs:performance.now()-started,readiness:source.readiness}));
}finally{if(live)await live.close();else{await transport?.close();await source?.control?.close();await source?.close();}await new Promise(resolve=>fixture.close(resolve));}
