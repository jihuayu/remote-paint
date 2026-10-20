"""Concurrent line-RPC test adapter; all Agent HTTP uses the installed Python SDK."""
from __future__ import annotations
import asyncio
from dataclasses import asdict, is_dataclass
import json
from pathlib import Path
import sys
import remote_paint_session as sdk

_RENAME={'agent_run_id':'agentRunId','session_id':'sessionId','invocation_id':'invocationId','holds_writer':'holdsWriter','begin_dispatch':'beginDispatch','end_dispatch':'endDispatch','created_at':'createdAt','updated_at':'updatedAt','dispatch_started':'dispatchStarted','tenant_id':'tenantId','target_id':'targetId','run_id':'runId','control_session_id':'controlSessionId','control_version':'controlVersion','page_epoch':'pageEpoch','viewport_version':'viewportVersion','request_id':'requestId','element_id':'elementId','observation_id':'observationId','observed_at':'observedAt','max_nodes':'maxNodes','max_chars':'maxChars','max_visited':'maxVisited'}
def output(v):
 if is_dataclass(v):return output(asdict(v))
 if isinstance(v,dict):return {_RENAME.get(k,k):output(value)for k,value in v.items()}
 if isinstance(v,(tuple,list)):return [output(value)for value in v]
 return v

def writer(v):
 b,f=v['binding'],v['fence'];return sdk.AgentContext(sdk.AgentRunId(v['agentRunId']),sdk.AgentBinding(b['tenantId'],sdk.SessionId(b['sessionId']),b['targetId'],b['runId']),sdk.AgentFence(f['controlSessionId'],f['controlVersion'],f['pageEpoch'],f['viewportVersion']))
def context(v):
 b,d=v['binding'],v['document'];return sdk.AgentObservationContext(sdk.AgentRunId(v['agentRunId']),sdk.SessionId(v['sessionId']),v['version'],sdk.AgentBinding(b['tenantId'],sdk.SessionId(b['sessionId']),b['targetId'],b['runId']),sdk.AgentObservationDocument(d['controlSessionId'],d['pageEpoch'],d['viewportVersion']))
def query(v):
 if v.get('kind')=='snapshot':return sdk.AgentSnapshotQuery()
 if v.get('kind')=='locate':return sdk.AgentLocateQuery(v['by'],v['value'])
 if v.get('kind')=='element':return sdk.AgentElementQuery(sdk.AgentElementId(v['elementId']))
 return v # SDK type/schema rejection must happen before any HTTP.
def action(v):
 rename={'fromX':'from_x','fromY':'from_y','toX':'to_x','toY':'to_y','deltaX':'delta_x','deltaY':'delta_y','selectionStart':'selection_start','selectionEnd':'selection_end','windowsVirtualKeyCode':'windows_virtual_key_code','nativeVirtualKeyCode':'native_virtual_key_code'}
 result=dict(tool=v['tool'],params={rename.get(k,k):value for k,value in v['params'].items()})
 if 'rpcTimeoutMs'in v:result['rpc_timeout_ms']=v['rpcTimeoutMs']
 return result

def emit(value):print(json.dumps(value,ensure_ascii=True),flush=True)
async def main():
 clients={};tasks={}
 async def execute(command):
  rid=command['id'];op=command['op'];a=command.get('args',{});client=clients[command['role']]
  try:
   if op=='run-create':result=await client.runs.create(sdk.SessionId(a['sessionId']),sdk.CreateAgentRunInput(a['input']['region'],a['input']['version'],a['input'].get('rpcTimeoutMs')),idempotency_key=a['key'])
   elif op=='run-get':result=await client.runs.get(sdk.AgentRunId(a['id']))
   elif op=='context':result=await client.runs.context(sdk.AgentRunReference(sdk.AgentRunId(a['run']['agentRunId']),sdk.SessionId(a['run']['sessionId'])))
   elif op=='end':result=await client.runs.end(sdk.AgentRunId(a['id']))
   elif op=='invocation-create':result=await client.invocations.create(writer(a['context']),action(a['action']),idempotency_key=a['key'])
   elif op=='invocation-get':result=await client.invocations.get(sdk.AgentInvocationId(a['id']))
   elif op=='observation-context':result=await client.observations.context(sdk.AgentObservationReference(sdk.AgentRunId(a['run']['agentRunId']),sdk.SessionId(a['run']['sessionId']),a['run']['version']))
   elif op=='observe':
    v=a['input'];l=v.get('limits',{});result=await client.observations.read(context(a['context']),sdk.AgentObservationInput(query(v['query']),sdk.AgentObservationLimits(l.get('maxNodes',8),l.get('maxChars',1024),l.get('maxVisited',128)),v.get('rpcTimeoutMs')))
   elif op=='status':result=client.transport_status()
   else:raise AssertionError('Unknown test driver operation')
   emit({'id':rid,'value':output(result)})
  except (sdk.AgentClientError,sdk.AgentClientCancelledError)as error:
   emit({'id':rid,'error':{'code':error.code,'outcome':error.outcome,'status':getattr(error,'status',None)}})
 try:
  while line:=await asyncio.to_thread(sys.stdin.readline):
   command=json.loads(line);rid=command['id'];op=command['op']
   if op=='init':
    assert not clients;location=Path(sdk.__file__).resolve();assert location.is_relative_to(Path(sys.prefix).resolve());assert location.with_name('_observation.py').is_file();assert location.with_name('py.typed').is_file();clients={role:sdk.AgentClient(base_url=command['base'],api_key=key)for role,key in command['keys'].items()};emit({'id':rid,'value':{'module':str(location),'prefix':sys.prefix,'installedObservationSdk':True}})
   elif op=='cancel':
    task=tasks.get(command['args']['target']);
    if task is not None:task.cancel()
    emit({'id':rid,'value':{'cancelRequested':task is not None}})
   elif op=='close':
    assert not tasks;await asyncio.gather(*(client.aclose()for client in clients.values()));emit({'id':rid,'value':{'closed':True}});break
   else:
    assert rid not in tasks and len(tasks)<64;task=asyncio.create_task(execute(command));tasks[rid]=task;task.add_done_callback(lambda done,rid=rid:tasks.pop(rid,None))
 finally:
  for task in tasks.values():task.cancel()
  await asyncio.gather(*tuple(tasks.values()),return_exceptions=True);await asyncio.gather(*(client.aclose()for client in clients.values()))

if __name__=='__main__':asyncio.run(main())
