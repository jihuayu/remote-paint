export type ViewerPresentation='cpu-2d'|'cpu-bitmap'|'webgl2-bitmap';
export interface ViewerSubmittedFrame {
 readonly scope:'viewer';readonly stage:'scene-submitted';readonly clock:'viewer-ui-receipt';
 readonly connectionGeneration:number;readonly frameId:number;readonly pageEpoch:number;readonly viewportVersion:number;
 readonly width:number;readonly height:number;readonly worker:boolean;readonly presentation:ViewerPresentation;
}
export interface ViewerFirstFrame extends ViewerSubmittedFrame {
 readonly startPhase:'renderer-init'|'connection-attempt';
 /** UI receipt of the submitted-frame result; includes Worker message hop and is not physical presentation. */
 readonly connectToReceiptMs:number;
}
export type ViewerPerformanceSnapshot=Readonly<{
 scope:'viewer';stage:'unavailable'|'scene-submitted';clock:'viewer-ui-receipt';connectionGeneration:number;
 frameId:number|null;pageEpoch:number|null;viewportVersion:number|null;width:number|null;height:number|null;
 worker:boolean|null;presentation:ViewerPresentation|null;framesSubmitted:number;
 submittedFramesPerSecond:number|null;lastFrameAgoMs:number|null;renderMs:number|null;
 receivedBytes:number|null;resourceBytes:number|null;resourceCount:number|null;
 wasmHeapBytes:number|null;gpuEstimateBytes:number|null;residentEstimateBytes:number|null;memoryScope:'client-estimate';
}>;
export function emptyViewerPerformance():ViewerPerformanceSnapshot;
export function viewerPerformanceSnapshot(value:unknown):ViewerPerformanceSnapshot;
export function viewerFirstFrame(value:unknown):ViewerFirstFrame;
