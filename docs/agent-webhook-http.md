# Authenticated Agent Webhook management

These backend HTTP routes select trusted, automatically driven endpoint profiles.
The service operator provisions each tenant's fixed HTTPS destination and HMAC
keys with `executor.registerWebhookEndpoint(...)`. The executor permits at most
four endpoint workers in total, sharing its existing manual/automatic worker
budget. Requests cannot provision destinations, keys, DNS settings or transport
limits. The service owns TLS/proxy binding and the original executor shutdown.

## Public routes

| Method and path | Required scope | Result |
| --- | --- | --- |
| `GET /v1/agent-runs/:run/webhook-endpoints` | `agents:webhooks:read` | Up to four registered automatic endpoint IDs and `available` booleans for the authenticated tenant. |
| `POST /v1/agent-runs/:run/webhook-subscriptions` | `agents:webhooks:write` | Persist or return the original subscription for this run and endpoint. |
| `GET /v1/agent-runs/:run/webhook-subscriptions/:subscription` | `agents:webhooks:read` | Bounded subscription metadata and its original pending head, without event bodies or secrets. |

Existing `agents:read`, `agents:write`, `agents:observe` and `agents:end` grants do
not imply either Webhook scope. Read and write scopes are independent. Run and
subscription references must belong to the authenticated tenant and exact run.
These routes use the backend API key and Origin policy of the Session API. They
consume ordinary HTTP admission; Source end/cancel retains its separate lane.

A subscription request is uncompressed UTF-8 JSON, at most 1024 bytes (or a lower
configured Agent request limit), with exactly two fields:

```json
{
  "endpointId": "awh_00000000-0000-4000-8000-000000000001",
  "after": "aec1.arun_00000000-0000-4000-8000-000000000002.0"
}
```

`after` uses the original public Agent event cursor, bound to this run. The
selected cursor must still have contiguous retained original history. Zero does
not authorize silently skipping a pruned prefix. A cursor is a position, not an
authorization credential. Query strings and `Last-Event-ID` are not accepted on
these management routes; the POST body is the only subscription start cursor.

Successful POST returns HTTP 200 and a `Location` pointing to the subscription.
The natural key is `(run, endpoint)`, with an immutable original start cursor.
Repeating the same request returns the same subscription ID. A different start
cursor returns `AGENT_WEBHOOK_SUBSCRIPTION_CONFLICT`; supplying a different
Idempotency-Key does not create a new subscription or reset its history.

The original automatic driver discovers the committed journal revision. Neither
this route nor the caller needs to invoke per-event delivery. HTTP success means
the subscription was committed; it does not mean any event or business action
has completed.

## Status and acceptance

Responses use `agent-webhook-subscription-v1` and include `subscriptionId`,
`agentRunId`, `sessionId`, `endpointId`, `pending`, `reconciliationRequired`, and
these original run-bound cursor positions:

- `after`: immutable subscription start.
- `acceptedThrough`: original sender-confirmed acceptance prefix.
- `queuedThrough`: last event in the captured contiguous prefix.
- `observedLatest`: latest original Source journal event observed by capture.
- `missingFrom` and `missingThrough`: explicit missing range, or null.

`head` is null when the retained pending prefix is empty. Otherwise it contains
only the original `eventId`, numeric `sequence`, public `cursor`, `attempts` and
`lastOutcome` (`null`, `requested`, `unknown` or `not-accepted`). No delivery body,
destination, signature, HMAC key, delivery ID, attempt ID or Source binding is
returned. Reads do not acknowledge events or change the Source writer.

`acceptedThrough` starts at the explicitly requested `after` cursor. Only
`(after, acceptedThrough]` is the sender-confirmed acceptance range; its initial
value does not claim that earlier events were delivered. Advancement records a
valid original transport ACK after actual I/O settlement. With the provided production receiver, that ACK follows its inbox
COMMIT. An arbitrary endpoint's ACK remains that endpoint's claim. Neither case
proves downstream business success. A requested or unknown original head is not
assumed stopped; eight consumed attempts remain consumed. Status does not issue
a ninth attempt, refund capacity or reset a missing range.

A saturated capture retains its known 64-event prefix and records the gap. The
driver may drain that prefix while `reconciliationRequired` remains true. A
null head with zero pending is therefore not proof that all Source history was
accepted. Explicit Source gap reconciliation remains a separate pending
capability; this API does not provide a cursor rewrite or action replay shortcut.

## Backend caller example

Use the configured backend base URL and API key. Obtain the run ID from the
existing Agent API. Discover endpoint IDs through the first route, then send the
JSON above and retain the returned subscription ID:

```sh
curl --fail-with-body "$REMOTE_PAINT_API/v1/agent-runs/$RUN_ID/webhook-endpoints" \
  -H "Authorization: Bearer $REMOTE_PAINT_API_KEY"

curl --fail-with-body "$REMOTE_PAINT_API/v1/agent-runs/$RUN_ID/webhook-subscriptions" \
  -H "Authorization: Bearer $REMOTE_PAINT_API_KEY" \
  -H 'Content-Type: application/json' --data-binary @subscription.json

curl --fail-with-body "$REMOTE_PAINT_API/v1/agent-runs/$RUN_ID/webhook-subscriptions/$SUBSCRIPTION_ID" \
  -H "Authorization: Bearer $REMOTE_PAINT_API_KEY"
```

Node/Python typed SDK wrappers now expose endpoint discovery, subscription and status
through their existing bounded ordinary request pools. See the executable examples in
[Node README](../sdk/README.md#fixed-webhook-subscriptions) and
[Python README](../sdk/python/README.md#fixed-webhook-subscriptions). They capture the exact
start before dispatch, validate run-bound cursor/head/gap invariants and return frozen
metadata. Explicit Source gap reconciliation and Native qualification remain pending. The existing
[HTTPS receiver](agent-webhook-receiver.md), [durable inbox](agent-webhook-inbox.md)
and [automatic driver](agent-webhook-driver.md) define the receiver/transport
contract; they are separate from management credentials and business processing.

## Failures and lifetime

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `AGENT_WEBHOOK_ENDPOINT_NOT_FOUND` | 404 | No selectable automatic profile for this tenant. |
| `AGENT_WEBHOOK_ENDPOINT_UNAVAILABLE` | 503 | Original registered worker is stopping, closed or faulted. |
| `AGENT_WEBHOOK_SUBSCRIPTION_NOT_FOUND` | 404 | Subscription does not belong to this exact tenant/run. |
| `AGENT_WEBHOOK_SUBSCRIPTION_CONFLICT` | 409 | Original start cursor cannot change. |
| `AGENT_WEBHOOK_HISTORY_UNAVAILABLE` | 409 | Requested original history is ahead or no longer retained. |
| `AGENT_WEBHOOK_CAPACITY` | 429 | Original persisted subscription capacity reached. |
| `AGENT_WEBHOOK_NOT_CONFIGURED` | 503 | Ledger capture is unavailable. |
| `AGENT_STORAGE_UNAVAILABLE` | 503 | Confirmation unavailable; an accepted write may have outcome `unknown`. |

Ordinary format/auth/run errors retain the existing Agent HTTP codes. Unknown
subscription probes and ordinary cursor/conflict/capacity errors do not fence a
healthy executor. Unexpected persistence failure fences later Agent admission;
a 503 with outcome `unknown` does not establish that a subscription is absent.

Disconnect, request deadline and later API-key revocation affect the HTTP
observation. They do not erase an already committed subscription or cancel its
original DNS/HTTPS work. Source end remains independent of a slow delivery.
Retiring an executor still waits for its actual owned work; after retirement a
fresh controller can read the original closed-run subscription and a newly
registered trusted driver can resume it without repeating Source actions.
