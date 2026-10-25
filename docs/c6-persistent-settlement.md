# C6 IndexedDB settlement correction

The previous persistent-cache completion audit identified two untested actual-
work boundaries. A real Chrome/IndexedDB probe reproduced both against the
previous implementation. A blocked version upgrade kept the original open
request pending, but three consecutive authorization observations created
three opens with zero terminal events. A real duplicate-key ConstraintError
also produced this order: request error with four memory owners, owner release
to zero, then actual transaction abort. The original body survived rollback,
but the application had retired its actual-work admission/charges too early.

The corrected owner keeps the one noncancelable IDBOpenDBRequest until its
actual success/error. An observation timeout rejects the wait without clearing
that admission; later callers reuse the same bounded failed observation and
cannot enqueue another request. Late success closes the returned database.
Synchronous failure before allocating a request does not retain a phantom slot.

Transactions now record errors and request abort, but settle only at actual
onabort/oncomplete. A synchronous setup error follows the same terminal-event
path. The real error probe now reports request error with four owners, actual
abort still with four owners, then owner release to zero. It preserves the
original body, releases all charges after settlement and physically purges.

Purge observation also has a bounded wait for prior purge/open/transaction:
twice the configured stage guard,600ms in the Viewer. Its actual purge admission
remains held until terminal callback settlement, even when the observer has
already returned failure. Pending purges remain capped at eight; duplicates
share admission. Unconfirmed cleanup denies cache I/O while complete Source
frames can continue without cache assistance. Supported storage that fails
explicit logout still does not produce a successful disconnect acknowledgement.
The original300ms operation/open/transaction,5s Source ACK,120s unit-stage and
quota/memory limits were not increased.

A third real-IDB probe deliberately gates delivery of the actual abort callback
to its owner. The engine's abort event is captured; this is explicitly delayed
observation, not evidence of a hung engine. With a50ms stage guard the observer
returns failure at about101ms, the purge admission remains held, repeated same-
realm requests allocate no new purge, and cache reads remain denied. Releasing
the callback releases admission; a fresh confirmed purge then recovers. The
original failing traces and complete successful traces are retained.

The exact1311-file executed candidate passed the new real-browser settlement
probes, the previous27 actual storage/HTTP/SQLite/WS checks, both saved real
CanvasKit rendering paths and their cache/corruption/logout checks, and76/76
contracts on each of macOS and LinuxARM64 without skips. Linux contracts do
not execute a real IndexedDB browser. The rendering proof still uses a virtual
Node Source and a test relay omitting warm resources; it is not production
cache negotiation, Native or a first-frame/bandwidth benchmark. SDK sources
are byte-identical to the previous authority checkpoint; installed SDK/Python
suites were not rerun. Their old failures remain unresolved.

C6 remains partial. Production scoped offer/omission/miss negotiation, Native
chunk/manifest hydration, real renderer upgrades, abrupt-unload/failed-purge
policy and actual reconnect measurements still need acceptance. Root1805,
original eight-hour, full Native and mild-loss gates remain unqualified. The
ledger stays10 complete within scope,19 partial,12 pending.

The original full build remains on its original PID. Source108 inputs,
canonical19 browser files and fixed sampler identity/hash were checked read-
only. The original canonical browser and fixed sampler were not executed this
turn; historical copied-sampler corrections remain applicable. Source/C++ was
not prepared or mutated, protected demo/old output were not inspected, and no
new full browser build started. Only the verified-unused owned test network
was removed. Build caches, unrelated peer edits and32GiB floor are retained;
no commit or push was made.
