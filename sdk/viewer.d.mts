import type {ViewerTicketConfig,ViewerRole} from './viewer-connection.mjs';
import type {ViewerChannelCode,ViewerChannelError} from './viewer-channel.mjs';
export {ViewerChannelError} from './viewer-channel.mjs';
export interface ViewerState {
 readonly state:'loading'|'ready'|'paused'|'connecting'|'connected'|'refreshing'|'reconnecting'|'failed'|'destroyed';
 readonly sessionId:`ses_${string}`;readonly role:ViewerRole;readonly version:string|null;readonly generation:number;readonly code?:ViewerChannelCode;
}
export interface ViewerConfig extends Omit<ViewerTicketConfig,'audience'|'role'> {
 readonly viewerOrigin:string;readonly role?:ViewerRole;readonly title?:string;
 readonly loadTimeoutMs?:number;readonly connectTimeoutMs?:number;readonly disconnectTimeoutMs?:number;readonly destroyTimeoutMs?:number;
 readonly onState?:(state:ViewerState)=>void;readonly onError?:(error:ViewerChannelError)=>void;
}
export interface Viewer {
 readonly element:HTMLElement;
 /** Metadata for the current iframe generation; does not request a ticket. */
 readonly ready:Promise<{readonly gatewayOrigin:string;readonly viewerBuild:string}>;
 readonly state:ViewerState;
 /** Resolves on authenticated network connection, independently of first paint. */
 connect(options?:{signal?:AbortSignal}):Promise<ViewerState>;
 disconnect():Promise<void>;destroy():Promise<void>;
 on(name:'state',listener:(state:ViewerState)=>void):()=>void;
 on(name:'error',listener:(error:ViewerChannelError)=>void):()=>void;
}
export function createViewer(container:HTMLElement,config:ViewerConfig):Viewer;
