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


from remote_paint_session import (AgentObservation,AgentObservationContext,AgentObservationReference,
    AgentObservationInput,AgentObservationLimits,AgentSnapshotQuery,AgentLocateQuery,AgentElementQuery,AgentElementId)

async def observe(client: AgentClient, run: AgentObservationReference) -> None:
    context: AgentObservationContext = (await client.observations.context(run)).data
    result: AgentObservation = (await client.observations.read(context,AgentObservationInput(AgentSnapshotQuery(),AgentObservationLimits(max_chars=0)))).data
    selected = (await client.observations.read(context,AgentObservationInput(AgentLocateQuery('testId','status')))).data
    if selected.nodes:
        element_id: AgentElementId = selected.nodes[0].element_id
        await client.observations.read(context,AgentObservationInput(AgentElementQuery(element_id)))
    await client.observations.context(AgentRunReference(run.agent_run_id,run.session_id))  # type: ignore[arg-type]
    await client.observations.read(context,AgentObservationInput(AgentSnapshotQuery()),retries=1)  # type: ignore[call-arg]
    _ = context.fence  # type: ignore[attr-defined]
    context.document.page_epoch = 2  # type: ignore[misc]
    result.nodes[0].text = 'changed'  # type: ignore[misc]
    result.nodes.append(selected.nodes[0])  # type: ignore[attr-defined]
    _ = AgentLocateQuery('css','*')  # type: ignore[arg-type]
    _ = AgentElementQuery(run.agent_run_id)  # type: ignore[arg-type]
    await client.invocations.create(context,{'tool':'insertText','params':{'text':'private'}},idempotency_key='key')  # type: ignore[arg-type]

from remote_paint_session import (AgentAccessibilityInput,AgentAccessibilityLimits,AgentAccessibilityObservation,
    AgentAccessibilityProjection,AgentAccessibilityVisible,AgentAccessibilityRedacted)

async def accessibility(client: AgentClient, context: AgentObservationContext, element: AgentElementId) -> None:
    observed: AgentAccessibilityObservation = (await client.observations.accessibility(context,AgentAccessibilityInput(element,AgentAccessibilityLimits(512)))).data
    if observed.redacted:
        redacted: AgentAccessibilityRedacted = observed
        masked: None = observed.ax
        _ = (redacted,masked)
    else:
        visible: AgentAccessibilityVisible = observed
        ax: AgentAccessibilityProjection = observed.ax
        checked: bool | str | None = ax.states.checked
        _ = (visible,checked)
        ax.states.readonly = True  # type: ignore[misc]
    observed.limits.max_chars = 1  # type: ignore[misc]
    await client.observations.accessibility(context,AgentAccessibilityInput(context.agent_run_id))  # type: ignore[arg-type]
    await client.observations.accessibility(context,AgentAccessibilityInput(element),retries=1)  # type: ignore[call-arg]
    _ = observed.ax.backend_node_id  # type: ignore[union-attr]

from remote_paint_session import (AgentScreenshotId,AgentScreenshotInput,AgentScreenshotLimits,AgentScreenshotFileInput,
    AgentScreenshotChunkInput,AgentScreenshotDownloadInput,AgentScreenshotObservation,AgentScreenshotChunk,AgentScreenshotDownload)

async def screenshots(client: AgentClient, context: AgentObservationContext) -> None:
    shot: AgentScreenshotObservation = (await client.observations.screenshot(context,AgentScreenshotInput(AgentScreenshotLimits(1048576)))).data
    screenshot_id: AgentScreenshotId = shot.screenshot_id
    chunk: AgentScreenshotChunk = (await client.observations.screenshot_chunk(context,AgentScreenshotChunkInput(screenshot_id,0))).data
    file: AgentScreenshotDownload = (await client.observations.download_screenshot(context,AgentScreenshotDownloadInput(screenshot_id,shot.sha256,shot.byte_length,shot.observed_at))).data
    content: bytes = file.content
    _ = (chunk,content)
    await client.observations.release_screenshot(context,AgentScreenshotFileInput(screenshot_id))
    _ = AgentScreenshotFileInput(context.agent_run_id)  # type: ignore[arg-type]
    await client.observations.screenshot(context,retries=1)  # type: ignore[call-arg]
    file.sha256 = 'changed'  # type: ignore[misc]
    file.content[0] = 1  # type: ignore[index]


from remote_paint_session import (AgentDownloadId,AgentDownloadArmInput,AgentDownloadLimits,AgentDownloadTicketInput,
    AgentDownloadChunkInput,AgentDownloadFileInput,AgentDownloadArmed,AgentDownloadInfo,AgentDownloadReady,AgentDownloadFile,AgentDownloadChunk)

async def downloads(client: AgentClient, context: AgentObservationContext) -> None:
    armed: AgentDownloadArmed = (await client.observations.arm_download(context,AgentDownloadArmInput(AgentDownloadLimits(1048576,10000)))).data
    download_id: AgentDownloadId = armed.download_id
    info: AgentDownloadInfo = (await client.observations.download_info(context,AgentDownloadTicketInput(download_id))).data
    if isinstance(info,AgentDownloadReady):
        file: AgentDownloadFile = (await client.observations.download_file(context,AgentDownloadFileInput(download_id,info.sha256,info.byte_length,info.completed_at))).data
        content: bytes = file.content
        file.content[0] = 1  # type: ignore[index]
        file.sha256 = 'changed'  # type: ignore[misc]
        _ = content
    else:
        _ = info.byte_length  # type: ignore[attr-defined]
    part: AgentDownloadChunk = (await client.observations.download_chunk(context,AgentDownloadChunkInput(download_id,0))).data
    await client.observations.release_download(context,AgentDownloadTicketInput(download_id))
    _ = part
    _ = AgentDownloadTicketInput(context.agent_run_id)  # type: ignore[arg-type]
    await client.observations.arm_download(context,retries=1)  # type: ignore[call-arg]
