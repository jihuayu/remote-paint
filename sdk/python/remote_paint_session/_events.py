"""Frozen bounded event pages and original-Run cancellation reports."""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from typing import Any, Coroutine, Literal, NewType, cast
import httpx
from ._agent import (AgentClientError, AgentFailure, AgentInvocationId, AgentInvocationState,
    AgentReceipt, AgentRunId, AgentRunState, AgentTool, DispatchPhase, _error, _exact,
    _fail, _failure, _id, _invalid, _text)
from ._client import SessionId, _integer
from ._observation import _byte_length, _canonical_date
from ._transport import ApiResult, BackendTransport, RetryCount

AgentEventId = NewType('AgentEventId',str)
AgentEventCursor = NewType('AgentEventCursor',str)
AgentCancellationCursor = NewType('AgentCancellationCursor',str)
AgentHistoryOrigin = Literal['created','migration-snapshot']
AgentCloseEvidence = Literal['never-dispatched','begin-rejected','worker-run-closed','session-terminal']
AgentInvocationEffect = Literal['not-dispatched-yet','unknown','input-injected','not-dispatched']
AgentCancellationStatus = Literal['not-requested','pending','settling','closed','reconciliation-required']

@dataclass(frozen=True,slots=True)
class AgentRunProjection:
    state: AgentRunState
    holds_writer: bool
    begin_dispatch: DispatchPhase
    end_dispatch: DispatchPhase
    error: AgentFailure | None
    close_evidence_kind: AgentCloseEvidence | None
@dataclass(frozen=True,slots=True)
class AgentRunEventData(AgentRunProjection):
    state_updated_at: str
@dataclass(frozen=True,slots=True)
class AgentInvocationProjection:
    invocation_id: AgentInvocationId
    tool: AgentTool
    state: AgentInvocationState
    dispatch_started: bool
    receipt: AgentReceipt | None
    error: AgentFailure | None
@dataclass(frozen=True,slots=True)
class AgentEventInvocation(AgentInvocationProjection):
    state_updated_at: str
@dataclass(frozen=True,slots=True)
class AgentCancellationInvocation(AgentInvocationProjection):
    effect: AgentInvocationEffect
    updated_at: str
@dataclass(frozen=True,slots=True)
class _EventBase:
    event_id: AgentEventId
    agent_run_id: AgentRunId
    session_id: SessionId
    region: str
    version: str
    sequence: int
    observed_at: str
    schema: Literal['agent-event-v1'] = field(default='agent-event-v1',init=False)
@dataclass(frozen=True,slots=True)
class AgentRunEvent(_EventBase):
    type: Literal['run.updated','run.snapshot']
    data: AgentRunEventData
@dataclass(frozen=True,slots=True)
class AgentInvocationEvent(_EventBase):
    type: Literal['invocation.updated','invocation.snapshot']
    data: AgentEventInvocation
AgentEvent = AgentRunEvent | AgentInvocationEvent
@dataclass(frozen=True,slots=True)
class AgentEventPage:
    agent_run_id: AgentRunId
    session_id: SessionId
    region: str
    version: str
    history_origin: AgentHistoryOrigin
    after: AgentEventCursor
    oldest_sequence: int
    latest_sequence: int
    events: tuple[AgentEvent,...]
    next_cursor: AgentEventCursor
    has_more: bool
    oldest_cursor: AgentEventCursor
    latest_cursor: AgentEventCursor
    schema: Literal['agent-event-http-page-v1'] = field(default='agent-event-http-page-v1',init=False)
    gap: Literal[False] = field(default=False,init=False)
@dataclass(frozen=True,slots=True)
class AgentEventGap:
    agent_run_id: AgentRunId
    history_origin: AgentHistoryOrigin
    after: AgentEventCursor
    oldest_cursor: AgentEventCursor
    latest_cursor: AgentEventCursor
    schema: Literal['agent-event-gap-v1'] = field(default='agent-event-gap-v1',init=False)
    missing_history: Literal[True] = field(default=True,init=False)
@dataclass(frozen=True,slots=True)
class AgentCancellationWork:
    ordinary_pending: bool
    end_pending: bool
    recovery_required: bool
    executor_stopping: bool
@dataclass(frozen=True,slots=True)
class AgentCancellationPage:
    generation: AgentEventCursor
    history_origin: AgentHistoryOrigin
    after: AgentCancellationCursor | None
    next_cursor: AgentCancellationCursor | None
    has_more: bool
    complete_run: bool
@dataclass(frozen=True,slots=True)
class AgentCancellation:
    agent_run_id: AgentRunId
    session_id: SessionId
    region: str
    version: str
    observed_at: str
    status: AgentCancellationStatus
    run: AgentRunProjection
    work: AgentCancellationWork
    page: AgentCancellationPage
    invocations: tuple[AgentCancellationInvocation,...]
    schema: Literal['agent-cancellation-v1'] = field(default='agent-cancellation-v1',init=False)
    scope: Literal['original-agent-run'] = field(default='original-agent-run',init=False)
    rollback_supported: Literal[False] = field(default=False,init=False)
    rollback_performed: Literal[False] = field(default=False,init=False)
    business_success_confirmed: Literal[False] = field(default=False,init=False)

_UUID=r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
_EVENT=re.compile(r'aec1\.(arun_'+_UUID+r')\.(0|[1-9][0-9]{0,15})')
_CANCEL=re.compile(r'acc1\.(arun_'+_UUID+r')\.([1-9][0-9]{0,15})\.(ainv_'+_UUID+r')')
_SAFE=2**53-1
_RUN=['state','holdsWriter','beginDispatch','endDispatch','error','closeEvidenceKind']
_INVOCATION=['invocationId','tool','state','dispatchStarted','receipt','error']
_ORIGINS=('created','migration-snapshot')
_CLOSURES=('never-dispatched','begin-rejected','worker-run-closed','session-terminal')

@dataclass(frozen=True,slots=True)
class EventExpected:
    kind: Literal['event-page','cancellation','cancel']
    id: AgentRunId
    after: str | None = None

def event_cursor(run: AgentRunId,sequence: int) -> AgentEventCursor:
    return AgentEventCursor('aec1.'+run+'.'+str(sequence))

def event_sequence(value: Any,run: AgentRunId) -> int | None:
    match=_EVENT.fullmatch(value) if type(value) is str else None
    if match is None or match[1]!=run:
        return None
    sequence=int(match[2])
    return sequence if _integer(sequence,0,_SAFE) else None

def cancellation_cursor(value: Any,run: AgentRunId) -> tuple[int,str] | None:
    match=_CANCEL.fullmatch(value) if type(value) is str else None
    if match is None or match[1]!=run or not _integer(int(match[2]),1,_SAFE):
        return None
    return int(match[2]),match[3]

def _size(v: Any) -> int:
    try:
        return _byte_length(v)
    except (ValueError,TypeError,RecursionError):
        _fail()

def _bounds(v: Any,run: AgentRunId) -> tuple[int,int,int]:
    after,oldest,latest=event_sequence(v['after'],run),event_sequence(v['oldestCursor'],run),event_sequence(v['latestCursor'],run)
    if v['agentRunId']!=run or v['historyOrigin'] not in _ORIGINS or after is None or oldest is None or latest is None or latest<1 or oldest!=max(0,latest-64):
        _fail()
    return after,oldest,latest

def _run_data(v: Any,*,stamp: bool=False) -> AgentRunProjection:
    if not _exact(v,[*_RUN,*(['stateUpdatedAt'] if stamp else [])]) or v['state'] not in ('intent','starting','active','closing','recovery-required','closed') or type(v['holdsWriter']) is not bool or (v['state']=='closed')==v['holdsWriter'] or v['beginDispatch'] not in ('not-requested','requested','confirmed') or v['endDispatch'] not in ('not-requested','requested','confirmed') or not (v['error'] is None or _error(v['error'])) or stamp and not _canonical_date(v['stateUpdatedAt']):
        _fail()
    state,begin,end,error,closure=v['state'],v['beginDispatch'],v['endDispatch'],v['error'],v['closeEvidenceKind']
    if (closure is None and state=='closed') or (closure is not None and (state!='closed' or closure not in _CLOSURES)):
        _fail()
    if state=='intent' and (begin!='not-requested' or end!='not-requested' or error is not None) or state=='starting' and (begin!='requested' or end!='not-requested' or error is not None) or state=='active' and (begin!='confirmed' or end!='not-requested' or error is not None) or end!='not-requested' and begin!='confirmed' or end=='requested' and state not in ('closing','recovery-required','closed') or end=='confirmed' and (state!='closed' or closure!='worker-run-closed'):
        _fail()
    if closure=='never-dispatched' and (begin!='not-requested' or end!='not-requested' or error is not None) or closure=='begin-rejected' and (begin!='requested' or end!='not-requested' or error is None or error['outcome']!='not-dispatched') or closure=='worker-run-closed' and (begin!='confirmed' or end!='confirmed') or state!='closed' and error is not None and (state not in ('closing','recovery-required') or error['outcome']!='unknown'):
        _fail()
    if stamp:
        return AgentRunEventData(state,v['holdsWriter'],begin,end,_failure(error),closure,v['stateUpdatedAt'])
    return AgentRunProjection(state,v['holdsWriter'],begin,end,_failure(error),closure)

def _invocation_data(v: Any,*,report: bool=False) -> AgentEventInvocation | AgentCancellationInvocation:
    if not _exact(v,[*_INVOCATION,*(['effect','updatedAt'] if report else ['stateUpdatedAt'])]) or not _id(v['invocationId'],'ainv_') or v['tool'] not in ('move','click','drag','scroll','press','insertText','composition') or v['state'] not in ('intent','requested','injected','rejected','unknown') or type(v['dispatchStarted']) is not bool or not (v['error'] is None or _error(v['error'])) or not _canonical_date(v['updatedAt'] if report else v['stateUpdatedAt']):
        _fail()
    state,dispatched,receipt,error=v['state'],v['dispatchStarted'],v['receipt'],v['error']
    if receipt is not None and (not _exact(receipt,['stage','inputs']) or receipt['stage']!='input-injected' or not _integer(receipt['inputs'],1,32)) or (state=='injected')!=(receipt is not None):
        _fail()
    if state=='intent' and (dispatched or error is not None) or state=='requested' and (not dispatched or error is not None) or state=='injected' and (not dispatched or error is not None) or state=='rejected' and (error is None or error['outcome']!='not-dispatched') or state=='unknown' and (not dispatched or error is None or error['outcome']!='unknown'):
        _fail()
    captured=None if receipt is None else AgentReceipt(receipt['stage'],receipt['inputs'])
    if report:
        effect='input-injected' if state=='injected' else 'not-dispatched' if state=='rejected' else 'not-dispatched-yet' if state=='intent' else 'unknown'
        if v['effect']!=effect:
            _fail()
        return AgentCancellationInvocation(AgentInvocationId(v['invocationId']),v['tool'],state,dispatched,captured,_failure(error),cast(AgentInvocationEffect,effect),v['updatedAt'])
    return AgentEventInvocation(AgentInvocationId(v['invocationId']),v['tool'],state,dispatched,captured,_failure(error),v['stateUpdatedAt'])

def decode_event(v: Any,run: AgentRunId) -> AgentEvent:
    if not _exact(v,['schema','eventId','agentRunId','sessionId','region','version','sequence','observedAt','type','data']) or v['schema']!='agent-event-v1' or not _id(v['eventId'],'aevt_') or v['agentRunId']!=run or not _id(v['sessionId'],'ses_') or not _text(v['region'],64) or not _text(v['version'],256) or not _integer(v['sequence'],1,_SAFE) or not _canonical_date(v['observedAt']) or _size(v)>3072:
        _fail()
    if v['type'] in ('run.updated','run.snapshot'):
        return AgentRunEvent(AgentEventId(v['eventId']),run,SessionId(v['sessionId']),v['region'],v['version'],v['sequence'],v['observedAt'],v['type'],cast(AgentRunEventData,_run_data(v['data'],stamp=True)))
    if v['type'] in ('invocation.updated','invocation.snapshot'):
        return AgentInvocationEvent(AgentEventId(v['eventId']),run,SessionId(v['sessionId']),v['region'],v['version'],v['sequence'],v['observedAt'],v['type'],cast(AgentEventInvocation,_invocation_data(v['data'])))
    _fail()

def decode_event_gap(v: Any,run: AgentRunId,after_cursor: AgentEventCursor) -> AgentEventGap:
    if not _exact(v,['schema','agentRunId','historyOrigin','after','oldestCursor','latestCursor','missingHistory']) or v['schema']!='agent-event-gap-v1' or v['missingHistory'] is not True or _size(v)>2048:
        _fail()
    after,oldest,_=_bounds(v,run)
    if after>=oldest or v['after']!=after_cursor:
        _fail()
    return AgentEventGap(run,v['historyOrigin'],AgentEventCursor(v['after']),AgentEventCursor(v['oldestCursor']),AgentEventCursor(v['latestCursor']))

def capture_event_error_details(error: dict[str,Any],expected: Any,status: int) -> AgentEventGap | None:
    if not isinstance(expected,EventExpected) or expected.kind!='event-page' or status!=409 or error['code']!='AGENT_EVENT_GAP' or error.get('outcome')!='not-dispatched':
        return None
    v=error.get('details')
    if type(v) is not dict:
        return None
    try:
        return decode_event_gap(v,expected.id,AgentEventCursor(expected.after) if expected.after is not None else event_cursor(expected.id,0))
    except AgentClientError:
        return None

def validate_event_reply(status: int,v: Any,e: EventExpected,headers: httpx.Headers) -> AgentEventPage | AgentCancellation:
    if e.kind=='event-page':
        if status!=200 or not _exact(v,['schema','agentRunId','sessionId','region','version','historyOrigin','after','oldestSequence','latestSequence','gap','events','nextCursor','hasMore','oldestCursor','latestCursor']) or v['schema']!='agent-event-http-page-v1' or not _id(v['sessionId'],'ses_') or not _text(v['region'],64) or not _text(v['version'],256) or v['gap'] is not False or type(v['events']) is not list or len(v['events'])>4 or type(v['hasMore']) is not bool or _size(v)>16384:
            _fail()
        after,oldest,latest=_bounds(v,e.id)
        if v['after']!=(e.after if e.after is not None else event_cursor(e.id,0)) or not oldest<=after<=latest or type(v['oldestSequence']) is not int or v['oldestSequence']!=oldest+1 or type(v['latestSequence']) is not int or v['latestSequence']!=latest or len(v['events'])!=min(4,latest-after):
            _fail()
        events=tuple(decode_event(row,e.id) for row in v['events']);seen:set[AgentEventId]=set()
        for i,row in enumerate(events):
            if (row.session_id,row.region,row.version)!=(v['sessionId'],v['region'],v['version']) or row.sequence!=after+i+1 or row.event_id in seen:
                _fail()
            seen.add(row.event_id)
        if v['nextCursor']!=event_cursor(e.id,after+len(events)) or v['hasMore']!=(after+len(events)<latest):
            _fail()
        return AgentEventPage(e.id,SessionId(v['sessionId']),v['region'],v['version'],v['historyOrigin'],AgentEventCursor(v['after']),v['oldestSequence'],latest,events,AgentEventCursor(v['nextCursor']),v['hasMore'],AgentEventCursor(v['oldestCursor']),AgentEventCursor(v['latestCursor']))
    if not _exact(v,['schema','agentRunId','sessionId','region','version','observedAt','status','run','work','scope','rollbackSupported','rollbackPerformed','businessSuccessConfirmed','page','invocations']) or v['schema']!='agent-cancellation-v1' or v['agentRunId']!=e.id or not _id(v['sessionId'],'ses_') or not _text(v['region'],64) or not _text(v['version'],256) or not _canonical_date(v['observedAt']) or not _exact(v['work'],['ordinaryPending','endPending','recoveryRequired','executorStopping']) or any(type(flag) is not bool for flag in v['work'].values()) or v['scope']!='original-agent-run' or any(v[k] is not False for k in ['rollbackSupported','rollbackPerformed','businessSuccessConfirmed']) or not _exact(v['page'],['generation','historyOrigin','after','nextCursor','hasMore','completeRun']) or v['page']['historyOrigin'] not in _ORIGINS or type(v['page']['hasMore']) is not bool or type(v['invocations']) is not list or len(v['invocations'])>4 or _size(v)>16384:
        _fail()
    run=_run_data(v['run']);work=v['work'];page=v['page']
    expected_status='settling' if run.state=='closed' and (work['ordinaryPending'] or work['endPending']) else 'closed' if run.state=='closed' else 'pending' if work['endPending'] or run.state=='closing' else 'reconciliation-required' if work['recoveryRequired'] or run.state=='recovery-required' else 'not-requested'
    if v['status']!=expected_status or e.kind=='cancel' and (status!=(202 if expected_status in ('pending','settling') else 200) or headers.get('location')!='/v1/agent-runs/'+e.id+'/cancellation') or e.kind=='cancellation' and status!=200:
        _fail()
    generation=event_sequence(page['generation'],e.id);anchor=cancellation_cursor(e.after,e.id) if e.after is not None else None
    if generation is None or generation<1 or page['after']!=e.after or anchor is not None and anchor[0]!=generation or type(page['completeRun']) is not bool or page['completeRun']!=(page['after'] is None and not page['hasMore']):
        _fail()
    invocations=tuple(cast(AgentCancellationInvocation,_invocation_data(row,report=True)) for row in v['invocations']);previous=anchor[1] if anchor is not None else ''
    for invocation in invocations:
        if invocation.invocation_id<=previous:
            _fail()
        previous=invocation.invocation_id
    if page['hasMore']:
        next_cursor=cancellation_cursor(page['nextCursor'],e.id)
        if len(invocations)!=4 or next_cursor is None or next_cursor!=(generation,previous):
            _fail()
    elif page['nextCursor'] is not None:
        _fail()
    return AgentCancellation(e.id,SessionId(v['sessionId']),v['region'],v['version'],v['observedAt'],v['status'],run,AgentCancellationWork(work['ordinaryPending'],work['endPending'],work['recoveryRequired'],work['executorStopping']),AgentCancellationPage(AgentEventCursor(page['generation']),page['historyOrigin'],None if page['after'] is None else AgentCancellationCursor(page['after']),None if page['nextCursor'] is None else AgentCancellationCursor(page['nextCursor']),page['hasMore'],page['completeRun']),invocations)

def prepare_event_request(transport: BackendTransport,kind: Literal['event-page','cancellation','cancel'],run: AgentRunId,after: str | None,retries: RetryCount | None) -> Coroutine[Any,Any,ApiResult[Any]]:
    if not _id(run,'arun_') or after is not None and (kind=='cancel' or (cancellation_cursor(after,run) is None if kind=='cancellation' else event_sequence(after,run) is None)):
        _invalid()
    count=None if retries is None else transport.retry_count(retries)
    path='/v1/agent-runs/'+run+('/events' if kind=='event-page' else '/'+kind)+(('?'+'after='+after) if after is not None else '')
    return transport.request('POST' if kind=='cancel' else 'GET',path,None,None,EventExpected(kind,run,after),count,ending=kind=='cancel')
