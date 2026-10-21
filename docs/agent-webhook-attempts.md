# Private durable webhook attempts and receipts

The v2 webhook ledger separates the immutable subscription `after` cursor from
`acceptedThrough`. Original envelope/event IDs and raw body bytes remain
unchanged. Acceptance removes only the original pending head and frees one
bounded slot. A remembered latest receipt makes that exact duplicate ACK a
no-op; older receipts cannot advance another head. Capture pages identify
delivery IDs, attempt IDs/counts and last transport outcome. Reads default to
the accepted cursor; requesting already removed bodies is an explicit cursor
error. Initial subscription retries still use the original immutable cursor.

Only the current opaque Agent controller can use the private store methods:

```js
const {attempt} = store.beginAgentWebhookAttempt(subscriptionId, tenant, {owner});
// The future trusted transport worker must retain this original attempt and
// call settlement only after the actual request/response resources settle.
if (attempt) store.settleAgentWebhookAttempt(subscriptionId, tenant, {
  deliveryId: attempt.deliveryId,
  attemptId: attempt.attemptId,
  bodySha256: attempt.bodySha256,
  outcome: 'unknown',
  transportSettled: true,
}, {owner});
```

`begin` durably assigns a fresh attempt ID to the one original head before a
worker may send. A second begin while requested fails. All retries keep the
original delivery ID, event ID and body/hash; only the attempt ID/count changes.
Outcomes are receiver `accepted`, `not-accepted`, or `unknown`. Eight requested
attempts are allowed; an exhausted head remains pending and cannot be skipped.
A late ACK from a superseded or already negatively settled attempt is rejected.
An identical repeated negative outcome does not increment the revision.

These are trusted transport bookkeeping methods. The `transportSettled:true`
input is a required assertion by the worker, not proof of actual network I/O.
This module does not open HTTP requests or verify receiver persistence. The
actual HTTPS worker must bind settlement to the original request completion,
hold capacity while I/O is unknown, and authenticate exact bytes with the
previously qualified HMAC core. A returned transport acceptance never asserts
receiver business success, input injection, side-effect rollback or Source
cleanup. Public admission, retries/backoff, trusted endpoint configuration,
receiver durable deduplication and SDK integration remain required work.

A requested attempt prevents controller release and therefore ledger close.
Repeated claim by that same live owner does not clear it. Only a fresh exclusive
ledger owner recovers persisted requested attempts as unknown; it preserves
the original ID/body and consumed count. The receiver may already have acted,
so later retries must retain the original event ID for receiver deduplication.
Notification revisions change independently of Agent/Session state revisions.

The original v1 validator checks every old capture before an atomic v1-to-v2
migration. The migration adds accepted cursors initialized to the original
starting cursor and new delivery IDs/zero attempt state. It preserves existing
body bytes, event IDs, ledger identity, original revisions and explicit gaps.
An unknown/corrupt extension is rejected. An existing v2 extension stays enabled
when reopened without a creation flag. v1 readers reject v2 rather than
silently losing acknowledgment state.

Overflow still retains the known prefix and explicit missing range. Draining
that prefix does not clear or advance past a gap; new Agent events extend its
missing range. Explicit reconciliation is required before resumed delivery.
There is no force-ack, gap skip or retry-budget reset in this checkpoint.

The attempts tests exercise current-head/attempt/hash fencing, duplicate ACKs,
finite retries, capacity reuse beyond replay retention, unchanged Source/Agent
state, legacy migration/corruption and real writer SIGKILL before migration,
begin and ACK commits and after begin/ACK commits. The same1255 source hashes completed macOS and Linux ARM64 full1645: macOS1630 pass/15 existing skips; Linux1639 pass/6 existing skips, zero failures/cancellations. All23 new cases actually ran and all1622 prior case names were retained. Each platform passed installed202 Node/194 Python, strict TypeScript and installed5-public/9-source mypy; all194 Python case names and both SDK archive hashes match. [CI39551778361](https://github.com/jihuayu/remote-paint/actions/runs/39551778361) binds implementation ce76596. Earlier host execution timeouts and the same-input100-pass retry are preserved; no timeout or acceptance threshold was relaxed. This qualifies storage bookkeeping only; actual transport, receiver durability and fullWebhook remain pending.
