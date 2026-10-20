import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareFrameAgeAssets} from './frame-age-observer.mjs';
import {prepareViewerAssets} from '../live/viewer-assets.mjs';

test('frame-age observer copied inputs reproduce the current production build before any instrumentation',async()=>{
 const production=await prepareViewerAssets(),prepared=await prepareFrameAgeAssets([[1,1]],false,false);
 assert.equal(prepared.provenance.productionBuild,production.build);assert.notEqual(prepared.assets.build,production.build);assert.ok(prepared.provenance.served[0].instrumentationBytes>0);
 assert.ok(prepared.assets.get('/connection.mjs'));assert.ok(prepared.assets.get('/public-config.mjs'));
 assert.deepEqual(prepared.assets.get('/viewer-telemetry.mjs').bytes,production.get('/viewer-telemetry.mjs').bytes);
});

test('diagnostic and streaming frame-age variants retain explicit provenance on the same current base',async()=>{
 const production=await prepareViewerAssets();
 for(const [diagnostic,streaming]of [[true,false],[false,true]]){
  const prepared=await prepareFrameAgeAssets([[1,1]],diagnostic,streaming);assert.equal(prepared.provenance.productionBuild,production.build);assert.equal(prepared.provenance.diagnosticFaults,diagnostic);assert.equal(prepared.provenance.streaming,streaming);assert.notEqual(prepared.provenance.productionBuild,prepared.provenance.observerBuild);
 }
});
