use crate::{budget::{Budget,Lease,OwnedVec},scene::{Snapshot,Resource}};
use serde::{Serialize,Serializer,ser::{SerializeMap,SerializeSeq}};
use serde_json::{Value,json};
use std::{collections::HashMap,io::{self,Write},sync::{Arc,OnceLock}};

pub const PRESSURE:&str="RPC output allocation budget exceeded";
pub const DATA_BYTES:usize=128*1024*1024;
pub const CONTROL_BYTES:usize=8*1024*1024;
pub const MAX_PACKET:usize=90*1024*1024;
pub const MAX_CONTROL:usize=256*1024;
const SIZING:usize=4096;
const FRAMING:usize=8192;
#[derive(Clone,Copy)]pub enum Lane{Data,Control}
#[derive(Debug,Clone,Copy,PartialEq,Eq)]pub enum Failure{Pressure,PacketLimit,Changed,Allocation,Transport}
impl Failure{
 pub fn message(self)->&'static str{match self{Self::Pressure=>PRESSURE,Self::PacketLimit=>"RPC output packet limit",Self::Changed=>"RPC output changed during serialization",Self::Allocation=>"RPC output backing allocation failed",Self::Transport=>"RPC output transport failed"}}
 pub fn code(self)->&'static str{match self{Self::Pressure|Self::Allocation=>"RESOURCE_BUDGET_PRESSURE",Self::PacketLimit=>"OUTPUT_PACKET_LIMIT",Self::Changed=>"INVALID_RESPONSE",Self::Transport=>"OUTPUT_TRANSPORT"}}
}
#[derive(Clone)]pub struct OutputPool{pub data:Budget,pub control:Budget,_framing:Arc<Lease>}
// Exact packet data is freed before either byte or sizing credit returns.
pub struct Packet{data:OwnedVec,_sizing:Lease}
impl Packet{
 pub fn write_to(&self,writer:&mut impl Write)->io::Result<()>{writer.write_all(self.data.as_ref())?;writer.flush()}
 #[cfg(test)]fn bytes(&self)->&[u8]{self.data.as_ref()}
}
static GLOBAL:OnceLock<OutputPool>=OnceLock::new();
pub fn global()->&'static OutputPool{GLOBAL.get_or_init(||OutputPool::new(DATA_BYTES,CONTROL_BYTES))}
pub fn configure()->Result<&'static OutputPool,String>{
 let read=|name:&str,default,min,max|->Result<usize,String>{let bytes=match std::env::var(name){Ok(value)=>value.parse::<usize>().map_err(|_|format!("Invalid {name}"))?,Err(_)=>default};if !(min..=max).contains(&bytes){return Err(format!("Invalid {name} range"));}Ok(bytes)};
 let data=read("REMOTE_PAINT_RPC_OUTPUT_BYTES",DATA_BYTES,1024*1024,2*1024*1024*1024)?;
 let control=read("REMOTE_PAINT_RPC_OUTPUT_CONTROL_BYTES",CONTROL_BYTES,256*1024,16*1024*1024)?;
 GLOBAL.set(OutputPool::new(data,control)).map_err(|_|"Broker output already configured")?;Ok(global())
}
impl OutputPool{
 pub fn new(data:usize,control:usize)->Self{
  let control=Budget::scoped(control,PRESSURE,"rpc-output-control");
  // Shared fixed framing/stdio slack stays reserved for this emitter's life;
  // per-packet sizing and backing have their own overlapping owners below.
  let framing=Arc::new(control.reserve(FRAMING).expect("Output control framing headroom"));
  Self{data:Budget::scoped(data,PRESSURE,"rpc-output-data"),control,_framing:framing}
 }
 fn budget(&self,lane:Lane)->&Budget{match lane{Lane::Data=>&self.data,Lane::Control=>&self.control}}
 pub fn encode<T:Serialize+?Sized>(&self,lane:Lane,value:&T)->Result<Packet,Failure>{
  let budget=self.budget(lane);let sizing=budget.reserve(SIZING).map_err(|_|Failure::Pressure)?;
  let mut count=Counter{bytes:0,limit:match lane{Lane::Data=>MAX_PACKET,Lane::Control=>MAX_CONTROL},over:false};
  serde_json::to_writer(&mut count,value).map_err(|_|if count.over{Failure::PacketLimit}else{Failure::Changed})?;
  let capacity=count.bytes.checked_add(4).ok_or(Failure::PacketLimit)?;
  let mut data=budget.buffer(capacity).map_err(|error|if error==PRESSURE{Failure::Pressure}else{Failure::Allocation})?;
  data.extend((count.bytes as u32).to_be_bytes());
  serde_json::to_writer(Exact(&mut data),value).map_err(|_|Failure::Changed)?;
  if data.len()!=capacity{return Err(Failure::Changed);}
  Ok(Packet{data,_sizing:sizing})
 }
 pub fn send<T:Serialize+?Sized>(&self,lane:Lane,value:&T)->Result<(),Failure>{
  let packet=self.encode(lane,value)?;let stdout=io::stdout();let mut writer=stdout.lock();
  packet.write_to(&mut writer).map_err(|_|Failure::Transport)
 }
 pub fn ready(&self)->bool{self.data.used()<=self.data.limit()/2&&self.control.used()<=self.control.limit()/2}
 pub fn stats(&self)->Value{json!({"scope":"rpc-output-packet-pool","data":self.data.stats(),"control":self.control.stats(),"framingBytes":FRAMING,"maximumPacket":MAX_PACKET,"maximumControlPacket":MAX_CONTROL,"ready":self.ready()})}
}
struct Counter{bytes:usize,limit:usize,over:bool}
impl Write for Counter{
 fn write(&mut self,bytes:&[u8])->io::Result<usize>{match self.bytes.checked_add(bytes.len()).filter(|n|*n<=self.limit){Some(next)=>{self.bytes=next;Ok(bytes.len())},None=>{self.over=true;Err(io::Error::other("RPC output packet limit"))}}}
 fn flush(&mut self)->io::Result<()>{Ok(())}
}
struct Exact<'a>(&'a mut OwnedVec);
impl Write for Exact<'_>{
 fn write(&mut self,bytes:&[u8])->io::Result<usize>{if bytes.len()>self.0.capacity()-self.0.len(){return Err(io::Error::other("RPC output size changed"));}self.0.extend(bytes);Ok(bytes.len())}
 fn flush(&mut self)->io::Result<()>{Ok(())}
}
// Event names/keys live in code; fields borrow caller-owned message/stats/IDs.
// The borrow remains alive through counting, packet admission and actual write.
#[derive(Clone,Copy)]
pub enum EventField<'a> { Text(&'a str), MaybeText(Option<&'a str>), Json(&'a Value), Bool(bool), U64(u64) }
impl Serialize for EventField<'_> {
 fn serialize<S:Serializer>(&self,serializer:S)->Result<S::Ok,S::Error>{
  match self{Self::Text(value)=>value.serialize(serializer),Self::MaybeText(value)=>value.serialize(serializer),Self::Json(value)=>value.serialize(serializer),Self::Bool(value)=>value.serialize(serializer),Self::U64(value)=>value.serialize(serializer)}
 }
}
pub struct Event<'a>(pub &'static str,pub &'a[(&'static str,EventField<'a>)]);
impl Serialize for Event<'_> {
 fn serialize<S:Serializer>(&self,serializer:S)->Result<S::Ok,S::Error>{
  // Static call-site fields are sorted, unique and cannot shadow the event.
  // Merge its key without a temporary map/vector, preserving old Value order.
  if self.1.iter().any(|(key,_)|*key=="event")||self.1.windows(2).any(|pair|pair[0].0>=pair[1].0){return Err(serde::ser::Error::custom("Invalid static event fields"));}
  let mut map=serializer.serialize_map(Some(self.1.len()+1))?;let mut named=false;
  for(key,value)in self.1{
   if !named&&*key>"event"{map.serialize_entry("event",self.0)?;named=true;}
   map.serialize_entry(key,value)?;
  }
  if !named{map.serialize_entry("event",self.0)?;}
  map.end()
 }
}
pub enum Reply<'a>{Value(&'a Value),Mapped(&'a Snapshot,bool),Error{message:&'a str,code:Option<&'a str>,budget:Option<&'a str>}}
pub struct RpcReply<'a>{pub id:&'a Value,pub reply:Reply<'a>}
impl Serialize for RpcReply<'_>{
 fn serialize<S:Serializer>(&self,serializer:S)->Result<S::Ok,S::Error>{
  let mut map=serializer.serialize_map(None)?;map.serialize_entry("id",self.id)?;
  match &self.reply{
   Reply::Value(value)=>map.serialize_entry("result",value)?,
   Reply::Mapped(snapshot,metadata_only)=>map.serialize_entry("result",&Mapped{snapshot,metadata_only:*metadata_only})?,
   Reply::Error{message,code,budget}=>{map.serialize_entry("error",message)?;map.serialize_entry("code",code)?;if let Some(budget)=budget{map.serialize_entry("budget",budget)?;}},
  }map.end()
 }
}
struct Mapped<'a>{snapshot:&'a Snapshot,metadata_only:bool}
impl Serialize for Mapped<'_>{
 fn serialize<S:Serializer>(&self,serializer:S)->Result<S::Ok,S::Error>{
  let mut map=serializer.serialize_map(Some(4))?;map.serialize_entry("serial",&self.snapshot.serial)?;
  if self.metadata_only{map.serialize_entry("scene",&())?;}else{map.serialize_entry("scene",&self.snapshot.scene)?;}
  map.serialize_entry("metadata",&self.snapshot.metadata)?;map.serialize_entry("resources",&Summaries(&self.snapshot.resources))?;map.end()
 }
}
struct Summaries<'a>(&'a HashMap<String,Arc<Resource>>);
impl Serialize for Summaries<'_>{
 fn serialize<S:Serializer>(&self,serializer:S)->Result<S::Ok,S::Error>{let mut seq=serializer.serialize_seq(Some(self.0.len()))?;for(id,resource)in self.0{seq.serialize_element(&Summary{id,bytes:resource.payload.len()})?;}seq.end()}
}
struct Summary<'a>{id:&'a str,bytes:usize}
impl Serialize for Summary<'_>{
 fn serialize<S:Serializer>(&self,serializer:S)->Result<S::Ok,S::Error>{let mut map=serializer.serialize_map(Some(2))?;map.serialize_entry("id",self.id)?;map.serialize_entry("bytes",&self.bytes)?;map.end()}
}

#[cfg(test)]mod tests{
 use super::*;
 use base64::{Engine,engine::general_purpose::STANDARD};
 use std::{cell::Cell,sync::mpsc,thread,time::Duration};
 fn fixture(bytes:usize,picture:bool)->(crate::scene::Mapper,Arc<Snapshot>){
  let rect=json!([0,0,100,100]);let mut capture=json!({"captureId":"output-baseline","producer":"output-baseline","timing":{"padding":"x".repeat(bytes)},"resources":[],"viz":{"captureId":"output-baseline","namespace":[1,2],"passes":[{"id":"root","output":rect,"quads":[{"kind":"solid","matrix":[1,0,0,0,1,0,0,0,1],"rect":rect,"visible":rect,"opacity":1,"color":[0.1,0.2,0.3,1]}]}]}});
  if picture{
   let mut payload=vec![0;32];payload[..8].copy_from_slice(b"skiapict");capture["resources"]=json!([{"localId":1,"quadScale":1,"width":100,"height":100,"skp":STANDARD.encode(payload)}]);
   let quad=&mut capture["viz"]["passes"][0]["quads"][0];quad["kind"]=json!("picture");quad["localId"]=json!(1);quad["namespace"]=json!([1,2]);quad["contentOrigin"]=json!([0,0]);capture["timing"]["unicode"]=json!("中文😀\u{0}\\\"\n");
  }
  let mut mapper=crate::scene::Mapper::new();let snapshot=mapper.map(&capture,1,&json!({"cssWidth":100,"cssHeight":100,"deviceScaleFactor":1}),1,0).unwrap();(mapper,snapshot)
 }
 #[test]fn borrowed_map_and_metadata_only_replies_preserve_json_and_resource_summaries(){
  let(_,snapshot)=fixture(16,true);let pool=OutputPool::new(DATA_BYTES,CONTROL_BYTES);let id=json!("reply\"中文😀");
  for metadata_only in [false,true]{
   let packet=pool.encode(Lane::Data,&RpcReply{id:&id,reply:Reply::Mapped(&snapshot,metadata_only)}).unwrap();let value:Value=serde_json::from_slice(&packet.bytes()[4..]).unwrap();
   assert_eq!(value["id"],id);assert_eq!(value["result"]["serial"],snapshot.serial);assert_eq!(value["result"]["metadata"],snapshot.metadata);
   assert_eq!(value["result"]["scene"],if metadata_only{Value::Null}else{snapshot.scene.clone()});let(hash,resource)=snapshot.resources.iter().next().unwrap();assert_eq!(value["result"]["resources"],json!([{"id":hash,"bytes":resource.payload.len()}]));
   assert_eq!(u32::from_be_bytes(packet.bytes()[..4].try_into().unwrap())as usize,packet.bytes().len()-4);drop(packet);assert_eq!(pool.data.used(),0);
  }
 }
 #[test]fn borrowed_map_layout_allocates_only_one_exact_packet_without_result_graph_clones(){
  let(mapper,snapshot)=fixture(2*1024*1024,false);let before=mapper.snapshot_pool.0.used();let pool=OutputPool::new(DATA_BYTES,CONTROL_BYTES);let id=json!(1);
  let(packet,peak)=crate::allocation_probe::measure(||pool.encode(Lane::Data,&RpcReply{id:&id,reply:Reply::Mapped(&snapshot,false)}).unwrap());
  assert_eq!(mapper.snapshot_pool.0.used(),before);assert_eq!(packet.data.capacity(),packet.bytes().len());assert_eq!(packet.bytes().len()-4,2_097_826);assert!(peak<=pool.data.used());
  println!("rpc-output-borrowed-layout: serialized_bytes={} packet_capacity={} requested_peak={} reservation={}",packet.bytes().len()-4,packet.data.capacity(),peak,pool.data.used());drop(packet);assert_eq!(pool.data.used(),0);
 }
 #[test]fn exact_ninety_mib_default_packet_and_over_limit_preallocation_denial(){
  let pool=OutputPool::new(DATA_BYTES,CONTROL_BYTES);let id=json!(1);let empty=json!("");let overhead=serde_json::to_vec(&RpcReply{id:&id,reply:Reply::Value(&empty)}).unwrap().len();
  let value=json!("x".repeat(MAX_PACKET-overhead));let(packet,peak)=crate::allocation_probe::measure(||pool.encode(Lane::Data,&RpcReply{id:&id,reply:Reply::Value(&value)}).unwrap());
  assert_eq!(packet.data.capacity(),MAX_PACKET+4);assert_eq!(packet.bytes().len(),MAX_PACKET+4);assert!(peak<=pool.data.used());println!("rpc-output-max-layout: packet_capacity={} requested_peak={} reservation={}",packet.data.capacity(),peak,pool.data.used());drop(packet);assert_eq!(pool.data.used(),0);drop(value);
  let oversized=json!("x".repeat(MAX_PACKET));let(result,peak)=crate::allocation_probe::measure(||pool.encode(Lane::Data,&RpcReply{id:&id,reply:Reply::Value(&oversized)}));assert_eq!(result.err().unwrap(),Failure::PacketLimit);assert!(peak<4096);assert_eq!(pool.data.used(),0);
 }
 struct Held{entered:Option<mpsc::Sender<()>>,resume:mpsc::Receiver<()>}
 impl Write for Held{
  fn write(&mut self,bytes:&[u8])->io::Result<usize>{if let Some(entered)=self.entered.take(){entered.send(()).unwrap();self.resume.recv_timeout(Duration::from_secs(2)).unwrap();}Ok(bytes.len())}
  fn flush(&mut self)->io::Result<()>{Ok(())}
 }
 #[test]fn a_blocked_write_keeps_data_credit_while_reserved_control_admission_still_works(){
  let value=json!("x".repeat(8192));let length=serde_json::to_vec(&value).unwrap().len();let limit=length+4+128+SIZING;let pool=OutputPool::new(limit,64*1024);
  let packet=pool.encode(Lane::Data,&value).unwrap();assert_eq!(pool.data.used(),limit);let(tx,rx)=mpsc::channel();let(resume_tx,resume_rx)=mpsc::channel();
  let child=thread::spawn(move||{packet.write_to(&mut Held{entered:Some(tx),resume:resume_rx}).unwrap();});rx.recv_timeout(Duration::from_secs(2)).unwrap();assert_eq!(pool.data.used(),limit);assert_eq!(pool.encode(Lane::Data,&true).err().unwrap(),Failure::Pressure);
  let control=pool.encode(Lane::Control,&json!({"result":true})).unwrap();control.write_to(&mut io::sink()).unwrap();drop(control);assert_eq!(pool.control.used(),FRAMING);assert_eq!(pool.data.used(),limit);resume_tx.send(()).unwrap();child.join().unwrap();assert_eq!(pool.data.used(),0);
  // This proves separate reservation,not overtaking a real stdout FIFO lock.
 }
 struct PartialFailure{wrote:bool}
 impl Write for PartialFailure{
  fn write(&mut self,bytes:&[u8])->io::Result<usize>{if self.wrote{return Err(io::ErrorKind::BrokenPipe.into());}self.wrote=true;Ok(bytes.len().min(2))}
  fn flush(&mut self)->io::Result<()>{Ok(())}
 }
 #[test]fn partial_transport_failure_does_not_release_a_still_owned_packet(){
  let pool=OutputPool::new(64*1024,64*1024);let packet=pool.encode(Lane::Data,&json!({"result":"retained"})).unwrap();let before=pool.data.used();assert!(packet.write_to(&mut PartialFailure{wrote:false}).is_err());assert_eq!(pool.data.used(),before);drop(packet);assert_eq!(pool.data.used(),0);
 }
 struct Changes{calls:Cell<usize>,grow:bool}
 impl Serialize for Changes{
  fn serialize<S:Serializer>(&self,serializer:S)->Result<S::Ok,S::Error>{let call=self.calls.get();self.calls.set(call+1);serializer.serialize_str(if(call==0)==self.grow{""}else{"different"})}
 }
 #[test]fn changed_serialized_length_is_rejected_before_any_packet_can_be_written(){
  let pool=OutputPool::new(64*1024,64*1024);for grow in [false,true]{let value=Changes{calls:Cell::new(0),grow};assert_eq!(pool.encode(Lane::Data,&value).err().unwrap(),Failure::Changed);assert_eq!(pool.data.used(),0);}
 }
}

#[cfg(test)]
mod event_tests {
 use super::*;
 use EventField::{Bool,Json,MaybeText,Text};
 fn same(event:Event<'_>,expected:Value){
  let pool=OutputPool::new(64*1024,CONTROL_BYTES);let packet=pool.encode(Lane::Control,&event).unwrap();
  assert_eq!(&packet.bytes()[4..],expected.to_string().as_bytes());drop(packet);assert_eq!(pool.control.used(),FRAMING);
 }
 #[test]fn borrowed_event_schemas_preserve_every_absent_null_code_and_sorted_key_case(){
  let message=json!({"type":"Input","text":"中文😀\u{0}\\\"\n","nested":[true,null,{}]});let stats=json!({"full":1,"ackRttMs":1.25});
  same(Event("Control",&[("message",Json(&message)),("peerId",Text("native-123"))]),json!({"event":"Control","peerId":"native-123","message":message}));
  same(Event("PeerStats",&[("peerId",Text("native-123")),("stats",Json(&stats))]),json!({"event":"PeerStats","peerId":"native-123","stats":stats}));
  for name in ["PeerClosed","ControlClosed"]{same(Event(name,&[("peerId",Text("native-123"))]),json!({"event":name,"peerId":"native-123"}));}
  for feedback in [false,true]{same(Event("PeerReady",&[("inputFeedback",Bool(feedback)),("peerId",Text("native-123"))]),json!({"event":"PeerReady","inputFeedback":feedback,"peerId":"native-123"}));}
  same(Event("VizReady",&[("captureId",Text("capture-中文😀"))]),json!({"event":"VizReady","captureId":"capture-中文😀"}));
  for code in [None,Some("RESOURCE_BUDGET_PRESSURE")]{same(Event("VizReady",&[("captureId",Text("capture")),("code",MaybeText(code)),("error",Text("failure"))]),json!({"event":"VizReady","captureId":"capture","error":"failure","code":code}));}
  same(Event("VizRejected",&[]),json!({"event":"VizRejected"}));
  same(Event("VizRejected",&[("captureId",Text("capture")),("reason",Text("unexpected-scene"))]),json!({"event":"VizRejected","captureId":"capture","reason":"unexpected-scene"}));
  same(Event("VizRejected",&[("reason",Text("bad fault"))]),json!({"event":"VizRejected","reason":"bad fault"}));
  for id in [None,Some("capture")]{for code in [None,Some("INPUT_BUDGET_PRESSURE")]{same(Event("VizRejected",&[("captureId",MaybeText(id)),("code",MaybeText(code)),("reason",Text("rejected"))]),json!({"event":"VizRejected","captureId":id,"reason":"rejected","code":code}));}}
 }
 #[test]fn dense_control_and_peer_stats_wrappers_allocate_nothing_and_packets_fit_their_owners(){
  let message=json!({"type":"Input","events":vec![0u8;16300],"text":"中文😀"});let source_bytes=message.to_string().len();assert_eq!(source_bytes,32647);let source=message["events"].as_array().unwrap().as_ptr();
  let(fields,builder_peak)=crate::allocation_probe::measure(||[("message",Json(&message)),("peerId",Text("native-123"))]);assert_eq!(builder_peak,0);let event=Event("Control",&fields);let pool=OutputPool::new(64*1024,CONTROL_BYTES);
  let(packet,peak)=crate::allocation_probe::measure(||pool.encode(Lane::Control,&event).unwrap());let reserved=pool.control.used()-FRAMING;assert!(peak<=reserved);assert_eq!(message["events"].as_array().unwrap().as_ptr(),source);
  assert_eq!(serde_json::from_slice::<Value>(&packet.bytes()[4..]).unwrap()["message"],message);println!("control-event-borrowed-layout: input_bytes={source_bytes} builder_peak={builder_peak} packet_capacity={} requested_peak={peak} reservation={reserved}",packet.data.capacity());drop(packet);assert_eq!(pool.control.used(),FRAMING);
  let stats=json!({"full":1,"delta":2,"resources":3,"bytes":4,"coalesced":5,"slowDisconnects":0,"maxInflight":2,"ackRttMs":1.25,"maxPendingBytes":60000,"pendingBytes":0,"maxInflightBytes":120000});
  let(fields,builder_peak)=crate::allocation_probe::measure(||[("peerId",Text("native-123")),("stats",Json(&stats))]);assert_eq!(builder_peak,0);let event=Event("PeerStats",&fields);
  let(packet,peak)=crate::allocation_probe::measure(||pool.encode(Lane::Control,&event).unwrap());let reserved=pool.control.used()-FRAMING;assert!(peak<=reserved);assert_eq!(serde_json::from_slice::<Value>(&packet.bytes()[4..]).unwrap()["stats"],stats);
  println!("peer-stats-event-borrowed-layout: stats_bytes={} builder_peak={builder_peak} packet_capacity={} requested_peak={peak} reservation={reserved}",stats.to_string().len(),packet.data.capacity());drop(packet);assert_eq!(pool.control.used(),FRAMING);
 }
 #[test]fn invalid_static_fields_and_oversized_events_fail_before_packet_allocation(){
  let pool=OutputPool::new(64*1024,CONTROL_BYTES);
  for fields in [vec![("event",Text("shadow"))],vec![("z",Text("last")),("a",Text("first"))],vec![("x",Text("one")),("x",Text("two"))]]{
   assert_eq!(pool.encode(Lane::Control,&Event("Invalid",&fields)).err().unwrap(),Failure::Changed);assert_eq!(pool.control.used(),FRAMING);
  }
  let message=json!("x".repeat(MAX_CONTROL));let fields=[("message",Json(&message)),("peerId",Text("native-123"))];
  let(result,peak)=crate::allocation_probe::measure(||pool.encode(Lane::Control,&Event("Control",&fields)));assert_eq!(result.err().unwrap(),Failure::PacketLimit);assert!(peak<4096);assert_eq!(pool.control.used(),FRAMING);
  let empty=json!("");let overhead=serde_json::to_vec(&Event("Control",&[("message",Json(&empty)),("peerId",Text("native-123"))])).unwrap().len();let message=json!("x".repeat(MAX_CONTROL-overhead));
  let packet=pool.encode(Lane::Control,&Event("Control",&[("message",Json(&message)),("peerId",Text("native-123"))])).unwrap();assert_eq!(packet.bytes().len(),MAX_CONTROL+4);drop(packet);assert_eq!(pool.control.used(),FRAMING);
  let constrained=OutputPool::new(64*1024,FRAMING+SIZING+128);let(result,peak)=crate::allocation_probe::measure(||constrained.encode(Lane::Control,&Event("Control",&[("message",Json(&message)),("peerId",Text("native-123"))])));assert_eq!(result.err().unwrap(),Failure::Pressure);assert!(peak<4096);assert_eq!(constrained.control.used(),FRAMING);
 }
}
