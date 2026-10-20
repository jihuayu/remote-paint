"""Private bounded backend HTTP transport. Not a public import surface."""
from __future__ import annotations
import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Generic, Literal, NewType, NoReturn, TypeVar, cast
from urllib.parse import urlsplit
import httpx

RequestId = NewType('RequestId', str)
RetryCount = Literal[0, 1, 2, 3]
Outcome = Literal['not-dispatched', 'unknown', 'rejected']
T = TypeVar('T')

class SessionClientError(Exception):
    def __init__(self, code: str, *, status: int | None = None, request_id: RequestId | None = None,
                 outcome: Outcome = 'unknown', retryable: bool = False) -> None:
        super().__init__('Invalid Session client request' if code == 'CLIENT_INVALID_REQUEST' else 'Session API request failed')
        self.code, self.status, self.request_id = code, status, request_id
        self.outcome, self.retryable = outcome, retryable

class SessionClientCancelledError(asyncio.CancelledError):
    def __init__(self, outcome: Outcome) -> None:
        super().__init__('Session API request cancelled')
        self.code, self.outcome = 'CLIENT_CANCELLED', outcome

@dataclass(frozen=True, slots=True)
class ApiResult(Generic[T]):
    data: T
    request_id: RequestId

@dataclass(frozen=True, slots=True)
class TransportStatus:
    ordinary: int
    ending: int

@dataclass(slots=True)
class _Dispatch:
    sent: bool = False

class _TrackedStream(httpx.AsyncByteStream):
    def __init__(self, source: httpx.AsyncByteStream) -> None:
        self.source, self.close_failed = source, False
    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self.source:
            yield chunk
    async def aclose(self) -> None:
        try:
            await self.source.aclose()
        except Exception:
            self.close_failed = True
            raise

class BackendTransport:
    def __init__(self, *, base_url: str, api_key: str, timeout_seconds: float, retries: RetryCount,
                 max_response_bytes: int, max_concurrent_requests: int,
                 transport: httpx.AsyncBaseTransport | None, validate: Callable[[int, Any, Any, httpx.Headers], Any],
                 error_type: type[SessionClientError] = SessionClientError,
                 cancelled_type: type[SessionClientCancelledError] = SessionClientCancelledError,
                 max_concurrent_end_requests: int = 0, agent_errors: bool = False) -> None:
        self._error, self._cancelled, self._validate, self._agent_errors = error_type, cancelled_type, validate, agent_errors
        if type(base_url) is not str or len(base_url) > 8192:
            self.invalid()
        try:
            url = urlsplit(base_url)
            valid = url.scheme == 'https' or url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1', '::1')
            if not valid or not url.hostname or url.username is not None or url.password is not None or url.query or url.fragment or url.path not in ('', '/'):
                self.invalid()
            self._base = str(httpx.URL(base_url).copy_with(path='/', query=None, fragment=None)).rstrip('/')
        except (ValueError, httpx.InvalidURL):
            self.invalid()
        if type(api_key) is not str or re.fullmatch(r'[A-Za-z0-9_-]{32,256}', api_key) is None:
            self.invalid()
        if type(timeout_seconds) not in (float, int) or not .05 <= timeout_seconds <= 60 or type(max_response_bytes) is not int or not 1024 <= max_response_bytes <= 1048576 or type(max_concurrent_requests) is not int or not 1 <= max_concurrent_requests <= 10000:
            self.invalid()
        if type(max_concurrent_end_requests) is not int or not 0 <= max_concurrent_end_requests <= 64:
            self.invalid()
        if transport is not None and not isinstance(transport, httpx.AsyncBaseTransport):
            self.invalid()
        self._api_key, self._timeout, self._max_bytes = api_key, timeout_seconds, max_response_bytes
        self._retries, self._max, self._max_end = self.retry_count(retries), max_concurrent_requests, max_concurrent_end_requests
        # End uses its own actual connection pool, not just a local counter.
        self.http = httpx.AsyncClient(transport=transport, limits=httpx.Limits(max_connections=16, max_keepalive_connections=8), trust_env=False, follow_redirects=False, timeout=timeout_seconds)
        self._end_http = httpx.AsyncClient(transport=transport, limits=httpx.Limits(max_connections=max(1, max_concurrent_end_requests), max_keepalive_connections=0), trust_env=False, follow_redirects=False, timeout=timeout_seconds) if max_concurrent_end_requests else None
        self.tasks: set[asyncio.Task[ApiResult[Any]]] = set()
        self._ordinary: set[asyncio.Task[ApiResult[Any]]] = set()
        self._ending: set[asyncio.Task[ApiResult[Any]]] = set()
        self._closed = False
        self._close_task: asyncio.Task[None] | None = None

    def fail(self, code: str, **options: Any) -> NoReturn:
        raise self._error(code, **options) from None
    def invalid(self) -> NoReturn:
        self.fail('CLIENT_INVALID_REQUEST', outcome='not-dispatched')
    def retry_count(self, value: Any) -> RetryCount:
        if type(value) is not int or not 0 <= value <= 3:
            self.invalid()
        return cast(RetryCount,value)
    def status(self) -> TransportStatus:
        return TransportStatus(len(self._ordinary), len(self._ending))
    def ensure_open(self) -> None:
        if self._closed:
            self.fail('CLIENT_CLOSED', outcome='not-dispatched')

    async def aclose(self) -> None:
        if self._close_task is None:
            self._closed = True
            async def close() -> None:
                tasks = tuple(self.tasks)
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                try:
                    # Closing a shared injected transport twice is its trusted
                    # configuration responsibility, just like HTTPX clients.
                    await self.http.aclose()
                    if self._end_http is not None:
                        await self._end_http.aclose()
                except Exception:
                    self.fail('CLIENT_CLOSE_FAILED', outcome='not-dispatched')
            self._close_task = asyncio.create_task(close())
            self._close_task.add_done_callback(self._observe)
        try:
            done, _ = await asyncio.wait({self._close_task}, timeout=1)
            if not done:
                self.fail('CLIENT_CLOSE_PENDING', outcome='not-dispatched', retryable=True)
            self._close_task.result()
        except asyncio.CancelledError:
            raise self._cancelled('not-dispatched') from None

    @staticmethod
    def _observe(task: asyncio.Task[Any]) -> None:
        if not task.cancelled():
            task.exception()

    async def request(self, method: str, path: str, body: bytes | None, key: str | None,
                      expect: Any, retries: RetryCount | None, *, ending: bool = False) -> ApiResult[Any]:
        count = self._retries if retries is None else self.retry_count(retries)
        uncertain = False
        for attempt in range(count + 1):
            try:
                return await self._attempt(method, path, body, key, expect, ending)
            except SessionClientError as error:
                if uncertain and error.outcome != 'unknown':
                    error = self._error(error.code, status=error.status, request_id=error.request_id, outcome='unknown', retryable=error.retryable)
                uncertain = uncertain or error.outcome == 'unknown'
                if not error.retryable or attempt == count:
                    raise error from None
            except SessionClientCancelledError as error:
                raise self._cancelled('unknown' if uncertain else error.outcome) from None
        raise AssertionError('unreachable')

    async def _attempt(self, method: str, path: str, body: bytes | None, key: str | None, expect: Any, ending: bool) -> ApiResult[Any]:
        self.ensure_open()
        slots, maximum = (self._ending, self._max_end) if ending else (self._ordinary, self._max)
        if len(slots) >= maximum:
            self.fail('CLIENT_BUSY', outcome='not-dispatched', retryable=False)
        dispatch = _Dispatch()
        task = asyncio.create_task(self._work(method, path, body, key, expect, dispatch, ending))
        slots.add(task); self.tasks.add(task)
        def settled(done: asyncio.Task[Any]) -> None:
            slots.discard(done); self.tasks.discard(done); self._observe(done)
        task.add_done_callback(settled)
        try:
            done, _ = await asyncio.wait({task}, timeout=self._timeout)
            if not done:
                task.cancel()
                # Bounded cleanup grace preserves eager cooperative closure.
                # Non-cooperative work remains counted after this wait.
                await asyncio.wait({task}, timeout=.01)
                self.fail('CLIENT_TIMEOUT', outcome='unknown' if dispatch.sent else 'not-dispatched', retryable=True)
            return task.result()
        except asyncio.CancelledError:
            task.cancel()
            raise self._cancelled('unknown' if dispatch.sent else 'not-dispatched') from None

    async def _work(self, method: str, path: str, body: bytes | None, key: str | None, expect: Any, dispatch: _Dispatch, ending: bool) -> ApiResult[Any]:
        response: httpx.Response | None = None
        tracked: _TrackedStream | None = None
        http = self._end_http if ending else self.http
        assert http is not None
        try:
            headers = {'authorization':'Bearer '+self._api_key, 'accept':'application/json', 'accept-encoding':'identity', 'cache-control':'no-store'}
            if body is not None:
                headers['content-type'] = 'application/json'
            if key is not None:
                headers['idempotency-key'] = key
            request = httpx.Request(method, self._base+path, content=body, headers=headers)
            dispatch.sent = True
            response = await http.send(request, stream=True, follow_redirects=False)
            if not isinstance(response.stream, httpx.AsyncByteStream):
                self.fail('CLIENT_INVALID_RESPONSE')
            tracked = _TrackedStream(response.stream); response.stream = tracked
            status, retryable = response.status_code, response.status_code in (408, 429) or response.status_code >= 500
            if 300 <= status < 400:
                self.fail('CLIENT_REDIRECT_REJECTED', status=status)
            if response.headers.get('content-encoding', 'identity').lower() != 'identity' or re.fullmatch(r'application/json(?:\s*;\s*charset=utf-8)?', response.headers.get('content-type',''), re.I) is None:
                self.fail('CLIENT_HTTP_ERROR' if status >= 400 else 'CLIENT_INVALID_RESPONSE', status=status, retryable=status >= 400 and retryable)
            length = response.headers.get('content-length')
            if length is not None and (re.fullmatch(r'0|[1-9][0-9]*',length) is None or len(length) > 16 or int(length) > self._max_bytes):
                self.fail('CLIENT_INVALID_RESPONSE', status=status)
            chunks: list[bytes] = []; size = 0
            if response.is_stream_consumed:
                if len(response.content) > self._max_bytes:
                    self.fail('CLIENT_INVALID_RESPONSE', status=status)
                chunks.append(response.content)
            else:
                async for chunk in response.aiter_raw():
                    size += len(chunk)
                    if size > self._max_bytes:
                        self.fail('CLIENT_INVALID_RESPONSE', status=status)
                    chunks.append(chunk)
            try:
                value = json.loads(b''.join(chunks).decode('utf-8'))
            except (ValueError, UnicodeError, RecursionError):
                self.fail('CLIENT_HTTP_ERROR' if status >= 400 else 'CLIENT_INVALID_RESPONSE', status=status, retryable=status >= 400 and retryable)
            request_id = value.get('requestId') if type(value) is dict else None
            if type(request_id) is not str or re.fullmatch(r'req_[A-Za-z0-9_-]{1,124}', request_id) is None or response.headers.get('x-request-id') != request_id:
                self.fail('CLIENT_INVALID_RESPONSE', status=status)
            if status >= 400:
                error = value.get('error'); has_outcome = self._agent_errors and type(error) is dict and 'outcome' in error
                if set(value) != {'error','requestId'} or type(error) is not dict or set(error) != ({'code','message','outcome'} if has_outcome else {'code','message'}) or type(error['code']) is not str or re.fullmatch(r'[A-Z][A-Z0-9_]{0,63}',error['code']) is None or error['code'].startswith('CLIENT_') or type(error['message']) is not str or not 1 <= len(error['message']) <= 512 or has_outcome and error['outcome'] not in ('not-dispatched','unknown'):
                    self.fail('CLIENT_INVALID_RESPONSE', status=status, request_id=request_id)
                self.fail(error['code'], status=status, request_id=request_id, retryable=retryable, outcome=error['outcome'] if has_outcome else 'rejected' if status < 500 and status != 408 else 'unknown')
            if status not in (200,202) or set(value) != {'data','requestId'}:
                self.fail('CLIENT_INVALID_RESPONSE', status=status)
            return ApiResult(self._validate(status,value['data'],expect,response.headers), RequestId(request_id))
        except (TimeoutError, httpx.TimeoutException):
            self.fail('CLIENT_TIMEOUT', outcome='unknown' if dispatch.sent else 'not-dispatched', retryable=True)
        except SessionClientError:
            raise
        except Exception:
            self.fail('CLIENT_TRANSPORT_ERROR', outcome='unknown' if dispatch.sent else 'not-dispatched', retryable=True)
        finally:
            http.cookies.clear()
            if response is not None:
                try:
                    await response.aclose()
                except Exception:
                    if tracked is not None:
                        tracked.close_failed = True
                if tracked is not None and tracked.close_failed:
                    self._closed = True
                    self.fail('CLIENT_RESPONSE_CLOSE_FAILED')
