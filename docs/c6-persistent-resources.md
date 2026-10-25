# C6 persistent resources: implemented scope and open gates

Current follow-up: [actual public-proxy offer/omission/miss integration](c6-cache-offer.md). The earlier component scope below is historical; C6 remains partial under the listed remaining gates.

The public Viewer now uses actual IndexedDB for private immutable chunks and
predecode SKPs. Static Viewer/CanvasKit resources remain in their separate
immutable HTTP cache. A private body key contains the proxy-selected opaque
tenant/session/Ready/version/role/audience realm, CanvasKit version, Wasm SHA,
resource kind and content hash. I/O requires the exact currently active frozen
ViewerConnection permission, with wall and monotonic expiry checks. Before a
fresh matching Welcome, neither a ticket alone nor a known hash opens the DB.
New authority/renderer realms purge stale realms before cache I/O is admitted.
This conservative per-origin policy may evict another active tab's cache; that
is a recoverable miss, not cross-tenant authority.

The database holds at most512 metadata records and64MiB of body payload,
with16MiB per entry. This is not an exact total disk or process-heap bound.
Writes use one operation with no extra storage-operation queue, immutable
snapshots, atomically enforced global FIFO eviction and Blob storage. Reads
check bounded metadata and Blob size before allocating an ArrayBuffer, then
verify SHA before returning a charged buffer with explicit ownership release.
The cloned write input, copied buffer, Blob work, digest work and conservative
512x4KiB metadata scratch are accounted in ClientMemory. A timed-out digest or
Blob operation retains its admission/charges until actual settlement; late
completion cannot publish or write under a canceled epoch.

Saved main-thread and Worker entry points now restore only dependencies of a
fresh validated scene or current resource manifest, using the existing queue
and frame barrier. Missing/corrupt/slow bodies retain full-keyframe recovery.
The cache-read loop starts work for at most200ms; a final in-flight read can
consume its separate300ms operation guard. Cache writes run after actual
presentation/ACK, with one bounded512-reference queue charged256KiB; each body
is acquired from its current live owner immediately before charged admission.
This avoids retaining an uncharged frame/body backlog. Closed generations stop
the drain. Unsupported/failed storage falls back to the original data path.

Pause, renderer retirement and normal reconnect suspend access while preserving
only the bounded cache lifetime; fresh Welcome is required again. Main-window
permission mirroring keeps expiry/revocation cleanup alive when a Worker is
terminated. Explicit disconnect stops the old writer and awaits physical
private metadata/body deletion before the authenticated iframe bridge replies.
Cleanup failure is observable and denies cache I/O; supported storage that
fails explicit logout cleanup does not return a successful disconnect reply.
Non-persisted pagehide requests deletion, but browser shutdown cannot guarantee
that an asynchronous transaction completes. Abrupt-unload/failed-cleanup policy
still requires acceptance; no universal deletion guarantee is claimed.

The final1308-file executed candidate passed76/76 saved-runtime, HTTP module
graph, authority, connection, iframe channel and DOM contracts on macOS and
LinuxARM64, with no skips. Linux first failed before loading one test file
because the verification environment lacked the portable Playwright package;
that failure is retained, and the complete76 passed after adding that dependency.
The SDK sources are byte-identical to the prior installed222 authority
checkpoint. Installed SDK/Python suites were not rerun in this task; the older
Python210 full-stage timeout and two Webhook observers remain unresolved.

A separate real Chrome155 profile passed27 IndexedDB checks against actual
public HTTP/SQLite/WebSocket grant authority: no pre-Welcome DB open, physical
write/reopen, fresh-grant reconnect, FIFO quota, SHA/size corruption deletion,
other-tenant same-hash isolation/stale realm purge, actual HTTP revoke, paused
expiry and actual queued-write revocation. The Source is explicitly the Node
fixture; this is not a Native browser acceptance.

Both actual saved main and Worker renderers, real CanvasKit and existing SKP
passed cold render, cache-only missing-resource restore and corrupt-cache
keyframe recovery. A test-owned private relay omitted one33638-byte SKP packet
on each warm connection. Healthy cache needed no keyframe; corrupt cache
needed exactly one original full-keyframe request. Warm and recovered canvas
PNG hashes exactly matched cold on each path. Awaited explicit logout left
zero metadata rows and zero bodies, and no Worker. Screenshots retain ordinary
text/image/content and the black WebGL region labelled “WebGL 无法显示”. This
is a Viewer fixture proof, not a new Native WebGL-source acceptance.

The first actual-render runs failed the original new2500ms cache observer:
its body was not persisted. Bounded diagnostics showed an890ms cold render,
a failed Worker purge transaction and no memory-pressure failure. The300ms
storage transaction guard was unchanged. Awaiting initial authorization purge
before drawing and starting persistence after presentation resolved the
observed integration failure. Both original failures and diagnostics are kept.
The final conservative metadata charge adjustment was rerun through the27
browser checks, both rendering paths and both76-case contract suites.

C6 is now PARTIAL. Production Hello/Welcome offer negotiation and omission,
bounded miss/reset behavior through the real authenticated proxy, Native chunk/
manifest hydration, real renderer/version transitions and real reconnect first-
frame/downlink measurements remain open. The relay deliberately simulates a
missing payload; its omitted bytes are not production traffic savings and its
wall times are not a benchmark. Linux actual-browser, abrupt unload/failed
purge, compact/whole-process pressure and full Native/mild-loss gates remain
unqualified. No timeout/attempt/retention/memory-growth gate was relaxed.

The ledger is10 complete within listed scopes,19 partial,12 pending. Root1805,
the failed original eight-hour run and the full objective are not accepted.
Original Source inputs, canonical browser files and fixed Mac sampler were
read-only checked; the original full build continues with its original PID.
No C++/Source preparation or new full browser build occurred. No original
canonical browser/fixed sampler was executed this turn; historical copied-
sampler execution corrections remain applicable. Protected demo/old output
were not inspected. Only owned unused test networks were removed. Build caches,
unrelated peer edits and the32GiB disk floor are retained. No commit or push.


Follow-up actual settlement correction: [real-browser open/error/purge ownership proof](c6-persistent-settlement.md) reproduces and fixes early retirement of the original blocked open and transaction-error charges. The bounded purge observer retains actual admission until its terminal callback. Production offer/Native/performance gates remain open.
