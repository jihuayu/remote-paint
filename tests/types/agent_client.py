from remote_paint_session import (AgentClient,AgentRunId,AgentInvocationId,SessionId,CreateAgentRunInput,
    AgentRunReference,AgentAction,ScrollAction,AgentContext,AgentClientError,AgentClientCancelledError)

async def use(client: AgentClient) -> None:
    created = await client.runs.prepare_create(SessionId('ses_example'),CreateAgentRunInput('test','version'),idempotency_key='run').send()
    run_id: AgentRunId = created.data.agent_run_id
    context: AgentContext = (await client.runs.context(created.data)).data
    action: AgentAction = {'tool':'scroll','params':{'x':1,'y':2,'delta_x':0,'delta_y':80}}
    prepared = client.invocations.prepare_create(context,action,idempotency_key='action')
    result = await prepared.send(retries=1)
    invocation_id: AgentInvocationId = result.data.invocation_id
    if result.data.receipt is not None:
        stage: str = result.data.receipt.stage
        _ = stage
    await client.runs.get(run_id)
    await client.invocations.get(invocation_id)
    await client.runs.end(run_id)
    await client.runs.create(SessionId('ses_example'),CreateAgentRunInput('test','v1'))  # type: ignore[call-arg]
    await client.runs.context(AgentRunReference(run_id))  # type: ignore[call-arg]
    await client.invocations.get(run_id)  # type: ignore[arg-type]
    await client.runs.end(invocation_id)  # type: ignore[arg-type]
    bad: AgentAction = {'tool':'Runtime.evaluate','params':{'expression':'private'}}  # type: ignore[assignment,misc]
    bad2: ScrollAction = {'tool':'scroll','params':{'text':'private'}}  # type: ignore[typeddict-item]
    context.fence.control_version = 2  # type: ignore[misc]
    await prepared.send(idempotency_key='replacement')  # type: ignore[call-arg]
    _ = result.data.business_success  # type: ignore[attr-defined]
    _ = (bad,bad2)
    try:
        await prepared.send()
    except AgentClientError as error:
        code: str = error.code
        _ = code
    except AgentClientCancelledError as cancelled:
        outcome: str = cancelled.outcome
        _ = outcome
