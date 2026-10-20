from __future__ import annotations
import asyncio,base64,hashlib,json,os
from dataclasses import FrozenInstanceError,replace
from pathlib import Path
import unittest
import httpx
from remote_paint_session import (AgentClient,AgentClientError,AgentClientCancelledError,AgentRunId,SessionId,AgentObservationReference,
 AgentDownloadId,AgentDownloadLimits,AgentDownloadArmInput,AgentDownloadTicketInput,AgentDownloadChunkInput,AgentDownloadFileInput,
 AgentDownloadArmed,AgentDownloadPending,AgentDownloadReady,AgentDownloadChunk,AgentDownloadReleased,AgentDownloadFile)
from test_agent_client import KEY,AT,RID,RUN,uid,Body,run,response as mutation_response,failure,until
from test_observation_client import ctx,wire_ctx
DATA=bytes([0,255,128,17,9]);DL=AgentDownloadId('dl_'+uid(10));SHA=hashlib.sha256(DATA).hexdigest()
def file_input(b=DATA,**patch):return AgentDownloadFileInput(DL,hashlib.sha256(b).hexdigest(),len(b),AT,**patch)
def meta(stage='download-armed',**patch):return wire_ctx()|dict(stage=stage,scope='next-owned-page-download',downloadId=DL,armedAt=AT,limits=dict(maxBytes=1048576,timeoutMs=10000))|patch
def ready(**patch):return meta('download-ready',completedAt=AT,fileName='report.bin',mimeType='application/octet-stream',byteLength=len(DATA),sha256=SHA)|patch
def chunk(**patch):return wire_ctx()|dict(stage='download-chunk',downloadId=DL,sha256=SHA,completedAt=AT,offset=0,byteLength=len(DATA),totalBytes=len(DATA),data=base64.b64encode(DATA).decode(),complete=True)|patch
def released():return wire_ctx()|dict(stage='download-released',downloadId=DL)
def response(value=None,status=200,headers=None):return httpx.Response(status,headers={'content-type':'application/json','x-request-id':RID,**(headers or{})},stream=Body(json.dumps(dict(data=meta()if value is None else value,requestId=RID)).encode()))
def binary_headers(patch=None,request=None,context=None):
 r=request or file_input();encoded=base64.urlsafe_b64encode(json.dumps(context or wire_ctx(),separators=(',',':')).encode()).rstrip(b'=').decode()
 return {'content-type':'application/octet-stream','content-length':str(r.byte_length),'content-disposition':'attachment; filename="'+r.download_id+'.bin"','content-digest':'sha-256=:'+base64.b64encode(bytes.fromhex(r.sha256)).decode()+':','cache-control':'no-store','x-content-type-options':'nosniff','x-request-id':RID,'x-download-id':r.download_id,'x-download-sha256':r.sha256,'x-download-completed-at':r.completed_at,'x-agent-observation-context':encoded,**(patch or{})}
def binary(content=DATA,headers=None,status=200,stream=None,request=None):return httpx.Response(status,headers=binary_headers(headers,request),stream=stream or Body(content))
class DownloadContracts(unittest.IsolatedAsyncioTestCase):
 async def client(self,handler,**opts):
  c=AgentClient(base_url='https://api.fixture.test',api_key=KEY,transport=httpx.MockTransport(handler),**opts);self.addAsyncCleanup(c.aclose);return c
 def invalid(self,fn):
  with self.assertRaises(AgentClientError)as e:fn()
  self.assertEqual((e.exception.code,e.exception.outcome),('CLIENT_INVALID_REQUEST','not-dispatched'))
 async def reject(self,coro,code='CLIENT_INVALID_RESPONSE'):
  with self.assertRaises(AgentClientError)as e:await coro
  self.assertEqual(e.exception.code,code);return e.exception
 async def test_arm_context_limits_and_deadline_are_captured_before_coroutine(self):
  calls=[]
  def handler(req):calls.append(req);return response(meta(limits=json.loads(req.content)['limits']))
  c=await self.client(handler);context=ctx();limits=AgentDownloadLimits(100,500);value=AgentDownloadArmInput(limits,50);pending=c.observations.arm_download(context,value);object.__setattr__(context.document,'page_epoch',2);object.__setattr__(limits,'max_bytes',1);object.__setattr__(value,'rpc_timeout_ms',500);r=(await pending).data;wire=json.loads(calls[0].content);self.assertEqual(wire['context'],wire_ctx());self.assertEqual(wire['limits'],dict(maxBytes=100,timeoutMs=500));self.assertEqual(wire['rpcTimeoutMs'],50);self.assertEqual(r.limits.max_bytes,100);self.assertNotIn('idempotency-key',calls[0].headers)
 async def test_armed_pending_ready_chunk_and_released_models_are_frozen_slotted(self):
  records=iter([meta(),meta('download-pending'),ready(),chunk(),released()]);c=await self.client(lambda req:response(next(records)));a=(await c.observations.arm_download(ctx())).data;p=(await c.observations.download_info(ctx(),AgentDownloadTicketInput(DL))).data;r=(await c.observations.download_info(ctx(),AgentDownloadTicketInput(DL))).data;part=(await c.observations.download_chunk(ctx(),AgentDownloadChunkInput(DL,0))).data;end=(await c.observations.release_download(ctx(),AgentDownloadTicketInput(DL))).data
  for obj,cls in [(a,AgentDownloadArmed),(p,AgentDownloadPending),(r,AgentDownloadReady),(part,AgentDownloadChunk),(end,AgentDownloadReleased)]:
   self.assertIsInstance(obj,cls);self.assertFalse(hasattr(obj,'__dict__'))
   with self.assertRaises(FrozenInstanceError):obj.download_id=AgentDownloadId('changed')
  self.assertFalse(hasattr(p,'byte_length'));self.assertEqual(base64.b64decode(part.data),DATA)
 async def test_invalid_typed_inputs_ids_limits_getters_context_and_retries_reject_before_send(self):
  calls=[];c=await self.client(lambda req:calls.append(req))
  for value in [{},AgentDownloadArmInput(None),AgentDownloadArmInput(AgentDownloadLimits(True)),AgentDownloadArmInput(AgentDownloadLimits(4194305)),AgentDownloadArmInput(AgentDownloadLimits(timeout_ms=49)),AgentDownloadArmInput(rpc_timeout_ms=120001)]:self.invalid(lambda:c.observations.arm_download(ctx(),value))
  for value in [AgentDownloadChunkInput(AgentDownloadId(RUN),0),AgentDownloadChunkInput(DL,-1),AgentDownloadChunkInput(DL,0,3073)]:self.invalid(lambda:c.observations.download_chunk(ctx(),value))
  class Evil(AgentDownloadArmInput):
   @property
   def limits(self):raise AssertionError('getter ran')
  self.invalid(lambda:c.observations.arm_download(ctx(),object.__new__(Evil)));self.invalid(lambda:c.observations.release_download(ctx(),AgentDownloadChunkInput(DL,0)));self.invalid(lambda:c.observations.arm_download({}))
  with self.assertRaises(TypeError):c.observations.arm_download(ctx(),retries=1)
  self.assertEqual(calls,[])
 async def test_json_context_metadata_phase_filename_time_limits_and_identity_are_strict(self):
  for patch in [dict(agentRunId='arun_'+uid(99)),dict(sessionId='ses_'+uid(99)),dict(version='wrong'),dict(document=wire_ctx()['document']|dict(pageEpoch=2)),dict(scope='all-downloads'),dict(limits=dict(maxBytes=1,timeoutMs=10000)),dict(armedAt='2026-02-30T00:00:00.000Z'),dict(path='/private')]:
   c=await self.client(lambda req,p=patch:response(meta(**p)));await self.reject(c.observations.arm_download(ctx()))
  for patch in [dict(fileName='../../private'),dict(fileName='\u202eprivate'),dict(mimeType='image/png'),dict(byteLength=4194305),dict(sha256='x'),dict(completedAt='not-time'),dict(armedAt='2099-01-01T00:00:00.000Z'),dict(stage='download-pending'),dict(private='x')]:
   c=await self.client(lambda req,p=patch:response(ready(**p)));await self.reject(c.observations.download_info(ctx(),AgentDownloadTicketInput(DL)))
 async def test_chunk_canonical_base64_arithmetic_eof_and_empty_digest_are_strict(self):
  for patch in [dict(offset=1),dict(byteLength=1),dict(data='!!!!'),dict(data='YR==',byteLength=1,totalBytes=1),dict(data='',byteLength=0,complete=False),dict(totalBytes=1),dict(complete=False),dict(downloadId='dl_'+uid(99)),dict(version='wrong')]:
   c=await self.client(lambda req,p=patch:response(chunk(**p)));await self.reject(c.observations.download_chunk(ctx(),AgentDownloadChunkInput(DL,0)))
  empty=chunk(totalBytes=0,byteLength=0,data='',sha256=hashlib.sha256(b'').hexdigest());c=await self.client(lambda req:response(empty));self.assertEqual((await c.observations.download_chunk(ctx(),AgentDownloadChunkInput(DL,0))).data.byte_length,0);bad=await self.client(lambda req:response(empty|dict(sha256=SHA)));await self.reject(bad.observations.download_chunk(ctx(),AgentDownloadChunkInput(DL,0)))
 async def test_json_envelope_request_status_media_location_and_source_budgets(self):
  for kwargs in [dict(status=202),dict(headers={'location':'/private'}),dict(headers={'x-request-id':'req_wrong'}),dict(headers={'content-type':'text/plain'})]:
   c=await self.client(lambda req,k=kwargs:response(**k));await self.reject(c.observations.arm_download(ctx()))
  context=ctx();object.__setattr__(context,'version','\u0000'*256);object.__setattr__(context.binding,'tenant_id','t'*128);wire=wire_ctx();wire['version']=context.version;wire['binding']['tenantId']=context.binding.tenant_id;large=chunk(**wire,data=base64.b64encode(b'x'*3072).decode(),byteLength=3072,totalBytes=4194304,complete=False);c=await self.client(lambda req:response(large));await self.reject(c.observations.download_chunk(context,AgentDownloadChunkInput(DL,0)))
 async def test_file_request_capture_precedes_await_and_returns_frozen_metadata_and_immutable_bytes(self):
  calls=[]
  def handler(req):calls.append(req);return binary()
  c=await self.client(handler);context=ctx();value=file_input(rpc_timeout_ms=50);pending=c.observations.download_file(context,value);object.__setattr__(context.document,'page_epoch',2);object.__setattr__(value,'sha256','a'*64);object.__setattr__(value,'byte_length',1);r=(await pending).data;self.assertIsInstance(r,AgentDownloadFile);self.assertIsInstance(r.content,bytes);self.assertEqual(r.content,DATA);self.assertEqual(json.loads(calls[0].content)['byteLength'],5);self.assertEqual(r.document.page_epoch,1)
  with self.assertRaises(TypeError):r.content[0]=1
  with self.assertRaises(FrozenInstanceError):r.sha256='changed'
 async def test_file_headers_require_exact_media_status_encoding_length_digest_ticket_context_and_attachment(self):
  for patch in [{'content-type':'image/png'},{'content-encoding':'gzip'},{'location':'/private'},{'content-length':'05'},{'content-length':'6'},{'content-digest':'bad'},{'x-download-id':'dl_'+uid(99)},{'x-download-sha256':'a'*64},{'x-download-completed-at':'wrong'},{'x-request-id':'bad'},{'content-disposition':'attachment; filename="../../private"'},{'cache-control':'public'},{'x-content-type-options':'unsafe'},{'x-agent-observation-context':'%%%'}]:
   c=await self.client(lambda req,p=patch:binary(headers=p));await self.reject(c.observations.download_file(ctx(),file_input()))
  for context in [wire_ctx()|dict(version='wrong'),wire_ctx()|dict(private='x'),wire_ctx()|dict(document=wire_ctx()['document']|dict(pageEpoch=2))]:
   encoded=base64.urlsafe_b64encode(json.dumps(context).encode()).rstrip(b'=').decode();c=await self.client(lambda req,e=encoded:binary(headers={'x-agent-observation-context':e}));await self.reject(c.observations.download_file(ctx(),file_input()))
 async def test_file_empty_and_single_byte_are_valid_without_png_assumptions(self):
  for b in [b'',b'\xff']:
   value=file_input(b);c=await self.client(lambda req,d=b,v=value:binary(d,request=v));r=(await c.observations.download_file(ctx(),value)).data;self.assertEqual(r.content,b);self.assertEqual(r.byte_length,len(b))
 async def test_file_truncation_overrun_digest_corruption_and_bad_empty_hash_return_no_partial_data(self):
  for b in [DATA[:-1],DATA+b'0',b'wrong']:
   c=await self.client(lambda req,d=b:binary(d));await self.reject(c.observations.download_file(ctx(),file_input()))
  c=await self.client(lambda req:binary());self.invalid(lambda:c.observations.download_file(ctx(),AgentDownloadFileInput(DL,SHA,0,AT)))
 async def test_separate_download_cap_rejects_synchronously_and_does_not_widen_json_or_screenshot_budget(self):
  for n in [None,True,0,4194305]:
   with self.assertRaises(AgentClientError):AgentClient(base_url='https://api.fixture.test',api_key=KEY,max_download_bytes=n)
  calls=[];c=await self.client(lambda req:calls.append(req),max_download_bytes=1);self.invalid(lambda:c.observations.download_file(ctx(),file_input()));self.assertEqual(calls,[]);c=await self.client(lambda req:binary(),max_response_bytes=1024,max_screenshot_bytes=57,max_download_bytes=5);self.assertEqual((await c.observations.download_file(ctx(),file_input())).data.content,DATA)
 async def test_all_methods_send_once_even_with_mutation_retries_and_errors_are_redacted(self):
  for name,value in [('arm_download',AgentDownloadArmInput()),('download_info',AgentDownloadTicketInput(DL)),('download_chunk',AgentDownloadChunkInput(DL,0)),('release_download',AgentDownloadTicketInput(DL)),('download_file',file_input())]:
   for mode in ['transport','stale','timeout']:
    calls=[]
    def handler(req):
     calls.append(req)
     if mode=='transport':raise RuntimeError('private '+KEY)
     return failure('STALE_AGENT_DOWNLOAD',409,'not-dispatched')if mode=='stale'else failure('AGENT_RPC_TIMEOUT',504,'unknown')
    c=await self.client(handler,retries=3);e=await self.reject(getattr(c.observations,name)(ctx(),value),'CLIENT_TRANSPORT_ERROR'if mode=='transport'else'STALE_AGENT_DOWNLOAD'if mode=='stale'else'AGENT_RPC_TIMEOUT');self.assertEqual(len(calls),1);self.assertNotIn(KEY,str(e))
 async def test_noncooperative_fetch_timeout_holds_actual_task_and_end_remains_independent(self):
  gate=asyncio.Event();calls=[]
  async def handler(req):
   calls.append(req)
   if req.url.path.endswith('/end'):return mutation_response(run(state='closed',holdsWriter=False,endDispatch='confirmed'))
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return binary()
  c=await self.client(handler,timeout_seconds=.05,max_concurrent_requests=1)
  try:
   await self.reject(c.observations.download_file(ctx(),file_input()),'CLIENT_TIMEOUT');self.assertEqual(c.transport_status().ordinary,1);await self.reject(c.observations.arm_download(ctx()),'CLIENT_BUSY');self.assertEqual((await c.runs.end(RUN)).data.state,'closed');self.assertEqual(len(calls),2)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_caller_cancel_holds_noncooperative_task_until_actual_settlement(self):
  gate=asyncio.Event();entered=asyncio.Event()
  async def handler(req):
   entered.set()
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return binary()
  c=await self.client(handler,max_concurrent_requests=1);task=asyncio.create_task(c.observations.download_file(ctx(),file_input()));await entered.wait();task.cancel()
  try:
   with self.assertRaises(AgentClientCancelledError):await task
   self.assertEqual(c.transport_status().ordinary,1)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_bad_header_waits_actual_slow_close_and_close_failure_fences_client(self):
  gate=asyncio.Event();entered=asyncio.Event()
  class Slow(Body):
   async def aclose(self):
    entered.set()
    while not gate.is_set():
     try:await gate.wait()
     except asyncio.CancelledError:pass
  c=await self.client(lambda req:binary(headers={'content-length':'9999999'},stream=Slow(DATA)),timeout_seconds=.05,max_concurrent_requests=1)
  try:
   await self.reject(c.observations.download_file(ctx(),file_input()),'CLIENT_TIMEOUT');self.assertTrue(entered.is_set());self.assertEqual(c.transport_status().ordinary,1)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
  class Broken(Body):
   async def aclose(self):raise RuntimeError('private '+KEY)
  bad=await self.client(lambda req:binary(stream=Broken(DATA)));e=await self.reject(bad.observations.download_file(ctx(),file_input()),'CLIENT_RESPONSE_CLOSE_FAILED');self.assertNotIn(KEY,str(e));await self.reject(bad.observations.arm_download(ctx()),'CLIENT_CLOSED')
 async def test_aclose_is_single_flight_pending_until_noncooperative_task_retires(self):
  gate=asyncio.Event()
  async def handler(req):
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return binary()
  c=await self.client(handler,timeout_seconds=.05)
  try:
   await self.reject(c.observations.download_file(ctx(),file_input()),'CLIENT_TIMEOUT');await self.reject(c.aclose(),'CLIENT_CLOSE_PENDING');self.assertEqual(c.transport_status().ordinary,1);await self.reject(c.observations.arm_download(ctx()),'CLIENT_CLOSED')
  finally:gate.set();await c.aclose();self.assertEqual(c.transport_status().ordinary,0)
 async def test_prebuffered_fragmented_streams_and_empty_prebuffer_are_checked(self):
  c=await self.client(lambda req:httpx.Response(200,headers=binary_headers(),content=DATA));self.assertEqual((await c.observations.download_file(ctx(),file_input())).data.content,DATA)
  class Fragmented(Body):
   async def __aiter__(self):
    for byte in self.data:yield bytes([byte])
  b=b'z'*1000;v=file_input(b);c=await self.client(lambda req:binary(b,request=v,stream=Fragmented(b)));self.assertEqual((await c.observations.download_file(ctx(),v)).data.content,b)
  v=file_input(b'');c=await self.client(lambda req:httpx.Response(200,headers=binary_headers(request=v),content=b''));self.assertEqual((await c.observations.download_file(ctx(),v)).data.content,b'')
class DownloadHttpContracts(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.child=await asyncio.create_subprocess_exec(os.environ.get('NODE','node'),str(Path(__file__).parents[1]/'fixtures/download-python-http.mjs'),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE);self.ready=json.loads(await asyncio.wait_for(self.child.stdout.readline(),3));self.clients=[]
 async def asyncTearDown(self):
  for c in self.clients:await c.aclose()
  if self.child.returncode is None:
   self.child.stdin.write(b'close\n');await self.child.stdin.drain();self.child.stdin.close();await self.child.stdin.wait_closed();out,err=await asyncio.wait_for(self.child.communicate(),3);self.assertEqual(self.child.returncode,0,err.decode()[-2000:])
 async def command(self,text):self.child.stdin.write((text+'\n').encode());await self.child.stdin.drain();return json.loads(await asyncio.wait_for(self.child.stdout.readline(),3))
 def client(self,role):
  c=AgentClient(base_url=self.ready['base'],api_key=self.ready['keys'][role]);self.clients.append(c);return c
 async def prepared(self,emit='emit'):
  r=self.ready['run'];reader=self.client('observe');c=(await reader.observations.context(AgentObservationReference(AgentRunId(r['agentRunId']),SessionId(r['sessionId']),r['version']))).data;a=(await reader.observations.arm_download(c)).data;await self.command(emit)
  for _ in range(100):
   info=(await reader.observations.download_info(c,AgentDownloadTicketInput(a.download_id))).data
   if isinstance(info,AgentDownloadReady):return reader,c,info,AgentDownloadFileInput(info.download_id,info.sha256,info.byte_length,info.completed_at)
   await asyncio.sleep(.001)
  self.fail('file did not become ready')
 async def test_http_models_bytes_release_and_independent_observe_scope(self):
  reader,c,info,value=await self.prepared();part=(await reader.observations.download_chunk(c,AgentDownloadChunkInput(info.download_id,0))).data;self.assertEqual(part.sha256,info.sha256);self.assertEqual((await reader.observations.download_file(c,value)).data.content,DATA);self.assertEqual((await reader.observations.release_download(c,AgentDownloadTicketInput(info.download_id))).data.stage,'download-released')
  for role in ['read','write','end','session']:
   with self.assertRaises(AgentClientError)as e:await self.client(role).observations.arm_download(c)
   self.assertEqual(e.exception.code,'FORBIDDEN')
  self.assertEqual((await self.command('stats'))['effects'],0)
 async def test_http_empty_file_metadata_and_delivery(self):
  reader,c,info,value=await self.prepared('empty');self.assertEqual(info.byte_length,0);self.assertEqual((await reader.observations.download_file(c,value)).data.content,b'')
 async def test_http_known_unknown_history_quarantine_and_input_count_remain(self):
  reader,c,info,value=await self.prepared();unknown=(await self.command('unknown'))['invocation'];before=(await self.command('stats'))['run'];self.assertEqual((await reader.observations.download_file(c,value)).data.sha256,info.sha256);self.assertEqual((await self.command('stats'))['run'],before);self.assertEqual((await self.client('read').invocations.get(unknown['invocationId'])).data.state,'unknown')
 async def test_http_408_retains_backend_source_and_independent_end(self):
  reader,c,info,value=await self.prepared();await self.command('hold')
  try:
   with self.assertRaises(AgentClientError)as e:await reader.observations.download_file(c,value)
   self.assertEqual(e.exception.code,'REQUEST_TIMEOUT');self.assertEqual(e.exception.status,408);self.assertEqual((await self.command('stats'))['ordinary'],1);await self.client('end').runs.end(c.agent_run_id)
  finally:await self.command('release')
 async def test_http_task_cancel_does_not_release_actual_source_or_replay(self):
  reader,c,info,value=await self.prepared();await self.command('hold');task=asyncio.create_task(reader.observations.download_file(c,value))
  try:
   for _ in range(100):
    if(await self.command('stats'))['ordinary']==1:break
    await asyncio.sleep(.001)
   task.cancel()
   with self.assertRaises(AgentClientCancelledError):await task
   self.assertEqual((await self.command('stats'))['ordinary'],1);await self.client('end').runs.end(c.agent_run_id)
  finally:await self.command('release')
 async def test_http_stale_ticket_is_not_automatically_rearmed(self):
  reader,c,info,value=await self.prepared();await reader.observations.release_download(c,AgentDownloadTicketInput(info.download_id));next=(await reader.observations.arm_download(c)).data
  with self.assertRaises(AgentClientError)as e:await reader.observations.download_file(c,value)
  self.assertEqual(e.exception.code,'STALE_AGENT_DOWNLOAD');self.assertNotEqual(next.download_id,info.download_id);self.assertEqual((await self.command('stats'))['calls'].count('arm-download'),2)
