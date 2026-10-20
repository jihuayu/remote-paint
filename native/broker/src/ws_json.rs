use crate::{budget::{Budget,Lease},scene::Result};
use serde_json::Value;
use std::{ops::Deref,sync::OnceLock};

pub const PRESSURE:&str="WebSocket JSON allocation budget exceeded";
pub const DEFAULT_BYTES:usize=128*1024*1024;
pub const MAX_MESSAGE:usize=32*1024;
#[derive(Clone)]
pub struct Pool(Budget);
// The Value is private and freed before its credit. Callers can borrow it,
// never move an unleased graph out of this owner into asynchronous work.
pub struct Parsed { value:Value,_lease:Lease }
impl Deref for Parsed {type Target=Value;fn deref(&self)->&Self::Target{&self.value}}
static GLOBAL:OnceLock<Pool>=OnceLock::new();
pub fn global()->&'static Pool{GLOBAL.get_or_init(||Pool::new(DEFAULT_BYTES))}
pub fn configure()->Result<&'static Pool>{
 let bytes=match std::env::var("REMOTE_PAINT_WEBSOCKET_JSON_BYTES"){
  Ok(value)=>value.parse::<usize>().map_err(|_|"Invalid REMOTE_PAINT_WEBSOCKET_JSON_BYTES")?,Err(_)=>DEFAULT_BYTES,
 };
 if !(1024*1024..=1024*1024*1024).contains(&bytes){return Err("WebSocket JSON pool must be 1MiB..1GiB".into());}
 GLOBAL.set(Pool::new(bytes)).map_err(|_|"WebSocket JSON pool already configured")?;Ok(global())
}
pub fn close_code(error:&str)->u16{if error==PRESSURE{1013}else{1008}}
impl Pool {
 pub fn new(bytes:usize)->Self{Self(Budget::scoped(bytes,PRESSURE,"websocket-parsed-json-pool"))}
 pub fn parse(&self,bytes:&[u8])->Result<Parsed>{
  if bytes.len()>MAX_MESSAGE{return Err("WebSocket JSON message limit".into());}
  // This is graph/parser admission. Tungstenite has already received the raw
  // UTF8/frame/HTTP data; those buffers require a separate ownership scope.
  let charge=crate::input::json_charge(bytes).map_err(|_|"WebSocket JSON depth exceeded")?;
  let lease=self.0.reserve(charge)?;
  let value=serde_json::from_slice(bytes).map_err(|_|"Invalid WebSocket JSON")?;
  Ok(Parsed{value,_lease:lease})
 }
 fn headroom(&self)->usize{(32*1024*1024).min(self.0.limit()/2)}
 pub fn ready(&self)->bool{self.0.used()<=self.0.limit()-self.headroom()}
 pub fn stats(&self)->Value{
  let mut stats=self.0.stats();stats["headroom"]=self.headroom().into();stats["ready"]=self.ready().into();stats["maximumMessage"]=MAX_MESSAGE.into();stats["rawSocketBuffers"]="outside parsed JSON owner".into();stats
 }
}

#[cfg(test)]mod tests {
 use super::*;
 use serde_json::json;
 use std::sync::{Arc,Barrier};
 #[test]fn admitted_graph_keeps_credit_until_value_drop_and_parse_errors_return_it(){
  let bytes=br#"{"type":"Input","event":{"kind":"text","text":"hello"}}"#;let charge=crate::input::json_charge(bytes).unwrap();let pool=Pool::new(charge);
  let parsed=pool.parse(bytes).unwrap();assert_eq!(parsed["type"],"Input");assert_eq!(pool.0.used(),charge);assert!(!pool.ready());assert_eq!(pool.parse(b"true").err().unwrap(),PRESSURE);assert_eq!(pool.0.used(),charge);drop(parsed);assert_eq!(pool.0.used(),0);assert!(pool.ready());
  for bad in [b"{invalid".as_slice(),b"[true,]",&[b'"',255,b'"']]{assert!(pool.parse(bad).is_err());assert_eq!(pool.0.used(),0);}
 }
 #[test]fn dense_default_message_fits_and_small_quota_denies_before_parse_allocation(){
  let value=json!({"type":"Input","events":vec![0u8;16300],"text":"中文😀"});let bytes=value.to_string();assert_eq!(bytes.len(),32647);
  let denied=Pool::new(1024*1024);let(result,denied_requested_peak)=crate::allocation_probe::measure(||denied.parse(bytes.as_bytes()));assert_eq!(result.err().unwrap(),PRESSURE);assert!(denied_requested_peak<1024);assert_eq!(denied.0.used(),0);
  let pool=Pool::new(DEFAULT_BYTES);let(parsed,peak)=crate::allocation_probe::measure(||pool.parse(bytes.as_bytes()).unwrap());let reserved=pool.0.used();assert_eq!(&*parsed,&value);assert!(peak<=reserved);assert!(pool.ready());println!("websocket-json-dense-layout: input_bytes={} requested_peak={peak} reservation={reserved} denied_requested_peak={denied_requested_peak}",bytes.len());drop(parsed);assert_eq!(pool.0.used(),0);
 }
 #[test]fn parser_requested_layout_corpus_fits_preflight_credit(){
  let cases=[("max-string",format!("\"{}\"","x".repeat(MAX_MESSAGE-2))),("late-escape",format!("\"{}\\n\"","x".repeat(24*1024))),("objects",format!("[{}]",vec!["{\"a\":0}";2000].join(","))),("nested-arrays",format!("[{}]",vec!["[0]";4000].join(","))),("unicode-keys",format!("{{{}}}",(0..800).map(|n|format!("\"key{n}\":\"中文😀\" ")).collect::<Vec<_>>().join(","))),("duplicate-keys",format!("{{{}}}",vec!["\"repeat\":0";1000].join(","))),("depth",format!("{}0{}","[".repeat(60),"]".repeat(60)))];
  for(name,bytes)in cases{assert!(bytes.len()<=MAX_MESSAGE);let pool=Pool::new(DEFAULT_BYTES);let(parsed,peak)=crate::allocation_probe::measure(||pool.parse(bytes.as_bytes()).unwrap());let reserved=pool.0.used();assert!(peak<=reserved,"{name}: {peak}>{reserved}");println!("websocket-json-layout {name}: input_bytes={} requested_peak={peak} reservation={reserved}",bytes.len());drop(parsed);assert_eq!(pool.0.used(),0);}
 }
 #[test]fn concurrent_reader_graphs_share_one_cap_and_do_not_consume_rpc_output_credit(){
  let bytes=Arc::new(br#"{"type":"Input","array":[0,1,2,3]}"#.to_vec());let charge=crate::input::json_charge(&bytes).unwrap();let pool=Pool::new(2*charge);let barrier=Arc::new(Barrier::new(9));let mut jobs=vec![];
  for _ in 0..8{let pool=pool.clone();let bytes=bytes.clone();let barrier=barrier.clone();jobs.push(std::thread::spawn(move||{barrier.wait();pool.parse(&bytes).ok()}));}barrier.wait();let pins:Vec<_>=jobs.into_iter().filter_map(|job|job.join().unwrap()).collect();assert_eq!(pins.len(),2);assert_eq!(pool.0.used(),pool.0.limit());assert!(pool.0.stats()["denied"].as_u64().unwrap()>=6);
  let output=crate::output::OutputPool::new(64*1024,64*1024);let control=output.encode(crate::output::Lane::Control,&json!({"result":true})).unwrap();drop(control);assert_eq!(pool.0.used(),2*charge);drop(pins);assert_eq!(pool.0.used(),0);
 }
 #[test]fn message_and_depth_limits_are_preflight_failures_with_distinct_pressure_close_code(){
  let pool=Pool::new(DEFAULT_BYTES);let oversized=vec![b' ';MAX_MESSAGE+1];let(result,peak)=crate::allocation_probe::measure(||pool.parse(&oversized));let error=result.err().unwrap();assert!(error.contains("message limit"));assert!(peak<1024);assert_eq!(close_code(&error),1008);
  let deep=format!("{}0{}","[".repeat(129),"]".repeat(129));let(result,peak)=crate::allocation_probe::measure(||pool.parse(deep.as_bytes()));let error=result.err().unwrap();assert!(error.contains("depth"));assert!(peak<1024);assert_eq!(close_code(&error),1008);assert_eq!(close_code(PRESSURE),1013);assert_eq!(pool.0.used(),0);
 }
}
