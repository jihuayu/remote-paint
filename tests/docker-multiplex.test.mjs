import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {decodeDockerMultiplex,DockerMultiplexError} from '../service/docker-multiplex.mjs';
const code=value=>error=>error instanceof DockerMultiplexError&&error.code===value;
function frame(stream,value){const bytes=Buffer.from(value),header=Buffer.alloc(8);header[0]=stream;header.writeUInt32BE(bytes.length,4);return Buffer.concat([header,bytes]);}
async function* source(chunks){for(const chunk of chunks)yield chunk;}
const collect=async(chunks,options)=>{const out=[];for await(const item of decodeDockerMultiplex(source(chunks),options))out.push(item);return out;};
const text=items=>items.map(item=>({stream:item.stream,value:item.bytes.toString()}));
test('non-TTY headers separate stdout/stderr and preserve opaque payload bytes in order',async()=>{
 const wire=Buffer.concat([frame(1,'hello\n'),frame(2,'private-stderr\n'),frame(1,Buffer.from([0,255,10]))]),out=await collect([wire]);assert.deepEqual(out.map(x=>x.stream),['stdout','stderr','stdout']);assert.equal(out[0].bytes.toString(),'hello\n');assert.equal(out[1].bytes.toString(),'private-stderr\n');assert.deepEqual(out[2].bytes,Buffer.from([0,255,10]));assert.equal(Object.isFrozen(out[0]),true);
});
test('every split across headers,UTF8 payloads and adjoining frames preserves exact bytes',async()=>{
 const wire=Buffer.concat([frame(1,'甲乙\n'),frame(2,'错误'),frame(1,'tail')]),expected=[{stream:'stdout',value:'甲乙\n'},{stream:'stderr',value:'错误'},{stream:'stdout',value:'tail'}];
 for(let n=1;n<wire.length;n++)assert.deepEqual(text(await collect([wire.subarray(0,n),wire.subarray(n)])),expected);assert.deepEqual(text(await collect([...wire].map(b=>Buffer.from([b])))),expected);
});
test('zero-sized valid frames consume headers without creating output or changing the next stream',async()=>{
 assert.deepEqual(text(await collect([Buffer.concat([frame(2,''),frame(1,'x'),frame(1,''),frame(2,'y'),frame(2,'')])])),[{stream:'stdout',value:'x'},{stream:'stderr',value:'y'}]);assert.deepEqual(await collect([]),[]);
});
test('the service frame maximum is accepted without retaining an oversized input backing store',async()=>{
 const payload=Buffer.alloc(65536,37),wire=frame(1,payload),out=await collect([wire.subarray(0,32768),wire.subarray(32768)]);assert.equal(out.length,1);assert.deepEqual(out[0].bytes,payload);assert.equal(out[0].bytes.buffer.byteLength,65536);
});
test('oversized and uint32-max declarations reject before reading or allocating the payload',async()=>{
 for(const size of [65537,0xffffffff]){let requestedPayload=false;async function* input(){const header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(size,4);yield header;requestedPayload=true;yield Buffer.from('private-secret');}await assert.rejects(async()=>{for await(const _ of decodeDockerMultiplex(input())){}},code('ATTACH_STREAM_FRAME_LIMIT'));assert.equal(requestedPayload,false);}
});
test('TTY/raw bytes,unknown streams and nonzero reserved header bytes never reach the consumer',async()=>{
 for(const change of [h=>h[0]=0,h=>h[0]=3,h=>h[0]=255,h=>h[1]=1,h=>h[2]=1,h=>h[3]=1]){const bytes=frame(1,'private-secret');change(bytes);await assert.rejects(collect([bytes]),code('ATTACH_STREAM_HEADER'));}await assert.rejects(collect([Buffer.from('raw-private-secret')]),e=>e instanceof DockerMultiplexError&&!JSON.stringify(e).includes('private-secret'));
});
test('EOF in any header or payload position rejects without yielding a partial frame',async()=>{
 const wire=frame(1,'WorkerHello\n');for(let n=1;n<wire.length;n++){let emitted=0;await assert.rejects(async()=>{for await(const _ of decodeDockerMultiplex(source([wire.subarray(0,n)])))emitted++;},code('ATTACH_STREAM_TRUNCATED'));assert.equal(emitted,0);}
});
test('no worker protocol bytes are exposed until the complete declared multiplex payload arrives',async()=>{
 let release,waiting=false;const gate=new Promise(resolve=>release=resolve),wire=frame(1,'Ready\ntail');async function* input(){yield wire.subarray(0,14);waiting=true;await gate;yield wire.subarray(14);}const iterator=decodeDockerMultiplex(input()),pending=iterator.next();let emitted=false;void pending.then(()=>emitted=true);while(!waiting)await new Promise(resolve=>setImmediate(resolve));assert.equal(emitted,false);release();assert.equal((await pending).value.bytes.toString(),'Ready\ntail');assert.equal((await iterator.next()).done,true);
});
test('consumer backpressure does not fetch or queue the next source chunk',async()=>{
 let fetched=0;async function* input(){fetched++;yield frame(1,'first');fetched++;yield frame(2,'second');fetched++;}const iterator=decodeDockerMultiplex(input()),first=await iterator.next();assert.equal(first.value.bytes.toString(),'first');await new Promise(resolve=>setImmediate(resolve));assert.equal(fetched,1);assert.equal((await iterator.next()).value.bytes.toString(),'second');assert.equal(fetched,2);assert.equal((await iterator.next()).done,true);assert.equal(fetched,3);
});
test('complete payload ownership is independent of source mutation,next frames,EOF and iterator cancellation',async()=>{
 const wire=frame(1,'first'),iterator=decodeDockerMultiplex(source([wire,frame(1,'second')])),first=(await iterator.next()).value;wire.fill(0);assert.equal(first.bytes.toString(),'first');const second=(await iterator.next()).value;await iterator.return();assert.equal(first.bytes.toString(),'first');assert.equal(second.bytes.toString(),'second');
});
test('early consumer cancellation closes its source once without reading another frame',async()=>{
 let closed=0,next=false;async function* input(){try{yield frame(1,'first');next=true;yield frame(1,'second');}finally{closed++;}}const iterator=decodeDockerMultiplex(input());await iterator.next();await iterator.return();assert.equal(closed,1);assert.equal(next,false);
});
test('source errors are redacted and cannot become a clean EOF or a partial successful frame',async()=>{
 async function* input(){yield frame(1,'ok');yield frame(2,'partial').subarray(0,10);throw Error('https://private.test/#owner-secret');}const iterator=decodeDockerMultiplex(input());assert.equal((await iterator.next()).value.bytes.toString(),'ok');await assert.rejects(iterator.next(),e=>code('ATTACH_STREAM_IO')(e)&&!JSON.stringify(e).includes('owner-secret'));
});
test('empty,non-byte and oversized source chunks reject under the explicit source contract',async()=>{
 for(const chunk of [Buffer.alloc(0),'private-secret',new Uint8Array([1]),Buffer.alloc(65537)])await assert.rejects(collect([chunk]),e=>code('ATTACH_STREAM_CHUNK_LIMIT')(e)&&!JSON.stringify(e).includes('private-secret'));assert.throws(()=>decodeDockerMultiplex([]),TypeError);
});
test('configured frame/input caps remain finite and are checked at protocol boundaries',async()=>{
 for(const patch of [{maxFrameBytes:0},{maxFrameBytes:65537},{maxChunkBytes:7},{maxChunkBytes:65537},{maxFrameBytes:1.5}])assert.throws(()=>decodeDockerMultiplex(source([]),patch),TypeError);await assert.rejects(collect([frame(1,'long')],{maxFrameBytes:3}),code('ATTACH_STREAM_FRAME_LIMIT'));assert.equal((await collect([frame(1,'yes')],{maxFrameBytes:3}))[0].bytes.toString(),'yes');
});
test('concurrent decoders keep independent partial headers and payload state',async()=>{
 const a=frame(1,'alpha'),b=frame(2,'beta'),[one,two]=await Promise.all([collect([a.subarray(0,3),a.subarray(3,10),a.subarray(10)]),collect([b.subarray(0,7),b.subarray(7)])]);assert.deepEqual(text(one),[{stream:'stdout',value:'alpha'}]);assert.deepEqual(text(two),[{stream:'stderr',value:'beta'}]);
});
test('actual Node stream delivery preserves bounded binary frames and reports truncated stream closure',async()=>{
 const stream=new PassThrough({highWaterMark:32}),out=collectStream(stream);stream.write(frame(1,'live').subarray(0,3));stream.end(frame(1,'live').subarray(3));assert.deepEqual(text(await out),[{stream:'stdout',value:'live'}]);const broken=new PassThrough(),pending=collectStream(broken);broken.end(frame(1,'live').subarray(0,10));await assert.rejects(pending,code('ATTACH_STREAM_TRUNCATED'));
});
async function collectStream(stream){const out=[];for await(const item of decodeDockerMultiplex(stream))out.push(item);return out;}
