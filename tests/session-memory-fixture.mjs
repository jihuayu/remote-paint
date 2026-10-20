// Test-only HTTP workload. No PNG buffers or closed Session objects are cached.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {PNG} from 'pngjs';
export async function startSessionMemoryFixture(){
 const sessions=new Map();let created=0,closed=false;
 const image=(session,n)=>{const png=new PNG({width:256,height:256});let state=((n+1)^Math.imul(session.number+1,2654435761))>>>0;
  for(let i=0;i<png.data.length;i+=4){state^=state<<13;state^=state>>>17;state^=state<<5;png.data[i]=state&255;png.data[i+1]=(state>>>8)&255;png.data[i+2]=(state>>>16)&255;png.data[i+3]=255;}png.data.set([n&255,(n>>8)&255,199,255]);return PNG.sync.write(png,{deflateLevel:1,filterType:0});};
 const html=session=>`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white;font:18px sans-serif}input{position:absolute;left:20px;top:20px;width:280px;height:36px}img{position:absolute;left:20px;top:80px;width:256px;height:256px}#marker,#cycle,#session{position:absolute;top:30px;width:24px;height:24px}#marker{left:340px;background:rgb(0,0,42)}#cycle{left:400px}#session{left:450px;background:rgb(${session.number&255},${(session.number>>8)&255},211)}#words{position:absolute;left:300px;top:100px;width:300px}</style><input id="name"><div id="marker"></div><div id="cycle"></div><div id="session"></div><img><div id="words"></div><script>
 window.sessionId=${JSON.stringify(session.id)};window.sessionNumber=${session.number};document.querySelector('input').oninput=e=>{const n=e.target.value.length;document.querySelector('#marker').style.background='rgb('+((n>>8)&255)+','+(n&255)+',42)';};
 window.update=async n=>{const img=document.querySelector('img');img.src='/image?session='+window.sessionId+'&n='+n;await img.decode();document.querySelector('#cycle').style.background='rgb('+(n&255)+','+((n>>8)&255)+',199)';document.querySelector('#words').textContent='Session '+window.sessionNumber+' 内存测试 '+n+'，图像与字体更新。';window.cycle=n;};window.loaded=update(Number(new URLSearchParams(location.search).get('n')??0));
 </script>`;
 const server=createServer((request,response)=>{
  response.setHeader('Cache-Control','no-store');const url=new URL(request.url,'http://localhost'),id=url.pathname==='/image'?url.searchParams.get('session'):url.pathname.split('/')[2],session=sessions.get(id);if(!session){response.writeHead(410);response.end('Session fixture closed or unknown');return;}
  if(url.pathname==='/image'){const n=Number(url.searchParams.get('n'));if(!Number.isInteger(n)||n<0||n>65535){response.writeHead(400);response.end();return;}const bytes=image(session,n);session.imageBytes+=bytes.length;session.imageRequests++;response.setHeader('Content-Type','image/png');response.end(bytes);}
  else if(url.pathname===`/session/${id}`){response.setHeader('Content-Type','text/html; charset=utf-8');response.end(html(session));}else{response.writeHead(404);response.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {get activeSessions(){return sessions.size;},get listening(){return server.listening;},create(){if(closed||sessions.size>=4||created>=65535)throw new Error('Session memory fixture owner limit');const session={id:randomUUID(),number:++created,imageBytes:0,imageRequests:0};sessions.set(session.id,session);let released=false;return {id:session.id,number:session.number,url:(host='127.0.0.1',n=0)=>`http://${host}:${server.address().port}/session/${session.id}?n=${n}`,stats:()=>({...session}),release(){if(!released){released=true;sessions.delete(session.id);}return {...session};}};},async close(){closed=true;sessions.clear();await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});}};
}
