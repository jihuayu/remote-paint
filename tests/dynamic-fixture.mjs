import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { PNG } from 'pngjs';

export async function startDynamicFixture() {
  const secret = randomBytes(16).toString('hex');
  const png = new PNG({ width: 150, height: 100 });
  for (let y=0;y<100;y++) for(let x=0;x<150;x++) png.data.set([30+x,100+y,160,255],(y*150+x)*4);
  const image = PNG.sync.write(png);
  const stats = { authorizedImageRequests: 0, rejectedImageRequests: 0 };
  const server = createServer(async (req,res) => {
    try {
      if(req.url==='/'||req.url==='/glyphs') {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8', 'Set-Cookie':`paint_fixture=${secret}; HttpOnly; SameSite=Strict; Path=/`});
        res.end(await readFile(new URL(req.url==='/glyphs'?'./fixtures/font-image.html':'./fixtures/dynamic.html',import.meta.url)));
      } else if(req.url==='/private.png') {
        if(!req.headers.cookie?.split(';').map(s=>s.trim()).includes(`paint_fixture=${secret}`)) {
          stats.rejectedImageRequests++;res.writeHead(403);res.end('Cookie required');return;
        }
        stats.authorizedImageRequests++;res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(image);
      } else {res.writeHead(404);res.end();}
    } catch {res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}/`,stats,
    close:()=>new Promise(resolve=>server.close(resolve))};
}
