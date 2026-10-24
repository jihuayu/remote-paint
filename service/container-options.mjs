export function containerOptions(env=process.env){
 const port=(name,fallback)=>{
  const text=env[name]??String(fallback);
  if(typeof text!=='string'||!/^\d{1,5}$/.test(text)||Number(text)<1||Number(text)>65535)throw new TypeError(`Invalid ${name}`);
  return Number(text);
 };
 const ports={port:port('REMOTE_PAINT_PORT',4176),nativePort:port('REMOTE_PAINT_WS_PORT',4177),cdpPort:port('REMOTE_PAINT_CDP_PORT',9222)};
 if(new Set(Object.values(ports)).size!==3)throw new TypeError('Server ports must be distinct');
 const url=env.REMOTE_PAINT_URL??'about:blank';
 const parsed=new URL(url);
 if(!['http:','https:'].includes(parsed.protocol)&&parsed.href!=='about:blank')throw new TypeError('Expected an HTTP(S) page or about:blank');
 return {...ports,url,host:'127.0.0.1'};
}
