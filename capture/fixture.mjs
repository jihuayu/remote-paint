import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';

const fixtureDir = new URL('../tests/fixtures/', import.meta.url);
const png = new PNG({ width: 194, height: 140 });
for (let y = 0; y < 140; y++) for (let x = 0; x < 194; x++) {
  const i = (y * 194 + x) * 4;
  png.data.set([Math.round(36 + x * 0.8), Math.round(100 + y * 0.7), 160, 255], i);
}
const image = PNG.sync.write(png);

export async function fixtureResponse(req, res) {
  const path = new URL(req.url, 'http://localhost').pathname;
  const files = {
    '/fixture/page.html': ['page.html', 'text/html; charset=utf-8'],
    '/fixture/NotoSansSC-subset.ttf': ['NotoSansSC-subset.ttf', 'font/ttf'],
  };
  if (path === '/fixture/sample.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(image); return true;
  }
  if (!files[path]) return false;
  const [name, type] = files[path];
  res.writeHead(200, { 'Content-Type': type });
  res.end(await readFile(new URL(name, fixtureDir))); return true;
}

export async function startFixtureServer() {
  const server = createServer((req, res) => {
    fixtureResponse(req, res).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/fixture/page.html`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
