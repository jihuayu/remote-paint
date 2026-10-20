# Remote Paint Session client — experimental

Python 3.11+ asyncio backend client with immutable typed models and `py.typed`. This `0.0.0.dev0` package is an unpublished development artifact. It contains the management client, with HTTPX 0.28.1 as a dependency. A configured Session control service is required. Native provider, rendered Viewer roles/tickets and long-task events remain pending.

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

Each attempt has a default 10-second total deadline covering headers and body reads. Responses are limited to 64 KiB and validated against identity/schema/status. Models are frozen dataclasses with SessionId/OperationId NewTypes. Cancelling an executing request raises `SessionClientCancelledError`, a subclass of asyncio.CancelledError, and preserves Task cancellation semantics. Cancelling a Task before client code starts may use the native CancelledError. Neither cancellation withdraws an already accepted creation; release it separately.

Use `async with` or `await client.aclose()`. Closing is single-flight, cancels and waits for owned requests, and closes the connection pool. A failed response close fences new requests. Default active request cap is 64, with at most 16 HTTPX connections. The client refuses redirects, sends no response cookie back, disables environment proxy settings, and accepts HTTPS origins plus local HTTP for localhost/127.0.0.1/::1. An injected AsyncBaseTransport is trusted backend configuration and must honor cancellation/close.

This package is not a Viewer/browser SDK and must not receive credentials from untrusted page content. Public publishing, complete Native lifecycle and cross-version compatibility remain separate acceptance gates.
