from __future__ import annotations
import asyncio
from dataclasses import FrozenInstanceError,replace
import json,os
from pathlib import Path
import unittest
import httpx
from _fixture_process import close_node_fixture
from remote_paint_session import (AgentClient,AgentClientError,AgentClientCancelledError,AgentRunId,SessionId,AgentRunReference,
 AgentElementId,AgentObservationReference,AgentObservationInput,AgentSnapshotQuery,AgentAccessibilityInput,AgentAccessibilityLimits,
 AgentAccessibilityVisible,AgentAccessibilityRedacted)
from test_agent_client import KEY,AT,RID,RUN,SID,uid,Body,run,response as mutation_response,failure,until
from test_observation_client import ctx,wire_ctx,snapshot

def request(**patch):return AgentAccessibilityInput(AgentElementId('elh_'+uid(10)),**patch)
def projection(**patch):return dict(ignored=False,role='textbox',name='Name',description='Description',value='123',states=dict(readonly=True,required=True,checked='mixed'))|patch
def record(**patch):return wire_ctx()|dict(stage='accessibility-observed',scope='main-document-element-accessibility',elementId='elh_'+uid(10),limits=dict(maxChars=256),observationId='obs_'+uid(11),revision=1,observedAt=AT,url='https://fixture.test/order',title='Order',ax=projection(),redacted=False,truncated=False)|patch
def response(value=None,status=200,headers=None,stream=None,raw=None):
 payload=json.dumps(dict(data=record()if value is None else value,requestId=RID)).encode()if raw is None else raw
 return httpx.Response(status,headers={'content-type':'application/json','x-request-id':RID,**(headers or{})},stream=stream or Body(payload))

class AccessibilityContracts(unittest.IsolatedAsyncioTestCase):
 async def client(self,handler,**opts):
  c=AgentClient(base_url='https://api.fixture.test',api_key=KEY,transport=httpx.MockTransport(handler),**opts);self.addAsyncCleanup(c.aclose);return c
 def invalid(self,call):
  with self.assertRaises(AgentClientError)as e:call()
  self.assertEqual((e.exception.code,e.exception.outcome),('CLIENT_INVALID_REQUEST','not-dispatched'))
 async def reject(self,call,code='CLIENT_INVALID_RESPONSE'):
  with self.assertRaises(AgentClientError)as e:await call
  self.assertEqual(e.exception.code,code);return e.exception
 async def test_ax_context_element_limits_timeout_are_captured_before_await(self):
  calls=[]
  def handler(req):
   wire=json.loads(req.content);calls.append(req);return response(record(limits=wire['limits']))
  c=await self.client(handler);context=ctx();limits=AgentAccessibilityLimits(64);value=request(limits=limits,rpc_timeout_ms=50);pending=c.observations.accessibility(context,value);object.__setattr__(context.document,'page_epoch',99);object.__setattr__(context.binding,'target_id','changed');object.__setattr__(value,'element_id',AgentElementId('elh_'+uid(99)));object.__setattr__(limits,'max_chars',0);object.__setattr__(value,'rpc_timeout_ms',100)
  result=(await pending).data;wire=json.loads(calls[0].content);self.assertEqual(wire['context'],wire_ctx());self.assertEqual(wire['elementId'],'elh_'+uid(10));self.assertEqual(wire['limits'],dict(maxChars=64));self.assertEqual(wire['rpcTimeoutMs'],50);self.assertEqual(calls[0].url.path,'/v1/agent-runs/'+RUN+'/accessibility-observations');self.assertNotIn('idempotency-key',calls[0].headers);self.assertEqual(result.limits.max_chars,64)
 async def test_ax_frozen_slotted_projection_states_and_discriminated_redaction(self):
  c=await self.client(lambda r:response());v=(await c.observations.accessibility(ctx(),request())).data;self.assertIsInstance(v,AgentAccessibilityVisible);self.assertFalse(v.redacted);self.assertTrue(v.ax.states.readonly);self.assertIsNone(v.ax.states.focusable);self.assertEqual(v.ax.states.checked,'mixed');self.assertFalse(hasattr(v,'__dict__'))
  for item,key,value in [(v,'title','changed'),(v.ax,'name','changed'),(v.ax.states,'checked',False),(v.document,'page_epoch',2),(v.limits,'max_chars',0)]:
   with self.assertRaises(FrozenInstanceError):setattr(item,key,value)
  red=await self.client(lambda r:response(record(ax=None,redacted=True)));masked=(await red.observations.accessibility(ctx(),request())).data;self.assertIsInstance(masked,AgentAccessibilityRedacted);self.assertTrue(masked.redacted);self.assertIsNone(masked.ax)
 async def test_ax_default_zero_max_budgets_and_unicode_use_utf16_units(self):
  def handler(req):
   n=json.loads(req.content)['limits']['maxChars'];return response(record(limits=dict(maxChars=n),ax=projection(name='😀'*(n//2),description='',value=None,states={}),truncated=True))
  c=await self.client(handler)
  for n in [0,2,256,512]:
   r=(await c.observations.accessibility(ctx(),request(limits=AgentAccessibilityLimits(n)))).data;self.assertEqual(len(r.ax.name),n//2)
  bad=await self.client(lambda r:response(record(ax=projection(name='😀'*129,description='',value=None))));await self.reject(bad.observations.accessibility(ctx(),request()))
 async def test_ax_invalid_typed_input_context_limits_timeout_subclasses_send_nothing(self):
  calls=[];c=await self.client(lambda r:calls.append(r))
  for value in [dict(elementId='elh_'+uid(10)),AgentAccessibilityInput(RUN),request(limits=None),request(limits=dict(maxChars=1)),request(limits=AgentAccessibilityLimits(True)),request(limits=AgentAccessibilityLimits(513)),request(limits=AgentAccessibilityLimits(-1)),request(rpc_timeout_ms=49),request(rpc_timeout_ms=True),request(rpc_timeout_ms=120001)]:self.invalid(lambda:c.observations.accessibility(ctx(),value))
  for context in [{},replace(ctx(),version=''),replace(ctx(),document=replace(ctx().document,page_epoch=True)),replace(ctx(),session_id=SessionId('ses_'+uid(99)))]:self.invalid(lambda:c.observations.accessibility(context,request()))
  class Evil(AgentAccessibilityInput):
   @property
   def element_id(self):raise AssertionError('getter executed')
  self.invalid(lambda:c.observations.accessibility(ctx(),object.__new__(Evil)))
  with self.assertRaises(TypeError):c.observations.accessibility(ctx(),request(),retries=1)
  self.assertEqual(calls,[])
 async def test_ax_reply_exact_logical_worker_version_document_element_budget_identity(self):
  patches=[dict(agentRunId='arun_'+uid(99)),dict(sessionId='ses_'+uid(99)),dict(version='wrong'),*[dict(binding=wire_ctx()['binding']|{k:v})for k,v in [('tenantId','other'),('targetId','target_'+uid(99)),('runId','run_'+uid(99))]],*[dict(document=wire_ctx()['document']|{k:v})for k,v in [('pageEpoch',2),('viewportVersion',2),('controlSessionId',uid(99))]],dict(elementId='elh_'+uid(99)),dict(limits=dict(maxChars=255)),dict(limits=dict(maxChars=True)),dict(limits=dict(maxChars=256,extra=1))]
  for p in patches:
   c=await self.client(lambda r,p=p:response(record(**p)));await self.reject(c.observations.accessibility(ctx(),request()))
 async def test_ax_metadata_redaction_projection_and_state_whitelist(self):
  patches=[dict(stage='observed'),dict(scope='whole-tree'),dict(observedAt='2026-02-30T00:00:00.000Z'),dict(observationId='bad'),dict(revision=True),dict(truncated=1),dict(redacted=1),dict(redacted=True),dict(ax=None),dict(rawNodes=[]),dict(ax=projection(backendNodeId=1)),dict(ax=projection(value=1)),dict(ax=projection(ignored=0)),dict(ax=projection(role='x'*65)),dict(ax=projection(name='x'*513)),*[dict(ax=projection(states={k:v}))for k,v in [('disabled',None),('focused',1),('checked','true'),('pressed',0),('sources',[]),('unknown',False)]]]
  for p in patches:
   c=await self.client(lambda r,p=p:response(record(**p)));await self.reject(c.observations.accessibility(ctx(),request()))
 async def test_ax_source_public_and_transport_bytes_correlated_envelope(self):
  for url in [1000,1024]:
   v=record(url='中'*url,title='中'*256,ax=projection(role='中'*64,name='中'*512,description='',value=None),limits=dict(maxChars=512));size=len(json.dumps(v,ensure_ascii=False,separators=(',',':')).encode());self.assertGreater(size-128,6144);c=await self.client(lambda r,v=v:response(v));await self.reject(c.observations.accessibility(ctx(),request(limits=AgentAccessibilityLimits(512))))
  for reply in [response(status=202),response(headers={'location':'/unexpected'}),response(headers={'x-request-id':'wrong'}),response(headers={'content-type':'text/plain'}),response(headers={'content-encoding':'gzip'}),response(raw=b'\xff')]:
   c=await self.client(lambda r,p=reply:p);await self.reject(c.observations.accessibility(ctx(),request()))
  c=await self.client(lambda r:response(record(url='x'*1024)),max_response_bytes=1024);await self.reject(c.observations.accessibility(ctx(),request()))
 async def test_ax_single_attempt_despite_mutation_retries_errors_are_sanitized(self):
  for mode in ['transport','stale','timeout']:
   calls=[]
   def handler(req):
    calls.append(req)
    if mode=='transport':raise RuntimeError('private '+KEY)
    return failure('STALE_AGENT_ELEMENT',409,'not-dispatched')if mode=='stale'else failure('AGENT_RPC_TIMEOUT',504,'unknown')
   c=await self.client(handler,retries=3);e=await self.reject(c.observations.accessibility(ctx(),request()),'CLIENT_TRANSPORT_ERROR'if mode=='transport'else'STALE_AGENT_ELEMENT'if mode=='stale'else'AGENT_RPC_TIMEOUT');self.assertEqual(len(calls),1);self.assertNotIn(KEY,str(e))
 async def test_ax_noncooperative_timeout_shares_actual_slot_and_has_independent_end(self):
  gate=asyncio.Event();calls=[]
  async def handler(req):
   calls.append(req)
   if req.url.path.endswith('/end'):return mutation_response(run(state='closed',holdsWriter=False,endDispatch='confirmed'))
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return response()
  c=await self.client(handler,timeout_seconds=.05,retries=3,max_concurrent_requests=1)
  try:
   await self.reject(c.observations.accessibility(ctx(),request()),'CLIENT_TIMEOUT');self.assertEqual(c.transport_status().ordinary,1);await self.reject(c.observations.read(ctx(),snapshot()),'CLIENT_BUSY');self.assertEqual((await c.runs.end(RUN)).data.state,'closed');self.assertEqual(len(calls),2)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_ax_caller_cancel_retains_noncooperative_task_and_no_retry(self):
  gate=asyncio.Event();entered=asyncio.Event();calls=[]
  async def handler(req):
   calls.append(req);entered.set()
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return response()
  c=await self.client(handler,retries=3,max_concurrent_requests=1);task=asyncio.create_task(c.observations.accessibility(ctx(),request()))
  try:
   await entered.wait();task.cancel()
   with self.assertRaises(AgentClientCancelledError):await task
   self.assertEqual(c.transport_status().ordinary,1);self.assertEqual(len(calls),1)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_ax_actual_body_close_is_counted_after_timeout(self):
  gate=asyncio.Event();entered=asyncio.Event()
  class Slow(Body):
   async def aclose(self):
    entered.set()
    while not gate.is_set():
     try:await gate.wait()
     except asyncio.CancelledError:pass
  c=await self.client(lambda r:response(stream=Slow(json.dumps(dict(data=record(),requestId=RID)).encode())),timeout_seconds=.05,max_concurrent_requests=1)
  try:
   await self.reject(c.observations.accessibility(ctx(),request()),'CLIENT_TIMEOUT');self.assertTrue(entered.is_set());self.assertEqual(c.transport_status().ordinary,1)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_ax_aclose_pending_tracks_actual_task_and_remains_closed(self):
  gate=asyncio.Event()
  async def handler(req):
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return response()
  c=await self.client(handler,timeout_seconds=.05)
  try:
   await self.reject(c.observations.accessibility(ctx(),request()),'CLIENT_TIMEOUT');await self.reject(c.aclose(),'CLIENT_CLOSE_PENDING');await self.reject(c.observations.accessibility(ctx(),request()),'CLIENT_CLOSED');self.assertEqual(c.transport_status().ordinary,1)
  finally:gate.set();await c.aclose();self.assertEqual(c.transport_status().ordinary,0)

class AccessibilityHttpContracts(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.clients=[]
  self.child=await asyncio.create_subprocess_exec(os.environ.get('NODE','node'),str(Path(__file__).parents[1]/'fixtures/accessibility-python-http.mjs'),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE);self.addAsyncCleanup(self.close)
  self.ready=json.loads(await asyncio.wait_for(self.child.stdout.readline(),3))
 async def close(self):
  await close_node_fixture(self.child,self.clients)
 async def command(self,text):self.child.stdin.write((text+'\n').encode());await self.child.stdin.drain();return json.loads(await asyncio.wait_for(self.child.stdout.readline(),3))
 def client(self,role):
  c=AgentClient(base_url=self.ready['base'],api_key=self.ready['keys'][role]);self.clients.append(c);return c
 async def prepared(self):
  r=self.ready['run'];reader=self.client('observe');context=(await reader.observations.context(AgentObservationReference(AgentRunId(r['agentRunId']),SessionId(r['sessionId']),r['version']))).data;dom=(await reader.observations.read(context,snapshot())).data;return reader,context,AgentAccessibilityInput(dom.nodes[0].element_id)
 async def test_ax_http_independent_scope_and_installed_models(self):
  reader,c,value=await self.prepared();r=(await reader.observations.accessibility(c,value)).data;self.assertEqual(r.ax.name,'private-computed-AX-name');self.assertTrue(r.ax.states.required)
  for role in ['read','write','end']:
   with self.assertRaises(AgentClientError)as e:await self.client(role).observations.accessibility(c,value)
   self.assertEqual(e.exception.code,'FORBIDDEN')
  self.assertEqual((await self.command('stats'))['effects'],0)
 async def test_ax_http_redacted_and_zero_budget_projection(self):
  reader,c,value=await self.prepared();zero=(await reader.observations.accessibility(c,replace(value,limits=AgentAccessibilityLimits(0)))).data;self.assertEqual(zero.ax.name,'');self.assertTrue(zero.truncated);await self.command('redact');self.assertIsInstance((await reader.observations.accessibility(c,value)).data,AgentAccessibilityRedacted)
 async def test_ax_http_unknown_input_read_preserves_history_and_quarantine(self):
  reader,c,value=await self.prepared();unknown=(await self.command('unknown'))['invocation'];before=(await self.command('stats'))['run'];self.assertEqual((await reader.observations.accessibility(c,value)).data.stage,'accessibility-observed');self.assertEqual((await self.command('stats'))['run'],before);row=(await self.client('read').invocations.get(unknown['invocationId'])).data;self.assertEqual(row.state,'unknown');await self.client('end').runs.end(c.agent_run_id)
 async def test_ax_http_stale_is_typed_and_does_not_quarantine_writer(self):
  reader,c,value=await self.prepared();before=(await self.command('stats'))['run'];await self.command('stale')
  with self.assertRaises(AgentClientError)as e:await reader.observations.accessibility(c,value)
  self.assertEqual(e.exception.code,'STALE_AGENT_ELEMENT');self.assertEqual((await self.command('stats'))['run'],before)
 async def test_ax_http_408_retains_actual_executor_with_independent_end(self):
  reader,c,value=await self.prepared();await self.command('hold')
  try:
   with self.assertRaises(AgentClientError)as e:await reader.observations.accessibility(c,value)
   self.assertEqual(e.exception.code,'REQUEST_TIMEOUT');self.assertEqual(reader.transport_status().ordinary,0);self.assertEqual((await self.command('stats'))['ordinary'],1);await self.client('end').runs.end(c.agent_run_id)
  finally:await self.command('release')
