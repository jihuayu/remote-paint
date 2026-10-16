import test from 'node:test';
import assert from 'node:assert/strict';
import {predictOptimistic} from '../viewer/input.mjs';

const state={kind:'input',x:0,y:0,width:200,height:40,text:'abcd',selectionStart:2,selectionEnd:2,style:{fontSize:'16px'}};
test('predicts printable insertion and preserves editor metadata',()=>{
 const next=predictOptimistic(state,{kind:'key',type:'keyDown',key:'X',text:'X'});
 assert.deepEqual(next,{...state,text:'abXcd',selectionStart:3,selectionEnd:3,style:{fontSize:'16px'}});
});
test('predicts deletion and selection movement without mutating the committed state',()=>{
 const next=predictOptimistic({...state,selectionStart:1,selectionEnd:3},{kind:'key',type:'keyDown',key:'Backspace'});
 assert.equal(next.text,'ad');assert.equal(next.selectionStart,1);assert.equal(next.selectionEnd,1);assert.equal(state.text,'abcd');
 assert.equal(predictOptimistic(state,{kind:'key',type:'keyDown',key:'PageDown'}),null);
});
