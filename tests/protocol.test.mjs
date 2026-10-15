import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameGate, encodeResource, decodeResource, validateFrame, LIMITS } from '../protocol/wire.mjs';

const id = 'a'.repeat(64);
const skp = new TextEncoder().encode('skiapict' + ' '.repeat(40));
const frame = (overrides = {}) => ({ protocol: 1, pageEpoch: 1, frameId: 1, baseFrameId: null,
  viewportVersion: 1, viewport: { cssWidth: 960, cssHeight: 640, deviceScaleFactor: 1 },
  requiredResources: [id], scene: [{ resourceId: id, matrix: [1,0,0,0,1,0,0,0,1],
    clip: [0,0,960,640], opacity: 1 }], ...overrides });

test('resource header round trip preserves content; truncation, length and version are rejected', () => {
  const bytes = encodeResource(id, skp);
  assert.deepEqual(decodeResource(bytes), { id, payload: skp });
  assert.throws(() => decodeResource(bytes.slice(0, -1)), /length/);
  const oversized = bytes.slice(); new DataView(oversized.buffer).setUint32(8, LIMITS.resourceBytes + 1);
  assert.throws(() => decodeResource(oversized), /length/);
  const wrongVersion = bytes.slice(); wrongVersion[4] = 2;
  assert.throws(() => decodeResource(wrongVersion), /header/);
});

test('missing resource never replaces committed frame; a complete keyframe recovers', () => {
  const gate = new FrameGate(); gate.stage(frame());
  assert.equal(gate.commit(1, 1), null); assert.equal(gate.committed, null);
  gate.put(id, skp); assert.equal(gate.commit(1, 1).frameId, 1);
  gate.stage(frame({ frameId: 2, requiredResources: ['b'.repeat(64)],
    scene: [{ ...frame().scene[0], resourceId: 'b'.repeat(64) }] }));
  assert.equal(gate.commit(1, 2), null); assert.equal(gate.committed.frameId, 1);
  gate.stage(frame({ frameId: 3 })); assert.equal(gate.commit(1, 3).frameId, 3);
});

test('reject mismatched commits, stale epochs and dependent delta frames', () => {
  const gate = new FrameGate(); gate.put(id, skp); gate.stage(frame());
  assert.throws(() => gate.commit(2, 1), /matching/); gate.commit(1, 1);
  gate.stage(frame()); assert.throws(() => gate.commit(1, 1), /Stale/);
  gate.stage(frame({ pageEpoch: 2 })); gate.commit(2, 1);
  gate.stage(frame({ pageEpoch: 1, frameId: 100 })); assert.throws(() => gate.commit(1, 100), /Stale/);
  assert.throws(() => validateFrame(frame({ baseFrameId: 1 })), /keyframe/);
});

test('do not free resources still referenced by a displayed or pending frame', () => {
  const gate = new FrameGate(); gate.put(id, skp); gate.stage(frame());
  assert.equal(gate.release(id), false); gate.commit(1, 1);
  assert.equal(gate.release(id), false);
  const old = 'c'.repeat(64); gate.put(old, skp); const before = gate.bytes;
  assert.equal(gate.release(old), true); assert.equal(gate.bytes, before - skp.length);
});

test('refuse cache growth and unsupported composition before native decoding', () => {
  const gate = new FrameGate();
  for (let i = 0; i < LIMITS.resources; i++) gate.put(i.toString(16).repeat(64), skp);
  assert.throws(() => gate.put('f'.repeat(64), skp), /budget/);
  assert.throws(() => validateFrame(frame({ viewport: { cssWidth: 9000, cssHeight: 640, deviceScaleFactor: 1 } })), /viewport/);
  assert.throws(() => validateFrame(frame({ scene: [{ ...frame().scene[0], opacity: 0.5 }] })), /Composition/);
});
