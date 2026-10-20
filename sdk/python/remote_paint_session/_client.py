from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, NewType, NoReturn, cast
from urllib.parse import urlsplit

import httpx
from ._transport import ApiResult, RequestId, RetryCount, Outcome, SessionClientError, SessionClientCancelledError, BackendTransport

SessionId = NewType("SessionId", str)
OperationId = NewType("OperationId", str)
OperationKind = Literal["create-session", "release-session"]
OperationStatus = Literal["pending", "succeeded", "failed"]
SessionState = Literal["creating", "ready", "closing", "closed", "expired", "failed", "cleanup-failed", "recovery-required"]
CloseReason = Literal["released", "ttl-expired", "registry-shutdown", "registry-recovery", "registry-storage-fault", "worker-unavailable"]


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


class SessionClient:
    def __init__(self, *, base_url: str, api_key: str, timeout_seconds: float = 10, retries: RetryCount = 0,
                 max_response_bytes: int = 65536, max_concurrent_requests: int = 64,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._transport = BackendTransport(base_url=base_url, api_key=api_key, timeout_seconds=timeout_seconds, retries=retries,
            max_response_bytes=max_response_bytes, max_concurrent_requests=max_concurrent_requests, transport=transport, validate=self._validate)
        self._http, self._tasks = self._transport.http, self._transport.tasks
        self.sessions, self.operations = _Sessions(self), _Operations(self)

    async def __aenter__(self) -> SessionClient:
        self._transport.ensure_open()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._transport.aclose()

    async def _request(self, method: str, path: str, body: bytes | None, key: str | None, kind: str,
                       target: str | None, retries: RetryCount | None) -> ApiResult[Operation] | ApiResult[Session]:
        return cast(ApiResult[Operation] | ApiResult[Session], await self._transport.request(method,path,body,key,(kind,target),retries))

    @staticmethod
    def _validate(status: int, data: Any, expect: tuple[str,str | None], headers: httpx.Headers) -> Operation | Session:
        kind, target = expect
        if kind == "session":
            current = _session(data)
            if status != 200 or current.session_id != target:
                _fail("CLIENT_INVALID_RESPONSE", status=status)
            return current
        operation = _operation(data)
        if (kind == "operation" and (operation.operation_id != target or status != 200)
            or kind != "operation" and operation.kind != kind
            or kind == "release-session" and operation.session_id != target
            or status == 202 and operation.status != "pending"
            or kind != "operation" and status == 200 and operation.status == "pending"):
            _fail("CLIENT_INVALID_RESPONSE", status=status)
        return operation
