import type {ViewerTicketConfig,ViewerRole} from './viewer-connection.mjs';
import type {ViewerChannelCode,ViewerChannelError} from './viewer-channel.mjs';
import type {ViewerControlState,ViewerControlOptions,ViewerViewportSize,ViewerViewportResult} from './viewer-control.mjs';
export type {ViewerControlState,ViewerControlOptions,ViewerViewportSize,ViewerViewportResult} from './viewer-control.mjs';
export type {ViewerViewportOutcome} from './viewer-channel.mjs';
export {ViewerChannelError,ViewerViewportError} from './viewer-channel.mjs';
export type ViewerDisplaySize=Readonly<{scope:'display';mode:'container';width:null;height:null}|{scope:'display';mode:'fixed';width:number;height:number}>;
export interface ViewerState {
 readonly state:'loading'|'ready'|'paused'|'connecting'|'connected'|'refreshing'|'reconnecting'|'failed'|'destroyed';
 readonly sessionId:`ses_${string}`;readonly role:ViewerRole;readonly version:string|null;readonly generation:number;readonly code?:ViewerChannelCode;
}
export interface ViewerConfig extends Omit<ViewerTicketConfig,'audience'|'role'> {
 readonly viewerOrigin:string;readonly role?:ViewerRole;readonly title?:string;
 readonly loadTimeoutMs?:number;readonly connectTimeoutMs?:number;readonly disconnectTimeoutMs?:number;readonly destroyTimeoutMs?:number;
 readonly onState?:(state:ViewerState)=>void;readonly onError?:(error:ViewerChannelError)=>void;readonly onControl?:(state:ViewerControlState)=>void;readonly onResize?:(size:ViewerDisplaySize)=>void;
}
export interface Viewer {
 readonly element:HTMLElement;
 /** Metadata for the current iframe generation; does not request a ticket. */
 readonly ready:Promise<{readonly gatewayOrigin:string;readonly viewerBuild:string}>;
 readonly state:ViewerState;
 readonly control:ViewerControlState;
 readonly displaySize:ViewerDisplaySize;
 /** Sets requested host CSS size; omitted input restores 100% container sizing. */
 resize(size?:{width:number;height:number}):ViewerDisplaySize;
 /** Requires a held controller lease; changes Source CSS viewport (integer 1–4096), not host CSS. */
 resizeViewport(size:ViewerViewportSize,options?:ViewerControlOptions):Promise<ViewerViewportResult>;
 /** Resolves on authenticated network connection, independently of first paint. */
 connect(options?:{signal?:AbortSignal}):Promise<ViewerState>;
 disconnect():Promise<void>;destroy():Promise<void>;
 setRole(role:ViewerRole,options?:{signal?:AbortSignal}):Promise<ViewerState>;
 setReadonly(value:boolean,options?:{signal?:AbortSignal}):Promise<ViewerState>;
 on(name:'state',listener:(state:ViewerState)=>void):()=>void;
 on(name:'error',listener:(error:ViewerChannelError)=>void):()=>void;
 on(name:'control',listener:(state:ViewerControlState)=>void):()=>void;
 on(name:'resize',listener:(size:ViewerDisplaySize)=>void):()=>void;
 takeControl(options?:ViewerControlOptions):Promise<ViewerControlState>;releaseControl(options?:ViewerControlOptions):Promise<ViewerControlState>;
}
export function createViewer(container:HTMLElement,config:ViewerConfig):Viewer;
