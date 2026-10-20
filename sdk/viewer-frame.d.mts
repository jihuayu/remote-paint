import type {ViewerTicketConfig,ViewerRole} from './viewer-connection.mjs';
import type {ViewerChannelCode,ViewerChannelError} from './viewer-channel.mjs';
import type {ViewerControlState,ViewerControlOptions} from './viewer-control.mjs';
export type {ViewerControlState,ViewerControlOptions} from './viewer-control.mjs';
export {ViewerChannelError} from './viewer-channel.mjs';
export interface ViewerFrameState {
 readonly state:'waiting'|'paused'|'connecting'|'connected'|'refreshing'|'reconnecting'|'failed'|'closed';
 readonly sessionId?:`ses_${string}`;readonly role?:ViewerRole;readonly attempt?:number;readonly version?:string|null;readonly code?:ViewerChannelCode;
}
export interface ViewerFrameConfig extends Omit<ViewerTicketConfig,'audience'> {
 readonly frameWindow:Pick<Window,'postMessage'>;readonly frameOrigin:string;readonly readyTimeoutMs?:number;readonly connectTimeoutMs?:number;
 readonly onState?:(state:ViewerFrameState)=>void;readonly onError?:(error:ViewerChannelError)=>void;readonly onControl?:(state:ViewerControlState)=>void;
}
export class ViewerFrameConnection {
 constructor(options:ViewerFrameConfig);
 readonly ready:Promise<{readonly gatewayOrigin:string;readonly viewerBuild:string}>;
 readonly state:ViewerFrameState;
 readonly control:ViewerControlState;
 connect(options?:{signal?:AbortSignal}):Promise<ViewerFrameState>;
 disconnect():Promise<void>;getState():Promise<ViewerFrameState>;close():void;
 takeControl(options?:ViewerControlOptions):Promise<ViewerControlState>;releaseControl(options?:ViewerControlOptions):Promise<ViewerControlState>;
}
