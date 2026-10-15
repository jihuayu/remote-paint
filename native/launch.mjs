// The single-device macOS harness keeps Viz/GPU in the browser process.
// Separate GPU startup currently stalls in dyld before main on this host;
// renderer capture and the bounded Unix scene IPC remain real and separate.
export function nativeLaunchArgs(token){
 return [`--remote-paint-token=${token}`,'--disable-gpu-rasterization','--in-process-gpu','--no-sandbox'];
}
