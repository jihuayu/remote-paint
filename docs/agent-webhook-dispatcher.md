# Private HTTPS Agent webhook dispatcher

The trusted backend can create one endpoint-bound dispatcher through its
`DurableAgentExecutor`. The executor owns its private ledger token. These
methods are not public HTTP authorization, receiver deduplication or SDK APIs.

```js
const dispatcher = executor.createWebhookDispatcher({
  tenantId,
  endpointId,
  url: 'https://receiver.example/hooks/agent',
  keys: [{keyId: 'current', secret: secretBytes}],
  activeKeyId: 'current',
});
const subscription = dispatcher.subscribe({agentRunId, after: 0});
const receipt = await dispatcher.deliver(subscription.subscriptionId, {signal});
```

Configuration captures a fixed HTTPS URL, tenant, endpoint and copied HMAC keys.
Per-call URL/transport overrides, userinfo, fragments, insecure schemes and TLS
verification bypasses are rejected. An optional bounded PEM `ca` selects private
trust; system trust is otherwise used. Hostname verification stays enabled.
The sender signs the exact stored UTF-8 body using the previously qualified
HMAC core. Each retry keeps the original event/delivery ID and body/hash and
signs again with the current timestamp. Redirects are never followed.

The receiver declares acceptance with complete HTTP200 or202, content type
`application/json` (optionally UTF-8), and exactly these JSON fields:

```json
{"schema":"agent-webhook-ack-v1","eventId":"aevt_UUID","bodySha256":"64-lowercase-hex"}
```

The event ID and SHA-256 must match that original request. An incomplete,
malformed, oversized, mismatched or unverifiable reply is unknown. A complete
other status is not-accepted. Acceptance is a peer declaration of receipt; it
does not prove durable receiver storage, business success, rollback, input
injection or Source retirement. Durable authenticated receiver insertion and
deduplication remain required before the full signed Webhook can be accepted.

Defaults are two admitted jobs,30 seconds per attempt and a1-second initial
retry delay. Hard limits are eight jobs per dispatcher,60 seconds per attempt,
eight attempts per original event,60 seconds per backoff,4096 outgoing bytes,
1024 response bytes,8192 header bytes,32 fields and four informational replies.
One sentinel header detects an over-limit set before parser truncation could
hide it. Duplicate response fields, upgrades/tunnels and trailers are rejected.
An executor owns at most four live endpoint dispatchers and rejects duplicate
tenant/endpoint workers. A fully closed worker with zero outstanding work can
be replaced, including for key rotation. URL, key or input-array mutation after
capture cannot redirect an existing worker or change its authentication keys.

One deliver job handles one original queue head, with sequential bounded retries.
It holds its admission slot across backoff and each actual transport. Exponential
backoff is based on the persisted consumed attempt count and capped at60 seconds.
A restarted owner conservatively waits a full computed delay before another
attempt; no unpersisted timer is treated as a delivered receipt. Eight failed
attempts retain the exhausted head. Empty queues and reconciliation gaps are
reported explicitly; the worker never skips a gap or invents missing history.

The default private `dns.Resolver` uses the system DNS server configuration with
asynchronous A/AAAA queries and a bounded eight-address result. It does not use
the OS getaddrinfo threadpool or `/etc/hosts`; see [Node22 DNS implementation
considerations](https://nodejs.org/download/release/v22.23.3/docs/api/dns.html#implementation-considerations).
This keeps ordinary Webhook DNS work separate from Source cleanup's system
lookup pool. Private `dnsServers` may select up to four captured literal server
addresses; it changes no global resolver settings. An alternative trusted
callback-style `lookup` can integrate a special name service and cannot be
combined with `dnsServers`. Its original callback remains owned even if the
function throws or mistakenly returns a rejected native Promise. The rejection
is observed, but it does not certify completion of the original callback work.

The original request, response, socket close events and DNS callbacks must all
settle before the corresponding ledger outcome is recorded or capacity returns.
The absolute timer actively destroys the request; a timeout alone is not close
evidence. Request `finish` is also insufficient. These distinctions follow the
[Node22 HTTP client lifecycle](https://nodejs.org/download/release/v22.23.3/docs/api/http.html#httprequestoptions-callback).
The dispatcher uses its own non-keepalive HTTPS agent with session caching off;
it exposes no transport callback able to supply a fabricated close receipt.

AbortSignal cancels only that caller's wait. Actual delivery continues with its
original identity, deadline and ownership. A second delivery for the same
subscription is in-flight, and a saturated worker rejects new work. No observer
abort, reply timeout, request `destroyed` flag or mistaken lower-level Promise
can refund live work. A custom lookup that never calls back can keep its bounded
slot unresolved; it cannot create replacement attempts or return a confirmed
close. The normal private resolver has real cancellation callbacks on close.

`dispatcher.close({signal})` fences admissions, zeros owned HMAC key copies,
stops backoff, destroys owned sockets and cancels its own resolver queries.
It returns a shared close promise only when original work and journal results
are settled. Canceling observation of close does not certify shutdown. Executor
shutdown initiates dispatcher close and independently sends Source end; it
returns the ledger owner only after original Source work and dispatchers settle.
Its bounded shutdown observation can remain unconfirmed while Source end has
already finished. The public status contains counts/fences and no URL, secrets
or raw event data. Direct capture reads remain private backend operations.

If a begin/ACK transaction's result is uncertain, the worker retains that exact
entry, rejects new admissions and holds close pending. After actual I/O settles,
`dispatcher.reconcile(subscriptionId)` can retry the exact original journal
settlement. A committed ACK is an idempotent duplicate; an uncertain begin that
never sent is recorded as unknown without refunding its consumed attempt. No
new HTTPS request is emitted during reconciliation. A file-identity fault or an
unmatched head remains fenced rather than being reconstructed as safe progress.

Tests use actual local TLS sockets and a public test-only localhost certificate
and key. They cover signed Unicode bytes, capacity after abort, original DNS
callbacks, finite retries, redirects, response bounds, trust/hostname checks,
deadlines, actual transaction failures before/after COMMIT, Source end and
default private DNS queries/cancellation. The first Unicode fixture incorrectly
used a default Run for its customized Session and correctly hit the existing
reference guard; its failed run and source are preserved outside the repository.
The same1262 source hashes passed macOS and Linux ARM64 full1670: macOS1655 pass/15 existing skips, Linux1664 pass/6 existing skips, zero failures/cancellations. All25 new cases actually ran and all1645 prior case names were retained. Each platform passed installed202 Node/194 Python, strict TypeScript and installed5-public/9-source mypy; all194 Python case names and both SDK archive hashes match. [CI39556464074](https://github.com/jihuayu/remote-paint/actions/runs/39556464074) binds implementation cc690eb. The Unicode-fixture failure remains preserved. This qualifies private local TLS/DNS/SQLite/executor fixtures only; no persistent receiver deduplication, public management/SDK, controlled external receiver or original Native runtime acceptance is claimed. See [evidence](evidence/agent-webhook-dispatcher.json).
Original Native runtime, public management/SDKs, receiver durable deduplication
and the wholeK8/41/eight-hour gates are not completed by these tests.
