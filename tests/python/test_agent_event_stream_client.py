from __future__ import annotations
import asyncio
from dataclasses import FrozenInstanceError
import json
import os
from pathlib import Path
import unittest
import httpx
from remote_paint_session import (AgentClient,AgentClientError,AgentClientCancelledError,
    AgentRunId,AgentRunReference,SessionId,AgentEventStream,AgentEventTransportStatus)
from test_agent_client import Body,response,run,until
from test_agent_events_client import RUN,KEY,event,cursor,gap,report,reply_report,failure
from test_agent_event_parser_client import frame,ready,checkpoint,heartbeat

class Wire(httpx.AsyncByteStream):
 def __init__(self,data=b'',*,read_gate=None,close_gate=None,close_error=False):self.data,self.read_gate,self.close_gate,self.close_error=data,read_gate,close_gate,close_error;self.reads=self.closes=0;self.entered=asyncio.Event();self.closing=asyncio.Event()
 async def __aiter__(self):
  self.reads+=1;self.entered.set()
  if self.read_gate:await self.read_gate.wait()
  if self.data:yield self.data
  self.reads+=1
 async def aclose(self):
  self.closes+=1;self.closing.set()
  if self.close_gate:await self.close_gate.wait()
  if self.close_error:raise RuntimeError('private close '+KEY)
def sse(data=b'',*,body=None,headers=None,status=200):return httpx.Response(status,headers={'content-type':'text/event-stream','x-request-id':'req_stream',**(headers or{})},stream=body if body is not None else Wire(data))
def complete(n=1,after=0):return frame('ready',ready(after,max(n,1)))+(frame('agent',event(n),cursor(n))if n>after else b'')+frame('checkpoint',checkpoint(max(n,after)))

class StreamContracts(unittest.IsolatedAsyncioTestCase):
 async def client(self,handler,*,allow_close_failure=False,**options):
  client=AgentClient(base_url='https://api.fixture.test',api_key=KEY,transport=httpx.MockTransport(handler),**options)
  async def close():
   try:await client.aclose()
   except AgentClientError as e:
    if not allow_close_failure or e.code!='CLIENT_CLOSE_FAILED':raise
  self.addAsyncCleanup(close);return client
 async def error(self,awaitable,code):
  with self.assertRaises(AgentClientError)as error:await awaitable
  self.assertEqual(error.exception.code,code);return error.exception
 async def test_configuration_is_bounded_lazy_and_private(self):
  for patch in [dict(max_concurrent_event_streams=0),dict(max_concurrent_event_streams=65),dict(event_stream_timeout_seconds=.09),dict(event_stream_timeout_seconds=121),dict(event_stream_timeout_seconds=True),dict(max_event_stream_bytes=4095),dict(max_event_stream_bytes=1048577)]:
   with self.assertRaises(AgentClientError):AgentClient(base_url='https://api.test',api_key=KEY,**patch)
  calls=[];client=await self.client(lambda req:calls.append(req));stream=client.runs.events(RUN);self.assertIsInstance(stream,AgentEventStream);self.assertEqual(client.event_transport_status(),AgentEventTransportStatus(0));self.assertEqual(calls,[]);self.assertNotIn(KEY,repr(stream)+repr(client))
  for options in [dict(after=cursor(0)+'\n'),dict(reconnects=4),dict(reconnects=True)]:
   with self.assertRaises(AgentClientError):client.runs.events(RUN,**options)
 async def test_preclosed_stream_and_empty_context_send_nothing(self):
  calls=[];client=await self.client(lambda req:calls.append(req));stream=client.runs.events(RUN);await stream.aclose()
  with self.assertRaises(StopAsyncIteration):await anext(stream)
  async with client.runs.events(RUN):pass
  self.assertEqual(calls,[]);self.assertEqual(client.event_transport_status().streams,0)
 async def test_messages_headers_freezing_and_full_window(self):
  calls=[];client=await self.client(lambda req:(calls.append(req),sse(complete()))[1]);values=[]
  async with client.runs.events(RUN,reconnects=0)as stream:
   async for value in stream:values.append(value)
  self.assertEqual([v.kind for v in values],['ready','event','checkpoint']);self.assertEqual(values[1].cursor,cursor(1));self.assertEqual(client.event_transport_status().streams,0);self.assertEqual(calls[0].headers['authorization'],'Bearer '+KEY);self.assertEqual(calls[0].headers['accept-encoding'],'identity');self.assertNotIn('cookie',calls[0].headers)
  with self.assertRaises(FrozenInstanceError):values[1].event.data.holds_writer=False
 async def test_bounded_reconnect_uses_delivered_cursor_and_fresh_requests(self):
  calls=[]
  def handler(req):calls.append(req);n=len(calls);return sse(complete(n,n-1),headers={'x-request-id':'req_'+str(n)})
  client=await self.client(handler);values=[]
  async with client.runs.events(RUN,reconnects=3)as stream:
   async for value in stream:
    if value.kind=='event':values.append(value)
  self.assertEqual([v.event.sequence for v in values],[1,2,3,4]);self.assertEqual(len(calls),4);self.assertEqual([req.url.params['after']for req in calls],[cursor(i)for i in range(4)])
 async def test_interrupted_eof_reconnects_without_duplicate_event_delivery(self):
  calls=[]
  def handler(req):calls.append(req);return sse(frame('ready',ready())+frame('agent',event(1),cursor(1)))if len(calls)==1 else sse(complete(2,1))
  client=await self.client(handler);events=[]
  async with client.runs.events(RUN,reconnects=1)as stream:
   async for value in stream:
    if value.kind=='event':events.append(value.event.sequence)
  self.assertEqual(events,[1,2]);self.assertEqual(calls[1].url.params['after'],cursor(1))
 async def test_initial_json_gap_is_frozen_terminal_and_preserves_cursor(self):
  calls=[];client=await self.client(lambda req:(calls.append(req),failure('AGENT_EVENT_GAP',409,'not-dispatched',details=gap()))[1]);stream=client.runs.events(RUN);e=await self.error(anext(stream),'AGENT_EVENT_GAP');self.assertEqual(e.cursor,cursor(0));self.assertTrue(e.details.missing_history);self.assertEqual(len(calls),1);await stream.aclose()
 async def test_midstream_gap_never_repairs_or_reconnects(self):
  calls=[];client=await self.client(lambda req:(calls.append(req),sse(frame('ready',ready())+frame('agent',event(1),cursor(1))+frame('gap',gap(1))))[1]);stream=client.runs.events(RUN);await anext(stream);await anext(stream);e=await self.error(anext(stream),'AGENT_EVENT_GAP');self.assertEqual(e.cursor,cursor(1));self.assertEqual(e.status,200);self.assertEqual(len(calls),1);await stream.aclose()
 async def test_malformed_headers_fail_without_retry_or_credentials_in_error(self):
  for headers in [{'content-type':'application/json'},{'content-encoding':'gzip'},{'x-request-id':'bad'},{'content-length':'01'},{'content-length':'1048577'}]:
   calls=[];c=await self.client(lambda req,h=headers:(calls.append(req),sse(complete(),headers=h))[1]);stream=c.runs.events(RUN);e=await self.error(anext(stream),'CLIENT_INVALID_RESPONSE');self.assertNotIn(KEY,str(e));await stream.aclose();self.assertEqual(len(calls),1)
 async def test_raw_frame_and_json_error_budgets_span_every_attempt(self):
  c=await self.client(lambda req:sse(b':'+b'x'*4094+b'\n\n'));stream=c.runs.events(RUN);await self.error(anext(stream),'CLIENT_EVENT_STREAM_LIMIT');await stream.aclose()
  calls=[]
  def handler(req):calls.append(req);raw=b' '*2600+json.dumps(dict(error=dict(code='SERVICE_BUSY',message='retry'),requestId='req_stream')).encode();return httpx.Response(503,headers={'content-type':'application/json','x-request-id':'req_stream'},stream=Body(raw))
  c=await self.client(handler,max_event_stream_bytes=4096);stream=c.runs.events(RUN);await self.error(anext(stream),'CLIENT_EVENT_STREAM_LIMIT');await stream.aclose();self.assertEqual(len(calls),2)
 async def test_concurrent_pull_is_rejected_and_chunks_are_demand_driven(self):
  gate=asyncio.Event();body=Wire(complete(),read_gate=gate);c=await self.client(lambda req:sse(body=body));stream=c.runs.events(RUN,reconnects=0);first=asyncio.create_task(anext(stream));await body.entered.wait();await self.error(anext(stream),'CLIENT_EVENT_STREAM_BUSY');self.assertEqual(body.closes,0);gate.set();self.assertEqual((await first).kind,'ready');await asyncio.sleep(.01);self.assertEqual(body.reads,1);self.assertEqual((await anext(stream)).kind,'event');self.assertEqual(body.reads,1);await stream.aclose()
 async def test_paused_iterator_absolute_deadline_closes_without_another_pull(self):
  body=Wire(frame('ready',ready()));c=await self.client(lambda req:sse(body=body),event_stream_timeout_seconds=.1);stream=c.runs.events(RUN);await anext(stream);await body.closing.wait();await until(lambda:c.event_transport_status().streams==0);await self.error(anext(stream),'CLIENT_TIMEOUT');self.assertEqual(body.closes,1)
 async def test_absolute_deadline_does_not_reset_on_checkpoint_reconnect(self):
  calls=[];c=await self.client(lambda req:(calls.append(req),sse(frame('ready',ready())+frame('checkpoint',checkpoint())))[1],event_stream_timeout_seconds=.1);stream=c.runs.events(RUN)
  with self.assertRaises(AgentClientError)as e:
   async for _ in stream:pass
  self.assertEqual(e.exception.code,'CLIENT_TIMEOUT');self.assertLessEqual(len(calls),3);await stream.aclose()
 async def test_noncooperative_send_holds_only_stream_capacity_after_timeout(self):
  gate=asyncio.Event();late=Wire();calls=[]
  async def handler(req):
   calls.append(req)
   if '/events/stream'in req.url.path:await gate.wait();return sse(body=late)
   return reply_report(report())if req.url.path.endswith('/cancel')else response(run())
  c=await self.client(handler,event_stream_timeout_seconds=.1,timeout_seconds=.05,max_concurrent_event_streams=1);stream=c.runs.events(RUN)
  try:
   await self.error(anext(stream),'CLIENT_TIMEOUT');self.assertEqual(c.event_transport_status().streams,1);await self.error(anext(c.runs.events(RUN)),'CLIENT_BUSY');await c.runs.get(RUN);await c.runs.cancel(RUN)
  finally:gate.set();await stream.aclose()
  self.assertEqual(late.closes,1);self.assertEqual(c.event_transport_status().streams,0)
 async def test_noncooperative_read_retains_slot_after_actual_close_returns(self):
  gate=asyncio.Event();body=Wire(frame('ready',ready()),read_gate=gate);c=await self.client(lambda req:sse(body=body),event_stream_timeout_seconds=.1,timeout_seconds=.05);stream=c.runs.events(RUN)
  try:
   await self.error(anext(stream),'CLIENT_TIMEOUT');await body.closing.wait();self.assertEqual(c.event_transport_status().streams,1);await self.error(stream.aclose(),'CLIENT_CLOSE_PENDING')
  finally:gate.set();await stream.aclose()
  self.assertEqual(c.event_transport_status().streams,0)
 async def test_is_closed_flag_cannot_substitute_for_pending_actual_close(self):
  gate=asyncio.Event();body=Wire(frame('ready',ready()),close_gate=gate);reply=sse(body=body);c=await self.client(lambda req:reply,timeout_seconds=.05);stream=c.runs.events(RUN);await anext(stream)
  try:
   await self.error(stream.aclose(),'CLIENT_CLOSE_PENDING');self.assertTrue(reply.is_closed);self.assertEqual(c.event_transport_status().streams,1);self.assertEqual(body.closes,1)
  finally:gate.set();await stream.aclose()
  self.assertEqual(body.closes,1);self.assertEqual(c.event_transport_status().streams,0)
 async def test_close_failure_retains_uncertain_capacity_but_end_is_independent(self):
  body=Wire(frame('ready',ready()),close_error=True)
  c=await self.client(lambda req:reply_report(report())if req.url.path.endswith('/cancel')else sse(body=body),allow_close_failure=True,max_concurrent_event_streams=1);stream=c.runs.events(RUN);await anext(stream);await self.error(stream.aclose(),'CLIENT_EVENT_STREAM_CLEANUP_FAILED');self.assertEqual(c.event_transport_status().streams,1);await self.error(anext(c.runs.events(RUN)),'CLIENT_BUSY');await c.runs.cancel(RUN);await self.error(c.aclose(),'CLIENT_CLOSE_FAILED')
 async def test_task_cancellation_is_prompt_and_preserves_last_delivered_cursor(self):
  gate=asyncio.Event();body=Wire(read_gate=gate);c=await self.client(lambda req:sse(body=body));stream=c.runs.events(RUN);pending=asyncio.create_task(anext(stream));await body.entered.wait();pending.cancel()
  try:
   with self.assertRaises(AgentClientCancelledError)as e:await pending
   self.assertEqual(e.exception.cursor,cursor(0));self.assertEqual(c.event_transport_status().streams,1)
  finally:gate.set();await stream.aclose()
 async def test_close_observer_pending_can_be_joined_after_original_cleanup(self):
  gate=asyncio.Event();body=Wire(frame('ready',ready()),close_gate=gate);c=await self.client(lambda req:sse(body=body),timeout_seconds=.05);stream=c.runs.events(RUN);await anext(stream)
  try:await self.error(stream.aclose(),'CLIENT_CLOSE_PENDING');self.assertEqual(c.event_transport_status().streams,1)
  finally:gate.set();await stream.aclose()
  self.assertEqual(c.event_transport_status().streams,0)
 async def test_cancelling_close_observer_does_not_cancel_original_cleanup(self):
  gate=asyncio.Event();body=Wire(frame('ready',ready()),close_gate=gate);c=await self.client(lambda req:sse(body=body));stream=c.runs.events(RUN);await anext(stream);closing=asyncio.create_task(stream.aclose());await body.closing.wait();closing.cancel()
  try:
   with self.assertRaises(AgentClientCancelledError):await closing
   self.assertEqual(c.event_transport_status().streams,1)
  finally:gate.set();await stream.aclose()
  self.assertEqual(body.closes,1)
 async def test_client_close_is_singleflight_and_includes_stream_cleanup(self):
  gate=asyncio.Event();body=Wire(frame('ready',ready()),close_gate=gate);c=await self.client(lambda req:sse(body=body));stream=c.runs.events(RUN);await anext(stream);closing=asyncio.create_task(c.aclose());await body.closing.wait();closing.cancel()
  try:
   with self.assertRaises(AgentClientCancelledError):await closing
   self.assertEqual(c.event_transport_status().streams,1)
   with self.assertRaises(AgentClientError)as e:c.runs.events(RUN)
   self.assertEqual(e.exception.code,'CLIENT_CLOSED')
  finally:gate.set();await c.aclose()
  self.assertEqual(c.event_transport_status().streams,0);self.assertEqual(body.closes,1)
 async def test_client_close_starts_stream_cleanup_before_noncooperative_ordinary_settles(self):
  gate=asyncio.Event();entered=asyncio.Event();body=Wire(frame('ready',ready()))
  async def handler(req):
   if '/events/stream'in req.url.path:return sse(body=body)
   entered.set()
   try:await gate.wait()
   except asyncio.CancelledError:await gate.wait()
   return response(run())
  c=await self.client(handler);stream=c.runs.events(RUN);await anext(stream);ordinary=asyncio.create_task(c.runs.get(RUN));await entered.wait();closing=asyncio.create_task(c.aclose());await body.closing.wait();self.assertFalse(gate.is_set());gate.set();await asyncio.gather(ordinary,return_exceptions=True);await closing;self.assertEqual(c.event_transport_status().streams,0)
 async def test_late_response_after_timeout_is_closed_without_parsing_or_replacement(self):
  gate=asyncio.Event();body=Wire(complete());calls=[]
  async def handler(req):calls.append(req);await gate.wait();return sse(body=body)
  c=await self.client(handler,event_stream_timeout_seconds=.1,timeout_seconds=.05);stream=c.runs.events(RUN)
  try:await self.error(anext(stream),'CLIENT_TIMEOUT');self.assertEqual(len(calls),1)
  finally:gate.set();await stream.aclose()
  self.assertEqual(body.reads,0);self.assertEqual(body.closes,1)
 async def test_retry_waits_for_actual_previous_close_and_deadline_retains_capacity(self):
  gate=asyncio.Event();body=Wire(frame('ready',ready()),close_gate=gate);calls=[];c=await self.client(lambda req:(calls.append(req),sse(body=body))[1],event_stream_timeout_seconds=.1,timeout_seconds=.05);stream=c.runs.events(RUN);await anext(stream);pending=asyncio.create_task(anext(stream));await body.closing.wait()
  try:await self.error(pending,'CLIENT_TIMEOUT');self.assertEqual(len(calls),1);self.assertEqual(c.event_transport_status().streams,1)
  finally:gate.set();await stream.aclose()
  self.assertEqual(body.closes,1)
 async def test_redirect_is_terminal_and_context_exception_keeps_original_error(self):
  calls=[];c=await self.client(lambda req:(calls.append(req),sse(status=307,headers={'location':'https://other.test'}))[1]);stream=c.runs.events(RUN);await self.error(anext(stream),'CLIENT_REDIRECT_REJECTED');await stream.aclose();self.assertEqual(len(calls),1)
  gate=asyncio.Event();body=Wire(frame('ready',ready()),close_gate=gate);c=await self.client(lambda req:sse(body=body),timeout_seconds=.05);stream=c.runs.events(RUN)
  try:
   with self.assertRaisesRegex(ValueError,'original'):
    async with stream:await anext(stream);raise ValueError('original')
   self.assertEqual(c.event_transport_status().streams,1)
  finally:gate.set();await stream.aclose()

class ActualStreams(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.child=await asyncio.create_subprocess_exec(os.environ.get('SESSION_PYTHON_TEST_NODE','node'),str(Path(__file__).resolve().parents[1]/'fixtures/agent-event-stream-python-http.mjs'),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE);self.addAsyncCleanup(self.stop);self.info=json.loads(await asyncio.wait_for(self.child.stdout.readline(),3));self.run=AgentRunId(self.info['agentRunId']);self.base='http://127.0.0.1:'+str(self.info['port']);self.client=AgentClient(base_url=self.base,api_key=self.info['keys']['all']);self.addAsyncCleanup(self.client.aclose)
 async def command(self,line):self.child.stdin.write((line+'\n').encode());await self.child.stdin.drain();return json.loads(await asyncio.wait_for(self.child.stdout.readline(),3))
 async def stop(self):
  if self.child.returncode is None:
   self.child.stdin.write(b'close\n');await self.child.stdin.drain();self.child.stdin.close();await self.child.stdin.wait_closed()
   try:_,error=await asyncio.wait_for(self.child.communicate(),3)
   except BaseException:self.child.kill();await self.child.wait();raise
   self.assertEqual(self.child.returncode,0,error.decode()[-2000:])
 async def test_actual_multiple_windows_keep_order_eventids_and_original_effects(self):
  await self.command('perform');events=[];requests=set()
  async with self.client.runs.events(self.run,reconnects=3)as stream:
   async for message in stream:
    requests.add(message.request_id)
    if message.kind=='event':events.append(message.event)
  self.assertEqual([e.sequence for e in events],[1,2,3,4,5,6]);self.assertEqual(len(set(e.event_id for e in events)),6);self.assertEqual(len(requests),4);self.assertEqual((await self.command('stats'))['effects'],1)
 async def test_actual_context_break_closes_reader_without_ending_source(self):
  async with self.client.runs.events(self.run)as stream:
   async for message in stream:self.assertEqual(message.kind,'ready');break
  self.assertEqual(self.client.event_transport_status().streams,0);self.assertEqual((await self.command('stats'))['run']['state'],'active')
 async def test_actual_pending_ordinary_and_stream_do_not_block_end_or_credit_source(self):
  await self.command('hold');c=AgentClient(base_url=self.base,api_key=self.info['keys']['all'],max_concurrent_requests=1);self.addAsyncCleanup(c.aclose);pending=asyncio.create_task(c.runs.context(AgentRunReference(self.run,SessionId(self.info['sessionId']))))
  try:
   async with asyncio.timeout(3):
    while (await self.command('stats'))['work']['ordinary']!=1:await asyncio.sleep(0)
   async with c.runs.events(self.run)as stream:await anext(stream);await c.runs.cancel(self.run)
   stats=await self.command('stats');self.assertEqual(stats['run']['state'],'closed');self.assertEqual(stats['work']['ordinary'],1);self.assertEqual(c.transport_status().ordinary,1);self.assertEqual((await self.client.runs.cancellation(self.run)).data.status,'settling')
  finally:await self.command('settle');await asyncio.gather(pending,return_exceptions=True)
  self.assertEqual((await self.client.runs.cancellation(self.run)).data.status,'closed')
 async def test_actual_reconnect_reauth_observes_revoked_key(self):
  stream=self.client.runs.events(self.run)
  try:
   while (await anext(stream)).kind!='checkpoint':pass
   await self.command('revoke')
   with self.assertRaises(AgentClientError)as e:await anext(stream)
   self.assertIn(e.exception.status,(401,403));self.assertEqual((await self.command('stats'))['requests'],2)
  finally:await stream.aclose()
 async def test_actual_initial_retention_gap_never_skips_to_newest(self):
  await self.command('burst');stream=self.client.runs.events(self.run)
  with self.assertRaises(AgentClientError)as e:await anext(stream)
  self.assertEqual(e.exception.code,'AGENT_EVENT_GAP');self.assertTrue(e.exception.details.missing_history);self.assertEqual(e.exception.cursor,'aec1.'+self.run+'.0');await stream.aclose()
 async def test_actual_retention_gap_after_checkpoint_is_explicit(self):
  stream=self.client.runs.events(self.run)
  try:
   while (await anext(stream)).kind!='checkpoint':pass
   await self.command('burst')
   with self.assertRaises(AgentClientError)as e:await anext(stream)
   self.assertEqual(e.exception.code,'AGENT_EVENT_GAP');self.assertEqual(e.exception.cursor,'aec1.'+self.run+'.2')
  finally:await stream.aclose()
 async def test_actual_tcp_interruption_and_http_restart_keep_original_sequences(self):
  await self.command('perform');await self.command('drop');events=[];stream=self.client.runs.events(self.run,reconnects=3);restarted=False
  try:
   async for message in stream:
    if message.kind=='event':
     events.append(message.event.sequence)
     if not restarted:await self.command('restart');restarted=True
  finally:await stream.aclose()
  self.assertEqual(events,[1,2,3,4,5,6]);stats=await self.command('stats');self.assertEqual(stats['effects'],1);self.assertEqual(stats['drops'],1);self.assertLessEqual(stats['requests'],4);self.assertTrue(restarted)
 async def test_actual_read_end_scopes_stay_independent(self):
  async with AgentClient(base_url=self.base,api_key=self.info['keys']['read'])as reader:
   async with reader.runs.events(self.run)as stream:await anext(stream)
   with self.assertRaises(AgentClientError)as e:await reader.runs.cancel(self.run)
   self.assertEqual(e.exception.code,'FORBIDDEN')
  async with AgentClient(base_url=self.base,api_key=self.info['keys']['end'])as ender:
   stream=ender.runs.events(self.run)
   try:
    with self.assertRaises(AgentClientError)as e:await anext(stream)
    self.assertEqual(e.exception.code,'FORBIDDEN')
   finally:await stream.aclose()
   await ender.runs.cancel(self.run)
