use crate::{budget::{Budget,Lease,OwnedVec},scene::{Result,Snapshot,SCENE_BYTES}};
use serde::{Serialize,Serializer,ser::{SerializeMap,SerializeSeq}};
use serde_json::{Value,json};
use std::{collections::HashMap,io::{self,Write},sync::OnceLock};
use tungstenite::Utf8Bytes;

pub const PRESSURE:&str="Gateway packet allocation budget exceeded";
pub const DATA_BYTES:usize=128*1024*1024;
pub const CONTROL_BYTES:usize=8*1024*1024;
pub const CACHE_BYTES:usize=64*1024;
const CACHE_CAPACITY:usize=128;
const SIZING:usize=4096;
#[derive(Clone,Copy)]pub enum Lane{Data,Control}
#[derive(Clone)]pub struct Pool{data:Budget,control:Budget}
static GLOBAL:OnceLock<Pool>=OnceLock::new();
pub fn global()->&'static Pool{GLOBAL.get_or_init(||Pool::new(DATA_BYTES,CONTROL_BYTES))}
pub fn configure()->Result<&'static Pool>{
 let read=|name:&str,default,max|->Result<usize>{let bytes=match std::env::var(name){Ok(value)=>value.parse::<usize>().map_err(|_|format!("Invalid {name}"))?,Err(_)=>default};if !(64*1024..=max).contains(&bytes){return Err(format!("Invalid {name} range"));}Ok(bytes)};
 let data=read("REMOTE_PAINT_GATEWAY_PACKET_BYTES",DATA_BYTES,2*1024*1024*1024)?;let control=read("REMOTE_PAINT_GATEWAY_CONTROL_BYTES",CONTROL_BYTES,32*1024*1024)?;
 GLOBAL.set(Pool::new(data,control)).map_err(|_|"Gateway packets already configured")?;Ok(global())
}
impl Pool{
 pub fn new(data:usize,control:usize)->Self{Self{data:Budget::scoped(data,PRESSURE,"gateway-packet-data"),control:Budget::scoped(control,PRESSURE,"gateway-packet-control")}}
 fn budget(&self,lane:Lane)->&Budget{match lane{Lane::Data=>&self.data,Lane::Control=>&self.control}}
 fn data_headroom(&self)->usize{(32*1024*1024).min(self.data.limit()/2)}
 pub fn ready(&self)->bool{self.data.used()<=self.data.limit()-self.data_headroom()&&self.control.used()<=self.control.limit()/2}
 pub fn stats(&self)->Value{let mut data=self.data.stats();data["headroom"]=self.data_headroom().into();data["ready"]=(self.data.used()<=self.data.limit()-self.data_headroom()).into();json!({"scope":"gateway-packet-pool","data":data,"control":self.control.stats(),"cacheMetadataBytes":CACHE_BYTES,"cacheCapacity":CACHE_CAPACITY,"maximumScene":SCENE_BYTES,"ready":self.ready(),"scopeNote":"final serialized Gateway text and delta cache backing;original config/peer/scratch/index/OS/RSS outside"})}
 fn build(&self,lane:Lane,limit:usize,write:impl Fn(&mut dyn Write)->io::Result<()>)->Result<Utf8Bytes>{
  let budget=self.budget(lane);let _sizing=budget.reserve(SIZING)?;
  let mut count=Counter{bytes:0,limit,over:false};if write(&mut count).is_err(){return Err(if count.over{"Frame metadata budget exceeded"}else{"Invalid Gateway packet serialization"}.into());}
  let mut buffer=budget.buffer(count.bytes)?;write(&mut Exact(&mut buffer)).map_err(|_|"Gateway packet changed during serialization")?;
  if buffer.len()!=count.bytes{return Err("Gateway packet changed during serialization".into());}
  Utf8Bytes::try_from(buffer.finish()).map_err(|_|"Invalid Gateway packet UTF8".into())
 }
 pub fn json<T:Serialize+?Sized>(&self,lane:Lane,limit:usize,value:&T)->Result<Utf8Bytes>{self.build(lane,limit,|out|write_json(out,value))}
 pub fn frame(&self,snapshot:&Snapshot,frame_id:u64,base:Option<u64>,delta:Option<&Utf8Bytes>)->Result<Utf8Bytes>{
  self.build(Lane::Data,SCENE_BYTES,|out|{
   out.write_all(b"{\"type\":\"SceneUpdate\",\"frame\":{")?;
   fields(out,&snapshot.metadata,frame_id,base)?;
   out.write_all(if delta.is_some(){b",\"delta\":"}else{b",\"scene\":"})?;
   out.write_all(delta.map_or(snapshot.full_json.as_bytes(),|delta|delta.as_bytes()))?;out.write_all(b"}}")
  })
 }
 pub fn notification(&self,lane:Lane,value:&Notification<'_>)->Result<Utf8Bytes>{
  let limit=if matches!(value,Notification::ControlWelcome{..}){crate::ws_memory::CONTROL_WRITE-10}else{crate::ws_memory::DATA_WRITE-10};self.json(lane,limit,value)
 }
 pub fn cache(&self)->Result<Cache>{
  let metadata=self.data.reserve(CACHE_BYTES)?;let mut values=HashMap::new();values.try_reserve(CACHE_CAPACITY).map_err(|_|"Gateway delta cache allocation failed")?;
  if values.capacity()>256{return Err("Unexpected Gateway delta cache capacity".into());}
  Ok(Cache{values,_metadata:metadata})
 }
}
struct Counter{bytes:usize,limit:usize,over:bool}
impl Write for Counter{
 fn write(&mut self,bytes:&[u8])->io::Result<usize>{if let Some(next)=self.bytes.checked_add(bytes.len()).filter(|n|*n<=self.limit){self.bytes=next;Ok(bytes.len())}else{self.over=true;Err(io::Error::other("Gateway packet limit"))}}
 fn flush(&mut self)->io::Result<()>{Ok(())}
}
struct Exact<'a>(&'a mut OwnedVec);
impl Write for Exact<'_>{
 fn write(&mut self,bytes:&[u8])->io::Result<usize>{if bytes.len()>self.0.capacity()-self.0.len(){return Err(io::Error::other("Gateway packet size changed"));}self.0.extend(bytes);Ok(bytes.len())}
 fn flush(&mut self)->io::Result<()>{Ok(())}
}
fn write_json<T:Serialize+?Sized>(out:&mut dyn Write,value:&T)->io::Result<()>{serde_json::to_writer(out,value).map_err(io::Error::other)}
enum HeaderValue{Number(u64),Base(Option<u64>)}
impl Serialize for HeaderValue{fn serialize<S:Serializer>(&self,s:S)->std::result::Result<S::Ok,S::Error>{match self{Self::Number(n)=>n.serialize(s),Self::Base(n)=>n.serialize(s)}}}
fn field<T:Serialize+?Sized>(out:&mut dyn Write,key:&str,value:&T,first:&mut bool)->io::Result<()>{if !*first{out.write_all(b",")?;}*first=false;write_json(out,key)?;out.write_all(b":")?;write_json(out,value)}
fn fields(out:&mut dyn Write,metadata:&Value,frame_id:u64,base:Option<u64>)->io::Result<()>{
 let object=metadata.as_object().ok_or_else(||io::Error::other("Invalid frame metadata"))?;
 let fixed=[("baseFrameId",HeaderValue::Base(base)),("frameId",HeaderValue::Number(frame_id)),("protocol",HeaderValue::Number(4))];let mut next=0;let mut first=true;
 // Merge sorted override fields into the original immutable metadata. Deleted
 // mappings/released and replaced values are never cloned or serialized.
 for(key,value)in object{
  if matches!(key.as_str(),"mappings"|"released"|"baseFrameId"|"frameId"|"protocol"){continue;}
  while next<fixed.len()&&fixed[next].0<key.as_str(){field(out,fixed[next].0,&fixed[next].1,&mut first)?;next+=1;}
  field(out,key,value,&mut first)?;
 }
 while next<fixed.len(){field(out,fixed[next].0,&fixed[next].1,&mut first)?;next+=1;}Ok(())
}
// Actual table backing is allocated only after fixed admission and is dropped
// before that lease. Cached text aliases own their independent exact buffers.
pub struct Cache{values:HashMap<(u64,u64),Utf8Bytes>,_metadata:Lease}
impl Cache{
 pub fn on_publish(&mut self){if self.values.len()>64{self.values.clear();}}
 pub fn clear(&mut self){self.values.clear();}
 pub fn reclaim(&mut self,pool:&Pool)->usize{if pool.ready(){return 0;}let retired=self.values.len();self.values.clear();retired}
 pub fn delta(&mut self,pool:&Pool,previous:&Snapshot,next:&Snapshot)->Result<Utf8Bytes>{
  let key=(previous.serial,next.serial);if let Some(value)=self.values.get(&key){return Ok(value.clone());}
  let text=pool.json(Lane::Data,SCENE_BYTES,&Delta{previous:&previous.scene,next:&next.scene})?;
  if self.values.len()==CACHE_CAPACITY{self.values.clear();}
  // Never let an incidental per-publication burst grow the admitted table.
  assert!(self.values.len()<self.values.capacity());self.values.insert(key,text.clone());Ok(text)
 }
}
struct Delta<'a>{previous:&'a Value,next:&'a Value}
impl Serialize for Delta<'_>{
 fn serialize<S:Serializer>(&self,s:S)->std::result::Result<S::Ok,S::Error>{let old=self.previous["passes"].as_array().ok_or_else(||serde::ser::Error::custom("Invalid previous passes"))?;let new=self.next["passes"].as_array().ok_or_else(||serde::ser::Error::custom("Invalid next passes"))?;let mut map=s.serialize_map(Some(4))?;map.serialize_entry("order",&Passes{old,new,kind:0})?;map.serialize_entry("remove",&Passes{old,new,kind:1})?;map.serialize_entry("rootPass",&self.next["rootPass"])?;map.serialize_entry("upsert",&Passes{old,new,kind:2})?;map.end()}
}
struct Passes<'a>{old:&'a[Value],new:&'a[Value],kind:u8}
impl Serialize for Passes<'_>{
 fn serialize<S:Serializer>(&self,s:S)->std::result::Result<S::Ok,S::Error>{let mut seq=s.serialize_seq(None)?;match self.kind{
  0=>for pass in self.new{seq.serialize_element(&pass["id"])?;},
  1=>for pass in self.old.iter().filter(|old|!self.new.iter().any(|next|next["id"]==old["id"])){seq.serialize_element(&pass["id"])?;},
  _=>for pass in self.new.iter().filter(|next|!self.old.iter().any(|old|old==*next)){seq.serialize_element(pass)?;},
 }seq.end()}
}
pub enum Notification<'a>{
 Welcome{config:&'a Value,peer:&'a str,window:usize,input_feedback:bool,resource_memory:bool,ticket:Option<&'a str>},
 ConsumerWelcome{config:&'a Value,peer:&'a str,window:usize,resource_memory:bool,kind:&'a str},
 ControlWelcome{peer:&'a str,session:&'a Value},Release(&'a[String]),Commit{epoch:&'a Value,frame:u64},Reset,
}
struct Ticket<'a>(Option<&'a str>);
impl Serialize for Ticket<'_>{fn serialize<S:Serializer>(&self,s:S)->std::result::Result<S::Ok,S::Error>{if let Some(ticket)=self.0{let mut map=s.serialize_map(Some(1))?;map.serialize_entry("ticket",ticket)?;map.end()}else{s.serialize_none()}}}
impl Serialize for Notification<'_>{
 fn serialize<S:Serializer>(&self,s:S)->std::result::Result<S::Ok,S::Error>{let mut map=s.serialize_map(None)?;match self{
  Self::Welcome{config,peer,window,input_feedback,resource_memory,ticket}=>{map.serialize_entry("ackStage","scene-submitted")?;map.serialize_entry("control",&Ticket(*ticket))?;map.serialize_entry("frameWindow",window)?;map.serialize_entry("input",&(config["input"]==true))?;map.serialize_entry("inputFeedback",input_feedback)?;map.serialize_entry("mode","live-skia-viz")?;map.serialize_entry("peerId",peer)?;map.serialize_entry("producer",&config["producer"])?;map.serialize_entry("protocol",&4)?;map.serialize_entry("renderer",&config["renderer"])?;map.serialize_entry("resourceMemory",resource_memory)?;map.serialize_entry("sessionId",&config["sessionId"])?;map.serialize_entry("type","Welcome")?;},
  Self::ConsumerWelcome{config,peer,window,resource_memory,kind}=>{map.serialize_entry("ackStage","consumer-released")?;map.serialize_entry("consumerKind",kind)?;map.serialize_entry("capabilities",&["scene-consumer-v1"])?;map.serialize_entry("control",&Ticket(None))?;map.serialize_entry("frameWindow",window)?;map.serialize_entry("input",&false)?;map.serialize_entry("inputFeedback",&false)?;map.serialize_entry("mode","live-skia-viz")?;map.serialize_entry("peerId",peer)?;map.serialize_entry("producer",&config["producer"])?;map.serialize_entry("protocol",&4)?;map.serialize_entry("renderer",&config["renderer"])?;map.serialize_entry("resourceMemory",resource_memory)?;map.serialize_entry("sessionId",&config["sessionId"])?;map.serialize_entry("type","Welcome")?;},
  Self::ControlWelcome{peer,session}=>{map.serialize_entry("peerId",peer)?;map.serialize_entry("protocol",&4)?;map.serialize_entry("sessionId",session)?;map.serialize_entry("type","ControlWelcome")?;},
  Self::Release(ids)=>{map.serialize_entry("ids",ids)?;map.serialize_entry("type","ResourceRelease")?;},
  Self::Commit{epoch,frame}=>{map.serialize_entry("frameId",frame)?;map.serialize_entry("pageEpoch",epoch)?;map.serialize_entry("type","FrameCommit")?;},
  Self::Reset=>map.serialize_entry("type","ChunkCacheReset")?,
 }map.end()}
}
#[cfg(test)]mod tests{
 use super::*;
 use crate::allocation_probe::{measure,observe};
 use std::{cell::Cell,sync::Arc};
 fn fixture(serial:u64,changed:bool)->Arc<Snapshot>{
  let quad=json!({"kind":"solid","matrix":[1,0,0,0,1,0,0,0,1],"rect":[0,0,10,10],"visible":[0,0,10,10],"opacity":1,"color":[if changed{0.2}else{0.1},0.2,0.3,1]});let scene=json!({"rootPass":"root","passes":[{"id":"root","output":[0,0,10,10],"quads":vec![quad;500]}]});
  let metadata=json!({"pageEpoch":1,"viewportVersion":1,"timing":{"extra":vec![0;16000],"unicode":"中文😀\"\\\n"},"mappings":(0..512).map(|n|json!({"localId":n,"resourceId":"a".repeat(64)})).collect::<Vec<_>>(),"released":vec!["b".repeat(64);512]});snapshot(serial,scene,metadata)
 }
 fn snapshot(serial:u64,scene:Value,metadata:Value)->Arc<Snapshot>{let full_json=serde_json::to_string(&scene).unwrap();Arc::new(Snapshot{serial,scene,metadata,full_json,resources:HashMap::new(),_graph:crate::snapshot_memory::SnapshotPool::new(32*1024*1024).0.reserve(4*1024*1024).unwrap()})}
 fn old_delta(previous:&Snapshot,next:&Snapshot)->String{let old=previous.scene["passes"].as_array().unwrap();let new=next.scene["passes"].as_array().unwrap();serde_json::to_string(&json!({"rootPass":next.scene["rootPass"],"order":new.iter().map(|p|p["id"].clone()).collect::<Vec<_>>(),"upsert":new.iter().filter(|p|!old.iter().any(|o|o==*p)).collect::<Vec<_>>(),"remove":old.iter().filter(|p|!new.iter().any(|n|n["id"]==p["id"])).map(|p|p["id"].clone()).collect::<Vec<_>>()})).unwrap()}
 fn old_frame(snapshot:&Snapshot,id:u64,base:Option<u64>,delta:Option<&str>)->String{let mut frame=snapshot.metadata.clone();for key in ["mappings","released"]{frame.as_object_mut().unwrap().remove(key);}frame["protocol"]=json!(4);frame["frameId"]=json!(id);frame["baseFrameId"]=json!(base);let header=serde_json::to_string(&frame).unwrap();format!("{{\"type\":\"SceneUpdate\",\"frame\":{{{},\"{}\":{}}}}}",&header[1..header.len()-1],if delta.is_some(){"delta"}else{"scene"},delta.unwrap_or(&snapshot.full_json))}
 #[test]fn borrowed_full_and_delta_frames_preserve_exact_wire_and_avoid_builder_graphs(){
  let old=fixture(1,false);let new=fixture(2,true);let pool=Pool::new(DATA_BYTES,CONTROL_BYTES);let mut cache=pool.cache().unwrap();
  for full in [true,false]{
   let delta=if full{None}else{Some(cache.delta(&pool,&old,&new).unwrap())};let before=pool.data.used();let(packet,live,peak)=observe(||pool.frame(&new,2,if full{None}else{Some(1)},delta.as_ref()).unwrap());let reservation=pool.data.used()-before;
   assert_eq!(packet.as_str(),old_frame(&new,2,if full{None}else{Some(1)},delta.as_ref().map(|x|x.as_str())));assert!(peak<=reservation);assert_eq!(packet.len(),if full{93744}else{93770});println!("gateway-packet-after: full={full} wire_bytes={} live={live} requested_peak={peak} reservation={reservation}",packet.len());drop(packet);assert_eq!(pool.data.used(),before);
  }
  let mixed=snapshot(3,json!({"rootPass":"r","passes":[]}),json!({"a":true,"baseFrameId":100,"frameId":"overridden","mappings":vec![0;1000],"protocol":99,"released":[1,2],"z":"中文😀\u{0}"}));let packet=pool.frame(&mixed,u64::MAX,None,None).unwrap();assert_eq!(packet.as_str(),old_frame(&mixed,u64::MAX,None,None));drop(packet);cache.clear();drop(cache);assert_eq!(pool.data.used(),0);
 }
 #[test]fn borrowed_delta_matches_add_remove_reorder_changed_and_unchanged_passes(){
  let old=snapshot(1,json!({"rootPass":"a","passes":[{"id":"a","x":[1,2]},{"id":"b","x":2},{"id":"gone","x":3}]}),json!({}));let pool=Pool::new(DATA_BYTES,CONTROL_BYTES);let mut cache=pool.cache().unwrap();
  for(n,scene)in [old.scene.clone(),json!({"rootPass":"a","passes":[{"id":"b","x":3},{"id":"new😀","x":4},{"id":"a","x":[1,2]}]}),json!({"rootPass":"","passes":[]})].into_iter().enumerate(){let new=snapshot(n as u64+2,scene,json!({}));let delta=cache.delta(&pool,&old,&new).unwrap();assert_eq!(delta.as_str(),old_delta(&old,&new));assert_eq!(serde_json::from_str::<Value>(&delta).unwrap()["rootPass"],new.scene["rootPass"]);}
 }
 #[test]fn actual_delta_miss_hit_and_fixed_cache_layout_fit_reservations_and_final_aliases(){
  let old=fixture(1,false);let new=fixture(2,true);let pool=Pool::new(DATA_BYTES,CONTROL_BYTES);let(mut cache,metadata_peak)=measure(||pool.cache().unwrap());assert!(metadata_peak<=CACHE_BYTES);println!("gateway-cache-layout: requested_peak={metadata_peak} reservation={CACHE_BYTES}");
  let before=pool.data.used();let(text,live,peak)=observe(||cache.delta(&pool,&old,&new).unwrap());let reservation=pool.data.used()-before;assert!(peak<=reservation);println!("gateway-delta-after-miss: wire_bytes={} live={live} requested_peak={peak} reservation={reservation}",text.len());
  let(alias,peak)=measure(||cache.delta(&pool,&old,&new).unwrap());assert_eq!(alias.as_ptr(),text.as_ptr());assert_eq!(peak,0);println!("gateway-delta-after-hit: wire_bytes={} requested_peak={peak}",alias.len());cache.clear();assert_eq!(pool.data.used(),CACHE_BYTES+reservation);drop(cache);assert_eq!(pool.data.used(),reservation);drop(text);assert_eq!(pool.data.used(),reservation);drop(alias);assert_eq!(pool.data.used(),0);
 }
 #[test]fn cache_publish_clear_and_hard_table_ceiling_never_grow_unadmitted_buckets(){
  let old=snapshot(0,json!({"rootPass":"root","passes":[]}),json!({}));let pool=Pool::new(DATA_BYTES,CONTROL_BYTES);let mut cache=pool.cache().unwrap();let capacity=cache.values.capacity();
  for serial in 1..=65{let next=snapshot(serial,old.scene.clone(),json!({}));cache.delta(&pool,&old,&next).unwrap();}assert_eq!(cache.values.len(),65);cache.on_publish();assert!(cache.values.is_empty());assert_eq!(pool.data.used(),CACHE_BYTES);assert_eq!(cache.values.capacity(),capacity);
  for serial in 100..=100+CACHE_CAPACITY as u64{let next=snapshot(serial,old.scene.clone(),json!({}));cache.delta(&pool,&old,&next).unwrap();}assert_eq!(cache.values.len(),1);assert_eq!(cache.values.capacity(),capacity);drop(cache);assert_eq!(pool.data.used(),0);
 }
 #[test]fn pressure_reclaims_evictable_cache_but_not_alias_or_table_credit(){
  let old=fixture(1,false);let next=fixture(2,true);let more=fixture(3,true);let pool=Pool::new(256*1024,CONTROL_BYTES);let mut cache=pool.cache().unwrap();let first=cache.delta(&pool,&old,&next).unwrap();let second=cache.delta(&pool,&old,&more).unwrap();assert!(!pool.ready());let used=pool.data.used();assert_eq!(cache.reclaim(&pool),2);assert!(cache.values.is_empty());assert_eq!(pool.data.used(),used,"Eviction must not release outside final aliases");assert!(!pool.ready());drop(second);assert!(pool.ready());drop(first);assert_eq!(pool.data.used(),CACHE_BYTES);assert_eq!(cache.reclaim(&pool),0);drop(cache);assert_eq!(pool.data.used(),0);
 }
 #[test]fn exact_scene_boundary_and_overflow_count_before_large_packet_allocation(){
  let pool=Pool::new(DATA_BYTES,CONTROL_BYTES);let scene=json!({"rootPass":"root","passes":[]});let mut value=snapshot(1,scene,json!({"pageEpoch":1,"timing":{"padding":""}}));let overhead=pool.frame(&value,1,None,None).unwrap().len();Arc::get_mut(&mut value).unwrap().metadata["timing"]["padding"]=json!("x".repeat(SCENE_BYTES-overhead));
  let(packet,peak)=measure(||pool.frame(&value,1,None,None).unwrap());assert_eq!(packet.len(),SCENE_BYTES);assert!(peak<=pool.data.used());drop(packet);assert_eq!(pool.data.used(),0);
  Arc::get_mut(&mut value).unwrap().metadata["timing"]["padding"]=json!("x".repeat(SCENE_BYTES-overhead+1));let(result,peak)=measure(||pool.frame(&value,1,None,None));assert_eq!(result.err().unwrap(),"Frame metadata budget exceeded");assert!(peak<4096);assert_eq!(pool.data.used(),0);
 }
 #[test]fn quotas_precede_cache_or_packet_allocation_and_preserve_existing_cache_on_failure(){
  let default=Pool::new(DATA_BYTES,CONTROL_BYTES);let held=default.data.reserve(80*1024*1024).unwrap();assert!(default.ready());assert_eq!(default.stats()["data"]["ready"],true);assert_eq!(default.stats()["data"]["headroom"],32*1024*1024);drop(held);
  let tiny=Pool::new(CACHE_BYTES-1,CONTROL_BYTES);let(result,peak)=measure(||tiny.cache());assert_eq!(result.err().unwrap_or_else(||panic!("cache admitted")),PRESSURE);assert!(peak<4096);assert_eq!(tiny.data.used(),0);
  let pool=Pool::new(CACHE_BYTES+SIZING+512,CONTROL_BYTES);let mut cache=pool.cache().unwrap();let old=snapshot(1,json!({"rootPass":"root","passes":[]}),json!({}));let next=snapshot(2,old.scene.clone(),json!({}));let text=cache.delta(&pool,&old,&next).unwrap();let used=pool.data.used();let big=fixture(3,true);let(result,peak)=measure(||cache.delta(&pool,&old,&big));assert_eq!(result.err().unwrap(),PRESSURE);assert!(peak<4096);assert_eq!(pool.data.used(),used);assert_eq!(cache.values.len(),1);let alias=cache.delta(&pool,&old,&next).unwrap();assert_eq!(alias.as_ptr(),text.as_ptr());
  let held=pool.data.reserve(pool.data.limit()-pool.data.used()).unwrap();let notification=pool.notification(Lane::Control,&Notification::ControlWelcome{peer:"native-test",session:&json!("session")}).unwrap();assert!(notification.contains("ControlWelcome"));drop(notification);assert_eq!(pool.control.used(),0);drop(held);drop(alias);drop(text);drop(cache);assert_eq!(pool.data.used(),0);
 }
 #[test]fn borrowed_notifications_preserve_exact_json_and_dense_renderer_allocates_only_final_text(){
  let config=json!({"input":true,"producer":"中文😀\"\\","renderer":{"extra":vec![0;16000]},"sessionId":"session"});let pool=Pool::new(DATA_BYTES,CONTROL_BYTES);let ids=vec!["a\"中文".to_owned(),"b".to_owned()];let epoch=json!(2);
  for ticket in [None,Some("ticket\"😀")]{let note=Notification::Welcome{config:&config,peer:"native-1",window:6,input_feedback:true,resource_memory:true,ticket};let expected=json!({"type":"Welcome","protocol":4,"renderer":config["renderer"],"producer":config["producer"],"mode":"live-skia-viz","input":true,"inputFeedback":true,"resourceMemory":true,"peerId":"native-1","sessionId":config["sessionId"],"frameWindow":6,"ackStage":"scene-submitted","control":ticket.map(|t|json!({"ticket":t}))});let(text,peak)=measure(||pool.notification(Lane::Data,&note).unwrap());assert_eq!(text.as_str(),expected.to_string());assert!(peak<=pool.data.used());println!("gateway-notification-layout: wire_bytes={} requested_peak={peak} reservation={}",text.len(),pool.data.used());drop(text);assert_eq!(pool.data.used(),0);}
  for(note,expected)in [(Notification::ControlWelcome{peer:"native-1",session:&config["sessionId"]},json!({"type":"ControlWelcome","protocol":4,"peerId":"native-1","sessionId":config["sessionId"]})),(Notification::Release(&ids),json!({"type":"ResourceRelease","ids":ids})),(Notification::Commit{epoch:&epoch,frame:u64::MAX},json!({"type":"FrameCommit","pageEpoch":epoch,"frameId":u64::MAX})),(Notification::Reset,json!({"type":"ChunkCacheReset"}))]{let text=pool.notification(Lane::Control,&note).unwrap();assert_eq!(text.as_str(),expected.to_string());drop(text);assert_eq!(pool.control.used(),0);}
 }
 struct Changing(Cell<usize>);
 impl Serialize for Changing{fn serialize<S:Serializer>(&self,s:S)->std::result::Result<S::Ok,S::Error>{let n=self.0.get();self.0.set(n+1);if n==0{s.serialize_str("x")}else{s.serialize_str("a much longer string")}}}
 #[test]fn changed_serializer_and_actual_library_copy_return_only_ended_gateway_owners(){
  let pool=Pool::new(DATA_BYTES,CONTROL_BYTES);let result=pool.json(Lane::Data,SCENE_BYTES,&Changing(Cell::new(0)));assert_eq!(result.err().unwrap(),"Gateway packet changed during serialization");assert_eq!(pool.data.used(),0);
  struct Blocked;impl io::Read for Blocked{fn read(&mut self,_:&mut[u8])->io::Result<usize>{Err(io::ErrorKind::WouldBlock.into())}}impl Write for Blocked{fn write(&mut self,_:&[u8])->io::Result<usize>{Err(io::ErrorKind::WouldBlock.into())}fn flush(&mut self)->io::Result<()>{Ok(())}}
  let ws_pool=crate::ws_memory::Pool::new(crate::ws_memory::DEFAULT_BYTES);let mut admission=ws_pool.connection().unwrap();admission.role(crate::ws_memory::Kind::Data).unwrap();let mut ws=crate::ws_memory::Socket::new(tungstenite::WebSocket::from_raw_socket(Blocked,tungstenite::protocol::Role::Server,Some(crate::ws_memory::config())),admission);let packet=pool.notification(Lane::Data,&Notification::Reset).unwrap();assert!(pool.data.used()>0);assert!(matches!(ws.write(tungstenite::Message::Text(packet)),Err(tungstenite::Error::Io(e))if e.kind()==io::ErrorKind::WouldBlock));assert_eq!(pool.data.used(),0);assert!(ws_pool.stats()["bytes"].as_u64().unwrap()>0);drop(ws);assert_eq!(ws_pool.stats()["bytes"],0);
 }
}
