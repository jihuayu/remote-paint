# Remote Paint Session client — experimental

Python 3.11+ asyncio backend client with immutable typed models and `py.typed`. This `0.0.0.dev0` package is an unpublished development artifact. It contains the management client, with HTTPX 0.28.1 as a dependency. A configured Session control service is required. The package also provides the managed Agent API described below. Complete Native lifecycle, long-task events and cross-version acceptance remain separate gates.

Install the local wheel with pip, then:

```python
import asyncio
import os
from remote_paint_session import SessionClient, CreateSessionInput

async def main():
    async with SessionClient(
        base_url="https://your-session-control.example",
        api_key=os.environ["REMOTE_PAINT_API_KEY"],
    ) as client:
        # Persist the request/key with your job before sending.
        creation = client.sessions.prepare_create(
            CreateSessionInput(ttl_seconds=900),
            idempotency_key="the-key-saved-with-this-job",
        )
        accepted = await creation.send()
        current = await client.sessions.get(accepted.data.session_id)
        print(accepted.data.status, current.data.state)

asyncio.run(main())
```

Creation returns a possibly pending operation. Query `operations.get(operation_id)` and the current Session before using it; historical creation success does not imply current availability. `sessions.release(session_id)` returns a separate release operation. Optional initial fields are `url`, `region`, `ttl_seconds`; None fields are omitted, and an omitted URL means exact `about:blank`. Tenant comes from backend authentication.

Prepared creation captures its body/key. Later sends and explicit transient retries keep them. Default automatic retries are zero; `retries=0|1|2|3` allows at most four attempts. Do not replace a job's key after a timeout, disconnect or unknown result. `SessionClientError` exposes `code`, `status`, `request_id`, `outcome`, `retryable`, with fixed error messages. Outcomes are `not-dispatched`, `rejected`, `unknown`; a refusal of a later request cannot rule out earlier side effects.

Each attempt has a default 10-second local observation deadline covering headers/body/cleanup, with at most 10ms cooperative cancellation grace. Actual non-cooperative work continues to hold admission after that deadline. Responses are limited to 64 KiB and validated against identity/schema/status. Models are frozen dataclasses with SessionId/OperationId NewTypes. Cancelling an executing request raises `SessionClientCancelledError`, a subclass of asyncio.CancelledError, and preserves Task cancellation semantics. Cancelling a Task before client code starts may use the native CancelledError. Neither cancellation withdraws an already accepted creation; release it separately.

Use `async with` or `await client.aclose()`. Closing is single-flight and cancels owned requests. It waits at most one second locally; `CLIENT_CLOSE_PENDING` means actual work/closure continues and remains counted. Await `aclose()` again after it settles. Cancellation of a close observer does not cancel the shared closing operation. A failed response close fences new requests. Default active request cap is 64, with at most 16 HTTPX connections. The client refuses redirects, sends no response cookie back, disables environment proxy settings, and accepts HTTPS origins plus local HTTP for localhost/127.0.0.1/::1. An injected AsyncBaseTransport is trusted backend configuration; non-cooperative send/read/close work stays counted until actual settlement. If shared across clients, its close must support that ownership pattern.

This package is not a Viewer/browser SDK and must not receive credentials from untrusted page content. Public publishing, complete Native lifecycle and cross-version compatibility remain separate acceptance gates.


## Managed Agent API (experimental)

```python
from remote_paint_session import AgentClient, CreateAgentRunInput

async with AgentClient(base_url="https://your-session-control.example", api_key=api_key) as agents:
    prepared = agents.runs.prepare_create(
        session.session_id,
        CreateAgentRunInput(session.region, session.version),
        idempotency_key="persisted-run-key",
    )
    run = (await prepared.send()).data
    # Poll runs.get(run.agent_run_id) until active; handle terminal states explicitly.
    run = (await agents.runs.get(run.agent_run_id)).data
    if run.state != "active":
        raise RuntimeError("Agent run is not active")
    context = (await agents.runs.context(run)).data
    action = agents.invocations.prepare_create(
        context, {"tool": "insertText", "params": {"text": "Hello"}},
        idempotency_key="persisted-action-key",
    )
    invocation = (await action.send()).data
    # Poll invocations.get(invocation.invocation_id) while intent/requested.
    await agents.runs.end(run.agent_run_id)
```

Authorize independent `agents:read`, `agents:write`, `agents:end` backend scopes. Session/Viewer scopes do not grant Agent access. `AgentRunId`/`AgentInvocationId` are separate NewTypes. Frozen Run, Invocation, Context, Binding, Fence, Failure and Receipt dataclasses use snake_case. The seven `AgentAction` TypedDict alternatives discriminate `move`, `click`, `drag`, `scroll`, `press`, `insertText`, `composition`; params use `from_x`, `delta_y`, `selection_start`, etc. Selection offsets and string limits use UTF-16 code units to match Source/JavaScript. Runtime validators reject arbitrary CDP/JavaScript, unknown keys, dict subclasses, booleans in numeric fields and out-of-range values before HTTP.

`runs.context(run)` accepts an AgentRun or `AgentRunReference(agent_run_id, session_id)`, validates the expected Session and adds a local logical run tag. Invocation serialization strips that tag. Prepared requests capture body/key/context/fence once, pin the returned operation ID/created_at across sends, and never refresh/rebase a fence. Persist the original inputs/keys before dispatch. Explicit retries use the original bytes; within one send's retry sequence a later definite rejection cannot erase an earlier uncertain dispatch. No retries run by default. A remote state `unknown` returns immutable data and never triggers replay. `injected` confirms only `receipt.stage == 'input-injected'` and primitive count; business completion requires separate observation.

`AgentClientError` extends SessionClientError. Executing task cancellation raises `AgentClientCancelledError`, preserving asyncio.CancelledError semantics and dispatch uncertainty. `rpc_timeout_ms` (50–120000) is a private-RPC observation limit; local `timeout_seconds` (.05–60) bounds HTTP waiting. Neither deadline undoes an admitted action. `transport_status()` returns frozen ordinary/ending actual counts. Agent end has separate admission (default 8, range 1–64) and its own HTTPX connection pool, so ordinary in-flight requests cannot consume its connections. The ordinary default cap is 64. `CLIENT_BUSY` rejects local capacity immediately. End still requires server authorization and confirmed Source cleanup.

This is the managed seven-tool API. General CDP/Playwright, business postconditions, resumable task recovery, full fault coverage and release/version guarantees remain outside its qualification.


## DOM observations

`agents:observe` is an independent backend scope. `client.observations.context(run)` requires an `AgentRun` or `AgentObservationReference(agent_run_id, session_id, version)`. The returned frozen read context has `binding` and `document`, without an input fence/control version. Observation credentials cannot create/end a Run, inject, release a Session, mint Viewer tickets or obtain the input fence.

```python
from remote_paint_session import AgentClient, AgentObservationInput, AgentLocateQuery, AgentObservationLimits

async with AgentClient(base_url=base_url, api_key=observation_key) as reader:
    context = (await reader.observations.context(run)).data
    observation = (await reader.observations.read(context, AgentObservationInput(
        AgentLocateQuery('id', 'status'),
        AgentObservationLimits(max_nodes=8, max_chars=1024, max_visited=128),
        rpc_timeout_ms=5000,
    ))).data
    for node in observation.nodes:
        print(node.text)
```

Queries are frozen `AgentSnapshotQuery()`, `AgentLocateQuery(by, value)` by `id`/`tag`/`testId`, and `AgentElementQuery(element_id)`. Nodes are an immutable tuple of frozen models. Input, reference and nested context/query/limits values are validated and copied before the method returns its coroutine. Each call sends exactly one HTTP attempt even if client mutation retries are configured. No read `retries` or idempotency argument is accepted. Cancel the caller task to stop waiting; noncooperative transport/body/close work remains counted until actual completion. `aclose()` keeps its existing bounded single-flight close and independent end pool semantics.

A successful response must match the captured logical Run/Session/version/Source binding/document/query/limits, be HTTP 200 without Location, and satisfy metadata, UTF-16 text, node/visit and Source/public UTF-8 bounds. `scope` is main-document light DOM; role/name are limited DOM attributes, not computed accessibility data. Password/hidden values are redacted. Snapshot revision/time are not a global DOM mutation counter. A fresh snapshot, GC, document or selected metadata changes can expire handles; no automatic selector rebind or context/fence refresh occurs.

Known-bound same-owner `recovery-required` input can be inspected. Observing its actual DOM does not upgrade unknown invocation history, clear writer quarantine or replay input. Source screenshots and PNG downloads are described below; actual page downloads, full locators/frame traversal and write-by-handle remain pending. Computed AX is described below. Qualification is limited by the matching repository evidence and installed Native tests.

Computed AX of an existing observed element uses the same explicit read context:

```python
from remote_paint_session import AgentAccessibilityInput, AgentAccessibilityLimits

result = (await client.observations.accessibility(
    context, AgentAccessibilityInput(element_id, AgentAccessibilityLimits(256))
)).data
if not result.redacted:
    print(result.ax.role, result.ax.name, result.ax.states.checked)
```

This reads browser computed semantics for the original main-document element.
Inputs are captured before the coroutine is returned. Models, nested states and
limits are frozen/slotted; `redacted` distinguishes `ax=None` from a projection.
Absent optional states use `None`, while the wire accepts only whitelisted boolean
or checked/pressed `mixed` values. Text budgets count UTF16 units (default 256,
maximum 512); Source/public records are separately bounded at 6144/8192 bytes.
Logical Run/Session/version, Source binding, document, element and limits must
match. Each AX read sends once, regardless of mutation retry settings, and never
refreshes a fence, rebinds a selector or replays an action. Cancellation/timeout
retains actual transport/body/close admission until settlement; end uses its own
capacity. Source raw CDP preallocation and browser AX physical memory remain
separate unfinished gates, as do whole-tree/frame, screenshot/download and
business postconditions.


Source viewport screenshots and their PNG downloads use the same original read context:

```python
from remote_paint_session import AgentScreenshotDownloadInput, AgentScreenshotFileInput

shot = (await client.observations.screenshot(context)).data
file = (await client.observations.download_screenshot(context, AgentScreenshotDownloadInput(
    shot.screenshot_id, shot.sha256, shot.byte_length, shot.observed_at
))).data
# file.content is immutable bytes; all metadata models are frozen/slotted.
await client.observations.release_screenshot(context, AgentScreenshotFileInput(shot.screenshot_id))
```

`screenshot_chunk` accepts an `AgentScreenshotChunkInput` with offset and up to3072
raw bytes per base64 chunk. All four methods capture copied typed inputs before
returning a coroutine and send once, with no retry/context refresh/recapture.
`max_screenshot_bytes` on AgentClient defaults to1MiB and accepts57..4MiB, separate
from the JSON response cap. File references above that cap fail before HTTP.
The binary response must match exact status/headers/context/file/length/time/hash,
PNG signature/IHDR and bounded dimensions; incomplete or corrupt data is rejected.
Assembly uses a bounded bytearray and a final immutable bytes copy (at most two
file-sized SDK allocations during conversion). Actual Task/body/aclose work stays
counted after timeout/cancellation, with independent end capacity and the existing
single-flight bounded aclose observation. Qualification still excludes actual page
download/upload/Profile, full locator/frame control, raw receiver preallocation,
browser physical memory and whole K6 completion.


### Actual Page downloads

`client.observations.arm_download(context, AgentDownloadArmInput(...))` returns a frozen
`AgentDownloadArmed` for the original Page's next download event. `download_info` takes
`AgentDownloadTicketInput` and returns `AgentDownloadPending | AgentDownloadReady`; only
ready has size/hash/completion/name metadata. `download_chunk` takes `AgentDownloadChunkInput`
and returns up to3072 raw bytes as canonical base64. `release_download` takes the original
ticket input; release the one Run-owned ticket before arming another window.

`download_file(context, AgentDownloadFileInput(download_id, sha256, byte_length, completed_at))`
returns a frozen/slotted `AgentDownloadFile` whose `content` is immutable `bytes`. All entrypoints
are normal methods that capture exact typed inputs and context before returning their coroutine.
They use one HTTP attempt regardless of mutation retries, with no automatic rearm/context refresh
or replay. `rpc_timeout_ms` is optional on each input and remains50..120000.

`max_download_bytes` defaults to1MiB and allows1..4MiB independently of JSON and screenshot
budgets. Zero-byte files remain valid. Headers must exactly match original full context, ticket,
size/hash/completion, binary media, UUID attachment, no-store/nosniff and request/digest metadata.
The reader uses one bounded bytearray, incremental SHA and periodic event-loop yielding, then
converts to immutable bytes only after full length/hash verification; conversion transiently holds
two file-sized allocations. No partial bytes or transport-buffer alias is returned. HTTPX mock
prebuffered responses still receive size/hash checks. This does not claim pre-spool/browser/raw
receiver or total physical memory bounds.

Timeout/Task cancellation only stops the waiter. Real Task/body/aclose work remains counted;
end owns its separate pool. Existing single-flight aclose waits up to1s and reports
CLIENT_CLOSE_PENDING while noncooperative work continues, rather than pretending it retired.


## Finite Run event pages and explicit cancellation

`await client.runs.event_page(run_id, after=event_cursor, retries=0)` reads at most four
public state events. `after` is optional and uses the distinct `AgentEventCursor` NewType.
`AgentEventPage.events` is an immutable tuple of `AgentRunEvent` or `AgentInvocationEvent`;
all nested models are frozen dataclasses. Sequence establishes causal order even if wall
time moves backward. Events contain public state, without input parameters or private
Source/fence identifiers. An input-injected receipt does not establish business success.

`AgentClientError.details` is either None or a validated frozen `AgentEventGap` for an
`AGENT_EVENT_GAP` response. The gap records missing retained history and exact Run cursors.
No implicit skip, history fabrication or cursor repair occurs. Explicit finite retries
preserve these details and an earlier unknown attempt outcome. Unknown error detail
shapes, wrong Run/cursor, extra fields and false gap assertions are rejected.

`await client.runs.cancel(run_id, retries=0)` requests the original idempotent end and
returns `AgentCancellation`. It shares the existing independent end admission and HTTPX
connection pool with `runs.end`. `await client.runs.cancellation(run_id, after=anchor)`
reads at most four original invocation effects per page. Anchors are a separate
`AgentCancellationCursor` NewType, bound to one Run event generation. On
`AGENT_CANCELLATION_CHANGED`, explicitly restart pagination; the client does not combine
reports from different generations. `complete_run` applies only to a first page with no
more pages. A closed Run still reports settling while original work remains pending.
Unknown, injected and not-dispatched effects stay separate. Rollback and business-success
flags remain false regardless of HTTP200 or closed state.

These methods validate and capture identifiers/cursors/retry counts before returning a
coroutine. Cancel the calling asyncio Task to stop waiting. Actual unfinished send/read/
close work remains counted under the existing transport rules, including after a local
deadline. The SSE iterator below uses an independent pool. Signed Webhooks and original
Native end-to-end event/cancel acceptance remain separate gates.


### SSE message models and parser checkpoint

Frozen `AgentEventReady`, `AgentEventHeartbeat`, `AgentEventCheckpoint` and the
`AgentEventMessage` union describe ready/event/heartbeat/checkpoint envelopes. Event
messages carry `event`; control messages carry their typed `data`, with the exact
request ID and original Run cursor. `AgentClientError.cursor` is optional metadata for
the last delivered cursor. Consumers must still persist an event cursor after processing.

The private incremental decoder now retains one raw chunk, one <=4096-byte frame and
one pending message, with at most8192 scanned bytes per pull. It captures the original
cursor/eventId and advances only after acknowledgement of that exact pending object.
Discarding an undelivered message preserves the prior cursor. Byte/event/identity budgets
span windows; malformed input and gaps remain terminal. Logical decoder-window completion
is not an HTTP close or Source retirement receipt. The HTTPX stream lifecycle below owns the actual send, read and close tasks for each window.


### Bounded SSE iterator

```python
async with client.runs.events(run_id, after=last_processed_cursor, reconnects=3) as stream:
    async for message in stream:
        if message.kind == "event":
            await process_event(message.event)
            last_processed_cursor = message.cursor
```

`runs.events` validates inputs immediately and sends nothing until the first iteration.
Use the async context manager (or explicitly `await stream.aclose()`) when breaking early.
Every new connection authenticates again and resumes from the last event actually delivered
by this iterator. Persist your own cursor after processing; delivery does not confirm business
success. Ready, heartbeat and checkpoint messages do not advance that cursor. A gap is terminal
and requires explicit application reconciliation. Reconnects are bounded to 0..3 (default3),
with a 50ms delay after actual prior cleanup. Exhausting windows ends this finite iterator;
applications choose whether to create another iterator with their persisted cursor.

`max_concurrent_event_streams` defaults to8 (1..64), independent of ordinary and end pools.
`event_stream_timeout_seconds` defaults to60 (0.1..120) and starts on first iteration; it covers
paused consumers, retries, headers and body. `max_event_stream_bytes` defaults to262144
(4096..1048576), counting raw SSE and JSON error bodies across all attempts. At most one raw
chunk, one4096-byte frame and one message are retained by the decoder; event delivery is
limited to64 per connection and256 per iterator. No background message queue is created.

`client.event_transport_status().streams` counts started readers until their original
send/read/close tasks and iterator cleanup actually settle. Timeout, Task cancellation or
HTTPX's `is_closed` flag cannot release that admission early. Cleanup failure retains the
uncertain slot. `aclose` can return `CLIENT_CLOSE_PENDING` while cleanup continues; call it
again to join the same cleanup. Global client close includes all stream cleanup and remains
single-flight. Concurrent `anext` calls are rejected. Reader close does not end the Run;
`runs.cancel` remains separately available. Errors (including cancellation) expose the last
delivered `cursor`, where known, without credentials or private transport text.
