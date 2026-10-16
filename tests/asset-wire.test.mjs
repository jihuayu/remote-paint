import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AssetCache,decodeAsset} from '../protocol/asset-wire.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const wire=payload=>Buffer.concat([Buffer.from('RPNT\x01\x02\0\0','binary'),Buffer.from([0,0,0,payload.length]),Buffer.from(hash(payload),'hex'),payload]);
test('font/image blocks survive changed command streams and release of old SKPs',()=>{
 const cache=new AssetCache(),font=Buffer.alloc(32,17),image=Buffer.alloc(64,29);
 for(const bytes of [font,image]){const packet=decodeAsset(wire(bytes));assert.equal(packet.kind,'chunk');cache.put(packet.id,packet.payload);}
 const make=text=>{const command=Buffer.from(`skiapict${text}`);cache.put(hash(command),command);const bytes=Buffer.concat([command,font,image]);return {bytes,manifest:{id:hash(bytes),bytes:bytes.length,chunks:[{id:hash(command),kind:'skp'},{id:hash(font),kind:'font'},{id:hash(image),kind:'image'}]}};};
 const a=make('old'),b=make('new');assert.deepEqual(Buffer.from(cache.assemble(a.manifest)),a.bytes);const received=cache.stats.receivedBytes;assert.deepEqual(Buffer.from(cache.assemble(b.manifest)),b.bytes);assert.equal(hash(cache.assemble(b.manifest)),b.manifest.id);assert.equal(cache.stats.receivedBytes,received);assert.ok(cache.stats.reusedBytes>=96);
 cache.clear();assert.equal(cache.assemble(b.manifest),null);
});
test('asset decoder and manifest reject truncation, overlap-sized length and bad references',()=>{
 const cache=new AssetCache(),bytes=Buffer.from('skiapict-resource-contents-long'),id=hash(bytes);cache.put(id,bytes);
 const manifest={id,bytes:bytes.length,chunks:[{id,kind:'skp'}]};assert.throws(()=>decodeAsset(wire(bytes).subarray(0,-1)),/length/);assert.throws(()=>cache.assemble({...manifest,bytes:bytes.length+1}),/length/);assert.throws(()=>cache.assemble({...manifest,chunks:[{id,kind:'script'}]}),/reference/);
 const corrupted=Buffer.from(bytes);corrupted[10]^=1;assert.notEqual(hash(corrupted),id,'Worker SHA verification detects corrupted chunk and assembled SKP');
});
