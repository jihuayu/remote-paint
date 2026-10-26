# Webhook event-window checkpoint

The internal event window now reuses its once-parsed projections and returns
recursively frozen values after every fresh database affinity and parent check.
Legacy capture and public event reads still return detached mutable copies.
The modern Webhook journal compares each retained delivery with the complete
canonical envelope rebuilt from that freshly validated Source event. This
preserves schema/routing/identity/byte equality while avoiding a second parse
and repeated serialization. Evicted prefixes retain their independent parse
and parent checks. No cross-operation authorization proof is cached.

The first checkpoint passed all 57 event/schema/capture cases on each platform.
The second adds corruption coverage for recomputed hashes with foreign routing,
extra fields, reordered keys and whitespace, for both retained and evicted
events. Current macOS five-file results are 100/102; Linux six-file results are
125/127, including the complete 25-case dispatcher file. Both still fail the
original 3-second automatic-prefix and public-capture-saturation observers.
No timeouts, retention, attempt limits, Source effects or acceptance semantics
were relaxed. These are component results, not a full regression pass.

A separate controlled attempt diagnostic proves eight durable begun/settled
attempts can produce seven actual HTTPS requests: the first begin consumes
90ms against the original absolute 75ms deadline before request construction.
The corrected test checks all original durable IDs, unknown outcomes and
settled TCP resources, plus positive actual I/O and no ninth attempt. Other
default-budget tests still require eight received requests.

Header-only Python diagnostics retain at most eight status/content-type/
content-encoding/operation rows, without body, credentials or query data. The
installed Linux Python suite passed 210 cases before these production window
changes. The earlier malformed download response was not reproduced, so its
cause remains unproven; this earlier run does not qualify the new backend.

The post-change CPU/call diagnostic failed its unchanged 3-second observer:
39/64 requests had arrived after about 3.26 seconds, driver unfaulted, with
about 1.92 seconds accumulated in Store methods. GC and event-window work
remain prominent. Profiling and method instrumentation are diagnostic only;
they do not establish a unique bottleneck or a cross-run performance gain.

Preserved failures include the first immutable-window fixture's exclusive
SQLite lock conflict (fixed by closing its Store before opening a read-only
connection), earlier observer failures, the seven-file Linux 120s termination,
and the outer coordinator timeout while that same container remained live.
No container was restarted on an observation timeout. The full 1794-case run
previously timed out with five observed failures; the two added journal cases
bring the current expected root count to 1796, which has not passed in full.
Original stderr/startup failures remain outside this six-file result.

The 41-item ledger remains 10 complete within their documented scopes,
18 partial and 13 pending. The original eight-hour secondary-Viewer growth
failure, full Native runtime and mild-loss acceptance remain unresolved.
The original build, 108 source inputs, 19 original browser files and the fixed
Mac sampler identity were checked read-only. No original browser/sampler was
executed, no Source was prepared, and no protected output/demo was inspected
in this checkpoint. Source and build caches are retained; unrelated peer
changes are excluded. No commit or push was made.
