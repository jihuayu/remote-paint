import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createAgentDownloadOwner} from '../../live/agent-download.mjs';
import {AgentRpcError} from '../../service/agent-rpc.mjs';
import {httpObservationFixture,tenantId} from './public-observation-fixture.mjs';
export {tenantId};
export const downloadPath=(id,kind='arms')=>'/v1/agent-runs/'+id+'/download-'+kind;
export const downloadReference=(context,file)=>({context,downloadId:file.downloadId,sha256:file.sha256,byteLength:file.byteLength,completedAt:file.completedAt});
export async function downloadFixture(t,options={}){const h=await httpObservationFixture(t,options),page=Object.assign(new EventEmitter(),{isClosed:()=>false});let owner=null,ownerRunId=null,lastPath=null;
 const context=(req,writer)=>{if(!writer||h.contexts.get(req.sessionId)!==writer||writer.binding.runId!==req.command.runId)throw new AgentRpcError('AGENT_RUN_NOT_FOUND','not-dispatched');const ctx=h.readContext(req,writer);if(['binding','document'].some(k=>Object.keys(ctx[k]).some(f=>ctx[k][f]!==req.command.context[k][f])))throw new AgentRpcError('STALE_AGENT_PAGE','not-dispatched');return ctx;};
 const armReply=(req,writer)=>{const ctx=context(req,writer);if(!owner){owner=createAgentDownloadOwner({page,binding:writer.binding,version:req.version});ownerRunId=writer.binding.runId;}return owner.arm(ctx,{limits:req.command.limits},()=>{if(ownerRunId!==writer.binding.runId)throw new AgentRpcError('AGENT_RUN_NOT_FOUND','not-dispatched');context(req,writer);});};
 const infoReply=(req,writer)=>{const ctx=context(req,writer);if(!owner)throw new AgentRpcError('STALE_AGENT_DOWNLOAD','not-dispatched');return owner.info(req.command.downloadId,ctx);};
 const chunkReply=(req,writer)=>{const ctx=context(req,writer);if(!owner)throw new AgentRpcError('STALE_AGENT_DOWNLOAD','not-dispatched');return owner.read(req.command,ctx);};
 const releaseReply=(req,writer)=>{const ctx=context(req,writer);if(!owner)throw new AgentRpcError('STALE_AGENT_DOWNLOAD','not-dispatched');return owner.release(req.command.downloadId,ctx);};
 h.hooks['arm-download']=armReply;h.hooks['download-info']=infoReply;h.hooks['read-download']=chunkReply;h.hooks['release-download']=releaseReply;h.hooks.end=async(_req,writer)=>{await owner?.close();owner=null;ownerRunId=null;h.contexts.delete(writer.binding.sessionId);return {stage:'run-closed',binding:writer.binding};};t.after(()=>owner?.close());
 async function emit(bytes=Buffer.from([0,255,128,1,9]),name='report.bin'){const path=join(h.directory,'download-'+randomUUID());await writeFile(path,bytes);lastPath=path;page.emit('download',{page:()=>page,path:async()=>path,cancel:async()=>{},delete:async()=>{},suggestedFilename:()=>name});}
 return {...h,page,armReply,infoReply,chunkReply,releaseReply,emit,get lastPath(){return lastPath;}};
}
