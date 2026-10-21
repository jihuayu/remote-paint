# Agent Webhook receiver checkpoints

The private `parseAgentEventBody` contract validates bounded JSON metadata without a Source database. The Source event journal uses the same validator and retains its separate database checks for parent run/tenant/session, invocation ownership, immutable tool, state history and original creation times. Projection validity alone does not authenticate a sender, verify closure evidence or establish business success.

The receiver must authenticate the original raw bytes before accepting a strict `agent-webhook-v1` envelope. Its separate persistent inbox must commit acceptance before returning an `agent-webhook-ack-v1`. An identical event ID and body can receive the same acknowledgment after restart; conflicting bytes must fail. Retention capacity must fail closed rather than silently evict deduplication identities.

Only shared projection validation is implemented in this checkpoint. The authenticated persistent inbox, actual lost-ACK/restart tests, public management and Node/Python SDK integration remain pending. The original Native end-to-end and eight-hour acceptance are unchanged.
