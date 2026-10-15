import {nativeLaunchArgs} from '../native/launch.mjs';
import {assertPrivateImagePixels} from './image-pixels.mjs';
import {assertTextInk} from './text-pixels.mjs';
import assert from 'node:assert/strict';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
import CanvasKitInit from 'canvaskit-wasm/full';
import {PNG} from 'pngjs';
import {NativeCapture,nativeToken} from '../capture/live.mjs';
import {startVizIPC} from '../capture/viz-ipc.mjs';
import {SceneMapper} from '../capture/scene.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';
import {startDynamicFixture} from './dynamic-fixture.mjs';
const executablePath=process.env.REMOTE_PAINT_CHROMIUM;if(!executablePath)throw new Error('Set REMOTE_PAINT_CHROMIUM');
const viz=await startVizIPC(),fixture=await startDynamicFixture(),token=nativeToken();
const browser=await chromium.launch({executablePath,headless:true,env:{...process.env,REMOTE_PAINT_SOCKET:viz.endpoint},args:nativeLaunchArgs(token)});
const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});
const renderer=new SceneRenderer(ck),mapper=new SceneMapper();let capture;
try{
 await mkdir('artifacts/scene',{recursive:true});const page=await browser.newPage({viewport:{width:960,height:640},deviceScaleFactor:1});await page.goto(fixture.url);
 await page.waitForFunction(()=>window.fixtureReady&&[...document.images].every(i=>i.complete&&i.naturalWidth));
 await page.locator('#stop-clock').click();await page.evaluate(()=>document.getAnimations().forEach(a=>a.pause()));
 capture=new NativeCapture(page,{token,viz});await capture.initialize();const stages=[];
 for(const offset of [0,700,0]){
  await page.evaluate(y=>window.scrollTo(0,y),offset);await page.screenshot();
  const native=await capture.capture();const mapped=mapper.map(native,1);const replay=renderer.render(mapped.scene,mapped.payloads);
  await writeFile(`artifacts/scene/scene-${stages.length}.json`,JSON.stringify(mapped.scene,null,2));
  const source=PNG.sync.read(await page.screenshot({path:`artifacts/scene/source-${stages.length}.png`}));
  const bytes=replay.image.encodeToBytes();await writeFile(`artifacts/scene/replay-${stages.length}.png`,bytes);const pixels=PNG.sync.read(Buffer.from(bytes));
  assert.equal(pixels.width,source.width);assert.equal(pixels.height,source.height);
  let changed=0,headerChanged=0;
  for(let i=0;i<source.data.length;i+=4){let d=0;for(let c=0;c<4;c++)d=Math.max(d,Math.abs(source.data[i+c]-pixels.data[i+c]));if(d>24){changed++;if(i/4<960*86)headerChanged++;}}
  const imagePixels=offset===0?await assertPrivateImagePixels(page,source,pixels):[];
  const textInk=await assertTextInk(page,source,pixels,[{selector:'header h1',background:[20,34,59]},{selector:'header p',background:[20,34,59]}]);
  const fraction=changed/(pixels.width*pixels.height);assert.ok(fraction<0.06,`Scene replay differs at ${(fraction*100).toFixed(2)}% of pixels`);
  assert.ok(headerChanged/(960*86)<0.08,'Fixed header composition changed materially');
  stages.push({offset,imagePixels,textInk,native:mapped.native,resources:mapped.mappings,released:mapped.released,pixelFractionOver24:fraction,headerChangedPixels:headerChanged,quads:mapped.scene.passes.reduce((n,p)=>n+p.quads.length,0)});
  await writeFile(`artifacts/scene/scene-${stages.length-1}.json`,JSON.stringify(mapped.scene,null,2));
  replay.image.delete();replay.surface.delete();renderer.retain(new Set(mapped.payloads.keys()));
 }
 assert.deepEqual(stages[1].resources,stages[0].resources,'Scrolling must reuse unchanged full-layer resources');
 assert.deepEqual(stages[2].resources,stages[0].resources,'Scrolling back must reuse unchanged resources');
 // A compositor animation must change scene geometry even when JS/DOM content
 // remains frozen. This checks the sampled active compositor + aggregated Viz.
 await page.evaluate(()=>document.getAnimations().forEach(a=>a.play()));
 const a=mapper.map(await capture.capture(),1);await new Promise(r=>setTimeout(r,250));const b=mapper.map(await capture.capture(),1);
 assert.notEqual(JSON.stringify(a.scene),JSON.stringify(b.scene),'Compositor animation did not update scene');
 const report={verifiedAt:new Date().toISOString(),browser:browser.version(),gpuMode:'in-process',nativeBrowserCapture:true,stages,scrollingReusesResources:true,animationChangesScene:true,ipc:viz.stats};
 await writeFile('artifacts/scene/report.json',JSON.stringify(report,null,2));console.log(report);
}finally{renderer.clear();await capture?.close();await browser.close();await viz.close();await fixture.close();}
