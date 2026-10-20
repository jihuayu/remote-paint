export type ViewerRole='readonly'|'controller';
export type ViewerConnectionCode='VIEWER_INVALID_CONFIG'|'VIEWER_INVALID_TICKET'|'VIEWER_CLOSED'|'VIEWER_ABORTED'|'VIEWER_ACCESS_ENDED'|'VIEWER_PROTOCOL_ERROR'|'VIEWER_STREAM_CLOSED'|'VIEWER_TICKET_BUSY'|'VIEWER_TICKET_TIMEOUT'|'VIEWER_TICKET_UNAVAILABLE'|'VIEWER_HANDSHAKE_TIMEOUT'|'VIEWER_TRANSPORT_UNAVAILABLE';
export class ViewerConnectionError extends Error {readonly code:ViewerConnectionCode;readonly retryable:boolean;constructor(code:ViewerConnectionCode);}
export interface ViewerGrant {
 readonly grantId:`vgr_${string}`;readonly sessionId:`ses_${string}`;readonly version:string;
 readonly role:ViewerRole;readonly audience:string;readonly expiresAt:string;
 readonly ticket:`vwt1.${string}`;readonly streamPath:string;
}
export interface ViewerTicketRequest {readonly signal:AbortSignal;readonly reason:'connect'|'reconnect'|'refresh';readonly previousGrantId:`vgr_${string}`|null;}
export interface ViewerTicketConfig {
 readonly gatewayOrigin:string;readonly audience:string;readonly sessionId:`ses_${string}`;readonly role:ViewerRole;readonly version?:string;
 readonly getTicket:(request:ViewerTicketRequest)=>ViewerGrant|PromiseLike<ViewerGrant>;readonly requestTimeoutMs?:number;
}
export interface ViewerTicketSettings {readonly gatewayOrigin:string;readonly audience:string;readonly sessionId:`ses_${string}`;readonly role:ViewerRole;readonly version?:string;readonly requestTimeoutMs:number;}
export class ViewerTicketSource {
 constructor(options:ViewerTicketConfig);readonly settings:ViewerTicketSettings;readonly busy:boolean;
 getTicket(options?:{signal?:AbortSignal;reason?:ViewerTicketRequest['reason']}):Promise<ViewerGrant>;
 destroy():void;
}
export interface ViewerConnectionState {
 readonly state:'paused'|'connecting'|'connected'|'refreshing'|'reconnecting'|'failed'|'closed';
 readonly sessionId:`ses_${string}`;readonly role:ViewerRole;readonly attempt:number;readonly version:string|null;readonly code?:ViewerConnectionCode;
}
export interface ViewerWelcome {
 readonly viewerSessionId:`ses_${string}`;readonly viewerVersion:string;readonly viewerGrantId:`vgr_${string}`;readonly viewerRole:ViewerRole;
 readonly input:boolean;readonly inputFeedback:boolean;readonly control:null;
}
export interface ViewerConnectionConfig extends ViewerTicketConfig {
 readonly WebSocket?:typeof globalThis.WebSocket;
 readonly onSocket:(socket:WebSocket,grant:ViewerGrant,control:{readonly acceptWelcome:(welcome:ViewerWelcome)=>void})=>void;
 readonly onState?:(state:ViewerConnectionState)=>void;readonly onError?:(error:ViewerConnectionError)=>void;
 readonly maxRetries?:0|1|2|3|4|5;readonly refreshBeforeMs?:number;readonly connectTimeoutMs?:number;
}
export class ViewerConnection {
 constructor(options:ViewerConnectionConfig);readonly state:ViewerConnectionState;
 start():Promise<void>;stop():void;destroy():void;
}
