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

Known-bound same-owner `recovery-required` input can be inspected. Observing its actual DOM does not upgrade unknown invocation history, clear writer quarantine or replay input. AX, screenshots/downloads, full locators/frame traversal and write-by-handle remain pending. Qualification is limited by the matching repository evidence and installed Native tests.
