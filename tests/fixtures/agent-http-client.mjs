// Test consumer of the public HTTP contract, not a shipped Agent SDK.
export const agentPaths=Object.freeze({run:id=>'/v1/agent-runs/'+id,context:id=>'/v1/agent-runs/'+id+'/context',invocations:id=>'/v1/agent-runs/'+id+'/invocations',invocation:id=>'/v1/agent-invocations/'+id,end:id=>'/v1/agent-runs/'+id+'/end',create:id=>'/v1/sessions/'+id+'/agent-runs'});
export function agentHttpClient(base,token){
 return async function request(method,path,{data,idempotencyKey,headers={},signal}={}){
  const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,...(data===undefined?{}:{'content-type':'application/json'}),...(idempotencyKey===undefined?{}:{'idempotency-key':idempotencyKey}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:signal??AbortSignal.timeout(5000)});return {status:response.status,headers:Object.fromEntries(response.headers),body:await response.json()};
 };
}
