import {createHash} from 'node:crypto';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
const compress=promisify(gzip);

const bundles=new Map(),creating=new Map();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function acceptsGzip(header=''){
 const values=new Map(String(header).split(',').map(part=>{const [name,...params]=part.trim().toLowerCase().split(';');const parameter=params.map(v=>v.trim()).find(v=>v.startsWith('q='));const quality=parameter?Number(parameter.slice(2)):1;return [name,Number.isFinite(quality)&&quality>=0&&quality<=1?quality:0];}));
 return (values.get('gzip')??values.get('*')??0)>0;
}
export async function makeStaticAssets(inputs){
 const digest=createHash('sha256').update('remote-paint-static-v1\0').update(makeStaticAssets.toString()).update(hash.toString());
 for(const [path,{bytes,type}]of [...inputs].sort(([a],[b])=>a<b?-1:a>b?1:0)){digest.update(JSON.stringify([path,type,bytes.length])).update('\0').update(bytes);}
 const build=digest.digest('hex');
 if(bundles.has(build)){const bundle=bundles.get(build);bundles.delete(build);bundles.set(build,bundle);return bundle;}
 if(creating.has(build))return creating.get(build);
 const produce=async()=>{
 const prefix=`/assets/${build}`,wasmSha256=hash(inputs.get('/vendor/canvaskit.wasm').bytes),files=new Map();
 for(const [path,asset]of inputs){
  let bytes=asset.bytes;
  if(/javascript|text\/html|text\/css/.test(asset.type)){
   let source=bytes.toString('utf8');
   for(const logical of inputs.keys())if(logical!=='/')for(const quote of ["'",'"','`']){
    source=source.replaceAll(`${quote}${logical}${quote}`,`${quote}${prefix}${logical}${quote}`);
    // Repo Viewer modules live one directory below protocol/, while their
    // served URLs share the bundle root. Preserve that cross-directory edge.
    if(logical.startsWith('/protocol/'))source=source.replaceAll(`${quote}..${logical}${quote}`,`${quote}${prefix}${logical}${quote}`);
    // The child bridge is also imported directly by Node contract tests. Keep
    // its SDK-relative imports on the single canonical served module URL.
    if(logical==='/connection.mjs')source=source.replaceAll(`${quote}../sdk/viewer-connection.mjs${quote}`,`${quote}${prefix}${logical}${quote}`);
    if(logical==='/viewer-channel.mjs')source=source.replaceAll(`${quote}../sdk/viewer-channel.mjs${quote}`,`${quote}${prefix}${logical}${quote}`);
   }
   source=source.replaceAll('`/vendor/',`\`${prefix}/vendor/`).replaceAll('__REMOTE_PAINT_VIEWER_BUILD__',build).replaceAll('__REMOTE_PAINT_WASM_SHA__',wasmSha256);
   bytes=Buffer.from(source);
  }
  const zipped=bytes.length>=1024?await compress(bytes,{level:3}):null;
  const gzip=zipped&&zipped.length<bytes.length*.95?zipped:null;
  files.set(path,{bytes,type:asset.type,etag:`"${hash(bytes)}"`,gzip,gzipEtag:gzip?`"${hash(gzip)}"`:null});
 }
 const bundle={build,wasmSha256,prefix,get(path){
  if(path.startsWith('/assets/')){if(!path.startsWith(`${prefix}/`))return {expired:true};const logical=path.slice(prefix.length);return logical==='/'?null:files.has(logical)?{...files.get(logical),immutable:true}:null;}
  return files.has(path)?{...files.get(path),immutable:false}:null;
 }};
 bundles.set(build,bundle);while(bundles.size>2)bundles.delete(bundles.keys().next().value);
 return bundle;
 };
 const promise=produce();creating.set(build,promise);
 try{return await promise;}finally{creating.delete(build);}
}
