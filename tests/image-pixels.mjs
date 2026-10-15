import assert from 'node:assert/strict';
// Check the actual image interiors separately from a page-wide text/AA budget.
export async function assertPrivateImagePixels(page,source,replay){
 assert.equal(replay.width,source.width);assert.equal(replay.height,source.height);const results=[];
 for(const selector of ['#private-image','#blob-image']){
  const box=await page.locator(selector).boundingBox();assert.ok(box,`${selector} missing`);
  assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=source.width&&box.y+box.height<=source.height,`${selector} must be fully visible for image comparison`);
  let pixelsCompared=0;
  for(let y=Math.ceil(box.y)+10;y<Math.floor(box.y+box.height)-10;y++)for(let x=Math.ceil(box.x)+10;x<Math.floor(box.x+box.width)-10;x++){
   const i=(y*source.width+x)*4;
   assert.deepEqual([...replay.data.subarray(i,i+4)],[...source.data.subarray(i,i+4)],`${selector} differs at ${x},${y}`);pixelsCompared++;
  }
  assert.ok(pixelsCompared>0);results.push({selector,pixelsCompared,maxChannelError:0});
 }
 return results;
}
