"""Frozen actual Page download models and single-attempt bounded reads."""
from __future__ import annotations
import asyncio
import base64
import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Coroutine, Literal, NewType, NoReturn
import httpx
from ._agent import AgentClientError, _body, _exact, _fail, _id, _invalid, _timeout
from ._client import _integer
from ._observation import AgentObservationContext, _capture_context, _context_wire, _decode_context, _canonical_date, _byte_length, _hash, _CONTEXT
from ._transport import ApiResult, BackendTransport, RequestId

AgentDownloadId = NewType('AgentDownloadId',str)
@dataclass(frozen=True,slots=True)
class AgentDownloadLimits:
    max_bytes: int = 1048576
    timeout_ms: int = 10000
@dataclass(frozen=True,slots=True)
class AgentDownloadArmInput:
    limits: AgentDownloadLimits = field(default_factory=AgentDownloadLimits)
    rpc_timeout_ms: int | None = None
@dataclass(frozen=True,slots=True)
class AgentDownloadTicketInput:
    download_id: AgentDownloadId
    rpc_timeout_ms: int | None = None
@dataclass(frozen=True,slots=True)
class AgentDownloadChunkInput:
    download_id: AgentDownloadId
    offset: int
    max_bytes: int = 3072
    rpc_timeout_ms: int | None = None
@dataclass(frozen=True,slots=True)
class AgentDownloadFileInput:
    download_id: AgentDownloadId
    sha256: str
    byte_length: int
    completed_at: str
    rpc_timeout_ms: int | None = None
@dataclass(frozen=True,slots=True)
class AgentDownloadTicket(AgentObservationContext):
    download_id: AgentDownloadId
    armed_at: str
    limits: AgentDownloadLimits
    scope: Literal['next-owned-page-download'] = field(default='next-owned-page-download',init=False)
@dataclass(frozen=True,slots=True)
class AgentDownloadArmed(AgentDownloadTicket):
    stage: Literal['download-armed'] = field(default='download-armed',init=False)
@dataclass(frozen=True,slots=True)
class AgentDownloadPending(AgentDownloadTicket):
    stage: Literal['download-pending'] = field(default='download-pending',init=False)
@dataclass(frozen=True,slots=True)
class AgentDownloadReady(AgentDownloadTicket):
    completed_at: str
    file_name: str
    byte_length: int
    sha256: str
    stage: Literal['download-ready'] = field(default='download-ready',init=False)
    mime_type: Literal['application/octet-stream'] = field(default='application/octet-stream',init=False)
AgentDownloadInfo = AgentDownloadPending | AgentDownloadReady
@dataclass(frozen=True,slots=True)
class AgentDownloadChunk(AgentObservationContext):
    download_id: AgentDownloadId
    sha256: str
    completed_at: str
    offset: int
    byte_length: int
    total_bytes: int
    data: str
    complete: bool
    stage: Literal['download-chunk'] = field(default='download-chunk',init=False)
@dataclass(frozen=True,slots=True)
class AgentDownloadReleased(AgentObservationContext):
    download_id: AgentDownloadId
    stage: Literal['download-released'] = field(default='download-released',init=False)
@dataclass(frozen=True,slots=True)
class AgentDownloadFile(AgentObservationContext):
    download_id: AgentDownloadId
    sha256: str
    byte_length: int
    completed_at: str
    content: bytes
    stage: Literal['download-delivered'] = field(default='download-delivered',init=False)
    mime_type: Literal['application/octet-stream'] = field(default='application/octet-stream',init=False)
DownloadInput = AgentDownloadArmInput | AgentDownloadTicketInput | AgentDownloadChunkInput | AgentDownloadFileInput
DownloadKind = Literal['armed','info','chunk','release','file']
@dataclass(frozen=True,slots=True)
class DownloadExpected:
    context: AgentObservationContext
    request: DownloadInput
    kind: DownloadKind
_EMPTY = hashlib.sha256(b'').hexdigest()
_BASE = ['agentRunId','sessionId','version','binding','document','stage','downloadId']
_META = _BASE+['scope','armedAt','limits']
_READY = _META+['completedAt','fileName','mimeType','byteLength','sha256']
_CHUNK = _BASE+['sha256','completedAt','offset','byteLength','totalBytes','data','complete']

def _capture(v: DownloadInput, kind: DownloadKind, cap: int) -> tuple[DownloadInput,dict[str,Any]]:
    if kind=='armed':
        if type(v) is not AgentDownloadArmInput or type(v.limits) is not AgentDownloadLimits or not _integer(v.limits.max_bytes,1,4194304) or not _integer(v.limits.timeout_ms,50,30000):
            _invalid()
        captured: DownloadInput = AgentDownloadArmInput(AgentDownloadLimits(v.limits.max_bytes,v.limits.timeout_ms),v.rpc_timeout_ms)
        wire: dict[str,Any] = dict(limits=dict(maxBytes=v.limits.max_bytes,timeoutMs=v.limits.timeout_ms))
    else:
        cls = AgentDownloadChunkInput if kind=='chunk' else AgentDownloadFileInput if kind=='file' else AgentDownloadTicketInput
        if type(v) is not cls:
            _invalid()
        assert isinstance(v,(AgentDownloadTicketInput,AgentDownloadChunkInput,AgentDownloadFileInput))
        if not _id(v.download_id,'dl_'):
            _invalid()
        wire = dict(downloadId=v.download_id)
        if isinstance(v,AgentDownloadChunkInput):
            if not _integer(v.offset,0,4194304) or not _integer(v.max_bytes,1,3072):
                _invalid()
            captured = AgentDownloadChunkInput(v.download_id,v.offset,v.max_bytes,v.rpc_timeout_ms);wire.update(offset=v.offset,maxBytes=v.max_bytes)
        elif isinstance(v,AgentDownloadFileInput):
            if not _hash(v.sha256) or not _integer(v.byte_length,0,cap) or v.byte_length==0 and v.sha256!=_EMPTY or not _canonical_date(v.completed_at):
                _invalid()
            captured = AgentDownloadFileInput(v.download_id,v.sha256,v.byte_length,v.completed_at,v.rpc_timeout_ms);wire.update(sha256=v.sha256,byteLength=v.byte_length,completedAt=v.completed_at)
        else:
            captured = AgentDownloadTicketInput(v.download_id,v.rpc_timeout_ms)
    _timeout(v.rpc_timeout_ms)
    if v.rpc_timeout_ms is not None:
        wire['rpcTimeoutMs'] = v.rpc_timeout_ms
    return captured,wire

def send_download(transport: BackendTransport, kind: DownloadKind, context: AgentObservationContext, value: DownloadInput) -> Coroutine[Any,Any,ApiResult[Any]]:
    ctx = _capture_context(context);request,wire = _capture(value,kind,transport.download_max_bytes)
    payload = _body(dict(context=_context_wire(ctx),**wire));expected = DownloadExpected(ctx,request,kind)
    async def send() -> ApiResult[Any]:
        suffix = {'armed':'arms','info':'observations','chunk':'chunks','release':'releases','file':'files'}[kind]
        return await transport.request('POST','/v1/agent-runs/'+ctx.agent_run_id+'/download-'+suffix,payload,None,expected,0)
    return send()

def _name(v: Any) -> bool:
    return type(v) is str and 1<=len(v)<=64 and unicodedata.normalize('NFC',v)==v and re.search(r'[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\\/]',v) is None and not v.startswith('.') and not v.endswith((' ','.'))

def validate_download(status: int, v: Any, e: DownloadExpected, headers: httpx.Headers) -> AgentDownloadArmed | AgentDownloadInfo | AgentDownloadChunk | AgentDownloadReleased:
    ready = e.kind=='info' and type(v) is dict and v.get('stage')=='download-ready'
    fields = _META if e.kind=='armed' or e.kind=='info' and not ready else _READY if e.kind=='info' else _CHUNK if e.kind=='chunk' else _BASE
    if status!=200 or 'location'in headers or not _exact(v,fields):
        _fail()
    ctx = _decode_context({k:v[k]for k in _CONTEXT})
    if ctx!=e.context or not _id(v['downloadId'],'dl_') or not isinstance(e.request,AgentDownloadArmInput) and v['downloadId']!=e.request.download_id or _byte_length(v)>8192 or _byte_length({k:x for k,x in v.items()if k not in ('agentRunId','sessionId')})>6144:
        _fail()
    args: dict[str,Any] = dict(agent_run_id=ctx.agent_run_id,session_id=ctx.session_id,version=ctx.version,binding=ctx.binding,document=ctx.document,download_id=AgentDownloadId(v['downloadId']))
    if e.kind=='release':
        if v['stage']!='download-released':
            _fail()
        return AgentDownloadReleased(**args)
    if e.kind in ('armed','info'):
        l = v['limits']
        if v['stage']!=('download-armed'if e.kind=='armed'else'download-ready'if ready else'download-pending') or v['scope']!='next-owned-page-download' or not _canonical_date(v['armedAt']) or not _exact(l,['maxBytes','timeoutMs']) or not _integer(l['maxBytes'],1,4194304) or not _integer(l['timeoutMs'],50,30000):
            _fail()
        if isinstance(e.request,AgentDownloadArmInput) and (l['maxBytes']!=e.request.limits.max_bytes or l['timeoutMs']!=e.request.limits.timeout_ms):
            _fail()
        args.update(armed_at=v['armedAt'],limits=AgentDownloadLimits(l['maxBytes'],l['timeoutMs']))
        if e.kind=='armed':
            return AgentDownloadArmed(**args)
        if not ready:
            return AgentDownloadPending(**args)
        if not _canonical_date(v['completedAt']) or v['completedAt']<v['armedAt'] or not _name(v['fileName']) or v['mimeType']!='application/octet-stream' or not _integer(v['byteLength'],0,l['maxBytes']) or not _hash(v['sha256']) or v['byteLength']==0 and v['sha256']!=_EMPTY:
            _fail()
        return AgentDownloadReady(**args,completed_at=v['completedAt'],file_name=v['fileName'],byte_length=v['byteLength'],sha256=v['sha256'])
    assert isinstance(e.request,AgentDownloadChunkInput)
    if v['stage']!='download-chunk' or not _hash(v['sha256']) or not _canonical_date(v['completedAt']) or not _integer(v['offset'],0,4194304) or v['offset']!=e.request.offset or not _integer(v['totalBytes'],0,4194304) or v['offset']>v['totalBytes'] or not _integer(v['byteLength'],0,3072) or v['byteLength']!=min(e.request.max_bytes,v['totalBytes']-v['offset']) or type(v['data']) is not str or len(v['data'])>4096 or len(v['data'])%4!=0 or re.fullmatch(r'[A-Za-z0-9+/]*={0,2}',v['data']) is None or type(v['complete']) is not bool or v['complete']!=(v['offset']+v['byteLength']==v['totalBytes']) or v['byteLength']==0 and not v['complete'] or v['totalBytes']==0 and v['sha256']!=_EMPTY:
        _fail()
    try:
        decoded = base64.b64decode(v['data'],validate=True)
        if len(decoded)!=v['byteLength'] or base64.b64encode(decoded).decode('ascii')!=v['data']:
            _fail()
    except ValueError:
        _fail()
    return AgentDownloadChunk(**args,sha256=v['sha256'],completed_at=v['completedAt'],offset=v['offset'],byte_length=v['byteLength'],total_bytes=v['totalBytes'],data=v['data'],complete=v['complete'])

def is_download_file(e: Any) -> bool:
    return isinstance(e,DownloadExpected) and e.kind=='file'

async def read_download_binary(response: httpx.Response, e: Any, cap: int) -> ApiResult[AgentDownloadFile]:
    assert isinstance(e,DownloadExpected) and isinstance(e.request,AgentDownloadFileInput)
    r,h = e.request,response.headers
    def reject() -> NoReturn:
        raise AgentClientError('CLIENT_INVALID_RESPONSE',status=response.status_code) from None
    request_id = h.get('x-request-id','')
    if response.status_code!=200 or 'location'in h or 'content-encoding'in h or h.get('content-type','').lower()!='application/octet-stream' or h.get('content-length')!=str(r.byte_length) or r.byte_length>cap or h.get('cache-control')!='no-store' or h.get('x-content-type-options')!='nosniff' or h.get('content-disposition')!='attachment; filename="'+r.download_id+'.bin"' or h.get('content-digest')!='sha-256=:'+base64.b64encode(bytes.fromhex(r.sha256)).decode('ascii')+':' or h.get('x-download-id')!=r.download_id or h.get('x-download-sha256')!=r.sha256 or h.get('x-download-completed-at')!=r.completed_at or re.fullmatch(r'req_[A-Za-z0-9_-]{1,124}',request_id) is None:
        reject()
    encoded = h.get('x-agent-observation-context','')
    if len(encoded)>4096 or re.fullmatch(r'[A-Za-z0-9_-]+',encoded) is None:
        reject()
    try:
        raw = base64.b64decode(encoded+'='*((4-len(encoded)%4)%4),altchars=b'-_',validate=True)
        if base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')!=encoded or _decode_context(json.loads(raw.decode('utf-8')))!=e.context:
            reject()
    except (ValueError,UnicodeError,RecursionError,AgentClientError):
        reject()
    buffer = bytearray(r.byte_length);digest = hashlib.sha256();size = 0;chunks = 0
    def consume(chunk: bytes) -> None:
        nonlocal size
        if type(chunk) is not bytes or size+len(chunk)>len(buffer):
            reject()
        end = size+len(chunk);buffer[size:end] = chunk;digest.update(memoryview(buffer)[size:end]);size = end
    if response.is_stream_consumed:
        consume(response.content)
    else:
        async for chunk in response.aiter_raw():
            consume(chunk);chunks += 1
            if chunks%128==0:
                await asyncio.sleep(0)
    if size!=r.byte_length or digest.hexdigest()!=r.sha256:
        reject()
    ctx = e.context
    return ApiResult(AgentDownloadFile(ctx.agent_run_id,ctx.session_id,ctx.version,ctx.binding,ctx.document,r.download_id,r.sha256,size,r.completed_at,bytes(buffer)),RequestId(request_id))
