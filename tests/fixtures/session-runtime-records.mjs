import {createHash} from 'node:crypto';
export const provider={region:'test',deploymentId:'deployment-test',daemonId:'daemon-test',createdAt:'2026-10-18T00:00:00.000Z'};
export const privateOwner='fixture-private-owner-key-not-stored';
export function intent(batch){const s=batch.sessions[0];return {sessionId:s.sessionId,tenant:s.tenant,region:s.region,deploymentId:provider.deploymentId,daemonId:provider.daemonId,ownerKeyHash:createHash('sha256').update(privateOwner).digest('hex'),specDigest:'b'.repeat(64),imageId:'sha256:'+'c'.repeat(64),containerName:'remote-paint-'+s.sessionId.toLowerCase(),containerId:null,state:'intent',requestStarted:false,version:null,closeReason:null,retirement:null,createdAt:s.createdAt,updatedAt:s.createdAt};}
export const requested=r=>({...r,state:'requested',requestStarted:true});
export const created=r=>({...requested(r),state:'created',containerId:'d'.repeat(64)});
export const ready=r=>({...created(r),state:'ready',version:'fixture-native-v1'});
export const closing=r=>({...r,state:'closing',closeReason:'released'});
export const retired=r=>({...closing(r),state:'retired',retirement:{kind:r.requestStarted?'container-removed':'not-dispatched',evidenceSha256:'e'.repeat(64)}});
