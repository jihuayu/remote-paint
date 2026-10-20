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

`prepareCreate` captures the body/key before sending. `send({signal,retries})` cannot replace them. The convenience method is `sessions.create(input,{idempotencyKey,signal?,retries?})`. Default automatic retries are zero. Explicit `retries:0|1|2|3` retries transient failures using the original body/key. A timeout or cancellation after dispatch may leave creation accepted; do not generate a new key for the same job. AbortSignal stops client waiting, while resource release is a separate request.

`SessionClientError` exposes `code`, `status`, `requestId`, `outcome` and `retryable`. Outcomes are `not-dispatched`, `rejected` or `unknown`. The error message does not include raw HTTP/transport exceptions or credentials. Responses are bounded and checked for schema, identity, operation kind/status and request ID. Each attempt has a default 10-second deadline covering fetch/body streaming; default response cap is 64 KiB. Returned data is frozen and typed readonly.

Keep the management key on your Node backend. The client refuses browser execution and redirects. Use an HTTPS API origin; local HTTP is allowed only for localhost, 127.0.0.1 or ::1. No cookies/referrer are sent. Injected fetch is trusted backend configuration and must respect AbortSignal and redirect options. Viewer embedding is a separate, unfinished integration.


## Browser connection module (experimental)

Import `ViewerTicketSource`, `ViewerConnection` and `ViewerConnectionError` from `@remote-paint/session-client/viewer-connection`. This entry imports no backend code or management credentials. Configure a fixed gateway Origin, Viewer Origin, Session ID and role, and provide `getTicket({signal, reason, previousGrantId})`. Your application backend mints or refreshes the grant; the browser callback receives only that short grant. An API key option is rejected.

`ViewerTicketSource` validates the exact destination/Session/role/audience/expiry and pins the version. A timed-out non-cooperative callback continues to hold its one admission. `ViewerConnection` adds socket lifetime, pre-expiry refresh, bounded consecutive retries, stop/destroy and Welcome binding checks. Its `onSocket` hook uses the existing display protocol; it is not a complete embedded renderer. State/error callbacks contain no ticket URLs.

The existing Viewer main and Worker paths now share this implementation through `/connection.mjs`. `window.remotePaintViewer.connect(...)` uses the current frame Origin as the audience and accepts the same fixed gateway/Session/role and application ticket callback. `disconnect()` releases the current renderer/Worker/sockets and fences automatic resume. The dedicated public asset server now configures CSP and a parent Origin allowlist. The iframe host/child bridge and createViewer DOM component are implemented within their Node contract scope; actual browser CSP/resource acceptance remains pending; rendered/Native qualification waits for the original long run. See the repository document `docs/session-viewer-runtime.md`.


## Existing iframe connection (experimental)

`@remote-paint/session-client/viewer-frame` exports `ViewerFrameConnection` and `ViewerChannelError`. Give it an already loaded trusted frame Window, exact frame/gateway Origins, fixed Session/role and an application ticket callback. The public child entry validates its parent Window and configured Origin allowlist before accepting one transferred port. `ready` binds metadata; `connect()` waits for actual network connected state, `disconnect()` preserves callback/version history, and `close()` ends the channel. The /viewer entry now owns DOM lifetime; control/lease/resize/performance surface remains pending.

Messages, request counts, handler waits and idle lifetime are bounded. Cancelled non-cooperative work retains admission; credentials travel only over the authenticated port. Public failure is frozen until explicit connect, including after online/resume. Real MessageChannel and Node data-plane tests do not substitute for real cross-origin browser/CSP/Native acceptance. See `docs/session-viewer-frame.md`.


## DOM component (experimental)

Import `createViewer` from `@remote-paint/session-client/viewer`. Pass an HTMLElement container with a defined size, a canonical trusted `viewerOrigin`, fixed `gatewayOrigin`/`sessionId`, optional `role` (default readonly), and the application `getTicket` callback. The component appends an isolated host/iframe at the exact Viewer root URL, without credentials in the URL. `ready` binds public metadata; `connect({signal?})` waits for actual authenticated connected state, independently of first paint.

`disconnect()` pauses authorization and preserves central callback/version/grant history. iframe reload creates a new port but keeps that central admission, including cancelled non-cooperative callbacks. Public failure remains latched until explicit connect. `destroy()` is idempotent, bounds its child acknowledgement wait, removes its DOM and listeners and leaves the RemoteSession backend/TTL-owned. Host removal and pagehide also dispose or pause the component. State and fixed-code error subscriptions use `on('state'|'error', listener)` and return unsubscribe functions.

Defaults: load 20s, connect total 45s, disconnect acknowledgement 1s, destroy wait 250ms. The child retains the existing render/input pipeline. Role changes, public takeover/lease/fencing and explicit resize/performance APIs remain pending. DOM/shadow/renderer scheduler fixtures and real Node network/MessageChannel tests do not prove actual browser/CSP/Native resource acceptance. See `docs/session-viewer-component.md`.
