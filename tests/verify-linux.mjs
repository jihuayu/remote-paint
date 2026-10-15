// Execute in the ARM64 runtime with the entire Linux build output mounted.
// A passing suite is Linux evidence; Mac Viewer acceptance runs separately.
import assert from 'node:assert/strict';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,open,readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const project=fileURLToPath(new URL('../',import.meta.url));
const directory=join(project,'artifacts/linux-suite');
const executable=resolve(process.env.REMOTE_PAINT_CHROMIUM??'/browser/headless_shell');
const output=dirname(executable),serializer=join(output,'serializer_tests');
await mkdir(directory,{recursive:true});
const report={startedAt:new Date().toISOString(),status:'running',scope:'Linux native browser acceptance; Mac Viewer acceptance is separate',macViewerVerified:false,checks:[]};
const save=()=>writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
const sha256=async path=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');};
async function inspectElf(path){
 const handle=await open(path,'r'),header=Buffer.alloc(64);
 try{assert.equal((await handle.read(header,0,64,0)).bytesRead,64);}finally{await handle.close();}
 assert.equal(header.subarray(0,4).toString('hex'),'7f454c46',`${path} must be ELF`);
 assert.equal(header[4],2,'Expected a 64-bit ELF');assert.equal(header[5],1,'Expected a little-endian ELF');
 assert.equal(header.readUInt16LE(18),183,'Expected an AArch64 executable');
 return {format:'ELF64',machine:'AArch64',sha256:await sha256(path)};
}
async function run(name,command,args,cwd=project){
 const started=Date.now(),log=createWriteStream(join(directory,`${name}.log`));
 console.log(`Linux acceptance: ${name}`);
 const child=spawn(command,args,{cwd,env:{...process.env,REMOTE_PAINT_CHROMIUM:executable,CHROME_EXECUTABLE_PATH:executable},stdio:['ignore','pipe','pipe']});
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},300000);
 try{
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  const check={name,...result,timedOut,elapsedMs:Date.now()-started};report.checks.push(check);await save();
  assert.equal(timedOut,false,`${name} timed out; see artifacts/linux-suite/${name}.log`);
  assert.equal(result.code,0,`${name} failed; see artifacts/linux-suite/${name}.log`);
 }finally{clearTimeout(timer);await new Promise(resolve=>log.end(resolve));}
}
try{
 assert.equal(process.platform,'linux');assert.equal(process.arch,'arm64');
 assert.notEqual(process.env.REMOTE_PAINT_CLOCK_ONLY,'1','Stock clock probes do not qualify for native acceptance');
 const [browserElf,serializerElf]=await Promise.all([inspectElf(executable),inspectElf(serializer)]);
 const args=await readFile(join(output,'args.gn'),'utf8');
 assert.equal(args,await readFile(join(project,'native/linux-arm64.args.gn'),'utf8'),'Build arguments differ from the Linux profile');
 const applied=JSON.parse(await readFile(join(output,'remote-paint-patches.json'),'utf8'));
 const patches={};
 for(const name of (await readdir(join(project,'native/patches'))).filter(n=>n.endsWith('.patch')).sort()){
  patches[name]=await sha256(join(project,'native/patches',name));assert.equal(applied[name],patches[name],`Build receipt mismatch: ${name}`);
 }
 report.preflight={platform:process.platform,architecture:process.arch,browser:browserElf,serializer:serializerElf,argsSha256:createHash('sha256').update(args).digest('hex'),patches};await save();
 await run('serializer',serializer,[],output);
 for(const name of ['begin-frame','native','scene','input','live'])await run(name,process.execPath,[`tests/verify-${name}.mjs`]);
 const json=async path=>JSON.parse(await readFile(join(project,'artifacts',path),'utf8'));
 const clock=await json('linux/begin-frame-report.json');assert.equal(clock.scope,'custom Linux browser external clock');assert.equal(clock.executableSha256,browserElf.sha256);
 assert.equal(clock.stats.errors,0);assert.ok(clock.stats.acked>0);
 for(const [path,flag] of [['native/report.json','nativeBrowserCapture'],['scene/report.json','nativeBrowserCapture'],['input/report.json','nativeDrawing'],['live/report.json','nativeDrawing']]){
  const result=await json(path);assert.equal(result[flag],true);assert.equal(result.platform,'linux');assert.equal(result.architecture,'arm64');assert.ok(result.beginFrame.acked>0);assert.equal(result.beginFrame.errors,0);
 }
 report.status='passed';
}catch(error){report.status='failed';report.error=error.stack;throw error;}
finally{report.finishedAt=new Date().toISOString();await save();}
console.log(`Linux native suite passed; report: ${join(directory,'report.json')}`);
