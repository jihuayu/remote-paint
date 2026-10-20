import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
export const RUNTIME_SOURCE_LIMITS=Object.freeze({manifestBytes:1048576,files:4096,fileBytes:1073741824,totalBytes:2147483648});
export class RuntimeSourceError extends Error {constructor(code){super('Frozen runtime sources are unavailable');this.name='RuntimeSourceError';this.code=code;}}
const fail=code=>new RuntimeSourceError(code),digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),fingerprint=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const path=v=>typeof v==='string'&&isAbsolute(v)&&v.length<=2048&&!/[\x00-\x1f\x7f]/.test(v);
async function hashFile(file,limit,{text=false}={}){
 let fd;try{fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=await fd.stat({bigint:true});if(!before.isFile()||before.size<0n||before.size>BigInt(limit))throw fail('SOURCE_FILE_LIMIT');const hash=createHash('sha256'),buffer=Buffer.alloc(65536),parts=[];let used=0;
  for(;;){const {bytesRead}=await fd.read(buffer,0,buffer.length,null);if(!bytesRead)break;used+=bytesRead;if(used>limit)throw fail('SOURCE_FILE_LIMIT');hash.update(buffer.subarray(0,bytesRead));if(text)parts.push(Buffer.from(buffer.subarray(0,bytesRead)));}
  if(used!==Number(before.size)||!same(fingerprint(before),fingerprint(await fd.stat({bigint:true}))))throw fail('SOURCE_CHANGED');return {sha256:hash.digest('hex'),bytes:used,...(text?{text:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts))}:{})};
 }catch(e){throw e instanceof RuntimeSourceError?e:fail('SOURCE_READ');}finally{await fd?.close();}
}
export async function verifyRuntimeSourceManifest({root,manifest,expectedSha256,requiredFiles=[]}={}){
 if(!path(root)||!path(manifest)||!digest(expectedSha256)||!Array.isArray(requiredFiles)||requiredFiles.length>64||requiredFiles.some(x=>typeof x!=='string'))throw new TypeError('Configure fixed source root,manifest and SHA256');
 try{const directory=await lstat(root,{bigint:true});if(!directory.isDirectory()||directory.isSymbolicLink())throw fail('SOURCE_ROOT');const resolved=await realpath(root),document=await hashFile(manifest,RUNTIME_SOURCE_LIMITS.manifestBytes,{text:true});if(document.sha256!==expectedSha256)throw fail('SOURCE_MANIFEST_DIGEST');const value=JSON.parse(document.text);
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join()!=='files,schema'||value.schema!=='runtime-source-files-v1'||!value.files||Object.getPrototypeOf(value.files)!==Object.prototype)throw fail('SOURCE_MANIFEST_FORMAT');const files=Object.entries(value.files);if(files.length>RUNTIME_SOURCE_LIMITS.files)throw fail('SOURCE_FILE_COUNT');if(requiredFiles.some(x=>!Object.hasOwn(value.files,x)))throw fail('SOURCE_REQUIRED');let bytes=0;
  for(const [name,hash]of files){if(name.length>2048||!name.length||isAbsolute(name)||/[\\\x00-\x1f\x7f]/.test(name)||name.split('/').some(x=>!x||x==='.'||x==='..')||!digest(hash))throw fail('SOURCE_MANIFEST_FORMAT');const file=join(root,name);if(!(await realpath(file)).startsWith(resolved+sep))throw fail('SOURCE_ROOT');const found=await hashFile(file,Math.min(RUNTIME_SOURCE_LIMITS.fileBytes,RUNTIME_SOURCE_LIMITS.totalBytes-bytes));if(found.sha256!==hash)throw fail('SOURCE_BYTES');bytes+=found.bytes;}
  const after=await lstat(root,{bigint:true});if(!after.isDirectory()||after.isSymbolicLink()||after.dev!==directory.dev||after.ino!==directory.ino)throw fail('SOURCE_ROOT');if((await hashFile(manifest,RUNTIME_SOURCE_LIMITS.manifestBytes)).sha256!==expectedSha256)throw fail('SOURCE_MANIFEST_DIGEST');return Object.freeze({manifestSha256:expectedSha256,files:files.length,bytes});
 }catch(e){throw e instanceof RuntimeSourceError?e:fail('SOURCE_MANIFEST_READ');}
}
