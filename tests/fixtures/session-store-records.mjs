export function records(suffix='a',tenant='tenant-a'){
 const at='2026-10-18T00:00:00.000Z',sessionId='ses_'+suffix,operationId='op_'+suffix;
 return {sessions:[{sessionId,tenant,region:'test',state:'creating',createdAt:at,version:null,reserved:true,operationId,ttlSeconds:900,readyAt:null,expiresAt:null,closeReason:null,closeAttempts:0,releaseOperationId:null}],operations:[{tenant,operation:{operationId,sessionId,kind:'create-session',status:'pending',createdAt:at,updatedAt:at,error:null}}],bindings:[{tenant,keyHash:suffix.charCodeAt(0).toString(16).padStart(64,'0'),fingerprint:'b'.repeat(64),defaults:{region:'test',ttlSeconds:900},operationId}]};
}
