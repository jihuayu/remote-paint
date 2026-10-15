import assert from 'node:assert/strict';

// Compare text ink separately from the much larger, unchanged page background.
// CoreText and FreeType have different edge coverage; permit a one-pixel
// neighborhood, but require the actual strokes to survive CanvasKit replay.
export async function assertTextInk(page,source,replay,regions){
 assert.equal(replay.width,source.width);assert.equal(replay.height,source.height);
 const results=[];
 for(const {selector,background} of regions){
  const box=await page.locator(selector).boundingBox();assert.ok(box,`${selector} missing`);
  const foreground=await page.locator(selector).evaluate(el=>getComputedStyle(el).color.match(/[\d.]+/g).slice(0,3).map(Number));
  const textContrast=Math.max(...foreground.map((channel,c)=>Math.abs(channel-background[c])));
  // Edge alpha varies between the two rasterizers. Measure the solid stroke
  // interiors (75% of text contrast), and accept nearby ink above 25%.
  assert.ok(textContrast>80,`${selector} needs sufficient contrast for an ink comparison`);
  const left=Math.max(1,Math.ceil(box.x)),top=Math.max(1,Math.ceil(box.y));
  const right=Math.min(source.width-1,Math.floor(box.x+box.width)),bottom=Math.min(source.height-1,Math.floor(box.y+box.height));
  let ink=0,uncovered=0;
  const contrast=(image,x,y)=>{const i=(y*image.width+x)*4;return Math.max(...background.map((channel,c)=>Math.abs(image.data[i+c]-channel)));};
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){
   if(contrast(source,x,y)<=textContrast*0.75)continue;ink++;
   let covered=false;
   for(let dy=-1;dy<=1&&!covered;dy++)for(let dx=-1;dx<=1;dx++)if(contrast(replay,x+dx,y+dy)>textContrast*0.25){covered=true;break;}
   if(!covered)uncovered++;
  }
  assert.ok(ink>20,`${selector} must contain visible text strokes`);
  const uncoveredFraction=uncovered/ink;
  assert.ok(uncoveredFraction<0.02,`${selector} lost ${(uncoveredFraction*100).toFixed(2)}% of source text ink`);
  results.push({selector,ink,uncovered,uncoveredFraction,sourceMinContrast:textContrast*0.75,replayMinContrast:textContrast*0.25,neighborhoodPixels:1});
 }
 return results;
}

// Check a color glyph on its own so a mostly blank field cannot hide its loss.
export async function assertColorGlyph(page,source,replay,selector,text){
 const box=await page.locator(selector).evaluate((el,text)=>{
  const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;
  while(node=walker.nextNode()){const index=node.data.indexOf(text);if(index<0)continue;
   const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+text.length);
   const r=range.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}
 },text);
 assert.ok(box,'Color glyph source range missing');
 const left=Math.max(1,Math.floor(box.x)-1),top=Math.max(1,Math.floor(box.y)-1);
 const right=Math.min(source.width-1,Math.ceil(box.x+box.width)+1),bottom=Math.min(source.height-1,Math.ceil(box.y+box.height)+1);
 const results=[];
 for(const [from,to] of [[source,replay],[replay,source]]){
  let colored=0,unmatched=0;
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){
   const i=(y*from.width+x)*4,color=[...from.data.subarray(i,i+3)];
   if(Math.max(...color)-Math.min(...color)<64)continue;colored++;let matched=false;
   for(let dy=-1;dy<=1&&!matched;dy++)for(let dx=-1;dx<=1;dx++){
    const j=((y+dy)*to.width+x+dx)*4;
    if(color.every((c,k)=>Math.abs(c-to.data[j+k])<=24)){matched=true;break;}
   }
   if(!matched)unmatched++;
  }
  assert.ok(colored>20,'Color glyph has no visible color pixels');
  assert.ok(unmatched/colored<0.02,`Color glyph lost ${(100*unmatched/colored).toFixed(2)}% of its colors`);
  results.push({colored,unmatched,fraction:unmatched/colored});
 }
 return {selector,text,neighborhoodPixels:1,channelTolerance:24,sourceToReplay:results[0],replayToSource:results[1]};
}
