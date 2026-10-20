"""Frozen public SSE message typing; actual network iterator is a separate gate."""
from remote_paint_session import (AgentEventMessage,AgentEventItem,AgentReadyMessage,
    AgentHeartbeatMessage,AgentCheckpointMessage,AgentClientError,AgentEventCursor,AgentRunEvent)

def handle(message: AgentEventMessage,error: AgentClientError) -> AgentEventCursor:
    cursor: AgentEventCursor=message.cursor
    if message.kind=='event':
        item: AgentEventItem=message
        if isinstance(item.event,AgentRunEvent):
            writer: bool=item.event.data.holds_writer
            print(writer)
        print(item.event.event_id,item.event.sequence)
        item.data  # type: ignore[attr-defined]
    elif message.kind=='ready':
        ready: AgentReadyMessage=message
        previous: AgentEventCursor=ready.data.after
        print(previous,ready.data.history_origin)
        ready.event  # type: ignore[attr-defined]
        ready.data.history_origin='invented'  # type: ignore[misc,assignment]
    elif message.kind=='heartbeat':
        heartbeat: AgentHeartbeatMessage=message
        print(heartbeat.data.observed_at)
    elif message.kind=='checkpoint':
        checkpoint: AgentCheckpointMessage=message
        reason: str=checkpoint.data.reason
        print(reason)
    observed: AgentEventCursor | None=error.cursor
    print(observed)
    message.cursor=cursor  # type: ignore[misc]
    return cursor
