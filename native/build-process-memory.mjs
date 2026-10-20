import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
if(process.platform!=='darwin'||!['arm64','x64'].includes(process.arch))throw new Error('Darwin libproc observer requires a native macOS build');
const source=new URL('./process-memory-darwin.c',import.meta.url),name=`process-memory-sampler-${process.arch}-darwin`,binary=new URL('./bin/'+name,import.meta.url),staged=new URL('./bin/.'+name+'-'+process.pid,import.meta.url);await mkdir(new URL('./bin/',import.meta.url),{recursive:true});
execFileSync('xcrun',['clang','-std=c11','-O2','-Wall','-Wextra','-Werror',fileURLToPath(source),'-lproc','-o',fileURLToPath(staged)],{stdio:'inherit'});await rename(staged,binary);
const hash=b=>createHash('sha256').update(b).digest('hex');const receipt={at:new Date().toISOString(),purpose:'Test-only persistent Darwin libproc memory observer;not Source/browser production code',platform:process.platform,arch:process.arch,sourceSha256:hash(await readFile(source)),binarySha256:hash(await readFile(binary)),compiler:execFileSync('xcrun',['clang','--version'],{encoding:'utf8'}).split('\n')[0],sdk:execFileSync('xcrun',['--show-sdk-version'],{encoding:'utf8'}).trim(),protocol:{requestMagic:'RPQ1',responseMagic:'RPM1',headerBytes:32,rowBytes:56,maxPids:1024,maxOutputBytes:65536}};await writeFile(new URL('./bin/'+name+'.json',import.meta.url),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
