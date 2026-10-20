// Disposable subprocess for RSS deadline tests. This never measures RSS.
import {readFile,writeFile} from 'node:fs/promises';
const [mode,path,pid]=process.argv.slice(2);let count=0;
if(mode==='timeout-once'){count=Number(await readFile(path,'utf8').catch(()=>0));await writeFile(path,String(count+1));}
if(mode==='always-timeout'||mode==='timeout-once'&&!count){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
else if(mode==='exit')process.exitCode=7;
else if(mode==='malformed')process.stdout.write('malformed\n');
else if(mode==='overflow')process.stdout.write('x'.repeat(128*1024));
else process.stdout.write(`${pid} 256\n`);
