import test from 'node:test';
import assert from 'node:assert/strict';
import {PNG} from 'pngjs';
import {inspectResourceMemory,pngMemoryBytes,makeResourceMemory} from '../protocol/resource-memory.mjs';
const image=PNG.sync.write(new PNG({width:2,height:3}));
function fixture(){const prefix=Buffer.from('skiapict-padding'),font=Buffer.alloc(32,5),payload=Buffer.concat([prefix,image,font]);return {payload,record:{assetRangeVersion:1,assetRangesComplete:true,assetRanges:[{offset:prefix.length,bytes:image.length,kind:'image'},{offset:prefix.length+image.length,bytes:font.length,kind:'font',glyphSlots:65536}]}};}
test('memory estimates use real PNG dimensions and retained font slots rather than compressed sizes',()=>{
 const {payload,record}=fixture(),memory=inspectResourceMemory(payload,record);assert.equal(memory.imageBytes,48);assert.equal(memory.fontBytes,32*4+65536*128+65536);assert.equal(pngMemoryBytes(image),48);
});
test('partial, incompatible or over-count native indexes cannot claim decode safety',()=>{
 const {payload,record}=fixture();for(const patch of [{assetRangesComplete:false},{assetRangeVersion:2},{assetRanges:null},{assetRanges:Array(257).fill(record.assetRanges[0])}])assert.throws(()=>inspectResourceMemory(payload,{...record,...patch}));assert.equal(inspectResourceMemory(payload,{}),null);
});
test('invalid PNG CRC, overlap and glyph-slot metadata fail before a decoder is invoked',()=>{
 const {payload,record}=fixture(),corrupt=Buffer.from(image);corrupt[16]^=1;assert.throws(()=>pngMemoryBytes(corrupt),/PNG/);
 for(const glyphSlots of [0,65537,2.5])assert.throws(()=>inspectResourceMemory(payload,{...record,assetRanges:[record.assetRanges[0],{...record.assetRanges[1],glyphSlots}]}),/glyph/);
 assert.throws(()=>inspectResourceMemory(payload,{...record,assetRanges:[record.assetRanges[0],{...record.assetRanges[1],offset:record.assetRanges[0].offset}]}),/overlapping/);
});
test('a frame memory summary is available only when every required resource has a complete descriptor',()=>{
 const bounds=new Map([['a',{imageBytes:48,fontBytes:0}],['b',null]]);assert.equal(makeResourceMemory(['a','b'],bounds),null);assert.equal(makeResourceMemory(['missing'],bounds),null);assert.deepEqual(makeResourceMemory(['a'],bounds),{version:1,resources:{a:{imageBytes:48,fontBytes:0}}});assert.deepEqual(makeResourceMemory([],bounds),{version:1,resources:{}});
});
