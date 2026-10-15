import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {BeginFrameDriver} from '../capture/begin-frame.mjs';
import {nativeLaunchArgs} from '../native/launch.mjs';
const executablePath=process.env.REMOTE_PAINT_CHROMIUM;
if(process.platform!=='linux'||!executablePath)throw new Error('Run in Linux with REMOTE_PAINT_CHROMIUM set');
const browser=await chromium.launch({executablePath,headless:true,args:nativeLaunchArgs('clock-test-token-'.repeat(4),{beginFrames:true})});
let driver;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 const page=await browser.newPage();const cdp=await page.context().newCDPSession(page);driver=new BeginFrameDriver(cdp);
 await page.goto('data:text/html,<h1>Linux BeginFrame clock</h1>',{waitUntil:'domcontentloaded'});
 await driver.step();
 await page.evaluate(()=>{
  window.rafTicks=0;window.timerTicks=0;
  setInterval(()=>window.timerTicks++,10);
  requestAnimationFrame(function frame(){window.rafTicks++;requestAnimationFrame(frame);});
 });
 const sample=()=>page.evaluate(()=>({raf:window.rafTicks,timers:window.timerTicks}));
 const before=await sample();await delay(150);const paused=await sample();
 assert.equal(paused.raf,before.raf,'rAF must remain paused without BeginFrame');assert.ok(paused.timers>before.timers,'JS timers must remain live');
 const steps=[];
 for(let i=0;i<5;i++){await delay(20);const ack=await driver.step();assert.equal(ack.screenshotData,undefined);steps.push(await sample());}
 assert.ok(steps.at(-1).raf-paused.raf>=4,'External BeginFrames must advance real rAF');
 assert.ok(steps.every((s,i)=>s.raf-(i?steps[i-1].raf:paused.raf)<=1),'One BeginFrame cannot deliver multiple rAF ticks');
 await delay(150);const pausedAgain=await sample();assert.equal(pausedAgain.raf,steps.at(-1).raf);
 driver.start();await delay(250);await driver.stop();const resumed=await sample();assert.ok(resumed.raf>pausedAgain.raf);
 assert.equal(driver.stats.issued,driver.stats.acked);assert.equal(driver.stats.errors,0);
 const report={verifiedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,browser:browser.version(),
  executableSha256:createHash('sha256').update(await readFile(executablePath)).digest('hex'),
  scope:process.env.REMOTE_PAINT_CLOCK_ONLY==='1'?'stock Linux clock probe; not native drawing acceptance':'custom Linux browser external clock',
  noScreenshotReadback:true,before,paused,steps,pausedAgain,resumed,stats:{...driver.stats}};
 await mkdir('artifacts/linux',{recursive:true});await writeFile('artifacts/linux/begin-frame-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await driver?.close();await browser.close();}
