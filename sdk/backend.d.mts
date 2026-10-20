export type SessionId = `ses_${string}`;
export type OperationId = `op_${string}`;
export type RequestId = `req_${string}`;
export type RequestOutcome = 'not-dispatched' | 'unknown' | 'rejected';
export type SessionState = 'creating' | 'ready' | 'closing' | 'closed' | 'expired' | 'failed' | 'cleanup-failed' | 'recovery-required';
export type CloseReason = 'released' | 'ttl-expired' | 'registry-shutdown' | 'registry-recovery' | 'registry-storage-fault' | 'worker-unavailable';
export interface ApiResult<T> { readonly data: T; readonly requestId: RequestId; }
export interface OperationError { readonly code: string; readonly message: string; }
interface OperationBase {
 readonly operationId: OperationId; readonly sessionId: SessionId;
 readonly createdAt: string; readonly updatedAt: string;
}
export type Operation<K extends 'create-session' | 'release-session' = 'create-session' | 'release-session'> = OperationBase & {readonly kind: K} & (
 {readonly status:'pending' | 'succeeded'; readonly error:null} | {readonly status:'failed'; readonly error:OperationError}
);
export interface Session {
 readonly sessionId:SessionId; readonly region:string; readonly state:SessionState;
 readonly createdAt:string; readonly version:string|null; readonly ttlSeconds:number;
 readonly readyAt:string|null; readonly expiresAt:string|null; readonly closeReason:CloseReason|null; readonly holdsQuota:boolean;
}
export interface CreateSessionInput { readonly url?:string; readonly region?:string; readonly ttlSeconds?:number; }
export interface RequestOptions { readonly signal?:AbortSignal; readonly retries?:0|1|2|3; }
export interface CreateRequestOptions extends RequestOptions { readonly idempotencyKey:string; }
export interface PreparedCreation { send(options?:RequestOptions):Promise<ApiResult<Operation<'create-session'>>>; }
export interface SessionClientConfig {
 readonly baseUrl:string; readonly apiKey:string; readonly fetch?:typeof globalThis.fetch;
 readonly timeoutMs?:number; readonly retries?:0|1|2|3; readonly maxResponseBytes?:number; readonly maxConcurrentRequests?:number;
}
export {AgentClient,AgentClientError} from './agent.mjs';
export type {AgentRunId,AgentInvocationId,AgentTool,AgentFence,AgentBinding,AgentContext,AgentRunReference,AgentFailure,AgentRun,AgentInvocation,AgentAction,CreateAgentRunInput,AgentCreateOptions,PreparedAgentRun,PreparedAgentInvocation,AgentClientConfig,AgentObservationReference,AgentObservationDocument,AgentObservationContext,AgentElementId,AgentObservationId,AgentObservationQuery,AgentObservationLimits,AgentObservationInput,AgentObservationOptions,AgentObservationNode,AgentObservation,AgentAccessibilityLimits,AgentAccessibilityInput,AgentAccessibilityStates,AgentAccessibilityProjection,AgentAccessibilityObservation,AgentScreenshotId,AgentScreenshotLimits,AgentScreenshotInput,AgentScreenshotFileInput,AgentScreenshotChunkInput,AgentScreenshotDownloadInput,AgentScreenshotObservation,AgentScreenshotChunk,AgentScreenshotReleased,AgentScreenshotDownload} from './agent.mjs';
export class SessionClientError extends Error {
 readonly code:string; readonly status:number|null; readonly requestId:RequestId|null;
 readonly outcome:RequestOutcome; readonly retryable:boolean;
 constructor(code:string,options?:{status?:number|null;requestId?:RequestId|null;outcome?:RequestOutcome;retryable?:boolean});
}
export class SessionClient {
 constructor(config:SessionClientConfig);
 readonly sessions: {
  readonly prepareCreate:(input:CreateSessionInput,options:{readonly idempotencyKey:string})=>PreparedCreation;
  readonly create:(input:CreateSessionInput,options:CreateRequestOptions)=>Promise<ApiResult<Operation<'create-session'>>>;
  readonly get:(sessionId:SessionId,options?:RequestOptions)=>Promise<ApiResult<Session>>;
  readonly release:(sessionId:SessionId,options?:RequestOptions)=>Promise<ApiResult<Operation<'release-session'>>>;
 };
 readonly operations:{readonly get:(operationId:OperationId,options?:RequestOptions)=>Promise<ApiResult<Operation>>};
}
