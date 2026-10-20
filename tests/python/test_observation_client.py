from __future__ import annotations
import asyncio
from dataclasses import FrozenInstanceError, replace
import json
import os
from pathlib import Path
import unittest
import httpx
from remote_paint_session import (AgentClient,AgentClientError,AgentClientCancelledError,AgentRunId,SessionId,
 AgentRunReference,AgentObservationReference,AgentObservationContext,AgentObservationDocument,AgentBinding,AgentSnapshotQuery,
 AgentLocateQuery,AgentElementQuery,AgentElementId,AgentObservationLimits,AgentObservationInput)
from test_agent_client import KEY,AT,RID,SID,RUN,uid,Body,run,response as mutation_response,failure,until

def ref():return AgentObservationReference(RUN,SID,'sdk-v1')
def ctx():return AgentObservationContext(RUN,SID,'sdk-v1',AgentBinding('sdk-tenant',SID,'target_'+uid(4),'run_'+uid(5)),AgentObservationDocument(uid(6),1,1))
def wire_ctx():return dict(agentRunId=RUN,sessionId=SID,version='sdk-v1',binding=dict(tenantId='sdk-tenant',sessionId=SID,targetId='target_'+uid(4),runId='run_'+uid(5)),document=dict(controlSessionId=uid(6),pageEpoch=1,viewportVersion=1))
def node():return dict(elementId='elh_'+uid(10),tag='span',id='status',role='status',name='',text='ready',value=None,redacted=False)
def record(**patch):return wire_ctx()|dict(stage='observed',observationId='obs_'+uid(11),revision=1,observedAt=AT,scope='main-document-light-dom',query=dict(kind='snapshot'),limits=dict(maxNodes=8,maxChars=1024,maxVisited=128),url='https://fixture.test/order',title='Order',nodes=[node()],visited=1,truncated=False)|patch
def response(value=None,status=200,headers=None,stream=None,raw=None):
 payload=json.dumps(dict(data=record()if value is None else value,requestId=RID)).encode()if raw is None else raw
 return httpx.Response(status,headers={'content-type':'application/json','x-request-id':RID,**(headers or{})},stream=stream or Body(payload))
def snapshot():return AgentObservationInput(AgentSnapshotQuery())

class ObservationContracts(unittest.IsolatedAsyncioTestCase):
 async def client(self,handler,**opts):
  c=AgentClient(base_url='https://api.fixture.test',api_key=KEY,transport=httpx.MockTransport(handler),**opts);self.addAsyncCleanup(c.aclose);return c
 def invalid(self,call):
  with self.assertRaises(AgentClientError)as e:call()
  self.assertEqual((e.exception.code,e.exception.outcome),('CLIENT_INVALID_REQUEST','not-dispatched'))
 async def reject(self,call,code='CLIENT_INVALID_RESPONSE'):
  with self.assertRaises(AgentClientError)as e:await call
  self.assertEqual(e.exception.code,code);return e.exception
 async def test_context_captured_before_await_and_frozen_without_writer_fence(self):
  calls=[];c=await self.client(lambda r:(calls.append(r),response(wire_ctx()))[1]);r=ref();pending=c.observations.context(r);object.__setattr__(r,'version','changed');result=(await pending).data
  self.assertEqual(result.version,'sdk-v1');self.assertFalse(hasattr(result,'fence'));self.assertFalse(hasattr(result.document,'control_version'));self.assertNotIn('idempotency-key',calls[0].headers)
  with self.assertRaises(FrozenInstanceError):result.document.page_epoch=2
 async def test_context_query_limits_and_private_timeout_capture_before_await(self):
  calls=[]
  def handler(req):
   wire=json.loads(req.content);calls.append(wire);return response(record(query=wire['query'],limits=wire['limits']))
  c=await self.client(handler);context=ctx();q=AgentLocateQuery('testId','status');l=AgentObservationLimits(1,16,32);value=AgentObservationInput(q,l,50);pending=c.observations.read(context,value);object.__setattr__(context.document,'page_epoch',9);object.__setattr__(q,'value','changed');object.__setattr__(l,'max_chars',0);object.__setattr__(value,'rpc_timeout_ms',500)
  result=(await pending).data;self.assertEqual(calls[0]['context']['document']['pageEpoch'],1);self.assertEqual(calls[0]['query']['value'],'status');self.assertEqual(calls[0]['limits']['maxChars'],16);self.assertEqual(calls[0]['rpcTimeoutMs'],50);self.assertIsInstance(result.nodes,tuple)
  with self.assertRaises(FrozenInstanceError):result.nodes[0].text='changed'
  with self.assertRaises(FrozenInstanceError):result.query.value='changed'
 async def test_snapshot_locate_and_element_queries_with_exact_limits_and_zero_text(self):
  def handler(req):
   wire=json.loads(req.content);return response(record(query=wire['query'],limits=wire['limits'],nodes=[node()|dict(text='')]))
  c=await self.client(handler)
  for q in [AgentSnapshotQuery(),AgentLocateQuery('id','status'),AgentLocateQuery('tag','span'),AgentLocateQuery('testId','status'),AgentElementQuery(AgentElementId('elh_'+uid(10)))]:
   result=(await c.observations.read(ctx(),AgentObservationInput(q,AgentObservationLimits(max_chars=0)))).data;self.assertEqual(result.query,q);self.assertEqual(result.limits.max_chars,0)
 async def test_invalid_reference_context_and_accessor_subclasses_do_not_send(self):
  calls=[];c=await self.client(lambda r:calls.append(r))
  for r in [dict(agent_run_id=RUN,session_id=SID,version='sdk-v1'),replace(ref(),version=''),replace(ref(),agent_run_id=AgentRunId('arun_bad'))]:self.invalid(lambda:c.observations.context(r))
  for context in [dict(),replace(ctx(),session_id=SessionId('ses_'+uid(99))),replace(ctx(),binding=replace(ctx().binding,tenant_id='bad space')),replace(ctx(),document=replace(ctx().document,page_epoch=True))]:self.invalid(lambda:c.observations.read(context,snapshot()))
  class Evil(AgentObservationContext):
   @property
   def version(self):raise AssertionError('getter executed')
  self.invalid(lambda:c.observations.read(object.__new__(Evil),snapshot()));self.assertEqual(calls,[])
 async def test_query_limits_bool_unicode_css_arbitrary_code_and_timeout_rejected(self):
  calls=[];c=await self.client(lambda r:calls.append(r))
  for value in [dict(query=dict(kind='snapshot')),AgentObservationInput(dict(kind='evaluate',expression='private')),AgentObservationInput(AgentLocateQuery('css','*')),AgentObservationInput(AgentLocateQuery('tag','DIV')),AgentObservationInput(AgentLocateQuery('id','bad\x00')),AgentObservationInput(AgentLocateQuery('id','😀'*65)),AgentObservationInput(AgentElementQuery(AgentElementId(RUN))),*[AgentObservationInput(AgentSnapshotQuery(),l)for l in [None,dict(),AgentObservationLimits(max_chars=True),AgentObservationLimits(max_chars=2049),AgentObservationLimits(max_nodes=17),AgentObservationLimits(max_visited=257)]],AgentObservationInput(AgentSnapshotQuery(),rpc_timeout_ms=49)]:self.invalid(lambda:c.observations.read(ctx(),value))
  with self.assertRaises(TypeError):c.observations.read(ctx(),snapshot(),retries=1)
  self.assertEqual(calls,[])
 async def test_context_response_exact_ids_version_document_status_location(self):
  for patch in [dict(agentRunId='arun_'+uid(99)),dict(sessionId='ses_'+uid(99)),dict(version='wrong'),dict(fence={}),dict(document=wire_ctx()['document']|dict(controlVersion=0))]:
   c=await self.client(lambda r,p=patch:response(wire_ctx()|p));await self.reject(c.observations.context(ref()))
  for reply in [response(wire_ctx(),202),response(wire_ctx(),headers={'location':'/unexpected'})]:
   c=await self.client(lambda r,p=reply:p);await self.reject(c.observations.context(ref()))
 async def test_reply_must_match_captured_logical_worker_document_query_and_budget(self):
  for patch in [dict(agentRunId='arun_'+uid(99)),dict(sessionId='ses_'+uid(99)),dict(version='wrong'),dict(binding=wire_ctx()['binding']|dict(targetId='target_'+uid(99))),dict(binding=wire_ctx()['binding']|dict(runId='run_'+uid(99))),dict(binding=wire_ctx()['binding']|dict(tenantId='other')),dict(document=wire_ctx()['document']|dict(pageEpoch=2)),dict(document=wire_ctx()['document']|dict(viewportVersion=2)),dict(query=dict(kind='locate',by='id',value='status')),dict(limits=dict(maxNodes=8,maxChars=1000,maxVisited=128)),dict(scope='computed-AX'),dict(rawHtml='private')]:
   c=await self.client(lambda r,p=patch:response(record(**p)));await self.reject(c.observations.read(ctx(),snapshot()))
 async def test_metadata_handles_redaction_and_utf16_budget_are_validated(self):
  for patch in [dict(observationId='bad'),dict(revision=True),dict(observedAt='2026-10-20'),dict(observedAt='2026-02-30T00:00:00.000Z'),dict(url='x'*1025),dict(visited=129),dict(visited=0),dict(truncated=1),dict(nodes=[node(),node()]),dict(nodes=[node()|dict(redacted=True)]),dict(nodes=[node()|dict(value='x'*1024)]),dict(nodes=[node()|dict(elementId=RUN)]),dict(nodes=[node()|dict(rawHtml='private')]),dict(nodes=[node()|dict(text='😀'*513)])]:
   c=await self.client(lambda r,p=patch:response(record(**p)));await self.reject(c.observations.read(ctx(),snapshot()))
  for n in [node()|dict(text='😀'*512),node()|dict(text='',value=None,redacted=True)]:
   c=await self.client(lambda r,p=n:response(record(nodes=[p])));self.assertEqual((await c.observations.read(ctx(),snapshot())).data.nodes[0].text,n['text'])
 async def test_source_and_public_utf8_caps_are_distinct_from_transport_budget(self):
  for chars,url in [(2048,1024),(1024,800)]:
   value=record(url='中'*url,title='中'*256,nodes=[node()|dict(text='中'*chars)],limits=dict(maxNodes=8,maxChars=chars,maxVisited=128));size=len(json.dumps(value,ensure_ascii=False,separators=(',',':')).encode());self.assertGreater(size,8192 if chars==2048 else 6144)
   if chars==1024:self.assertLess(size,8192)
   c=await self.client(lambda r,p=value:response(p));await self.reject(c.observations.read(ctx(),AgentObservationInput(AgentSnapshotQuery(),AgentObservationLimits(max_chars=chars))))
 async def test_observation_sends_once_despite_mutation_retries_and_redacts_remote_messages(self):
  for method in ['context','read']:
   for mode in ['transport','timeout','stale']:
    calls=[]
    def handler(req):
     calls.append(req)
     if mode=='transport':raise RuntimeError('private '+KEY)
     return failure('AGENT_RPC_TIMEOUT',504,'unknown')if mode=='timeout'else failure('STALE_AGENT_ELEMENT',409,'not-dispatched')
    c=await self.client(handler,retries=3);e=await self.reject(c.observations.context(ref())if method=='context'else c.observations.read(ctx(),snapshot()),'CLIENT_TRANSPORT_ERROR'if mode=='transport'else'AGENT_RPC_TIMEOUT'if mode=='timeout'else'STALE_AGENT_ELEMENT');self.assertEqual(len(calls),1);self.assertNotIn(KEY,str(e))
 async def test_envelope_phase_correlation_encoding_and_content_type(self):
  for reply in [response(status=202),response(headers={'location':'/unexpected'}),response(headers={'x-request-id':'req_wrong'}),response(headers={'content-type':'text/plain'}),response(headers={'content-encoding':'gzip'}),response(raw=b'\xff')]:
   c=await self.client(lambda r,p=reply:p);await self.reject(c.observations.read(ctx(),snapshot()))
 async def test_noncooperative_timeout_retains_real_admission_and_separate_end(self):
  gate=asyncio.Event();entered=asyncio.Event();calls=[]
  async def handler(req):
   calls.append(req)
   if req.url.path.endswith('/end'):return mutation_response(run(state='closed',holdsWriter=False,endDispatch='confirmed'))
   entered.set()
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return response(wire_ctx())
  c=await self.client(handler,timeout_seconds=.05,retries=3,max_concurrent_requests=1)
  try:
   e=await self.reject(c.observations.context(ref()),'CLIENT_TIMEOUT');self.assertEqual(e.outcome,'unknown');self.assertEqual(c.transport_status().ordinary,1);await self.reject(c.observations.read(ctx(),snapshot()),'CLIENT_BUSY');self.assertEqual((await c.runs.end(RUN)).data.state,'closed');self.assertEqual(len(calls),2)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_caller_cancellation_does_not_release_noncooperative_read_or_retry(self):
  gate=asyncio.Event();entered=asyncio.Event();calls=[]
  async def handler(req):
   calls.append(req);entered.set()
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return response()
  c=await self.client(handler,retries=3,max_concurrent_requests=1);task=asyncio.create_task(c.observations.read(ctx(),snapshot()))
  try:
   await entered.wait();task.cancel()
   with self.assertRaises(AgentClientCancelledError)as e:await task
   self.assertEqual(e.exception.outcome,'unknown');self.assertEqual(c.transport_status().ordinary,1);self.assertEqual(len(calls),1)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_actual_body_close_remains_counted_after_local_timeout(self):
  gate=asyncio.Event();entered=asyncio.Event()
  class Slow(Body):
   async def aclose(self):
    entered.set()
    while not gate.is_set():
     try:await gate.wait()
     except asyncio.CancelledError:pass
  body=Slow(json.dumps(dict(data=record(),requestId=RID)).encode());c=await self.client(lambda r:response(stream=body),timeout_seconds=.05,max_concurrent_requests=1)
  try:
   await self.reject(c.observations.read(ctx(),snapshot()),'CLIENT_TIMEOUT');self.assertTrue(entered.is_set());self.assertEqual(c.transport_status().ordinary,1)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_aclose_is_single_flight_and_stays_pending_until_real_read_settles(self):
  gate=asyncio.Event()
  async def handler(req):
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return response()
  c=await self.client(handler,timeout_seconds=.05)
  try:
   await self.reject(c.observations.read(ctx(),snapshot()),'CLIENT_TIMEOUT');await self.reject(c.aclose(),'CLIENT_CLOSE_PENDING');self.assertEqual(c.transport_status().ordinary,1);await self.reject(c.observations.context(ref()),'CLIENT_CLOSED')
  finally:gate.set();await c.aclose();self.assertEqual(c.transport_status().ordinary,0)
 async def test_body_close_failure_fails_client_closed_without_sensitive_details(self):
  class Broken(Body):
   async def aclose(self):raise RuntimeError('private-close')
  body=Broken(json.dumps(dict(data=record(),requestId=RID)).encode());c=await self.client(lambda r:response(stream=body));e=await self.reject(c.observations.read(ctx(),snapshot()),'CLIENT_RESPONSE_CLOSE_FAILED');self.assertNotIn('private-close',str(e));await self.reject(c.observations.context(ref()),'CLIENT_CLOSED')

class ActualObservationHttp(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.child=await asyncio.create_subprocess_exec(os.environ.get('SESSION_PYTHON_TEST_NODE','node'),str(Path(__file__).resolve().parents[1]/'fixtures/observation-python-http.mjs'),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE);self.addAsyncCleanup(self.close);self.ready=json.loads(await asyncio.wait_for(self.child.stdout.readline(),3));self.clients=[]
 async def close(self):
  for c in self.clients:await c.aclose()
  if self.child.returncode is None:
   self.child.stdin.write(b'close\n');await self.child.stdin.drain();self.child.stdin.close();await self.child.stdin.wait_closed();out,err=await asyncio.wait_for(self.child.communicate(),3);self.assertEqual(self.child.returncode,0,err.decode()[-2000:])
 async def command(self,text):self.child.stdin.write((text+'\n').encode());await self.child.stdin.drain();return json.loads(await asyncio.wait_for(self.child.stdout.readline(),3))
 def client(self,role):
  c=AgentClient(base_url=self.ready['base'],api_key=self.ready['keys'][role]);self.clients.append(c);return c
 def reference(self):r=self.ready['run'];return AgentObservationReference(AgentRunId(r['agentRunId']),SessionId(r['sessionId']),r['version'])
 async def test_independent_scope_and_real_sqlite_executor_metadata(self):
  reader=self.client('observe');c=(await reader.observations.context(self.reference())).data;result=(await reader.observations.read(c,AgentObservationInput(AgentLocateQuery('testId','SDK-PYTHON-PRIVATE-QUERY')))).data;self.assertEqual(result.nodes[0].text,'private-observation-DOM');self.assertEqual(result.version,self.reference().version)
  for coro in [reader.runs.context(AgentRunReference(c.agent_run_id,c.session_id)),reader.runs.end(c.agent_run_id),self.client('read').observations.context(self.reference())]:
   with self.assertRaises(AgentClientError)as e:await coro
   self.assertEqual(e.exception.code,'FORBIDDEN')
  self.assertEqual((await self.command('stats'))['effects'],0)
 async def test_known_unknown_input_observable_without_recovery_or_history_upgrade(self):
  reader=self.client('observe');unknown=(await self.command('unknown'))['invocation'];before=(await self.command('stats'))['run'];c=(await reader.observations.context(self.reference())).data;self.assertEqual((await reader.observations.read(c,snapshot())).data.stage,'observed');self.assertEqual((await self.command('stats'))['run'],before);row=(await self.client('all').invocations.get(unknown['invocationId'])).data;self.assertEqual(row.state,'unknown');self.assertEqual(row.error.outcome,'unknown');await self.client('end').runs.end(c.agent_run_id)
 async def test_http_deadline_retains_executor_slot_and_independent_end(self):
  reader=self.client('observe');c=(await reader.observations.context(self.reference())).data;await self.command('hold')
  try:
   with self.assertRaises(AgentClientError)as e:await reader.observations.read(c,snapshot())
   self.assertEqual(e.exception.code,'REQUEST_TIMEOUT');self.assertEqual(reader.transport_status().ordinary,0);self.assertEqual((await self.command('stats'))['ordinary'],1);await self.client('end').runs.end(c.agent_run_id)
  finally:await self.command('release')
