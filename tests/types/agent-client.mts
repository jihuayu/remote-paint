import {AgentClient as RootAgentClient,AgentClientError,type AgentContext,type AgentInvocation,type AgentAction,type AgentRunId,type AgentInvocationId,type AgentObservationContext,type AgentObservation,type AgentAccessibilityObservation,type AgentAccessibilityStates,type AgentScreenshotObservation,type AgentScreenshotId,type AgentScreenshotChunk,type AgentScreenshotDownload,type AgentScreenshotReleased} from '../../sdk/backend.mjs';
import {AgentClient,type AgentAccessibilityInput} from '../../sdk/agent.mjs';
const same:typeof AgentClient=RootAgentClient;void same;
const client=new AgentClient({baseUrl:'https://api.example.test',apiKey:'backend-secret-from-environment',maxConcurrentRequests:2,maxConcurrentEndRequests:1,maxScreenshotBytes:4194304});
const created=await client.runs.prepareCreate('ses_example',{region:'test',version:'pinned-version',rpcTimeoutMs:5000},{idempotencyKey:'run-key'}).send();
const runId:AgentRunId=created.data.agentRunId;
const ctx:AgentContext=(await client.runs.context(created.data)).data;
const actions:AgentAction[]=[{tool:'move',params:{x:1,y:2}},{tool:'click',params:{x:1,y:2,button:'left'}},{tool:'drag',params:{fromX:1,fromY:2,toX:3,toY:4,steps:4}},{tool:'scroll',params:{x:1,y:2,deltaX:0,deltaY:80}},{tool:'press',params:{key:'a',code:'KeyA',modifiers:2}},{tool:'insertText',params:{text:'text'}},{tool:'composition',params:{text:'拼',selectionStart:0,selectionEnd:1}}];
const pending=client.invocations.prepareCreate(ctx,actions[0]!,{idempotencyKey:'action-key'});
const result=await pending.send({signal:new AbortController().signal,retries:1});
const invocationId:AgentInvocationId=result.data.invocationId;
await client.invocations.get(invocationId);await client.runs.get(runId);await client.runs.end(runId);
function outcome(row:AgentInvocation){if(row.state==='injected'){const stage:'input-injected'=row.receipt.stage;return stage;}if(row.state==='unknown'){const uncertain:'unknown'=row.error.outcome;const dispatched:true=row.dispatchStarted;void dispatched;return uncertain;}return row.state;}
const caught:unknown=new Error();if(caught instanceof AgentClientError){const code:string=caught.code;void code;}
// @ts-expect-error explicit key is required
client.runs.create('ses_example',{region:'test',version:'v1'});
// @ts-expect-error the Session binding is required when fetching context
client.runs.context({agentRunId:runId});
// @ts-expect-error logical Agent run and invocation identifiers are distinct
client.invocations.get(runId);
// @ts-expect-error logical Agent run and invocation identifiers are distinct
client.runs.end(invocationId);
// @ts-expect-error arbitrary CDP is outside the managed tool surface
client.invocations.create(ctx,{tool:'Runtime.evaluate',params:{expression:'private'}},{idempotencyKey:'key'});
// @ts-expect-error tool params are discriminated
client.invocations.create(ctx,{tool:'scroll',params:{text:'text'}},{idempotencyKey:'key'});
// @ts-expect-error Tenant is selected by backend authentication
client.runs.create('ses_example',{region:'test',version:'v1',tenantId:'foreign'},{idempotencyKey:'key'});
// @ts-expect-error returned fences are readonly
ctx.fence.controlVersion=2;
// @ts-expect-error prepared sends cannot replace captured body/key/context
pending.send({idempotencyKey:'changed'});
// @ts-expect-error injection receipts do not expose business completion
result.data.businessSuccess;
// @ts-expect-error a controller context must include the original fence
client.invocations.prepareCreate({agentRunId:runId,binding:ctx.binding},actions[0]!,{idempotencyKey:'key'});
void outcome;

// Observation APIs share the package root and agent exports.
const readContext:AgentObservationContext=(await client.observations.context(created.data)).data;
const snapshot:AgentObservation=(await client.observations.read(readContext,{query:{kind:'snapshot'},limits:{maxVisited:32,maxChars:0}})).data;
const scope:'main-document-light-dom'=snapshot.scope;void scope;
const selected=(await client.observations.read(readContext,{query:{kind:'locate',by:'testId',value:'status'}})).data;
if(selected.nodes[0])await client.observations.read(readContext,{query:{kind:'element',elementId:selected.nodes[0].elementId}});
// @ts-expect-error observation context requires current pinned version
client.observations.context({agentRunId:runId,sessionId:created.data.sessionId});
// @ts-expect-error read context has no writer fence
readContext.fence;
// @ts-expect-error a writer context cannot stand in for observation document context
client.observations.read(ctx,{query:{kind:'snapshot'}});
// @ts-expect-error reads have no idempotency key or retry loop
client.observations.read(readContext,{query:{kind:'snapshot'}},{idempotencyKey:'key'});
// @ts-expect-error reads always send once even when mutation retries are configured
client.observations.context(created.data,{retries:1});
// @ts-expect-error read input cannot execute JavaScript
client.observations.read(readContext,{query:{kind:'evaluate',expression:'private'}});
// @ts-expect-error CSS is outside the current structured locator surface
client.observations.read(readContext,{query:{kind:'locate',by:'css',value:'*'}});
// @ts-expect-error element identifiers are distinct from logical Run IDs
client.observations.read(readContext,{query:{kind:'element',elementId:runId}});
// @ts-expect-error observation output is deeply readonly
snapshot.document.pageEpoch=2;
// @ts-expect-error observation node arrays are readonly
snapshot.nodes.push(selected.nodes[0]!);
// @ts-expect-error node metadata is readonly
selected.nodes[0]!.text='changed';
// @ts-expect-error read authority cannot be used to inject
client.invocations.create(readContext,actions[0]!,{idempotencyKey:'key'});


const axInput:AgentAccessibilityInput={elementId:selected.nodes[0]!.elementId,limits:{maxChars:256},rpcTimeoutMs:5000};
const axResult:AgentAccessibilityObservation=(await client.observations.accessibility(readContext,axInput,{signal:new AbortController().signal})).data;
if(axResult.redacted){
 const noData:null=axResult.ax;void noData;
 // @ts-expect-error redacted results have no AX projection
 axResult.ax.name;
}else{
 const role:string=axResult.ax.role;
 const states:AgentAccessibilityStates=axResult.ax.states;
 const checked:boolean|'mixed'|undefined=states.checked;void role;void checked;
 // @ts-expect-error projection/state fields are readonly
 states.readonly=false;
}
// @ts-expect-error requires a read document context, not a writer fence
client.observations.accessibility(ctx,axInput);
// @ts-expect-error exact element ID type is required
client.observations.accessibility(readContext,{elementId:runId});
// @ts-expect-error arbitrary selectors are not accepted
client.observations.accessibility(readContext,{selector:'button'});
// @ts-expect-error AX limits differ from DOM traversal limits
client.observations.accessibility(readContext,{...axInput,limits:{maxNodes:1}});
// @ts-expect-error AX reads have no retries or idempotency
client.observations.accessibility(readContext,axInput,{retries:1});
// @ts-expect-error document versions are immutable
axResult.document.pageEpoch=2;
// @ts-expect-error AX observations do not expose business success
axResult.businessSuccess;

const screenshot:AgentScreenshotObservation=(await client.observations.screenshot(readContext,{limits:{maxBytes:1048576}})).data;
const screenshotId:AgentScreenshotId=screenshot.screenshotId;
const chunk:AgentScreenshotChunk=(await client.observations.screenshotChunk(readContext,{screenshotId,offset:0,maxBytes:3072})).data;
const file:AgentScreenshotDownload=(await client.observations.downloadScreenshot(readContext,{screenshotId,sha256:screenshot.sha256,byteLength:screenshot.byteLength,observedAt:screenshot.observedAt})).data;
const bytes:Uint8Array=file.bytes;bytes[0]=1;
const released:AgentScreenshotReleased=(await client.observations.releaseScreenshot(readContext,{screenshotId})).data;
void chunk;void released;
// @ts-expect-error screenshot IDs cannot be logical Run IDs
client.observations.screenshotChunk(readContext,{screenshotId:runId,offset:0});
// @ts-expect-error screenshot reads do not retry
client.observations.screenshot(readContext,{}, {retries:1});
// @ts-expect-error downloads require original hash length and time
client.observations.downloadScreenshot(readContext,{screenshotId});
// @ts-expect-error metadata remains readonly
file.sha256='changed';
// @ts-expect-error input fence context cannot replace observation context
client.observations.screenshot(ctx);
