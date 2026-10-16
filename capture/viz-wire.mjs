// Compact, private Viz scene wire format. All integers are big-endian and
// floating point values are IEEE-754 doubles. The frame is already bounded by
// the Unix receiver, so decoding still performs explicit per-field limits.
const MAGIC = 'RVB2';
const VERSION = 1;
const text = new TextDecoder();
const string = (bytes, state, limit=4096) => {
  const length = state.u32();
  if (length > limit || state.left < length) throw new Error('Invalid Viz string');
  return text.decode(state.take(length));
};
export function isBinaryVizScene(bytes) {
  return bytes.byteLength >= 6 && String.fromCharCode(...bytes.subarray(0, 4)) === MAGIC && bytes[4] === VERSION && bytes[5] === 1;
}
export function decodeVizScene(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isBinaryVizScene(bytes)) throw new Error('Invalid binary Viz header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 6;
  const state = {get left(){return bytes.byteLength-offset;}, take(n){const out=bytes.subarray(offset,offset+n);offset+=n;return out;}, u8(){if(this.left<1)throw new Error('Truncated Viz frame');return bytes[offset++];}, u32(){if(this.left<4)throw new Error('Truncated Viz frame');const n=view.getUint32(offset);offset+=4;return n;}, i32(){if(this.left<4)throw new Error('Truncated Viz frame');const n=view.getInt32(offset);offset+=4;return n;}, f64(){if(this.left<8)throw new Error('Truncated Viz frame');const n=view.getFloat64(offset);offset+=8;if(!Number.isFinite(n))throw new Error('Invalid Viz number');return n;}};
  const captureId=string(bytes,state,128), namespace=[state.u32(),state.u32()], passCount=state.u32();
  if(!passCount||passCount>64)throw new Error('Invalid Viz pass count');
  const passes=[];
  for(let p=0;p<passCount;p++){
    const id=string(bytes,state,128), output=Array.from({length:4},()=>state.f64()), quadCount=state.u32();
    if(quadCount>2048)throw new Error('Invalid Viz quad count');
    const quads=[];
    for(let i=0;i<quadCount;i++){
      const kindCode=state.u8(), kind=kindCode===1?'solid':kindCode===2?'pass':kindCode===3?'picture':null;
      if(!kind)throw new Error('Unknown Viz quad kind');
      const localId=state.i32(), qNamespace=[state.u32(),state.u32()], matrix=Array.from({length:9},()=>state.f64()), visible=Array.from({length:4},()=>state.f64()), rect=Array.from({length:4},()=>state.f64()), contentOrigin=[state.f64(),state.f64()], opacity=state.f64(), clip=state.u8()?Array.from({length:4},()=>state.f64()):null, roundedClip=state.u8()?Array.from({length:12},()=>state.f64()):undefined, vizResource=state.u32();
      const q={kind,localId,namespace:qNamespace,matrix,visible,rect,contentOrigin,opacity,clip,vizResource};
      if(roundedClip)q.roundedClip=roundedClip;
      if(kind==='solid')q.color=Array.from({length:4},()=>state.f64());
      else if(kind==='pass')q.passId=string(bytes,state,128);
      quads.push(q);
    }
    passes.push({id,output,quads});
  }
  const hasError=state.u8(), error=hasError?string(bytes,state,4096):null;
  if(state.left!==0)throw new Error('Trailing Viz bytes');
  return {type:'VizScene',captureId,namespace,passes,...(error?{error}:{})};
}
