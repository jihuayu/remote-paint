import {createAgentDownloadHttpSink} from './agent-download-http.mjs';
import {createScreenshotHttpSink} from './agent-screenshot-http.mjs';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {SessionRegistry,SessionApiError} from './session-registry.mjs';
import {ViewerAccess} from './viewer-access.mjs';
import {AGENT_HTTP_SCOPES,agentHttpRoute,createAgentHttpAccess,handleAgentHttp,agentHttpError} from './agent-http.mjs';

const SCOPES=new Set(['sessions:create','sessions:read','sessions:release','viewers:read','viewers:control',...AGENT_HTTP_SCOPES]);
const ERRORS={
 INVALID_REQUEST:[400,'Invalid request'],INVALID_URL:[400,'Invalid initial page URL'],INVALID_TENANT:[401,'Invalid authenticated tenant'],
 INVALID_TTL:[400,'TTL is outside the configured range'],UNSUPPORTED_REGION:[400,'Requested region is unavailable'],
 INVALID_IDEMPOTENCY_KEY:[400,'Expected a bounded printable idempotency key'],IDEMPOTENCY_CONFLICT:[409,'Idempotency key is already bound to another request'],
 SESSION_NOT_FOUND:[404,'Session not found'],OPERATION_NOT_FOUND:[404,'Operation not found'],SESSION_QUOTA:[429,'Concurrent Session quota reached'],
 REGISTRY_CAPACITY:[503,'Operation retention capacity reached'],REGISTRY_CLOSED:[503,'Session service is unavailable'],
 REGISTRY_STORAGE_UNAVAILABLE:[503,'Session state confirmation is unavailable'],REGISTRY_WRITE_IN_PROGRESS:[503,'Session state is being committed'],
 SESSION_CLEANUP_LIMIT:[503,'Resource cleanup requires reconciliation'],
 SESSION_NOT_READY:[409,'Session is not available'],SESSION_EXPIRED:[410,'Session has expired'],
 INVALID_VIEWER_GRANT:[400,'Invalid Viewer grant'],VIEWER_GRANT_NOT_FOUND:[404,'Viewer grant not found'],
 VIEWER_CAPACITY:[429,'Viewer grant capacity reached'],VIEWER_NOT_CONFIGURED:[503,'Viewer access is unavailable'],
 UNAUTHENTICATED:[401,'A valid backend API key is required'],FORBIDDEN:[403,'API key does not permit this operation'],
 AUTHENTICATION_UNAVAILABLE:[503,'Authentication is unavailable'],MANAGEMENT_ORIGIN_FORBIDDEN:[403,'Management API requires a backend caller'],
 REQUEST_TOO_LARGE:[413,'Request body exceeds the configured limit'],UNSUPPORTED_MEDIA_TYPE:[415,'Expected uncompressed application/json with UTF-8 encoding'],
 REQUEST_TIMEOUT:[408,'Request deadline exceeded'],SERVICE_BUSY:[503,'Concurrent request limit reached'],
 METHOD_NOT_ALLOWED:[405,'Method not allowed'],ROUTE_NOT_FOUND:[404,'Route not found'],INTERNAL_ERROR:[500,'Session request failed']
};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const tenant=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const key=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{32,256}$/.test(v);
const fail=code=>{throw new SessionApiError(code,ERRORS[code][1],ERRORS[code][0]);};
function data(object,name){return object&&typeof object==='object'?Object.getOwnPropertyDescriptor(object,name)?.value:undefined;}
function identity(value){
 const tenantId=data(value,'tenantId'),scopes=data(value,'scopes');
 if(!tenant(tenantId)||!Array.isArray(scopes)||scopes.length>SCOPES.size||scopes.some(v=>!SCOPES.has(v)))fail('AUTHENTICATION_UNAVAILABLE');
 return {tenantId,scopes:new Set(scopes)};
}
// Optional fixed configuration resolver. Store only hashes in the returned closure;
// callers can supply their own trusted resolver for live key rotation/revocation.
export function createApiKeyAuthenticator(credentials){
 if(!Array.isArray(credentials)||!credentials.length||credentials.length>10000)throw new TypeError('Configure explicit backend API credentials');
 const entries=new Map();
 for(const row of credentials){
  const apiKey=data(row,'apiKey');if(!key(apiKey))throw new TypeError('Invalid backend API credential');
  let principal;try{principal=identity(row);}catch{throw new TypeError('Invalid backend API principal');}
  const hash=createHash('sha256').update(apiKey).digest('hex');if(entries.has(hash))throw new TypeError('Duplicate backend API credential');
  entries.set(hash,{tenantId:principal.tenantId,scopes:[...principal.scopes]});
 }
 return ({token})=>{if(!key(token))return null;const row=entries.get(createHash('sha256').update(token).digest('hex'));return row?{tenantId:row.tenantId,scopes:[...row.scopes]}:null;};
}
function header(req,name){
 const values=[];for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)values.push(req.rawHeaders[i+1]);
 if(values.length>1)fail('INVALID_REQUEST');return values[0];
}
function confirmed(registry){const state=registry.persistence();if(state.mode!=='durable'||state.confirmation!=='confirmed')fail('REGISTRY_STORAGE_UNAVAILABLE');}
function send(res,requestId,status,value,headers={}){
 if(res.destroyed||res.writableEnded)return;if(res.headersSent){res.destroy();return;}
 const body=JSON.stringify({...value,requestId});
 res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store',
  'x-content-type-options':'nosniff','x-request-id':requestId,'connection':'close',...headers});res.end(body);
}
function aborted(signal){if(signal.aborted)throw signal.reason;}
function wait(value,signal){
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(value).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  if(signal.aborted)abort();
 });
}
function body(req,maxBytes,signal){
 return new Promise((resolve,reject)=>{
  let size=0;const chunks=[];
  const cleanup=()=>{req.off('data',chunk);req.off('end',end);req.off('error',error);signal.removeEventListener('abort',abort);};
  const error=value=>{cleanup();req.pause();reject(value);},abort=()=>error(signal.reason);
  const chunk=value=>{size+=value.length;if(size>maxBytes){error(new SessionApiError('REQUEST_TOO_LARGE','Request too large',413));return;}chunks.push(value);};
  const end=()=>{cleanup();try{resolve(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size))));}catch{reject(new SessionApiError('INVALID_REQUEST','Invalid JSON request',400));}};
  req.on('data',chunk);req.once('end',end);req.once('error',error);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 });
}
function route(req){
 const path=req.url;
 if(typeof path!=='string'||path.length>2048||/[?#%]/.test(path))fail('ROUTE_NOT_FOUND');
 const agent=agentHttpRoute(path);if(agent)return agent;
 let match;
 if(path==='/v1/sessions')return {method:'POST',scope:'sessions:create',kind:'create'};
 if((match=/^\/v1\/sessions\/(ses_[A-Za-z0-9_-]{1,124})\/viewer-tickets$/.exec(path)))return {method:'POST',scope:'viewers:read',kind:'viewer-issue',id:match[1]};
 if((match=/^\/v1\/sessions\/(ses_[A-Za-z0-9_-]{1,124})\/viewer-tickets\/(vgr_[a-f0-9-]{36})(\/refresh)?$/.exec(path)))return {method:match[3]?'POST':'DELETE',scope:'viewers:read',kind:match[3]?'viewer-refresh':'viewer-revoke',id:match[1],grantId:match[2]};
 if((match=/^\/v1\/sessions\/(ses_[A-Za-z0-9_-]{1,124})$/.exec(path)))return {method:req.method==='DELETE'?'DELETE':'GET',scope:req.method==='DELETE'?'sessions:release':'sessions:read',kind:req.method==='DELETE'?'release':'session',id:match[1],allow:'GET, DELETE'};
 if((match=/^\/v1\/operations\/(op_[A-Za-z0-9_-]{1,125})$/.exec(path)))return {method:'GET',scope:'sessions:read',kind:'operation',id:match[1]};
 fail('ROUTE_NOT_FOUND');
}

// An unbound backend HTTP server. The caller owns TLS/proxy binding, ledger,
// Registry recovery and shutdown. Disconnection never cancels accepted creation.
// HTTP options follow Node22: https://r2.nodejs.org/docs/latest-jod/api/http.html
export function createSessionControlServer({registry,authenticate,viewerAccess=null,agentExecutor=null,maxBodyBytes=16384,maxAgentBodyBytes=32768,maxConcurrentRequests=64,maxAgentEndRequests=8,requestTimeoutMs=10000}={}){
 if(!(registry instanceof SessionRegistry)||typeof authenticate!=='function')throw new TypeError('Configure an explicit Registry and trusted authenticator');
 if(viewerAccess!==null&&(!(viewerAccess instanceof ViewerAccess)||!viewerAccess.usesRegistry(registry)))throw new TypeError('Viewer access must use this Registry');
 const agentAccess=createAgentHttpAccess(agentExecutor,registry);
 if(!integer(maxBodyBytes,128,1048576)||!integer(maxAgentBodyBytes,128,32768)||!integer(maxConcurrentRequests,1,10000)||!integer(maxAgentEndRequests,1,256)||!integer(requestTimeoutMs,50,60000))throw new TypeError('Invalid HTTP request bounds');
 confirmed(registry);let active=0,activeEnds=0,authenticating=0,authenticatingEnds=0;
 const handle=async(req,res)=>{
  const requestId='req_'+randomUUID();let held=false,controller,timer,onAbort,onClose,selected,screenshotSink,downloadSink;
  try{
   if(req.rawHeaders.length>128)fail('INVALID_REQUEST');
   if(header(req,'origin')!==undefined)fail('MANAGEMENT_ORIGIN_FORBIDDEN');
   if(header(req,'expect')!==undefined)fail('INVALID_REQUEST');
   selected=route(req);const priority=selected.kind==='agent-end'&&req.method===selected.method;
   if(priority){if(activeEnds>=maxAgentEndRequests)fail('SERVICE_BUSY');activeEnds++;held='end';}
   else{if(active>=maxConcurrentRequests)fail('SERVICE_BUSY');active++;held='ordinary';}
   controller=new AbortController();const {signal}=controller;
   timer=setTimeout(()=>controller.abort(new SessionApiError('REQUEST_TIMEOUT','Request deadline exceeded',408)),requestTimeoutMs);timer.unref();
   onAbort=()=>controller.abort(new SessionApiError('INVALID_REQUEST','Request disconnected',400));onClose=()=>{if(!res.writableFinished)onAbort();};
   req.once('aborted',onAbort);res.once('close',onClose);req.on('error',onAbort);
   if(req.method!==selected.method){res.setHeader('allow',selected.allow??selected.method);fail('METHOD_NOT_ALLOWED');}
   const length=header(req,'content-length'),transfer=header(req,'transfer-encoding'),encoding=header(req,'content-encoding'),contentType=header(req,'content-type');
   if(length!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(length)||!Number.isSafeInteger(Number(length))))fail('INVALID_REQUEST');
   const bodyLimit=selected.agent?maxAgentBodyBytes:maxBodyBytes;
   if(length!==undefined&&Number(length)>bodyLimit)fail('REQUEST_TOO_LARGE');
   const needsBody=selected.agent?selected.needsBody:['create','viewer-issue','viewer-refresh'].includes(selected.kind);
   if(!needsBody&&(transfer!==undefined||Number(length??0)!==0))fail('INVALID_REQUEST');
   if(needsBody&&(encoding!==undefined||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType??'')))fail('UNSUPPORTED_MEDIA_TYPE');
   const authorization=header(req,'authorization'),match=/^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(authorization??'');if(!match)fail('UNAUTHENTICATED');
   let authenticated;
   if(priority?authenticatingEnds>=maxAgentEndRequests:authenticating>=maxConcurrentRequests)fail('SERVICE_BUSY');
   if(priority)authenticatingEnds++;else authenticating++;
   const attempt=Promise.resolve().then(()=>{aborted(signal);return authenticate({token:match[1],signal});});
   const authDone=()=>{if(priority)authenticatingEnds--;else authenticating--;};void attempt.then(authDone,authDone);
   try{authenticated=await wait(attempt,signal);}catch(error){if(signal.aborted)throw signal.reason;fail('AUTHENTICATION_UNAVAILABLE');}
   aborted(signal);if(authenticated===null||authenticated===undefined)fail('UNAUTHENTICATED');const principal=identity(authenticated);
   if(!principal.scopes.has(selected.scope))fail('FORBIDDEN');confirmed(registry);
   if(selected.agent){
    const needsKey=['agent-create','agent-invocations'].includes(selected.kind),idempotencyKey=needsKey?header(req,'idempotency-key'):undefined;
    if(needsKey&&(typeof idempotencyKey!=='string'||!/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)))fail('INVALID_IDEMPOTENCY_KEY');
    const input=needsBody?await body(req,bodyLimit,signal):undefined;aborted(signal);confirmed(registry);
    if(selected.kind==='agent-screenshot-downloads'){if(header(req,'range')!==undefined||header(req,'if-range')!==undefined)fail('INVALID_REQUEST');screenshotSink=createScreenshotHttpSink(res,requestId,signal);}
    if(selected.kind==='agent-download-files'){if(header(req,'range')!==undefined||header(req,'if-range')!==undefined)fail('INVALID_REQUEST');downloadSink=createAgentDownloadHttpSink(res,requestId,signal);}
    const response=await handleAgentHttp({selected,principal,input,idempotencyKey,access:agentAccess,registry,wait,signal,screenshotSink:screenshotSink?{start:screenshotSink.start,write:screenshotSink.write,finish:screenshotSink.finish}:undefined,downloadSink:downloadSink?{start:downloadSink.start,write:downloadSink.write,finish:downloadSink.finish}:undefined});if(response.binary)return;
    send(res,requestId,response.status,{data:response.data},response.location?{location:response.location}:{});return;
   }
   let result;
   if(selected.kind==='create'){
    const idempotencyKey=header(req,'idempotency-key');if(typeof idempotencyKey!=='string'||!/^[\x21-\x7e]{1,128}$/.test(idempotencyKey))fail('INVALID_IDEMPOTENCY_KEY');
    const input=await body(req,maxBodyBytes,signal);aborted(signal);confirmed(registry);
    result=registry.create(principal.tenantId,input,{idempotencyKey});
   }else if(selected.kind.startsWith('viewer-')){
    if(!viewerAccess)fail('VIEWER_NOT_CONFIGURED');
    const input=needsBody?await body(req,maxBodyBytes,signal):{};aborted(signal);confirmed(registry);
    if(!input||Object.getPrototypeOf(input)!==Object.prototype||Object.keys(input).some(k=>!(selected.kind==='viewer-issue'?['role','audience','ttlSeconds']:['ttlSeconds']).includes(k)))fail('INVALID_VIEWER_GRANT');
    const args={tenantId:principal.tenantId,sessionId:selected.id,grantId:selected.grantId};
    const role=selected.kind==='viewer-issue'?input.role:viewerAccess.get(args).role;
    if(role==='controller'&&!principal.scopes.has('viewers:control'))fail('FORBIDDEN');
    result=selected.kind==='viewer-issue'?viewerAccess.issue({tenantId:principal.tenantId,sessionId:selected.id,...input}):selected.kind==='viewer-refresh'?viewerAccess.refresh({...args,...input}):viewerAccess.revoke(args);
   }else{
    aborted(signal);
    result=selected.kind==='session'?registry.getSession(principal.tenantId,selected.id):selected.kind==='operation'?registry.getOperation(principal.tenantId,selected.id):registry.release(principal.tenantId,selected.id);
   }
   const operation=selected.kind==='create'||selected.kind==='release';
   send(res,requestId,operation&&result.status==='pending'?202:200,{data:result},operation?{location:'/v1/operations/'+result.operationId}:{});
  }catch(error){
   const agentError=selected?.agent?agentHttpError(error):null;
   if(agentError)send(res,requestId,agentError.status,{error:{code:agentError.code,message:agentError.message,outcome:agentError.outcome}});
   else{const code=error instanceof SessionApiError&&Object.hasOwn(ERRORS,error.code)?error.code:'INTERNAL_ERROR',entry=ERRORS[code];send(res,requestId,entry[0],{error:{code,message:entry[1]}});}
  }finally{
   if(screenshotSink)await screenshotSink.cleanup();
   if(downloadSink)await downloadSink.cleanup();
   if(timer)clearTimeout(timer);if(onAbort){req.off('aborted',onAbort);req.off('error',onAbort);res.off('close',onClose);}
   if(held==='end')activeEnds--;else if(held)active--;
  }
 };
 const server=createServer({maxHeaderSize:16384,headersTimeout:requestTimeoutMs,requestTimeout:requestTimeoutMs,connectionsCheckingInterval:1000,keepAliveTimeout:1000},(req,res)=>{void handle(req,res);});
 server.maxHeadersCount=64;server.maxRequestsPerSocket=1;server.maxConnections=Math.min(20000,(maxConcurrentRequests+maxAgentEndRequests)*2);
 server.on('checkContinue',(req,res)=>{void handle(req,res);});server.on('checkExpectation',(req,res)=>{void handle(req,res);});
 server.on('upgrade',(req,socket,head)=>{if(viewerAccess)viewerAccess.handleUpgrade(req,socket,head);else socket.destroy();});server.on('connect',(req,socket)=>socket.destroy());
 server.once('close',()=>viewerAccess?.close());
 return server;
}
