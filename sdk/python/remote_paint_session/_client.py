from __future__ import annotations

import asyncio
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, AsyncIterator, Generic, Literal, NewType, NoReturn, TypeVar, cast
from urllib.parse import urlsplit

import httpx

SessionId = NewType("SessionId", str)
OperationId = NewType("OperationId", str)
RequestId = NewType("RequestId", str)
RetryCount = Literal[0, 1, 2, 3]
Outcome = Literal["not-dispatched", "unknown", "rejected"]
OperationKind = Literal["create-session", "release-session"]
OperationStatus = Literal["pending", "succeeded", "failed"]
SessionState = Literal["creating", "ready", "closing", "closed", "expired", "failed", "cleanup-failed", "recovery-required"]
CloseReason = Literal["released", "ttl-expired", "registry-shutdown", "registry-recovery", "registry-storage-fault", "worker-unavailable"]
T = TypeVar("T")


class SessionClientError(Exception):
    def __init__(self, code: str, *, status: int | None = None, request_id: RequestId | None = None,
                 outcome: Outcome = "unknown", retryable: bool = False) -> None:
        super().__init__("Invalid Session client request" if code == "CLIENT_INVALID_REQUEST" else "Session API request failed")
        self.code, self.status, self.request_id = code, status, request_id
        self.outcome, self.retryable = outcome, retryable


class SessionClientCancelledError(asyncio.CancelledError):
    """Cancellation preserves asyncio task semantics and reports dispatch uncertainty."""
    def __init__(self, outcome: Outcome) -> None:
        super().__init__("Session API request cancelled")
        self.code, self.outcome = "CLIENT_CANCELLED", outcome


@dataclass(frozen=True, slots=True)
class ApiResult(Generic[T]):
    data: T
    request_id: RequestId


@dataclass(frozen=True, slots=True)
class CreateSessionInput:
    url: str | None = None
    region: str | None = None
    ttl_seconds: int | None = None


@dataclass(frozen=True, slots=True)
class OperationError:
    code: str
    message: str


@dataclass(frozen=True, slots=True)
class Operation:
    operation_id: OperationId
    session_id: SessionId
    kind: OperationKind
    status: OperationStatus
    created_at: str
    updated_at: str
    error: OperationError | None


@dataclass(frozen=True, slots=True)
class Session:
    session_id: SessionId
    region: str
    state: SessionState
    created_at: str
    version: str | None
    ttl_seconds: int
    ready_at: str | None
    expires_at: str | None
    close_reason: CloseReason | None
    holds_quota: bool


def _fail(code: str, **options: Any) -> NoReturn:
    raise SessionClientError(code, **options) from None


def _invalid() -> NoReturn:
    _fail("CLIENT_INVALID_REQUEST", outcome="not-dispatched")


def _integer(value: Any, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high


def _text(value: Any, limit: int) -> bool:
    return type(value) is str and 0 < len(value) <= limit


def _identifier(value: Any, prefix: str) -> bool:
    return type(value) is str and value.startswith(prefix) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) is not None


def _date(value: Any) -> bool:
    if type(value) is not str or len(value) > 32:
        return False
    try:
        return datetime.fromisoformat(value).isoformat(timespec="milliseconds").replace("+00:00", "Z") == value
    except ValueError:
        return False


def _exact(value: Any, names: str) -> bool:
    return type(value) is dict and set(value) == set(names.split())


def _code(value: Any) -> bool:
    return type(value) is str and re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", value) is not None


def _operation(value: Any) -> Operation:
    if not _exact(value, "operationId sessionId kind status createdAt updatedAt error"):
        _fail("CLIENT_INVALID_RESPONSE")
    if not (_identifier(value["operationId"], "op_") and _identifier(value["sessionId"], "ses_")
            and value["kind"] in ("create-session", "release-session") and value["status"] in ("pending", "succeeded", "failed")
            and _date(value["createdAt"]) and _date(value["updatedAt"])):
        _fail("CLIENT_INVALID_RESPONSE")
    error = value["error"]
    if error is not None and not (_exact(error, "code message") and _code(error["code"]) and _text(error["message"], 512)):
        _fail("CLIENT_INVALID_RESPONSE")
    if (value["status"] == "failed") != (error is not None):
        _fail("CLIENT_INVALID_RESPONSE")
    return Operation(value["operationId"], value["sessionId"], value["kind"], value["status"], value["createdAt"], value["updatedAt"],
                     None if error is None else OperationError(error["code"], error["message"]))


def _session(value: Any) -> Session:
    if not _exact(value, "sessionId region state createdAt version ttlSeconds readyAt expiresAt closeReason holdsQuota"):
        _fail("CLIENT_INVALID_RESPONSE")
    if not (_identifier(value["sessionId"], "ses_") and _text(value["region"], 64)
            and value["state"] in ("creating", "ready", "closing", "closed", "expired", "failed", "cleanup-failed", "recovery-required")
            and _date(value["createdAt"]) and (value["version"] is None or _text(value["version"], 256))
            and _integer(value["ttlSeconds"], 1, 86400)
            and all(value[name] is None or _date(value[name]) for name in ("readyAt", "expiresAt"))
            and (value["closeReason"] is None or value["closeReason"] in ("released", "ttl-expired", "registry-shutdown", "registry-recovery", "registry-storage-fault", "worker-unavailable"))
            and type(value["holdsQuota"]) is bool):
        _fail("CLIENT_INVALID_RESPONSE")
    if value["state"] == "ready" and not all(value[name] for name in ("version", "readyAt", "expiresAt", "holdsQuota")):
        _fail("CLIENT_INVALID_RESPONSE")
    if value["state"] in ("closed", "expired", "failed") and value["holdsQuota"]:
        _fail("CLIENT_INVALID_RESPONSE")
    return Session(value["sessionId"], value["region"], value["state"], value["createdAt"], value["version"], value["ttlSeconds"],
                   value["readyAt"], value["expiresAt"], value["closeReason"], value["holdsQuota"])


def _body(value: CreateSessionInput | None) -> bytes:
    if value is None:
        value = CreateSessionInput()
    if type(value) is not CreateSessionInput:
        _invalid()
    data: dict[str, Any] = {}
    if value.url is not None:
        if not _text(value.url, 8192):
            _invalid()
        try:
            url = urlsplit(value.url)
            valid = value.url == "about:blank" or (url.scheme in ("http", "https") and bool(url.hostname)
                    and url.username is None and url.password is None and (url.port is None or 0 <= url.port <= 65535))
        except ValueError:
            valid = False
        if not valid:
            _invalid()
        data["url"] = value.url
    if value.region is not None:
        if not _text(value.region, 64):
            _invalid()
        data["region"] = value.region
    if value.ttl_seconds is not None:
        if not _integer(value.ttl_seconds, 1, 86400):
            _invalid()
        data["ttlSeconds"] = value.ttl_seconds
    try:
        return json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (ValueError, UnicodeError):
        _invalid()


def _retries(value: Any) -> RetryCount:
    if not _integer(value, 0, 3):
        _invalid()
    return cast(RetryCount, value)


@dataclass(frozen=True, slots=True)
class PreparedCreation:
    _client: SessionClient = field(repr=False)
    _body: bytes = field(repr=False)
    _key: str = field(repr=False)

    async def send(self, *, retries: RetryCount | None = None) -> ApiResult[Operation]:
        return cast(ApiResult[Operation], await self._client._request("POST", "/v1/sessions", self._body, self._key, "create-session", None, retries))


class _Sessions:
    def __init__(self, client: SessionClient) -> None:
        self._client = client

    def prepare_create(self, value: CreateSessionInput | None = None, *, idempotency_key: str) -> PreparedCreation:
        if type(idempotency_key) is not str or re.fullmatch(r"[\x21-\x7e]{1,128}", idempotency_key) is None:
            _invalid()
        return PreparedCreation(self._client, _body(value), idempotency_key)

    async def create(self, value: CreateSessionInput | None = None, *, idempotency_key: str, retries: RetryCount | None = None) -> ApiResult[Operation]:
        return await self.prepare_create(value, idempotency_key=idempotency_key).send(retries=retries)

    async def get(self, session_id: SessionId, *, retries: RetryCount | None = None) -> ApiResult[Session]:
        if not _identifier(session_id, "ses_"):
            _invalid()
        return cast(ApiResult[Session], await self._client._request("GET", "/v1/sessions/" + session_id, None, None, "session", session_id, retries))

    async def release(self, session_id: SessionId, *, retries: RetryCount | None = None) -> ApiResult[Operation]:
        if not _identifier(session_id, "ses_"):
            _invalid()
        return cast(ApiResult[Operation], await self._client._request("DELETE", "/v1/sessions/" + session_id, None, None, "release-session", session_id, retries))


class _Operations:
    def __init__(self, client: SessionClient) -> None:
        self._client = client

    async def get(self, operation_id: OperationId, *, retries: RetryCount | None = None) -> ApiResult[Operation]:
        if not _identifier(operation_id, "op_"):
            _invalid()
        return cast(ApiResult[Operation], await self._client._request("GET", "/v1/operations/" + operation_id, None, None, "operation", operation_id, retries))


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


@dataclass(slots=True)
class _Dispatch:
    sent: bool = False


class SessionClient:
    def __init__(self, *, base_url: str, api_key: str, timeout_seconds: float = 10, retries: RetryCount = 0,
                 max_response_bytes: int = 65536, max_concurrent_requests: int = 64,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        if type(base_url) is not str or len(base_url) > 8192:
            _invalid()
        try:
            url = urlsplit(base_url)
            valid = url.scheme == "https" or url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
            if not valid or not url.hostname or url.username is not None or url.password is not None or url.query or url.fragment or url.path not in ("", "/"):
                _invalid()
            origin = str(httpx.URL(base_url).copy_with(path="/", query=None, fragment=None)).rstrip("/")
        except (ValueError, httpx.InvalidURL):
            _invalid()
        if type(api_key) is not str or re.fullmatch(r"[A-Za-z0-9_-]{32,256}", api_key) is None:
            _invalid()
        if type(timeout_seconds) not in (float, int) or not 0.05 <= timeout_seconds <= 60 or not _integer(max_response_bytes, 1024, 1048576) or not _integer(max_concurrent_requests, 1, 10000):
            _invalid()
        if transport is not None and not isinstance(transport, httpx.AsyncBaseTransport):
            _invalid()
        self._base, self._api_key, self._timeout = origin, api_key, timeout_seconds
        self._retries, self._max_bytes, self._max_concurrent = _retries(retries), max_response_bytes, max_concurrent_requests
        self._http = httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False,
                    timeout=timeout_seconds, limits=httpx.Limits(max_connections=16, max_keepalive_connections=8))
        self._tasks: set[asyncio.Task[ApiResult[Operation] | ApiResult[Session]]] = set()
        self._closed, self._close_task = False, cast(asyncio.Task[None] | None, None)
        self.sessions, self.operations = _Sessions(self), _Operations(self)

    async def __aenter__(self) -> SessionClient:
        if self._closed:
            _fail("CLIENT_CLOSED", outcome="not-dispatched")
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._close_task is None:
            self._closed = True
            async def close() -> None:
                tasks = tuple(self._tasks)
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                try:
                    async with asyncio.timeout(1):
                        await self._http.aclose()
                except Exception:
                    _fail("CLIENT_CLOSE_FAILED", outcome="not-dispatched")
            self._close_task = asyncio.create_task(close())
        await asyncio.shield(self._close_task)

    async def _request(self, method: str, path: str, body: bytes | None, key: str | None, kind: str,
                       target: str | None, retries: RetryCount | None) -> ApiResult[Operation] | ApiResult[Session]:
        count = self._retries if retries is None else _retries(retries)
        if self._closed:
            _fail("CLIENT_CLOSED", outcome="not-dispatched")
        if len(self._tasks) >= self._max_concurrent:
            _fail("CLIENT_BUSY", outcome="not-dispatched", retryable=True)
        dispatch = _Dispatch()
        async def run() -> ApiResult[Operation] | ApiResult[Session]:
            for attempt in range(count + 1):
                try:
                    return await self._attempt(method, path, body, key, kind, target, dispatch)
                except SessionClientError as error:
                    if not error.retryable or attempt == count:
                        raise error from None
            raise AssertionError("unreachable")
        task = asyncio.create_task(run())
        self._tasks.add(task)
        try:
            return await task
        except asyncio.CancelledError:
            raise SessionClientCancelledError("unknown" if dispatch.sent else "not-dispatched") from None
        finally:
            self._tasks.discard(task)

    async def _attempt(self, method: str, path: str, body: bytes | None, key: str | None, kind: str,
                       target: str | None, dispatch: _Dispatch) -> ApiResult[Operation] | ApiResult[Session]:
        response: httpx.Response | None = None
        tracked: _TrackedStream | None = None
        try:
            async with asyncio.timeout(self._timeout):
                headers = {"authorization": "Bearer " + self._api_key, "accept": "application/json", "accept-encoding": "identity", "cache-control": "no-store"}
                if body is not None:
                    headers.update({"content-type": "application/json", "idempotency-key": cast(str, key)})
                request = httpx.Request(method, self._base + path, content=body, headers=headers)
                dispatch.sent = True
                response = await self._http.send(request, stream=True, follow_redirects=False)
                if not isinstance(response.stream, httpx.AsyncByteStream):
                    _fail("CLIENT_INVALID_RESPONSE")
                tracked = _TrackedStream(response.stream)
                response.stream = tracked
                status, retryable = response.status_code, response.status_code in (408, 429) or response.status_code >= 500
                if 300 <= status < 400:
                    _fail("CLIENT_REDIRECT_REJECTED", status=status)
                if response.headers.get("content-encoding", "identity").lower() != "identity" or re.fullmatch(r"application/json(?:\s*;\s*charset=utf-8)?", response.headers.get("content-type", ""), re.I) is None:
                    _fail("CLIENT_HTTP_ERROR" if status >= 400 else "CLIENT_INVALID_RESPONSE", status=status, retryable=status >= 400 and retryable)
                length = response.headers.get("content-length")
                if length is not None and (re.fullmatch(r"0|[1-9][0-9]*", length) is None or int(length) > self._max_bytes):
                    _fail("CLIENT_INVALID_RESPONSE", status=status)
                chunks: list[bytes] = []
                size = 0
                if response.is_stream_consumed:
                    if len(response.content) > self._max_bytes:
                        _fail("CLIENT_INVALID_RESPONSE", status=status)
                    chunks.append(response.content)
                else:
                    async for chunk in response.aiter_raw():
                        size += len(chunk)
                        if size > self._max_bytes:
                            _fail("CLIENT_INVALID_RESPONSE", status=status)
                        chunks.append(chunk)
                try:
                    value = json.loads(b"".join(chunks).decode("utf-8"))
                except (ValueError, UnicodeError, RecursionError):
                    _fail("CLIENT_HTTP_ERROR" if status >= 400 else "CLIENT_INVALID_RESPONSE", status=status, retryable=status >= 400 and retryable)
                request_id = value.get("requestId") if type(value) is dict else None
                if not _identifier(request_id, "req_") or response.headers.get("x-request-id") != request_id:
                    _fail("CLIENT_INVALID_RESPONSE", status=status)
                if status >= 400:
                    error = value.get("error")
                    if not (_exact(value, "error requestId") and _exact(error, "code message") and _code(error["code"]) and not error["code"].startswith("CLIENT_") and _text(error["message"], 512)):
                        _fail("CLIENT_INVALID_RESPONSE", status=status)
                    _fail(error["code"], status=status, request_id=request_id, retryable=retryable, outcome="rejected" if status < 500 and status != 408 else "unknown")
                if status not in (200, 202) or not _exact(value, "data requestId"):
                    _fail("CLIENT_INVALID_RESPONSE", status=status)
                if kind == "session":
                    current = _session(value["data"])
                    if status != 200 or current.session_id != target:
                        _fail("CLIENT_INVALID_RESPONSE", status=status)
                    return ApiResult(current, request_id)
                operation = _operation(value["data"])
                if (kind == "operation" and (operation.operation_id != target or status != 200)
                    or kind != "operation" and operation.kind != kind
                    or kind == "release-session" and operation.session_id != target
                    or status == 202 and operation.status != "pending"
                    or kind != "operation" and status == 200 and operation.status == "pending"):
                    _fail("CLIENT_INVALID_RESPONSE", status=status)
                return ApiResult(operation, request_id)
        except (TimeoutError, httpx.TimeoutException):
            _fail("CLIENT_TIMEOUT", outcome="unknown" if dispatch.sent else "not-dispatched", retryable=True)
        except SessionClientError:
            raise
        except Exception:
            _fail("CLIENT_TRANSPORT_ERROR", outcome="unknown" if dispatch.sent else "not-dispatched", retryable=True)
        finally:
            self._http.cookies.clear()
            if response is not None:
                prior_error = sys.exception()
                try:
                    async with asyncio.timeout(1):
                        await response.aclose()
                except Exception:
                    if tracked is not None:
                        tracked.close_failed = True
                if tracked is not None and tracked.close_failed:
                    self._closed = True
                    if not isinstance(prior_error, asyncio.CancelledError):
                        _fail("CLIENT_RESPONSE_CLOSE_FAILED")
