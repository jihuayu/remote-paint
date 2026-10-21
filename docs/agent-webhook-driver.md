# Owned automatic Agent Webhook delivery

`executor.registerWebhookEndpoint(config)` is trusted backend registration. It captures one tenant, endpoint ID, HTTPS URL and signing keys, then owns an automatic delivery driver through executor shutdown. Configuration is the dispatcher profile plus optional `pollIntervalMs` (default250, range10..1000). Transport defaults to two concurrent original heads, hard eight; the executor shares a four-profile budget with its manual dispatchers, rejects duplicate tenant/endpoint owners and cannot replace an automatic owner before its complete close. Public request callers never choose a URL or key through this API.

```js
const endpoint = executor.registerWebhookEndpoint({
  tenantId, endpointId, url, keys, activeKeyId,
});
const subscription = endpoint.subscribe({agentRunId, after: 0});
// Automatic delivery continues for later original events; no per-event deliver call.
const current = endpoint.read(subscription.subscriptionId);
```

On startup, the driver discovers existing original subscriptions in pages of at most four metadata records. It advances a round-robin keyset cursor and starts one original head per subscription visit, retaining at most the dispatcher's bounded active jobs. Each sweep reads at most64 subscriptions; there is one polling timer per driver. An idle pass checks the persisted webhook revision instead of loading histories. The completed pass remembers its starting revision, so events appended behind the current cursor during a pass trigger another sweep. The driver does not retain a delivery history or raw event queue of its own.

The existing dispatcher owns exact signed body/IDs, DNS callbacks, request/response/socket closure, retry backoff and eight persisted attempts. Automatic scheduling never refunds consumed attempts, emits a ninth request or treats an already requested head as stopped. It drains a known captured prefix while retaining the explicit missing range; it does not skip lost Source events, replay Source actions or infer business success. An exhausted head remains retained. A persistence-uncertain attempt retains dispatcher capacity and fences new admission until private exact `reconcile(subscriptionId)` succeeds. A discovery read fault stops admission; closing and re-registering the fully retired owner can validate and resume original state, without clearing an uncertain original attempt.

`close({signal})` starts dispatcher close, stops and joins the original poll loop, then joins its job continuations. A signal cancels only the caller's observation. Status remains `closed:false` while the actual owner is unresolved, even if observation timed out. Executor shutdown starts this retirement before ending Source runs, so a held webhook DNS callback cannot delay the original Source end request. The controller is released only after both original Source work and every webhook owner settle. Closed notification owners do not erase subscriptions or pending heads.

Local targeted tests cover automatic production receiver delivery and later events, persisted subscription discovery, fairness, eight-attempt exhaustion, prefix/gap preservation, original DNS ownership, retry backoff stop, receiver commit with lost ACK plus controller restart/dedup, idempotent subscription/profile pinning, requested-head non-replay, uncertain committed ACK reconciliation, discovery read faults, strict options, four-profile registration and Source shutdown independence. A separate case appends original events to a subscription already visited while another subscription is being delivered. Initial fixtures wrongly requested another reserved writer on one Session, used an undefined executor tenant and reused a synthetic idempotency hash; their failed source/logs are preserved and the production constraints are retained.

This checkpoint implements trusted automatic ownership. Public authenticated management routes, Node/Python typed SDK calls, explicit Source gap reconciliation and original Native end-to-end acceptance remain required. No external endpoint is deployed and no new macOS sampler execution/copy/rebuild is needed for targeted tests. Linux full-suite and installed-package qualification is recorded below.

## Verification

The same1278 executed source files passed macOS targeted214 and [Linux CI39573287711](https://github.com/jihuayu/remote-paint/actions/runs/39573287711), implementation bd42cd343b0a7c7a906390108c3ac59d90c61079. Linux full1751 has1745 pass/six existing skips, zero failures/cancellations; all prior1725 names and those six skips are retained. All26 added cases (eight discovery and18 driver) actually ran on both platforms. The preceding discovery-only commit also passed CI39571744383 full1733 and macOS targeted166. A new macOS full1751 run is not claimed.

Linux installed202 Node/194 Python cases, strict TypeScript and public5/source9 Mypy checks passed; all194 Python identities and SDK archive bytes match the preceding receiver checkpoint. No additional macOS sampler startup, copy or rebuild was required. Initial13/17 and16/17 fixture failures remain preserved; actual transport deadlines, retry counts and platform skips were not relaxed. See [qualification evidence](evidence/agent-webhook-driver.json).
