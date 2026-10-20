export function intersect(a,b){
 if(!a||!b)return null;
 const result=[Math.max(a[0],b[0]),Math.max(a[1],b[1]),Math.min(a[2],b[2]),Math.min(a[3],b[3])];
 return result[2]>result[0]&&result[3]>result[1]?result:null;
}
function union(a,b){return a&&b?[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])]:a??b;}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const effects=value=>['filters','backdropFilters','backdrop','mask'].some(key=>value?.[key]!==undefined&&value[key]!==null&&value[key]!==false&&(!Array.isArray(value[key])||value[key].length));

// Bounds are in the pass's target space. Perspective or future effects use
// the entire pass until their dependency/expansion rules are implemented.
export function quadBounds(quad,output,local=quad?.visible){
 if(!quad||quad.opacity===0||!local)return null;
 const m=quad.matrix;if(m[6]!==0||m[7]!==0||m[8]!==1||effects(quad))return output;
 const visible=intersect(local,quad.visible);if(!visible)return null;
 const [x,y,r,b]=visible,points=[[x,y],[r,y],[r,b],[x,b]].map(([x,y])=>[m[0]*x+m[1]*y+m[2],m[3]*x+m[4]*y+m[5]]);
 let bounds=[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
 if(quad.clip)bounds=intersect(bounds,quad.clip);
 if(quad.roundedClip)bounds=intersect(bounds,quad.roundedClip.slice(0,4));
 if(!bounds)return null;
 // Cover antialiasing and subpixel edges before applying an integer scissor.
 bounds=[Math.floor(bounds[0])-2,Math.floor(bounds[1])-2,Math.ceil(bounds[2])+2,Math.ceil(bounds[3])+2];
 return intersect(bounds,output);
}

export function passDamage(pass,previous,children,{backgroundChanged=false}={}){
 const output=pass.output;
 if(!previous||!equal(output,previous.output)||backgroundChanged||effects(pass)||effects(previous))return output.slice();
 let damage=null;
 for(let index=0;index<Math.max(pass.quads.length,previous.quads.length);index++){
  const before=previous.quads[index],after=pass.quads[index];
  if(!equal(before,after))damage=union(damage,union(quadBounds(before,output),quadBounds(after,output)));
  else if(after?.kind==='pass'&&children.get(after.passId))damage=union(damage,quadBounds(after,output,children.get(after.passId)));
 }
 return damage;
}
