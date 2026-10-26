from __future__ import annotations
import asyncio
from dataclasses import FrozenInstanceError
import json
import os
from pathlib import Path
import unittest
import httpx
from remote_paint_session import (AgentClient,AgentClientError,AgentClientCancelledError,AgentRunId,
    AgentWebhookEndpointId,AgentWebhookSubscriptionId,AgentWebhookSubscribeInput,AgentWebhookSubscription,AgentWebhookEndpoints)
from test_agent_client import RUN,SID,uid,response,until
from test_agent_events_client import cursor

KEY='fixture_python_webhook_backend_key_000000000'
ENDPOINT=AgentWebhookEndpointId('awh_'+uid(1));SUB=AgentWebhookSubscriptionId('awsub_'+uid(2))
def subscription(**patch):return dict(schema='agent-webhook-subscription-v1',subscriptionId=SUB,agentRunId=RUN,sessionId=SID,endpointId=ENDPOINT,after=cursor(0),acceptedThrough=cursor(1),queuedThrough=cursor(3),observedLatest=cursor(3),pending=2,reconciliationRequired=False,missingFrom=None,missingThrough=None,head=dict(eventId='aevt_'+uid(4),sequence=2,attempts=0,lastOutcome=None,cursor=cursor(2)))|patch
def endpoints(rows=None):return dict(schema='agent-webhook-endpoints-v1',agentRunId=RUN,endpoints=[dict(endpointId=ENDPOINT,available=True)] if rows is None else rows)
def subscribed(v):return response(v,headers={'location':'/v1/agent-runs/'+RUN+'/webhook-subscriptions/'+v['subscriptionId']})

class FiniteWebhooks(unittest.IsolatedAsyncioTestCase):
 async def client(self,handler,**kwargs):
  c=AgentClient(base_url='https://fixture.test',api_key=KEY,transport=httpx.MockTransport(handler),**kwargs);self.addAsyncCleanup(c.aclose);return c
 def invalid(self,call):
  with self.assertRaises(AgentClientError)as e:call()
  self.assertEqual((e.exception.code,e.exception.outcome),('CLIENT_INVALID_REQUEST','not-dispatched'))
 async def bad(self,data,method='webhook_subscription',status=200,headers=None):
  c=await self.client(lambda req:response(data,status,headers=headers or {}))
  with self.assertRaises(AgentClientError)as e:
   if method=='subscribe_webhook':await c.runs.subscribe_webhook(RUN,AgentWebhookSubscribeInput(ENDPOINT,cursor(0)))
   elif method=='webhook_endpoints':await c.runs.webhook_endpoints(RUN)
   else:await c.runs.webhook_subscription(RUN,SUB)
  self.assertEqual(e.exception.code,'CLIENT_INVALID_RESPONSE')
 async def test_endpoint_profiles_are_frozen_tuples_and_use_the_public_route(self):
  calls=[];c=await self.client(lambda req:(calls.append(req),response(endpoints()))[1]);v=(await c.runs.webhook_endpoints(RUN)).data
  self.assertIsInstance(v,AgentWebhookEndpoints);self.assertIsInstance(v.endpoints,tuple);self.assertEqual(v.endpoints[0].endpoint_id,ENDPOINT)
  with self.assertRaises(FrozenInstanceError):v.endpoints[0].available=False
  self.assertTrue(str(calls[0].url).endswith('/v1/agent-runs/'+RUN+'/webhook-endpoints'));self.assertEqual(calls[0].content,b'')
  c=await self.client(lambda req:response(endpoints([])));self.assertEqual((await c.runs.webhook_endpoints(RUN)).data.endpoints,())
 async def test_inputs_and_retries_are_validated_before_a_coroutine_or_http(self):
  calls=[];c=await self.client(lambda req:calls.append(req))
  class Evil(str):
   def startswith(self,*args):raise AssertionError('getter')
  for after in [cursor(0)+'1'*100000,cursor(0)+'\n',cursor(0).replace('.0','.00'),cursor(0).replace('.0','.-1'),cursor(0).replace('.0','.9007199254740992'),cursor(0,AgentRunId('arun_'+uid(99))),True,Evil(cursor(0))]:self.invalid(lambda:c.runs.subscribe_webhook(RUN,AgentWebhookSubscribeInput(ENDPOINT,after)))
  for value in [dict(endpoint_id=ENDPOINT,after=cursor(0)),AgentWebhookSubscribeInput(AgentWebhookEndpointId(ENDPOINT+'\n'),cursor(0))]:self.invalid(lambda:c.runs.subscribe_webhook(RUN,value))
  self.invalid(lambda:c.runs.webhook_endpoints(AgentRunId(RUN+'\n')));self.invalid(lambda:c.runs.webhook_subscription(RUN,AgentWebhookSubscriptionId(SUB+'\n')));self.invalid(lambda:c.runs.webhook_endpoints(RUN,retries=True))
  with self.assertRaises(TypeError):c.runs.subscribe_webhook(RUN,AgentWebhookSubscribeInput(ENDPOINT,cursor(0)),idempotency_key='unused')
  self.assertEqual(calls,[])
 async def test_subscribe_captures_body_before_await_and_retries_identical_natural_key(self):
  calls=[]
  async def handler(req):
   calls.append(req)
   if len(calls)==1:raise httpx.ReadError('lost reply')
   return subscribed(subscription())
  c=await self.client(handler,retries=1);value=AgentWebhookSubscribeInput(ENDPOINT,cursor(0));pending=c.runs.subscribe_webhook(RUN,value);object.__setattr__(value,'after',cursor(9));r=(await pending).data
  self.assertIsInstance(r,AgentWebhookSubscription);self.assertEqual(len(calls),2);self.assertEqual(calls[0].content,calls[1].content);self.assertEqual(json.loads(calls[0].content),dict(endpointId=ENDPOINT,after=cursor(0)));self.assertNotIn('idempotency-key',calls[0].headers)
  with self.assertRaises(FrozenInstanceError):r.head.attempts=1
 async def test_ranges_keep_explicit_gaps_and_exhausted_original_heads(self):
  variants=[subscription(),subscription(head=subscription()['head']|dict(attempts=8,lastOutcome='unknown')),subscription(observedLatest=cursor(8),reconciliationRequired=True,missingFrom=cursor(4),missingThrough=cursor(8)),subscription(after=cursor(3),acceptedThrough=cursor(3),pending=0,head=None),subscription(acceptedThrough=cursor(3),pending=0,head=None,observedLatest=cursor(8),reconciliationRequired=True,missingFrom=cursor(4),missingThrough=cursor(8))]
  for row in variants:
   c=await self.client(lambda req,v=row:response(v));v=(await c.runs.webhook_subscription(RUN,SUB)).data;self.assertEqual(v.after,row['after']);self.assertEqual(v.reconciliation_required,row['reconciliationRequired']);self.assertEqual(v.missing_through,row['missingThrough'])
 async def test_invalid_cursor_ranges_head_attempts_and_delivery_claims_are_rejected(self):
  patches=[lambda v:v.update(pending=3),lambda v:v.update(after=cursor(2)),lambda v:v.update(acceptedThrough=cursor(4)),lambda v:v.update(observedLatest=cursor(2)),lambda v:v.update(queuedThrough=cursor(4)),lambda v:v.update(pending=True),lambda v:v.update(reconciliationRequired=1),lambda v:v.update(head=None),lambda v:v['head'].update(sequence=3),lambda v:v['head'].update(sequence=True),lambda v:v['head'].update(cursor=cursor(3)),lambda v:v['head'].update(attempts=9),lambda v:v['head'].update(lastOutcome='accepted'),lambda v:v['head'].update(attempts=1),lambda v:v['head'].update(eventId='aevt_'+uid(4)+'\n'),lambda v:v.update(missingFrom=cursor(4)),lambda v:v.update(after=cursor(0)+'\n'),lambda v:v.update(acceptedThrough=cursor(1,AgentRunId('arun_'+uid(99)))),lambda v:v.update(privateSignature='secret'),lambda v:v['head'].update(privateBody='secret'),lambda v:v.update(sessionId=SID+'\n')]
  for patch in patches:
   v=subscription();patch(v);await self.bad(v)
  for patch in [dict(missingFrom=cursor(3)),dict(missingThrough=cursor(7)),dict(reconciliationRequired=False)]:await self.bad(subscription(observedLatest=cursor(8),reconciliationRequired=True,missingFrom=cursor(4),missingThrough=cursor(8))|patch)
 async def test_endpoint_lists_reject_secrets_duplicates_order_and_capacity_overflow(self):
  for v in [endpoints([dict(endpointId=ENDPOINT,available=1)]),endpoints([dict(endpointId=ENDPOINT,available=True,secret='private')]),endpoints([dict(endpointId=ENDPOINT,available=True)]*2),endpoints([dict(endpointId='awh_'+uid(9),available=True),dict(endpointId=ENDPOINT,available=True)]),endpoints([dict(endpointId='awh_'+uid(n),available=True)for n in range(5)]),endpoints()|dict(agentRunId='arun_'+uid(99))]:await self.bad(v,'webhook_endpoints')
 async def test_subscription_reply_is_bound_to_request_and_exact_status_location_and_request_id(self):
  for v in [subscription(after=cursor(1)),subscription(endpointId='awh_'+uid(99)),subscription(agentRunId='arun_'+uid(99))]:await self.bad(v,'subscribe_webhook',headers={'location':'/v1/agent-runs/'+RUN+'/webhook-subscriptions/'+SUB})
  for status,headers in [(200,{}),(200,dict(location='/wrong')),(202,dict(location='/v1/agent-runs/'+RUN+'/webhook-subscriptions/'+SUB)),(200,{'x-request-id':'req_wrong'})]:await self.bad(subscription(),'subscribe_webhook',status,headers)
  await self.bad(subscription(subscriptionId='awsub_'+uid(99)))
 async def test_stable_errors_preserve_uncertain_write_outcomes(self):
  for status,code,outcome in [(404,'AGENT_WEBHOOK_SUBSCRIPTION_NOT_FOUND','not-dispatched'),(409,'AGENT_WEBHOOK_HISTORY_UNAVAILABLE','not-dispatched'),(429,'AGENT_WEBHOOK_CAPACITY','not-dispatched'),(503,'AGENT_STORAGE_UNAVAILABLE','unknown')]:
   c=await self.client(lambda req,s=status,c=code,o=outcome:httpx.Response(s,json=dict(error=dict(code=c,message='failure',outcome=o),requestId='req_python_agent'),headers={'x-request-id':'req_python_agent'}))
   with self.assertRaises(AgentClientError)as e:await c.runs.subscribe_webhook(RUN,AgentWebhookSubscribeInput(ENDPOINT,cursor(0)))
   self.assertEqual((e.exception.code,e.exception.status,e.exception.outcome),(code,status,outcome))
 async def test_caller_cancellation_keeps_shared_ordinary_capacity_until_original_settlement(self):
  gate=asyncio.Event();entered=asyncio.Event();calls=[]
  async def handler(req):
   calls.append(req);entered.set()
   try:await gate.wait()
   except asyncio.CancelledError:await gate.wait()
   return response(endpoints())
  c=await self.client(handler,max_concurrent_requests=1);pending=asyncio.create_task(c.runs.webhook_endpoints(RUN));await entered.wait();pending.cancel()
  try:
   with self.assertRaises(AgentClientCancelledError):await pending
   self.assertEqual(c.transport_status().ordinary,1)
   with self.assertRaises(AgentClientError)as e:await c.runs.subscribe_webhook(RUN,AgentWebhookSubscribeInput(ENDPOINT,cursor(0)))
   self.assertEqual(e.exception.code,'CLIENT_BUSY');self.assertEqual(len(calls),1)
  finally:gate.set();await until(lambda:c.transport_status().ordinary==0)

class ActualWebhookHTTP(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.process=await asyncio.create_subprocess_exec(os.environ.get('SESSION_PYTHON_TEST_NODE','node'),str(Path(__file__).resolve().parents[1]/'fixtures/agent-webhooks-python-http.mjs'),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
  self.addAsyncCleanup(self.stop);self.info=json.loads(await asyncio.wait_for(self.process.stdout.readline(),5));self.run=AgentRunId(self.info['agentRunId']);self.base=self.info['baseUrl'];self.endpoint=AgentWebhookEndpointId(self.info['endpointId']);self.input=AgentWebhookSubscribeInput(self.endpoint,cursor(0,self.run))
  self.client=AgentClient(base_url=self.base,api_key=self.info['keys']['all']);self.addAsyncCleanup(self.client.aclose)
 async def command(self,line):
  self.process.stdin.write((line+'\n').encode());await self.process.stdin.drain();return json.loads(await asyncio.wait_for(self.process.stdout.readline(),5))
 async def stop(self):
  if self.process.returncode is None:
   self.process.stdin.write(b'close\n');await self.process.stdin.drain();self.process.stdin.close();await self.process.stdin.wait_closed()
   try:await asyncio.wait_for(self.process.wait(),5)
   except TimeoutError:self.process.kill();await self.process.wait()
  error=(await self.process.stderr.read()).decode();self.assertEqual(self.process.returncode,0,error)
 async def drained(self,sub,n):
  deadline=asyncio.get_running_loop().time()+3
  while True:
   value=(await self.client.runs.webhook_subscription(self.run,sub)).data
   if value.accepted_through==cursor(n,self.run):return value
   self.assertLess(asyncio.get_running_loop().time(),deadline,'original delivery observation deadline');await asyncio.sleep(.01)
 async def test_actual_typed_client_reaches_durable_tls_inbox_and_tracks_original_agent_events(self):
  self.assertEqual((await self.client.runs.webhook_endpoints(self.run)).data.endpoints[0].endpoint_id,self.endpoint)
  sub=(await self.client.runs.subscribe_webhook(self.run,self.input)).data;await self.drained(sub.subscription_id,3);await self.command('perform');await self.drained(sub.subscription_id,6)
  inbox=await self.command('inbox');self.assertEqual([e['envelope']['event']['sequence']for e in inbox['events']],[1,2,3,4,5,6]);self.assertEqual(inbox['effects'],1);self.assertEqual(inbox['subscriptions'],1)
 async def test_actual_repeated_subscribe_and_closed_source_keep_the_same_subscription(self):
  first=(await self.client.runs.subscribe_webhook(self.run,self.input)).data;second=(await self.client.runs.subscribe_webhook(self.run,self.input)).data;self.assertEqual(first.subscription_id,second.subscription_id);await self.drained(first.subscription_id,3)
  await self.client.runs.end(self.run)
  deadline=asyncio.get_running_loop().time()+3
  while (await self.client.runs.get(self.run)).data.state!='closed':
   self.assertLess(asyncio.get_running_loop().time(),deadline);await asyncio.sleep(.01)
  latest=(await self.client.runs.event_page(self.run)).data.latest_cursor
  value=await self.drained(first.subscription_id,int(latest.rsplit('.',1)[1]));self.assertEqual(value.after,self.input.after);self.assertEqual(value.subscription_id,first.subscription_id)
 async def test_actual_scopes_tenant_isolation_and_immutable_start_cursor(self):
  async with AgentClient(base_url=self.base,api_key=self.info['keys']['read'])as reader:
   self.assertEqual(len((await reader.runs.webhook_endpoints(self.run)).data.endpoints),1)
   with self.assertRaises(AgentClientError)as e:await reader.runs.subscribe_webhook(self.run,self.input)
   self.assertEqual(e.exception.code,'FORBIDDEN')
  async with AgentClient(base_url=self.base,api_key=self.info['keys']['other'])as other:
   with self.assertRaises(AgentClientError)as e:await other.runs.webhook_endpoints(self.run)
   self.assertEqual(e.exception.code,'AGENT_RUN_NOT_FOUND')
  await self.client.runs.subscribe_webhook(self.run,self.input)
  with self.assertRaises(AgentClientError)as e:await self.client.runs.subscribe_webhook(self.run,AgentWebhookSubscribeInput(self.endpoint,cursor(1,self.run)))
  self.assertEqual(e.exception.code,'AGENT_WEBHOOK_SUBSCRIPTION_CONFLICT')
