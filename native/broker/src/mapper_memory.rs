use crate::{budget::{Budget,Lease},scene::Result};
use serde_json::Value;

pub const PRESSURE:&str="Mapper index allocation budget exceeded";
pub const DEFAULT_BYTES:usize=64*1024*1024;
// The layout corpus includes HashMap growth from512+256 strong/recency,
//512+768 weak resources,8192+8192 weak chunks,and overlapping sort/hash/stats
// scratch and Arc allocation blocks retained by stale Weak targets. It measures
// requested allocations,not allocator/VM/OS residency.
pub const ALLOWANCE_BYTES:usize=16*1024*1024;
#[derive(Clone)]pub struct Pool(pub Budget);
impl Pool{
 pub fn new(bytes:usize)->Self{Self(Budget::scoped(bytes,PRESSURE,"mapper-index-pool"))}
 pub fn configured()->Result<Self>{
  let bytes=match std::env::var("REMOTE_PAINT_MAPPER_INDEX_BYTES"){Ok(value)=>value.parse::<usize>().map_err(|_|"Invalid REMOTE_PAINT_MAPPER_INDEX_BYTES")?,Err(_)=>DEFAULT_BYTES};
  if !(1024*1024..=1024*1024*1024).contains(&bytes){return Err("Mapper index pool must be 1MiB..1GiB".into());}Ok(Self::new(bytes))
 }
 pub fn admit(&self)->Result<Lease>{self.0.reserve(ALLOWANCE_BYTES)}
 // All future bounded growth is already reserved for an admitted Mapper.
 pub fn ready(&self)->bool{self.0.used()<=self.0.limit()}
 pub fn stats(&self)->Value{let mut value=self.0.stats();value["headroom"]=0.into();value["ready"]=self.ready().into();value["allowanceBytes"]=ALLOWANCE_BYTES.into();value["canAdmitMapper"]=(self.0.limit().saturating_sub(self.0.used())>=ALLOWANCE_BYTES).into();value["scopeNote"]="fixed requested-layout allowance for persistent strong/recency/weak/chunk index backing and bounded sorting/hash/stats scratch;logical entries,Snapshot graphs,payload/wire/manifest and parser owners remain separate;VM/allocator/OS/RSS outside".into();value}
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn admission_does_not_allocate_and_already_owned_growth_stays_ready(){let pool=Pool::new(ALLOWANCE_BYTES);let(lease,peak)=crate::allocation_probe::measure(||pool.admit().unwrap());assert_eq!(peak,0);assert_eq!(pool.stats()["bytes"],ALLOWANCE_BYTES);assert!(pool.ready());assert_eq!(pool.stats()["canAdmitMapper"],false);assert_eq!(pool.admit().err().unwrap(),PRESSURE);drop(lease);assert_eq!(pool.stats()["bytes"],0);assert_eq!(pool.stats()["allocations"],0);assert_eq!(pool.stats()["canAdmitMapper"],true);assert_eq!(Pool::new(ALLOWANCE_BYTES-1).admit().err().unwrap(),PRESSURE);}
}
