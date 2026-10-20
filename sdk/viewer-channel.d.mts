export type ViewerChannelCode='CHANNEL_CLOSED'|'CHANNEL_PROTOCOL'|'CHANNEL_TIMEOUT'|'CHANNEL_ABORTED'|'CHANNEL_BUSY'|'CHANNEL_HANDLER_FAILED'|'VIEWER_INVALID_CONFIG'|'VIEWER_INVALID_TICKET'|'VIEWER_CLOSED'|'VIEWER_ABORTED'|'VIEWER_ACCESS_ENDED'|'VIEWER_PROTOCOL_ERROR'|'VIEWER_STREAM_CLOSED'|'VIEWER_TICKET_BUSY'|'VIEWER_TICKET_TIMEOUT'|'VIEWER_TICKET_UNAVAILABLE'|'VIEWER_HANDSHAKE_TIMEOUT'|'VIEWER_TRANSPORT_UNAVAILABLE'|'VIEWER_CONFIG_INVALID'|'VIEWER_CONFIG_TIMEOUT'|'VIEWER_CONFIG_ABORTED'|'VIEWER_CONTROL_UNAVAILABLE'|'VIEWER_CONTROL_BUSY'|'VIEWER_CONTROL_DENIED'|'VIEWER_CONTROL_STALE'|'VIEWER_VIEWPORT_UNSUPPORTED'|'VIEWER_VIEWPORT_DENIED'|'VIEWER_VIEWPORT_FAILED';
export class ViewerChannelError extends Error {readonly code:ViewerChannelCode;constructor(code:ViewerChannelCode);}
export type ViewerViewportOutcome='not-applied'|'unknown';
export class ViewerViewportError extends ViewerChannelError {readonly outcome:ViewerViewportOutcome;constructor(code:ViewerChannelCode,outcome?:ViewerViewportOutcome);}
export type ViewerPortMethod='connect'|'disconnect'|'state'|'ticket'|'take-control'|'release-control'|'resize-viewport';
export interface ViewerPortOptions {
 readonly port:MessagePort;readonly channel:string;
 readonly handle:(method:ViewerPortMethod,data:unknown,context:{signal:AbortSignal})=>unknown|PromiseLike<unknown>;
 readonly notify?:(name:'ready'|'state'|'control'|'performance'|'first-frame',data:unknown)=>void;readonly onClose?:(error:ViewerChannelError)=>void;
 readonly maxPending?:number;readonly requestTimeoutMs?:number;readonly heartbeatMs?:number;readonly idleTimeoutMs?:number;
}
export class ViewerPort {
 constructor(options:ViewerPortOptions);readonly closed:boolean;readonly pending:{readonly outgoing:number;readonly incoming:number};
 request(method:ViewerPortMethod,data?:unknown,options?:{signal?:AbortSignal;timeoutMs?:number}):Promise<unknown>;
 notify(name:'ready'|'state'|'control'|'performance'|'first-frame',data:unknown):void;close(code?:ViewerChannelCode):void;
}
export function channelCode(value:unknown):ViewerChannelCode;
export function viewerOrigin(value:string):string;
export function viewerNonce():string;
export function validNonce(value:unknown):value is string;
export function viewerHello(channel:string):string;
export function readViewerHello(value:unknown):string|null;
export function viewerPort(value:unknown):value is MessagePort;
