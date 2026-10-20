from __future__ import annotations
import asyncio
from dataclasses import FrozenInstanceError
import json
import os
from pathlib import Path
import tempfile
import time
import traceback
import unittest
import httpx
from remote_paint_session import (SessionClient, SessionClientError, SessionClientCancelledError,
                                  CreateSessionInput, SessionId, OperationId)

KEY = 'fixture_python_backend_api_key_00000000'
AT = '2026-10-18T00:00:00.000Z'
RID = 'req_python_fixture'

def operation(**patch):
    return dict(operationId='op_fixture',sessionId='ses_fixture',kind='create-session',status='pending',
                createdAt=AT,updatedAt=AT,error=None,**{}) | patch

class Body(httpx.AsyncByteStream):
    def __init__(self,data=b'',hang=False):self.data,self.hang,self.closed=data,hang,False
    async def __aiter__(self):
        yield self.data
        if self.hang:await asyncio.Future()
    async def aclose(self):self.closed=True

def response(data=None,status=202,headers=None,raw=None,stream=None):
    payload=json.dumps({'data':operation() if data is None else data,'requestId':RID}).encode() if raw is None else raw
    return httpx.Response(status,headers={'content-type':'application/json','x-request-id':RID,**(headers or {})},stream=stream or Body(payload))

def failure(code,status=503):
    return response(status=status,raw=json.dumps({'error':{'code':code,'message':'private-proxy-token'},'requestId':RID}).encode())

class Contracts(unittest.IsolatedAsyncioTestCase):
    async def client(self,handler,**options):
        client=SessionClient(base_url='https://api.fixture.test',api_key=KEY,transport=httpx.MockTransport(handler),**options)
        self.addAsyncCleanup(client.aclose)
        return client

    def assert_code(self,error,code):
        self.assertIsInstance(error,SessionClientError);self.assertEqual(error.code,code)

    async def test_configuration_and_input_validate_before_dispatch(self):
        calls=[]
        async def handler(req):calls.append(req);return response()
        for patch in [{'base_url':'http://public.test'},{'base_url':'https://u:p@api.test'},{'base_url':'https://api.test/path'},
                      {'base_url':'https://api.test/?secret=x'},{'api_key':'short'},{'timeout_seconds':True},{'retries':4},
                      {'max_response_bytes':1},{'max_concurrent_requests':0}]:
            with self.assertRaises(SessionClientError) as context:SessionClient(**({'base_url':'https://api.test','api_key':KEY}|patch))
            self.assertEqual(context.exception.outcome,'not-dispatched')
        client=await self.client(handler)
        for value in [CreateSessionInput(url='file:///private'),CreateSessionInput(url=' about:blank'),CreateSessionInput(url='https://u:p@test'),
                      CreateSessionInput(url='https://example.test/\ud800'),CreateSessionInput(ttl_seconds=True),CreateSessionInput(ttl_seconds=0),CreateSessionInput(region=''),{}]:
            with self.assertRaises(SessionClientError):client.sessions.prepare_create(value,idempotency_key='key')
        for key in ['','has space','x'*129]:
            with self.assertRaises(SessionClientError):client.sessions.prepare_create(idempotency_key=key)
        with self.assertRaises(SessionClientError):await client.sessions.get('op_wrong')
        with self.assertRaises(SessionClientError):await client.operations.get('ses_wrong')
        self.assertFalse(calls);self.assertNotIn(KEY,repr(client))

    async def test_prebuffered_trusted_mock_transport_still_validates_size_and_schema(self):
        client=await self.client(lambda req:httpx.Response(202,json={'data':operation(),'requestId':RID},headers={'x-request-id':RID}))
        self.assertEqual((await client.sessions.create(idempotency_key='key')).data.session_id,'ses_fixture')
        client=await self.client(lambda req:httpx.Response(202,content=b'x'*2048,headers={'content-type':'application/json'}),max_response_bytes=1024)
        with self.assertRaises(SessionClientError) as context:await client.sessions.create(idempotency_key='key')
        self.assert_code(context.exception,'CLIENT_INVALID_RESPONSE')

    async def test_prepared_body_and_key_survive_mutation_and_manual_resend(self):
        calls=[]
        async def handler(req):
            calls.append(req)
            if len(calls)==1:raise RuntimeError('private transport '+KEY)
            return response()
        client=await self.client(handler)
        value=CreateSessionInput(url='https://example.test/',ttl_seconds=60)
        prepared=client.sessions.prepare_create(value,idempotency_key='saved-key')
        object.__setattr__(value,'url','https://changed.test/')
        with self.assertRaises(SessionClientError) as context:await prepared.send()
        self.assert_code(context.exception,'CLIENT_TRANSPORT_ERROR');self.assertEqual(context.exception.outcome,'unknown')
        self.assertNotIn(KEY,''.join(traceback.format_exception(context.exception)));self.assertEqual(len(calls),1)
        result=await prepared.send();self.assertEqual(result.data.operation_id,'op_fixture');self.assertEqual(len(calls),2)
        self.assertEqual(calls[0].content,calls[1].content);self.assertEqual(json.loads(calls[1].content)['url'],'https://example.test/')
        self.assertEqual(calls[1].headers['idempotency-key'],'saved-key');self.assertNotIn('saved-key',repr(prepared))
        with self.assertRaises(FrozenInstanceError):result.data.status='failed'

    async def test_explicit_transient_retries_keep_request_and_default_does_not_retry(self):
        calls=[]
        async def handler(req):calls.append(req);return failure('REGISTRY_STORAGE_UNAVAILABLE') if len(calls)==1 else response()
        client=await self.client(handler)
        prepared=client.sessions.prepare_create(idempotency_key='saved-key')
        with self.assertRaises(SessionClientError):await prepared.send()
        self.assertEqual(len(calls),1)
        calls.clear();result=await prepared.send(retries=1);self.assertEqual(result.data.status,'pending');self.assertEqual(len(calls),2)
        self.assertEqual(calls[0].content,calls[1].content);self.assertEqual(calls[0].headers['idempotency-key'],calls[1].headers['idempotency-key'])

    async def test_conflict_and_authentication_errors_are_redacted_and_never_retried(self):
        calls=[]
        async def handler(req):calls.append(req);return failure('IDEMPOTENCY_CONFLICT',409)
        client=await self.client(handler,retries=3)
        with self.assertRaises(SessionClientError) as context:await client.sessions.create(idempotency_key='key')
        error=context.exception;self.assertEqual(error.status,409);self.assertEqual(error.request_id,RID);self.assertEqual(error.outcome,'rejected');self.assertFalse(error.retryable)
        self.assertNotIn('private-proxy-token',str(error)+repr(vars(error)));self.assertEqual(len(calls),1)

    async def test_exact_response_schema_kind_target_status_and_request_id_are_checked(self):
        factories=[lambda:response(operation(private='unknown')),lambda:response(status=200),lambda:response(operation(kind='release-session')),
                   lambda:response(operation(status='failed')),lambda:response(operation(operationId='ses_wrong')),
                   lambda:response(headers={'x-request-id':'req_other'}),lambda:response(headers={'content-type':'text/plain'}),lambda:failure('CLIENT_CANCELLED',409)]
        for factory in factories:
            client=await self.client(lambda req,f=factory:f())
            with self.assertRaises(SessionClientError) as context:await client.sessions.create(idempotency_key='key')
            self.assert_code(context.exception,'CLIENT_INVALID_RESPONSE')
        client=await self.client(lambda req:response(status=200))
        with self.assertRaises(SessionClientError):await client.operations.get(OperationId('op_other'))
        client=await self.client(lambda req:response(operation(kind='release-session')))
        with self.assertRaises(SessionClientError):await client.sessions.release(SessionId('ses_other'))

    async def test_invalid_json_utf8_and_proxy_error_never_escape_as_confirmed_data(self):
        for body in [b'{',b'\xff',b'null',b'[]']:
            client=await self.client(lambda req,b=body:response(raw=b))
            with self.assertRaises(SessionClientError):await client.sessions.create(idempotency_key='key')
        client=await self.client(lambda req:response(status=503,headers={'content-type':'text/html'},raw=b'private '+KEY.encode()))
        with self.assertRaises(SessionClientError) as context:await client.sessions.create(idempotency_key='key')
        self.assert_code(context.exception,'CLIENT_HTTP_ERROR');self.assertEqual(context.exception.outcome,'unknown');self.assertNotIn(KEY,str(context.exception))

    async def test_response_size_and_content_encoding_close_the_stream(self):
        for headers,data in [({},b'x'*2048),({'content-length':'2048'},b''),({'content-encoding':'gzip'},b'compressed')]:
            stream=Body(data);client=await self.client(lambda req:response(headers=headers,stream=stream),max_response_bytes=1024)
            with self.assertRaises(SessionClientError) as context:await client.sessions.create(idempotency_key='key')
            self.assert_code(context.exception,'CLIENT_INVALID_RESPONSE');self.assertTrue(stream.closed)

    async def test_deadline_covers_headers_and_streaming_body_and_closes_stream(self):
        async def handler(req):await asyncio.Future()
        client=await self.client(handler,timeout_seconds=.05)
        start=time.monotonic()
        with self.assertRaises(SessionClientError) as context:await client.sessions.create(idempotency_key='key')
        self.assert_code(context.exception,'CLIENT_TIMEOUT');self.assertEqual(context.exception.outcome,'unknown');self.assertLess(time.monotonic()-start,.5)
        stream=Body(b'{',hang=True);client=await self.client(lambda req:response(stream=stream),timeout_seconds=.05)
        with self.assertRaises(SessionClientError) as context:await client.sessions.create(idempotency_key='key')
        self.assert_code(context.exception,'CLIENT_TIMEOUT');self.assertTrue(stream.closed)

    async def test_task_cancellation_keeps_asyncio_semantics_and_unknown_outcome(self):
        entered=asyncio.Event();calls=[]
        async def handler(req):calls.append(req);entered.set();await asyncio.Future()
        client=await self.client(handler,retries=3)
        task=asyncio.create_task(client.sessions.create(idempotency_key='key'));await entered.wait();task.cancel()
        with self.assertRaises(SessionClientCancelledError) as context:await task
        self.assertEqual(context.exception.outcome,'unknown');self.assertTrue(task.cancelled());self.assertEqual(len(calls),1)
        before=asyncio.create_task(client.sessions.create(idempotency_key='before'));before.cancel()
        with self.assertRaises(asyncio.CancelledError):await before
        self.assertEqual(len(calls),1)

    async def test_active_request_limit_and_single_flight_close_cancel_owned_requests(self):
        entered=asyncio.Event()
        async def handler(req):entered.set();await asyncio.Future()
        client=await self.client(handler,max_concurrent_requests=1)
        task=asyncio.create_task(client.sessions.create(idempotency_key='first'));await entered.wait()
        with self.assertRaises(SessionClientError) as context:await client.sessions.create(idempotency_key='second')
        self.assert_code(context.exception,'CLIENT_BUSY');self.assertEqual(context.exception.outcome,'not-dispatched')
        await asyncio.gather(client.aclose(),client.aclose())
        with self.assertRaises(SessionClientCancelledError):await task
        self.assertTrue(client._http.is_closed);self.assertFalse(client._tasks)
        with self.assertRaises(SessionClientError) as context:await client.sessions.create(idempotency_key='after')
        self.assert_code(context.exception,'CLIENT_CLOSED')

    async def test_redirects_never_reach_the_target_and_response_cookies_are_not_sent(self):
        calls=[]
        async def handler(req):
            calls.append(req)
            if len(calls)==1:return response(headers={'set-cookie':'private-cookie=value; Path=/'})
            if len(calls)==2:return response(status=302,headers={'location':'https://other.test/'})
            return response()
        client=await self.client(handler)
        await client.sessions.create(idempotency_key='first')
        with self.assertRaises(SessionClientError) as context:await client.sessions.create(idempotency_key='second')
        self.assert_code(context.exception,'CLIENT_REDIRECT_REJECTED');self.assertEqual(len(calls),2)
        self.assertNotIn('cookie',calls[1].headers);self.assertEqual(len(client._http.cookies),0)

    async def test_session_availability_and_requested_id_are_checked(self):
        current=dict(sessionId='ses_fixture',region='test',state='ready',createdAt=AT,version='v1',ttlSeconds=60,readyAt=AT,expiresAt=AT,closeReason=None,holdsQuota=True)
        for patch in [dict(sessionId='ses_other'),dict(state='unknown'),dict(version=None),dict(readyAt=None),dict(expiresAt=None),dict(holdsQuota=False),dict(state='expired'),dict(ttlSeconds=True),dict(closeReason='private'),dict(private='x')]:
            client=await self.client(lambda req,p=patch:response(current|p,status=200))
            with self.assertRaises(SessionClientError):await client.sessions.get(SessionId('ses_fixture'))
        client=await self.client(lambda req:response(current|dict(state='recovery-required',version=None,readyAt=None,expiresAt=None),status=200))
        self.assertEqual((await client.sessions.get(SessionId('ses_fixture'))).data.state,'recovery-required')

    async def test_failed_response_cleanup_is_reported_and_fences_new_calls(self):
        class Broken(Body):
            async def aclose(self):raise RuntimeError('private-close-token')
        stream=Broken(json.dumps({'data':operation(),'requestId':RID}).encode())
        client=await self.client(lambda req:response(stream=stream))
        with self.assertRaises(SessionClientError) as context:await client.sessions.create(idempotency_key='key')
        self.assert_code(context.exception,'CLIENT_RESPONSE_CLOSE_FAILED')
        self.assertNotIn('private-close-token',''.join(traceback.format_exception(context.exception)))
        with self.assertRaises(SessionClientError) as context:await client.sessions.create(idempotency_key='later')
        self.assert_code(context.exception,'CLIENT_CLOSED')

class ActualNodeHttp(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.child=None;self.spawn_task=None;self.directory=tempfile.TemporaryDirectory(prefix='remote-paint-python-client-')
        self.addAsyncCleanup(self.cleanup)
    async def cleanup(self):
        try:
            if self.child is None and self.spawn_task is not None:
                self.child=await asyncio.shield(self.spawn_task)
            if self.child is not None:
                if self.child.returncode is None:
                    try:
                        self.child.stdin.write(b'close\n');await self.child.stdin.drain()
                        stdout,stderr=await asyncio.wait_for(self.child.communicate(),3)
                    except BaseException:
                        if self.child.returncode is None:self.child.kill()
                        await self.child.wait()
                        raise
                    records=[json.loads(line)for line in stdout.splitlines()if line]
                    closed=next(row for row in records if row['event']=='closed')
                    self.assertEqual(closed['outcome'],{'status':'closed','remainingSessions':[],'persistence':'confirmed'})
                self.assertEqual(self.child.returncode,0)
        finally:
            self.directory.cleanup()
    async def start(self,mode='normal'):
        script=Path(__file__).resolve().parents[1]/'fixtures/session-python-http.mjs'
        self.spawn_task=asyncio.create_task(asyncio.create_subprocess_exec(os.environ.get('SESSION_PYTHON_TEST_NODE','node'),str(script),self.directory.name,mode,
            stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE))
        self.child=await asyncio.shield(self.spawn_task)
        line=await asyncio.wait_for(self.child.stdout.readline(),3)
        if not line:raise AssertionError((await self.child.stderr.read()).decode()[:2000])
        ready=json.loads(line);self.assertEqual(ready['event'],'ready')
        return 'http://127.0.0.1:'+str(ready['port'])
    async def stats(self):
        self.child.stdin.write(b'stats\n');await self.child.stdin.drain();return json.loads(await asyncio.wait_for(self.child.stdout.readline(),3))
    async def test_worker_unavailable_is_readable_during_close_and_after_retirement(self):
        base=await self.start('worker-unavailable')
        async with SessionClient(base_url=base,api_key=KEY) as client:
            created=(await client.sessions.create(CreateSessionInput(ttl_seconds=60),idempotency_key='worker-fault')).data
            self.assertEqual((await client.sessions.get(created.session_id)).data.state,'ready')
            self.child.stdin.write(b'unavailable\n');await self.child.stdin.drain();self.assertEqual(json.loads(await self.child.stdout.readline())['event'],'unavailable')
            closing=(await client.sessions.get(created.session_id)).data
            self.assertEqual(closing.state,'closing');self.assertEqual(closing.close_reason,'worker-unavailable');self.assertTrue(closing.holds_quota)
            self.assertEqual((await self.stats())['reservedSessions'],1)
            self.child.stdin.write(b'retire-worker\n');await self.child.stdin.drain();self.assertEqual(json.loads(await self.child.stdout.readline())['event'],'retiring-worker')
            for _ in range(100):
                closed=(await client.sessions.get(created.session_id)).data
                if closed.state=='closed':break
                await asyncio.sleep(.01)
            self.assertEqual(closed.state,'closed');self.assertEqual(closed.close_reason,'worker-unavailable');self.assertFalse(closed.holds_quota)
            self.assertEqual((await client.operations.get(created.operation_id)).data.status,'succeeded')
        self.assertEqual((await self.stats())['reservedSessions'],0)
    async def test_lost_response_retry_one_allocation_tenant_fencing_query_and_release(self):
        base=await self.start('drop-first')
        async with SessionClient(base_url=base,api_key=KEY,retries=1) as client:
            prepared=client.sessions.prepare_create(CreateSessionInput(ttl_seconds=60),idempotency_key='saved-job-key')
            first=await prepared.send();second=await prepared.send();self.assertEqual(first.data.operation_id,second.data.operation_id)
            self.assertEqual((await self.stats())['requests'],3)
            current=await client.sessions.get(first.data.session_id);self.assertEqual(current.data.state,'ready');self.assertEqual(current.data.version,'python-fixture-v1')
            op=await client.operations.get(first.data.operation_id);self.assertEqual(op.data.status,'succeeded')
            async with SessionClient(base_url=base,api_key='fixture_python_other_backend_key_000000') as other:
                with self.assertRaises(SessionClientError) as context:await other.sessions.get(first.data.session_id)
                self.assert_code_not_found(context.exception)
            released=await client.sessions.release(first.data.session_id);completed=await client.operations.get(released.data.operation_id)
            self.assertEqual(completed.data.status,'succeeded');self.assertEqual(completed.data.kind,'release-session')
            replay=await client.sessions.release(first.data.session_id);self.assertEqual(replay.data.operation_id,released.data.operation_id)
        stats=await self.stats();self.assertEqual(stats['creates'],1);self.assertEqual(stats['closes'],1);self.assertEqual(stats['reservedSessions'],0)
    def assert_code_not_found(self,error):self.assertEqual(error.code,'SESSION_NOT_FOUND');self.assertEqual(error.status,404)
    async def test_blank_page_and_original_binding_survive_multiple_python_clients(self):
        base=await self.start()
        async with SessionClient(base_url=base,api_key=KEY) as first:
            original=await first.sessions.create(idempotency_key='job-key')
        async with SessionClient(base_url=base,api_key=KEY) as second:
            replay=await second.sessions.create(CreateSessionInput(url='about:blank'),idempotency_key='job-key')
            self.assertEqual(replay.data.session_id,original.data.session_id)
            with self.assertRaises(SessionClientError) as context:await second.sessions.create(CreateSessionInput(url='https://different.test/'),idempotency_key='job-key')
            self.assertEqual(context.exception.code,'IDEMPOTENCY_CONFLICT')
        self.assertEqual((await self.stats())['creates'],1)

if __name__=='__main__':unittest.main()
