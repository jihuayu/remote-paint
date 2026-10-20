from __future__ import annotations
import asyncio,base64,hashlib,json,os,struct,zlib
from dataclasses import FrozenInstanceError,replace
from pathlib import Path
import unittest
import httpx
from remote_paint_session import (AgentClient,AgentClientError,AgentClientCancelledError,AgentRunId,SessionId,AgentObservationReference,
 AgentScreenshotId,AgentScreenshotInput,AgentScreenshotLimits,AgentScreenshotFileInput,AgentScreenshotChunkInput,
 AgentScreenshotDownloadInput,AgentScreenshotObservation,AgentScreenshotChunk,AgentScreenshotReleased,AgentScreenshotDownload)
from test_agent_client import KEY,AT,RID,RUN,SID,uid,Body,run,response as mutation_response,failure,until
from test_observation_client import ctx,wire_ctx,snapshot

def png(width=2,height=2):
 def part(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
 return b'\x89PNG\r\n\x1a\n'+part(b'IHDR',struct.pack('>IIBBBBB',width,height,8,6,0,0,0))+part(b'IDAT',zlib.compress((b'\x00'+bytes([17,83,151,255])*width)*height))+part(b'IEND',b'')
PNG=png();SHOT=AgentScreenshotId('shot_'+uid(10));SHA=hashlib.sha256(PNG).hexdigest()
def download(**patch):return AgentScreenshotDownloadInput(SHOT,SHA,len(PNG),AT,**patch)
def record(**patch):return wire_ctx()|dict(stage='screenshot-observed',scope='main-frame-viewport-source-pixels',observationId='obs_'+uid(11),revision=1,observedAt=AT,limits=dict(maxBytes=1048576),url='https://fixture.test/shot',title='Shot',truncated=False,screenshotId=SHOT,mimeType='image/png',width=2,height=2,byteLength=len(PNG),sha256=SHA)|patch
def chunk(**patch):return wire_ctx()|dict(stage='screenshot-chunk',screenshotId=SHOT,sha256=SHA,observedAt=AT,offset=0,byteLength=len(PNG),totalBytes=len(PNG),data=base64.b64encode(PNG).decode(),complete=True)|patch
def released():return wire_ctx()|dict(stage='screenshot-released',screenshotId=SHOT)
def response(value=None,status=200,headers=None,stream=None):
 payload=json.dumps(dict(data=record()if value is None else value,requestId=RID)).encode()
 return httpx.Response(status,headers={'content-type':'application/json','x-request-id':RID,**(headers or{})},stream=stream or Body(payload))
def binary_headers(patch=None,request=None,context=None):
 r=request or download();encoded=base64.urlsafe_b64encode(json.dumps(context or wire_ctx(),separators=(',',':')).encode()).rstrip(b'=').decode()
 return {'content-type':'image/png','content-length':str(r.byte_length),'content-disposition':'attachment; filename="'+r.screenshot_id+'.png"','content-digest':'sha-256=:'+base64.b64encode(bytes.fromhex(r.sha256)).decode()+':','cache-control':'no-store','x-content-type-options':'nosniff','x-request-id':RID,'x-screenshot-id':r.screenshot_id,'x-screenshot-sha256':r.sha256,'x-screenshot-observed-at':r.observed_at,'x-agent-observation-context':encoded,**(patch or{})}
def binary(content=PNG,headers=None,status=200,stream=None):return httpx.Response(status,headers=binary_headers(headers),stream=stream or Body(content))

class ScreenshotContracts(unittest.IsolatedAsyncioTestCase):
 async def client(self,handler,**opts):
  c=AgentClient(base_url='https://api.fixture.test',api_key=KEY,transport=httpx.MockTransport(handler),**opts);self.addAsyncCleanup(c.aclose);return c
 def invalid(self,call):
  with self.assertRaises(AgentClientError)as e:call()
  self.assertEqual((e.exception.code,e.exception.outcome),('CLIENT_INVALID_REQUEST','not-dispatched'))
 async def reject(self,call,code='CLIENT_INVALID_RESPONSE'):
  with self.assertRaises(AgentClientError)as e:await call
  self.assertEqual(e.exception.code,code);return e.exception
 async def test_shot_context_limits_deadline_captured_before_coroutine_await(self):
  calls=[]
  def handler(req):
   calls.append(req);return response(record(limits=json.loads(req.content)['limits']))
  c=await self.client(handler);context=ctx();limits=AgentScreenshotLimits(4096);value=AgentScreenshotInput(limits,50);pending=c.observations.screenshot(context,value);object.__setattr__(context.document,'page_epoch',2);object.__setattr__(context.binding,'target_id','changed');object.__setattr__(limits,'max_bytes',1);object.__setattr__(value,'rpc_timeout_ms',500)
  r=(await pending).data;wire=json.loads(calls[0].content);self.assertEqual(wire['context'],wire_ctx());self.assertEqual(wire['limits'],dict(maxBytes=4096));self.assertEqual(wire['rpcTimeoutMs'],50);self.assertEqual(r.limits.max_bytes,4096);self.assertNotIn('idempotency-key',calls[0].headers)
 async def test_shot_chunk_release_and_results_are_frozen_slotted_models(self):
  c=await self.client(lambda req:response(chunk()if req.url.path.endswith('chunks')else released()if req.url.path.endswith('releases')else record()));shot=(await c.observations.screenshot(ctx())).data;self.assertIsInstance(shot,AgentScreenshotObservation);part=(await c.observations.screenshot_chunk(ctx(),AgentScreenshotChunkInput(SHOT,0))).data;self.assertIsInstance(part,AgentScreenshotChunk);self.assertEqual(base64.b64decode(part.data),PNG);self.assertTrue(part.complete);self.assertIsInstance((await c.observations.release_screenshot(ctx(),AgentScreenshotFileInput(SHOT))).data,AgentScreenshotReleased)
  for obj,key,value in [(shot,'title','changed'),(shot.document,'page_epoch',2),(shot.limits,'max_bytes',1),(part,'data','private')]:
   self.assertFalse(hasattr(obj,'__dict__'))
   with self.assertRaises(FrozenInstanceError):setattr(obj,key,value)
 async def test_shot_invalid_typed_inputs_limits_ids_getters_context_and_retries_do_not_send(self):
  calls=[];c=await self.client(lambda req:calls.append(req))
  for value in [{},AgentScreenshotInput(None),AgentScreenshotInput(AgentScreenshotLimits(True)),AgentScreenshotInput(AgentScreenshotLimits(4194305)),AgentScreenshotInput(rpc_timeout_ms=49)]:self.invalid(lambda:c.observations.screenshot(ctx(),value))
  for value in [AgentScreenshotChunkInput(AgentScreenshotId(RUN),0),AgentScreenshotChunkInput(SHOT,-1),AgentScreenshotChunkInput(SHOT,0,3073)]:self.invalid(lambda:c.observations.screenshot_chunk(ctx(),value))
  self.invalid(lambda:c.observations.release_screenshot(ctx(),AgentScreenshotChunkInput(SHOT,0)))
  class Evil(AgentScreenshotInput):
   @property
   def limits(self):raise AssertionError('getter executed')
  self.invalid(lambda:c.observations.screenshot(ctx(),object.__new__(Evil)))
  self.invalid(lambda:c.observations.screenshot({}))
  with self.assertRaises(TypeError):c.observations.screenshot(ctx(),retries=1)
  self.assertEqual(calls,[])
 async def test_shot_response_logical_source_document_version_metadata_and_budget_correlation(self):
  for patch in [dict(agentRunId='arun_'+uid(99)),dict(sessionId='ses_'+uid(99)),dict(version='wrong'),dict(binding=wire_ctx()['binding']|dict(runId='run_'+uid(99))),dict(document=wire_ctx()['document']|dict(pageEpoch=2)),dict(stage='observed'),dict(scope='all-frames'),dict(screenshotId='bad'),dict(limits=dict(maxBytes=1)),dict(limits=dict(maxBytes=True)),dict(width=2049),dict(height=0),dict(byteLength=4194305),dict(sha256='bad'),dict(observedAt='2026-02-30T00:00:00.000Z'),dict(mimeType='text/plain'),dict(rawPixels='private')]:
   c=await self.client(lambda req,p=patch:response(record(**p)));await self.reject(c.observations.screenshot(ctx()))
  for patch in [dict(offset=1),dict(byteLength=1),dict(data='!!!!'),dict(totalBytes=1),dict(complete=False),dict(version='wrong')]:
   c=await self.client(lambda req,p=patch:response(chunk(**p)));await self.reject(c.observations.screenshot_chunk(ctx(),AgentScreenshotChunkInput(SHOT,0)))
 async def test_shot_source_public_and_outer_json_budgets_status_location_and_correlation(self):
  for reply in [response(record(),202),response(record(),headers={'location':'/unexpected'}),response(record(),headers={'x-request-id':'wrong'}),response(record(url='\x00'*1024,title='\x00'*256))]:
   c=await self.client(lambda req,r=reply:r);await self.reject(c.observations.screenshot(ctx()))
  c=await self.client(lambda req:response(record(url='x'*1024)),max_response_bytes=1024);await self.reject(c.observations.screenshot(ctx()))
 async def test_png_download_captures_context_file_length_time_hash_before_await(self):
  calls=[];c=await self.client(lambda req:(calls.append(req),binary())[1]);context=ctx();value=download(rpc_timeout_ms=50);pending=c.observations.download_screenshot(context,value);object.__setattr__(context.document,'page_epoch',2);object.__setattr__(value,'sha256','f'*64);object.__setattr__(value,'byte_length',57);object.__setattr__(value,'rpc_timeout_ms',500);r=(await pending).data;wire=json.loads(calls[0].content);self.assertEqual(wire['context'],wire_ctx());self.assertEqual(wire['sha256'],SHA);self.assertEqual(wire['rpcTimeoutMs'],50);self.assertEqual(r.sha256,SHA);self.assertNotIn('idempotency-key',calls[0].headers)
 async def test_png_download_content_and_nested_models_are_immutable_frozen_slotted(self):
  c=await self.client(lambda req:binary());r=(await c.observations.download_screenshot(ctx(),download())).data;self.assertIsInstance(r,AgentScreenshotDownload);self.assertIs(type(r.content),bytes);self.assertEqual(r.content,PNG);self.assertEqual((r.width,r.height),(2,2));self.assertFalse(hasattr(r,'__dict__'))
  with self.assertRaises(FrozenInstanceError):r.sha256='changed'
  with self.assertRaises(TypeError):r.content[0]=0
  with self.assertRaises(FrozenInstanceError):r.document.page_epoch=2
 async def test_png_headers_exact_status_encoding_length_file_time_digest_request_and_context(self):
  for patch in [{'content-type':'text/plain'},{'content-encoding':'gzip'},{'location':'/unexpected'},{'content-length':'0'+str(len(PNG))},{'content-length':str(len(PNG)+1)},{'content-digest':'wrong'},{'x-screenshot-id':'shot_'+uid(99)},{'x-screenshot-sha256':'f'*64},{'x-screenshot-observed-at':'wrong'},{'x-request-id':'wrong'},{'content-disposition':'attachment; filename="../private"'},{'cache-control':'public'},{'x-content-type-options':'unsafe'},{'x-agent-observation-context':'%%%'}]:
   c=await self.client(lambda req,p=patch:binary(headers=p));await self.reject(c.observations.download_screenshot(ctx(),download()))
  for context in [wire_ctx()|dict(version='wrong'),wire_ctx()|dict(privateObjectId=1),wire_ctx()|dict(document=wire_ctx()['document']|dict(pageEpoch=2))]:
   c=await self.client(lambda req,v=context:binary(headers={'x-agent-observation-context':binary_headers(context=v)['x-agent-observation-context']}));await self.reject(c.observations.download_screenshot(ctx(),download()))
  c=await self.client(lambda req:binary(status=202));await self.reject(c.observations.download_screenshot(ctx(),download()))
 async def test_png_corruption_truncation_overrun_signature_ihdr_and_dimensions_return_no_partial_file(self):
  for data in [PNG[:-1],PNG+b'x',b'x'+PNG[1:]]:
   c=await self.client(lambda req,v=data:binary(v));await self.reject(c.observations.download_screenshot(ctx(),download()))
  for start,replacement in [(0,b'x'),(12,b'xxxx'),(16,struct.pack('>I',2049))]:
   data=PNG[:start]+replacement+PNG[start+len(replacement):];value=replace(download(),sha256=hashlib.sha256(data).hexdigest());c=await self.client(lambda req,d=data,r=value:httpx.Response(200,headers=binary_headers(request=r),stream=Body(d)));await self.reject(c.observations.download_screenshot(ctx(),value))
 async def test_png_separate_cap_rejects_before_http_without_widening_json_budget(self):
  for n in [None,True,0,56,4194305]:
   with self.assertRaises(AgentClientError):AgentClient(base_url='https://api.fixture.test',api_key=KEY,max_screenshot_bytes=n)
  calls=[];c=await self.client(lambda req:calls.append(req),max_screenshot_bytes=57);self.invalid(lambda:c.observations.download_screenshot(ctx(),download()));self.assertEqual(calls,[]);c=await self.client(lambda req:binary(),max_response_bytes=1024);self.assertEqual((await c.observations.download_screenshot(ctx(),download())).data.content,PNG)
 async def test_shot_and_png_single_attempt_despite_mutation_retries_and_error_redaction(self):
  for method in ['screenshot','download_screenshot']:
   for mode in ['transport','stale','timeout']:
    calls=[]
    def handler(req):
     calls.append(req)
     if mode=='transport':raise RuntimeError('private '+KEY)
     return failure('STALE_AGENT_SCREENSHOT',409,'not-dispatched')if mode=='stale'else failure('AGENT_RPC_TIMEOUT',504,'unknown')
    c=await self.client(handler,retries=3);e=await self.reject(c.observations.screenshot(ctx())if method=='screenshot'else c.observations.download_screenshot(ctx(),download()),'CLIENT_TRANSPORT_ERROR'if mode=='transport'else'STALE_AGENT_SCREENSHOT'if mode=='stale'else'AGENT_RPC_TIMEOUT');self.assertEqual(len(calls),1);self.assertNotIn(KEY,str(e))
 async def test_png_noncooperative_fetch_timeout_retains_actual_task_and_separate_end(self):
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
   await self.reject(c.observations.download_screenshot(ctx(),download()),'CLIENT_TIMEOUT');self.assertEqual(c.transport_status().ordinary,1);await self.reject(c.observations.screenshot(ctx()),'CLIENT_BUSY');self.assertEqual((await c.runs.end(RUN)).data.state,'closed');self.assertEqual(len(calls),2)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_png_caller_cancel_retains_noncooperative_task_and_never_retries(self):
  gate=asyncio.Event();entered=asyncio.Event();calls=[]
  async def handler(req):
   calls.append(req);entered.set()
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return binary()
  c=await self.client(handler,retries=3,max_concurrent_requests=1);task=asyncio.create_task(c.observations.download_screenshot(ctx(),download()))
  try:
   await entered.wait();task.cancel()
   with self.assertRaises(AgentClientCancelledError):await task
   self.assertEqual(c.transport_status().ordinary,1);self.assertEqual(len(calls),1)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_png_actual_body_close_remains_counted_after_local_timeout(self):
  gate=asyncio.Event();entered=asyncio.Event()
  class Slow(Body):
   async def aclose(self):
    entered.set()
    while not gate.is_set():
     try:await gate.wait()
     except asyncio.CancelledError:pass
  c=await self.client(lambda req:binary(stream=Slow(PNG)),timeout_seconds=.05,max_concurrent_requests=1)
  try:
   await self.reject(c.observations.download_screenshot(ctx(),download()),'CLIENT_TIMEOUT');self.assertTrue(entered.is_set());self.assertEqual(c.transport_status().ordinary,1)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_png_invalid_header_still_waits_actual_close_and_failure_fences_client(self):
  gate=asyncio.Event();entered=asyncio.Event()
  class Slow(Body):
   async def aclose(self):
    entered.set()
    while not gate.is_set():
     try:await gate.wait()
     except asyncio.CancelledError:pass
  c=await self.client(lambda req:binary(headers={'content-length':'9999999'},stream=Slow(PNG)),timeout_seconds=.05,max_concurrent_requests=1)
  try:
   await self.reject(c.observations.download_screenshot(ctx(),download()),'CLIENT_TIMEOUT');self.assertTrue(entered.is_set());self.assertEqual(c.transport_status().ordinary,1)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
  class Broken(Body):
   async def aclose(self):raise RuntimeError('private '+KEY)
  bad=await self.client(lambda req:binary(stream=Broken(PNG)));e=await self.reject(bad.observations.download_screenshot(ctx(),download()),'CLIENT_RESPONSE_CLOSE_FAILED');self.assertNotIn(KEY,str(e));await self.reject(bad.observations.screenshot(ctx()),'CLIENT_CLOSED')
 async def test_png_aclose_is_single_flight_and_pending_until_actual_task_settles(self):
  gate=asyncio.Event()
  async def handler(req):
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return binary()
  c=await self.client(handler,timeout_seconds=.05)
  try:
   await self.reject(c.observations.download_screenshot(ctx(),download()),'CLIENT_TIMEOUT');await self.reject(c.aclose(),'CLIENT_CLOSE_PENDING');self.assertEqual(c.transport_status().ordinary,1);await self.reject(c.observations.screenshot(ctx()),'CLIENT_CLOSED')
  finally:gate.set();await c.aclose();self.assertEqual(c.transport_status().ordinary,0)
 async def test_png_prebuffered_and_byte_fragmented_httpx_streams_validate_content_and_size(self):
  pre=await self.client(lambda req:httpx.Response(200,headers=binary_headers(),content=PNG));self.assertEqual((await pre.observations.download_screenshot(ctx(),download())).data.content,PNG)
  class Fragmented(Body):
   async def __aiter__(self):
    for byte in PNG:yield bytes([byte])
  c=await self.client(lambda req:binary(stream=Fragmented(PNG)));self.assertEqual((await c.observations.download_screenshot(ctx(),download())).data.content,PNG)

class ScreenshotHttpContracts(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.child=await asyncio.create_subprocess_exec(os.environ.get('NODE','node'),str(Path(__file__).parents[1]/'fixtures/screenshot-python-http.mjs'),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE);self.ready=json.loads(await asyncio.wait_for(self.child.stdout.readline(),3));self.clients=[]
 async def asyncTearDown(self):
  for client in self.clients:await client.aclose()
  if self.child.returncode is None:
   self.child.stdin.write(b'close\n');await self.child.stdin.drain();self.child.stdin.close();await self.child.stdin.wait_closed();out,err=await asyncio.wait_for(self.child.communicate(),3);self.assertEqual(self.child.returncode,0,err.decode()[-2000:])
 async def command(self,text):self.child.stdin.write((text+'\n').encode());await self.child.stdin.drain();return json.loads(await asyncio.wait_for(self.child.stdout.readline(),3))
 def client(self,role):
  c=AgentClient(base_url=self.ready['base'],api_key=self.ready['keys'][role]);self.clients.append(c);return c
 async def prepared(self):
  r=self.ready['run'];reader=self.client('observe');context=(await reader.observations.context(AgentObservationReference(AgentRunId(r['agentRunId']),SessionId(r['sessionId']),r['version']))).data;shot=(await reader.observations.screenshot(context)).data;value=AgentScreenshotDownloadInput(shot.screenshot_id,shot.sha256,shot.byte_length,shot.observed_at);return reader,context,shot,value
 async def test_shot_http_full_metadata_chunk_download_release_and_independent_scope(self):
  reader,c,shot,value=await self.prepared();chunk=(await reader.observations.screenshot_chunk(c,AgentScreenshotChunkInput(shot.screenshot_id,0))).data;self.assertEqual(chunk.sha256,shot.sha256);file=(await reader.observations.download_screenshot(c,value)).data;self.assertEqual(hashlib.sha256(file.content).hexdigest(),shot.sha256);self.assertEqual((file.width,file.height),(640,480));self.assertEqual((await reader.observations.release_screenshot(c,AgentScreenshotFileInput(shot.screenshot_id))).data.stage,'screenshot-released')
  for role in ['read','write','end','session']:
   with self.assertRaises(AgentClientError)as e:await self.client(role).observations.screenshot(c)
   self.assertEqual(e.exception.code,'FORBIDDEN')
  self.assertEqual((await self.command('stats'))['effects'],0)
 async def test_shot_http_unknown_input_keeps_history_quarantine_and_single_capture(self):
  reader,c,shot,value=await self.prepared();unknown=(await self.command('unknown'))['invocation'];before=(await self.command('stats'))['run'];self.assertEqual(hashlib.sha256((await reader.observations.download_screenshot(c,value)).data.content).hexdigest(),shot.sha256);self.assertEqual((await self.command('stats'))['run'],before);self.assertEqual((await self.client('read').invocations.get(unknown['invocationId'])).data.state,'unknown');self.assertEqual((await self.command('stats'))['calls'].count('observe-screenshot'),1)
 async def test_shot_http_408_retains_backend_actual_slot_and_end_is_independent(self):
  reader,c,shot,value=await self.prepared();await self.command('hold')
  try:
   with self.assertRaises(AgentClientError)as e:await reader.observations.download_screenshot(c,value)
   self.assertEqual(e.exception.code,'REQUEST_TIMEOUT');self.assertEqual(reader.transport_status().ordinary,0);self.assertEqual((await self.command('stats'))['ordinary'],1);await self.client('end').runs.end(c.agent_run_id)
  finally:await self.command('release')
 async def test_shot_http_caller_cancel_does_not_release_source_work_and_end_remains_available(self):
  reader,c,shot,value=await self.prepared();await self.command('hold');task=asyncio.create_task(reader.observations.download_screenshot(c,value))
  try:
   for _ in range(100):
    if(await self.command('stats'))['ordinary']==1:break
    await asyncio.sleep(.001)
   self.assertEqual((await self.command('stats'))['ordinary'],1);task.cancel()
   with self.assertRaises(AgentClientCancelledError):await task
   self.assertEqual((await self.command('stats'))['ordinary'],1);await self.client('end').runs.end(c.agent_run_id)
  finally:await self.command('release')
 async def test_shot_http_replacement_and_release_do_not_automatically_recapture_stale_file(self):
  reader,c,shot,value=await self.prepared();next=(await reader.observations.screenshot(c)).data
  with self.assertRaises(AgentClientError)as e:await reader.observations.download_screenshot(c,value)
  self.assertEqual(e.exception.code,'STALE_AGENT_SCREENSHOT');await reader.observations.release_screenshot(c,AgentScreenshotFileInput(next.screenshot_id));self.assertEqual((await self.command('stats'))['calls'].count('observe-screenshot'),2)
