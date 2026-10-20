// Only allocations introduced by preprocessing belong here. The moved input
// graph/SKP storage remains under its RPC/native-input owner through mapping.
use crate::{budget::{Budget,Lease},scene::Result};
use serde_json::{Value,json};
use std::ops::Deref;
pub const PRESSURE:&str="Capture expansion allocation budget exceeded";
pub const DEFAULT_BYTES:usize=128*1024*1024;
#[derive(Clone)]pub struct Pool(pub Budget);
impl Pool{
 pub fn new(bytes:usize)->Self{Self(Budget::scoped(bytes,PRESSURE,"capture-expansion-pool"))}
 pub fn configured()->Result<Self>{
  let bytes=match std::env::var("REMOTE_PAINT_EXPANSION_BYTES"){Ok(v)=>v.parse::<usize>().map_err(|_|"Invalid REMOTE_PAINT_EXPANSION_BYTES")?,Err(_)=>DEFAULT_BYTES};
  if !(1024*1024..=1024*1024*1024).contains(&bytes){return Err("Capture expansion pool must be 1MiB..1GiB".into());}Ok(Self::new(bytes))
 }
 pub fn ready(&self)->bool{self.0.used()<=self.0.limit()-(8*1024*1024).min(self.0.limit()/2)}
 pub fn stats(&self)->Value{let mut s=self.0.stats();s["headroom"]=(8*1024*1024).min(self.0.limit()/2).into();s["ready"]=self.ready().into();s["scopeNote"]="new preprocessing clone/field/vector requested-layout allowance through expanded capture lifetime;original input/SKP,Mapper/Snapshot,payload/output,VM/OS separate".into();s}
}
// Fields drop in declaration order: every expanded Value before its credit.
// No into_inner/Clone API can detach the expanded graph from its admission.
pub struct ExpandedCapture { value:Value,_lease:Option<Lease> }
impl Deref for ExpandedCapture {type Target=Value;fn deref(&self)->&Value{&self.value}}
#[derive(Clone,Copy)]struct Tile{local:i64,id:i64,origin:[f64;2],scale:f64,width:f64,height:f64}
const EMPTY_TILE:Tile=Tile{local:0,id:0,origin:[0.,0.],scale:0.,width:0.,height:0.};
struct Plan{tiled:bool,tiles:[Tile;256],tile_count:usize,webgl:[i64;256],webgl_count:usize,counts:[usize;64],bytes:usize}
fn plus(total:&mut usize,n:usize)->Result<()>{*total=total.checked_add(n).ok_or_else(||PRESSURE.to_string())?;Ok(())}
fn times(a:usize,b:usize)->Result<usize>{a.checked_mul(b).ok_or_else(||PRESSURE.to_string())}
fn nums<const N:usize>(value:&Value)->Result<[f64;N]>{
 let a=value.as_array().filter(|a|a.len()==N).ok_or_else(||"Invalid native number array".to_string())?;let mut result=[0.;N];
 for(n,v)in a.iter().enumerate(){result[n]=v.as_f64().filter(|n|n.is_finite()&&n.abs()<1e7).ok_or_else(||"Invalid native number".to_string())?;}Ok(result)
}
// Conservative requested-layout accounting, not physical allocator residency.
// Preflight recursively borrows only; multiplication prices duplicated extra
// producer fields even though Mapper discards those fields from the final scene.
fn graph(value:&Value,depth:usize)->Result<usize>{
 if depth>128{return Err("Capture expansion metadata depth exceeded".into());}
 let mut cost=768;
 match value{
  Value::String(s)=>plus(&mut cost,times(s.len(),2)?)?,
  Value::Array(a)=>for v in a{plus(&mut cost,graph(v,depth+1)?)?;},
  Value::Object(o)=>for(k,v)in o{plus(&mut cost,256)?;plus(&mut cost,times(k.len(),2)?)?;plus(&mut cost,graph(v,depth+1)?)?;},
  _=>{}
 }Ok(cost)
}
fn webgl(q:&Value,namespace:&Value,p:&Plan)->bool{q["kind"]=="picture"&& &q["namespace"]==namespace&&q["localId"].as_i64().is_some_and(|id|p.webgl[..p.webgl_count].contains(&id))}
fn area(tile:&Tile,content:[f64;2],visible:[f64;4])->Option<([f64;2],[f64;4])>{
 let x=content[0]+tile.origin[0]*tile.scale;let y=content[1]+tile.origin[1]*tile.scale;
 let a=[x.max(visible[0]),y.max(visible[1]),(x+tile.width*tile.scale).min(visible[2]),(y+tile.height*tile.scale).min(visible[3])];
 if a[2]<=a[0]||a[3]<=a[1]{None}else{Some(([x,y],a))}
}
fn preflight(capture:&Value)->Result<Plan>{
 let mut p=Plan{tiled:false,tiles:[EMPTY_TILE;256],tile_count:0,webgl:[0;256],webgl_count:0,counts:[0;64],bytes:0};
 if let Some(layers)=capture.get("webglLayers"){
  for layer in layers.as_array().filter(|v|v.len()<=256).ok_or_else(||"Invalid WebGL layer list".to_string())?{
   let id=layer.as_i64().filter(|n|*n>0&&*n<=i32::MAX as i64).ok_or_else(||"Invalid WebGL layer ID".to_string())?;
   if p.webgl[..p.webgl_count].contains(&id){return Err("Duplicate WebGL layer ID".into());}
   p.webgl[p.webgl_count]=id;p.webgl_count+=1;
  }
 }
 let records=capture["resources"].as_array().ok_or_else(||"Missing resources".to_string())?;
 p.tiled=records.iter().any(|r|!r["tileOrigin"].is_null());
 if !p.tiled&&p.webgl_count==0{return Ok(p);}
 let passes=capture["viz"]["passes"].as_array().ok_or_else(||"Missing Viz passes".to_string())?;
 if records.len()>256||passes.is_empty()||passes.len()>64{return Err("Native scene budget exceeded".into());}
 if p.tiled{
  // Fixed stack geometry replaces HashMap/groups and temporary number Vecs.
  // Original records (including large Base64 strings) remain in place.
  for(r,tile)in records.iter().zip(p.tiles.iter_mut()){
   let local=r["localId"].as_i64().filter(|id|id.unsigned_abs()<=i32::MAX as u64).ok_or_else(||"Invalid tile layer ID".to_string())?;
   let origin=nums::<2>(&r["tileOrigin"])?;let[x,y]=origin;
   if x<0.||y<0.||x>=8192.||y>=8192.||x%256.!=0.||y%256.!=0.{return Err("Invalid tile origin".into());}
   *tile=Tile{local,id:local*1024+(y as i64/256)*32+(x as i64/256),origin,scale:r["quadScale"].as_f64().ok_or_else(||"Invalid tile scale".to_string())?,width:r["width"].as_f64().ok_or_else(||"Invalid tile width".to_string())?,height:r["height"].as_f64().ok_or_else(||"Invalid tile height".to_string())?};
  }
  p.tile_count=records.len();plus(&mut p.bytes,8192)?;plus(&mut p.bytes,times(records.len(),4096)?)?;
 }
 let mut count=0usize;
 for(i,pass)in passes.iter().enumerate(){
  for q in pass["quads"].as_array().ok_or_else(||"Missing quads".to_string())?{
   let placeholder=webgl(q,&capture["viz"]["namespace"],&p);
   if placeholder{plus(&mut p.bytes,4096)?;}
   let copies=if p.tiled&&q["kind"]=="picture"&&!placeholder{
    let local=q["localId"].as_i64().ok_or_else(||"Invalid layer".to_string())?;
    let tiles=&p.tiles[..p.tile_count];if !tiles.iter().any(|t|t.local==local){return Err("Missing tile group".into());}
    let content=nums::<2>(&q["contentOrigin"])?;let visible=nums::<4>(&q["visible"])?;
    tiles.iter().filter(|t|t.local==local&&area(t,content,visible).is_some()).count()
   }else{1};
   if p.tiled{
    count=count.checked_add(copies).ok_or_else(||PRESSURE.to_string())?;if count>2048{return Err("Expanded tile quad budget exceeded".into());}
    p.counts[i]+=copies;
    // The final visible tile takes the original quad. Only preceding tiles
    // clone its graph; all generated fields and exact output Vec are charged.
    if copies>1{plus(&mut p.bytes,times(graph(q,0)?,copies-1)?)?;}
    plus(&mut p.bytes,times(copies,4096+std::mem::size_of::<Value>())?)?;
   }
  }
 }
 Ok(p)
}
pub fn expand(capture:Value,pool:&Pool)->Result<ExpandedCapture>{
 let plan=preflight(&capture)?;
 let lease=if plan.bytes==0{None}else{Some(pool.0.reserve(plan.bytes)?)};
 let mut owned=ExpandedCapture{value:capture,_lease:lease};
 if plan.bytes==0{return Ok(owned);}
 apply(&mut owned.value,&plan)?;
 Ok(owned)
}
fn apply(capture:&mut Value,p:&Plan)->Result<()>{
 if p.tiled{
  for(r,tile)in capture["resources"].as_array_mut().unwrap().iter_mut().zip(p.tiles.iter()){
   r["localId"]=json!(tile.id);r["sourceLocalId"]=json!(tile.local);
  }
 }
 // Move passes out while borrowing the namespace. No namespace graph clone.
 let mut passes=capture["viz"]["passes"].take();
 let namespace=&capture["viz"]["namespace"];
 for(i,pass)in passes.as_array_mut().unwrap().iter_mut().enumerate(){
  if !p.tiled{
   for q in pass["quads"].as_array_mut().unwrap(){if webgl(q,namespace,p){q["kind"]=json!("placeholder");q["reason"]=json!("webgl");}}
   continue;
  }
  let old=std::mem::take(pass["quads"].as_array_mut().unwrap());let mut quads=Vec::with_capacity(p.counts[i]);
  for mut q in old{
   if webgl(&q,namespace,p){q["kind"]=json!("placeholder");q["reason"]=json!("webgl");}
   if q["kind"]!="picture"{quads.push(q);continue;}
   let local=q["localId"].as_i64().unwrap();let content=nums::<2>(&q["contentOrigin"])?;let visible=nums::<4>(&q["visible"])?;
   let tiles=&p.tiles[..p.tile_count];let mut remaining=tiles.iter().filter(|t|t.local==local&&area(t,content,visible).is_some()).count();
   let mut original=Some(q);
   for tile in tiles.iter().filter(|t|t.local==local){
    let Some((origin,visible))=area(tile,content,visible)else{continue;};remaining-=1;
    let mut out=if remaining==0{original.take().unwrap()}else{original.as_ref().unwrap().clone()};
    out["localId"]=json!(tile.id);out["visible"]=json!(visible);out["contentOrigin"]=json!(origin);quads.push(out);
   }
  }
  debug_assert_eq!(quads.len(),p.counts[i]);
  pass["quads"]=Value::Array(quads);
 }
 capture["viz"]["passes"]=passes;Ok(())
}

#[cfg(test)]mod tests{
 use super::*;
 use crate::allocation_probe::measure;
 fn capture(count:usize,extra:usize)->Value{
  json!({"captureId":"expansion-layout","producer":"fixture","resources":(0..count).map(|n|json!({"localId":7,"quadScale":1,"width":256,"height":256,"tileOrigin":[n%32*256,n/32*256],"resourceId":"0".repeat(64)})).collect::<Vec<_>>(),"viz":{"captureId":"expansion-layout","namespace":[1,2],"passes":[{"id":"root","output":[0,0,8192,8192],"quads":[{"kind":"picture","localId":7,"namespace":[1,2],"contentOrigin":[0,0],"visible":[0,0,8192,8192],"rect":[0,0,8192,8192],"matrix":[1,0,0,0,1,0,0,0,1],"opacity":1,"unused":"x".repeat(extra)}]}]}})
 }
 #[test]fn denial_before_cloning_large_extras_has_no_committed_or_partial_graph(){
  let pool=Pool::new(1024*1024);let native=capture(32,256*1024);let plan=preflight(&native).unwrap();assert!(plan.bytes>16*1024*1024);
  let(result,peak)=measure(||expand(native,&pool));assert_eq!(result.err().unwrap(),PRESSURE);assert!(peak<4096,"denial allocated{peak}");assert_eq!(pool.0.used(),0);assert_eq!(pool.stats()["denied"],1);
  println!("pre-map-denial: planned={} requested_peak={peak} used=0",plan.bytes);
 }
 #[test]fn large_extra_clone_layout_fits_admission_and_final_quad_moves_original_string(){
  let pool=Pool::new(64*1024*1024);let plan=preflight(&capture(32,256*1024)).unwrap();let native=capture(32,256*1024);let pointer=native["viz"]["passes"][0]["quads"][0]["unused"].as_str().unwrap().as_ptr();
  let(expanded,peak)=measure(||expand(native,&pool).unwrap());let q=expanded["viz"]["passes"][0]["quads"].as_array().unwrap();assert_eq!(q.len(),32);assert_eq!(q[31]["unused"].as_str().unwrap().as_ptr(),pointer);assert!(q[..31].iter().all(|q|q["unused"].as_str().unwrap().as_ptr()!=pointer));assert!(peak<=plan.bytes);assert_eq!(pool.0.used(),plan.bytes);
  let box_owner=Box::new(expanded);assert_eq!(pool.0.used(),plan.bytes);drop(box_owner);assert_eq!(pool.0.used(),0);assert_eq!(pool.stats()["allocations"],0);
  let(_,whole_peak)=measure(||expand(capture(32,256*1024),&pool).unwrap());println!("pre-map-after: requested_peak={peak} fresh_input_and_expansion_peak={whole_peak} reserved={}",plan.bytes);
 }
 #[test]fn no_op_moves_45mib_base64_without_new_copy_or_expansion_credit(){
  let pool=Pool::new(1);let mut native=capture(1,0);native["resources"][0].as_object_mut().unwrap().remove("tileOrigin");native["resources"][0]["skp"]=Value::String("x".repeat(45*1024*1024));let pointer=native["resources"][0]["skp"].as_str().unwrap().as_ptr();
  let(expanded,peak)=measure(||expand(native,&pool).unwrap());assert_eq!(peak,0);assert_eq!(pool.0.used(),0);assert_eq!(expanded["resources"][0]["skp"].as_str().unwrap().as_ptr(),pointer);
 }
 #[test]fn expanded_quad_limit_is_rejected_in_read_only_preflight(){
  let pool=Pool::new(usize::MAX);let mut native=capture(1,128);let q=native["viz"]["passes"][0]["quads"][0].clone();native["viz"]["passes"][0]["quads"]=json!(vec![q;2049]);
  let(result,peak)=measure(||expand(native,&pool));assert_eq!(result.err().unwrap(),"Expanded tile quad budget exceeded");assert!(peak<4096);assert_eq!(pool.0.used(),0);assert_eq!(pool.stats()["allocations"],0);
 }
 #[test]fn webgl_namespace_is_borrowed_and_only_matching_layer_is_marked(){
  let pool=Pool::new(64*1024);let mut native=capture(0,0);native["webglLayers"]=json!([7]);native["viz"]["namespace"]=json!({"unsupported":"n".repeat(512*1024)});native["viz"]["passes"][0]["quads"][0]["namespace"]=native["viz"]["namespace"].clone();let pointer=native["viz"]["namespace"]["unsupported"].as_str().unwrap().as_ptr();
  let q=native["viz"]["passes"][0]["quads"][0].clone();native["viz"]["passes"][0]["quads"].as_array_mut().unwrap().push(q);native["viz"]["passes"][0]["quads"][1]["localId"]=json!(8);
  let(result,peak)=measure(||expand(native,&pool).unwrap());assert!(peak<4096,"namespace cloned {peak}");assert_eq!(result["viz"]["namespace"]["unsupported"].as_str().unwrap().as_ptr(),pointer);assert_eq!(result["viz"]["passes"][0]["quads"][0]["kind"],"placeholder");assert_eq!(result["viz"]["passes"][0]["quads"][1]["kind"],"picture");assert_eq!(result["viz"]["passes"][0]["quads"][0]["reason"],"webgl");assert!(pool.0.used()>0);drop(result);assert_eq!(pool.0.used(),0);
 }
 #[test]fn credit_follows_expanded_owner_and_refusal_recovers_after_drop(){
  let bytes=preflight(&capture(2,0)).unwrap().bytes;let pool=Pool::new(bytes);let first=expand(capture(2,0),&pool).unwrap();assert_eq!(pool.0.used(),bytes);assert_eq!(expand(capture(2,0),&pool).err().unwrap(),PRESSURE);assert_eq!(pool.0.used(),bytes);
  let gate=std::sync::Arc::new(std::sync::Barrier::new(2));let other=gate.clone();let handle=std::thread::spawn(move||{other.wait();drop(first);});gate.wait();handle.join().unwrap();assert_eq!(pool.0.used(),0);let second=expand(capture(2,0),&pool).unwrap();assert_eq!(second["viz"]["passes"][0]["quads"].as_array().unwrap().len(),2);drop(second);assert_eq!(pool.0.used(),0);
 }
 #[test]fn invalid_late_geometry_does_not_begin_rewrite_or_reserve(){
  let pool=Pool::new(DEFAULT_BYTES);let mut native=capture(256,0);native["resources"][255]["tileOrigin"]=json!([3,0]);let(result,peak)=measure(||expand(native,&pool));assert_eq!(result.err().unwrap(),"Invalid tile origin");assert!(peak<4096);assert_eq!(pool.0.used(),0);assert_eq!(pool.stats()["allocations"],0);
 }
 #[test]fn requested_layout_corpus_covers_max_tiles_quads_passes_escaped_keys_and_webgl(){
  for name in ["max-tiles","max-quads","max-passes","escaped","webgl","invisible"]{
   let fixture=||{
    let mut c=capture(if name=="max-tiles"{256}else{2},if name=="escaped"{8192}else{0});
    if name=="max-quads"{let q=c["viz"]["passes"][0]["quads"][0].clone();c["resources"].as_array_mut().unwrap().truncate(1);c["viz"]["passes"][0]["quads"]=Value::Array(vec![q;2048]);}
    if name=="max-passes"{let pass=c["viz"]["passes"][0].clone();c["viz"]["passes"]=Value::Array(vec![pass;64]);}
    if name=="escaped"{c["viz"]["passes"][0]["quads"][0]["\\\"\n\t".repeat(512)]=json!({"nested":vec!["\\\"\n".repeat(1024);8]});}
    if name=="webgl"{c["webglLayers"]=json!([7]);c["resources"]=json!([]);let q=c["viz"]["passes"][0]["quads"][0].clone();c["viz"]["passes"][0]["quads"]=Value::Array(vec![q;2048]);}
    if name=="invisible"{c["viz"]["passes"][0]["quads"][0]["visible"]=json!([9000,9000,9500,9500]);}
    c
   };
   let(_,input_peak)=measure(fixture);let plan=preflight(&fixture()).unwrap();let pool=Pool::new(DEFAULT_BYTES);let(expanded,peak)=measure(||expand(fixture(),&pool).unwrap());
   assert!(peak<=input_peak+plan.bytes,"{name}:peak={peak} original_input={input_peak} new_credit={}",plan.bytes);assert_eq!(pool.0.used(),plan.bytes);
   if name=="max-quads"||name=="webgl"{assert_eq!(expanded["viz"]["passes"][0]["quads"].as_array().unwrap().len(),2048);}
   if name=="max-tiles"{assert_eq!(expanded["viz"]["passes"][0]["quads"].as_array().unwrap().len(),256);}
   if name=="invisible"{assert!(expanded["viz"]["passes"][0]["quads"].as_array().unwrap().is_empty());}
   println!("pre-map-layout {name}: input_peak={input_peak} combined_peak={peak} new_credit={}",plan.bytes);drop(expanded);assert_eq!(pool.0.used(),0);
  }
 }

}
