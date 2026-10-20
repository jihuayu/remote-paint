export interface ViewerControlState {
 readonly mode:'unavailable'|'agent'|'handoff'|'human';readonly holder:'none'|'self'|'other';readonly held:boolean;
 readonly lease:string|null;readonly fencingToken:number|null;readonly expiresAt:number|null;
 readonly pageEpoch:number|null;readonly viewportVersion:number|null;
}
export interface ViewerControlOptions {readonly signal?:AbortSignal;readonly timeoutMs?:number;}
export function emptyViewerControl():ViewerControlState;
export function viewerControlState(value:unknown):ViewerControlState;
export function viewerControlOptions(value?:ViewerControlOptions):{signal:AbortSignal|undefined;timeoutMs:number};
