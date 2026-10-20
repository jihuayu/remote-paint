"""Managed Agent input and observation API for trusted Python backends."""
from __future__ import annotations
import json
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Coroutine, Generic, Literal, NewType, NoReturn, NotRequired, TypeVar, TypedDict, cast
import httpx
from ._client import SessionId, _date as _session_date, _integer
from ._transport import ApiResult, BackendTransport, Outcome, RetryCount, SessionClientError, SessionClientCancelledError, TransportStatus

if TYPE_CHECKING:
    from ._observation import ObservationExpected, AccessibilityExpected, ScreenshotExpected
    from ._download import DownloadExpected
    from ._events import EventExpected, AgentEventGap, AgentEventPage, AgentEventCursor, AgentCancellationCursor, AgentCancellation

AgentRunId = NewType('AgentRunId', str)
AgentInvocationId = NewType('AgentInvocationId', str)
AgentTool = Literal['move','click','drag','scroll','press','insertText','composition']
AgentRunState = Literal['intent','starting','active','closing','recovery-required','closed']
AgentInvocationState = Literal['intent','requested','injected','rejected','unknown']
DispatchPhase = Literal['not-requested','requested','confirmed']
Button = Literal['left','middle','right']

class AgentClientError(SessionClientError):
    def __init__(self, code: str, *, details: AgentEventGap | None = None, cursor: AgentEventCursor | None = None, **options: Any) -> None:
        super().__init__(code, **options)
        self.details = details
        self.cursor = cursor
        self.args = ('Invalid Agent client request' if code == 'CLIENT_INVALID_REQUEST' else 'Agent API request failed',)
class AgentClientCancelledError(SessionClientCancelledError):
    def __init__(self, outcome: Outcome) -> None:
        super().__init__(outcome)
        self.args = ('Agent API request cancelled',)

@dataclass(frozen=True, slots=True)
class AgentFence:
    control_session_id: str
    control_version: int
    page_epoch: int
    viewport_version: int
@dataclass(frozen=True, slots=True)
class AgentBinding:
    tenant_id: str
    session_id: SessionId
    target_id: str
    run_id: str
@dataclass(frozen=True, slots=True)
class AgentContext:
    agent_run_id: AgentRunId
    binding: AgentBinding
    fence: AgentFence
@dataclass(frozen=True, slots=True)
class AgentRunReference:
    agent_run_id: AgentRunId
    session_id: SessionId
@dataclass(frozen=True, slots=True)
class AgentFailure:
    code: str
    outcome: Literal['not-dispatched','unknown']
@dataclass(frozen=True, slots=True)
class AgentReceipt:
    stage: Literal['input-injected']
    inputs: int
@dataclass(frozen=True, slots=True)
class AgentRun:
    agent_run_id: AgentRunId
    session_id: SessionId
    region: str
    version: str
    state: AgentRunState
    holds_writer: bool
    begin_dispatch: DispatchPhase
    end_dispatch: DispatchPhase
    created_at: str
    updated_at: str
    error: AgentFailure | None
@dataclass(frozen=True, slots=True)
class AgentInvocation:
    invocation_id: AgentInvocationId
    agent_run_id: AgentRunId
    session_id: SessionId
    tool: AgentTool
    fence: AgentFence
    state: AgentInvocationState
    dispatch_started: bool
    receipt: AgentReceipt | None
    error: AgentFailure | None
    created_at: str
    updated_at: str
@dataclass(frozen=True, slots=True)
class CreateAgentRunInput:
    region: str
    version: str
    rpc_timeout_ms: int | None = None

class MoveParams(TypedDict):
    x: float
    y: float
    modifiers: NotRequired[int]
class ClickParams(MoveParams):
    button: NotRequired[Button]
class DragParams(TypedDict):
    from_x: float
    from_y: float
    to_x: float
    to_y: float
    steps: NotRequired[int]
    button: NotRequired[Button]
    modifiers: NotRequired[int]
class ScrollParams(MoveParams):
    delta_x: float
    delta_y: float
class PressParams(TypedDict):
    key: str
    code: str
    text: NotRequired[str]
    modifiers: NotRequired[int]
    windows_virtual_key_code: NotRequired[int]
    native_virtual_key_code: NotRequired[int]
class InsertTextParams(TypedDict):
    text: str
class CompositionParams(InsertTextParams):
    selection_start: int
    selection_end: int
class _ActionOptions(TypedDict):
    rpc_timeout_ms: NotRequired[int]
class MoveAction(_ActionOptions):
    tool: Literal['move']
    params: MoveParams
class ClickAction(_ActionOptions):
    tool: Literal['click']
    params: ClickParams
class DragAction(_ActionOptions):
    tool: Literal['drag']
    params: DragParams
class ScrollAction(_ActionOptions):
    tool: Literal['scroll']
    params: ScrollParams
class PressAction(_ActionOptions):
    tool: Literal['press']
    params: PressParams
class InsertTextAction(_ActionOptions):
    tool: Literal['insertText']
    params: InsertTextParams
class CompositionAction(_ActionOptions):
    tool: Literal['composition']
    params: CompositionParams
AgentAction = MoveAction | ClickAction | DragAction | ScrollAction | PressAction | InsertTextAction | CompositionAction

_TOOLS = ('move','click','drag','scroll','press','insertText','composition')
_FENCE = ('controlSessionId','controlVersion','pageEpoch','viewportVersion')
_BINDING = ('tenantId','sessionId','targetId','runId')
_RUN = 'agentRunId sessionId region version state holdsWriter beginDispatch endDispatch createdAt updatedAt error'.split()
_INVOCATION = 'invocationId agentRunId sessionId tool fence state dispatchStarted receipt error createdAt updatedAt'.split()
_INPUTS = {'move':1,'click':3,'scroll':1,'press':2,'insertText':1,'composition':1}

def _fail(code: str = 'CLIENT_INVALID_RESPONSE', **options: Any) -> NoReturn:
    raise AgentClientError(code, **options) from None

def _invalid() -> NoReturn:
    _fail('CLIENT_INVALID_REQUEST', outcome='not-dispatched')

def _exact(v: Any, keys: Any) -> bool:
    return type(v) is dict and set(v) == set(keys)

def _data(v: Any, allowed: list[str], required: list[str] | None = None) -> dict[str, Any]:
    if type(v) is not dict or any(type(k) is not str or k not in allowed for k in v) or any(k not in v for k in (allowed if required is None else required)):
        _invalid()
    return dict(v)

def _uuid(v: Any) -> bool:
    return type(v) is str and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',v) is not None

def _id(v: Any, prefix: str) -> bool:
    return type(v) is str and v.startswith(prefix) and _uuid(v[len(prefix):])

def _date(v: Any) -> bool:
    return type(v) is str and v.endswith('Z') and _session_date(v)

def _text(v: Any, maximum: int, minimum: int = 1) -> bool:
    # Match JavaScript string/selection units, including astral characters.
    return type(v) is str and len(v) <= maximum and minimum <= len(v.encode('utf-16-le',errors='surrogatepass'))//2 <= maximum

def _fence(v: Any) -> bool:
    return _exact(v,_FENCE) and _uuid(v['controlSessionId']) and _integer(v['controlVersion'],0,2**53-1) and _integer(v['pageEpoch'],1,2**53-1) and _integer(v['viewportVersion'],1,2**53-1)

def _binding(v: Any) -> bool:
    return _exact(v,_BINDING) and _text(v['tenantId'],128) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*',v['tenantId']) is not None and _id(v['sessionId'],'ses_') and _id(v['targetId'],'target_') and _id(v['runId'],'run_')

def _error(v: Any) -> bool:
    return _exact(v,['code','outcome']) and type(v['code']) is str and re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}',v['code']) is not None and not v['code'].startswith('CLIENT_') and v['outcome'] in ('not-dispatched','unknown')

def _failure(v: Any) -> AgentFailure | None:
    return None if v is None else AgentFailure(v['code'],v['outcome'])

def _decode_fence(v: dict[str, Any]) -> AgentFence:
    return AgentFence(v['controlSessionId'],v['controlVersion'],v['pageEpoch'],v['viewportVersion'])

def _run(v: Any) -> AgentRun:
    if not _exact(v,_RUN) or not _id(v['agentRunId'],'arun_') or not _id(v['sessionId'],'ses_') or not _text(v['region'],64) or not _text(v['version'],256) or v['state'] not in ('intent','starting','active','closing','recovery-required','closed') or type(v['holdsWriter']) is not bool or v['beginDispatch'] not in ('not-requested','requested','confirmed') or v['endDispatch'] not in ('not-requested','requested','confirmed') or not _date(v['createdAt']) or not _date(v['updatedAt']) or v['updatedAt'] < v['createdAt'] or not (v['error'] is None or _error(v['error'])):
        _fail()
    if (v['state']=='closed') == v['holdsWriter'] or v['endDispatch']!='not-requested' and v['beginDispatch']!='confirmed' or v['endDispatch']=='confirmed' and v['state']!='closed':
        _fail()
    for state,phase in [('intent','not-requested'),('starting','requested'),('active','confirmed')]:
        if v['state']==state and (v['beginDispatch']!=phase or v['endDispatch']!='not-requested' or v['error'] is not None):
            _fail()
    if v['error'] is not None and (v['state'] not in ('closed','closing','recovery-required') or v['error']['outcome']=='not-dispatched' and v['state']!='closed'):
        _fail()
    return AgentRun(v['agentRunId'],v['sessionId'],v['region'],v['version'],v['state'],v['holdsWriter'],v['beginDispatch'],v['endDispatch'],v['createdAt'],v['updatedAt'],_failure(v['error']))

def _invocation(v: Any) -> AgentInvocation:
    if not _exact(v,_INVOCATION) or not _id(v['invocationId'],'ainv_') or not _id(v['agentRunId'],'arun_') or not _id(v['sessionId'],'ses_') or v['tool'] not in _TOOLS or not _fence(v['fence']) or v['state'] not in ('intent','requested','injected','rejected','unknown') or type(v['dispatchStarted']) is not bool or not _date(v['createdAt']) or not _date(v['updatedAt']) or v['updatedAt'] < v['createdAt']:
        _fail()
    state,receipt,error = v['state'],v['receipt'],v['error']
    if state in ('intent','requested'):
        valid = v['dispatchStarted']==(state=='requested') and receipt is None and error is None
    elif state=='injected':
        valid = v['dispatchStarted'] and error is None and _exact(receipt,['stage','inputs']) and receipt['stage']=='input-injected' and (_integer(receipt['inputs'],4,19) if v['tool']=='drag' else type(receipt['inputs']) is int and receipt['inputs']==_INPUTS[v['tool']])
    else:
        valid = receipt is None and _error(error) and (v['dispatchStarted'] and error['outcome']=='unknown' if state=='unknown' else error['outcome']=='not-dispatched')
    if not valid:
        _fail()
    return AgentInvocation(v['invocationId'],v['agentRunId'],v['sessionId'],v['tool'],_decode_fence(v['fence']),state,v['dispatchStarted'],None if receipt is None else AgentReceipt(receipt['stage'],receipt['inputs']),_failure(error),v['createdAt'],v['updatedAt'])

@dataclass(frozen=True, slots=True)
class _Expected:
    kind: str
    id: str | None = None
    session_id: str | None = None
    agent_run_id: str | None = None
    region: str | None = None
    version: str | None = None
    tool: str | None = None
    fence: AgentFence | None = None
    inputs: int | None = None

def _validate(status: int, v: Any, e: _Expected | ObservationExpected | AccessibilityExpected | ScreenshotExpected | DownloadExpected | EventExpected, headers: httpx.Headers) -> Any:
    from ._observation import ObservationExpected, AccessibilityExpected, ScreenshotExpected, validate_observation, validate_accessibility, validate_screenshot
    from ._download import DownloadExpected,validate_download
    from ._events import EventExpected,validate_event_reply
    if isinstance(e,EventExpected):
        return validate_event_reply(status,v,e,headers)
    if isinstance(e,DownloadExpected):
        return validate_download(status,v,e,headers)
    if isinstance(e,ScreenshotExpected):
        return validate_screenshot(status,v,e,headers)
    if isinstance(e,AccessibilityExpected):
        return validate_accessibility(status,v,e,headers)
    if isinstance(e,ObservationExpected):
        return validate_observation(status,v,e,headers)
    if e.kind=='context':
        if status!=200 or not _exact(v,['binding','fence']) or not _binding(v['binding']) or not _fence(v['fence']) or v['binding']['sessionId']!=e.session_id:
            _fail()
        b = v['binding']
        return AgentContext(AgentRunId(cast(str,e.id)),AgentBinding(b['tenantId'],b['sessionId'],b['targetId'],b['runId']),_decode_fence(v['fence']))
    if e.kind.startswith('invocation'):
        row = _invocation(v)
        if e.id is not None and row.invocation_id!=e.id:
            _fail()
        if e.kind=='invocation-get':
            if status!=200:
                _fail()
        elif row.agent_run_id!=e.agent_run_id or row.session_id!=e.session_id or row.tool!=e.tool or row.fence!=e.fence or row.state=='injected' and cast(AgentReceipt,row.receipt).inputs!=e.inputs or status!=(202 if row.state in ('intent','requested') else 200) or headers.get('location')!='/v1/agent-invocations/'+row.invocation_id:
            _fail()
        return row
    run = _run(v)
    if e.id is not None and run.agent_run_id!=e.id:
        _fail()
    if e.kind=='run-get':
        if status!=200:
            _fail()
    elif e.kind=='run-create' and (run.session_id!=e.session_id or run.region!=e.region or run.version!=e.version) or e.kind=='end' and run.state in ('intent','starting','active') or status!=(202 if run.state in ('intent','starting','closing') else 200) or headers.get('location')!='/v1/agent-runs/'+run.agent_run_id:
        _fail()
    return run

def _timeout(v: Any) -> None:
    if v is not None and not _integer(v,50,120000):
        _invalid()

def _key(v: Any) -> str:
    if type(v) is not str or re.fullmatch(r'[\x21-\x7e]{1,128}',v) is None:
        _invalid()
    return v

def _body(v: Any) -> bytes:
    try:
        result = json.dumps(v,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8',errors='backslashreplace')
    except (TypeError,ValueError,UnicodeError,RecursionError):
        _invalid()
    if len(result)>32768:
        _invalid()
    return result

def _context(v: AgentContext) -> tuple[AgentContext,dict[str,Any]]:
    if type(v) is not AgentContext or type(v.binding) is not AgentBinding or type(v.fence) is not AgentFence:
        _invalid()
    b,f = v.binding,v.fence
    binding = dict(tenantId=b.tenant_id,sessionId=b.session_id,targetId=b.target_id,runId=b.run_id)
    fence = dict(controlSessionId=f.control_session_id,controlVersion=f.control_version,pageEpoch=f.page_epoch,viewportVersion=f.viewport_version)
    if not _id(v.agent_run_id,'arun_') or not _binding(binding) or not _fence(fence):
        _invalid()
    return AgentContext(v.agent_run_id,AgentBinding(b.tenant_id,b.session_id,b.target_id,b.run_id),_decode_fence(fence)),dict(binding=binding,fence=fence)

def _action(value: AgentAction) -> tuple[dict[str,Any],int]:
    v = _data(value,['tool','params','rpc_timeout_ms'],['tool','params']);tool = v['tool']
    if type(tool) is not str or tool not in _TOOLS:
        _invalid()
    _timeout(v.get('rpc_timeout_ms'))
    fields = {'move':(['x','y','modifiers'],['x','y']),'click':(['x','y','button','modifiers'],['x','y']),'drag':(['from_x','from_y','to_x','to_y','steps','button','modifiers'],['from_x','from_y','to_x','to_y']),'scroll':(['x','y','delta_x','delta_y','modifiers'],['x','y','delta_x','delta_y']),'press':(['key','code','text','modifiers','windows_virtual_key_code','native_virtual_key_code'],['key','code']),'insertText':(['text'],['text']),'composition':(['text','selection_start','selection_end'],['text','selection_start','selection_end'])}[tool]
    p = _data(v['params'],*fields)
    if 'modifiers' in p and not _integer(p['modifiers'],0,15):
        _invalid()
    for k in ('x','y','from_x','from_y','to_x','to_y'):
        if k in fields[1] and (type(p[k]) not in (int,float) or not 0<=p[k]<=1e7):
            _invalid()
    if 'button' in p and p['button'] not in ('left','middle','right') or tool=='drag' and 'steps' in p and not _integer(p['steps'],1,16):
        _invalid()
    if tool=='scroll' and any(type(p[k]) not in (int,float) or not abs(p[k])<=10000 for k in ('delta_x','delta_y')):
        _invalid()
    if tool=='press' and (not _text(p['key'],64,0) or not _text(p['code'],64,0) or 'text' in p and not _text(p['text'],32,0) or any(k in p and not _integer(p[k],0,65535) for k in ('windows_virtual_key_code','native_virtual_key_code'))):
        _invalid()
    if tool in ('insertText','composition') and not _text(p['text'],8192,0):
        _invalid()
    if tool=='composition':
        units = len(p['text'].encode('utf-16-le',errors='surrogatepass'))//2
        if not _integer(p['selection_start'],0,units) or not _integer(p['selection_end'],p['selection_start'],units):
            _invalid()
    renamed = {'from_x':'fromX','from_y':'fromY','to_x':'toX','to_y':'toY','delta_x':'deltaX','delta_y':'deltaY','selection_start':'selectionStart','selection_end':'selectionEnd','windows_virtual_key_code':'windowsVirtualKeyCode','native_virtual_key_code':'nativeVirtualKeyCode'}
    wire = {'tool':tool,'params':{renamed.get(k,k):v for k,v in p.items()}}
    if v.get('rpc_timeout_ms') is not None:
        wire['rpcTimeoutMs'] = v['rpc_timeout_ms']
    return wire,(p.get('steps',4)+3 if tool=='drag' else _INPUTS[tool])

T = TypeVar('T',AgentRun,AgentInvocation)
@dataclass(slots=True)
class _Identity:
    id: str | None = None
    created_at: str | None = None
@dataclass(frozen=True, slots=True)
class PreparedAgentRequest(Generic[T]):
    _transport: BackendTransport = field(repr=False)
    _path: str = field(repr=False)
    _body: bytes = field(repr=False)
    _key: str = field(repr=False)
    _expected: _Expected = field(repr=False)
    _identity: _Identity = field(default_factory=_Identity,repr=False)
    async def send(self, *, retries: RetryCount | None = None) -> ApiResult[T]:
        result = await self._transport.request('POST',self._path,self._body,self._key,self._expected,retries)
        row = result.data; identifier = row.agent_run_id if type(row) is AgentRun else row.invocation_id
        if self._identity.id is not None and self._identity.id!=identifier or self._identity.created_at is not None and self._identity.created_at!=row.created_at:
            _fail(request_id=result.request_id)
        self._identity.id,self._identity.created_at = identifier,row.created_at
        return cast(ApiResult[T],result)
PreparedAgentRun = PreparedAgentRequest[AgentRun]
PreparedAgentInvocation = PreparedAgentRequest[AgentInvocation]

class _Runs:
    def __init__(self, transport: BackendTransport) -> None:
        self._transport = transport
    def prepare_create(self, session_id: SessionId, value: CreateAgentRunInput, *, idempotency_key: str) -> PreparedAgentRun:
        if not _id(session_id,'ses_') or type(value) is not CreateAgentRunInput or not _text(value.region,64) or not _text(value.version,256):
            _invalid()
        _timeout(value.rpc_timeout_ms)
        payload: dict[str,Any] = {'region':value.region,'version':value.version}
        if value.rpc_timeout_ms is not None:
            payload['rpcTimeoutMs'] = value.rpc_timeout_ms
        return PreparedAgentRequest(self._transport,'/v1/sessions/'+session_id+'/agent-runs',_body(payload),_key(idempotency_key),_Expected('run-create',session_id=session_id,region=value.region,version=value.version))
    async def create(self, session_id: SessionId, value: CreateAgentRunInput, *, idempotency_key: str, retries: RetryCount | None = None) -> ApiResult[AgentRun]:
        return await self.prepare_create(session_id,value,idempotency_key=idempotency_key).send(retries=retries)
    async def get(self, agent_run_id: AgentRunId, *, retries: RetryCount | None = None) -> ApiResult[AgentRun]:
        if not _id(agent_run_id,'arun_'):
            _invalid()
        return cast(ApiResult[AgentRun],await self._transport.request('GET','/v1/agent-runs/'+agent_run_id,None,None,_Expected('run-get',id=agent_run_id),retries))
    async def context(self, run: AgentRunReference | AgentRun, *, retries: RetryCount | None = None) -> ApiResult[AgentContext]:
        if type(run) not in (AgentRunReference,AgentRun) or not _id(run.agent_run_id,'arun_') or not _id(run.session_id,'ses_'):
            _invalid()
        return cast(ApiResult[AgentContext],await self._transport.request('GET','/v1/agent-runs/'+run.agent_run_id+'/context',None,None,_Expected('context',id=run.agent_run_id,session_id=run.session_id),retries))
    async def end(self, agent_run_id: AgentRunId, *, retries: RetryCount | None = None) -> ApiResult[AgentRun]:
        if not _id(agent_run_id,'arun_'):
            _invalid()
        return cast(ApiResult[AgentRun],await self._transport.request('POST','/v1/agent-runs/'+agent_run_id+'/end',None,None,_Expected('end',id=agent_run_id),retries,ending=True))
    def event_page(self, agent_run_id: AgentRunId, *, after: AgentEventCursor | None = None, retries: RetryCount | None = None) -> Coroutine[Any,Any,ApiResult[AgentEventPage]]:
        from ._events import AgentEventPage,prepare_event_request
        return cast(Coroutine[Any,Any,ApiResult[AgentEventPage]],prepare_event_request(self._transport,'event-page',agent_run_id,after,retries))
    def cancellation(self, agent_run_id: AgentRunId, *, after: AgentCancellationCursor | None = None, retries: RetryCount | None = None) -> Coroutine[Any,Any,ApiResult[AgentCancellation]]:
        from ._events import AgentCancellation,prepare_event_request
        return cast(Coroutine[Any,Any,ApiResult[AgentCancellation]],prepare_event_request(self._transport,'cancellation',agent_run_id,after,retries))
    def cancel(self, agent_run_id: AgentRunId, *, retries: RetryCount | None = None) -> Coroutine[Any,Any,ApiResult[AgentCancellation]]:
        from ._events import AgentCancellation,prepare_event_request
        return cast(Coroutine[Any,Any,ApiResult[AgentCancellation]],prepare_event_request(self._transport,'cancel',agent_run_id,None,retries))
class _Invocations:
    def __init__(self, transport: BackendTransport) -> None:
        self._transport = transport
    def prepare_create(self, context: AgentContext, action: AgentAction, *, idempotency_key: str) -> PreparedAgentInvocation:
        ctx,wire_context = _context(context);wire,inputs = _action(action)
        return PreparedAgentRequest(self._transport,'/v1/agent-runs/'+ctx.agent_run_id+'/invocations',_body({**wire,'context':wire_context}),_key(idempotency_key),_Expected('invocation-create',session_id=ctx.binding.session_id,agent_run_id=ctx.agent_run_id,tool=wire['tool'],fence=ctx.fence,inputs=inputs))
    async def create(self, context: AgentContext, action: AgentAction, *, idempotency_key: str, retries: RetryCount | None = None) -> ApiResult[AgentInvocation]:
        return await self.prepare_create(context,action,idempotency_key=idempotency_key).send(retries=retries)
    async def get(self, invocation_id: AgentInvocationId, *, retries: RetryCount | None = None) -> ApiResult[AgentInvocation]:
        if not _id(invocation_id,'ainv_'):
            _invalid()
        return cast(ApiResult[AgentInvocation],await self._transport.request('GET','/v1/agent-invocations/'+invocation_id,None,None,_Expected('invocation-get',id=invocation_id),retries))

class AgentClient:
    def __init__(self, *, base_url: str, api_key: str, timeout_seconds: float = 10, retries: RetryCount = 0,
                 max_response_bytes: int = 65536, max_concurrent_requests: int = 64, max_concurrent_end_requests: int = 8, max_screenshot_bytes: int = 1048576, max_download_bytes: int = 1048576,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        if not _integer(max_concurrent_end_requests,1,64) or not _integer(max_screenshot_bytes,57,4194304) or not _integer(max_download_bytes,1,4194304):
            _invalid()
        from ._download import is_download_file,read_download_binary
        from ._observation import is_screenshot_download, read_screenshot_binary
        from ._events import capture_event_error_details
        self._transport = BackendTransport(base_url=base_url,api_key=api_key,timeout_seconds=timeout_seconds,retries=retries,max_response_bytes=max_response_bytes,max_concurrent_requests=max_concurrent_requests,max_concurrent_end_requests=max_concurrent_end_requests,transport=transport,validate=_validate,error_type=AgentClientError,cancelled_type=AgentClientCancelledError,agent_errors=True,max_screenshot_bytes=max_screenshot_bytes,binary_expected=is_screenshot_download,read_binary=read_screenshot_binary,max_download_bytes=max_download_bytes,download_expected=is_download_file,read_download=read_download_binary,error_details=capture_event_error_details)
        from ._observation import _Observations
        self.runs,self.invocations,self.observations = _Runs(self._transport),_Invocations(self._transport),_Observations(self._transport)
    async def __aenter__(self) -> AgentClient:
        self._transport.ensure_open()
        return self
    async def __aexit__(self, *args: Any) -> None:
        await self.aclose()
    async def aclose(self) -> None:
        await self._transport.aclose()
    def transport_status(self) -> TransportStatus:
        return self._transport.status()
