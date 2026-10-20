import {createControl} from './live/input.mjs';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startLiveSource} from './live/source.mjs';
import {startLiveTransport} from './live/transport.mjs';
import {prepareViewerAssets} from './live/viewer-assets.mjs';
import {startDynamicFixture} from './tests/dynamic-fixture.mjs';
export async function startLive({url,port=4175,host='127.0.0.1',executablePath,interval=1000/60,captureOnInput=true}={}){
 const preparedAssets=prepareViewerAssets();preparedAssets.catch(()=>{});
 const fixture=url?null:await startDynamicFixture();let source,transport;
 let closing;
 const close=()=>closing??=(async()=>{
  const errors=[];
  for(const dispose of [()=>transport?.close(),()=>source?.control?.close(),()=>source?.close(),()=>fixture?.close()]){
   try{await dispose();}catch(error){errors.push(error);}
  }
  if(errors.length)throw new AggregateError(errors,'Live close failed');
 })();
 try{source=await startLiveSource({url:url??fixture.url,executablePath,interval,captureOnInput});source.control=await createControl(source);transport=await startLiveTransport(source,{port,host,preparedAssets});
  return {...transport,source,close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Live startup and cleanup failed');}throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const {values}=parseArgs({options:{url:{type:'string'},port:{type:'string'},host:{type:'string'},browser:{type:'string'}}});
 const live=await startLive({url:values.url,port:Number(values.port??4175),host:values.host,executablePath:values.browser});
 console.log(`Live Remote Paint Viewer: ${live.url}`);
 const stop=async()=>{await live.close();process.exit(0);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
