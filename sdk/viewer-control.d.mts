import {ViewerChannelError} from './viewer-channel.mjs';
import type {ViewerChannelCode} from './viewer-channel.mjs';
export interface ViewerControlState {
 readonly mode:'unavailable'|'agent'|'handoff'|'human';readonly holder:'none'|'self'|'other';readonly held:boolean;
 readonly lease:string|null;readonly fencingToken:number|null;readonly expiresAt:number|null;
 readonly pageEpoch:number|null;readonly viewportVersion:number|null;
}
export interface ViewerControlOptions {readonly signal?:AbortSignal;readonly timeoutMs?:number;}
export interface ViewerViewportSize {readonly width:number;readonly height:number;}
/** Confirms the Source viewport barrier, independently of new Viewer pixels. */
export interface ViewerViewportResult extends ViewerViewportSize {readonly scope:'viewport';readonly changed:boolean;readonly pageEpoch:number;readonly viewportVersion:number;}
export class ViewerViewportError extends ViewerChannelError {readonly outcome:'not-applied'|'unknown';constructor(code:ViewerChannelCode,outcome?:'not-applied'|'unknown');}
export function viewerViewportSize(value:unknown):ViewerViewportSize;
export function viewerViewportResult(value:unknown):ViewerViewportResult;
export function emptyViewerControl():ViewerControlState;
export function viewerControlState(value:unknown):ViewerControlState;
export function viewerControlOptions(value?:ViewerControlOptions):{signal:AbortSignal|undefined;timeoutMs:number};
