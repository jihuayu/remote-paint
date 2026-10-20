import {AgentClient,AgentClientError,type AgentRunId,type AgentEventCursor,type AgentEventMessage,type AgentEventPage,type AgentCancellation,type AgentCancellationCursor,type AgentEventGap} from '../../sdk/backend.mjs';
import type {AgentEvent,AgentCancellationInvocation} from '../../sdk/agent.mjs';
declare const run:AgentRunId;
declare const eventCursor:AgentEventCursor;
declare const cancellationCursor:AgentCancellationCursor;
const client=new AgentClient({baseUrl:'https://api.example.test',apiKey:'secret-from-backend-environment',maxConcurrentEventStreams:1,eventStreamTimeoutMs:60000,maxEventStreamBytes:262144});
const page:AgentEventPage=(await client.runs.eventPage(run,{after:eventCursor,retries:0})).data;
const events:readonly AgentEvent[]=page.events;
const cancelled:AgentCancellation=(await client.runs.cancel(run,{signal:new AbortController().signal})).data;
const cancellation:AgentCancellation=(await client.runs.cancellation(run,{after:cancellationCursor})).data;
const noRollback:false=cancelled.rollbackPerformed;
const noBusinessSuccess:false=cancellation.businessSuccessConfirmed;
const invocation:AgentCancellationInvocation|undefined=cancellation.invocations[0];
if(invocation?.state==='injected'){
 const effect:'input-injected'=invocation.effect;
 const stage:'input-injected'=invocation.receipt.stage;
 void effect;void stage;
}else if(invocation?.state==='unknown'){
 const effect:'unknown'=invocation.effect;
 const outcome:'unknown'=invocation.error.outcome;
 void effect;void outcome;
}
const iterator:AsyncIterableIterator<AgentEventMessage>=client.runs.events(run,{after:eventCursor,reconnects:3});
for await(const message of iterator){
 const cursor:AgentEventCursor=message.cursor;
 if(message.kind==='event'){
  if(message.event.type==='invocation.updated'||message.event.type==='invocation.snapshot'){
   if(message.event.data.state==='injected'){
    const stage:'input-injected'=message.event.data.receipt.stage;void stage;
   }
  }
 }else if(message.kind==='checkpoint'){
  const reason:'duration'|'events'|'bytes'=message.data.reason;void reason;
 }
 void cursor;
}
declare const error:AgentClientError;
const gap:AgentEventGap|undefined=error.details;
const cursor:AgentEventCursor|undefined=error.cursor;
void gap;void cursor;void noRollback;void noBusinessSuccess;void events;
// @ts-expect-error event cursors cannot select cancellation pages
client.runs.cancellation(run,{after:eventCursor});
// @ts-expect-error cancellation cursors cannot resume event streams
client.runs.events(run,{after:cancellationCursor});
// @ts-expect-error stream reconnect count is explicitly bounded
client.runs.events(run,{reconnects:4});
// @ts-expect-error finite request retries differ from stream reconnections
client.runs.events(run,{retries:1});
// @ts-expect-error cancel cannot transparently select a different report page
client.runs.cancel(run,{after:cancellationCursor});
// @ts-expect-error public events are immutable
page.events.push(page.events[0]!);
// @ts-expect-error actual work status is immutable
cancellation.work.ordinaryPending=false;
// @ts-expect-error immutable error details cannot skip a gap
gap!.after=eventCursor;
// @ts-expect-error stream status has a separate shape from ordinary transport status
client.transportStatus().streams;
// @ts-expect-error stream capacity metrics are readonly
client.eventTransportStatus().streams=0;
