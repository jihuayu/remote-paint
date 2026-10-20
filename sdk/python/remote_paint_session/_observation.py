"""Immutable managed DOM and computed AX DTOs and single-attempt reads."""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime
import json
import re
from typing import Any, Coroutine, Literal, NewType, cast
import httpx
from ._agent import AgentBinding, AgentRun, AgentRunId, _binding, _body, _exact, _fail, _id, _invalid, _text, _timeout, _uuid
from ._client import SessionId, _integer
from ._transport import ApiResult, BackendTransport

AgentElementId = NewType('AgentElementId', str)
AgentObservationId = NewType('AgentObservationId', str)

@dataclass(frozen=True, slots=True)
class AgentObservationReference:
    agent_run_id: AgentRunId
    session_id: SessionId
    version: str
@dataclass(frozen=True, slots=True)
class AgentObservationDocument:
    control_session_id: str
    page_epoch: int
    viewport_version: int
@dataclass(frozen=True, slots=True)
class AgentObservationContext:
    agent_run_id: AgentRunId
    session_id: SessionId
    version: str
    binding: AgentBinding
    document: AgentObservationDocument
@dataclass(frozen=True, slots=True)
class AgentSnapshotQuery:
    kind: Literal['snapshot'] = field(default='snapshot',init=False)
@dataclass(frozen=True, slots=True)
class AgentLocateQuery:
    by: Literal['id','tag','testId']
    value: str
    kind: Literal['locate'] = field(default='locate',init=False)
@dataclass(frozen=True, slots=True)
class AgentElementQuery:
    element_id: AgentElementId
    kind: Literal['element'] = field(default='element',init=False)
AgentObservationQuery = AgentSnapshotQuery | AgentLocateQuery | AgentElementQuery
@dataclass(frozen=True, slots=True)
class AgentObservationLimits:
    max_nodes: int = 8
    max_chars: int = 1024
    max_visited: int = 128
@dataclass(frozen=True, slots=True)
class AgentObservationInput:
    query: AgentObservationQuery
    limits: AgentObservationLimits = field(default_factory=AgentObservationLimits)
    rpc_timeout_ms: int | None = None
@dataclass(frozen=True, slots=True)
class AgentObservationNode:
    element_id: AgentElementId
    tag: str
    id: str
    role: str
    name: str
    text: str
    value: str | None
    redacted: bool
@dataclass(frozen=True, slots=True)
class AgentObservation(AgentObservationContext):
    observation_id: AgentObservationId
    revision: int
    observed_at: str
    query: AgentObservationQuery
    limits: AgentObservationLimits
    url: str
    title: str
    nodes: tuple[AgentObservationNode, ...]
    visited: int
    truncated: bool
    stage: Literal['observed'] = field(default='observed',init=False)
    scope: Literal['main-document-light-dom'] = field(default='main-document-light-dom',init=False)

_CONTEXT = ['agentRunId','sessionId','version','binding','document']
_DOCUMENT = ['controlSessionId','pageEpoch','viewportVersion']
_LIMITS = ['maxNodes','maxChars','maxVisited']
_NODE = ['elementId','tag','id','role','name','text','value','redacted']
_RESULT = ['agentRunId','sessionId','stage','binding','document','observationId','revision','observedAt','version','scope','query','limits','url','title','nodes','visited','truncated']

@dataclass(frozen=True, slots=True)
class ObservationExpected:
    reference: AgentObservationReference
    context: AgentObservationContext | None = None
    request: AgentObservationInput | None = None

@dataclass(frozen=True, slots=True)
class AgentAccessibilityLimits:
    max_chars: int = 256
@dataclass(frozen=True, slots=True)
class AgentAccessibilityInput:
    element_id: AgentElementId
    limits: AgentAccessibilityLimits = field(default_factory=AgentAccessibilityLimits)
    rpc_timeout_ms: int | None = None
@dataclass(frozen=True, slots=True)
class AgentAccessibilityStates:
    disabled: bool | None = None
    focused: bool | None = None
    focusable: bool | None = None
    readonly: bool | None = None
    required: bool | None = None
    selected: bool | None = None
    multiline: bool | None = None
    multiselectable: bool | None = None
    expanded: bool | None = None
    modal: bool | None = None
    busy: bool | None = None
    checked: bool | Literal['mixed'] | None = None
    pressed: bool | Literal['mixed'] | None = None
@dataclass(frozen=True, slots=True)
class AgentAccessibilityProjection:
    ignored: bool
    role: str
    name: str
    description: str
    value: str | None
    states: AgentAccessibilityStates
@dataclass(frozen=True, slots=True)
class _AccessibilityObservation(AgentObservationContext):
    observation_id: AgentObservationId
    revision: int
    observed_at: str
    element_id: AgentElementId
    limits: AgentAccessibilityLimits
    url: str
    title: str
    truncated: bool
    stage: Literal['accessibility-observed'] = field(default='accessibility-observed',init=False)
    scope: Literal['main-document-element-accessibility'] = field(default='main-document-element-accessibility',init=False)
@dataclass(frozen=True, slots=True)
class AgentAccessibilityVisible(_AccessibilityObservation):
    ax: AgentAccessibilityProjection
    redacted: Literal[False] = field(default=False,init=False)
@dataclass(frozen=True, slots=True)
class AgentAccessibilityRedacted(_AccessibilityObservation):
    ax: None = field(default=None,init=False)
    redacted: Literal[True] = field(default=True,init=False)
AgentAccessibilityObservation = AgentAccessibilityVisible | AgentAccessibilityRedacted

@dataclass(frozen=True, slots=True)
class AccessibilityExpected:
    context: AgentObservationContext
    request: AgentAccessibilityInput

def _capture_accessibility(v: AgentAccessibilityInput) -> tuple[AgentAccessibilityInput,dict[str,Any]]:
    if type(v) is not AgentAccessibilityInput or not _id(v.element_id,'elh_') or type(v.limits) is not AgentAccessibilityLimits or not _integer(v.limits.max_chars,0,512):
        _invalid()
    _timeout(v.rpc_timeout_ms)
    captured = AgentAccessibilityInput(v.element_id,AgentAccessibilityLimits(v.limits.max_chars),v.rpc_timeout_ms)
    wire: dict[str,Any] = dict(elementId=captured.element_id,limits=dict(maxChars=captured.limits.max_chars))
    if captured.rpc_timeout_ms is not None:
        wire['rpcTimeoutMs'] = captured.rpc_timeout_ms
    return captured,wire

def validate_accessibility(status: int, v: Any, e: AccessibilityExpected, headers: httpx.Headers) -> AgentAccessibilityObservation:
    fields = ['agentRunId','sessionId','stage','binding','document','observationId','revision','observedAt','version','scope','elementId','limits','url','title','ax','redacted','truncated']
    if status!=200 or 'location' in headers or not _exact(v,fields):
        _fail()
    ctx = _decode_context({k:v[k]for k in _CONTEXT})
    if ctx!=e.context or v['stage']!='accessibility-observed' or v['scope']!='main-document-element-accessibility' or not _id(v['observationId'],'obs_') or not _integer(v['revision'],1,2**53-1) or not _canonical_date(v['observedAt']) or v['elementId']!=e.request.element_id or not _exact(v['limits'],['maxChars']) or not _integer(v['limits']['maxChars'],0,512) or v['limits']['maxChars']!=e.request.limits.max_chars or not _text(v['url'],1024,0) or not _text(v['title'],256,0) or type(v['redacted']) is not bool or type(v['truncated']) is not bool:
        _fail()
    if _byte_length(v)>8192 or _byte_length({k:value for k,value in v.items()if k not in ('agentRunId','sessionId')})>6144:
        _fail()
    args = dict(agent_run_id=ctx.agent_run_id,session_id=ctx.session_id,version=ctx.version,binding=ctx.binding,document=ctx.document,observation_id=AgentObservationId(v['observationId']),revision=v['revision'],observed_at=v['observedAt'],element_id=AgentElementId(v['elementId']),limits=AgentAccessibilityLimits(v['limits']['maxChars']),url=v['url'],title=v['title'],truncated=v['truncated'])
    ax = v['ax']
    if v['redacted']:
        if ax is not None:
            _fail()
        return AgentAccessibilityRedacted(**args)
    if not _exact(ax,['ignored','role','name','description','value','states']) or type(ax['ignored']) is not bool or not _text(ax['role'],64,0) or any(not _text(ax[k],512,0)for k in ['name','description']) or ax['value'] is not None and not _text(ax['value'],512,0):
        _fail()
    if len((ax['name']+ax['description']+(ax['value'] or '')).encode('utf-16-le',errors='surrogatepass'))//2>e.request.limits.max_chars:
        _fail()
    states = ax['states'];boolean = {'disabled','focused','focusable','readonly','required','selected','multiline','multiselectable','expanded','modal','busy'}
    if type(states) is not dict or any(k not in boolean|{'checked','pressed'} or (type(value) is not bool if k in boolean else type(value) is not bool and value!='mixed')for k,value in states.items()):
        _fail()
    return AgentAccessibilityVisible(**args,ax=AgentAccessibilityProjection(ax['ignored'],ax['role'],ax['name'],ax['description'],ax['value'],AgentAccessibilityStates(**states)))

def _context_wire(c: AgentObservationContext) -> dict[str,Any]:
    b,d = c.binding,c.document
    return dict(agentRunId=c.agent_run_id,sessionId=c.session_id,version=c.version,binding=dict(tenantId=b.tenant_id,sessionId=b.session_id,targetId=b.target_id,runId=b.run_id),document=dict(controlSessionId=d.control_session_id,pageEpoch=d.page_epoch,viewportVersion=d.viewport_version))

def _decode_context(v: Any) -> AgentObservationContext:
    if not _exact(v,_CONTEXT) or not _id(v['agentRunId'],'arun_') or not _id(v['sessionId'],'ses_') or not _text(v['version'],256) or not _binding(v['binding']) or v['binding']['sessionId']!=v['sessionId'] or not _exact(v['document'],_DOCUMENT):
        _fail()
    b,d = v['binding'],v['document']
    if not _uuid(d['controlSessionId']) or not _integer(d['pageEpoch'],1,2**53-1) or not _integer(d['viewportVersion'],1,2**53-1):
        _fail()
    return AgentObservationContext(AgentRunId(v['agentRunId']),SessionId(v['sessionId']),v['version'],AgentBinding(b['tenantId'],SessionId(b['sessionId']),b['targetId'],b['runId']),AgentObservationDocument(d['controlSessionId'],d['pageEpoch'],d['viewportVersion']))

def _reference(v: AgentObservationReference | AgentRun) -> AgentObservationReference:
    if type(v) not in (AgentObservationReference,AgentRun) or not _id(v.agent_run_id,'arun_') or not _id(v.session_id,'ses_') or not _text(v.version,256):
        _invalid()
    return AgentObservationReference(v.agent_run_id,v.session_id,v.version)

def _capture_context(v: AgentObservationContext) -> AgentObservationContext:
    if type(v) is not AgentObservationContext or type(v.binding) is not AgentBinding or type(v.document) is not AgentObservationDocument:
        _invalid()
    try:
        return _decode_context(_context_wire(v))
    except Exception:
        _invalid()

def _query_wire(q: AgentObservationQuery) -> dict[str,Any]:
    if type(q) is AgentSnapshotQuery and q.kind=='snapshot':
        return dict(kind='snapshot')
    if type(q) is AgentLocateQuery and q.kind=='locate' and type(q.by) is str and q.by in ('id','tag','testId') and _text(q.value,128) and re.search(r'[\x00-\x1f]',q.value) is None and (q.by!='tag' or re.fullmatch(r'[a-z][a-z0-9-]{0,63}',q.value) is not None):
        return dict(kind='locate',by=q.by,value=q.value)
    if type(q) is AgentElementQuery and q.kind=='element' and _id(q.element_id,'elh_'):
        return dict(kind='element',elementId=q.element_id)
    _invalid()

def _decode_query(v: Any) -> AgentObservationQuery:
    if _exact(v,['kind']) and v['kind']=='snapshot':
        return AgentSnapshotQuery()
    if _exact(v,['kind','by','value']) and v['kind']=='locate':
        q = AgentLocateQuery(v['by'],v['value']);_query_wire(q);return q
    if _exact(v,['kind','elementId']) and v['kind']=='element':
        e = AgentElementQuery(AgentElementId(v['elementId']));_query_wire(e);return e
    _fail()

def _limits_wire(v: AgentObservationLimits) -> dict[str,int]:
    if type(v) is not AgentObservationLimits or not _integer(v.max_nodes,1,16) or not _integer(v.max_chars,0,2048) or not _integer(v.max_visited,1,256):
        _invalid()
    return dict(maxNodes=v.max_nodes,maxChars=v.max_chars,maxVisited=v.max_visited)

def _decode_limits(v: Any) -> AgentObservationLimits:
    if not _exact(v,_LIMITS):
        _fail()
    result = AgentObservationLimits(v['maxNodes'],v['maxChars'],v['maxVisited']);_limits_wire(result);return result

def _capture_request(v: AgentObservationInput) -> tuple[AgentObservationInput,dict[str,Any]]:
    if type(v) is not AgentObservationInput:
        _invalid()
    _timeout(v.rpc_timeout_ms);q,l = _query_wire(v.query),_limits_wire(v.limits)
    captured = AgentObservationInput(_decode_query(q),_decode_limits(l),v.rpc_timeout_ms)
    wire: dict[str,Any] = dict(query=q,limits=l)
    if v.rpc_timeout_ms is not None:
        wire['rpcTimeoutMs'] = v.rpc_timeout_ms
    return captured,wire

def _canonical_date(v: Any) -> bool:
    if type(v) is not str or re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',v) is None:
        return False
    try:
        return datetime.fromisoformat(v[:-1]+'+00:00').isoformat(timespec='milliseconds').replace('+00:00','Z')==v
    except ValueError:
        return False

def _byte_length(v: Any) -> int:
    return len(json.dumps(v,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8',errors='backslashreplace'))

def validate_observation(status: int, v: Any, e: ObservationExpected, headers: httpx.Headers) -> AgentObservationContext | AgentObservation:
    if status!=200 or 'location' in headers:
        _fail()
    if e.context is None:
        ctx = _decode_context(v)
        if (ctx.agent_run_id,ctx.session_id,ctx.version)!=(e.reference.agent_run_id,e.reference.session_id,e.reference.version):
            _fail()
        return ctx
    if not _exact(v,_RESULT):
        _fail()
    ctx = _decode_context({k:v[k]for k in _CONTEXT})
    if ctx!=e.context or v['stage']!='observed' or v['scope']!='main-document-light-dom' or not _id(v['observationId'],'obs_') or not _integer(v['revision'],1,2**53-1) or not _canonical_date(v['observedAt']) or not _text(v['url'],1024,0) or not _text(v['title'],256,0) or type(v['truncated']) is not bool:
        _fail()
    try:
        q,l = _decode_query(v['query']),_decode_limits(v['limits'])
    except Exception:
        _fail()
    assert e.request is not None
    if q!=e.request.query or l!=e.request.limits or not _integer(v['visited'],0,l.max_visited) or type(v['nodes']) is not list or len(v['nodes'])>min(l.max_nodes,v['visited']):
        _fail()
    nodes: list[AgentObservationNode] = [];seen: set[str] = set();chars = 0
    for n in v['nodes']:
        if not _exact(n,_NODE) or not _id(n['elementId'],'elh_') or n['elementId'] in seen or not _text(n['tag'],32) or any(not _text(n[k],maximum,0)for k,maximum in [('id',64),('role',32),('name',64),('text',2048)]) or n['value'] is not None and not _text(n['value'],2048,0) or type(n['redacted']) is not bool or n['redacted'] and (n['value'] is not None or n['text']!=''):
            _fail()
        seen.add(n['elementId']);chars += len((n['text']+(n['value'] or '')).encode('utf-16-le',errors='surrogatepass'))//2
        nodes.append(AgentObservationNode(AgentElementId(n['elementId']),n['tag'],n['id'],n['role'],n['name'],n['text'],n['value'],n['redacted']))
    if chars>l.max_chars or type(q) is AgentElementQuery and (len(nodes)!=1 or v['visited']!=1) or _byte_length(v)>8192 or _byte_length({k:value for k,value in v.items()if k not in ('agentRunId','sessionId')})>6144:
        _fail()
    return AgentObservation(ctx.agent_run_id,ctx.session_id,ctx.version,ctx.binding,ctx.document,AgentObservationId(v['observationId']),v['revision'],v['observedAt'],q,l,v['url'],v['title'],tuple(nodes),v['visited'],v['truncated'])

class _Observations:
    def __init__(self, transport: BackendTransport) -> None:
        self._transport = transport
    def context(self, run: AgentObservationReference | AgentRun) -> Coroutine[Any,Any,ApiResult[AgentObservationContext]]:
        reference = _reference(run)
        async def send() -> ApiResult[AgentObservationContext]:
            return cast(ApiResult[AgentObservationContext],await self._transport.request('GET','/v1/agent-runs/'+reference.agent_run_id+'/observation-context',None,None,ObservationExpected(reference),0))
        return send()
    def read(self, context: AgentObservationContext, value: AgentObservationInput) -> Coroutine[Any,Any,ApiResult[AgentObservation]]:
        ctx = _capture_context(context);request,wire = _capture_request(value)
        payload = _body(dict(context=_context_wire(ctx),**wire));expected = ObservationExpected(AgentObservationReference(ctx.agent_run_id,ctx.session_id,ctx.version),ctx,request)
        async def send() -> ApiResult[AgentObservation]:
            return cast(ApiResult[AgentObservation],await self._transport.request('POST','/v1/agent-runs/'+ctx.agent_run_id+'/observations',payload,None,expected,0))
        return send()
    def accessibility(self, context: AgentObservationContext, value: AgentAccessibilityInput) -> Coroutine[Any,Any,ApiResult[AgentAccessibilityObservation]]:
        ctx = _capture_context(context);request,wire = _capture_accessibility(value)
        payload = _body(dict(context=_context_wire(ctx),**wire));expected = AccessibilityExpected(ctx,request)
        async def send() -> ApiResult[AgentAccessibilityObservation]:
            return cast(ApiResult[AgentAccessibilityObservation],await self._transport.request('POST','/v1/agent-runs/'+ctx.agent_run_id+'/accessibility-observations',payload,None,expected,0))
        return send()
