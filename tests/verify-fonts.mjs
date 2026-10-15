import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import CanvasKitInit from 'canvaskit-wasm/full';
import {createRequire} from 'node:module';
import {PNG} from 'pngjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {subsetPicture} from '../native/subset.mjs';
import {startDynamicFixture} from './dynamic-fixture.mjs';

const directory=resolve('artifacts/fonts');await mkdir(directory,{recursive:true});
const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});
const fixture=await startDynamicFixture();const browser=await launchCaptureBrowser();
const reports=[];
try{
  const page=await browser.newPage({viewport:{width:960,height:640},deviceScaleFactor:1});
  await page.goto(new URL('/glyphs',fixture.url).href);
  await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth));
  for(const state of ['before','after']){
    if(state==='after')await page.locator('#advance').click();
    await page.evaluate(()=>document.fonts.ready);
    await page.screenshot({path:join(directory,`${state}-source.png`)});
    const raw=join(directory,state);await mkdir(raw,{recursive:true});
    await page.evaluate(path=>chrome.gpuBenchmarking.printToSkPicture(path),raw);
    const files=(await readdir(raw)).filter(f=>f.endsWith('.skp'));assert.equal(files.length,1);
    const output=join(directory,`${state}.skp`);
    const stats=await subsetPicture(join(raw,files[0]),output,join(directory,`${state}-native.png`));
    assert.equal(stats.imageCount,2);
    assert.ok(stats.outputBytes<stats.inputBytes/10,'Actual font data must shrink substantially');
    assert.ok(stats.fonts.every(f=>f.missingGlyphs===0),'Source contains missing glyphs');
    assert.ok(stats.fonts.every(f=>f.subsetBytes<f.originalBytes));
    const pic=ck.MakePicture(await readFile(output));assert.ok(pic,'CanvasKit must accept native subset output');
    const surface=ck.MakeSurface(960,640);surface.getCanvas().clear(ck.WHITE);surface.getCanvas().drawPicture(pic);surface.flush();
    const snapshot=surface.makeImageSnapshot();const bytes=snapshot.encodeToBytes();await writeFile(join(directory,`${state}-wasm.png`),bytes);
    const source=PNG.sync.read(await readFile(join(directory,`${state}-source.png`)));const replay=PNG.sync.read(Buffer.from(bytes));
    for(const img of await page.locator('img').all()){
      const box=await img.boundingBox();assert.ok(box);
      for(let y=Math.ceil(box.y)+5;y<Math.floor(box.y+box.height)-5;y++)for(let x=Math.ceil(box.x)+5;x<Math.floor(box.x+box.width)-5;x++){
        const i=(y*960+x)*4;assert.deepEqual([...replay.data.subarray(i,i+4)],[...source.data.subarray(i,i+4)],'Authenticated/blob image pixels changed');
      }
    }
    reports.push({state,...stats,text:await page.locator('#text').innerText(),authenticatedAndBlobPixelsExact:true});
    snapshot.delete();surface.delete();pic.delete();
  }
  assert.notEqual(reports[0].text,reports[1].text);
  assert.ok(reports[1].fonts.some(f=>f.family.includes('Emoji')));
  const result={verifiedAt:new Date().toISOString(),native:true,fontsPredeclared:false,stages:reports,sourceRequests:fixture.stats,
    skiaRevision:'29ed1e87a0a50f3d8347e988842d9d59e7573efa',canvaskit:'0.42.0'};
  await writeFile(join(directory,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();await fixture.close();}
