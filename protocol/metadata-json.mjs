import {MemoryLimitError} from './client-memory.mjs';

// Scan without a UTF-8 copy or a parsed object graph. This bounds work before
// JSON.parse; its object/string/temporary sizes remain engine estimates.
export function inspectMetadataJson(text,{maxBytes=256*1024,maxNodes=131072,maxDepth=64,maxEstimateBytes=32*1024*1024}={}){
 if(typeof text!=='string')throw new Error('Expected metadata text');
 for(const limit of [maxBytes,maxNodes,maxDepth,maxEstimateBytes])if(!Number.isSafeInteger(limit)||limit<1)throw new Error('Invalid metadata limits');
 if(text.length>maxBytes)throw new MemoryLimitError('metadata wire bytes');
 let bytes=0,nodes=0,depth=0,peakDepth=0,quoted=false,escaped=false,atom=false;
 for(let i=0;i<text.length;i++){
  const code=text.charCodeAt(i);
  if(code<128)bytes++;else if(code<2048)bytes+=2;else if(code>=0xd800&&code<=0xdbff&&i+1<text.length&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}else bytes+=3;
  if(bytes>maxBytes)throw new MemoryLimitError('metadata wire bytes');
  if(quoted){if(escaped)escaped=false;else if(code===92)escaped=true;else if(code===34)quoted=false;continue;}
  if(code===34){quoted=true;atom=false;nodes++;}
  else if(code===123||code===91){atom=false;nodes++;depth++;peakDepth=Math.max(peakDepth,depth);if(depth>maxDepth)throw new MemoryLimitError('metadata nesting');}
  else if(code===125||code===93){atom=false;depth--;}
  else if(code===44||code===58||code===32||code===9||code===10||code===13)atom=false;
  else if(!atom){nodes++;atom=true;}
  if(nodes>maxNodes)throw new MemoryLimitError('metadata entries');
 }
 const estimatedBytes=4096+text.length*6+nodes*192+peakDepth*64;
 if(estimatedBytes>maxEstimateBytes)throw new MemoryLimitError('metadata parse estimate');
 return {byteLength:bytes,estimatedBytes,nodes};
}

export function parseMetadataJson(text,{memory,...limits}={}){
 const inspected=inspectMetadataJson(text,limits),release=memory?.reserve('receive',inspected.estimatedBytes)??(()=>{});
 try{
  const value=JSON.parse(text);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid metadata JSON object');
  return {...inspected,value,release};
 }catch(error){release();if(error instanceof SyntaxError)throw new Error('Invalid metadata JSON');throw error;}
}
