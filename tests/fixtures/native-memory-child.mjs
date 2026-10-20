// Explicit fault child for protocol/deadline tests; it never supplies positive
// memory measurements. The allocation mode is measured by real libproc.
const mode=process.argv[2];
if(mode==='allocate'){
 let held;process.on('message',m=>{if(m==='allocate'){held=Buffer.allocUnsafeSlow(64*1024*1024);held.fill(91);process.send({event:'allocated',bytes:held.length,rssBytes:process.memoryUsage().rss});}else if(m==='release'){held=null;global.gc?.();process.send({event:'released',rssBytes:process.memoryUsage().rss});}});process.send({event:'ready',rssBytes:process.memoryUsage().rss});
}else if(mode==='startup-silent'){
 process.stdin.resume();setInterval(()=>{},1000);
}else{
 const header=(id,count=0)=>{const b=Buffer.alloc(32);b.write('RPM1');b.writeUInt32BE(1,4);b.writeBigUInt64BE(BigInt(id),8);b.writeUInt32BE(count,16);return b;};
 const ready=header(0);ready.writeUInt32BE(process.pid,24);ready.writeUInt32BE(1024,28);if(mode==='malformed-ready')ready.write('BAD1');if(mode==='fragmented-ready'){process.stdout.write(ready.subarray(0,5));setTimeout(()=>process.stdout.write(ready.subarray(5)),10);}else process.stdout.write(ready);
 if(mode==='fragmented-ready')process.stdin.once('end',()=>process.exit(0));
 process.stdin.on('data',bytes=>{if(mode==='oversize-count'){const id=bytes.length>=12?bytes.readBigUInt64BE(4):1n;process.stdout.write(header(id,1025));}});setInterval(()=>{},1000);
}
