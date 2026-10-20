"""Line-RPC test driver. All Agent HTTP operations use the installed Python SDK."""
from __future__ import annotations
import asyncio
from dataclasses import asdict, is_dataclass
import json
from pathlib import Path
import sys
import remote_paint_session as sdk

_RENAME={'agent_run_id':'agentRunId','session_id':'sessionId','invocation_id':'invocationId','holds_writer':'holdsWriter','begin_dispatch':'beginDispatch','end_dispatch':'endDispatch','created_at':'createdAt','updated_at':'updatedAt','dispatch_started':'dispatchStarted','tenant_id':'tenantId','target_id':'targetId','run_id':'runId','control_session_id':'controlSessionId','control_version':'controlVersion','page_epoch':'pageEpoch','viewport_version':'viewportVersion','request_id':'requestId'}
def output(value):
 if is_dataclass(value):return output(asdict(value))
 if isinstance(value,dict):return {_RENAME.get(k,k):output(v)for k,v in value.items()}
 if isinstance(value,(list,tuple)):return [output(v)for v in value]
 return value

def ctx(v):
 b,f=v['binding'],v['fence'];return sdk.AgentContext(sdk.AgentRunId(v['agentRunId']),sdk.AgentBinding(b['tenantId'],sdk.SessionId(b['sessionId']),b['targetId'],b['runId']),sdk.AgentFence(f['controlSessionId'],f['controlVersion'],f['pageEpoch'],f['viewportVersion']))
def action(v):
 rename={'fromX':'from_x','fromY':'from_y','toX':'to_x','toY':'to_y','deltaX':'delta_x','deltaY':'delta_y','selectionStart':'selection_start','selectionEnd':'selection_end','windowsVirtualKeyCode':'windows_virtual_key_code','nativeVirtualKeyCode':'native_virtual_key_code'}
 result=dict(tool=v['tool'],params={rename.get(k,k):value for k,value in v['params'].items()})
 if 'rpcTimeoutMs'in v:result['rpc_timeout_ms']=v['rpcTimeoutMs']
 return result

async def main():
 clients={};prepared={};counter=0
 try:
  while line:=await asyncio.to_thread(sys.stdin.readline):
   command=json.loads(line);rid=command['id'];op=command['op']
   try:
    if op=='init':
     location=Path(sdk.__file__).resolve();assert location.is_relative_to(Path(sys.prefix).resolve());assert location.with_name('py.typed').is_file()
     clients={role:sdk.AgentClient(base_url=command['base'],api_key=key)for role,key in command['keys'].items()};result={'module':str(location),'prefix':sys.prefix,'publicAgentSdk':True}
    elif op=='close':
     await asyncio.gather(*(client.aclose()for client in clients.values()));result={'closed':True}
    else:
     client=clients[command['role']];a=command.get('args',{})
     if op=='run-create':result=await client.runs.create(sdk.SessionId(a['sessionId']),sdk.CreateAgentRunInput(a['input']['region'],a['input']['version'],a['input'].get('rpcTimeoutMs')),idempotency_key=a['key'])
     elif op=='run-get':result=await client.runs.get(sdk.AgentRunId(a['id']))
     elif op=='context':result=await client.runs.context(sdk.AgentRunReference(sdk.AgentRunId(a['run']['agentRunId']),sdk.SessionId(a['run']['sessionId'])))
     elif op=='end':result=await client.runs.end(sdk.AgentRunId(a['id']))
     elif op=='invocation-get':result=await client.invocations.get(sdk.AgentInvocationId(a['id']))
     elif op=='invocation-create':result=await client.invocations.create(ctx(a['context']),action(a['action']),idempotency_key=a['key'])
     elif op=='prepare':
      counter+=1;prepared[counter]=client.invocations.prepare_create(ctx(a['context']),action(a['action']),idempotency_key=a['key']);result={'handle':counter}
     elif op=='send':result=await prepared[a['handle']].send(retries=a.get('retries'))
     else:raise AssertionError('Unknown driver command')
    print(json.dumps({'id':rid,'value':output(result)},ensure_ascii=True),flush=True)
    if op=='close':break
   except (sdk.AgentClientError,sdk.AgentClientCancelledError)as error:
    print(json.dumps({'id':rid,'error':{'code':error.code,'outcome':error.outcome,'status':getattr(error,'status',None)}}),flush=True)
 finally:
  await asyncio.gather(*(client.aclose()for client in clients.values()))

if __name__=='__main__':asyncio.run(main())
