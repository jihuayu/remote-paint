const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
export class DockerMultiplexError extends Error {
 constructor(code){super('Docker attach stream is unavailable');this.name='DockerMultiplexError';this.code=code;}
}
const fail=code=>new DockerMultiplexError(code);
// One fixed header and at most one unfinished payload. Complete frame buffers
// transfer to the consumer, which must apply backpressure and release them.
// This accepts this service's bounded, non-TTY attach stream, not arbitrary
// Docker output. No partial payload reaches the worker protocol parser.
export function decodeDockerMultiplex(source,{maxFrameBytes=65536,maxChunkBytes=65536}={}){
 if(typeof source?.[Symbol.asyncIterator]!=='function'||!integer(maxFrameBytes,1,65536)||!integer(maxChunkBytes,8,65536))throw new TypeError('Expected an async byte source and finite attach bounds');
 return (async function*(){
  const header=Buffer.alloc(8);let headerBytes=0,payload=null,payloadBytes=0,stream=null;
  try{
   for await(const chunk of source){
    if(!Buffer.isBuffer(chunk)||chunk.length===0||chunk.length>maxChunkBytes)throw fail('ATTACH_STREAM_CHUNK_LIMIT');
    let offset=0;
    while(offset<chunk.length){
     if(payload===null){
      const length=Math.min(8-headerBytes,chunk.length-offset);chunk.copy(header,headerBytes,offset,offset+length);offset+=length;headerBytes+=length;
      if(headerBytes<8)continue;
      if(![1,2].includes(header[0])||header[1]!==0||header[2]!==0||header[3]!==0)throw fail('ATTACH_STREAM_HEADER');
      const size=header.readUInt32BE(4);if(size>maxFrameBytes)throw fail('ATTACH_STREAM_FRAME_LIMIT');stream=header[0]===1?'stdout':'stderr';header.fill(0);headerBytes=0;
      if(size===0)continue;
      payload=Buffer.allocUnsafeSlow(size);payloadBytes=0;
     }
     const length=Math.min(payload.length-payloadBytes,chunk.length-offset);chunk.copy(payload,payloadBytes,offset,offset+length);offset+=length;payloadBytes+=length;
     if(payloadBytes===payload.length){const bytes=payload;payload=null;payloadBytes=0;yield Object.freeze({stream,bytes});}
    }
   }
   if(headerBytes!==0||payload!==null)throw fail('ATTACH_STREAM_TRUNCATED');
  }catch(error){throw error instanceof DockerMultiplexError?error:fail('ATTACH_STREAM_IO');}
  finally{header.fill(0);payload?.fill(0);payload=null;}
 })();
}
