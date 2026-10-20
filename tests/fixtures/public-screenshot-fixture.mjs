import {randomUUID} from 'node:crypto';
import {AgentRpcError} from '../../service/agent-rpc.mjs';
import {createAgentScreenshotOwner} from '../../live/agent-screenshot.mjs';
import {httpObservationFixture,tenantId} from './public-observation-fixture.mjs';
import {screenshotPng} from './agent-screenshot-fixture.mjs';
export {tenantId};
export const shotPath=(id,kind='observations')=>'/v1/agent-runs/'+id+'/screenshot-'+kind;
export async function screenshotFixture(t,options={}){const h=await httpObservationFixture(t,options),owner=createAgentScreenshotOwner();let png=screenshotPng(),revision=0;
 const context=(req,writer)=>{const ctx=h.readContext(req,writer);if(['binding','document'].some(k=>Object.keys(ctx[k]).some(f=>ctx[k][f]!==req.command.context[k][f])))throw new AgentRpcError('STALE_AGENT_PAGE','not-dispatched');return ctx;};
 const screenshotReply=(req,writer)=>{const ctx=context(req,writer);if(png.length>req.command.limits.maxBytes)throw new AgentRpcError('AGENT_OBSERVATION_LIMIT','not-dispatched');return owner.retain(png,{stage:'screenshot-observed',...ctx,observationId:'obs_'+randomUUID(),revision:++revision,observedAt:new Date().toISOString(),version:req.version,scope:'main-frame-viewport-source-pixels',limits:req.command.limits,url:'https://fixture.example/private-screenshot',title:'Private screenshot',truncated:false,screenshotId:'shot_'+randomUUID(),mimeType:'image/png',width:png.readUInt32BE(16),height:png.readUInt32BE(20)});};
 const chunkReply=(req,writer)=>owner.read(req.command,context(req,writer));
 h.hooks['observe-screenshot']=screenshotReply;h.hooks['read-screenshot']=chunkReply;h.hooks['release-screenshot']=(req,writer)=>owner.release(req.command.screenshotId,context(req,writer));h.hooks.end=(_req,writer)=>{owner.close();h.contexts.delete(writer.binding.sessionId);return {stage:'run-closed',binding:writer.binding};};
 return {...h,screenshotReply,chunkReply,owner,get png(){return png;},set png(value){png=value;}};
}
export const downloadReference=(context,shot)=>({context,screenshotId:shot.screenshotId,sha256:shot.sha256,byteLength:shot.byteLength,observedAt:shot.observedAt});
