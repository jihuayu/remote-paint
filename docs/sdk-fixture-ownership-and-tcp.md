# Fixture retirement and real TCP pressure checkpoint

Four actual Node-backed Python fixture families now initialize their client list and register
cleanup immediately after spawning, before the original three-second startup observation.
Cleanup joins the real process even if client close fails. A graceful deadline still fails;
forced reap does not manufacture a successful graceful shutdown. Three new real-process
cases cover invalid startup data, client cleanup failure and forced reap. The separate
ownership checkpoint passed 22 macOS cases before the next task began.

An additional real TCP case withholds the final request-header blank line from the existing
50ms server. Node returns a raw 408 without JSON Content-Type before dispatch; the SDK
reports `CLIENT_HTTP_ERROR`, status 408, retryable, outcome unknown. Source calls and Run
state remain identical. This proves the mechanism, not the cause of earlier responses whose
status/headers were not captured. Observation failures now retain a status note for diagnosis.

## Physical backpressure

The original screenshot/download tests keep 4MiB limits, 3072-byte public chunks, a 2500ms
HTTP deadline, the three-second observer, the before-EOF assertion, ordinary-capacity 503,
and independent end/closed-Run assertions. A test-only Python TCP receiver now stops reading
after headers on an explicitly bounded socket. A one-shot child configures only the accepted
test socket's send buffer through a duplicated fd, and retires before the request starts.
Actual buffer values are checked; on macOS the measured send/receive sizes are 65536/16384.
The parent stream's reading state and nonblocking flag are restored after child setup.
No global socket/kernel tuning or production service change is made.

Initial candidates exposed Darwin connect/read autotuning, a masked early-cleanup error,
and inherited stream state/descriptor flags. Their failures and the stalled diagnostic are
retained. The isolated protocol failed with raw 408/paused reading before the restoration
and then returned 200 with the complete 17-byte request. Those diagnostics are not runtime
qualification. Pending download readiness polling now yields 10ms between HTTP observations,
keeping every 200/ready assertion and the original three-second deadline while reducing
observer contention with the real file reader. Production capture/read code is unchanged.

Both complete test files passed 54 cases on each platform, including the two previous TCP
failures. Measured macOS chunk counts stopped at 197 before end, versus 1366/1268 total.
Linux actual buffer and chunk observations are retained in its TAP log. Socket setup and
private fixtures do not prove original browser/Native adapter behavior.

## Remaining failures

macOS isolated installed packages passed Node 214/Python 210, strict TypeScript, mypy and
the exact README examples. Linux installed Node 214 passed; Python 210 completed with one
existing download-response error (209 passed). The earlier two failures did not reproduce
in that run, but their causes are not declared fixed. SDK bytes are identical to the prior
package checkpoint. All prior Python case names remain; four cases were added.

The expanded Linux root run used the original four-file concurrency and 120-second guard.
It timed out before a complete 1794-case result, with five observed failures: stalled-response attempt/receiver count, automatic retained-prefix
gap, public capture saturation, finite stderr lifetime, and the original startup deadline. The two-file 54-case passes do not replace this failed full gate. Its 154 other
root test files are byte-identical; the two modified files keep all original case names.

Full Source gap reconciliation, original Native/mild-loss and the failed eight-hour gate
remain incomplete. The 41-item ledger stays 10 complete within scope /18 partial /13 pending.
The original live full-browser build, caches, protected browser and sampler are retained;
read-only hashes are not execution-history proof. No commit/push was made.

See [machine evidence](evidence/sdk-fixture-pressure.json), the
[Node fd-duplication API](https://nodejs.org/api/child_process.html#optionsstdio), and
[Python socket options](https://docs.python.org/3/library/socket.html#socket.socket.setsockopt).
