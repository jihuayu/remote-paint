import test from 'node:test';
import assert from 'node:assert/strict';
import {ClientMemory,memoryPolicy} from '../protocol/client-memory.mjs';
import {inspectMetadataJson,parseMetadataJson} from '../protocol/metadata-json.mjs';

test('metadata scanner handles UTF-8, escapes and delimiters inside strings without encoding a copy',()=>{
 for(const value of ['ascii','中文😀','quote " slash \\ braces [{]}','\ud800','\udfff','x\ud800\udfffy']){
  const text=`{"type":"Fixture","value":"${value.replaceAll('\\','\\\\').replaceAll('"','\\"')}"}`;
  assert.equal(inspectMetadataJson(text).byteLength,Buffer.byteLength(text));
  assert.equal(parseMetadataJson(text).value.value,value);
 }
 assert.throws(()=>inspectMetadataJson('{"v":"中文"}',{maxBytes:12}),/wire bytes/);
 assert.doesNotThrow(()=>parseMetadataJson(JSON.stringify({text:'['.repeat(200),escaped:'\\"'.repeat(200)}),{maxDepth:2}));
});

test('metadata structural and memory refusals precede JSON.parse',()=>{
 const original=JSON.parse;let parses=0;JSON.parse=(...args)=>{parses++;return original(...args);};
 try{
  assert.throws(()=>parseMetadataJson('{"v":'+'['.repeat(65)+'0'+']'.repeat(65)+'}'),/nesting/);
  assert.throws(()=>parseMetadataJson('{"v":[0,0,0,0,0]}',{maxNodes:5}),/entries/);
  assert.throws(()=>parseMetadataJson('{"v":0}',{maxEstimateBytes:1024}),/parse estimate/);
  const memory=new ClientMemory({...memoryPolicy(),js:2048});
  assert.throws(()=>parseMetadataJson('{"v":0}',{memory}),/JavaScript/);
  assert.equal(memory.snapshot().owners,0);assert.equal(parses,0);
 }finally{JSON.parse=original;}
});

test('parse work is reserved during parsing and stays owned while metadata waits in a queue',()=>{
 const memory=new ClientMemory(),text=JSON.stringify({type:'SceneUpdate',frame:{values:Array(300).fill(1)}}),estimate=inspectMetadataJson(text).estimatedBytes;
 const original=JSON.parse;JSON.parse=(...args)=>{assert.ok(memory.snapshot().categories.receive>=estimate);return original(...args);};
 let parsed;
 try{parsed=parseMetadataJson(text,{memory});assert.equal(parsed.value.frame.values.length,300);assert.equal(memory.snapshot().categories.receive,estimate);}
 finally{JSON.parse=original;parsed?.release();}
 assert.equal(memory.snapshot().owners,0);
});

test('invalid JSON roots and syntax release their parse reservation',()=>{
 const memory=new ClientMemory();
 for(const text of ['null','[]','1','{"x":','{"x":NaN}','{"x":"unterminated}']){
  assert.throws(()=>parseMetadataJson(text,{memory}));assert.equal(memory.snapshot().owners,0);
 }
 assert.throws(()=>parseMetadataJson('{"privateFixture":"do-not-copy-to-error",}',{memory}),{message:'Invalid metadata JSON'});
});

test('queued tiny-token metadata exhausts its estimated memory budget and recovers after release',()=>{
 const text=JSON.stringify({type:'Fixture',values:Array(100).fill(0)}),estimate=inspectMetadataJson(text).estimatedBytes;
 const memory=new ClientMemory({...memoryPolicy(),js:Math.ceil(estimate*2.5)}),first=parseMetadataJson(text,{memory}),second=parseMetadataJson(text,{memory});
 assert.throws(()=>parseMetadataJson(text,{memory}),/JavaScript/);assert.equal(memory.snapshot().owners,2);
 first.release();const replacement=parseMetadataJson(text,{memory});second.release();replacement.release();assert.equal(memory.snapshot().owners,0);
});
