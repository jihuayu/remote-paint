# Remote Paint Session client — experimental

Node.js 22+ ESM backend client, with TypeScript declarations. This private package is a local development artifact; it has not been published. It contains the backend management client and a separate browser-safe short-ticket connection module. A configured Session control service is required. Native provider integration, rendered Viewer roles/tickets, Agent tools and rolling-version acceptance remain pending.

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

Keep the management key on your Node backend. The client refuses browser execution and redirects. Use an HTTPS API origin; local HTTP is allowed only for localhost, 127.0.0.1 or ::1. No cookies/referrer are sent. Injected fetch is trusted backend configuration and must respect AbortSignal and redirect options. Viewer embedding is a separate, unfinished integration.


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
