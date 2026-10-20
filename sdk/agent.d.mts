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
export interface AgentCreateOptions extends RequestOptions {readonly idempotencyKey:string;}
export interface PreparedAgentRun {send(options?:RequestOptions):Promise<ApiResult<AgentRun>>;}
export interface PreparedAgentInvocation {send(options?:RequestOptions):Promise<ApiResult<AgentInvocation>>;}
export interface AgentClientConfig extends SessionClientConfig {readonly maxConcurrentEndRequests?:number;}
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
