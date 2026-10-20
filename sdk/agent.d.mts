import {SessionClientError,type SessionClientConfig,type ApiResult,type SessionId,type RequestOptions} from './backend.mjs';
export type AgentRunId=`arun_${string}`;
export type AgentInvocationId=`ainv_${string}`;
export type AgentTool='move'|'click'|'drag'|'scroll'|'press'|'insertText'|'composition';
export interface AgentFence {readonly controlSessionId:string;readonly controlVersion:number;readonly pageEpoch:number;readonly viewportVersion:number;}
export interface AgentBinding {readonly tenantId:string;readonly sessionId:SessionId;readonly targetId:`target_${string}`;readonly runId:`run_${string}`;}
/** SDK binding adds the requested logical run ID; the wire context stays binding/fence only. */
export interface AgentContext {readonly agentRunId:AgentRunId;readonly binding:AgentBinding;readonly fence:AgentFence;}
export interface AgentRunReference {readonly agentRunId:AgentRunId;readonly sessionId:SessionId;}
export interface AgentFailure {readonly code:string;readonly outcome:'not-dispatched'|'unknown';}
export interface AgentRun extends AgentRunReference {
 readonly region:string;readonly version:string;readonly state:'intent'|'starting'|'active'|'closing'|'recovery-required'|'closed';readonly holdsWriter:boolean;
 readonly beginDispatch:'not-requested'|'requested'|'confirmed';readonly endDispatch:'not-requested'|'requested'|'confirmed';readonly createdAt:string;readonly updatedAt:string;readonly error:AgentFailure|null;
}
interface InvocationBase {readonly invocationId:AgentInvocationId;readonly agentRunId:AgentRunId;readonly sessionId:SessionId;readonly tool:AgentTool;readonly fence:AgentFence;readonly createdAt:string;readonly updatedAt:string;}
export type AgentInvocation=InvocationBase&(
 {readonly state:'intent';readonly dispatchStarted:false;readonly receipt:null;readonly error:null}|
 {readonly state:'requested';readonly dispatchStarted:true;readonly receipt:null;readonly error:null}|
 {readonly state:'injected';readonly dispatchStarted:true;readonly receipt:{readonly stage:'input-injected';readonly inputs:number};readonly error:null}|
 {readonly state:'rejected';readonly dispatchStarted:boolean;readonly receipt:null;readonly error:{readonly code:string;readonly outcome:'not-dispatched'}}|
 {readonly state:'unknown';readonly dispatchStarted:true;readonly receipt:null;readonly error:{readonly code:string;readonly outcome:'unknown'}}
);
type Modifiers={readonly modifiers?:number};
type Point={readonly x:number;readonly y:number}&Modifiers;
export type AgentAction=(
 {readonly tool:'move';readonly params:Point}|
 {readonly tool:'click';readonly params:Point&{readonly button?:'left'|'middle'|'right'}}|
 {readonly tool:'drag';readonly params:Modifiers&{readonly fromX:number;readonly fromY:number;readonly toX:number;readonly toY:number;readonly steps?:number;readonly button?:'left'|'middle'|'right'}}|
 {readonly tool:'scroll';readonly params:Point&{readonly deltaX:number;readonly deltaY:number}}|
 {readonly tool:'press';readonly params:Modifiers&{readonly key:string;readonly code:string;readonly text?:string;readonly windowsVirtualKeyCode?:number;readonly nativeVirtualKeyCode?:number}}|
 {readonly tool:'insertText';readonly params:{readonly text:string}}|
 {readonly tool:'composition';readonly params:{readonly text:string;readonly selectionStart:number;readonly selectionEnd:number}}
)&{readonly rpcTimeoutMs?:number};
export interface CreateAgentRunInput {readonly region:string;readonly version:string;readonly rpcTimeoutMs?:number;}
/** Read authority is distinct from the input fence; version is required. */
export interface AgentObservationReference extends AgentRunReference {readonly version:string;}
export interface AgentObservationDocument {readonly controlSessionId:string;readonly pageEpoch:number;readonly viewportVersion:number;}
export interface AgentObservationContext extends AgentObservationReference {readonly binding:AgentBinding;readonly document:AgentObservationDocument;}
export type AgentElementId=`elh_${string}`;
export type AgentObservationId=`obs_${string}`;
export type AgentObservationQuery={readonly kind:'snapshot'}|{readonly kind:'locate';readonly by:'id'|'tag'|'testId';readonly value:string}|{readonly kind:'element';readonly elementId:AgentElementId};
export interface AgentObservationLimits {readonly maxNodes?:number;readonly maxChars?:number;readonly maxVisited?:number;}
export interface AgentObservationInput {readonly query:AgentObservationQuery;readonly limits?:AgentObservationLimits;readonly rpcTimeoutMs?:number;}
/** Every observation is one HTTP attempt, independent of configured retries. */
export interface AgentObservationOptions {readonly signal?:AbortSignal;}
export interface AgentObservationNode {readonly elementId:AgentElementId;readonly tag:string;readonly id:string;readonly role:string;readonly name:string;readonly text:string;readonly value:string|null;readonly redacted:boolean;}
export interface AgentObservation extends AgentObservationContext {
 readonly stage:'observed';readonly observationId:AgentObservationId;readonly revision:number;readonly observedAt:string;readonly scope:'main-document-light-dom';
 readonly query:AgentObservationQuery;readonly limits:Required<AgentObservationLimits>;readonly url:string;readonly title:string;readonly nodes:readonly AgentObservationNode[];readonly visited:number;readonly truncated:boolean;
}
export interface AgentAccessibilityLimits {readonly maxChars?:number;}
export interface AgentAccessibilityInput {readonly elementId:AgentElementId;readonly limits?:AgentAccessibilityLimits;readonly rpcTimeoutMs?:number;}
export interface AgentAccessibilityStates {
 readonly disabled?:boolean;readonly focused?:boolean;readonly focusable?:boolean;readonly readonly?:boolean;readonly required?:boolean;readonly selected?:boolean;readonly multiline?:boolean;readonly multiselectable?:boolean;readonly expanded?:boolean;readonly modal?:boolean;readonly busy?:boolean;readonly checked?:boolean|'mixed';readonly pressed?:boolean|'mixed';
}
export interface AgentAccessibilityProjection {readonly ignored:boolean;readonly role:string;readonly name:string;readonly description:string;readonly value:string|null;readonly states:AgentAccessibilityStates;}
interface AgentAccessibilityBase extends AgentObservationContext {
 readonly stage:'accessibility-observed';readonly scope:'main-document-element-accessibility';readonly observationId:AgentObservationId;readonly revision:number;readonly observedAt:string;readonly elementId:AgentElementId;readonly limits:Required<AgentAccessibilityLimits>;readonly url:string;readonly title:string;readonly truncated:boolean;
}
export type AgentAccessibilityObservation=AgentAccessibilityBase&({readonly redacted:true;readonly ax:null}|{readonly redacted:false;readonly ax:AgentAccessibilityProjection});
export type AgentScreenshotId=`shot_${string}`;
export interface AgentScreenshotLimits {readonly maxBytes?:number;}
export interface AgentScreenshotInput {readonly limits?:AgentScreenshotLimits;readonly rpcTimeoutMs?:number;}
export interface AgentScreenshotFileInput {readonly screenshotId:AgentScreenshotId;readonly rpcTimeoutMs?:number;}
export interface AgentScreenshotChunkInput extends AgentScreenshotFileInput {readonly offset:number;readonly maxBytes?:number;}
export interface AgentScreenshotDownloadInput extends AgentScreenshotFileInput {readonly sha256:string;readonly byteLength:number;readonly observedAt:string;}
export interface AgentScreenshotObservation extends AgentObservationContext {
 readonly stage:'screenshot-observed';readonly scope:'main-frame-viewport-source-pixels';readonly observationId:AgentObservationId;readonly revision:number;readonly observedAt:string;
 readonly limits:Required<AgentScreenshotLimits>;readonly url:string;readonly title:string;readonly truncated:boolean;readonly screenshotId:AgentScreenshotId;readonly mimeType:'image/png';readonly width:number;readonly height:number;readonly byteLength:number;readonly sha256:string;
}
export interface AgentScreenshotChunk extends AgentObservationContext {readonly stage:'screenshot-chunk';readonly screenshotId:AgentScreenshotId;readonly sha256:string;readonly observedAt:string;readonly offset:number;readonly byteLength:number;readonly totalBytes:number;readonly data:string;readonly complete:boolean;}
export interface AgentScreenshotReleased extends AgentObservationContext {readonly stage:'screenshot-released';readonly screenshotId:AgentScreenshotId;}
/** Metadata is frozen. bytes is a new caller-owned mutable allocation, not a transport/Source alias. */
export interface AgentScreenshotDownload extends AgentObservationContext {readonly stage:'screenshot-downloaded';readonly screenshotId:AgentScreenshotId;readonly mimeType:'image/png';readonly byteLength:number;readonly sha256:string;readonly observedAt:string;readonly width:number;readonly height:number;readonly bytes:Uint8Array;}
export interface AgentCreateOptions extends RequestOptions {readonly idempotencyKey:string;}
export interface PreparedAgentRun {send(options?:RequestOptions):Promise<ApiResult<AgentRun>>;}
export interface PreparedAgentInvocation {send(options?:RequestOptions):Promise<ApiResult<AgentInvocation>>;}
export type AgentDownloadId=`dl_${string}`;
export interface AgentDownloadLimits {readonly maxBytes?:number;readonly timeoutMs?:number;}
export interface AgentDownloadArmInput {readonly limits?:AgentDownloadLimits;readonly rpcTimeoutMs?:number;}
export interface AgentDownloadTicketInput {readonly downloadId:AgentDownloadId;readonly rpcTimeoutMs?:number;}
export interface AgentDownloadChunkInput extends AgentDownloadTicketInput {readonly offset:number;readonly maxBytes?:number;}
export interface AgentDownloadFileInput extends AgentDownloadTicketInput {readonly sha256:string;readonly byteLength:number;readonly completedAt:string;}
export interface AgentDownloadTicket extends AgentObservationContext {readonly downloadId:AgentDownloadId;readonly scope:'next-owned-page-download';readonly armedAt:string;readonly limits:Required<AgentDownloadLimits>;}
export interface AgentDownloadArmed extends AgentDownloadTicket {readonly stage:'download-armed';}
export interface AgentDownloadPending extends AgentDownloadTicket {readonly stage:'download-pending';}
export interface AgentDownloadReady extends AgentDownloadTicket {readonly stage:'download-ready';readonly completedAt:string;readonly fileName:string;readonly mimeType:'application/octet-stream';readonly byteLength:number;readonly sha256:string;}
export type AgentDownloadInfo=AgentDownloadPending|AgentDownloadReady;
export interface AgentDownloadChunk extends AgentObservationContext {readonly stage:'download-chunk';readonly downloadId:AgentDownloadId;readonly sha256:string;readonly completedAt:string;readonly offset:number;readonly byteLength:number;readonly totalBytes:number;readonly data:string;readonly complete:boolean;}
export interface AgentDownloadReleased extends AgentObservationContext {readonly stage:'download-released';readonly downloadId:AgentDownloadId;}
/** Metadata is frozen; bytes are a new mutable caller-owned allocation. */
export interface AgentDownloadFile extends AgentObservationContext {readonly stage:'download-delivered';readonly downloadId:AgentDownloadId;readonly mimeType:'application/octet-stream';readonly byteLength:number;readonly sha256:string;readonly completedAt:string;readonly bytes:Uint8Array;}
export interface AgentClientConfig extends SessionClientConfig {readonly maxConcurrentEndRequests?:number;readonly maxScreenshotBytes?:number;readonly maxDownloadBytes?:number;}
export class AgentClientError extends SessionClientError {}
export class AgentClient {
 constructor(config:AgentClientConfig);
 readonly runs:{
  readonly prepareCreate:(sessionId:SessionId,input:CreateAgentRunInput,options:{readonly idempotencyKey:string})=>PreparedAgentRun;
  readonly create:(sessionId:SessionId,input:CreateAgentRunInput,options:AgentCreateOptions)=>Promise<ApiResult<AgentRun>>;
  readonly get:(agentRunId:AgentRunId,options?:RequestOptions)=>Promise<ApiResult<AgentRun>>;
  readonly context:(run:AgentRunReference,options?:RequestOptions)=>Promise<ApiResult<AgentContext>>;
  readonly end:(agentRunId:AgentRunId,options?:RequestOptions)=>Promise<ApiResult<AgentRun>>;
 };
 readonly observations:{
  readonly armDownload:(context:AgentObservationContext,input?:AgentDownloadArmInput,options?:AgentObservationOptions)=>Promise<ApiResult<AgentDownloadArmed>>;
  readonly downloadInfo:(context:AgentObservationContext,input:AgentDownloadTicketInput,options?:AgentObservationOptions)=>Promise<ApiResult<AgentDownloadInfo>>;
  readonly downloadChunk:(context:AgentObservationContext,input:AgentDownloadChunkInput,options?:AgentObservationOptions)=>Promise<ApiResult<AgentDownloadChunk>>;
  readonly releaseDownload:(context:AgentObservationContext,input:AgentDownloadTicketInput,options?:AgentObservationOptions)=>Promise<ApiResult<AgentDownloadReleased>>;
  readonly downloadFile:(context:AgentObservationContext,input:AgentDownloadFileInput,options?:AgentObservationOptions)=>Promise<ApiResult<AgentDownloadFile>>;
  readonly screenshot:(context:AgentObservationContext,input?:AgentScreenshotInput,options?:AgentObservationOptions)=>Promise<ApiResult<AgentScreenshotObservation>>;
  readonly screenshotChunk:(context:AgentObservationContext,input:AgentScreenshotChunkInput,options?:AgentObservationOptions)=>Promise<ApiResult<AgentScreenshotChunk>>;
  readonly releaseScreenshot:(context:AgentObservationContext,input:AgentScreenshotFileInput,options?:AgentObservationOptions)=>Promise<ApiResult<AgentScreenshotReleased>>;
  readonly downloadScreenshot:(context:AgentObservationContext,input:AgentScreenshotDownloadInput,options?:AgentObservationOptions)=>Promise<ApiResult<AgentScreenshotDownload>>;
  readonly accessibility:(context:AgentObservationContext,input:AgentAccessibilityInput,options?:AgentObservationOptions)=>Promise<ApiResult<AgentAccessibilityObservation>>;
  readonly context:(run:AgentObservationReference,options?:AgentObservationOptions)=>Promise<ApiResult<AgentObservationContext>>;
  readonly read:(context:AgentObservationContext,input:AgentObservationInput,options?:AgentObservationOptions)=>Promise<ApiResult<AgentObservation>>;
 };
 readonly invocations:{
  readonly prepareCreate:(context:AgentContext,action:AgentAction,options:{readonly idempotencyKey:string})=>PreparedAgentInvocation;
  readonly create:(context:AgentContext,action:AgentAction,options:AgentCreateOptions)=>Promise<ApiResult<AgentInvocation>>;
  readonly get:(invocationId:AgentInvocationId,options?:RequestOptions)=>Promise<ApiResult<AgentInvocation>>;
 };
 transportStatus():Readonly<{ordinary:number;ending:number}>;
}
