from __future__ import annotations
import asyncio
from dataclasses import FrozenInstanceError, replace
import json
import os
from pathlib import Path
import traceback
import unittest
import httpx
from remote_paint_session import (AgentClient,AgentClientError,AgentClientCancelledError,AgentRunId,AgentInvocationId,
    SessionClientError,SessionId,AgentFence,AgentBinding,AgentContext,AgentRunReference,CreateAgentRunInput)

KEY='fixture_python_agent_backend_key_0000000000';AT='2026-10-20T00:00:00.000Z';RID='req_python_agent'
def uid(n):return '00000000-0000-0000-0000-'+str(n).zfill(12)
SID=SessionId('ses_'+uid(1));RUN=AgentRunId('arun_'+uid(2));INV=AgentInvocationId('ainv_'+uid(3))
def context():return AgentContext(RUN,AgentBinding('sdk-tenant',SID,'target_'+uid(4),'run_'+uid(5)),AgentFence(uid(6),0,1,1))
def fence():return dict(controlSessionId=uid(6),controlVersion=0,pageEpoch=1,viewportVersion=1)
def run(**patch):return dict(agentRunId=RUN,sessionId=SID,region='test',version='sdk-v1',state='active',holdsWriter=True,beginDispatch='confirmed',endDispatch='not-requested',createdAt=AT,updatedAt=AT,error=None)|patch
def invocation(**patch):return dict(invocationId=INV,agentRunId=RUN,sessionId=SID,tool='insertText',fence=fence(),state='injected',dispatchStarted=True,receipt=dict(stage='input-injected',inputs=1),error=None,createdAt=AT,updatedAt=AT)|patch
class Body(httpx.AsyncByteStream):
 def __init__(self,data=b''):self.data,self.closed=data,False
 async def __aiter__(self):yield self.data
 async def aclose(self):self.closed=True

def response(data=None,status=200,headers=None,stream=None,raw=None):
 if data is None:data=run()
 payload=json.dumps(dict(data=data,requestId=RID)).encode() if raw is None else raw
 location='/v1/agent-invocations/'+data['invocationId'] if 'invocationId'in data else '/v1/agent-runs/'+data['agentRunId'] if 'agentRunId'in data else None
 return httpx.Response(status,headers={'content-type':'application/json','x-request-id':RID,**({'location':location}if location else{}),**(headers or{})},stream=stream or Body(payload))
def failure(code='FORBIDDEN',status=403,outcome=None,**patch):
 error=dict(code=code,message='private '+KEY)|patch
 if outcome is not None:error['outcome']=outcome
 return response(status=status,raw=json.dumps(dict(error=error,requestId=RID)).encode())
async def until(check):
 async with asyncio.timeout(3):
  while not (value:=check()):await asyncio.sleep(.001)
  return value

class Contracts(unittest.IsolatedAsyncioTestCase):
 async def client(self,handler,**opts):
  c=AgentClient(base_url='https://api.fixture.test',api_key=KEY,transport=httpx.MockTransport(handler),**opts);self.addAsyncCleanup(c.aclose);return c
 def invalid(self,call):
  with self.assertRaises(AgentClientError)as e:call()
  self.assertEqual(e.exception.code,'CLIENT_INVALID_REQUEST');self.assertEqual(e.exception.outcome,'not-dispatched')
 async def test_configuration_boundaries_and_error_privacy(self):
  for patch in [dict(base_url='http://public.test'),dict(base_url='https://u:p@api.test'),dict(base_url='https://api.test/path'),dict(api_key='short'),dict(timeout_seconds=True),dict(timeout_seconds=.01),dict(max_concurrent_requests=0),dict(max_concurrent_end_requests=0),dict(max_concurrent_end_requests=65),dict(max_response_bytes=1),dict(retries=4)]:
   self.invalid(lambda:AgentClient(**(dict(base_url='https://api.test',api_key=KEY)|patch)))
  self.assertIsInstance(AgentClientError('CODE'),SessionClientError)
  c=await self.client(lambda r:response());self.assertNotIn(KEY,repr(c));self.invalid(lambda:c.runs.prepare_create(SID,CreateAgentRunInput('test','v1'),idempotency_key='bad key'))
 async def test_run_prepared_identity_and_body_are_captured(self):
  calls=[];changed=False
  async def handler(req):
   calls.append(req)
   if len(calls)==1:raise RuntimeError(KEY)
   return response(run(**(dict(agentRunId='arun_'+uid(9))if changed else{})))
  c=await self.client(handler);value=CreateAgentRunInput('test','sdk-v1');p=c.runs.prepare_create(SID,value,idempotency_key='original');object.__setattr__(value,'region','changed')
  with self.assertRaises(AgentClientError)as e:await p.send()
  self.assertEqual(e.exception.outcome,'unknown');self.assertNotIn(KEY,''.join(traceback.format_exception(e.exception)))
  self.assertEqual((await p.send()).data.agent_run_id,RUN);self.assertEqual(calls[0].content,calls[1].content);self.assertEqual(json.loads(calls[1].content)['region'],'test');changed=True
  with self.assertRaises(AgentClientError)as e:await p.send()
  self.assertEqual(e.exception.code,'CLIENT_INVALID_RESPONSE');self.assertNotIn('original',repr(p))
 async def test_context_requires_expected_session_and_freezes_local_run_tag(self):
  ctx=context();data=dict(binding=dict(tenantId=ctx.binding.tenant_id,sessionId=SID,targetId=ctx.binding.target_id,runId=ctx.binding.run_id),fence=fence())
  c=await self.client(lambda r:response(data));current=(await c.runs.context(AgentRunReference(RUN,SID))).data;self.assertEqual(current,ctx)
  with self.assertRaises(FrozenInstanceError):current.fence.control_version=2
  wrong=await self.client(lambda r:response({**data,'binding':{**data['binding'],'sessionId':'ses_'+uid(99)}}))
  with self.assertRaises(AgentClientError):await wrong.runs.context(AgentRunReference(RUN,SID))
 async def test_prepared_action_captures_original_context_key_and_params(self):
  calls=[];c=await self.client(lambda req:(calls.append(req),response(invocation()))[1]);ctx=context();action=dict(tool='insertText',params=dict(text='original'));p=c.invocations.prepare_create(ctx,action,idempotency_key='original-key');action['params']['text']='changed';object.__setattr__(ctx.fence,'control_version',99)
  a=await p.send();b=await p.send();self.assertEqual(a.data.invocation_id,b.data.invocation_id);self.assertEqual(calls[0].content,calls[1].content);wire=json.loads(calls[0].content);self.assertEqual(wire['context']['fence']['controlVersion'],0);self.assertNotIn('agentRunId',wire['context']);self.assertEqual(wire['params']['text'],'original');self.assertEqual(calls[1].headers['idempotency-key'],'original-key')
 async def test_seven_discriminated_tools_and_utf16_selection_map_to_wire(self):
  calls=[]
  def handler(req):
   wire=json.loads(req.content);calls.append(wire);tool=wire['tool'];count=wire['params'].get('steps',4)+3 if tool=='drag'else dict(move=1,click=3,scroll=1,press=2,insertText=1,composition=1)[tool];return response(invocation(tool=tool,receipt=dict(stage='input-injected',inputs=count)))
  c=await self.client(handler)
  for tool,params in [('move',dict(x=1,y=2)),('click',dict(x=1,y=2,button='right')),('drag',dict(from_x=1,from_y=2,to_x=3,to_y=4,steps=16)),('scroll',dict(x=1,y=2,delta_x=0,delta_y=10000)),('press',dict(key='a',code='KeyA',windows_virtual_key_code=65)),('insertText',dict(text='')),('composition',dict(text='😀',selection_start=0,selection_end=2))]:
   self.assertEqual((await c.invocations.create(context(),dict(tool=tool,params=params),idempotency_key='key')).data.state,'injected')
  self.assertEqual(len(calls),7);self.assertEqual(calls[-1]['params']['selectionEnd'],2);self.assertIn('fromX',calls[2]['params']);self.assertIn('windowsVirtualKeyCode',calls[4]['params'])
 async def test_strict_input_schema_bounds_reject_bool_nan_unknown_and_side_effect_dicts(self):
  calls=[];c=await self.client(lambda req:calls.append(req))
  for action in [dict(tool='Runtime.evaluate',params=dict(expression='private')),dict(tool='click',params=dict(x=True,y=2)),dict(tool='click',params=dict(x=float('nan'),y=2)),dict(tool='move',params=dict(x=10**1000,y=2)),dict(tool='drag',params=dict(from_x=1,from_y=2,to_x=3,to_y=4,steps=17)),dict(tool='scroll',params=dict(x=1,y=2,delta_x=0,delta_y=10001)),dict(tool='press',params=dict(key='a',code='KeyA',commands=['private'])),dict(tool='composition',params=dict(text='x',selection_start=1,selection_end=0)),dict(tool='insertText',params=dict(text='😀'*4097)),dict(tool='insertText',params=dict(text='x'),rpc_timeout_ms=49),dict(tool='insertText',params=dict(text='x'),tenant_id='foreign')]:
   self.invalid(lambda:c.invocations.prepare_create(context(),action,idempotency_key='key'))
  class Evil(dict):
   def items(self):raise AssertionError('getter executed')
  self.invalid(lambda:c.invocations.prepare_create(context(),dict(tool='insertText',params=Evil(text='x')),idempotency_key='key'));self.assertEqual(calls,[])
 async def test_reply_identity_phase_fence_receipt_and_location_checks(self):
  for patch in [dict(invocationId='ainv_bad'),dict(agentRunId='arun_'+uid(9)),dict(sessionId='ses_'+uid(9)),dict(tool='press',receipt=dict(stage='input-injected',inputs=2)),dict(fence=fence()|dict(controlVersion=1)),dict(receipt=dict(stage='business-complete',inputs=1)),dict(receipt=dict(stage='input-injected',inputs=True)),dict(state='requested',receipt=None),dict(updatedAt='2026-10-19T00:00:00.000Z'),dict(createdAt='2026-10-20T00:00:00.000',updatedAt='2026-10-20T00:00:00.000'),dict(secret='private')]:
   c=await self.client(lambda req,p=patch:response(invocation(**p)))
   with self.assertRaises(AgentClientError)as e:await c.invocations.create(context(),dict(tool='insertText',params=dict(text='x')),idempotency_key='key')
   self.assertEqual(e.exception.code,'CLIENT_INVALID_RESPONSE')
  c=await self.client(lambda req:response(invocation(),headers={'location':'https://wrong.test/'}))
  with self.assertRaises(AgentClientError):await c.invocations.create(context(),dict(tool='insertText',params=dict(text='x')),idempotency_key='key')
 async def test_run_get_end_status_and_parent_identity_checks(self):
  for patch in [dict(agentRunId='arun_'+uid(9)),dict(holdsWriter=False),dict(beginDispatch='requested'),dict(endDispatch='confirmed'),dict(error=dict(code='RAW',outcome='not-dispatched'))]:
   c=await self.client(lambda req,p=patch:response(run(**p)))
   with self.assertRaises(AgentClientError):await c.runs.get(RUN)
  c=await self.client(lambda req:response())
  with self.assertRaises(AgentClientError):await c.runs.end(RUN)
 async def test_unknown_is_frozen_data_without_retry_or_business_success(self):
  calls=[];c=await self.client(lambda req:(calls.append(req),response(invocation(state='unknown',receipt=None,error=dict(code='AGENT_RPC_TIMEOUT',outcome='unknown'))))[1],retries=3);row=(await c.invocations.create(context(),dict(tool='insertText',params=dict(text='x')),idempotency_key='key')).data
  self.assertEqual(row.state,'unknown');self.assertEqual(row.error.outcome,'unknown');self.assertEqual(len(calls),1);self.assertFalse(hasattr(row,'business_success'))
 async def test_authenticated_error_outcomes_redaction_and_client_code_spoof(self):
  for reply,code,outcome in [(failure(),'FORBIDDEN','rejected'),(failure('AGENT_STORAGE_UNAVAILABLE',503,'unknown'),'AGENT_STORAGE_UNAVAILABLE','unknown'),(failure('AGENT_INVALID_REQUEST',400,'not-dispatched'),'AGENT_INVALID_REQUEST','not-dispatched')]:
   c=await self.client(lambda req,r=reply:r)
   with self.assertRaises(AgentClientError)as e:await c.runs.get(RUN)
   self.assertEqual((e.exception.code,e.exception.outcome),(code,outcome));self.assertNotIn(KEY,str(e.exception))
  for reply in [failure('CLIENT_ABORTED'),failure('AGENT_PAUSED',409,'rejected'),failure('AGENT_PAUSED',409,'unknown',secret='private')]:
   c=await self.client(lambda req,r=reply:r)
   with self.assertRaises(AgentClientError)as e:await c.runs.get(RUN)
   self.assertEqual(e.exception.code,'CLIENT_INVALID_RESPONSE')
 async def test_explicit_retry_preserves_body_and_uncertainty_after_later_denial(self):
  calls=[]
  def handler(req):calls.append(req);return failure('AGENT_STORAGE_UNAVAILABLE',503,'unknown')if len(calls)==1 else response(invocation())
  c=await self.client(handler,retries=1);p=c.invocations.prepare_create(context(),dict(tool='insertText',params=dict(text='x')),idempotency_key='saved');await p.send();self.assertEqual(calls[0].content,calls[1].content)
  calls.clear()
  def denied(req):
   calls.append(req)
   if len(calls)==1:raise RuntimeError('lost')
   return failure()
  c=await self.client(denied,retries=1)
  with self.assertRaises(AgentClientError)as e:await c.runs.get(RUN)
  self.assertEqual(e.exception.code,'FORBIDDEN');self.assertEqual(e.exception.outcome,'unknown');self.assertEqual(len(calls),2)
 async def test_noncooperative_fetch_timeout_retains_admission_and_end_still_works(self):
  gate=asyncio.Event();entered=asyncio.Event();calls=[]
  async def handler(req):
   calls.append(req)
   if req.url.path.endswith('/end'):return response(run(state='closed',holdsWriter=False,endDispatch='confirmed'))
   entered.set()
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return response()
  c=await self.client(handler,timeout_seconds=.05,max_concurrent_requests=1,retries=1)
  try:
   async with asyncio.timeout(.5):
    with self.assertRaises(AgentClientError)as e:await c.runs.get(RUN)
   self.assertEqual((e.exception.code,e.exception.outcome),('CLIENT_BUSY','unknown'));self.assertEqual(c.transport_status().ordinary,1);self.assertEqual((await c.runs.end(RUN)).data.state,'closed');self.assertEqual(len(calls),2)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_task_cancellation_preserves_semantics_and_actual_slot(self):
  gate=asyncio.Event();entered=asyncio.Event()
  async def handler(req):
   entered.set()
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return response()
  c=await self.client(handler,retries=3);task=asyncio.create_task(c.runs.get(RUN));await entered.wait();task.cancel()
  try:
   with self.assertRaises(AgentClientCancelledError)as e:await task
   self.assertEqual(e.exception.outcome,'unknown');self.assertTrue(task.cancelled());self.assertEqual(c.transport_status().ordinary,1)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_noncooperative_response_close_holds_capacity(self):
  gate=asyncio.Event();entered=asyncio.Event()
  class SlowClose(Body):
   async def aclose(self):
    entered.set()
    while not gate.is_set():
     try:await gate.wait()
     except asyncio.CancelledError:pass
    self.closed=True
  stream=SlowClose(json.dumps(dict(data=run(),requestId=RID)).encode());c=await self.client(lambda req:response(stream=stream),timeout_seconds=.05,max_concurrent_requests=1)
  try:
   with self.assertRaises(AgentClientError)as e:await c.runs.get(RUN)
   self.assertEqual(e.exception.code,'CLIENT_TIMEOUT');self.assertTrue(entered.is_set());self.assertEqual(c.transport_status().ordinary,1)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_shutdown_is_single_flight_bounded_and_retains_noncooperative_tasks(self):
  gate=asyncio.Event()
  async def handler(req):
   while not gate.is_set():
    try:await gate.wait()
    except asyncio.CancelledError:pass
   return response()
  c=await self.client(handler,timeout_seconds=.05)
  try:
   with self.assertRaises(AgentClientError):await c.runs.get(RUN)
   with self.assertRaises(AgentClientError)as e:await c.aclose()
   self.assertEqual(e.exception.code,'CLIENT_CLOSE_PENDING');self.assertEqual(c.transport_status().ordinary,1)
   with self.assertRaises(AgentClientError)as e:await c.runs.end(RUN)
   self.assertEqual(e.exception.code,'CLIENT_CLOSED')
  finally:gate.set();await c.aclose()
 async def test_byte_limits_encoding_request_id_and_cleanup_failure(self):
  c=await self.client(lambda req:response());self.invalid(lambda:c.invocations.prepare_create(context(),dict(tool='insertText',params=dict(text='\x00'*8192)),idempotency_key='key'))
  for reply in [response(headers={'x-request-id':'req_wrong'}),response(headers={'content-type':'text/plain'}),response(raw=b'\xff'),response(raw=b'x'*2048)]:
   c=await self.client(lambda req,r=reply:r,max_response_bytes=1024)
   with self.assertRaises(AgentClientError):await c.runs.get(RUN)
  class Broken(Body):
   async def aclose(self):raise RuntimeError('private-close')
  c=await self.client(lambda req:response(stream=Broken(json.dumps(dict(data=run(),requestId=RID)).encode())))
  with self.assertRaises(AgentClientError)as e:await c.runs.get(RUN)
  self.assertEqual(e.exception.code,'CLIENT_RESPONSE_CLOSE_FAILED')
  with self.assertRaises(AgentClientError)as e:await c.runs.get(RUN)
  self.assertEqual(e.exception.code,'CLIENT_CLOSED')
 async def test_end_has_an_independent_real_http_connection_pool(self):
  entered=0;all_entered=asyncio.Event();release=asyncio.Event();writers=set()
  async def handler(reader,writer):
   nonlocal entered
   writers.add(writer)
   try:
    raw=await reader.readuntil(b'\r\n\r\n')
    if b'/end ' in raw:
     payload=json.dumps(dict(data=run(state='closed',holdsWriter=False,endDispatch='confirmed'),requestId=RID)).encode();writer.write(b'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-request-id: '+RID.encode()+b'\r\nlocation: /v1/agent-runs/'+RUN.encode()+b'\r\ncontent-length: '+str(len(payload)).encode()+b'\r\nconnection: close\r\n\r\n'+payload);await writer.drain()
    else:
     entered+=1
     if entered==16:all_entered.set()
     await release.wait()
   finally:writer.close();await writer.wait_closed();writers.discard(writer)
  server=await asyncio.start_server(handler,'127.0.0.1',0);c=AgentClient(base_url='http://127.0.0.1:'+str(server.sockets[0].getsockname()[1]),api_key=KEY,timeout_seconds=5,max_concurrent_requests=16);tasks=[asyncio.create_task(c.runs.get(RUN))for _ in range(16)]
  try:
   await asyncio.wait_for(all_entered.wait(),3);self.assertEqual((await asyncio.wait_for(c.runs.end(RUN),1)).data.state,'closed');self.assertEqual(c.transport_status().ordinary,16)
  finally:
   for task in tasks:task.cancel()
   await asyncio.gather(*tasks,return_exceptions=True);release.set();await c.aclose();server.close();await server.wait_closed();await until(lambda:not writers)
 async def test_redirect_is_not_followed_and_no_cookie_is_sent(self):
  calls=[]
  def handler(req):calls.append(req);return response(headers={'set-cookie':'private=value; Path=/'})if len(calls)==1 else response(status=307,headers={'location':'https://foreign.test/'})
  c=await self.client(handler);await c.runs.get(RUN)
  with self.assertRaises(AgentClientError)as e:await c.runs.get(RUN)
  self.assertEqual(e.exception.code,'CLIENT_REDIRECT_REJECTED');self.assertEqual(len(calls),2);self.assertNotIn('cookie',calls[1].headers)

class ActualHttp(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.child=await asyncio.create_subprocess_exec(os.environ.get('SESSION_PYTHON_TEST_NODE','node'),str(Path(__file__).resolve().parents[1]/'fixtures/agent-python-http.mjs'),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
  self.addAsyncCleanup(self.close);self.ready=json.loads(await asyncio.wait_for(self.child.stdout.readline(),3));self.base='http://127.0.0.1:'+str(self.ready['port'])
 async def close(self):
  if self.child.returncode is None:
   self.child.stdin.write(b'close\n');await self.child.stdin.drain();self.child.stdin.close();await self.child.stdin.wait_closed()
   try:out,err=await asyncio.wait_for(self.child.communicate(),3)
   except BaseException:self.child.kill();await self.child.wait();raise
   self.assertEqual(self.child.returncode,0,err.decode()[-2000:])
 async def command(self,command):
  self.child.stdin.write((command+'\n').encode());await self.child.stdin.drain();return json.loads(await asyncio.wait_for(self.child.stdout.readline(),3))
 async def test_actual_installed_http_lost_response_reuses_id_and_one_effect(self):
  async with AgentClient(base_url=self.base,api_key=KEY)as c:
   run=(await c.runs.create(SessionId(self.ready['sessionId']),CreateAgentRunInput('test',self.ready['version']),idempotency_key='run')).data
   for _ in range(100):
    run=(await c.runs.get(run.agent_run_id)).data
    if run.state=='active':break
    await asyncio.sleep(.01)
   ctx=(await c.runs.context(run)).data;p=c.invocations.prepare_create(ctx,dict(tool='insertText',params=dict(text='ONCE')),idempotency_key='drop-action');await self.command('drop')
   with self.assertRaises(AgentClientError)as e:await p.send()
   self.assertEqual(e.exception.outcome,'unknown');first=(await p.send()).data
   for _ in range(100):
    current=(await c.invocations.get(first.invocation_id)).data
    if current.state=='injected':break
    await asyncio.sleep(.01)
   self.assertEqual(current.state,'injected');self.assertEqual((await p.send()).data.invocation_id,first.invocation_id);self.assertEqual((await self.command('stats'))['effects'],1);await c.runs.end(run.agent_run_id)
 async def test_actual_http_scope_denied_and_remote_unknown_is_data(self):
  async with AgentClient(base_url=self.base,api_key='fixture_python_agent_readonly_key_00000000')as denied:
   with self.assertRaises(AgentClientError)as e:await denied.runs.create(SessionId(self.ready['sessionId']),CreateAgentRunInput('test',self.ready['version']),idempotency_key='denied')
   self.assertEqual((e.exception.code,e.exception.outcome),('FORBIDDEN','rejected'))
  await self.command('unknown')
  async with AgentClient(base_url=self.base,api_key=KEY,retries=3)as c:
   run=(await c.runs.create(SessionId(self.ready['sessionId']),CreateAgentRunInput('test',self.ready['version']),idempotency_key='run')).data
   for _ in range(100):
    run=(await c.runs.get(run.agent_run_id)).data
    if run.state=='active':break
    await asyncio.sleep(.01)
   ctx=(await c.runs.context(run)).data;p=c.invocations.prepare_create(ctx,dict(tool='insertText',params=dict(text='UNKNOWN')),idempotency_key='unknown');first=(await p.send()).data
   for _ in range(100):
    row=(await c.invocations.get(first.invocation_id)).data
    if row.state=='unknown':break
    await asyncio.sleep(.01)
   self.assertEqual(row.state,'unknown');self.assertEqual((await p.send()).data.state,'unknown');self.assertEqual((await self.command('stats'))['performCalls'],1)
