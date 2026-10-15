import {LIVE_VERSION} from '../protocol/live-wire.mjs';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export const manifest=JSON.parse(await readFile(new URL('../examples/verified-capture/manifest.json',import.meta.url),'utf8'));
export const payload=await readFile(new URL(`../examples/verified-capture/${manifest.resources[0].file}`,import.meta.url));
export const hash=createHash('sha256').update(payload).digest('hex');
export function snapshot({captureId='contract-1',epoch=1,translation=0,resource=payload}={}){
 const id=createHash('sha256').update(resource).digest('hex');const rect=[0,0,960,640];
 return {pageEpoch:epoch,viewportVersion:1,viewport:{cssWidth:960,cssHeight:640,deviceScaleFactor:1},lastProcessedInputSeq:0,
 native:{captureId,producer:'contract-fixture',namespace:[1,2],frameToken:1,sourceFrame:1},payloads:new Map([[id,resource]]),
 scene:{rootPass:'root',passes:[{id:'root',output:rect,quads:[{kind:'picture',resourceId:id,logical:`${epoch}/contract-fixture/1:2/1`,revision:1,
  width:960,height:640,quadScale:1,contentOrigin:[0,0],matrix:[1,0,0,0,1,translation,0,0,1],rect,visible:rect,clip:null,opacity:1}]}]}};
}
export function fakeSource(initial=snapshot()){
 const source=new EventEmitter();Object.assign(source,{latest:initial,demand:0,setDemand(n){this.demand=n;},publish(frame){this.latest=frame;this.emit('frame',frame);}});return source;
}
export function frame(snapshot,id,base=null,extra={}){
 return {protocol:LIVE_VERSION,pageEpoch:snapshot.pageEpoch,frameId:id,baseFrameId:base,viewportVersion:snapshot.viewportVersion,viewport:snapshot.viewport,
  lastProcessedInputSeq:0,requiredResources:[...snapshot.payloads.keys()],scene:snapshot.scene,...extra};
}
