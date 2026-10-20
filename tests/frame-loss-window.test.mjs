import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {observeFrameLoss} from './frame-age-observer.mjs';
const fixture=()=>({broker:new EventEmitter(),capture:{binding:{config:{id:'scope'}}},stats:{captures:3}});
const rejection=n=>({event:'NativeFrameRejected',captureId:'scope:'+n,code:'TEST_ONLY_EVENT',outcome:'retry',reason:'Synthetic collector contract event,not actual fault evidence'});
test('bounded rejection drains preserve lifetime ordinals and exact coverage across multiple windows',()=>{
 const source=fixture(),observer=observeFrameLoss(source,new Set(),{drainable:true});
 for(let i=1;i<=256;i++)source.broker.emit('event',rejection(i));const first=observer.drain();assert.equal(first.rejections.length,256);assert.equal(first.throughObservationOrdinal,256);assert.equal(observer.rejections.length,0);
 source.broker.emit('event',rejection(257));const next=observer.drain();assert.equal(next.windowOrdinal,2);assert.equal(next.rejections[0].observationOrdinal,257);assert.equal(next.afterObservationOrdinal,256);assert.equal(next.rejectionCount,257);assert.equal(observer.snapshot().receivedRejectionEvents,257);assert.equal(observer.snapshot().retainedRejections,0);assert.equal(observer.drain().rejections.length,0);
 observer.close();assert.equal(source.broker.listenerCount('event'),0);source.broker.emit('event',rejection(258));assert.equal(observer.snapshot().rejectionCount,257);
});
test('a malformed or overflowing drainable observer fails its proof without throwing into the Source emitter',()=>{
 for(const cause of ['malformed','overflow']){
  const source=fixture(),observer=observeFrameLoss(source,new Set(),{drainable:true});
  if(cause==='overflow')for(let i=1;i<=256;i++)source.broker.emit('event',rejection(i));
  assert.doesNotThrow(()=>source.broker.emit('event',cause==='malformed'?{...rejection(1),outcome:'invented'}:rejection(257)));
  assert.ok(observer.snapshot().observerFailure);assert.throws(()=>observer.drain(),/incomplete/);assert.ok(observer.rejections.length<=256);observer.close();
 }
});
test('legacy collectors retain their original bounded behavior and cannot silently enable drains',()=>{
 const source=fixture(),observer=observeFrameLoss(source);source.broker.emit('event',rejection(1));assert.equal(observer.snapshot().rejectionCount,1);assert.equal(observer.rejections[0].matchedActiveScope,true);assert.throws(()=>observer.drain(),/not configured/);assert.throws(()=>source.broker.emit('event',{...rejection(2),captureId:'invalid'}));observer.close();
});
