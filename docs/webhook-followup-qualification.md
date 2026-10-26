# Webhook follow-up: local Linux qualification

2026-10-25 20:40 Asia/Shanghai. Base is merged PR #1, main commit
`2d886d33b541431982baeb3be3ebd6400d73758d`. This local branch continues 52
explicitly selected pre-existing, uncommitted Webhook HTTP/Node/Python SDK and
fixture changes. The original checkout was not edited. C6 persistent Viewer
cache changes, old packaging changes and the unrelated peer edit were excluded.

## What changed in this continuation

The isolated Linux container exposed a real test-resolver assumption. Node's
inherited `ADDRCONFIG` causes localhost lookup to return `ENOTFOUND` when the
namespace has only loopback, even though lookup with zero hints returns IPv4
loopback. Both observed Webhook failures had zero accepted TLS connections.
The trusted localhost-only test resolvers now clear those hints. Certificate
verification, hostname mismatch rejection, actual TCP/TLS retirement checks,
eight-attempt limits and three-second observers are unchanged. Production DNS,
TLS, authorization, retention and retry code were not weakened for this fix.

The SDK CI's strict test-file/case count also lagged PR #1's three added Linux
packaging test files and nine cases. The post-merge remote
[run 40192236314](https://github.com/jihuayu/remote-paint/actions/runs/40192236314)
failed at `len(test_files)==154` before any tests ran. With this existing
Webhook follow-up included, the precise gate is now 159 files and 1803 cases.
Mac expectations remain 15 platform skips and Linux six; no failure is accepted.
This is a local correction, not a claim that the remote run has turned green.

## Executed evidence

Linux/aarch64, Node 22.23.3, Python 3.11.2; 4 CPU, 2 GiB, 512 MiB temporary
filesystem, no external network or published ports. The test-only filesystem
permits the repository's existing executable child fixtures. The first
self-created noexec test environment caused 11 failures and 17 cancellations;
its full log is retained, and those results are not product failures or passes.
The root remains read-only and the host's security settings were not changed.

- Webhook dispatcher/driver/public HTTP/receiver: before 94/96, after 96/96.
- Full JS: 1803 cases, 1797 pass, six existing platform skips, zero failures or
  cancellations; 159 root test files, original four-file concurrency.
- Full source Python: 210/210, about 18 seconds under the original 120-second cap.
- Fresh private archive builds and independent offline installs: Node 214/214,
  Python 210/210, strict TypeScript and installed-package Mypy all passed.
- Exact Node/Python README snippets produced the same subscription and three
  durable inbox events, with zero Source actions.
- The complete local qualification coordinator exited zero in about 56 seconds;
  full JS took about 31 seconds and installed-package checks about 24 seconds.
  Every stage retained its original 120-second limit. No source SDK fallback
  was available to the installed consumers.

The frozen executed input contains 1328 files. Implementation/test/SDK bytes
were verified unchanged after execution; only this document and its summary
were added afterwards. Machine details and archive hashes are in
[evidence/webhook-followup-qualification.json](evidence/webhook-followup-qualification.json).
Full logs, frozen manifests, receipts and private archives remain in the local
`followup-webhook-validation` task directory. Historical evidence is preserved.

## What this does not establish

The older Linux Python malformed download response and mapped-storage timeout
did not reproduce in this qualification; their original cause is not declared
fixed. This newly passing Linux offline-installed suite supersedes neither all
storage environments nor a fresh macOS full-suite run. The remote main SDK CI
remains failed until an authorized new publication/rerun occurs.

Original Native Webhook end-to-end and Source history-gap reconciliation are
still open. Native hard-download-budget readiness, full C6 capacity/eviction/
version-transition qualification, the deferred eight-hour Viewer memory failure,
NAS deployment and full production qualification are not claimed. No draft PR,
Release or deployment was created by this continuation.
