// The single-device macOS harness keeps Viz/GPU in the browser process.
// Separate GPU startup currently stalls in dyld before main on this host;
// renderer capture and the bounded Unix scene IPC remain real and separate.
export function nativeLaunchArgs(token,{beginFrames=false}={}){
 return [`--remote-paint-token=${token}`,'--disable-gpu-rasterization',
  ...(process.platform==='darwin'?['--in-process-gpu']:['--ozone-platform=headless','--disable-gpu']),
  ...(beginFrames?['--enable-begin-frame-control','--run-all-compositor-stages-before-draw']:[]),
  '--no-sandbox'];
}
