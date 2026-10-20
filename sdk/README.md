# Remote Paint Session client — experimental

Node.js 22+ ESM backend client, with TypeScript declarations. This private package is a local development artifact; it has not been published. It contains the backend management client and a separate browser-safe short-ticket connection module. A configured Session control service is required. The managed Agent client is available through the Node backend exports. Qualification is scoped by the repository evidence; General CDP access, rolling-version acceptance and production-wide Native qualification remain pending.

Install the local `.tgz` produced by `npm pack`, then import from `@remote-paint/session-client` or `@remote-paint/session-client/backend`. Both exports use the same implementation and declarations. CommonJS and direct access to internal files are unsupported.

```js
import { SessionClient } from '@remote-paint/session-client';

const apiKey = process.env.REMOTE_PAINT_API_KEY;
if (!apiKey) throw new Error('Configure the backend credential');
const client = new SessionClient({
  baseUrl: 'https://your-session-control.example',
  apiKey,
});

// Persist the job request/key before sending, and retain them for every retry.
const creation = client.sessions.prepareCreate(
  { ttlSeconds: 900 },
  { idempotencyKey: 'the-key-saved-with-this-job' },
);
const { data: operation } = await creation.send();
const { data: session } = await client.sessions.get(operation.sessionId);
console.log(operation.status, session.state);
```

Creation returns an operation, which may be pending. Query `client.operations.get(operation.operationId)` and the current Session before using it. Historical creation success does not imply current availability after expiry, release or restart reconciliation. `sessions.release(sessionId)` returns a separate release operation. Missing initial URL means exact `about:blank`; optional fields are `url`, `region`, `ttlSeconds`. Tenant identity comes from backend authentication.

When the owned worker becomes unavailable, the current Session reports `closeReason: 'worker-unavailable'`. Both backend SDKs accept that reason during closing and after retirement. `holdsQuota` remains true until retirement is confirmed; historical creation success does not authorize reconnecting to that Session.

`prepareCreate` captures the body/key before sending. `send({signal,retries})` cannot replace them. The convenience method is `sessions.create(input,{idempotencyKey,signal?,retries?})`. Default automatic retries are zero. Explicit `retries:0|1|2|3` retries transient failures using the original body/key. A timeout or cancellation after dispatch may leave creation accepted; do not generate a new key for the same job. AbortSignal stops client waiting, while resource release is a separate request.

`SessionClientError` exposes `code`, `status`, `requestId`, `outcome` and `retryable`. Outcomes are `not-dispatched`, `rejected` or `unknown`. The error message does not include raw HTTP/transport exceptions or credentials. Responses are bounded and checked for schema, identity, operation kind/status and request ID. Each attempt has a default 10-second deadline covering fetch/body streaming; default response cap is 64 KiB. Returned data is frozen and typed readonly.

Keep the management key on your Node backend. The client refuses browser execution and redirects. Use an HTTPS API origin; local HTTP is allowed only for localhost, 127.0.0.1 or ::1. No cookies/referrer are sent. Injected fetch is trusted backend configuration and must respect AbortSignal and redirect options. Viewer embedding uses the separate browser entries below; their individual contract and Native acceptance boundaries are documented in the repository.


## Managed Agent client (Node backend, experimental)

`AgentClient` and `AgentClientError` are exported from the package root, `/backend`, and `/agent`. A Session must be ready on its current worker. Authorize the independent `agents:write`, `agents:read` and `agents:end` scopes on your backend; Session/Viewer scopes do not grant Agent access. The API key determines Tenant identity.

```js
import { AgentClient } from '@remote-paint/session-client/agent';
const agents = new AgentClient({ baseUrl: 'https://your-session-control.example', apiKey });
const creation = agents.runs.prepareCreate(
  session.sessionId, { region: session.region, version: session.version },
  { idempotencyKey: 'the-persisted-run-key' },
);
let run = (await creation.send()).data;
// Poll runs.get(run.agentRunId) until active; handle closed/recovery-required explicitly.
run = (await agents.runs.get(run.agentRunId)).data;
if (run.state !== 'active') throw new Error('Agent run is not active');
const context = (await agents.runs.context(run)).data;
const input = agents.invocations.prepareCreate(
  context, { tool: 'insertText', params: { text: 'Hello' } },
  { idempotencyKey: 'the-persisted-action-key' },
);
const invocation = (await input.send()).data;
// Poll invocations.get(invocation.invocationId) while intent/requested.
await agents.runs.end(run.agentRunId);
```

The seven discriminated tools are `move`, `click`, `drag`, `scroll`, `press`, `insertText` and `composition`. Runtime schemas reject unknown properties, getters, arbitrary CDP/JavaScript and out-of-range inputs before fetch. Run creation requires explicit region and version. `runs.context({agentRunId,sessionId})` requires the caller's expected Session; the SDK validates it and adds a local logical run ID to the returned binding/fence. That local tag is stripped from the HTTP body. The original Source fence is captured with the action; the SDK never fetches a replacement fence or rebases a rejected action.

Both `prepareCreate` methods capture body, context and key once. Reusing `send()` pins the returned operation ID and creation time. Persist original job inputs/keys before dispatch and reuse them after lost replies. No retries run by default. An explicit `retries:0|1|2|3` uses the captured payload; an earlier unknown transport outcome cannot become a definite rejection merely because a later attempt is refused. A remote invocation in state `unknown` is returned as data and does not cause automatic replay. `injected` confirms only the bounded `input-injected` primitive receipt; it does not establish business completion. `rejected` is not-dispatched; `unknown` requires explicit reconciliation/end rather than generating a new action key.

`AgentClientError` extends `SessionClientError` and uses the same redacted code/status/requestId/outcome/retryable fields. The shared transport retains actual fetch/body/cancellation admission after the observer times out or aborts, including a non-cooperative injected fetch. `maxConcurrentRequests` defaults to 64 (1–256) for both backend clients. Agent `end` uses an independent pool, `maxConcurrentEndRequests` default 8 (1–64). `transportStatus()` reports actual unsettled ordinary/end attempts; capacity failures are immediate. End still depends on its independent server scope and Source completion. HTTP cancellation stops waiting and does not undo an admitted action.

Every response has exact schema, request correlation, phase/status, ID/Session and immutable receipt checks. Prepared mutations also require the exact relative Location and original tool/fence. `rpcTimeoutMs` is the server's private-RPC observer deadline (50–120000ms); backend `timeoutMs` bounds each local HTTP attempt (50–60000ms). Neither deadline proves that input was not delivered. Python 3.11+ also provides the managed Agent API with snake_case parameters and frozen models; see `sdk/python/README.md` in the repository for installation, cancellation and close semantics. Qualification is scoped by the corresponding SDK evidence.


### DOM observations (Node backend)

An independent `agents:observe` key may use `agents.observations.context(run)` and `agents.observations.read(context, input)`. The reference must include the logical `agentRunId`, `sessionId` and pinned `version` (an `AgentRun` has these fields). Observation keys cannot fetch the input fence, create or end a Run, inject, release a Session or mint a Viewer ticket. A separate write/end credential may manage the same Run.

```js
const reader = new AgentClient({baseUrl, apiKey: observationKey});
const readContext = (await reader.observations.context(run)).data;
const result = (await reader.observations.read(readContext, {
  query: {kind: 'locate', by: 'id', value: 'status'},
  limits: {maxVisited: 128, maxNodes: 8, maxChars: 1024},
  rpcTimeoutMs: 5000,
}, {signal})).data;
// result.nodes contain bounded DOM attributes/direct text; result.truncated is explicit.
```

Queries are `snapshot`, `locate` by `id`/`tag`/`testId`, or `element` with an opaque handle from a prior observation. Scope is main-document light DOM: role/name are limited attributes, not computed accessibility data. Password/hidden values are redacted. Contexts include document generation, viewport, version and Source binding but no writer fence/controlVersion. Returned data is deeply frozen. Every successful response must match the original logical IDs, version, binding, document, query and limits; status is 200 with no Location. UTF-16 text, node/visit and UTF-8 Source/public byte bounds are checked independently.

Each call captures its input before awaiting and makes exactly one HTTP attempt, even if the client config enables mutation retries. Observation options accept only `signal`; no idempotency key or `retries`. Cancellation/deadline ends the local wait while actual fetch/body/cancellation work retains bounded ordinary admission until settled. Independently scoped end has its own transport pool. This does not cancel or undo an admitted Source operation.

Read context is fetched only when the caller asks. Stale document/element errors do not fetch a new fence, rebind a selector or replay input. A known, confirmed same-owner input Run in `recovery-required` can be inspected, but observing actual DOM never upgrades an unknown invocation or clears writer quarantine. Each fresh snapshot replaces the bounded handle registry; GC and selected metadata/document changes can also expire handles. Observations carry a snapshot revision and time, not a global DOM mutation counter. Computed AX is available for exact main-document elements through the method below. The Node screenshot and PNG download methods are described below; actual page downloads, cross-frame/full locators and write-by-handle remain pending; The Python backend also provides frozen observation models and single-attempt reads; see the repository `sdk/python/README.md` and its independent qualification evidence.

### Computed accessibility for an existing element

`reader.observations.accessibility(readContext, {elementId, limits?, rpcTimeoutMs?}, {signal?})` uses the same independent `agents:observe` scope. Supply an opaque handle returned by a DOM observation for this original Run/document. No selector, CDP/object/backend-node ID or write fence is accepted.

```js
const selected = (await reader.observations.read(readContext, {
  query: {kind: 'locate', by: 'id', value: 'shipping-address'},
})).data;
if (selected.nodes[0]) {
  const observation = (await reader.observations.accessibility(readContext, {
    elementId: selected.nodes[0].elementId,
    limits: {maxChars: 256},
  })).data;
  if (!observation.redacted) console.log(observation.ax.role, observation.ax.name);
}
```

The frozen result has stage `accessibility-observed` and scope `main-document-element-accessibility`, the original logical IDs/version/binding/document/element, time/revision, normalized limits, truncation and a discriminated `redacted`/`ax` pair. Password/hidden elements return `redacted: true, ax: null`; other results provide computed role/name/description/value and the supported boolean/tristate states. `value` is a string or null; numeric/bool browser values have already been normalized by Source. `maxChars` defaults to 256, max 512 UTF-16 units shared by name/description/value. Role is separately limited to 64. Source and public record byte limits remain 6144/8192.

The SDK captures inputs before awaiting and rejects wrong IDs, version, worker/target/document, element, budget, status/Location, metadata, redaction and extra projection/state fields. It sends one HTTP attempt regardless of configured mutation retries and accepts only the read `signal` option. Stale AX handles and documents do not trigger context refresh, selector rebind or input replay. Observing a known unknown action never upgrades history or clears writer quarantine. Actual unsettled HTTP/body/cancellation work retains local capacity; the server separately retains actual Source work after an HTTP wait ends, with independent end admission.

This is computed accessibility for the exact original main-document element, not a full AX tree/frame API or a physical browser-memory qualification. Source's raw CDP reply budget is checked after decoding. Python computed AX models/methods follow in a separate checkpoint; its existing DOM/input SDK remains available. Qualification is limited by the corresponding repository evidence and installed Native flow.

## Browser connection module (experimental)

Import `ViewerTicketSource`, `ViewerConnection` and `ViewerConnectionError` from `@remote-paint/session-client/viewer-connection`. This entry imports no backend code or management credentials. Configure a fixed gateway Origin, Viewer Origin, Session ID and role, and provide `getTicket({signal, reason, role, previousGrantId, previousRole})`. Your application backend mints or refreshes the grant; the browser callback receives only that short grant. An API key option is rejected.

`ViewerTicketSource` validates the exact destination/Session/role/audience/expiry and pins the version. A timed-out non-cooperative callback continues to hold its one admission. `ViewerConnection` adds socket lifetime, pre-expiry refresh, bounded consecutive retries, stop/destroy and Welcome binding checks. Its `onSocket` hook uses the existing display protocol; it is not a complete embedded renderer. State/error callbacks contain no ticket URLs.

The existing Viewer main and Worker paths now share this implementation through `/connection.mjs`. `window.remotePaintViewer.connect(...)` uses the current frame Origin as the audience and accepts the same fixed gateway/Session/role and application ticket callback. `disconnect()` releases the current renderer/Worker/sockets and fences automatic resume. The dedicated public asset server now configures CSP and a parent Origin allowlist. The iframe host/child bridge and createViewer DOM component are implemented within their Node contract scope; actual browser CSP/resource acceptance remains pending; rendered/Native qualification remains pending. See the repository document `docs/session-viewer-runtime.md`.


## Existing iframe connection (experimental)

`@remote-paint/session-client/viewer-frame` exports `ViewerFrameConnection` and `ViewerChannelError`. Give it an already loaded trusted frame Window, exact frame/gateway Origins, fixed Session/role and an application ticket callback. The public child entry validates its parent Window and configured Origin allowlist before accepting one transferred port. `ready` binds metadata; `connect()` waits for actual network connected state, `disconnect()` preserves callback/version history, and `close()` ends the channel. The /viewer entry now owns DOM lifetime; public control/lease is connected within its Node contract scope; performance APIs, actual Native viewport acceptance and full Agent/CDP fencing remain pending.

Messages, request counts, handler waits and idle lifetime are bounded. Cancelled non-cooperative work retains admission; credentials travel only over the authenticated port. Public failure is frozen until explicit connect, including after online/resume. Real MessageChannel and Node data-plane tests do not substitute for real cross-origin browser/CSP/Native acceptance. See `docs/session-viewer-frame.md`.


## DOM component (experimental)

Import `createViewer` from `@remote-paint/session-client/viewer`. Pass an HTMLElement container with a defined size, a canonical trusted `viewerOrigin`, fixed `gatewayOrigin`/`sessionId`, optional `role` (default readonly), and the application `getTicket` callback. The component appends an isolated host/iframe at the exact Viewer root URL, without credentials in the URL. `ready` binds public metadata; `connect({signal?})` waits for actual authenticated connected state, independently of first paint.

`disconnect()` pauses authorization and preserves central callback/version/grant history. iframe reload creates a new port but keeps that central admission, including cancelled non-cooperative callbacks. Public failure remains latched until explicit connect. `destroy()` is idempotent, bounds its child acknowledgement wait, removes its DOM and listeners and leaves the RemoteSession backend/TTL-owned. Host removal and pagehide also dispose or pause the component. State and fixed-code error subscriptions use `on('state'|'error', listener)` and return unsubscribe functions.

Defaults: load 20s, connect total 45s, disconnect acknowledgement 1s, destroy wait 250ms. The child retains the existing render/input pipeline. Role changes are connected within their Node contract scope; full Agent/CDP write fencing, performance APIs and actual Native viewport acceptance remain pending. DOM/shadow/renderer scheduler fixtures and real Node network/MessageChannel tests do not prove actual browser/CSP/Native resource acceptance. See `docs/session-viewer-component.md`.


## Public takeover and lease (experimental)

Controller-ticket connections expose `takeControl({signal?,timeoutMs?})`, `releaseControl(...)` and immutable `control` snapshots through both the DOM component and frame connection. Subscribe using component `on('control', listener)` or `onControl`. Readonly tickets reject before Source control requests. Wait for a displayed frame/control mode `agent`; network connected alone does not imply control is available.

Takeover resolves on actual Source ControlGranted, after prior managed Agent work and cleanup. Release stops local queued input immediately and resolves only when Source cleanup returns to Agent mode. The eight fixed snapshot fields are mode, holder (none/self/other), held, lease, fencingToken, expiresAt, pageEpoch, viewportVersion. Only the current holder receives its lease and Source control-version fence; private Source Session/peer identity, keys and editor content are omitted. Fences are scoped to the current Source instance and do not substitute for the pending all-Agent/CDP authorization work.

One pending action, default 5s (50ms–10s). Pre-cancelled calls have no effect; cancellation/deadline after dispatch closes the connection/port to fence late grants. Source disconnect cleanup still waits for prior dispatched tools; cancellation is not business rollback. Explicit connect is required after terminal failure. Malformed control events/replies close the port. Real ViewerInput/Node Source/MessageChannel tests use explicit DOM/renderer/CDP-result fixtures; actual browser/Native qualification remains pending. See `docs/session-viewer-control.md`.


## Role and readonly transitions (experimental)

The DOM component exposes `setRole('readonly'|'controller', {signal?})` and `setReadonly(boolean, options?)`. Same role has no effect. A real change invalidates/stops/removes the old iframe before requesting a fresh matching grant in a new channel. It resumes prior explicit connection intent; paused/failed viewers change role while staying paused until explicit connect. One transition, no queue; concurrent role/connect/control operations reject with CHANNEL_BUSY.

Ticket callbacks receive immutable requested `role`, `previousRole` and `previousGrantId` alongside signal/reason. The application backend authorizes the user and Session, revokes the old grant and mints the requested role (same-role refresh may be used). The existing refresh endpoint keeps its original role. A client role switch is not a global server permission change or revocation; no management key enters this module. Version/history and the one actual unsettled callback admission survive every role switch; late old results cannot create a socket or replace history.

Standalone `ViewerTicketSource.setRole` only changes callback/validation policy and aborts old waiting; the caller owns external socket retirement. FrameConnection instances remain fixed-role. The DOM component owns the complete old/new lifetime. Cancellation/disconnect/destroy stops a transition without restoring old authority; state.role shows the committed role. Source cleanup still fences prior submitted tools even if new readonly display connects first. Real browser/Native and all Agent/CDP paths remain pending. See `docs/session-viewer-roles.md`.


## Local display sizing (experimental)

`viewer.resize({width,height})` sets the owned host CSS size (finite numeric 1–16384px, fractional allowed); `viewer.resize()` restores 100% container sizing. Immutable `displaySize` and `on('resize', listener)` / `onResize` snapshots explicitly use scope `display`, mode `fixed` or `container`, and width/height (null in container mode). They describe requested CSS sizing, not measured canvas/client boxes or completed pixels. Identical requests do not repeat events.

Sizing works before authorization and across iframe reload/role changes, independently of tickets, Source viewport/epochs and leases. Destroy refuses later updates and clears subscriptions. The separate authorized resizeViewport API below confirms the Source barrier; actual Native capture/pixel acceptance remains pending. Performance/firstframe and actual browser/layout/Native resource qualification also remain pending. See `docs/session-viewer-display.md`.


## Remote Source viewport (experimental)

Both DOM and Frame connections expose `resizeViewport({width,height}, {signal?,timeoutMs?})`. Hold a controller lease first. Sizes are CSS integers 1–4096 with exactly those two fields; DPR and arbitrary commands are refused. Default total timeout is 5s, configurable 50ms–10s. One pending viewport operation; takeover/release share the child admission. This operation leaves host CSS/displaySize unchanged.

The frozen result has exactly `scope: "viewport"`, `changed`, `width`, `height`, `pageEpoch`, `viewportVersion`. It confirms the corresponding Source resize barrier, independently of new submitted Viewer pixels. A changed size retires the old lease; reacquire only after the new frame/control generation is ready. A size no-op still neutralizes old held input at Source and renews the same lease before input resumes.

Import `ViewerViewportError` from the same /viewer or /viewer-frame entry. It extends ViewerChannelError with outcome `not-applied` or `unknown`. Invalid/pre-cancelled requests have no effects; a fixed Source denial can confirm not-applied. Cancellation/deadline/closure after dispatch and malformed outcomes are unknown and end the old connection. Source work already entered still holds its real admission until settlement; client cancellation does not prove rollback. No automatic viewport retry is performed. iframe reload/role change/destroy fences old results, and fixed failure details survive synchronous iframe teardown. Raw errors, Source private identity and execution APIs are never returned.

Real MessageChannel and Node Source contracts cover the full public request path with saved main/Worker code; DOM/CanvasKit/worker scheduling and Source.resize/CDP are explicit fixtures. Actual browser/Native capture/pixels, public control priority, performance/firstframe events and full resource/growth acceptance remain pending. See `docs/viewer-viewport-sdk.md`.

## Performance and first frame (experimental)

DOM and Frame connections expose immutable `performance` and nullable `firstFrame`. Configure `onPerformance` / `onFirstFrame`, or subscribe on the DOM component with `on('performance', listener)` and `on('first-frame', listener)`. Performance subscriptions immediately replay the latest snapshot, including `stage: 'unavailable'`; first-frame subscriptions replay only an available current-connection result. Each DOM event allows at most 64 listeners and returns an unsubscribe function. Ready metadata and authenticated connect can finish before first frame.

The first frame has `stage: 'scene-submitted'` and `clock: 'viewer-ui-receipt'`. `connectToReceiptMs` starts at renderer initialization (`startPhase: 'renderer-init'`) or a subsequent connection attempt; Worker messages include their hop back to UI. It confirms a submitted scene result received by UI, not physical presentation or application success. Correlate `connectionGeneration`, `pageEpoch`, `viewportVersion`, `frameId`, width and height with the current remote viewport. Display CSS sizing remains independent.

Performance samples are separated by at least 250ms in the child, including reconnects. They report local submitted throughput/receipt age, render time, received/resource bytes and count, observed Wasm heap and GPU/resident estimates. Missing optional measurements are null; memory is explicitly `client-estimate`, not process physical usage. No Source-clock frame age is inferred. Paused/failed/reloading/role-changing/destroyed lifetimes clear current metrics and first frame; empty reset notifications describe unavailability, not another measurement sample.

The authenticated bridge carries only a finite private grant envelope and a sanitized fixed-field snapshot. The host checks the grant it actually issued and drops old grants/generations/frame namespaces. Unknown fields or malformed snapshots close the channel with a fixed code. Renderer initialization/replay failures surface fixed `VIEWER_PROTOCOL_ERROR` through existing state/error APIs; private diagnostic text is not forwarded. No raw scenes, Source identity, URLs, tickets, renderer or memory objects enter these public snapshots. Actual Native/browser telemetry, physical latency and long resource/growth acceptance remain separate pending gates.


Source viewport screenshots and PNG file reads use the original observation context:

```js
const client = new AgentClient({ baseUrl, apiKey, maxScreenshotBytes: 4 * 1024 * 1024 });
const shot = (await client.observations.screenshot(context, { limits: { maxBytes: 1048576 } })).data;
const file = (await client.observations.downloadScreenshot(context, {
  screenshotId: shot.screenshotId, sha256: shot.sha256,
  byteLength: shot.byteLength, observedAt: shot.observedAt,
})).data;
// file.bytes is a new caller-owned Uint8Array; metadata is frozen.
await client.observations.releaseScreenshot(context, { screenshotId: shot.screenshotId });
```

`screenshotChunk(context, { screenshotId, offset, maxBytes? })` returns an immutable
base64 chunk, at most 3072 decoded bytes. Each method synchronously captures its
context/input, accepts `{ signal? }`, and makes one HTTP attempt, independently of
mutation retry configuration. It never refreshes context or recreates an expired
file. `rpcTimeoutMs?` remains a separate 50..120000 private deadline.

The PNG download cap `maxScreenshotBytes` defaults to 1 MiB and permits 57..4 MiB,
independent of the JSON `maxResponseBytes` cap. An oversized file reference fails
before fetch. Headers must match the requested file length/hash/time/context and
safe PNG attachment; the bounded streamed body must match length, SHA256, signature,
IHDR and dimensions. Partial or corrupt files are never returned. The result object,
context and metadata are frozen; its byte array is explicitly caller-owned and
mutable, with no transport or Source buffer alias. Actual fetch/body/cancellation
capacity stays held until settlement even after caller abort/timeout, and end has
independent capacity. No Node screenshot method grants Python screenshot SDK,
actual page download/upload/Profile, complete locators/frame access, raw CDP receiver
preallocation or browser physical-memory qualification.
