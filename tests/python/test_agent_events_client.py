from __future__ import annotations
import asyncio
import copy
from dataclasses import FrozenInstanceError,asdict
import json
import os
from pathlib import Path
import unittest
import httpx
from remote_paint_session import (AgentClient,AgentClientError,AgentClientCancelledError,
    AgentRunId,AgentEventCursor,AgentCancellationCursor,AgentEventPage,AgentEventGap,
    AgentRunEvent,AgentInvocationEvent,AgentCancellation,AgentCancellationWork)
from test_agent_client import RUN,SID,INV,AT,uid,Body,response,failure,run,until

KEY='fixture_python_events_backend_key_0000000000'
def cursor(n,run_id=RUN):return AgentEventCursor('aec1.'+run_id+'.'+str(n))
def cancel_cursor(sequence,invocation_id=INV):return AgentCancellationCursor('acc1.'+RUN+'.'+str(sequence)+'.'+invocation_id)
def projection(**patch):return dict(state='active',holdsWriter=True,beginDispatch='confirmed',endDispatch='not-requested',error=None,closeEvidenceKind=None)|patch
def event(n,**patch):return dict(schema='agent-event-v1',eventId='aevt_'+uid(n+100),agentRunId=RUN,sessionId=SID,region='test',version='sdk-v1',sequence=n,observedAt=AT,type='run.updated',data=projection(stateUpdatedAt=AT))|patch
def page(after=0,latest=2):return dict(schema='agent-event-http-page-v1',agentRunId=RUN,sessionId=SID,region='test',version='sdk-v1',historyOrigin='created',after=cursor(after),oldestSequence=max(1,latest-63),latestSequence=latest,gap=False,events=[event(n)for n in range(after+1,min(after+4,latest)+1)],nextCursor=cursor(min(after+4,latest)),hasMore=after+4<latest,oldestCursor=cursor(max(0,latest-64)),latestCursor=cursor(latest))
def gap(after=0,latest=70):return dict(schema='agent-event-gap-v1',agentRunId=RUN,historyOrigin='created',after=cursor(after),oldestCursor=cursor(latest-64),latestCursor=cursor(latest),missingHistory=True)
def invocation(state='injected',invocation_id=INV,**patch):return dict(invocationId=invocation_id,tool='insertText',state=state,dispatchStarted=state!='intent',receipt=dict(stage='input-injected',inputs=1)if state=='injected'else None,error=dict(code='AGENT_RPC_TIMEOUT',outcome='unknown')if state=='unknown'else dict(code='AGENT_PAUSED',outcome='not-dispatched')if state=='rejected'else None,effect={'intent':'not-dispatched-yet','requested':'unknown','injected':'input-injected','rejected':'not-dispatched','unknown':'unknown'}[state],updatedAt=AT)|patch
def report(**patch):return dict(schema='agent-cancellation-v1',agentRunId=RUN,sessionId=SID,region='test',version='sdk-v1',observedAt=AT,status='not-requested',run=projection(),work=dict(ordinaryPending=False,endPending=False,recoveryRequired=False,executorStopping=False),scope='original-agent-run',rollbackSupported=False,rollbackPerformed=False,businessSuccessConfirmed=False,page=dict(generation=cursor(2),historyOrigin='created',after=None,nextCursor=None,hasMore=False,completeRun=True),invocations=[])|patch
def reply_report(value,status=200):return response(value,status,headers={'location':'/v1/agent-runs/'+value['agentRunId']+'/cancellation'})

class FiniteEvents(unittest.IsolatedAsyncioTestCase):
 async def client(self,handler,**options):
  client=AgentClient(base_url='https://api.fixture.test',api_key=KEY,transport=httpx.MockTransport(handler),**options);self.addAsyncCleanup(client.aclose);return client
 def invalid(self,call):
  with self.assertRaises(AgentClientError)as error:call()
  self.assertEqual(error.exception.code,'CLIENT_INVALID_REQUEST');self.assertEqual(error.exception.outcome,'not-dispatched')
 async def bad(self,data,method='event_page',status=200,**kwargs):
  client=await self.client(lambda req:response(data,status))
  with self.assertRaises(AgentClientError)as error:await getattr(client.runs,method)(RUN,**kwargs)
  self.assertEqual(error.exception.code,'CLIENT_INVALID_RESPONSE')
 async def test_public_models_and_nested_tuples_are_frozen(self):
  client=await self.client(lambda req:response(page()));value=(await client.runs.event_page(RUN)).data;self.assertIsInstance(value,AgentEventPage);self.assertIsInstance(value.events[0],AgentRunEvent);self.assertIsInstance(value.events,tuple)
  for target,name in [(value,'latest_sequence'),(value.events[0],'sequence'),(value.events[0].data,'holds_writer')]:
   with self.assertRaises(FrozenInstanceError):setattr(target,name,False)
  self.assertNotIn(KEY,repr(client));self.assertEqual(len(asdict(value)['events']),2)
 async def test_input_cursors_and_retries_are_captured_before_any_coroutine_or_http(self):
  calls=[];client=await self.client(lambda req:calls.append(req))
  class Evil(str):
   def startswith(self,*args):raise AssertionError('getter')
  for value in ['',cursor(0)+'\n',cursor(0).replace('.0','.01'),cursor(0).replace('.0','.-1'),cursor(0).replace('.0','.9007199254740992'),cursor(0,AgentRunId('arun_'+uid(99))),True,1,Evil(cursor(0)),cancel_cursor(2)]:self.invalid(lambda:client.runs.event_page(RUN,after=value))
  for value in [cursor(0),cancel_cursor(0),cancel_cursor(2)+'\n',cancel_cursor(2).replace(RUN,'arun_'+uid(99))]:self.invalid(lambda:client.runs.cancellation(RUN,after=value))
  self.invalid(lambda:client.runs.cancel(AgentRunId('arun_bad')));self.invalid(lambda:client.runs.event_page(RUN,retries=True));self.invalid(lambda:client.runs.cancel(RUN,retries=4))
  with self.assertRaises(TypeError):client.runs.cancel(RUN,after=cancel_cursor(2))
  self.assertEqual(calls,[])
 async def test_valid_partial_complete_and_empty_event_pages_keep_exact_cursor(self):
  calls=[];client=await self.client(lambda req:(calls.append(req),response(page(2,7)))[1]);result=(await client.runs.event_page(RUN,after=cursor(2))).data;self.assertEqual(len(result.events),4);self.assertTrue(result.has_more);self.assertEqual(result.next_cursor,cursor(6));self.assertEqual(str(calls[0].url),'https://api.fixture.test/v1/agent-runs/'+RUN+'/events?after='+cursor(2));self.assertEqual(calls[0].content,b'');self.assertNotIn('idempotency-key',calls[0].headers)
  for after,latest in [(0,2),(2,2),(65,65)]:
   c=await self.client(lambda req,a=after,l=latest:response(page(a,l)));value=(await c.runs.event_page(RUN,after=cursor(after))).data;self.assertFalse(value.has_more);self.assertEqual(value.next_cursor,cursor(latest))
 async def test_event_pages_reject_schema_identity_sequence_bounds_metadata_and_boolean_integers(self):
  patches=[lambda v:v.update(gap=True),lambda v:v.update(extra='private'),lambda v:v.update(oldestSequence=True),lambda v:v.update(latestSequence=True),lambda v:v.update(after=cursor(1)),lambda v:v.update(nextCursor=cursor(3)),lambda v:v.update(hasMore=True),lambda v:v['events'].pop(),lambda v:v['events'][0].update(sequence=True),lambda v:v['events'][0].update(sequence=2),lambda v:v['events'][1].update(eventId=v['events'][0]['eventId']),lambda v:v['events'][0].update(sessionId='ses_'+uid(99)),lambda v:v['events'][0].update(version='changed'),lambda v:v['events'][0].update(observedAt='2026-10-20T00:00:00Z'),lambda v:v['events'][0].update(secret='private'),lambda v:v['events'][0].update(type='business.succeeded'),lambda v:v['events'][0]['data'].update(holdsWriter=False),lambda v:v.update(region='😀'*33)]
  for patch in patches:
   value=page();patch(value);await self.bad(value)
  await self.bad(page(),status=202)
 async def test_invocation_event_variants_preserve_receipts_and_unknown_without_parameters(self):
  for state in ['intent','requested','injected','rejected','unknown']:
   row=invocation(state);row['stateUpdatedAt']=row.pop('updatedAt');row.pop('effect');value=page(0,1);value['events']=[event(1,type='invocation.snapshot',data=row)];client=await self.client(lambda req,v=value:response(v));result=(await client.runs.event_page(RUN)).data.events[0];self.assertIsInstance(result,AgentInvocationEvent);self.assertEqual(result.data.state,state);self.assertFalse(hasattr(result.data,'params'))
   bad=copy.deepcopy(value)
   if state=='rejected':bad['events'][0]['data']['error']['outcome']='unknown'
   else:bad['events'][0]['data']['dispatchStarted']=not row['dispatchStarted']
   await self.bad(bad)
 async def test_run_projection_requires_matching_dispatch_and_original_close_evidence(self):
  projections=[projection(state='closed',holdsWriter=False,beginDispatch='not-requested',closeEvidenceKind='never-dispatched'),projection(state='closed',holdsWriter=False,beginDispatch='requested',error=dict(code='AGENT_PAUSED',outcome='not-dispatched'),closeEvidenceKind='begin-rejected'),projection(state='closed',holdsWriter=False,endDispatch='confirmed',closeEvidenceKind='worker-run-closed'),projection(state='recovery-required',error=dict(code='AGENT_RPC_TIMEOUT',outcome='unknown'))]
  for state in projections:
   value=page(0,1);value['events']=[event(1,type='run.snapshot',data=state|dict(stateUpdatedAt=AT))];c=await self.client(lambda req,v=value:response(v));self.assertEqual((await c.runs.event_page(RUN)).data.events[0].data.state,state['state'])
  for patch in [dict(state='closed',holdsWriter=False),dict(closeEvidenceKind='worker-run-closed'),dict(endDispatch='confirmed'),dict(state='intent'),dict(state='starting'),dict(error=dict(code='CLIENT_RAW',outcome='unknown'))]:
   value=page(0,1);value['events'][0]['data'].update(patch);await self.bad(value)
 async def test_only_valid_retention_gap_details_are_public_frozen_and_never_skip(self):
  calls=[];client=await self.client(lambda req:(calls.append(req),failure('AGENT_EVENT_GAP',409,'not-dispatched',details=gap()))[1],retries=3)
  with self.assertRaises(AgentClientError)as error:await client.runs.event_page(RUN)
  self.assertEqual(error.exception.code,'AGENT_EVENT_GAP');self.assertIsInstance(error.exception.details,AgentEventGap);self.assertTrue(error.exception.details.missing_history);self.assertNotIn(KEY,str(error.exception));self.assertEqual(len(calls),1)
  with self.assertRaises(FrozenInstanceError):error.exception.details.after=cursor(7)
  for patch in [dict(after=cursor(7)),dict(missingHistory=False),dict(extra='private'),dict(oldestCursor=cursor(5)),dict(historyOrigin='all-history')]:
   c=await self.client(lambda req,p=patch:failure('AGENT_EVENT_GAP',409,'not-dispatched',details=gap()|p))
   with self.assertRaises(AgentClientError)as e:await c.runs.event_page(RUN)
   self.assertEqual(e.exception.code,'CLIENT_INVALID_RESPONSE')
  for code,status,outcome in [('FORBIDDEN',403,'not-dispatched'),('AGENT_EVENT_GAP',200,'not-dispatched'),('AGENT_EVENT_GAP',409,'unknown')]:
   c=await self.client(lambda req,c=code,s=status,o=outcome:failure(c,s,o,details=gap()))
   with self.assertRaises(AgentClientError)as e:await c.runs.event_page(RUN)
   self.assertEqual(e.exception.code,'CLIENT_INVALID_RESPONSE')
 async def test_explicit_finite_retry_keeps_valid_gap_details_and_prior_dispatch_uncertainty(self):
  calls=[]
  async def handler(req):
   calls.append(req)
   if len(calls)==1:raise RuntimeError('private '+KEY)
   return failure('AGENT_EVENT_GAP',409,'not-dispatched',details=gap())
  client=await self.client(handler,retries=1)
  with self.assertRaises(AgentClientError)as e:await client.runs.event_page(RUN)
  self.assertEqual(e.exception.code,'AGENT_EVENT_GAP');self.assertEqual(e.exception.outcome,'unknown');self.assertTrue(e.exception.details.missing_history);self.assertEqual(len(calls),2);self.assertEqual(calls[0].url,calls[1].url)
 async def test_cancellation_status_depends_on_actual_work_and_matching_http_location(self):
  cases=[report(),report(status='pending',run=projection(state='closing',endDispatch='requested')),report(status='reconciliation-required',run=projection(state='recovery-required',error=dict(code='AGENT_RPC_TIMEOUT',outcome='unknown')))]
  closed=projection(state='closed',holdsWriter=False,endDispatch='confirmed',closeEvidenceKind='worker-run-closed');cases.extend([report(status='closed',run=closed),report(status='settling',run=closed,work=dict(ordinaryPending=True,endPending=False,recoveryRequired=False,executorStopping=False))])
  for value in cases:
   status=202 if value['status']in('pending','settling')else 200;c=await self.client(lambda req,v=value,s=status:reply_report(v,s));result=(await c.runs.cancel(RUN)).data;self.assertIsInstance(result,AgentCancellation);self.assertEqual(result.status,value['status']);self.assertFalse(result.business_success_confirmed);self.assertFalse(result.rollback_performed)
   bad=await self.client(lambda req,v=value,s=status:reply_report(v,202 if s==200 else 200))
   with self.assertRaises(AgentClientError):await bad.runs.cancel(RUN)
  await self.bad(report(),'cancel')
  for key,value in [('status','closed'),('rollbackSupported',True),('rollbackPerformed',0),('businessSuccessConfirmed',True),('scope','any-run')]:await self.bad(report(**{key:value}),'cancellation')
 async def test_cancellation_effects_remain_unknown_injected_or_not_dispatched_and_are_immutable(self):
  for state in ['intent','requested','injected','rejected','unknown']:
   value=report(invocations=[invocation(state)]);c=await self.client(lambda req,v=value:response(v));result=(await c.runs.cancellation(RUN)).data;self.assertIsInstance(result.invocations,tuple);self.assertEqual(result.invocations[0].effect,value['invocations'][0]['effect']);self.assertIsInstance(result.work,AgentCancellationWork)
   with self.assertRaises(FrozenInstanceError):result.work.ordinary_pending=True
   bad=copy.deepcopy(value);bad['invocations'][0]['effect']='business-succeeded';await self.bad(bad,'cancellation')
   bad=copy.deepcopy(value);bad['invocations'][0]['receipt']=dict(stage='input-injected',inputs=True);await self.bad(bad,'cancellation')
 async def test_cancellation_pages_are_sorted_bounded_and_bound_to_one_run_generation(self):
  rows=[invocation(invocation_id='ainv_'+uid(i))for i in range(11,15)];value=report(invocations=rows,page=dict(generation=cursor(2),historyOrigin='created',after=None,nextCursor=cancel_cursor(2,rows[-1]['invocationId']),hasMore=True,completeRun=False));c=await self.client(lambda req:response(value));result=(await c.runs.cancellation(RUN)).data;self.assertEqual(len(result.invocations),4);self.assertFalse(result.page.complete_run)
  second=report(invocations=[invocation(invocation_id='ainv_'+uid(15))],page=dict(generation=cursor(2),historyOrigin='created',after=result.page.next_cursor,nextCursor=None,hasMore=False,completeRun=False));c=await self.client(lambda req:response(second));self.assertEqual((await c.runs.cancellation(RUN,after=result.page.next_cursor)).data.invocations[0].invocation_id,'ainv_'+uid(15))
  for patch in [lambda v:v['invocations'].reverse(),lambda v:v['invocations'].append(invocation()),lambda v:v['page'].update(nextCursor=cancel_cursor(3,rows[-1]['invocationId'])),lambda v:v['page'].update(completeRun=True),lambda v:v['page'].update(generation=cursor(0)),lambda v:v['page'].update(hasMore=1),lambda v:v['invocations'][0].update(extra='private')]:
   bad=copy.deepcopy(value);patch(bad);await self.bad(bad,'cancellation')
  changed=await self.client(lambda req:failure('AGENT_CANCELLATION_CHANGED',409,'not-dispatched'),retries=3)
  with self.assertRaises(AgentClientError)as e:await changed.runs.cancellation(RUN,after=result.page.next_cursor)
  self.assertEqual(e.exception.code,'AGENT_CANCELLATION_CHANGED');self.assertIsNone(e.exception.details)
 async def test_pre_cancelled_task_sends_no_request(self):
  calls=[];c=await self.client(lambda req:calls.append(req));task=asyncio.create_task(c.runs.event_page(RUN));task.cancel()
  with self.assertRaises(asyncio.CancelledError):await task
  self.assertEqual(calls,[]);self.assertEqual(c.transport_status().ordinary,0)
 async def test_noncooperative_send_timeout_keeps_ordinary_admission_and_cancel_end_pool(self):
  gate=asyncio.Event();entered=asyncio.Event()
  async def handler(req):
   if req.url.path.endswith('/cancel'):return reply_report(report())
   entered.set()
   try:await gate.wait()
   except asyncio.CancelledError:await gate.wait()
   return response(page())
  c=await self.client(handler,timeout_seconds=.05,max_concurrent_requests=1)
  try:
   with self.assertRaises(AgentClientError)as e:await c.runs.event_page(RUN)
   self.assertEqual(e.exception.code,'CLIENT_TIMEOUT');self.assertTrue(entered.is_set());self.assertEqual(c.transport_status().ordinary,1);self.assertEqual((await c.runs.cancel(RUN)).data.status,'not-requested')
   with self.assertRaises(AgentClientError)as e:await c.runs.cancellation(RUN)
   self.assertEqual(e.exception.code,'CLIENT_BUSY')
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_caller_task_cancellation_does_not_release_actual_work_or_replay(self):
  gate=asyncio.Event();entered=asyncio.Event();calls=[]
  async def handler(req):
   calls.append(req);entered.set()
   try:await gate.wait()
   except asyncio.CancelledError:await gate.wait()
   return response(page())
  c=await self.client(handler);pending=asyncio.create_task(c.runs.event_page(RUN));await entered.wait();pending.cancel()
  try:
   with self.assertRaises(AgentClientCancelledError)as e:await pending
   self.assertEqual(e.exception.outcome,'unknown');self.assertEqual(c.transport_status().ordinary,1);self.assertEqual(len(calls),1)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)
 async def test_response_close_failure_fences_new_requests_without_exposing_private_error(self):
  class Broken(Body):
   async def aclose(self):raise RuntimeError(KEY)
  body=Broken(json.dumps(dict(data=page(),requestId='req_python_agent')).encode());c=await self.client(lambda req:response(stream=body))
  with self.assertRaises(AgentClientError)as e:await c.runs.event_page(RUN)
  self.assertEqual(e.exception.code,'CLIENT_RESPONSE_CLOSE_FAILED');self.assertNotIn(KEY,str(e.exception))
  with self.assertRaises(AgentClientError)as e:await c.runs.cancel(RUN)
  self.assertEqual(e.exception.code,'CLIENT_CLOSED')
 async def test_noncooperative_body_and_shared_end_pool_retire_only_after_actual_settlement(self):
  gate=asyncio.Event();entered=asyncio.Event()
  class HeldBody(Body):
   async def __aiter__(self):
    entered.set()
    try:await gate.wait()
    except asyncio.CancelledError:await gate.wait()
    yield self.data
  body=HeldBody(json.dumps(dict(data=report(),requestId='req_python_agent')).encode())
  async def handler(req):return response(stream=body,headers={'location':'/v1/agent-runs/'+RUN+'/cancellation'})if req.url.path.endswith('/cancel')else response(run())
  c=await self.client(handler,timeout_seconds=.05,max_concurrent_end_requests=1)
  try:
   with self.assertRaises(AgentClientError)as e:await c.runs.cancel(RUN)
   self.assertEqual(e.exception.code,'CLIENT_TIMEOUT');self.assertTrue(entered.is_set());self.assertEqual(c.transport_status().ending,1)
   with self.assertRaises(AgentClientError)as e:await c.runs.end(RUN)
   self.assertEqual(e.exception.code,'CLIENT_BUSY')
   self.assertEqual((await c.runs.get(RUN)).data.agent_run_id,RUN)
  finally:gate.set();await until(lambda:c.transport_status().ending==0)
  self.assertTrue(body.closed)

class ActualHTTP(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.process=await asyncio.create_subprocess_exec(os.environ.get('SESSION_PYTHON_TEST_NODE','node'),str(Path(__file__).resolve().parents[1]/'fixtures/agent-events-python-http.mjs'),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
  self.addAsyncCleanup(self.stop)
  self.info=json.loads(await asyncio.wait_for(self.process.stdout.readline(),5));self.run=AgentRunId(self.info['agentRunId']);self.base='http://127.0.0.1:'+str(self.info['port'])
  self.client=AgentClient(base_url=self.base,api_key=self.info['keys']['all']);self.addAsyncCleanup(self.client.aclose)
 async def command(self,line):
  self.process.stdin.write((line+'\n').encode());await self.process.stdin.drain();return json.loads(await asyncio.wait_for(self.process.stdout.readline(),5))
 async def stop(self):
  if self.process.returncode is None:
   self.process.stdin.write(b'close\n');await self.process.stdin.drain();self.process.stdin.close();await self.process.stdin.wait_closed()
   try:await asyncio.wait_for(self.process.wait(),5)
   except TimeoutError:self.process.kill();await self.process.wait()
  error=(await self.process.stderr.read()).decode();self.assertEqual(self.process.returncode,0,error)
 async def test_actual_event_pages_gap_and_independent_tenant_scopes(self):
  await self.command('perform');value=(await self.client.runs.event_page(self.run)).data;self.assertEqual(len(value.events),4);self.assertTrue(value.has_more);other=(await self.client.runs.event_page(self.run,after=value.next_cursor)).data;self.assertEqual(other.events[0].sequence,value.events[-1].sequence+1)
  async with AgentClient(base_url=self.base,api_key=self.info['keys']['read'])as reader:
   self.assertIsInstance((await reader.runs.event_page(self.run)).data,AgentEventPage)
   with self.assertRaises(AgentClientError)as e:await reader.runs.cancel(self.run)
   self.assertEqual(e.exception.code,'FORBIDDEN')
  async with AgentClient(base_url=self.base,api_key=self.info['keys']['other'])as other:
   with self.assertRaises(AgentClientError)as e:await other.runs.cancellation(self.run)
   self.assertEqual(e.exception.code,'AGENT_RUN_NOT_FOUND')
  await self.command('burst')
  with self.assertRaises(AgentClientError)as e:await self.client.runs.event_page(self.run)
  self.assertEqual(e.exception.code,'AGENT_EVENT_GAP');self.assertTrue(e.exception.details.missing_history)
 async def test_actual_cancellation_pages_and_changed_generation_do_not_auto_restart(self):
  for _ in range(6):await self.command('perform')
  first=(await self.client.runs.cancellation(self.run)).data;second=(await self.client.runs.cancellation(self.run,after=first.page.next_cursor)).data;self.assertEqual(len(first.invocations),4);self.assertEqual(len(second.invocations),2);self.assertFalse(second.page.complete_run);self.assertEqual(len(set(row.invocation_id for row in first.invocations+second.invocations)),6)
  await self.client.runs.cancel(self.run)
  with self.assertRaises(AgentClientError)as e:await self.client.runs.cancellation(self.run,after=first.page.next_cursor)
  self.assertEqual(e.exception.code,'AGENT_CANCELLATION_CHANGED');self.assertEqual((await self.command('stats'))['effects'],6)
 async def test_actual_unknown_effect_stays_unknown_after_explicit_cancel(self):
  await self.command('perform');await self.command('unknown');await self.client.runs.cancel(self.run);value=(await self.client.runs.cancellation(self.run)).data;self.assertEqual({row.effect for row in value.invocations},{'input-injected','unknown'});self.assertFalse(value.business_success_confirmed);self.assertFalse(value.rollback_performed);self.assertEqual((await self.command('stats'))['effects'],1)
 async def test_actual_closed_run_reports_settling_until_original_source_task_finishes(self):
  await self.command('pending');await self.client.runs.cancel(self.run)
  value=(await self.client.runs.cancellation(self.run)).data;self.assertEqual(value.run.state,'closed');self.assertEqual(value.status,'settling');self.assertTrue(value.work.ordinary_pending)
  await self.command('settle');self.assertEqual((await self.client.runs.cancellation(self.run)).data.status,'closed');self.assertEqual((await self.command('stats'))['effects'],0)
