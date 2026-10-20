import test from 'node:test';
import assert from 'node:assert/strict';
import {passDamage} from '../viewer/damage.mjs';
const matrix=[1,0,0,0,1,0,0,0,1],output=[0,0,100,100];
const q=(extra={})=>({kind:'solid',matrix,rect:[10,10,20,20],visible:[10,10,20,20],clip:null,opacity:1,color:[1,0,0,1],...extra});
test('damage handles removals, reorder, target clips and fractional rotations conservatively',()=>{
 const old={id:'root',output,quads:[q(),q({rect:[70,70,80,80],visible:[70,70,80,80]})]};
 assert.deepEqual(passDamage({...old,quads:[]},old,new Map()),[8,8,82,82]);
 assert.deepEqual(passDamage({...old,quads:[...old.quads].reverse()},old,new Map()),[8,8,82,82]);
 const changed={...old,quads:[q({matrix:[1,.2,0,.1,1,0,0,0,1],clip:[0,0,18,19]}),old.quads[1]]};
 assert.deepEqual(passDamage(changed,old,new Map()),[8,8,22,22]);
});
test('unimplemented effect and perspective dependencies force a complete pass damage',()=>{
 const old={id:'root',output,quads:[q()]};
 for(const changed of [q({matrix:[1,0,0,0,1,0,.001,0,1]}),q({filters:[{blur:4}]}),q({backdrop:[1]})])assert.deepEqual(passDamage({...old,quads:[changed]},old,new Map()),output);
 assert.deepEqual(passDamage({...old,filters:[1]},old,new Map()),output);
});
