// The build/test checkout may contain public TLS fixture keys; the delivered
// server must not contain keys or local account configuration, even fixtures.
import assert from 'node:assert/strict';
import {readdir,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fileHash} from '../native/linux-receipt.mjs';

export function excludedDistributionPath(path){
 return path.split('/').some(part=>/^\.env(?:\.|$)/.test(part)||['.aws','.ssh','.npmrc','.netrc','.pypirc','id_rsa','id_ed25519'].includes(part))||/\.(pem|key|p12|pfx)$/i.test(path);
}
async function sanitize(root,relative=''){
 let removed=0;
 for(const entry of await readdir(join(root,relative),{withFileTypes:true})){
  const path=relative?`${relative}/${entry.name}`:entry.name;
  if(excludedDistributionPath(path)){await rm(join(root,path),{recursive:true,force:true});removed++;}
  else if(entry.isDirectory())removed+=await sanitize(root,path);
 }
 return removed;
}
async function listFiles(root,relative=''){
 const result=[];
 for(const entry of await readdir(join(root,relative),{withFileTypes:true})){
  const path=relative?`${relative}/${entry.name}`:entry.name;
  if(entry.isDirectory())result.push(...await listFiles(root,path));
  else if(entry.isFile()&&path!=='SHA256SUMS')result.push(path);
 }
 return result;
}
export async function prepareDistribution(directory){
 const destination=resolve(directory);
 const roots=(await readdir(destination,{withFileTypes:true})).filter(e=>e.isDirectory()&&/^remote-paint-linux-(?:arm64|x86_64)-[a-f0-9]{12}$/.test(e.name));
 assert.equal(roots.length,1,'Expected exactly one freshly built architecture package');
 const name=roots[0].name,root=join(destination,name);
 const removed=await sanitize(root);
 const build=JSON.parse(await readFile(join(root,'BUILD.json'),'utf8'));
 build.distribution={policy:'no-key-or-local-config-files-v1',removedPaths:removed};
 await writeFile(join(root,'BUILD.json'),JSON.stringify(build,null,2)+'\n');
 const files=(await listFiles(root)).sort();
 assert.ok(files.length>0);
 assert.ok(files.every(file=>!excludedDistributionPath(file)));
 await writeFile(join(root,'SHA256SUMS'),(await Promise.all(files.map(async file=>`${await fileHash(join(root,file))}  ./${file}`))).join('\n')+'\n');
 const archive=join(destination,`${name}.tar.gz`);
 execFileSync('tar',['-czf',archive,'-C',destination,name],{stdio:'inherit'});
 await writeFile(`${archive}.sha256`,`${await fileHash(archive)}  ${name}.tar.gz\n`);
 console.log(JSON.stringify({distribution:name,removedKeyOrConfigPaths:removed}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await prepareDistribution(process.argv[2]);
