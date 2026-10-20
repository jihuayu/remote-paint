import {createServer} from 'node:http';
import {prepareViewerAssets} from '../live/viewer-assets.mjs';
import {acceptsGzip} from '../live/static-assets.mjs';
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
function origin(value){
 if(typeof value!=='string'||value.length>2048)throw new TypeError('Configure exact Viewer Origins');
 let url;try{url=new URL(value);}catch{throw new TypeError('Configure exact Viewer Origins');}
 if(url.origin!==value||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new TypeError('Configure exact HTTPS or loopback Origins');return value;
}

// Dedicated public assets only. The caller owns listener/TLS and the separate
// backend API/data gateway. This server never resolves or allocates a Source.
export async function createPublicViewerServer({gatewayOrigin,allowedParentOrigins,preparedAssets,requestTimeoutMs=10000,maxConnections=64}={}){
 const gateway=origin(gatewayOrigin);
 if(!Array.isArray(allowedParentOrigins)||allowedParentOrigins.length>32||!integer(requestTimeoutMs,50,60000)||!integer(maxConnections,1,1024))throw new TypeError('Configure bounded Viewer assets and an explicit parent allowlist');
 const parents=allowedParentOrigins.map(origin);
 if(new Set(parents).size!==parents.length||Buffer.byteLength(gateway+parents.join(''))>8192)throw new TypeError('Invalid parent Origin allowlist');
 const assets=await(preparedAssets??prepareViewerAssets({mode:'public'}));
 if(assets?.mode!=='public'||typeof assets.get!=='function'||!/^[a-f0-9]{64}$/.test(assets.build??'')||!assets.get('/')?.bytes?.includes(Buffer.from('<meta name="remote-paint-mode" content="public">')))throw new TypeError('Use prepared public Viewer assets');
 const config=Buffer.from(JSON.stringify({schema:'public-viewer-v1',gatewayOrigin:gateway,allowedParentOrigins:parents,viewerBuild:assets.build}));
 const socketOrigin=gateway.replace(/^https:/,'wss:').replace(/^http:/,'ws:');
 const csp=`default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ${socketOrigin}; style-src 'self'; img-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${parents.length?parents.join(' '):"'none'"}`;
 const server=createServer({maxHeaderSize:16384,headersTimeout:requestTimeoutMs,requestTimeout:requestTimeoutMs,connectionsCheckingInterval:1000,keepAliveTimeout:1000},(req,res)=>{
  const finish=(status,bytes)=>{res.writeHead(status);res.end(req.method==='HEAD'?undefined:bytes);};
  try{
   res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('Content-Security-Policy',csp);res.setHeader('Connection','close');
   const path=req.url;
   if(typeof path!=='string'||path.length>2048||!/^\/[A-Za-z0-9_./-]*$/.test(path)||req.headers['transfer-encoding']!==undefined||req.headers['content-length']!==undefined&&req.headers['content-length']!=='0'){finish(404);return;}
   if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');finish(405);return;}
   if(path==='/viewer-config'){res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Content-Length',config.length);finish(200,config);return;}
   const asset=assets.get(path);if(!asset){finish(404);return;}
   if(asset.expired){finish(410,Buffer.from('Viewer asset version expired; reload the Viewer'));return;}
   const compressed=asset.gzip&&acceptsGzip(req.headers['accept-encoding']),bytes=compressed?asset.gzip:asset.bytes,etag=compressed?asset.gzipEtag:asset.etag;
   if(path!=='/')res.setHeader('Cache-Control',asset.immutable?'public, max-age=31536000, immutable':'no-cache');
   res.setHeader('ETag',etag);res.setHeader('Vary','Accept-Encoding');res.setHeader('Content-Type',asset.type);
   if(path!=='/'&&String(req.headers['if-none-match']??'').split(',').some(value=>value.trim()==='*'||value.trim().replace(/^W\//,'')===etag)){finish(304);return;}
   if(compressed)res.setHeader('Content-Encoding','gzip');res.setHeader('Content-Length',bytes.length);finish(200,bytes);
  }catch{if(!res.headersSent)res.writeHead(500);res.end();}
 });
 server.maxHeadersCount=64;server.maxRequestsPerSocket=1;server.maxConnections=maxConnections;
 server.on('upgrade',(_req,socket)=>socket.destroy());server.on('connect',(_req,socket)=>socket.destroy());
 return server;
}
