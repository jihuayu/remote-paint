import test from 'node:test';
import CRC from 'pngjs/lib/crc.js';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {captureManagedAgentScreenshot,captureManagedAgentScreenshotRead,captureAgentScreenshotResult,captureAgentScreenshotChunk,decodeAgentScreenshot,createAgentScreenshotOwner} from '../live/agent-screenshot.mjs';
import {screenshotFixture,screenshotPng} from './fixtures/agent-screenshot-fixture.mjs';
import {setup} from './fixtures/agent-observation-realm-fixture.mjs';
const error=code=>e=>e.code===code,sha=v=>createHash('sha256').update(v).digest('hex'),gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('screenshot capture and chunk inputs are exact bounded own data without paths format clip or selectors',()=>{
 assert.equal(captureManagedAgentScreenshot().limits.maxBytes,1048576);for(const limits of [null,[],{format:'jpeg'},{maxBytes:null},{maxBytes:0},{maxBytes:true},{maxBytes:4194305},{fullPage:true},{path:'/private'}])assert.throws(()=>captureManagedAgentScreenshot(limits));let reads=0;assert.throws(()=>captureManagedAgentScreenshot(Object.defineProperty({},'maxBytes',{get(){reads++;}})));assert.equal(reads,0);for(const v of [['raw',0,3072],['shot_'+crypto.randomUUID(),-1,1],['shot_'+crypto.randomUUID(),0,3073],['shot_'+crypto.randomUUID(),true,1]])assert.throws(()=>captureManagedAgentScreenshotRead(...v));
});
test('Source screenshot pins original viewport Page Native world and version and returns metadata only',async t=>{
 const h=screenshotFixture(t),r=await h.capture();assert.equal(r.stage,'screenshot-observed');assert.equal(r.scope,'main-frame-viewport-source-pixels');assert.equal(r.width,640);assert.equal(r.height,480);assert.equal(r.byteLength,h.png.length);assert.equal(r.sha256,sha(h.png));assert.ok(Object.isFrozen(r.document)&&Object.isFrozen(r.limits));assert.equal(r.document.controlVersion,undefined);assert.ok(!JSON.stringify(r).includes('data:'));const call=h.base.calls.find(c=>c.method==='Page.captureScreenshot');assert.deepEqual(call.params,{format:'png',fromSurface:true,captureBeyondViewport:false,optimizeForSpeed:false});assert.equal(h.base.calls.filter(c=>c.method==='Runtime.callFunctionOn'&&c.params.functionDeclaration.includes('screenshotMetadata')).length,2);
});
test('screenshot chunks reconstruct the original PNG with stable hash metadata offset and actual pixels',async t=>{
 const h=screenshotFixture(t),r=await h.capture(),parts=[];let offset=0,complete=false;
 while(!complete){const chunk=await h.base.run.readScreenshot(r.screenshotId,offset,h.context,101);assert.equal(chunk.sha256,r.sha256);assert.equal(chunk.observedAt,r.observedAt);assert.equal(chunk.offset,offset);assert.ok(Buffer.byteLength(JSON.stringify(chunk))<=6144);const bytes=Buffer.from(chunk.data,'base64');parts.push(bytes);offset+=bytes.length;complete=chunk.complete;}
 const bytes=Buffer.concat(parts);assert.equal(sha(bytes),r.sha256);assert.deepEqual(bytes,h.png);assert.deepEqual([...PNG.sync.read(bytes).data.subarray((40*640+30)*4,(40*640+30)*4+4)],[17,83,151,255]);const eof=await h.base.run.readScreenshot(r.screenshotId,offset,h.context);assert.equal(eof.byteLength,0);assert.equal(eof.complete,true);
});
test('fresh screenshot replaces one prior file while failed captures preserve the last successful file',async t=>{
 const h=screenshotFixture(t),first=await h.capture();await assert.rejects(h.capture({maxBytes:1}),error('AGENT_OBSERVATION_LIMIT'));assert.equal((await h.base.run.readScreenshot(first.screenshotId,0,h.context)).sha256,first.sha256);const next=await h.capture();assert.notEqual(first.screenshotId,next.screenshotId);assert.equal(next.revision,first.revision+1);await assert.rejects(h.base.run.readScreenshot(first.screenshotId,0,h.context),error('STALE_AGENT_SCREENSHOT'));assert.equal((await h.base.run.readScreenshot(next.screenshotId,0,h.context)).sha256,next.sha256);
});
test('explicit release invalidates only the owned screenshot and malformed or foreign handles cannot release it',async t=>{
 const h=screenshotFixture(t),r=await h.capture();await assert.rejects(h.base.run.releaseScreenshot('shot_'+crypto.randomUUID(),h.context),error('STALE_AGENT_SCREENSHOT'));const released=await h.base.run.releaseScreenshot(r.screenshotId,h.context);assert.equal(released.stage,'screenshot-released');await assert.rejects(h.base.run.readScreenshot(r.screenshotId,0,h.context),error('STALE_AGENT_SCREENSHOT'));await assert.rejects(h.base.run.releaseScreenshot(r.screenshotId,h.context),error('STALE_AGENT_SCREENSHOT'));await h.capture();
});
test('screenshots recheck permission document original Page capture and CDP before accepting late PNG bytes',async t=>{
 for(const mode of ['permission','epoch','page','capture','cdp']){const h=screenshotFixture(t),entered=gate(),release=gate();h.hook=async method=>{if(method==='Page.captureScreenshot'){entered.resolve();await release.promise;}};const pending=assert.rejects(h.capture());await entered.promise;if(mode==='permission')h.base.readAllowed=false;if(mode==='epoch')h.base.source.pageEpoch++;if(mode==='page')h.base.source.page={isClosed:()=>false};if(mode==='capture')h.base.source.capture={...h.base.source.capture};if(mode==='cdp')h.base.source.capture.cdp={send:async()=>({})};release.resolve();await pending;}
});
test('one actual screenshot blocks DOM AX chunks and new capture until real browser work settles',async t=>{
 const h=screenshotFixture(t),old=await h.capture(),entered=gate(),release=gate();h.hook=async method=>{if(method==='Page.captureScreenshot'){entered.resolve();await release.promise;}};const pending=h.capture();await entered.promise;for(const call of [h.capture(),h.base.run.observe({kind:'snapshot'},h.context),h.base.run.observeAccessibility('elh_'+crypto.randomUUID(),h.context),h.base.run.readScreenshot(old.screenshotId,0,h.context),h.base.run.releaseScreenshot(old.screenshotId,h.context)])await assert.rejects(call,error('AGENT_OBSERVATION_BUSY'));release.resolve();await pending;
});
test('end awaits actual screenshot work rejects its late result and releases its realm',async t=>{
 const h=screenshotFixture(t),entered=gate(),release=gate();h.hook=async method=>{if(method==='Page.captureScreenshot'){entered.resolve();await release.promise;}};const pending=assert.rejects(h.capture(),error('AGENT_RUN_CLOSED'));await entered.promise;let ended=false;const closing=h.base.run.close().then(()=>ended=true);await new Promise(setImmediate);assert.equal(ended,false);release.resolve();await pending;await closing;assert.equal(ended,true);assert.equal(h.base.calls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,1);
});
test('pending Native metadata for chunk reads retains real admission and end waits for it',async t=>{
 const h=screenshotFixture(t),r=await h.capture(),entered=gate(),release=gate();h.hook=async(method,p)=>{if(method==='Runtime.callFunctionOn'&&p.functionDeclaration.includes('screenshotMetadata')){entered.resolve();await release.promise;}};const pending=assert.rejects(h.base.run.readScreenshot(r.screenshotId,0,h.context),error('AGENT_RUN_CLOSED'));await entered.promise;let ended=false;const closing=h.base.run.close().then(()=>ended=true);await new Promise(setImmediate);assert.equal(ended,false);release.resolve();await pending;await closing;
});
test('screenshot read authorization is independent and checked before caller getters without changing writer fence',async t=>{
 const h=screenshotFixture(t),before=h.base.run.context();h.base.readAllowed=false;let reads=0;await assert.rejects(h.capture(Object.defineProperty({},'maxBytes',{get(){reads++;}})),error('AGENT_NOT_AUTHORIZED'));assert.equal(reads,0);h.base.readAllowed=true;h.base.writeAllowed=false;await h.capture();h.base.writeAllowed=true;assert.deepEqual(h.base.run.context(),before);
});
test('human-held keys and lease survive screenshot capture chunk release and Agent end',async t=>{
 const h=screenshotFixture(t),grant=await h.base.control.acquire('human',{sessionId:h.base.control.sessionId,pageEpoch:1,viewportVersion:1}),r=await h.capture();await h.base.run.readScreenshot(r.screenshotId,0,h.context);await h.base.run.releaseScreenshot(r.screenshotId,h.context);await h.base.run.close();assert.equal(h.base.control.mode,'human');assert.equal(h.base.control.lease,grant.lease);
});
test('PNG acceptance bounds encoded bytes before Buffer decoding and validates chunk CRC dimensions and ending',()=>{
 const good=screenshotPng(),encoded={data:good.toString('base64')},options={width:640,height:480,maxBytes:4194304};assert.deepEqual(decodeAgentScreenshot(encoded,options),good);const corrupt=Buffer.from(good);corrupt[corrupt.length-1]^=1;for(const reply of [{data:corrupt.toString('base64')},{data:good.subarray(0,good.length-12).toString('base64')},{data:Buffer.concat([good,Buffer.from([0])]).toString('base64')},{data:'!!!!'},{data:good.toString('base64'),private:'x'}])assert.throws(()=>decodeAgentScreenshot(reply,options));assert.throws(()=>decodeAgentScreenshot(encoded,{...options,width:639}));assert.throws(()=>decodeAgentScreenshot(encoded,{...options,maxBytes:1}),error('AGENT_OBSERVATION_LIMIT'));assert.throws(()=>decodeAgentScreenshot({data:'A'.repeat(5600000)},options),error('AGENT_OBSERVATION_LIMIT'));
});
test('malformed PNG and screenshot metadata never replace an already retained successful screenshot',async t=>{
 const h=screenshotFixture(t),r=await h.capture(),good=h.png;h.png=Buffer.from('private invalid PNG');await assert.rejects(h.capture());h.png=good;h.hook=(method,p)=>method==='Runtime.callFunctionOn'&&p.functionDeclaration.includes('screenshotMetadata')?{result:{value:{ok:true,url:'x'.repeat(1025),title:'Fixture',truncated:false}}}:undefined;await assert.rejects(h.capture());h.hook=null;assert.equal((await h.base.run.readScreenshot(r.screenshotId,0,h.context)).sha256,r.sha256);
});
test('out of bounds viewport is rejected before pixel capture and resized old contexts cannot read saved bytes',async t=>{
 const h=screenshotFixture(t),r=await h.capture(),before=h.base.calls.length;h.base.source.viewport.cssWidth=2049;await assert.rejects(h.capture(),error('AGENT_OBSERVATION_LIMIT'));assert.equal(h.base.calls.length,before);h.base.source.viewportVersion++;await assert.rejects(h.base.run.readScreenshot(r.screenshotId,0,h.context),error('STALE_AGENT_PAGE'));
});
test('Native screenshot metadata leaves original DOM and AX handles intact while validating the original document',()=>{
 const h=setup(),dom=h.read({kind:'locate',by:'id',value:'submit'}),id=dom.nodes[0].elementId;assert.equal(h.realm.screenshotMetadata().url,h.doc.URL);assert.equal(h.realm.axElement(id),h.button);h.nativeToken='other';assert.equal(h.realm.screenshotMetadata().code,'STALE_AGENT_PAGE');
});
test('screenshot result validators enforce exact identity budget hash metadata and bounded chunk arithmetic',async t=>{
 const h=screenshotFixture(t),r=await h.capture(),expected={...h.context,screenshot:captureManagedAgentScreenshot()};for(const patch of [{document:{...r.document,pageEpoch:2}},{width:2049},{byteLength:1048577},{sha256:'x'},{stage:'observed'},{data:'private'},{limits:{maxBytes:1}},{observedAt:'2026-02-30T00:00:00.000Z'}])assert.throws(()=>captureAgentScreenshotResult({...r,...patch},expected));const chunk=await h.base.run.readScreenshot(r.screenshotId,0,h.context,128);for(const patch of [{offset:1},{byteLength:129},{totalBytes:1},{complete:true},{data:'A==='},{backendNodeId:2},{screenshotId:'shot_'+crypto.randomUUID()}])assert.throws(()=>captureAgentScreenshotChunk({...chunk,...patch},{...h.context,screenshotRead:captureManagedAgentScreenshotRead(r.screenshotId,0,128)}));
});
test('screenshot owner has one bounded record and close drops its file and forbids foreign documents',async t=>{
 const h=screenshotFixture(t),r=await h.capture(),owner=createAgentScreenshotOwner();owner.retain(h.png,r);assert.deepEqual(owner.status(),{files:1,bytes:h.png.length});assert.throws(()=>owner.read(captureManagedAgentScreenshotRead(r.screenshotId,0),{...h.context,document:{...h.context.document,pageEpoch:2}}),error('STALE_AGENT_SCREENSHOT'));owner.close();assert.deepEqual(owner.status(),{files:0,bytes:0});assert.throws(()=>owner.read(captureManagedAgentScreenshotRead(r.screenshotId,0),h.context),error('STALE_AGENT_SCREENSHOT'));
});

test('PNG chunk names retain high bits and cannot masquerade as ASCII IHDR with a valid CRC',()=>{const bytes=screenshotPng();bytes[12]|=128;bytes.writeUInt32BE(CRC.crc32(bytes.subarray(12,29))>>>0,29);assert.throws(()=>decodeAgentScreenshot({data:bytes.toString('base64')},{width:640,height:480,maxBytes:1048576}));});
