"""Installed public finite-event API typing, including deliberate negative checks."""
from typing import Literal
from remote_paint_session import (AgentClient,AgentClientError,AgentRunId,AgentEventCursor,
    AgentCancellationCursor,AgentEventPage,AgentEvent,AgentRunEvent,AgentInvocationEvent,
    AgentCancellation,AgentCancellationInvocation,AgentEventGap)

async def consume(client: AgentClient,run: AgentRunId,cursor: AgentEventCursor,anchor: AgentCancellationCursor) -> None:
    page: AgentEventPage=(await client.runs.event_page(run,after=cursor,retries=0)).data
    rows: tuple[AgentEvent,...]=page.events
    next_cursor: AgentEventCursor=page.next_cursor
    for row in rows:
        if isinstance(row,AgentRunEvent):
            state: str=row.data.state
            evidence: str | None=row.data.close_evidence_kind
            print(state,evidence)
        elif isinstance(row,AgentInvocationEvent):
            invocation_id: str=row.data.invocation_id
            print(invocation_id,row.data.receipt)
    cancelled: AgentCancellation=(await client.runs.cancel(run)).data
    reported: AgentCancellation=(await client.runs.cancellation(run,after=anchor)).data
    rollback: Literal[False]=cancelled.rollback_performed
    business: Literal[False]=reported.business_success_confirmed
    invocations: tuple[AgentCancellationInvocation,...]=reported.invocations
    print(next_cursor,rollback,business,invocations)
    # Event/cancellation cursors and logical Run IDs remain different NewTypes.
    await client.runs.event_page(run,after=anchor)  # type: ignore[arg-type]
    await client.runs.cancellation(run,after=cursor)  # type: ignore[arg-type]
    await client.runs.cancel(run,after=anchor)  # type: ignore[call-arg]
    await client.runs.event_page(cursor)  # type: ignore[arg-type]
    page.events.append(page.events[0])  # type: ignore[attr-defined]
    reported.work.ordinary_pending=False  # type: ignore[misc]
    cancelled.business_success_confirmed=True  # type: ignore[misc,assignment]
    try:
        await client.runs.event_page(run)
    except AgentClientError as error:
        gap: AgentEventGap | None=error.details
        if gap is not None:
            missing: Literal[True]=gap.missing_history
            print(missing,gap.oldest_cursor)
            gap.after=cursor  # type: ignore[misc]

from remote_paint_session import (AgentWebhookEndpointId,AgentWebhookSubscriptionId,
    AgentWebhookSubscribeInput,AgentWebhookEndpoints,AgentWebhookSubscription)
async def webhooks(client: AgentClient,run: AgentRunId,event: AgentEventCursor,endpoint: AgentWebhookEndpointId,sub: AgentWebhookSubscriptionId) -> None:
    profiles: AgentWebhookEndpoints=(await client.runs.webhook_endpoints(run)).data
    subscribed: AgentWebhookSubscription=(await client.runs.subscribe_webhook(run,AgentWebhookSubscribeInput(endpoint,event))).data
    status: AgentWebhookSubscription=(await client.runs.webhook_subscription(run,sub,retries=0)).data
    accepted: AgentEventCursor=status.accepted_through
    await client.runs.webhook_subscription(run,endpoint)  # type: ignore[arg-type]
    AgentWebhookSubscribeInput(endpoint,AgentCancellationCursor('invalid'))  # type: ignore[arg-type]
    AgentWebhookSubscribeInput(sub,event)  # type: ignore[arg-type]
    AgentWebhookSubscribeInput(endpoint,event,url='https://receiver.test')  # type: ignore[call-arg]
    profiles.endpoints.append(profiles.endpoints[0])  # type: ignore[attr-defined]
    subscribed.accepted_through=accepted  # type: ignore[misc]
