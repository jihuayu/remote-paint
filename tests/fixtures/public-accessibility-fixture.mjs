import {randomUUID} from 'node:crypto';
import {AgentRpcError} from '../../service/agent-rpc.mjs';
import {httpObservationFixture,tenantId} from './public-observation-fixture.mjs';
export {tenantId};
export async function accessibilityFixture(t,options={}){
 const h=await httpObservationFixture(t,options);let elementId=null,revision=0;
 h.hooks.observe=(req,writer)=>{const result=h.reply(req,writer);elementId=result.nodes[0].elementId;return result;};
 const axReply=(req,writer)=>{const ctx=h.readContext(req,writer);if(['binding','document'].some(k=>Object.keys(ctx[k]).some(f=>ctx[k][f]!==req.command.context[k][f])))throw new AgentRpcError('STALE_AGENT_PAGE','not-dispatched');if(req.command.elementId!==elementId)throw new AgentRpcError('STALE_AGENT_ELEMENT','not-dispatched');let budget=req.command.limits.maxChars,truncated=false;const text=v=>{const result=v.slice(0,budget);if(result.length<v.length)truncated=true;budget-=result.length;return result;};return {stage:'accessibility-observed',...ctx,observationId:'obs_'+randomUUID(),revision:++revision,observedAt:new Date().toISOString(),version:req.version,scope:'main-document-element-accessibility',elementId,limits:req.command.limits,url:'https://fixture.example/order/42',title:'Fixture',ax:{ignored:false,role:'textbox',name:text('private-computed-AX-name'),description:text('private-computed-AX-description'),value:text('private-computed-AX-value'),states:{readonly:true,required:true}},redacted:false,truncated};};
 h.hooks['observe-ax']=axReply;return {...h,axReply};
}
export const axPath=id=>'/v1/agent-runs/'+id+'/accessibility-observations';
