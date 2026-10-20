// The single-device macOS harness keeps Viz/GPU in the browser process.
// Separate GPU startup currently stalls in dyld before main on this host;
// renderer capture and the bounded Unix scene IPC remain real and separate.
export function nativeLaunchArgs(token,{beginFrames=false,nativeDownloadBudget=false}={}){
 if(typeof nativeDownloadBudget!=='boolean')throw new TypeError('nativeDownloadBudget must be a trusted boolean');
 return [`--remote-paint-token=${token}`,'--disable-gpu-rasterization',
  ...(nativeDownloadBudget?['--remote-paint-download-budget-v1']:[]),
  ...(process.platform==='darwin'?['--in-process-gpu']:['--ozone-platform=headless','--disable-gpu']),
  ...(beginFrames?['--enable-begin-frame-control','--run-all-compositor-stages-before-draw']:[]),
  ...(process.env.REMOTE_PAINT_TRACE==='1'?['--enable-logging=stderr','--log-level=0']:[]),
  '--no-sandbox'];
}

export function nativeRuntimeInfo(frameDriver){
 return {platform:process.platform,architecture:process.arch,
  gpuMode:process.platform==='darwin'?'in-process':'software-compositing',
  beginFrame:frameDriver?{...frameDriver.stats}:null};
}
