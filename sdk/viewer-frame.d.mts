import type {ViewerTicketConfig,ViewerRole} from './viewer-connection.mjs';
import type {ViewerChannelCode,ViewerChannelError} from './viewer-channel.mjs';
import type {ViewerControlState,ViewerControlOptions,ViewerViewportSize,ViewerViewportResult} from './viewer-control.mjs';
import type {ViewerPerformanceSnapshot,ViewerFirstFrame} from './viewer-telemetry.mjs';
export type {ViewerPerformanceSnapshot,ViewerFirstFrame,ViewerSubmittedFrame,ViewerPresentation} from './viewer-telemetry.mjs';
export type {ViewerControlState,ViewerControlOptions,ViewerViewportSize,ViewerViewportResult} from './viewer-control.mjs';
export type {ViewerViewportOutcome} from './viewer-channel.mjs';
export {ViewerChannelError,ViewerViewportError} from './viewer-channel.mjs';
export interface ViewerFrameState {
 readonly state:'waiting'|'paused'|'connecting'|'connected'|'refreshing'|'reconnecting'|'failed'|'closed';
 readonly sessionId?:`ses_${string}`;readonly role?:ViewerRole;readonly attempt?:number;readonly version?:string|null;readonly code?:ViewerChannelCode;
}
export interface ViewerFrameConfig extends Omit<ViewerTicketConfig,'audience'> {
 readonly frameWindow:Pick<Window,'postMessage'>;readonly frameOrigin:string;readonly readyTimeoutMs?:number;readonly connectTimeoutMs?:number;
 readonly onState?:(state:ViewerFrameState)=>void;readonly onError?:(error:ViewerChannelError)=>void;readonly onControl?:(state:ViewerControlState)=>void;
 readonly onPerformance?:(snapshot:ViewerPerformanceSnapshot)=>void;readonly onFirstFrame?:(frame:ViewerFirstFrame)=>void;
}
export class ViewerFrameConnection {
 constructor(options:ViewerFrameConfig);
 readonly ready:Promise<{readonly gatewayOrigin:string;readonly viewerBuild:string}>;
 readonly state:ViewerFrameState;
 readonly control:ViewerControlState;
 readonly performance:ViewerPerformanceSnapshot;
 /** First current-generation scene submission received by the child UI; not physical presentation. */
 readonly firstFrame:ViewerFirstFrame|null;
 connect(options?:{signal?:AbortSignal}):Promise<ViewerFrameState>;
 disconnect():Promise<void>;getState():Promise<ViewerFrameState>;close():void;
 takeControl(options?:ViewerControlOptions):Promise<ViewerControlState>;releaseControl(options?:ViewerControlOptions):Promise<ViewerControlState>;
 /** Requires a held controller lease; confirms Source application, independently of Viewer pixels. */
 resizeViewport(size:ViewerViewportSize,options?:ViewerControlOptions):Promise<ViewerViewportResult>;
}
