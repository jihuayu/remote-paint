import assert from 'node:assert/strict';

// Test-only paint signal, installed in the real source DOM. Its color changes
// only after a normal Viewer key event reaches the real remote input element.
export async function installInputLatencyProbe(page){
 return page.evaluate(()=>{
  window.removeInputLatencyProbe?.();
  const input=document.querySelector('#name'),original=input.value;
  const marker=document.createElement('div');marker.id='remote-paint-latency-probe';
  Object.assign(marker.style,{position:'fixed',right:'16px',top:'100px',width:'24px',height:'24px',zIndex:'99999',background:'rgb(0,0,0)',pointerEvents:'none'});
  document.body.append(marker);
  const update=()=>{const code=input.value.charCodeAt(input.value.length-1);marker.style.background=`rgb(${32+code*53%192},${32+code*97%192},${32+code*131%192})`;};
  input.addEventListener('input',update);
  window.removeInputLatencyProbe=()=>{input.removeEventListener('input',update);input.value=original;marker.remove();delete window.removeInputLatencyProbe;};
  const r=marker.getBoundingClientRect(),style=getComputedStyle(input);
  return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2),inputStyle:{borderRadius:style.borderRadius,caretColor:style.caretColor}};
 });
}

export async function measureInputLatency(page,point,{samples=16}={}){
 const results=[];
 for(let i=0;i<samples;i++){
  const key=String.fromCharCode(65+i),code=key.charCodeAt(0),rgb=[32+code*53%192,32+code*97%192,32+code*131%192];
  await page.evaluate(({key,rgb,point})=>{
   const proxy=document.querySelector('#inputProxy'),canvas=document.querySelector('canvas');
   window.inputLatencySample=null;
   proxy.addEventListener('keydown',function pressed(event){
    if(event.key!==key)return;proxy.removeEventListener('keydown',pressed,true);
    const start=performance.now(),previous=window.remotePaintResult?.lastProcessedInputSeq??0;
    function observe(){
     const frame=window.remotePaintResult,pixel=canvas.getContext('2d').getImageData(point.x,point.y,1,1).data;
     if(frame?.lastProcessedInputSeq>previous&&rgb.every((value,c)=>Math.abs(value-pixel[c])<=1)){
      window.inputLatencySample={key,inputToPixelsMs:performance.now()-start,frameId:frame.frameId,inputSequence:frame.lastProcessedInputSeq,renderMs:frame.renderMs};return;
     }
     if(performance.now()-start>10000){window.inputLatencySample={error:'No matching native paint within 10 seconds',key,expected:rgb,pixel:[...pixel],previous,inputSequence:frame?.lastProcessedInputSeq,frameId:frame?.frameId,viewerError:document.querySelector('#error').textContent};return;}
     requestAnimationFrame(observe);
    }
    requestAnimationFrame(observe);
   },true);
  },{key,rgb,point});
  await page.keyboard.type(key);
  await page.waitForFunction(()=>window.inputLatencySample!==null,null,{timeout:15000});
  const sample=await page.evaluate(()=>window.inputLatencySample);assert.equal(sample.error,undefined,JSON.stringify(sample));results.push(sample);
  await page.waitForTimeout(13+i*17%89);
 }
 const sorted=results.map(r=>r.inputToPixelsMs).sort((a,b)=>a-b),percentile=p=>sorted[Math.ceil(sorted.length*p)-1];
 return {scope:'Viewer keydown to matching native source paint observed in the CanvasKit canvas; excludes physical keyboard and monitor scanout',samples:results,p50Ms:percentile(0.5),p95Ms:percentile(0.95),maxMs:sorted.at(-1),meanMs:sorted.reduce((a,b)=>a+b,0)/sorted.length};
}
