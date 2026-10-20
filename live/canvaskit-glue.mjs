import {createHash} from 'node:crypto';

// This pinned upstream build omits Emscripten's wasmBinary incoming API.
// Adapt served bytes, never the dependency cache. The digest guard prevents
// applying minified-variable assumptions to a different build.
export const CANVASKIT_GLUE_SHA256='894815b2d39b24de2eacdb01453778d83e0b6c418b034e3b728e80956ac2a9d5';
export function adaptCanvasKitGlue(bytes){
 if(createHash('sha256').update(bytes).digest('hex')!==CANVASKIT_GLUE_SHA256)throw new Error('Unsupported CanvasKit glue build');
 const source=bytes.toString('utf8'),marker='async function ib(a){var b=fb;';
 if(source.indexOf(marker)<0||source.indexOf(marker)!==source.lastIndexOf(marker))throw new Error('CanvasKit binary handoff marker mismatch');
 // A provided buffer either instantiates or rejects; a bad buffer must never
 // be replaced by an unverified HTTP fallback.
 return Buffer.from(source.replace(marker,'async function ib(a){const verifiedBytes=u.wasmBinary;if(verifiedBytes!==void 0)return WebAssembly.instantiate(verifiedBytes,a);var b=fb;'));
}
