use bytes::Bytes;
use serde_json::{Value,json};
use std::{ops::Deref,sync::{Arc,atomic::{AtomicUsize,Ordering}}};
use tungstenite::Utf8Bytes;

pub const PRESSURE: &str = "Resource allocation budget exceeded";
pub const DEFAULT_BYTES: usize = 768*1024*1024;
const BUFFER_OWNER: usize = 128;
struct State { limit:usize,pressure:&'static str,scope:&'static str,used:AtomicUsize,peak:AtomicUsize,live:AtomicUsize,denied:AtomicUsize }
#[derive(Clone)]
pub struct Budget(Arc<State>);
pub struct Lease { state:Arc<State>,bytes:usize }
impl Drop for Lease { fn drop(&mut self){self.state.used.fetch_sub(self.bytes,Ordering::AcqRel);self.state.live.fetch_sub(1,Ordering::AcqRel);} }
// Field order is deliberate: owned allocation is freed before its credit.
pub struct OwnedVec { data:Vec<u8>,_lease:Lease }
pub struct Payload { pub bytes:Bytes,pub capacity:usize }
impl Deref for Payload {type Target=[u8];fn deref(&self)->&Self::Target{&self.bytes}}
impl AsRef<[u8]> for Payload {fn as_ref(&self)->&[u8]{&self.bytes}}
impl AsRef<[u8]> for OwnedVec { fn as_ref(&self)->&[u8]{&self.data} }
impl Deref for OwnedVec { type Target=Vec<u8>;fn deref(&self)->&Self::Target{&self.data} }
impl OwnedVec {
 pub fn extend(&mut self,bytes:impl AsRef<[u8]>){let bytes=bytes.as_ref();assert!(bytes.len()<=self.data.capacity()-self.data.len(),"Budgeted buffer cannot grow");self.data.extend_from_slice(bytes);}
 pub fn finish(self)->Bytes{Bytes::from_owner(self)}
 pub fn payload(self)->Payload{let capacity=self.capacity();Payload{bytes:self.finish(),capacity}}
 pub fn initialized(&mut self)->&mut [u8]{self.data.resize(self.data.capacity(),0);&mut self.data}
 pub fn truncate(&mut self,length:usize){self.data.truncate(length);}
 pub fn transfer(self,budget:&Budget)->Result<Self,String>{
  // Reserve the new owner before returning the old credit; keep the exact
  // allocation and capacity instead of briefly making an uncharged copy.
  let lease=budget.reserve(self.data.capacity().checked_add(BUFFER_OWNER).ok_or(budget.0.pressure)?)?;
  let Self{data,_lease}=self;drop(_lease);Ok(Self{data,_lease:lease})
 }
}
impl Budget {
 pub fn new(limit:usize)->Self{Self::scoped(limit,PRESSURE,"resource-allocation-pool")}
 pub fn scoped(limit:usize,pressure:&'static str,scope:&'static str)->Self{Self(Arc::new(State{limit,pressure,scope,used:AtomicUsize::new(0),peak:AtomicUsize::new(0),live:AtomicUsize::new(0),denied:AtomicUsize::new(0)}))}
 pub fn configured()->Result<Self,String>{
  let bytes=match std::env::var("REMOTE_PAINT_RESOURCE_POOL_BYTES") {Ok(value)=>value.parse::<usize>().map_err(|_|"Invalid REMOTE_PAINT_RESOURCE_POOL_BYTES")?,Err(_)=>DEFAULT_BYTES};
  if !(64*1024*1024..=2*1024*1024*1024).contains(&bytes){return Err("Resource pool must be 64MiB..2GiB".into());}Ok(Self::new(bytes))
 }
 pub fn used(&self)->usize{self.0.used.load(Ordering::Acquire)}
 pub fn limit(&self)->usize{self.0.limit}
 pub fn headroom(&self)->usize{(320*1024*1024).min(self.limit()/2)}
 pub fn ready(&self)->bool{self.used()<=self.limit()-self.headroom()}
 pub fn reserve(&self,bytes:usize)->Result<Lease,String>{
  let mut used=self.used();loop{
   let Some(next)=used.checked_add(bytes).filter(|n|*n<=self.limit())else{self.0.denied.fetch_add(1,Ordering::Relaxed);return Err(self.0.pressure.into());};
   match self.0.used.compare_exchange_weak(used,next,Ordering::AcqRel,Ordering::Acquire){Ok(_)=>{self.0.peak.fetch_max(next,Ordering::Relaxed);self.0.live.fetch_add(1,Ordering::Relaxed);return Ok(Lease{state:self.0.clone(),bytes});},Err(actual)=>used=actual}
  }
 }
 pub fn buffer(&self,capacity:usize)->Result<OwnedVec,String>{
  let lease=self.reserve(capacity.checked_add(BUFFER_OWNER).ok_or(self.0.pressure)?)?;let mut data=Vec::new();data.try_reserve_exact(capacity).map_err(|_|"Resource allocation failed")?;
  if data.capacity()!=capacity{return Err("Unexpected resource buffer capacity".into());}Ok(OwnedVec{data,_lease:lease})
 }
 pub fn own(&self,data:Vec<u8>)->Result<Bytes,String>{let lease=self.reserve(data.capacity().checked_add(BUFFER_OWNER).ok_or(self.0.pressure)?)?;Ok(Bytes::from_owner(OwnedVec{data,_lease:lease}))}
 #[cfg(test)]pub fn payload(&self,data:Vec<u8>)->Result<Payload,String>{let capacity=data.capacity();Ok(Payload{bytes:self.own(data)?,capacity})}
 pub fn text(&self,text:String)->Result<Utf8Bytes,String>{Utf8Bytes::try_from(self.own(text.into_bytes())?).map_err(|_|"Invalid resource text".into())}
 pub fn stats(&self)->Value{json!({"scope":self.0.scope,"bytes":self.used(),"limit":self.limit(),"peak":self.0.peak.load(Ordering::Acquire),"allocations":self.0.live.load(Ordering::Acquire),"denied":self.0.denied.load(Ordering::Acquire),"headroom":self.headroom(),"ready":self.ready()})}
}

#[cfg(test)]
mod tests {
 use super::*;
 #[test]fn aliases_and_slices_hold_the_full_allocation_until_final_drop(){
  let budget=Budget::new(4096);let data=budget.own(vec![17;1024]).unwrap();let charged=budget.used();let slice=data.slice(5..6);let clone=slice.clone();drop(data);drop(slice);assert_eq!(budget.used(),charged);assert_eq!(clone.as_ref(),[17]);drop(clone);assert_eq!(budget.used(),0);
 }
 #[test]fn concurrent_admission_cannot_exceed_the_limit(){
  let budget=Budget::new(1024);let gate=Arc::new(std::sync::Barrier::new(9));let mut jobs=vec![];
  for _ in 0..8{let owner=budget.clone();let barrier=gate.clone();jobs.push(std::thread::spawn(move||{barrier.wait();owner.reserve(512).ok()}));}gate.wait();let pins:Vec<_>=jobs.into_iter().filter_map(|job|job.join().unwrap()).collect();assert_eq!(pins.len(),2);assert_eq!(budget.used(),1024);assert!(budget.reserve(1).is_err());drop(pins);assert_eq!(budget.used(),0);
 }
 #[test]fn wire_text_alias_retains_the_same_reservation(){let budget=Budget::new(4096);let text=budget.text("manifest".repeat(32)).unwrap();let bytes=text.clone();let used=budget.used();drop(text);assert_eq!(budget.used(),used);drop(bytes);assert_eq!(budget.used(),0);assert!(budget.reserve(usize::MAX).is_err());}
 #[test]fn packet_transfer_keeps_exact_backing_and_retires_old_credit(){
  let first=Budget::new(4096);let second=Budget::new(4096);let mut packet=first.buffer(1024).unwrap();packet.extend([17;1024]);let pointer=packet.as_ptr();let used=first.used();let packet=packet.transfer(&second).unwrap();assert_eq!(packet.as_ptr(),pointer);assert_eq!(packet.capacity(),1024);assert_eq!(first.used(),0);assert_eq!(second.used(),used);drop(packet);assert_eq!(second.used(),0);
  let small=Budget::new(1);assert!(first.buffer(1024).unwrap().transfer(&small).is_err());assert_eq!(first.used(),0);assert_eq!(small.used(),0);
 }
}
