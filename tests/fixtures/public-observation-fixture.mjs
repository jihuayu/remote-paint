import {randomUUID} from 'node:crypto';
import {fixture,tenantId} from './agent-executor-fixture.mjs';
import {AgentRpcError} from '../../service/agent-rpc.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../../service/session-http.mjs';
import {agentHttpClient} from './agent-http-client.mjs';
export {tenantId};
export async function observationFixture(t,options={}){
 const f=await fixture(t,options);let revision=0;
 const readContext=(request,writer)=>({binding:writer.binding,document:{controlSessionId:writer.fence.controlSessionId,pageEpoch:writer.fence.pageEpoch,viewportVersion:writer.fence.viewportVersion}});
 const reply=(request,writer)=>{const ctx=readContext(request,writer),expected=request.command.context;if(['binding','document'].some(k=>Object.keys(ctx[k]).some(field=>ctx[k][field]!==expected[k][field])))throw new AgentRpcError('STALE_AGENT_PAGE','not-dispatched');return {stage:'observed',...ctx,observationId:'obs_'+randomUUID(),revision:++revision,observedAt:new Date().toISOString(),version:request.version,scope:'main-document-light-dom',query:request.command.query,limits:request.command.limits,url:'https://fixture.example/order/42',title:'Fixture',nodes:[{elementId:'elh_'+randomUUID(),tag:'span',id:'status',role:'status',name:'',text:'private-observation-DOM',value:null,redacted:false}],visited:1,truncated:false};};
 f.hooks['observation-context']=readContext;f.hooks.observe=reply;return {...f,readContext,reply};
}
export async function httpObservationFixture(t,{http={},authenticate=null,executorOptions={},storeOptions={}}={}){
 const f=await observationFixture(t,{executorOptions,storeOptions}),sockets=new Set(),keys=Object.fromEntries(['all','observe','read','write','end','session','other'].map(n=>[n,'public-observation-'+n+'-'+'a'.repeat(40)])),all=['agents:read','agents:write','agents:end','agents:observe'],credentials=[{apiKey:keys.all,tenantId,scopes:all},{apiKey:keys.observe,tenantId,scopes:['agents:observe']},{apiKey:keys.read,tenantId,scopes:['agents:read']},{apiKey:keys.write,tenantId,scopes:['agents:write']},{apiKey:keys.end,tenantId,scopes:['agents:end']},{apiKey:keys.session,tenantId,scopes:['sessions:create','sessions:read','sessions:release','viewers:read','viewers:control']},{apiKey:keys.other,tenantId:'foreign',scopes:all}],server=createSessionControlServer({registry:f.registry,agentExecutor:f.executor,authenticate:authenticate??createApiKeyAuthenticator(credentials),...http});server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{for(const s of sockets)s.destroy();server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));});const base='http://127.0.0.1:'+server.address().port,api=(role,...args)=>agentHttpClient(base,keys[role])(...args);return {...f,server,sockets,keys,base,api};
}
export const paths={context:id=>'/v1/agent-runs/'+id+'/observation-context',observations:id=>'/v1/agent-runs/'+id+'/observations'};
