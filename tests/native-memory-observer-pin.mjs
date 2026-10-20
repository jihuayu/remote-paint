// Preserve the qualified Mac observer dependency across copied Source projects.
// Every run still creates a new helper and uses the original sampler deadlines.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {createNativeProcessMemorySampler} from './process-native-memory.mjs';
import {NativeMemoryStartupTrace} from './native-memory-startup.mjs';
export const NATIVE_OBSERVER_PIN_LIMITS=Object.freeze({profileBytes:4096,receiptBytes:8192,binaryBytes:1048576});
const fail=(code,message)=>Object.assign(Error(message),{code});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const path=value=>typeof value==='string'&&value.length<=1024&&isAbsolute(value)&&!/[\0\r\n?#]|:\/\//.test(value);
const fingerprintKeys=['dev','ino','size','mode','mtimeMs','birthtimeMs'];
const fingerprint=s=>Object.fromEntries(fingerprintKeys.map(k=>[k,s[k]]));
const same=(a,b)=>fingerprintKeys.every(k=>a?.[k]===b?.[k]);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===keys.slice().sort().join();
const freeze=value=>{if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;};
async function readRegular(filePath,maximum,{privateFile=false}={}){
 let file;try{
  file=await open(filePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=await file.stat();
  if(!before.isFile()||!Number.isSafeInteger(before.size)||before.size<1||before.size>maximum)throw fail('NATIVE_MEMORY_PIN_LIMIT','Observer pin input is not a bounded regular file');
  if(privateFile&&((before.mode&0o777)!==0o600||before.uid!==process.getuid()))throw fail('NATIVE_MEMORY_PIN_PRIVATE','Observer pin must be an owned0600 file');
  const buffer=Buffer.alloc(maximum+1);let length=0;
  for(;;){const part=await file.read(buffer,length,buffer.length-length,null);length+=part.bytesRead;if(length>maximum)throw fail('NATIVE_MEMORY_PIN_LIMIT','Observer pin input exceeded its byte limit');if(!part.bytesRead)break;}
  const after=await file.stat();if(length!==before.size||!same(before,after))throw fail('NATIVE_MEMORY_PIN_CHANGED','Observer pin input changed during read');return {bytes:buffer.subarray(0,length),file:fingerprint(after)};
 }finally{await file?.close();}
}
export async function readVerifiedNativeObserverPin({pinFile,expectedSha256}={}){
 if(!path(pinFile)||!digest(expectedSha256))throw fail('NATIVE_MEMORY_PIN_CONFIG','Configure an absolute private observer pin and expected SHA256');
 const parent=await open(dirname(pinFile),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{const s=await parent.stat();if(!s.isDirectory()||(s.mode&0o777)!==0o700||s.uid!==process.getuid())throw fail('NATIVE_MEMORY_PIN_PRIVATE','Observer pin directory must be owned0700');}finally{await parent.close();}
 const profile=await readRegular(pinFile,NATIVE_OBSERVER_PIN_LIMITS.profileBytes,{privateFile:true});if(hash(profile.bytes)!==expectedSha256)throw fail('NATIVE_MEMORY_PIN_DIGEST','Observer pin SHA256 differs from frozen configuration');let pin;try{pin=JSON.parse(profile.bytes);}catch{throw fail('NATIVE_MEMORY_PIN_FORMAT','Observer pin JSON is invalid');}
 if(!exact(pin,['schema','platform','arch','executable','binarySha256','sourceSha256','receiptSha256','qualificationSha256','file'])||pin.schema!=='native-memory-observer-pin-v1'||pin.platform!=='darwin'||!['arm64','x64'].includes(pin.arch)||!path(pin.executable)||!['binarySha256','sourceSha256','receiptSha256','qualificationSha256'].every(k=>digest(pin[k]))||!exact(pin.file,fingerprintKeys)||!fingerprintKeys.every(k=>Number.isFinite(pin.file[k])&&pin.file[k]>=0)||!['dev','ino','size','mode'].every(k=>Number.isSafeInteger(pin.file[k]))||pin.file.ino<1||pin.file.size<1||pin.file.size>NATIVE_OBSERVER_PIN_LIMITS.binaryBytes||(pin.file.mode&0o777)!==0o755)throw fail('NATIVE_MEMORY_PIN_FORMAT','Observer pin fields are invalid');
 const binary=await readRegular(pin.executable,NATIVE_OBSERVER_PIN_LIMITS.binaryBytes);if(!same(binary.file,pin.file))throw fail('NATIVE_MEMORY_PIN_IDENTITY','Observer executable file identity differs from qualification');if(hash(binary.bytes)!==pin.binarySha256)throw fail('NATIVE_MEMORY_PIN_BINARY','Observer executable bytes differ from qualification');
 const receipt=await readRegular(pin.executable+'.json',NATIVE_OBSERVER_PIN_LIMITS.receiptBytes);if(hash(receipt.bytes)!==pin.receiptSha256)throw fail('NATIVE_MEMORY_PIN_RECEIPT','Observer build receipt differs from qualification');let build;try{build=JSON.parse(receipt.bytes);}catch{throw fail('NATIVE_MEMORY_PIN_RECEIPT','Observer build receipt is invalid');}if(build.binarySha256!==pin.binarySha256||build.sourceSha256!==pin.sourceSha256||build.platform!==pin.platform||build.arch!==pin.arch)throw fail('NATIVE_MEMORY_PIN_RECEIPT','Observer build receipt does not bind the pinned source/binary/platform');
 return freeze({pinFile,pinSha256:expectedSha256,pin});
}
export function assertNativeObserverStartupPin(selection,startup){
 const pin=selection.pin;if(startup?.ready!==true||startup.provenance?.executable!==pin.executable||startup.provenance?.binarySha256!==pin.binarySha256||startup.provenance?.sourceSha256!==pin.sourceSha256||!same(startup.binaryFile,pin.file))throw fail('NATIVE_MEMORY_PIN_IDENTITY','Started observer differs from the qualified file');
}
export async function createPinnedNativeProcessMemorySampler(configuration){
 const trace=new NativeMemoryStartupTrace();let selection,sampler;
 try{
  selection=await readVerifiedNativeObserverPin(configuration);if(process.platform!=='darwin'||selection.pin.arch!==process.arch)throw fail('NATIVE_MEMORY_PLATFORM','Pinned native observer requires its qualified Darwin architecture');
  sampler=await createNativeProcessMemorySampler({executable:selection.pin.executable});assertNativeObserverStartupPin(selection,sampler.startupSnapshot());
  sampler.observerPin=freeze({pinFile:selection.pinFile,pinSha256:selection.pinSha256,qualificationSha256:selection.pin.qualificationSha256,executable:selection.pin.executable,binarySha256:selection.pin.binarySha256,sourceSha256:selection.pin.sourceSha256,receiptSha256:selection.pin.receiptSha256,file:{...selection.pin.file}});return sampler;
 }catch(error){let cleanupError;if(sampler){try{const owner=await sampler.close();error.owner??=owner;}catch(e){cleanupError=e;error.owner??=e.owner;}}
  if(sampler)Object.defineProperty(error,'nativeStartup',{value:sampler.startupSnapshot(error,cleanupError?.code),configurable:true});else if(!error.nativeStartup){trace.settle();Object.defineProperty(error,'nativeStartup',{value:trace.snapshot({error}),configurable:true});}
  Object.defineProperty(error,'nativeObserverPin',{value:selection?freeze({pinFile:selection.pinFile,pinSha256:selection.pinSha256,qualificationSha256:selection.pin.qualificationSha256,executable:selection.pin.executable,file:{...selection.pin.file}}):null,configurable:true});throw error;
 }
}
