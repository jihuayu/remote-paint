# C6 actual proxy cache negotiation

The saved public main-thread and Worker Viewers now advertise a public-only
cache capability. The authenticated proxy removes it before forwarding Hello
to the existing private Source. After its fresh public Welcome, it waits up to
250ms for one strict offer bound to the server-derived tenant/session/Ready/
version/incarnation/role/audience namespace and actual Source renderer. The
client queries only bounded IndexedDB metadata under the exact live permission;
it does not read private bodies to build this list. Its150ms metadata observer
falls back to an empty offer. Legacy peers keep their previous path.

Offers contain at most128 typed chunk/SKP hashes within the existing32KiB
inbound metadata limit. Repeated/early/unnegotiated, foreign-scope, wrong-
renderer and malformed offers are refused. A valid first offer arriving after
the wait has expired is validated but cannot activate omission. No caller-
chosen namespace or content hash substitutes for current server authority.
The existing HTTP ticket DTO and SDK package bytes remain unchanged.

While waiting, the private WebSocket is paused. Already parsed resource and
scene packets remain in an ordered bounded queue: at most512 records, charged
by retained backing length plus metadata against existing per-link/global
limits. Queue pressure falls back to full delivery, subject to those original
limits. The omission index is separately charged512 bytes per entry. Closing,
expiry or revocation clears the cache state. The Source still constructs and
sends its original resources; only the actual public proxy can omit matching
typed packets on the downstream leg.

Both renderer paths restore only current validated scene/manifest dependencies.
They can hydrate missing manifest blocks from separately verified persistent
chunks, then retain the original complete-SKP checksum and frame barrier. Any
RequestKeyframe clears all proxy omissions before being forwarded. Existing
Rust Gateway source was read-only audited: its recovery branch clears known
resources, known chunks and chunk bytes. This is code evidence, not a newly
executed Native runtime qualification. No C++ or Rust source was changed.

Metadata queries and returned offers/buffers use the existing actual-work
admission and memory ledger. Cancellation/reentrant suspension cannot leak a
verified result that was never delivered to its caller. One charged client
sender remains held until actual browser bufferedAmount drain or close; later
connections fall back rather than adding an unbounded send queue. Chunk-
hydration metadata is bounded and charged. Original300ms storage operations,
5s Source ACK,120s unit stages and memory/quota limits remain unchanged.

The exact1316-file candidate passed85/85 contracts on each of macOS and
LinuxARM64 with no skips. Nine new cases cover actual HTTP/SQLite/public/private
WebSockets: legacy delivery, actual SKP omission, strict DTO/scope, timeout and
late offers, duplicate/early offers, keyframe resend, revoke while waiting or
accepted, index-budget enforcement and chunk/SKP type separation. Thirty-two
real-browser storage checks include metadata offers, reentrant undelivered-
result cleanup and reconstruction of an existing SKP from persisted chunks.
The prior actual blocked-open/error/late-terminal probes passed unchanged.
Linux contracts do not run a real IndexedDB browser.

A new real-CanvasKit verifier uses the actual public proxy and existing Node
Source transport, with no packet-omitting relay. On both main and Worker paths,
Source counters prove one original SKP was sent in cold and warm connections.
The warm Viewer receives no binary resource and its downstream count is exactly
33638 bytes smaller:33594 payload bytes plus44 protocol bytes. The canvas PNG
matches cold exactly. A same-size corrupted persisted body produces one full
keyframe request; Source then sends a second resource, the actual proxy allows
it through, and the recovered canvas again matches cold. Awaited logout leaves
zero metadata/body rows and no Worker. Current PNG hashes also match the
previously inspected ordinary text/images and black WebGL label.

This is exact traffic evidence for the fixed local fixture. It is not a claim
of general production savings, Source CPU savings or a Native benchmark. The
same-process Node observation times include driver/presentation observation
and only one cold/warm sample per path; they do not qualify first-frame
performance. SDK sources are unchanged, so installed SDK/Python suites were
not rerun. Root1814 and older Webhook/Python failures remain unresolved.

C6 stays partial. Full512-entry/64MiB pressure, actual Native chunk transport,
real renderer/version transitions, abrupt unload/failed-purge policy and proper
reconnect first-frame measurements still need acceptance. In particular,
per-row metadata cursor cost at full capacity has not been measured against
the150/300ms guards; collect real evidence before changing queries or limits.
The41-item ledger remains10 complete within scope,19 partial,12 pending.
Original eight-hour, full Native and mild-loss acceptance remain unqualified.

The original full browser build continues with its original PID;108 Source
inputs,19 canonical browser files and the fixed sampler identity/hash were
read-only verified. Neither original canonical browser nor fixed sampler was
executed this turn; historical copied-sampler corrections remain applicable.
Source/C++ was not prepared or mutated, protected demo/old output were not
inspected, and no new full browser build began. Only the verified-unused owned
test network was removed. Build caches, unrelated peer edits and32GiB floor
remain intact. No commit or push was made.
