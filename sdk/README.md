# Remote Paint Session client — experimental

Node.js 22+ ESM backend client, with TypeScript declarations. This private package is a local development artifact; it has not been published. It contains the management client only. A configured Session control service is required. Native provider integration, rendered Viewer roles/tickets, Agent tools and rolling-version acceptance remain pending.

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
