// Package only completed, provenance-checked builds. No object/cache directories.
import assert from 'node:assert/strict';
import {cp,copyFile,mkdir,readFile,writeFile,chmod,open,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {fileHash,verifyLinuxReceipt} from './linux-receipt.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
export function runtimePath(output,name){
 const path=resolve(output,name),rel=relative(output,path);
 assert.ok(rel&&rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel),`Runtime dependency escapes output: ${name}`);
 return {path,rel};
}
export async function verifyElf(path,cpu){
 assert.ok(['arm64','x64'].includes(cpu),'Unsupported target CPU');
 const file=await open(path,'r'),header=Buffer.alloc(20);
 try{assert.equal((await file.read(header,0,20,0)).bytesRead,20);}finally{await file.close();}
 assert.equal(header.subarray(0,6).toString('hex'),'7f454c460201','Expected little-endian ELF64');
 assert.equal(header.readUInt16LE(18),cpu==='arm64'?183:62,`Wrong ELF architecture: ${path}`);
}
export async function packageLinux({source,cpu,broker,nodeDirectory,destination}){
 assert.equal(process.platform,'linux','Package inside the Linux builder');
 assert.ok(['arm64','x64'].includes(cpu));
 source=resolve(source);destination=resolve(destination);
 const output=join(source,'out/RemotePaintLinux');
 const receipt=JSON.parse(await readFile(join(output,'remote-paint-build.json'),'utf8'));
 await verifyLinuxReceipt(receipt,{cpu,buildProfile:`linux-${cpu}`,patches:receipt.patches,
  argsSha256:await fileHash(join(output,'args.gn')),browserSha256:await fileHash(join(output,'headless_shell')),
  serializerSha256:await fileHash(join(output,'serializer_tests'))});
 // Reject an old receipt even if the completed binaries have not changed yet.
 const {inspectLinuxInputs}=await import('./linux-receipt.mjs');
 const inputs=await inspectLinuxInputs(source);
 for(const key of ['nativeSources','patches','patchedSources','hostConfiguration'])assert.deepEqual(receipt[key],inputs[key],`Stale build receipt: ${key}`);
 for(const binary of [join(output,'headless_shell'),join(output,'serializer_tests'),broker,join(nodeDirectory,'bin/node')])await verifyElf(binary,cpu);
 const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:project,encoding:'utf8'}).trim();
 const name=`remote-paint-linux-${cpu==='x64'?'x86_64':'arm64'}-${revision.slice(0,12)}`;
 const root=join(destination,name);
 // Do not silently merge a previous release into this one.
 await mkdir(destination,{recursive:true});await mkdir(root);
 const files=execFileSync('git',['ls-files','-z'],{cwd:project,encoding:'utf8'}).split('\0').filter(Boolean);
 for(const file of files){
  if(file.startsWith('docs/evidence/')||file.startsWith('.github/')||file.startsWith('examples/'))continue;
  const to=join(root,'app',file);await mkdir(dirname(to),{recursive:true});await copyFile(join(project,file),to);
 }
 await cp(join(project,'node_modules'),join(root,'app/node_modules'),{recursive:true});
 await mkdir(join(root,'app/native/bin'),{recursive:true});await copyFile(broker,join(root,'app/native/bin/remote-paint-broker'));
 await chmod(join(root,'app/native/bin/remote-paint-broker'),0o755);
 await mkdir(join(root,'node/bin'),{recursive:true});
 await copyFile(join(nodeDirectory,'bin/node'),join(root,'node/bin/node'));await chmod(join(root,'node/bin/node'),0o755);
 await copyFile(join(nodeDirectory,'LICENSE'),join(root,'node/LICENSE'));
 const gn=join(source,'buildtools/linux64/gn');
 const dependencies=execFileSync(gn,['desc',output,'//headless:headless_shell','runtime_deps'],{cwd:source,encoding:'utf8',maxBuffer:16*1024*1024}).trim().split('\n');
 const browserFiles=[...new Set([...dependencies,'serializer_tests','args.gn','remote-paint-patches.json','remote-paint-build.json','LICENSE.headless_shell'])];
 for(const file of browserFiles){
  const {path,rel}=runtimePath(output,file.trim()),to=join(root,'browser',rel);
  await mkdir(dirname(to),{recursive:true});await cp(path,to,{recursive:true,dereference:true});
 }
 await writeFile(join(root,'start.sh'),'#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport REMOTE_PAINT_CHROMIUM="$root/browser/headless_shell"\nexport REMOTE_PAINT_BROKER="$root/app/native/bin/remote-paint-broker"\nexec "$root/node/bin/node" "$root/app/live.mjs" "$@"\n',{mode:0o755});
 await writeFile(join(root,'BUILD.json'),JSON.stringify({format:1,projectRevision:revision,cpu,chromium:receipt,
  brokerSha256:await fileHash(broker),nodeSha256:await fileHash(join(nodeDirectory,'bin/node'))},null,2)+'\n');
 await copyFile(join(project,'docs/linux-packages.md'),join(root,'README.md'));
 // File checksums also cover the extracted runtime, not only the outer archive.
 const find=execFileSync('find',['.','-type','f','!','-name','SHA256SUMS','-print0'],{cwd:root}).toString().split('\0').filter(Boolean).sort();
 await writeFile(join(root,'SHA256SUMS'),(await Promise.all(find.map(async file=>`${await fileHash(join(root,file))}  ${file}`))).join('\n')+'\n');
 const archive=join(destination,`${name}.tar.gz`);
 execFileSync('tar',['-czf',archive,'-C',destination,name],{stdio:'inherit'});
 await writeFile(`${archive}.sha256`,`${await fileHash(archive)}  ${name}.tar.gz\n`);
 console.log(JSON.stringify({archive,bytes:(await stat(archive)).size,projectRevision:revision,cpu}));
 return archive;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const {values}=parseArgs({options:{source:{type:'string'},cpu:{type:'string'},broker:{type:'string'},'node-dir':{type:'string'},destination:{type:'string',default:'artifacts/packages'}}});
 for(const key of ['source','cpu','broker','node-dir'])assert.ok(values[key],`Missing --${key}`);
 await packageLinux({source:values.source,cpu:values.cpu,broker:values.broker,nodeDirectory:values['node-dir'],destination:values.destination});
}
