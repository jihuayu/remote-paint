# Bounded canonical-envelope reuse

The modern Webhook journal now keeps at most 64 pure encodings/digests of
freshly validated, deeply frozen Source events, across all subscribers in that
journal. A hit still requires the same immutable object and current endpoint;
the subscription ID is part of the key. Every operation still reads and checks
the actual database rows, Source window, current invocation parents, tenant/
session affinity, cursor, attempt IDs/counts/outcomes and original ACK. No
authorization proof is cached. Old prefixes evicted from Source still get
independent parsing, canonical/hash and parent checks. Five fixed ID regexes
are compiled once instead of allocating one for each checked row.

The canonical text payload is capped at 64 times 4096 UTF-8 bytes (256 KiB).
This is not a total JS heap bound: keys, JS string representation, objects and
retained immutable Source references add overhead. The new cache does not
complete C5 or replace its whole-process accounting and failed eight-hour gate.

The added warm-cache corruption case changes fresh Source bytes while keeping
the event ID, changes captured bytes and recomputes their hash, changes only
the hash, and changes endpoint routing. All are rejected; subsequent valid
reads remain unchanged. Existing fresh-parent and old-prefix tests still run.
macOS five files: 101/103; Linux six files: 126/128. Both failures are the same
original three-second retained-prefix/public-saturation observers. No timeout,
retention, attempt, transport-settlement or Source-effect requirement changed.

Six counterbalanced Node22.23.1 diagnostic runs (before/after/after/before/
before/after) each perform 500 real SQLite reads of the same 64-row saturated
queue shape, with unchanged result and revision. CPU medians are 1457.625ms
before and 1215.652ms after (about 16.6% lower); wall medians are 3730.315ms
and 3285.114ms. This isolates repeated-read cost; it does not prove an HTTPS
drain, first-frame, p95 or production throughput improvement. No GC was forced.

The installed Linux consumer was refreshed with exactly the two changed backend
modules and the earlier bounded download-response observer. Every other copied
fixture hash matches its previous source/import-adaptation receipt, all installed
SDK files match the candidate, and sdk/ fallback is absent. Node214/214 passed.
Python reached its original120s guard before a complete210-case report, with
four observed ERROR labels whose final traceback was not reached. The exact
README Python snippet first reached its original10s subprocess limit. These
failed runs are retained and neither Python nor aggregate CI is qualified.

A separate four-case diagnostic adds immediate bounded error metadata and a
header-only observer without changing pools, retries or timeouts; all four
passed, so the earlier causes remain unproven. The unchanged README verifier
then passed both exact snippets against the current backend: one subscription,
three original durable inbox events, no Source actions. This is component
evidence, not a replacement for the failed complete Python stage. Types were
not rerun because SDK declarations and package bytes are unchanged.

C6 remains pending. The inspected Viewer path contains only an in-memory
AssetCache; the authenticated proxy allowlists Hello/Welcome and has no durable
cache realm, scoped cache-offer/miss contract or private persistence purge
lifecycle. The next-gates audit preserves the complete C6 requirement: bind
account/tenant and renderer authority, implement actual bounded IndexedDB,
wire both rendering paths and real transport, then verify real-browser
reconnect/first-frame and account/revocation/corruption/eviction/version cases.
The audit is not an implementation or C6 acceptance.

The41-item ledger remains10 complete within their scopes/18 partial/13 pending.
The original eight-hour, full Native and mild-loss gates are still unqualified.
The original build remains live with its original PID;108 Source inputs,19
original browser files and fixed Mac sampler identity were checked read-only.
No original browser or sampler was run, no Source prepared or protected output/
demo inspected in this checkpoint. Only the unused owned internal test network
was removed. Source/build caches and unrelated peer edits are retained; no
commit or push was made.
