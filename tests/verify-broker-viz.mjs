import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {NativeBroker} from '../native/broker.mjs';
import {startVizIPC} from '../capture/viz-ipc.mjs';
import {decodeVizScene} from '../capture/viz-wire.mjs';
// Independent binary fixture matching the C++ writer. Splitting a frame at
// every byte and concatenating frames checks real stream framing behavior.
function packet(id,error=null){const parts=[Buffer.from('RVB2\x01\x01')];const u8=n=>parts.push(Buffer.from([n]));const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);parts.push(b);};const f64=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);parts.push(b);};const string=s=>{const b=Buffer.from(s);u32(b.length);parts.push(b);};string(id);u32(1);u32(2);u32(error?0:1);if(!error){string('root');[0,0,100,100].forEach(f64);u32(1);u8(1);u32(0);u32(1);u32(2);[1,0,0,0,1,0,0,0,1].forEach(f64);[0,0,100,100,0,0,100,100,0,0,1].forEach(f64);u8(0);u8(0);u32(0);[1,0,0,1].forEach(f64);}u8(error?1:0);if(error)string(error);const body=Buffer.concat(parts),head=Buffer.alloc(4);head.writeUInt32BE(body.length);return Buffer.concat([head,body]);}
const broker=new NativeBroker(),viz=await startVizIPC({broker});let socket;
try{
 const first=viz.waitFor('first'),second=viz.waitFor('second');await Promise.all([first.registered,second.registered]);
 socket=net.createConnection(viz.endpoint);await once(socket,'connect');const a=packet('first');for(const byte of a)socket.write(Buffer.from([byte]));socket.write(packet('second'));
 const [one,two]=await Promise.all([first,second]);assert.deepEqual(one,{captureId:'first',native:true});assert.equal(two.native,true);
 const mapped=await broker.map({captureId:'first',producer:'contract',resources:[],viz:one},{epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1}});assert.equal(mapped.scene.passes[0].quads[0].kind,'solid');
 const expected=decodeVizScene(a.subarray(4));assert.deepEqual(mapped.scene.passes[0].quads[0].color,expected.passes[0].quads[0].color);
 assert.equal(decodeVizScene(packet('failure-decode','native error').subarray(4)).error,'native error');
 const failure=viz.waitFor('failed');failure.catch(()=>{});await failure.registered;socket.write(packet('failed','Unsupported Viz material'));await assert.rejects(failure,/Unsupported Viz material/);
 socket.write(packet('unknown'));await new Promise(resolve=>setTimeout(resolve,30));assert.equal(viz.stats.received,3);assert.ok(viz.stats.rejected>=1);
 await new Promise(resolve=>setTimeout(resolve,16000));const idle=viz.waitFor('after-idle');await idle.registered;socket.write(packet('after-idle'));assert.equal((await idle).native,true,'A private persistent socket must survive a paused compositor');
 for(let i=0;i<10;i++)assert.throws(()=>decodeVizScene(a.subarray(4,10+i)),/Truncated|Invalid/);
 console.log('Native binary Viz: persistent fragmented stream, pairing without Node scene payload, error and unknown frame rejection passed');
}finally{socket?.destroy();await viz.close();await broker.close();}
