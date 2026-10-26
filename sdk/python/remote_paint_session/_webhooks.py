"""Frozen fixed-endpoint subscription metadata, using the ordinary HTTP pool."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Coroutine, Literal, NewType, cast
import httpx
from ._agent import AgentRunId, _exact, _fail, _id as _agent_id, _invalid
from ._client import SessionId, _integer
from ._events import AgentEventId, AgentEventCursor, event_sequence
from ._transport import ApiResult, BackendTransport, RetryCount

def _id(value: Any, prefix: str) -> bool:
    return type(value) is str and len(value)==len(prefix)+36 and _agent_id(value,prefix)

AgentWebhookEndpointId = NewType('AgentWebhookEndpointId', str)
AgentWebhookSubscriptionId = NewType('AgentWebhookSubscriptionId', str)
AgentWebhookOutcome = Literal['requested','unknown','not-accepted']

@dataclass(frozen=True, slots=True)
class AgentWebhookEndpoint:
    endpoint_id: AgentWebhookEndpointId
    available: bool
@dataclass(frozen=True, slots=True)
class AgentWebhookEndpoints:
    agent_run_id: AgentRunId
    endpoints: tuple[AgentWebhookEndpoint,...]
    schema: Literal['agent-webhook-endpoints-v1'] = field(default='agent-webhook-endpoints-v1',init=False)
@dataclass(frozen=True, slots=True)
class AgentWebhookSubscribeInput:
    endpoint_id: AgentWebhookEndpointId
    after: AgentEventCursor
@dataclass(frozen=True, slots=True)
class AgentWebhookHead:
    event_id: AgentEventId
    sequence: int
    attempts: int
    last_outcome: AgentWebhookOutcome | None
    cursor: AgentEventCursor
@dataclass(frozen=True, slots=True)
class AgentWebhookSubscription:
    """Only (after, accepted_through] is receiver-accepted; no business success claim."""
    subscription_id: AgentWebhookSubscriptionId
    agent_run_id: AgentRunId
    session_id: SessionId
    endpoint_id: AgentWebhookEndpointId
    after: AgentEventCursor
    accepted_through: AgentEventCursor
    queued_through: AgentEventCursor
    observed_latest: AgentEventCursor
    pending: int
    reconciliation_required: bool
    missing_from: AgentEventCursor | None
    missing_through: AgentEventCursor | None
    head: AgentWebhookHead | None
    schema: Literal['agent-webhook-subscription-v1'] = field(default='agent-webhook-subscription-v1',init=False)
@dataclass(frozen=True, slots=True)
class WebhookExpected:
    kind: Literal['webhook-endpoints','webhook-subscribe','webhook-subscription']
    id: AgentRunId
    subscription_id: AgentWebhookSubscriptionId | None = None
    endpoint_id: AgentWebhookEndpointId | None = None
    after: AgentEventCursor | None = None

def validate_webhook_reply(status: int, v: Any, e: WebhookExpected, headers: httpx.Headers) -> AgentWebhookEndpoints | AgentWebhookSubscription:
    if status!=200 or type(v) is not dict or v.get('agentRunId')!=e.id:
        _fail()
    if e.kind=='webhook-endpoints':
        if not _exact(v,['schema','agentRunId','endpoints']) or v['schema']!='agent-webhook-endpoints-v1' or type(v['endpoints']) is not list or len(v['endpoints'])>4:
            _fail()
        rows=v['endpoints']
        for i,row in enumerate(rows):
            if not _exact(row,['endpointId','available']) or not _id(row['endpointId'],'awh_') or type(row['available']) is not bool or i>0 and rows[i-1]['endpointId']>=row['endpointId']:
                _fail()
        return AgentWebhookEndpoints(e.id,tuple(AgentWebhookEndpoint(AgentWebhookEndpointId(row['endpointId']),row['available']) for row in rows))
    if not _exact(v,['schema','subscriptionId','agentRunId','sessionId','endpointId','after','acceptedThrough','queuedThrough','observedLatest','pending','reconciliationRequired','missingFrom','missingThrough','head']) or v['schema']!='agent-webhook-subscription-v1' or not _id(v['subscriptionId'],'awsub_') or not _id(v['sessionId'],'ses_') or not _id(v['endpointId'],'awh_') or not _integer(v['pending'],0,64) or type(v['reconciliationRequired']) is not bool:
        _fail()
    if e.kind=='webhook-subscribe':
        if v['endpointId']!=e.endpoint_id or v['after']!=e.after or headers.get('location')!='/v1/agent-runs/'+e.id+'/webhook-subscriptions/'+v['subscriptionId']:
            _fail()
    elif v['subscriptionId']!=e.subscription_id:
        _fail()
    after,accepted,queued,latest=(event_sequence(v[key],e.id) for key in ['after','acceptedThrough','queuedThrough','observedLatest'])
    if after is None or accepted is None or queued is None or latest is None or after>accepted or accepted>queued or queued>latest or v['pending']!=queued-accepted:
        _fail()
    if v['reconciliationRequired']:
        if queued>=latest or event_sequence(v['missingFrom'],e.id)!=queued+1 or v['missingThrough']!=v['observedLatest']:
            _fail()
    elif queued!=latest or v['missingFrom'] is not None or v['missingThrough'] is not None:
        _fail()
    head=None
    if v['pending']==0:
        if v['head'] is not None:
            _fail()
    else:
        h=v['head']
        if not _exact(h,['eventId','sequence','attempts','lastOutcome','cursor']) or not _id(h['eventId'],'aevt_') or not _integer(h['sequence'],1,9007199254740991) or h['sequence']!=accepted+1 or not _integer(h['attempts'],0,8) or (h['lastOutcome'] is not None if h['attempts']==0 else h['lastOutcome'] not in ('requested','unknown','not-accepted')) or event_sequence(h['cursor'],e.id)!=h['sequence']:
            _fail()
        head=AgentWebhookHead(AgentEventId(h['eventId']),h['sequence'],h['attempts'],cast(AgentWebhookOutcome | None,h['lastOutcome']),AgentEventCursor(h['cursor']))
    return AgentWebhookSubscription(AgentWebhookSubscriptionId(v['subscriptionId']),e.id,SessionId(v['sessionId']),AgentWebhookEndpointId(v['endpointId']),AgentEventCursor(v['after']),AgentEventCursor(v['acceptedThrough']),AgentEventCursor(v['queuedThrough']),AgentEventCursor(v['observedLatest']),v['pending'],v['reconciliationRequired'],None if v['missingFrom'] is None else AgentEventCursor(v['missingFrom']),None if v['missingThrough'] is None else AgentEventCursor(v['missingThrough']),head)

def prepare_webhook_request(transport: BackendTransport,kind: Literal['webhook-endpoints','webhook-subscribe','webhook-subscription'],run: AgentRunId,value: AgentWebhookSubscribeInput | AgentWebhookSubscriptionId | None,retries: RetryCount | None) -> Coroutine[Any,Any,ApiResult[Any]]:
    if not _id(run,'arun_'):
        _invalid()
    count=None if retries is None else transport.retry_count(retries)
    path='/v1/agent-runs/'+run
    payload=None
    if kind=='webhook-subscribe':
        if type(value) is not AgentWebhookSubscribeInput or not _id(value.endpoint_id,'awh_') or event_sequence(value.after,run) is None:
            _invalid()
        import json
        payload=json.dumps({'endpointId':value.endpoint_id,'after':value.after},separators=(',',':')).encode('utf-8')
        expected=WebhookExpected(kind,run,endpoint_id=value.endpoint_id,after=value.after)
        path+='/webhook-subscriptions'
    elif kind=='webhook-subscription':
        if not _id(value,'awsub_'):
            _invalid()
        subscription=cast(AgentWebhookSubscriptionId,value)
        expected=WebhookExpected(kind,run,subscription_id=subscription)
        path+='/webhook-subscriptions/'+subscription
    else:
        expected=WebhookExpected(kind,run)
        path+='/webhook-endpoints'
    return transport.request('POST' if kind=='webhook-subscribe' else 'GET',path,payload,None,expected,count)
