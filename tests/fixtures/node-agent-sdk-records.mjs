export const uuid=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
export const sessionId='ses_'+uuid(1),agentRunId='arun_'+uuid(2),invocationId='ainv_'+uuid(3),at='2026-10-20T00:00:00.000Z',requestId='req_fixture';
export const context=()=>({agentRunId,binding:{tenantId:'sdk-tenant',sessionId,targetId:'target_'+uuid(4),runId:'run_'+uuid(5)},fence:{controlSessionId:uuid(6),controlVersion:0,pageEpoch:1,viewportVersion:1}});
export const run=(patch={})=>({agentRunId,sessionId,region:'test',version:'sdk-v1',state:'active',holdsWriter:true,beginDispatch:'confirmed',endDispatch:'not-requested',createdAt:at,updatedAt:at,error:null,...patch});
export const invocation=(patch={})=>({invocationId,agentRunId,sessionId,tool:'insertText',fence:context().fence,state:'injected',dispatchStarted:true,receipt:{stage:'input-injected',inputs:1},error:null,createdAt:at,updatedAt:at,...patch});
export function response(data,status=200,location=null,headers={}){return new Response(JSON.stringify({data,requestId}),{status,headers:{'content-type':'application/json','x-request-id':requestId,...(location?{location}:{}),...headers}});}
export const runResponse=(patch={},status=200)=>{const row=run(patch);return response(row,status,'/v1/agent-runs/'+row.agentRunId);};
export const invocationResponse=(patch={},status=200)=>{const row=invocation(patch);return response(row,status,'/v1/agent-invocations/'+row.invocationId);};
export const failure=(code,status=409,outcome,extra={})=>new Response(JSON.stringify({error:{code,message:'private transport message',...(outcome===undefined?{}:{outcome}),...extra},requestId}),{status,headers:{'content-type':'application/json','x-request-id':requestId}});
