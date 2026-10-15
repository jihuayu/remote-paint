export const VERSION = 1;
export const LIMITS = Object.freeze({ resourceBytes: 16 * 1024 * 1024, totalBytes: 32 * 1024 * 1024,
  jsonBytes: 64 * 1024, resources: 8, dimension: 4096 });
const magic = [82, 80, 78, 84]; // RPNT
const HEADER = 44; // magic(4), version(1), kind(1), reserved(2), length(4), sha256(32)
export const isHash = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

export function encodeResource(id, payload) {
  if (!isHash(id) || payload.byteLength < 28 || payload.byteLength > LIMITS.resourceBytes)
    throw new Error('Invalid resource');
  const bytes = new Uint8Array(HEADER + payload.byteLength);
  bytes.set(magic); bytes[4] = VERSION; bytes[5] = 1;
  new DataView(bytes.buffer).setUint32(8, payload.byteLength);
  bytes.set(id.match(/../g).map(x => parseInt(x, 16)), 12); bytes.set(payload, HEADER);
  return bytes;
}

export function decodeResource(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < HEADER || !magic.every((b, i) => bytes[i] === b) || bytes[4] !== VERSION ||
      bytes[5] !== 1 || bytes[6] || bytes[7]) throw new Error('Invalid binary header');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8);
  if (length < 28 || length > LIMITS.resourceBytes || length + HEADER !== bytes.byteLength)
    throw new Error('Invalid binary length');
  const id = [...bytes.subarray(12, 44)].map(b => b.toString(16).padStart(2, '0')).join('');
  const payload = bytes.subarray(HEADER);
  if (new TextDecoder().decode(payload.subarray(0, 8)) !== 'skiapict') throw new Error('Expected SKP');
  return { id, payload };
}

export function validateFrame(frame) {
  if (frame?.protocol !== VERSION || !Number.isSafeInteger(frame.pageEpoch) || frame.pageEpoch < 1 ||
      !Number.isSafeInteger(frame.frameId) || frame.frameId < 1 || frame.baseFrameId !== null ||
      !Number.isSafeInteger(frame.viewportVersion) || frame.viewportVersion < 1)
    throw new Error('Expected complete phase A keyframe');
  const v = frame.viewport;
  if (!v || ![v.cssWidth, v.cssHeight].every(n => Number.isInteger(n) && n > 0 && n <= LIMITS.dimension) || v.deviceScaleFactor !== 1)
    throw new Error('Invalid viewport');
  if (!Array.isArray(frame.requiredResources) || frame.requiredResources.length !== 1 || !frame.requiredResources.every(isHash) ||
      !Array.isArray(frame.scene) || frame.scene.length !== 1) throw new Error('Expected one-layer scene');
  const layer = frame.scene[0];
  if (layer.resourceId !== frame.requiredResources[0] || layer.opacity !== 1 ||
      JSON.stringify(layer.matrix) !== '[1,0,0,0,1,0,0,0,1]' ||
      JSON.stringify(layer.clip) !== JSON.stringify([0, 0, v.cssWidth, v.cssHeight]))
    throw new Error('Composition unsupported by phase A');
  return frame;
}

// Shared state machine: no visible mutation until FrameCommit + all resources.
export class FrameGate {
  constructor() { this.resources = new Map(); this.bytes = 0; this.pending = null; this.committed = null; }
  put(id, payload) {
    if (!isHash(id)) throw new Error('Invalid resource id');
    if (this.resources.has(id)) return;
    if (this.resources.size >= LIMITS.resources || payload.byteLength > LIMITS.resourceBytes ||
        this.bytes + payload.byteLength > LIMITS.totalBytes) throw new Error('Resource budget exceeded');
    this.resources.set(id, payload); this.bytes += payload.byteLength;
  }
  stage(frame) { this.pending = validateFrame(frame); }
  commit(epoch, id) {
    const frame = this.pending;
    if (!frame || frame.pageEpoch !== epoch || frame.frameId !== id) throw new Error('Commit without matching scene');
    if (this.committed && frame.pageEpoch <= this.committed.pageEpoch &&
        (frame.pageEpoch < this.committed.pageEpoch || frame.frameId <= this.committed.frameId))
      throw new Error('Stale frame');
    if (frame.requiredResources.some(id => !this.resources.has(id))) return null;
    this.committed = frame; this.pending = null; return frame;
  }
  release(id) {
    if (this.committed?.requiredResources.includes(id) || this.pending?.requiredResources.includes(id)) return false;
    const data = this.resources.get(id);
    if (data) { this.bytes -= data.byteLength; this.resources.delete(id); }
    return true;
  }
}
