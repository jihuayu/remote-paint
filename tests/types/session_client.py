from remote_paint_session import (SessionClient, CreateSessionInput, SessionId, OperationId, SessionClientError)

async def use(client: SessionClient) -> None:
    prepared = client.sessions.prepare_create(CreateSessionInput(ttl_seconds=60), idempotency_key='saved-job-key')
    created = await prepared.send(retries=1)
    session_id: SessionId = created.data.session_id
    operation_id: OperationId = created.data.operation_id
    current = await client.sessions.get(session_id)
    status = await client.operations.get(operation_id)
    if status.data.error is not None:
        message: str = status.data.error.message
        _ = message
    await client.sessions.release(session_id)
    await client.sessions.create()  # type: ignore[call-arg]
    await client.sessions.get(operation_id)  # type: ignore[arg-type]
    await client.operations.get(session_id)  # type: ignore[arg-type]
    current.data.state = 'closed'  # type: ignore[misc]
    await prepared.send(idempotency_key='replacement')  # type: ignore[call-arg]
    await prepared.send(retries=4)  # type: ignore[arg-type]
    CreateSessionInput(tenant_id='other')  # type: ignore[call-arg]
    try:
        await prepared.send()
    except SessionClientError as error:
        outcome: str = error.outcome
        _ = outcome
