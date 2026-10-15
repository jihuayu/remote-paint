import {createControl} from './live/input.mjs';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startLiveSource} from './live/source.mjs';
import {startLiveTransport} from './live/transport.mjs';
import {startDynamicFixture} from './tests/dynamic-fixture.mjs';
export async function startLive({url,port=4175,host='127.0.0.1',executablePath,interval=120,captureOnInput=true}={}){
 const fixture=url?null:await startDynamicFixture();let source,transport;
 try{source=await startLiveSource({url:url??fixture.url,executablePath,interval,captureOnInput});source.control=await createControl(source);transport=await startLiveTransport(source,{port,host});
  return {...transport,source,close:async()=>{await transport.close();await source.control.close();await source.close();await fixture?.close();}};
 }catch(error){await transport?.close();await source?.control?.close();await source?.close();await fixture?.close();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const {values}=parseArgs({options:{url:{type:'string'},port:{type:'string'},host:{type:'string'},browser:{type:'string'}}});
 const live=await startLive({url:values.url,port:Number(values.port??4175),host:values.host,executablePath:values.browser});
 console.log(`Live Remote Paint Viewer: ${live.url}`);
 const stop=async()=>{await live.close();process.exit(0);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
