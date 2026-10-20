import {AgentClient as RootAgentClient,AgentClientError,type AgentContext,type AgentInvocation,type AgentAction,type AgentRunId,type AgentInvocationId} from '../../sdk/backend.mjs';
import {AgentClient} from '../../sdk/agent.mjs';
const same:typeof AgentClient=RootAgentClient;void same;
const client=new AgentClient({baseUrl:'https://api.example.test',apiKey:'backend-secret-from-environment',maxConcurrentRequests:2,maxConcurrentEndRequests:1});
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
