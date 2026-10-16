import {decodeResource,isHash} from './wire.mjs';
export function decodeAsset(input){
 const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
 if(bytes[5]!==2)return {kind:'skp',...decodeResource(bytes)};
 if(bytes.length<44||String.fromCharCode(...bytes.subarray(0,4))!=='RPNT'||bytes[4]!==1||bytes[6]||bytes[7])throw new Error('Invalid asset chunk header');
 const length=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(8);
 if(!length||length>16*1024*1024||length+44!==bytes.byteLength)throw new Error('Invalid asset chunk length');
 return {kind:'chunk',id:[...bytes.subarray(12,44)].map(b=>b.toString(16).padStart(2,'0')).join(''),payload:bytes.subarray(44)};
}
// This cache holds immutable font/image/content blocks independently of the
// current SKP set. The native peer sends an ordered reset before its working
// set can exceed these limits; resetting never changes the visible frame.
export class AssetCache{
 constructor(){this.chunks=new Map();this.bytes=0;this.stats={receivedChunks:0,receivedBytes:0,fontBytes:0,imageBytes:0,reusedBytes:0};this.seen=new Set();}
 clear(){this.chunks.clear();this.bytes=0;this.seen.clear();}
 put(id,payload){if(!isHash(id)||!payload.byteLength||payload.byteLength>16*1024*1024)throw new Error('Invalid asset chunk');if(this.chunks.has(id))return;if(this.chunks.size>=131072||this.bytes+payload.byteLength>128*1024*1024)throw new Error('Asset cache budget exceeded');this.chunks.set(id,payload);this.bytes+=payload.byteLength;this.stats.receivedChunks++;this.stats.receivedBytes+=payload.byteLength;}
 assemble(manifest){
  if(!isHash(manifest.id)||!Number.isInteger(manifest.bytes)||manifest.bytes<28||manifest.bytes>16*1024*1024||!Array.isArray(manifest.chunks)||!manifest.chunks.length||manifest.chunks.length>2048)throw new Error('Invalid resource manifest');
  if(manifest.chunks.some(part=>!isHash(part.id)||!['font','image','skp'].includes(part.kind)))throw new Error('Invalid asset reference');
  const parts=manifest.chunks.map(part=>this.chunks.get(part.id));if(parts.some(part=>!part))return null;
  if(parts.reduce((n,part)=>n+part.byteLength,0)!==manifest.bytes)throw new Error('Resource manifest length mismatch');
  const payload=new Uint8Array(manifest.bytes);let offset=0;for(let i=0;i<parts.length;i++){const part=parts[i],entry=manifest.chunks[i];payload.set(part,offset);offset+=part.byteLength;if(entry.kind==='font')this.stats.fontBytes+=part.byteLength;if(entry.kind==='image')this.stats.imageBytes+=part.byteLength;if(this.seen.has(entry.id))this.stats.reusedBytes+=part.byteLength;this.seen.add(entry.id);}
  if(new TextDecoder().decode(payload.subarray(0,8))!=='skiapict')throw new Error('Expected assembled SKP');return payload;
 }
}
