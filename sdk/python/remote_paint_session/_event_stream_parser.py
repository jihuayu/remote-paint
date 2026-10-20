"""Private bounded SSE decoder. Window retirement is not an IO cleanup receipt."""
from __future__ import annotations
import json
import re
from dataclasses import dataclass,field
from typing import Any,Literal,NoReturn,cast
from ._agent import AgentClientError,AgentRunId,_exact,_id,_invalid
from ._client import _integer
from ._events import (AgentEvent,AgentEventCursor,AgentEventGap,AgentEventId,AgentHistoryOrigin,
    _bounds,decode_event,decode_event_gap,event_cursor,event_sequence)
from ._observation import _canonical_date
from ._transport import Outcome,RequestId

@dataclass(frozen=True,slots=True)
class AgentEventReady:
    agent_run_id: AgentRunId
    history_origin: AgentHistoryOrigin
    after: AgentEventCursor
    oldest_cursor: AgentEventCursor
    latest_cursor: AgentEventCursor
    cursor: AgentEventCursor
    schema: Literal['agent-event-stream-v1']=field(default='agent-event-stream-v1',init=False)
@dataclass(frozen=True,slots=True)
class AgentEventHeartbeat:
    agent_run_id: AgentRunId
    cursor: AgentEventCursor
    observed_at: str
    schema: Literal['agent-heartbeat-v1']=field(default='agent-heartbeat-v1',init=False)
@dataclass(frozen=True,slots=True)
class AgentEventCheckpoint:
    agent_run_id: AgentRunId
    cursor: AgentEventCursor
    reason: Literal['duration','events','bytes']
    schema: Literal['agent-event-checkpoint-v1']=field(default='agent-event-checkpoint-v1',init=False)
@dataclass(frozen=True,slots=True)
class _MessageBase:
    cursor: AgentEventCursor
    request_id: RequestId
@dataclass(frozen=True,slots=True)
class AgentEventItem(_MessageBase):
    event: AgentEvent
    kind: Literal['event']=field(default='event',init=False)
@dataclass(frozen=True,slots=True)
class AgentReadyMessage(_MessageBase):
    data: AgentEventReady
    kind: Literal['ready']=field(default='ready',init=False)
@dataclass(frozen=True,slots=True)
class AgentHeartbeatMessage(_MessageBase):
    data: AgentEventHeartbeat
    kind: Literal['heartbeat']=field(default='heartbeat',init=False)
@dataclass(frozen=True,slots=True)
class AgentCheckpointMessage(_MessageBase):
    data: AgentEventCheckpoint
    kind: Literal['checkpoint']=field(default='checkpoint',init=False)
AgentEventMessage=AgentEventItem|AgentReadyMessage|AgentHeartbeatMessage|AgentCheckpointMessage

@dataclass(frozen=True,slots=True)
class _Pending:
    message: AgentEventMessage
    advance_to: AgentEventCursor | None=None
    event_id: AgentEventId | None=None
@dataclass(frozen=True,slots=True)
class _Failure:
    code: str
    cursor: AgentEventCursor
    request_id: RequestId | None
    status: int | None=None
    outcome: Outcome='unknown'
    retryable: bool=False
    details: AgentEventGap | None=None
@dataclass(frozen=True,slots=True)
class _DecoderStatus:
    last_delivered_cursor: AgentEventCursor
    windows: int
    received_bytes: int
    decoded_events: int
    window_events: int
    retained_event_ids: int
    retained_chunk_bytes: int
    unconsumed_chunk_bytes: int
    frame_bytes: int
    pending_message: bool
    active_window: bool
    failed: bool

def _unique_object(pairs: list[tuple[str,Any]]) -> dict[str,Any]:
    result: dict[str,Any]={}
    for key,value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON field')
        result[key]=value
    return result
def _reject_constant(value: str) -> NoReturn:
    raise ValueError('Non-JSON constant')

class _AgentSseDecoder:
    """One retained chunk/frame/pending message, bounded work per pull.

    pull() returning None with has_buffered_bytes means the IO owner must
    yield cooperatively before pulling again. It must not read another chunk.
    acknowledge() belongs at successful public delivery, not at raw parsing.
    discard_window() never authorizes freeing actual send/read/close capacity.
    """
    def __init__(self,run: AgentRunId,*,after: AgentEventCursor | None=None,max_bytes: int=262144,max_windows: int=4) -> None:
        if not _id(run,'arun_') or after is not None and event_sequence(after,run) is None or not _integer(max_bytes,4096,1048576) or not _integer(max_windows,1,4):
            _invalid()
        self._run=run;self._cursor=after if after is not None else event_cursor(run,0)
        self._max_bytes,self._max_windows=max_bytes,max_windows
        self._request_id: RequestId | None=None
        self._windows=self._bytes=self._events=self._window_events=0
        self._chunk: bytes | None=None;self._offset=0
        self._frame=bytearray();self._line_length=self._previous_byte=0
        self._active=self._ready=self._checkpoint=False
        self._history: AgentHistoryOrigin | None=None
        self._identity: tuple[str,str,str] | None=None
        self._seen: set[AgentEventId]=set()
        self._pending: _Pending | None=None
        # Retain error metadata, never a traceback holding an oversized input.
        self._failure: _Failure | None=None

    @property
    def last_delivered_cursor(self) -> AgentEventCursor:
        return self._cursor
    @property
    def has_buffered_bytes(self) -> bool:
        return self._chunk is not None
    def status(self) -> _DecoderStatus:
        length=0 if self._chunk is None else len(self._chunk)
        return _DecoderStatus(self._cursor,self._windows,self._bytes,self._events,self._window_events,len(self._seen),length,0 if not length else length-self._offset,len(self._frame),self._pending is not None,self._active,self._failure is not None)
    def _exception(self,record: _Failure) -> AgentClientError:
        return AgentClientError(record.code,cursor=record.cursor,request_id=record.request_id,status=record.status,outcome=record.outcome,retryable=record.retryable,details=record.details)
    def _make(self,code: str,*,status: int | None=None,outcome: Outcome='unknown',retryable: bool=False,details: AgentEventGap | None=None) -> AgentClientError:
        return self._exception(_Failure(code,self._cursor,self._request_id,status,outcome,retryable,details))
    def _fault(self,code: str='CLIENT_INVALID_RESPONSE',*,status: int | None=None,details: AgentEventGap | None=None,outcome: Outcome='unknown') -> NoReturn:
        self._failure=_Failure(code,self._cursor,self._request_id,status,outcome,False,details)
        raise self._exception(self._failure) from None
    def _check(self,*,active: bool=True) -> None:
        if self._failure is not None:
            raise self._exception(self._failure) from None
        if active and not self._active:
            _invalid()
    def begin_window(self,request_id: RequestId) -> None:
        self._check(active=False)
        if self._active:
            raise self._make('CLIENT_EVENT_STREAM_BUSY',outcome='not-dispatched') from None
        self._request_id=None
        if type(request_id) is not str or re.fullmatch(r'req_[A-Za-z0-9_-]{1,124}',request_id) is None:
            self._fault()
        if self._windows>=self._max_windows:
            self._fault('CLIENT_EVENT_STREAM_LIMIT')
        self._windows+=1;self._request_id=request_id;self._active=True
        self._window_events=0;self._ready=self._checkpoint=False
    def offer_chunk(self,data: bytes) -> None:
        self._check()
        if self._pending is not None or self._chunk is not None:
            raise self._make('CLIENT_EVENT_STREAM_BUSY',outcome='not-dispatched') from None
        if type(data) is not bytes or not data:
            self._fault()
        self.account_external_bytes(len(data))
        self._chunk=data;self._offset=0
    def account_external_bytes(self,count: int) -> None:
        self._check(active=False)
        if not _integer(count,0,2**53-1):
            _invalid()
        self._bytes+=count
        if self._bytes>self._max_bytes:
            self._fault('CLIENT_EVENT_STREAM_LIMIT')
    def pull(self) -> AgentEventMessage | None:
        self._check()
        if self._pending is not None:
            raise self._make('CLIENT_EVENT_STREAM_BUSY',outcome='not-dispatched') from None
        scanned=0
        while self._chunk is not None and scanned<8192:
            byte=self._chunk[self._offset];self._offset+=1;scanned+=1
            if self._offset==len(self._chunk):
                self._chunk=None;self._offset=0
            if len(self._frame)>=4096:
                self._fault('CLIENT_EVENT_STREAM_LIMIT')
            self._frame.append(byte)
            if byte==10:
                blank=self._line_length==0 or self._line_length==1 and self._previous_byte==13
                self._line_length=0;self._previous_byte=byte
                if blank:
                    raw=bytes(self._frame);self._frame.clear()
                    message=self._parse(raw)
                    if message is not None:
                        return message
            else:
                self._line_length+=1;self._previous_byte=byte
        return None
    def _parse(self,raw: bytes) -> AgentEventMessage | None:
        try:
            text=raw.decode('utf-8',errors='strict')
        except UnicodeError:
            self._fault()
        fields: dict[str,str]={}
        for line in text.split('\n'):
            if line.endswith('\r'):
                line=line[:-1]
            if not line or line.startswith(':'):
                continue
            if ':' not in line:
                self._fault()
            key,value=line.split(':',1)
            if value.startswith(' '):
                value=value[1:]
            if key not in ('event','id','data') or key in fields:
                self._fault()
            fields[key]=value
        if not fields:
            return None
        if self._checkpoint or not {'event','data'}<=set(fields):
            self._fault()
        try:
            value=json.loads(fields['data'],parse_constant=_reject_constant,object_pairs_hook=_unique_object)
        except (ValueError,UnicodeError,RecursionError):
            self._fault()
        try:
            pending=self._decode(fields,value)
        except AgentClientError:
            if self._failure is not None:
                raise
            self._fault()
        self._pending=pending
        return pending.message
    def _decode(self,fields: dict[str,str],v: Any) -> _Pending:
        name=fields['event'];has_id='id' in fields
        assert self._request_id is not None
        if name=='ready':
            if self._ready or has_id or not _exact(v,['schema','agentRunId','historyOrigin','after','oldestCursor','latestCursor','cursor']) or v['schema']!='agent-event-stream-v1' or v['cursor']!=self._cursor or v['after']!=self._cursor:
                self._fault()
            after,oldest,latest=_bounds(v,self._run)
            if not oldest<=after<=latest or self._history is not None and v['historyOrigin']!=self._history:
                self._fault()
            self._ready=True;self._history=v['historyOrigin']
            ready=AgentEventReady(self._run,v['historyOrigin'],AgentEventCursor(v['after']),AgentEventCursor(v['oldestCursor']),AgentEventCursor(v['latestCursor']),self._cursor)
            return _Pending(AgentReadyMessage(self._cursor,self._request_id,ready))
        if not self._ready:
            self._fault()
        if name=='agent':
            if not has_id:
                self._fault()
            event=decode_event(v,self._run);cursor=event_cursor(self._run,event.sequence)
            if event.sequence!=cast(int,event_sequence(self._cursor,self._run))+1 or fields['id']!=cursor or event.event_id in self._seen:
                self._fault()
            if self._window_events>=64 or self._events>=256:
                self._fault('CLIENT_EVENT_STREAM_LIMIT')
            identity=(event.session_id,event.region,event.version)
            if self._identity is not None and self._identity!=identity:
                self._fault()
            self._identity=identity;self._events+=1;self._window_events+=1
            return _Pending(AgentEventItem(cursor,self._request_id,event),cursor,event.event_id)
        if has_id:
            self._fault()
        if name=='heartbeat':
            if not _exact(v,['schema','agentRunId','cursor','observedAt']) or v['schema']!='agent-heartbeat-v1' or v['agentRunId']!=self._run or v['cursor']!=self._cursor or not _canonical_date(v['observedAt']):
                self._fault()
            return _Pending(AgentHeartbeatMessage(self._cursor,self._request_id,AgentEventHeartbeat(self._run,self._cursor,v['observedAt'])))
        if name=='checkpoint':
            if not _exact(v,['schema','agentRunId','cursor','reason']) or v['schema']!='agent-event-checkpoint-v1' or v['agentRunId']!=self._run or v['cursor']!=self._cursor or v['reason'] not in ('duration','events','bytes'):
                self._fault()
            self._checkpoint=True
            return _Pending(AgentCheckpointMessage(self._cursor,self._request_id,AgentEventCheckpoint(self._run,self._cursor,v['reason'])))
        if name=='gap':
            details=decode_event_gap(v,self._run,self._cursor)
            if details.history_origin!=self._history:
                self._fault()
            self._fault('AGENT_EVENT_GAP',status=200,details=details,outcome='not-dispatched')
        self._fault()
    def acknowledge(self,message: AgentEventMessage) -> None:
        self._check()
        if self._pending is None or message is not self._pending.message:
            _invalid()
        # Capture came from the validated bytes, not from caller-mutated data.
        if self._pending.advance_to is not None:
            assert self._pending.event_id is not None
            self._cursor=self._pending.advance_to;self._seen.add(self._pending.event_id)
        self._pending=None
    def end_of_file(self) -> None:
        self._check()
        if self._pending is not None or self._chunk is not None:
            raise self._make('CLIENT_EVENT_STREAM_BUSY',outcome='not-dispatched') from None
        interrupted=bool(self._frame) or not self._checkpoint
        self.discard_window()
        if interrupted:
            raise self._make('CLIENT_EVENT_STREAM_INTERRUPTED',retryable=True) from None
    def discard_window(self) -> None:
        self._active=self._ready=self._checkpoint=False
        self._chunk=None;self._offset=0;self._frame.clear();self._line_length=self._previous_byte=0;self._pending=None
