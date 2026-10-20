use crate::{budget::{Budget,Lease},scene::Result};
use serde_json::{Value,json};
use std::{ops::Deref,sync::{Arc,OnceLock,atomic::{AtomicUsize,Ordering}}};

pub const PRESSURE:&str="Gateway state allocation budget exceeded";
pub const DEFAULT_BYTES:usize=512*1024*1024;
pub const REGISTRY_BYTES:usize=64*1024;
pub const ROUTE_BYTES:usize=16*1024;
pub const PEER_BYTES:usize=64*1024*1024;
pub const FRAME_CHUNKS:usize=64*1024*1024/(32*1024)+256*(2*256+1);
pub const KNOWN_CHUNKS:usize=32768+FRAME_CHUNKS;
#[derive(Clone,Copy)]enum Kind{Config=0,Registry=1,Route=2,Peer=3}
struct Counters{bytes:[AtomicUsize;4],owners:[AtomicUsize;4]}
#[derive(Clone)]pub struct Pool{budget:Budget,counters:Arc<Counters>}
pub struct Reservation{_lease:Lease,counters:Arc<Counters>,kind:Kind,bytes:usize}
impl Drop for Reservation{fn drop(&mut self){let index=self.kind as usize;self.counters.bytes[index].fetch_sub(self.bytes,Ordering::AcqRel);self.counters.owners[index].fetch_sub(1,Ordering::AcqRel);}}
// The original admitted RPC graph is moved,never cloned. Data precedes credit.
pub struct Config{value:Value,_admission:Reservation}
impl Deref for Config{type Target=Value;fn deref(&self)->&Value{&self.value}}
static GLOBAL:OnceLock<Pool>=OnceLock::new();
pub fn global()->&'static Pool{GLOBAL.get_or_init(||Pool::new(DEFAULT_BYTES))}
pub fn configure()->Result<&'static Pool>{
 let bytes=match std::env::var("REMOTE_PAINT_GATEWAY_STATE_BYTES"){Ok(value)=>value.parse::<usize>().map_err(|_|"Invalid REMOTE_PAINT_GATEWAY_STATE_BYTES")?,Err(_)=>DEFAULT_BYTES};
 if !(1024*1024..=2*1024*1024*1024).contains(&bytes){return Err("Gateway state pool must be 1MiB..2GiB".into());}
 GLOBAL.set(Pool::new(bytes)).map_err(|_|"Gateway state pool already configured")?;Ok(global())
}
impl Pool{
 pub fn new(bytes:usize)->Self{Self{budget:Budget::scoped(bytes,PRESSURE,"gateway-state-pool"),counters:Arc::new(Counters{bytes:std::array::from_fn(|_|AtomicUsize::new(0)),owners:std::array::from_fn(|_|AtomicUsize::new(0))})}}
 fn reserve(&self,kind:Kind,bytes:usize)->Result<Reservation>{let lease=self.budget.reserve(bytes)?;let index=kind as usize;self.counters.bytes[index].fetch_add(bytes,Ordering::AcqRel);self.counters.owners[index].fetch_add(1,Ordering::AcqRel);Ok(Reservation{_lease:lease,counters:self.counters.clone(),kind,bytes})}
 pub fn registry(&self)->Result<Reservation>{self.reserve(Kind::Registry,REGISTRY_BYTES)}
 pub fn route(&self)->Result<Reservation>{self.reserve(Kind::Route,ROUTE_BYTES)}
 pub fn peer(&self)->Result<Reservation>{self.reserve(Kind::Peer,PEER_BYTES)}
 pub fn config(&self,value:&mut Value)->Result<Config>{let mut nodes=0;let bytes=graph(value,0,&mut nodes)?.checked_add(64*1024).ok_or(PRESSURE)?;let admission=self.reserve(Kind::Config,bytes)?;Ok(Config{value:value.take(),_admission:admission})}
 // These fixed reservations already cover future container growth/scratch.
 // Lack of room for another peer must reject its admission,not permanently
 // pause capture for existing admitted peers. Payload/parse pools gate those.
 pub fn ready(&self)->bool{self.budget.used()<=self.budget.limit()}
 pub fn stats(&self)->Value{
  let mut result=self.budget.stats();result["headroom"]=0.into();result["ready"]=self.ready().into();let available=self.budget.limit().saturating_sub(self.budget.used());result["available"]=available.into();result["canAdmitPeer"]=(available>=PEER_BYTES+ROUTE_BYTES).into();result["registryBytes"]=REGISTRY_BYTES.into();result["routeBytes"]=ROUTE_BYTES.into();result["peerBytes"]=PEER_BYTES.into();result["frameChunkUpperBound"]=FRAME_CHUNKS.into();result["knownChunkUpperBound"]=KNOWN_CHUNKS.into();
  for(kind,name)in [(Kind::Config,"config"),(Kind::Registry,"registry"),(Kind::Route,"route"),(Kind::Peer,"peer")]{let index=kind as usize;result[name]=json!({"bytes":self.counters.bytes[index].load(Ordering::Acquire),"owners":self.counters.owners[index].load(Ordering::Acquire)});}
  result["scopeNote"]="retained config capacity and fixed registry/route/per-peer container+scratch requested-layout allowance;payloads/parser/library/DNS/thread runtime/stack/OS/RSS outside".into();result
 }
}
fn add(sum:&mut usize,bytes:usize)->Result<()>{*sum=sum.checked_add(bytes).ok_or(PRESSURE)?;Ok(())}
fn times(value:usize,n:usize)->Result<usize>{value.checked_mul(n).ok_or_else(||PRESSURE.into())}
fn graph(value:&Value,depth:usize,nodes:&mut usize)->Result<usize>{
 if depth>128{return Err("Gateway config depth exceeded".into());}*nodes=nodes.checked_add(1).ok_or(PRESSURE)?;if *nodes>1_000_000{return Err(PRESSURE.into());}
 let mut bytes=768;match value{
  Value::String(text)=>add(&mut bytes,times(text.capacity(),4)?)?,
  Value::Array(values)=>{add(&mut bytes,times(values.capacity(),std::mem::size_of::<Value>())?)?;for value in values{add(&mut bytes,graph(value,depth+1,nodes)?)?;}},
  Value::Object(values)=>for(key,value)in values{add(&mut bytes,768)?;add(&mut bytes,times(key.capacity(),2)?)?;add(&mut bytes,graph(value,depth+1,nodes)?)?;},
  _=>{},
 }Ok(bytes)
}

pub fn check_snapshot(snapshot:&crate::scene::Snapshot)->Result<()>{
 let passes=snapshot.scene["passes"].as_array().ok_or("Invalid Gateway scene")?;
 let chunks=snapshot.resources.values().try_fold(0usize,|sum,resource|sum.checked_add(resource.chunks.len()).ok_or(PRESSURE))?;
 if passes.len()>64||snapshot.resources.len()>256||chunks>FRAME_CHUNKS||snapshot.resources.keys().any(|id|id.len()!=64)||snapshot.resources.values().any(|r|r.chunks.iter().any(|chunk|chunk.id.len()!=64)){return Err("Gateway snapshot exceeds admitted state bounds".into());}Ok(())
}
#[cfg(test)]mod tests{
 use super::*;
 use crate::allocation_probe::measure;
 #[test]fn moved_config_keeps_original_capacities_unknown_fields_and_final_alias_credit(){
  let mut spare=String::with_capacity(1024*1024);spare.push_str("中文😀");let mut values=Vec::with_capacity(8192);values.push(json!(1));
  let mut value=json!({"origin":"http://127.0.0.1","renderer":{"name":"fixture"},"unknown":vec![0;4000]});value.as_object_mut().unwrap().insert("spare".into(),Value::String(spare));value.as_object_mut().unwrap().insert("values".into(),Value::Array(values));let pointer=value["spare"].as_str().unwrap().as_ptr();let pool=Pool::new(32*1024*1024);
  let(config,peak)=measure(||pool.config(&mut value).unwrap());assert_eq!(peak,0);assert!(value.is_null());assert_eq!(config["spare"].as_str().unwrap().as_ptr(),pointer);assert_eq!(config["unknown"].as_array().unwrap().len(),4000);assert!(pool.stats()["config"]["bytes"].as_u64().unwrap()>=4*1024*1024+8192*std::mem::size_of::<Value>()as u64);println!("gateway-config-after-move: requested_peak={peak} retained_graph_reservation={} original_pointer=true",pool.stats()["config"]["bytes"]);
  let config=Arc::new(config);let alias=config.clone();drop(config);assert_eq!(pool.stats()["config"]["owners"],1);assert!(pool.stats()["bytes"].as_u64().unwrap()>0);assert_eq!(alias["values"][0],1);drop(alias);assert_eq!(pool.stats()["bytes"],0);assert_eq!(pool.stats()["config"]["owners"],0);
 }
 #[test]fn config_quota_and_depth_denials_do_not_move_or_clone_caller_graph(){
  let mut value=json!({"padding":"x".repeat(512*1024)});let pointer=value["padding"].as_str().unwrap().as_ptr();let pool=Pool::new(1024*1024);let(result,peak)=measure(||pool.config(&mut value));assert_eq!(result.err().unwrap(),PRESSURE);assert!(peak<4096);assert_eq!(value["padding"].as_str().unwrap().as_ptr(),pointer);assert_eq!(pool.stats()["bytes"],0);assert_eq!(pool.stats()["config"]["owners"],0);
  let mut deep=Value::Null;for _ in 0..129{deep=Value::Array(vec![deep]);}assert_eq!(pool.config(&mut deep).err().unwrap(),"Gateway config depth exceeded");assert!(deep.is_array());assert_eq!(pool.stats()["bytes"],0);
 }
 #[test]fn fixed_state_admission_separates_existing_capture_readiness_from_new_peer_room(){
  let pool=Pool::new(PEER_BYTES+REGISTRY_BYTES+ROUTE_BYTES);let registry=pool.registry().unwrap();let route=pool.route().unwrap();let(peer,peak)=measure(||pool.peer().unwrap());assert_eq!(peak,0);let stats=pool.stats();assert_eq!(stats["bytes"],PEER_BYTES+REGISTRY_BYTES+ROUTE_BYTES);assert_eq!(stats["peer"]["bytes"],PEER_BYTES);assert_eq!(stats["headroom"],0);assert_eq!(stats["ready"],true);assert_eq!(stats["canAdmitPeer"],false);assert_eq!(pool.peer().err().unwrap(),PRESSURE);assert!(pool.ready());drop(peer);assert!(pool.ready());assert_eq!(pool.stats()["canAdmitPeer"],false);drop(route);assert_eq!(pool.stats()["canAdmitPeer"],true);drop(registry);assert_eq!(pool.stats()["bytes"],0);assert_eq!(pool.stats()["allocations"],0);
  let tiny=Pool::new(REGISTRY_BYTES-1);assert_eq!(tiny.registry().err().unwrap(),PRESSURE);assert_eq!(tiny.stats()["bytes"],0);
 }
 #[test]fn graph_price_covers_actual_parsed_dense_sparse_and_escaped_capacity_corpus(){
  let cases=[format!("{{\"a\":[{}]}}",vec!["0";4000].join(",")),format!("{{{}}}",(0..2000).map(|n|format!("\"key{n}\":{{\"x\":0}}")).collect::<Vec<_>>().join(",")),format!("{{\"text\":\"{}\\n\"}}","中".repeat(40000))];
  for(index,text)in cases.iter().enumerate(){let pool=Pool::new(32*1024*1024);let((config,actual),peak)=measure(||{let value:Value=serde_json::from_str(text).unwrap();let actual=value;let mut clone=actual.clone();let config=pool.config(&mut clone).unwrap();(config,actual)});let reservation=pool.stats()["config"]["bytes"].as_u64().unwrap()as usize;assert!(peak<=reservation,"case{index}");assert_eq!(*config,actual);println!("gateway-config-capacity: case={index} requested_peak={peak} reservation={reservation}");drop(config);drop(actual);assert_eq!(pool.stats()["bytes"],0);}
 }
}
