# Node/Python Webhook SDK checkpoint

Node exposes `runs.webhookEndpoints`, `runs.subscribeWebhook` and `runs.webhookSubscription`.
Python exposes `runs.webhook_endpoints`, `runs.subscribe_webhook` and
`runs.webhook_subscription`, with frozen typed models and distinct endpoint/subscription IDs.
Both select trusted fixed endpoint IDs and an explicit original run-bound event cursor.
No caller URL/key configuration or event-by-event delivery is required.

Requests reuse ordinary HTTP admission, bounded retries and existing cancellation/settlement.
Input is captured before dispatch (before coroutine creation in Python). Response validation
binds identities, sorted endpoint limits, canonical cursors, accepted/queued/observed ranges,
exact missing ranges and the original head with at most eight consumed attempts. Only
`(after, acceptedThrough]` is receiver-accepted; no business success is implied.

## Executable public examples

[Node README](../sdk/README.md#fixed-webhook-subscriptions) and
[Python README](../sdk/python/README.md#fixed-webhook-subscriptions) contain the exact verified
snippets. The package verifier extracts and executes their bytes with isolated installed
archives against real HTTP, SQLite and the signed durable TLS receiver. Both snippets return
one natural-key subscription and three distinct original inbox events, without Source actions.
The archive consumer has no source `sdk/` fallback. Existing receiver and inbox docs define
HMAC verification and event-ID deduplication independently from management credentials.

## Local evidence and limits

Both platforms passed 214 installed Node cases. macOS passed all 206 installed Python
cases; Linux completed 206 with two errors in existing download-startup and observation
cases (204 passed). The 12 new Webhook cases per language pass; Linux repeats its 12 new
Python cases separately. The unchanged full-suite assertion remains failing. TypeScript strict/exact-optional checks, five mypy consumer files
and ten package files passed. Actual fixtures cover later original events, immutable retries,
lost committed Node replies, tenant/scopes, and delivery through Source end. macOS package
qualification uses candidate 2; candidate 3 changes only the immediate rejection observer in
one existing Node test and separately repeats all 214 installed Node cases. SDK, Python and
README bytes are identical. Linux executes candidate 3, retains the two full Python
errors, and separately checks the previously unexecuted strict types and README snippets.
Those component checks do not make the full Python suite pass.

The original 100ms stream test deadline and exactly-once cleanup assertions are unchanged.
The observer now attaches before awaiting the cancellation-start signal, and a finally block
settles its owned deferred cleanup. The first tmpfs run's unhandled rejection is preserved.
Earlier dependency/setup failures, the 12-error Python cast failure, aggregate coordinator
terminations, and the Linux 120-second Python unit timeout on mapped storage are retained.
The final Linux consumer uses the same 4 CPU/2GiB/512MiB tmpfs limits with project/consumer
on tmpfs, retaining all per-stage 120-second guards. The local aggregate coordinator has
360 seconds to collect multiple independently bounded stages. This is not qualification of
the unchanged hosted/full-CI aggregate timing or performance across storage configurations.

154 original root test files remain byte-identical, one has only the observer correction,
and all its case names remain. Nine original Python test files are byte-identical. The root
expectation becomes 1794 cases in 156 files; this checkpoint did not run the whole root suite.
Its earlier three failures remain unresolved and were reproduced on the clean baseline.

The 41-item ledger remains 10 complete within their recorded scopes, 18 partial, 13 pending.
The two Linux full Python errors, explicit Source history-gap reconciliation, full Native/adapter and mild-loss acceptance,
and the failed original eight-hour run remain pending. The original browser build and its
32GiB floor are preserved. No commit or push was made; the unrelated peer edit is excluded.

Machine-readable details: [evidence](evidence/agent-webhook-sdk.json).
