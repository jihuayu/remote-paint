// Structural controller facts only; these are not actual Engine observations.
import {runtime} from './runtime-witness-records.mjs';
export function retirement({requested=true,unstarted=false}={}){
 const {plan,inspection}=runtime(),containerId=requested?inspection.document.Id:null,at='2026-10-19T00:00:00.000Z';
 const closing={revision:7,allocation:{sessionId:plan.sessionId,tenant:plan.tenantId,region:plan.region,deploymentId:plan.deploymentId,daemonId:plan.daemonId,ownerKeyHash:plan.ownerKeyHash,specDigest:plan.specDigest,imageId:plan.imageId,containerName:plan.containerName,containerId,state:'closing',requestStarted:requested,version:null,closeReason:'released',retirement:null,createdAt:at,updatedAt:at}};
 if(unstarted)inspection.document.State={Status:'created',Running:false,Pid:0,StartedAt:'0001-01-01T00:00:00Z'};
 return {plan,closing,inspection,startDispatched:unstarted?false:true,removal:{kind:'remove',containerId,daemonId:plan.daemonId,connectionId:'11111111-2222-4333-8444-555555555555',httpStatus:204,authorizationRevision:7,effectAttempted:true,alreadyAbsent:false},absence:{found:false,daemon:{id:plan.daemonId},selector:containerId}};
}
