# Private durable Agent webhook capture

The opt-in `SqliteSessionStore({path, enableAgentWebhooks:true})` extension
captures notification bodies in the original exclusive SQLite ledger. This
checkpoint implements storage only. HTTP dispatch, retry/attempt fencing,
acknowledgment, receiver deduplication, public routes and SDK methods remain
required work. No notification is claimed delivered by this module.

An existing capture extension stays active when reopened without the creation
flag. Ordinary ledgers do not acquire its tables until explicitly enabled.
Migration validates existing Agent/event history first, preserves the instance,
Session/Agent revisions and event IDs, and adds a separate webhook revision.
Unknown extension formats, missing/foreign tables and invalid stored captures
fail closed. Durability uses the ledger's existing DELETE journal and FULL
synchronous policy. No new database or source of ownership is introduced.

The original opaque Agent controller calls:

```js
const capture = store.subscribeAgentWebhook(agentRunId, tenant, {
  endpointId: 'awh_00000000-0000-4000-8000-000000000001',
  after: 0,
}, {owner});
const page = store.readAgentWebhookCapture(capture.subscriptionId, tenant, {
  after: capture.after,
  limit: 4,
}, {owner});
```

The caller must supply a cursor in the available original Run history. A cursor
ahead of the Run or before its retained contiguous history is rejected. A
duplicate Run/endpoint subscription returns the original subscription; changing
its starting cursor is a conflict. Registration can capture available history
of a closed Run without reopening it. Endpoint IDs identify trusted future
configuration; this storage API does not accept or resolve URLs, secrets or
action parameters. Public admission and tenant-bound endpoint configuration
must be supplied before exposing any route.

Limits are fixed: 64 subscriptions overall, four per Run, 64 pending bodies per
subscription, 4096 UTF-8 bytes per body, and four entries per read. Each body is
the once-encoded `agent-webhook-v1` envelope containing its fixed endpoint ID,
subscription ID and the original complete `agent-event-v1` projection. The
original event ID/sequence survive retries and independent event-window pruning.
The stored SHA-256 detects inconsistent bytes; it is not protection against a
writer able to rewrite the database and its hash together. Captures validate
the full event DTO and its parent references using the event journal's existing
validator, and match retained original events when available.

Agent state, event append/pruning, capture body, cursor and both affected
revisions commit or roll back together. Registration/read operations do not
advance Agent or Session revisions, dispatch input, release Source ownership,
or assert a business outcome. Queued invocation projections retain the actual
requested/unknown/injected distinction.

A full subscription retains its exact known prefix and records
`reconciliationRequired:true`, `missingFrom` and `missingThrough`. Later events
expand that explicit gap without enqueueing past it. This bound does not block
the original Agent transition and never silently advances a delivery cursor.
There is no acknowledgment, deletion, gap reset or resume API in this stage;
future recovery must explicitly account for missing history. Queue reads are
repeatable, carry exact raw body strings/hashes, and do not consume entries.
The ledger's total database-byte limit and storage-error policy still apply;
physical disk exhaustion cannot guarantee further durable writes.

`tests/agent-webhook-journal.test.mjs` covers catch-up, byte/ID stability,
pagination, both subscription quotas, overflow, stale owner/tenant rejection,
closed Runs, opt-in/reopen behavior, schema/capture corruption, injected insert
failure, and real writer SIGKILL before migration, registration and outcome
commit. The first capacity fixture reused an existing Session idempotency
binding and correctly failed with `STATE_CONFLICT`; that failed run is retained
outside the repository. The corrected fixture uses independent tenants.
