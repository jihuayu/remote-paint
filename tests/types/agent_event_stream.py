"""Public async iterator/context lifecycle and distinct cursor typing."""
from typing import AsyncIterator
from remote_paint_session import (AgentClient,AgentRunId,AgentEventCursor,
    AgentCancellationCursor,AgentEventMessage,AgentEventStream,AgentEventTransportStatus,
    AgentClientCancelledError)

async def consume(client: AgentClient,run: AgentRunId,after: AgentEventCursor,
                  cancellation: AgentCancellationCursor) -> AgentEventCursor:
    stream: AgentEventStream=client.runs.events(run,after=after,reconnects=3)
    iterator: AsyncIterator[AgentEventMessage]=stream
    status: AgentEventTransportStatus=client.event_transport_status()
    slots: int=status.streams
    status.streams=slots  # type: ignore[misc]
    client.runs.events(run,after=cancellation)  # type: ignore[arg-type]
    client.runs.events(run,reconnects=4)  # type: ignore[arg-type]
    client.runs.events(run,after='untyped')  # type: ignore[arg-type]
    try:
        async with stream as reader:
            async for message in reader:
                if message.kind=='event':
                    after=message.cursor
                elif message.kind=='checkpoint':
                    print(message.data.reason)
    except AgentClientCancelledError as error:
        observed: AgentEventCursor | None=error.cursor
        print(observed)
        raise
    await iterator.aclose()  # type: ignore[attr-defined]
    await stream.aclose()
    return after
