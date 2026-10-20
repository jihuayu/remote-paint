// The native producer certifies a complete asset index; this reader derives
// estimates from the exact indexed bytes, never from compressed byte length.
const signature=[137,80,78,71,13,10,26,10];
export function pngMemoryBytes(bytes){
 if(bytes.byteLength<33||signature.some((v,i)=>bytes[i]!==v))throw new Error('Invalid indexed PNG header');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(view.getUint32(8)!==13||String.fromCharCode(...bytes.subarray(12,16))!=='IHDR')throw new Error('Invalid indexed PNG header');
 const width=view.getUint32(16),height=view.getUint32(20),depth=bytes[24],color=bytes[25];
 const valid=color===0?[1,2,4,8,16].includes(depth):[2,4,6].includes(color)?[8,16].includes(depth):color===3?[1,2,4,8].includes(depth):false;
 let crc=0xffffffff;for(let i=12;i<29;i++){crc^=bytes[i];for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
 if(!width||!height||width>8192||height>8192||!valid||bytes[26]||bytes[27]||bytes[28]>1||view.getUint32(29)!==crc)throw new Error('Invalid indexed PNG dimensions or format');
 return width*height*8;
}
export function inspectResourceMemory(payload,record){
 const claimed=Object.hasOwn(record,'assetRangeVersion')||Object.hasOwn(record,'assetRangesComplete');
 if(!claimed)return null;
 if(record.assetRangeVersion!==1||record.assetRangesComplete!==true||!Array.isArray(record.assetRanges)||record.assetRanges.length>256)throw new Error('Incomplete or incompatible native asset memory index');
 let end=0,imageBytes=0,fontBytes=0;
 for(const range of record.assetRanges){
  const {offset,bytes,kind}=range;
  if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(bytes)||offset<end||bytes<16||offset+bytes>payload.byteLength||!['image','font'].includes(kind))throw new Error('Invalid or overlapping asset range');
  if(kind==='image')imageBytes+=pngMemoryBytes(payload.subarray(offset,offset+bytes));
  else {if(!Number.isSafeInteger(range.glyphSlots)||range.glyphSlots<1||range.glyphSlots>65536)throw new Error('Invalid indexed font glyph slots');fontBytes+=bytes*4+range.glyphSlots*128+65536;}
  end=offset+bytes;
 }
 return Object.freeze({imageBytes,fontBytes});
}
export function makeResourceMemory(ids,bounds){
 if(ids.some(id=>!bounds.has(id)||bounds.get(id)===null))return null;
 return {version:1,resources:Object.fromEntries(ids.map(id=>[id,bounds.get(id)]))};
}
export function validateFrameMemory(frame,required=false){
 const memory=frame.resourceMemory;
 if(memory==null){if(required)throw new Error('Missing complete resource memory profile');return null;}
 if(memory.version!==1||!memory.resources||typeof memory.resources!=='object'||Array.isArray(memory.resources))throw new Error('Invalid resource memory profile');
 const keys=Object.keys(memory.resources);
 if(keys.length!==frame.requiredResources.length||frame.requiredResources.some(id=>!Object.hasOwn(memory.resources,id)))throw new Error('Resource memory dependency mismatch');
 for(const value of Object.values(memory.resources))if(!value||typeof value!=='object'||!['imageBytes','fontBytes'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=2**40))throw new Error('Invalid resource decode estimate');
 return memory.resources;
}
