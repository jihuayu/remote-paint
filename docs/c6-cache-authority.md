# C6 cache authority checkpoint

The authenticated Viewer proxy now issues an opaque HMAC cache namespace only
in the public Welcome after its existing tenant, session, Ready/version, role
and Origin checks. It binds the trusted tenant/session identity, Ready version
and incarnation, role and audience, under a fresh per-authority secret. The
same realm survives a normal grant refresh; different tenants, sessions, roles,
audiences, versions/incarnations and replacement authorities get different
realms. A caller-provided Hello namespace cannot choose this authority. The
HTTP ticket DTO remains unchanged, preserving strict Node/Python consumers.

ViewerConnection exposes an immutable resourceCachePermission only after a
matching, valid Welcome with a validated renderer version and SHA-256. It
signals authorized, suspended and revoked states. Pause/transient loss removes
active permission; its original grant expiry still revokes the retained realm.
Explicit terminal close, expiry and destroy signal revocation. Reentrant
callbacks cannot revive a destroyed connection or create a new ticket request.
Legacy Welcome without cache metadata remains usable with no cache permission.
No management credential or raw ticket is part of this permission object.

This phase adds authority and lifecycle signals only. No IndexedDB read/write,
resource offer/miss suppression, private-byte erasure, quota enforcement or
first-frame savings is implemented or accepted yet. A callback is not proof
that persisted bytes were deleted. Per-entry renderer binding and fresh frame
membership, fenced asynchronous storage, corruption/miss recovery, eviction,
logout/revocation purges, both render paths and real-browser measurements remain
required before C6 can pass.

The three complete authority/connection files passed 33/33 on macOS and Linux,
with no skips. Eight new cases exercise actual HTTP, SQLite and public/private
WebSocket plumbing against the existing virtual Node Source. Ready replacement
uses a trusted registry snapshot override; this is not a Native upgrade test.
The fresh Node archive was packed and actually installed in a source-free SDK
consumer: 222/222 passed, and six strict TypeScript groups passed. Installed SDK
bytes and adapted fixture closure were checked against the exact candidate.
The unchanged Python wheel was inspected, but Python runtime tests were not
rerun. The earlier full210 timeout and two old Webhook observer timeouts remain
unresolved; this subset does not qualify root1805 or aggregate CI.

No Chromium/C++ inputs were changed and no new full build was started. The
original October20 build remains live with its original PID2967239. Read-only
checks matched108 Source inputs,19 canonical browser files and the fixed Mac
sampler device/inode/hash. These hashes do not prove historical execution; the
historical copied-sampler correction remains applicable. The canonical browser
and fixed sampler were not executed by this goal turn. The forbidden old output
and protected demo were not inspected. The original32GiB floor and caches stay
intact. Only this phase's verified-unused internal test network was removed.

The41-item ledger remains10 complete within scope,18 partial,13 pending.
C6, the failed original eight-hour gate, Native and mild-loss acceptance remain
unqualified. No commit or push was made; unrelated peer edits are excluded from
review artifacts, which carry the sanitized baseline peer blob.
