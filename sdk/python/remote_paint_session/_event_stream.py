"""Bounded demand-driven HTTPX event streams with actual cleanup ownership."""
from __future__ import annotations
import asyncio
import re
from dataclasses import dataclass
from typing import Any,AsyncIterator,Awaitable,Callable,cast
import httpx
from ._agent import AgentClientError,AgentClientCancelledError,AgentRunId,_invalid
from ._client import _integer
from ._events import AgentEventCursor,AgentEventGap,EventExpected
from ._event_stream_parser import AgentEventMessage,_AgentSseDecoder,_Failure
from ._transport import BackendTransport,Outcome,RequestId

@dataclass(frozen=True,slots=True)
class AgentEventTransportStatus:
    streams: int

async def _one_content(data: bytes) -> AsyncIterator[bytes]:
    if data:
        yield data

class _Window:
    def __init__(self,http: httpx.AsyncClient,request: httpx.Request) -> None:
        self.response: httpx.Response | None=None
        self.iterator: AsyncIterator[bytes] | None=None
        self.reading: asyncio.Task[bytes] | None=None
        self.closing: asyncio.Task[None] | None=None
        async def send() -> httpx.Response:
            self.response=await http.send(request,stream=True,follow_redirects=False)
            http.cookies.clear()
            return self.response
        self.sending=asyncio.create_task(send());self.sending.add_done_callback(BackendTransport._observe)
    def attach_reader(self) -> None:
        assert self.response is not None
        if not isinstance(self.response.stream,httpx.AsyncByteStream):
            raise AgentClientError('CLIENT_INVALID_RESPONSE') from None
        self.iterator=_one_content(self.response.content) if self.response.is_stream_consumed else self.response.stream.__aiter__()
    async def read(self) -> bytes:
        assert self.iterator is not None
        iterator=self.iterator
        async def read_next() -> bytes:
            return await anext(iterator)
        self.reading=asyncio.create_task(read_next());self.reading.add_done_callback(BackendTransport._observe)
        return await asyncio.shield(self.reading)
    def close(self) -> asyncio.Task[None]:
        if self.closing is None:
            async def close() -> None:
                await asyncio.gather(self.sending,return_exceptions=True)
                if self.response is not None:
                    # HTTPX sets is_closed before awaiting the underlying close.
                    # This exact Task, not that flag, is the retirement receipt.
                    await self.response.aclose()
                if self.reading is not None:
                    await asyncio.gather(self.reading,return_exceptions=True)
                if self.iterator is not None:
                    close_iterator=getattr(self.iterator,'aclose',None)
                    if close_iterator is not None:
                        await cast(Callable[[],Awaitable[None]],close_iterator)()
                self.iterator=None;self.reading=None
            self.closing=asyncio.create_task(close());self.closing.add_done_callback(BackendTransport._observe)
        return self.closing

class _AgentEventStreams:
    def __init__(self,transport: BackendTransport,*,http_transport: httpx.AsyncBaseTransport | None,max_streams: int,timeout_seconds: float,max_bytes: int) -> None:
        if not _integer(max_streams,1,64) or type(timeout_seconds) not in (int,float) or not .1<=timeout_seconds<=120 or not _integer(max_bytes,4096,1048576):
            _invalid()
        self.backend=transport;self.maximum=max_streams;self.timeout=float(timeout_seconds);self.max_bytes=max_bytes
        self._http_transport=http_transport;self._http: httpx.AsyncClient | None=None
        self.streams: set[AgentEventStream]=set();self.closed=False
        self._shutdown: asyncio.Task[None] | None=None
    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http=httpx.AsyncClient(transport=self._http_transport,limits=httpx.Limits(max_connections=self.maximum,max_keepalive_connections=0),trust_env=False,follow_redirects=False,timeout=self.timeout)
        return self._http
    def create(self,run: AgentRunId,*,after: AgentEventCursor | None=None,reconnects: int=3) -> AgentEventStream:
        self.backend.ensure_open()
        if self.closed:
            raise AgentClientError('CLIENT_CLOSED',outcome='not-dispatched') from None
        if not _integer(reconnects,0,3):
            _invalid()
        decoder=_AgentSseDecoder(run,after=after,max_bytes=self.max_bytes,max_windows=reconnects+1)
        return AgentEventStream(self,run,decoder,reconnects+1)
    def status(self) -> AgentEventTransportStatus:
        return AgentEventTransportStatus(len(self.streams))
    async def shutdown(self) -> None:
        if self._shutdown is None:
            self.closed=True;streams=tuple(self.streams)
            for stream in streams:
                stream._stop(None,mode='close')
            async def close() -> None:
                tasks=[s._cleanup for s in streams if s._cleanup is not None]
                results=await asyncio.gather(*tasks,return_exceptions=True)
                if any(isinstance(r,BaseException) for r in results):
                    raise AgentClientError('CLIENT_EVENT_STREAM_CLEANUP_FAILED') from None
                if self._http is not None:
                    await self._http.aclose()
            self._shutdown=asyncio.create_task(close());self._shutdown.add_done_callback(BackendTransport._observe)
        await asyncio.shield(self._shutdown)

class AgentEventStream:
    """Lazy async iterator/context manager; aclose never ends the Source Run."""
    def __init__(self,owner: _AgentEventStreams,run: AgentRunId,decoder: _AgentSseDecoder,attempts: int) -> None:
        self._owner,self._run,self._decoder,self._max_attempts=owner,run,decoder,attempts
        self._started=self._stopped=self._busy=False
        self._terminal: _Failure | None=None;self._wake_reason: _Failure | None=None
        self._signal: asyncio.Future[None] | None=None;self._timer: asyncio.TimerHandle | None=None
        self._window: _Window | None=None;self._request_id: RequestId | None=None
        self._pull: asyncio.Task[AgentEventMessage | None] | None=None
        self._cleanup: asyncio.Task[None] | None=None;self._attempts=0
    def __aiter__(self) -> AgentEventStream:
        return self
    async def __aenter__(self) -> AgentEventStream:
        self._owner.backend.ensure_open()
        if self._stopped:
            raise AgentClientError('CLIENT_CLOSED',outcome='not-dispatched') from None
        return self
    async def __aexit__(self,exc_type: Any,exc: Any,tb: Any) -> None:
        if exc is None:
            await self.aclose()
        else:
            self._stop(None,mode='close')
            if self._cleanup is not None:
                # Preserve the original application/Task exception. Actual
                # cleanup remains owned and counted after this local grace.
                await asyncio.wait({self._cleanup},timeout=.01)
    def _record(self,code: str,*,status: int | None=None,outcome: Outcome | None=None,retryable: bool=False,details: AgentEventGap | None=None,request_id: RequestId | None=None) -> _Failure:
        return _Failure(code,self._decoder.last_delivered_cursor,self._request_id if request_id is None else request_id,status,('unknown' if self._attempts else 'not-dispatched') if outcome is None else outcome,retryable,details)
    def _from_error(self,error: BaseException) -> _Failure:
        if isinstance(error,AgentClientError):
            details=error.details if type(error.details) is AgentEventGap else None
            request_id=error.request_id if type(error.request_id) is str and re.fullmatch(r'req_[A-Za-z0-9_-]{1,124}',error.request_id) else self._request_id
            return self._record(error.code,status=error.status,outcome=error.outcome,retryable=error.retryable,details=details,request_id=request_id)
        return self._record('CLIENT_TRANSPORT_ERROR',retryable=True)
    @staticmethod
    def _exception(record: _Failure) -> AgentClientError | AgentClientCancelledError:
        if record.code=='CLIENT_CANCELLED':
            return AgentClientCancelledError(record.outcome,cursor=record.cursor)
        return AgentClientError(record.code,cursor=record.cursor,request_id=record.request_id,status=record.status,outcome=record.outcome,retryable=record.retryable,details=record.details)
    def _start(self) -> None:
        if self._started:
            return
        self._owner.backend.ensure_open()
        if self._owner.closed or len(self._owner.streams)>=self._owner.maximum:
            self._stopped=True;self._terminal=self._record('CLIENT_CLOSED' if self._owner.closed else 'CLIENT_BUSY',outcome='not-dispatched')
            raise self._exception(self._terminal) from None
        self._started=True;self._owner.streams.add(self)
        loop=asyncio.get_running_loop();self._signal=loop.create_future()
        self._timer=loop.call_later(self._owner.timeout,lambda:self._stop(self._record('CLIENT_TIMEOUT'),mode='error'))
    def _stop(self,reason: _Failure | None,*,mode: str) -> None:
        if self._stopped:
            return
        self._stopped=True;self._terminal=reason if mode=='error' else None
        self._wake_reason=reason if reason is not None else self._record('CLIENT_CANCELLED') if mode=='close' else None
        if self._timer is not None:
            self._timer.cancel()
        self._decoder.discard_window()
        if self._signal is not None and not self._signal.done():
            self._signal.set_result(None)
        if not self._started:
            return
        async def cleanup() -> None:
            if self._window is not None:
                await asyncio.shield(self._window.close())
            if self._pull is not None:
                await asyncio.gather(self._pull,return_exceptions=True)
            self._owner.streams.discard(self)
        self._cleanup=asyncio.create_task(cleanup());self._cleanup.add_done_callback(BackendTransport._observe)
    async def _error_chunks(self,window: _Window) -> AsyncIterator[bytes]:
        while True:
            try:
                chunk=await window.read()
            except StopAsyncIteration:
                return
            if self._stopped:
                return
            if type(chunk) is not bytes:
                raise AgentClientError('CLIENT_INVALID_RESPONSE') from None
            self._decoder.account_external_bytes(len(chunk))
            yield chunk
    async def _open(self) -> None:
        self._attempts+=1;self._request_id=None
        request=httpx.Request('GET',self._owner.backend._base+'/v1/agent-runs/'+self._run+'/events/stream?after='+self._decoder.last_delivered_cursor,headers={'authorization':'Bearer '+self._owner.backend._api_key,'accept':'text/event-stream','accept-encoding':'identity','cache-control':'no-store'})
        self._window=_Window(self._owner.http,request);response=await asyncio.shield(self._window.sending)
        if self._stopped:
            return
        self._window.attach_reader();status=response.status_code
        raw_id=response.headers.get('x-request-id')
        if type(raw_id) is str and re.fullmatch(r'req_[A-Za-z0-9_-]{1,124}',raw_id):
            self._request_id=RequestId(raw_id)
        if 300<=status<400:
            raise AgentClientError('CLIENT_REDIRECT_REJECTED',status=status) from None
        if status>=400:
            await self._owner.backend.decode_json_response(response,EventExpected('event-stream',self._run,self._decoder.last_delivered_cursor),raw_chunks=self._error_chunks(self._window))
            raise AgentClientError('CLIENT_INVALID_RESPONSE') from None
        length=response.headers.get('content-length');remaining=self._owner.max_bytes-self._decoder.status().received_bytes
        if status!=200 or re.fullmatch(r'text/event-stream(?:\s*;\s*charset=utf-8)?',response.headers.get('content-type',''),re.I) is None or self._request_id is None or response.headers.get('content-encoding','identity').lower()!='identity' or length is not None and (re.fullmatch(r'0|[1-9][0-9]*',length) is None or len(length)>16 or int(length)>remaining):
            raise AgentClientError('CLIENT_INVALID_RESPONSE',status=status) from None
        self._decoder.begin_window(self._request_id)
    async def _advance(self) -> AgentEventMessage | None:
        while not self._stopped:
            try:
                await self._open()
                if self._stopped:
                    return None
                assert self._window is not None
                while not self._stopped:
                    message=self._decoder.pull()
                    if message is not None:
                        return message
                    if self._decoder.has_buffered_bytes:
                        await asyncio.sleep(0)
                        continue
                    try:
                        chunk=await self._window.read()
                    except StopAsyncIteration:
                        self._decoder.end_of_file()
                        break
                    if self._stopped:
                        return None
                    self._decoder.offer_chunk(chunk)
                await asyncio.shield(self._window.close())
                if self._stopped:
                    return None
                if self._attempts>=self._max_attempts:
                    self._stop(None,mode='complete');return None
            except BaseException as error:
                if self._stopped:
                    return None
                record=self._from_error(error)
                if not record.retryable or self._attempts>=self._max_attempts:
                    self._stop(record,mode='error');return None
                if self._window is not None:
                    try:
                        await asyncio.shield(self._window.close())
                    except BaseException:
                        record=self._record('CLIENT_EVENT_STREAM_CLEANUP_FAILED')
                if not record.retryable or self._attempts>=self._max_attempts:
                    self._stop(record,mode='error');return None
                if self._stopped:
                    return None
                self._decoder.discard_window()
            assert self._signal is not None
            await asyncio.wait({self._signal},timeout=.05)
        return None
    async def __anext__(self) -> AgentEventMessage:
        if self._stopped:
            if self._terminal is not None:
                raise self._exception(self._terminal) from None
            raise StopAsyncIteration
        if self._busy:
            raise self._exception(self._record('CLIENT_EVENT_STREAM_BUSY',outcome='not-dispatched')) from None
        self._start();self._busy=True
        assert self._signal is not None
        # Continue the same window after each acknowledged delivery. _open is
        # only needed initially or after actual EOF/transport cleanup.
        self._pull=asyncio.create_task(self._pull_one());self._pull.add_done_callback(BackendTransport._observe)
        try:
            pending: set[asyncio.Future[Any]]={self._pull,self._signal}
            await asyncio.wait(pending,return_when=asyncio.FIRST_COMPLETED)
            if self._stopped:
                if self._wake_reason is not None:
                    raise self._exception(self._wake_reason) from None
                raise StopAsyncIteration
            message=self._pull.result()
            if message is None:
                raise StopAsyncIteration
            self._decoder.acknowledge(message)
            return message
        except asyncio.CancelledError:
            record=self._record('CLIENT_CANCELLED');self._stop(record,mode='error')
            raise AgentClientCancelledError(record.outcome,cursor=record.cursor) from None
        finally:
            self._busy=False
    async def _pull_one(self) -> AgentEventMessage | None:
        if self._window is None or not self._decoder.status().active_window:
            return await self._advance()
        try:
            while not self._stopped:
                message=self._decoder.pull()
                if message is not None:
                    return message
                if self._decoder.has_buffered_bytes:
                    await asyncio.sleep(0);continue
                try:
                    chunk=await self._window.read()
                except StopAsyncIteration:
                    self._decoder.end_of_file();await asyncio.shield(self._window.close())
                    if self._stopped:
                        return None
                    if self._attempts>=self._max_attempts:
                        self._stop(None,mode='complete');return None
                    assert self._signal is not None
                    await asyncio.wait({self._signal},timeout=.05)
                    return await self._advance()
                if self._stopped:
                    return None
                self._decoder.offer_chunk(chunk)
        except BaseException as error:
            if self._stopped:
                return None
            record=self._from_error(error)
            if not record.retryable or self._attempts>=self._max_attempts:
                self._stop(record,mode='error');return None
            try:
                await asyncio.shield(self._window.close())
            except BaseException:
                record=self._record('CLIENT_EVENT_STREAM_CLEANUP_FAILED')
            if not record.retryable or self._attempts>=self._max_attempts:
                self._stop(record,mode='error');return None
            if self._stopped:
                return None
            self._decoder.discard_window()
            assert self._signal is not None
            await asyncio.wait({self._signal},timeout=.05)
            return await self._advance()
        return None
    async def aclose(self) -> None:
        self._stop(None,mode='close')
        if self._cleanup is None:
            return
        try:
            done,_=await asyncio.wait({self._cleanup},timeout=self._owner.backend._timeout)
            if not done:
                raise self._exception(self._record('CLIENT_CLOSE_PENDING',retryable=True)) from None
            if self._cleanup.cancelled() or self._cleanup.exception() is not None:
                raise self._exception(self._record('CLIENT_EVENT_STREAM_CLEANUP_FAILED')) from None
        except asyncio.CancelledError:
            raise AgentClientCancelledError('not-dispatched',cursor=self._decoder.last_delivered_cursor) from None
