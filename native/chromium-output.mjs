import {lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// A caller must choose the cache explicitly. No platform-dependent fallback.
export function captureChromiumOutputDirectory(value){
 const match=typeof value==='string'?/^out\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.exec(value):null;
 if(!match||match[0]!==value)throw new Error('Pass explicit --output out/name (one directory under the Chromium checkout)');
 return value;
}

async function directory(path,optional=false){
 const entry=await lstat(path).catch(error=>{if(optional&&error.code==='ENOENT')return null;throw error;});
 if(!entry)return false;
 if(entry.isSymbolicLink()||!entry.isDirectory())throw new Error(`Chromium build directory must be a real directory, not an alias: ${path}`);
 return true;
}

export async function resolveChromiumOutput(source,outputDirectory){
 const relativeDirectory=captureChromiumOutputDirectory(outputDirectory);
 if(typeof source!=='string'||!source)throw new Error('Pass the pinned Chromium source directory');
 const requested=resolve(source);
 await directory(requested);
 const canonical=await realpath(requested);
 const parent=join(canonical,'out'),output=join(canonical,relativeDirectory);
 if(await directory(parent,true))await directory(output,true);
 return Object.freeze({source:canonical,directory:output,relativeDirectory});
}

// Shell build entry points use the same validation before touching a cache.
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(!process.argv[2]||!process.argv[3]||process.argv[4])throw new Error('Usage: node native/chromium-output.mjs SOURCE out/name');
 console.log((await resolveChromiumOutput(process.argv[2],process.argv[3])).directory);
}
