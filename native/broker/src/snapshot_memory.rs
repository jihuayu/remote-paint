use crate::{budget::{Budget,Lease},scene::{Result,SCENE_BYTES}};
use serde_json::Value;
use std::io::{self,Write};

pub const PRESSURE:&str="Snapshot allocation budget exceeded";
pub const DEFAULT_BYTES:usize=256*1024*1024;
#[derive(Clone)]
pub struct SnapshotPool(pub Budget);
pub struct Plan {pub snapshot:usize,pub entries:usize,pub staging:usize}
pub struct Admission {pub snapshot:Lease,pub entries:Lease,pub _staging:Lease}
impl SnapshotPool {
 pub fn new(bytes:usize)->Self{Self(Budget::scoped(bytes,PRESSURE,"snapshot-graph-pool"))}
 pub fn configured()->Result<Self>{
  let bytes=match std::env::var("REMOTE_PAINT_SNAPSHOT_BYTES"){Ok(value)=>value.parse::<usize>().map_err(|_|"Invalid REMOTE_PAINT_SNAPSHOT_BYTES")?,Err(_)=>DEFAULT_BYTES};
  if !(1024*1024..=1024*1024*1024).contains(&bytes){return Err("Snapshot pool must be 1MiB..1GiB".into());}Ok(Self::new(bytes))
 }
 pub fn admit(&self,plan:Plan)->Result<Admission>{Ok(Admission{snapshot:self.0.reserve(plan.snapshot)?,entries:self.0.reserve(plan.entries)?,_staging:self.0.reserve(plan.staging)?})}
 pub fn ready(&self)->bool{self.0.used()<=self.0.limit()-self.headroom()}
 fn headroom(&self)->usize{(64*1024*1024).min(self.0.limit()/2)}
 pub fn stats(&self)->Value{let mut stats=self.0.stats();stats["headroom"]=self.headroom().into();stats["ready"]=self.ready().into();stats}
}
fn add(total:&mut usize,bytes:usize)->Result<()>{*total=total.checked_add(bytes).ok_or(PRESSURE)?;Ok(())}
fn mul(value:usize,count:usize)->Result<usize>{value.checked_mul(count).ok_or_else(||PRESSURE.into())}
// No cloning, key enumeration vector or serialized input string. Price Value,
// Vec/BTreeMap capacity and cloned string storage conservatively. The allocator
// layout corpus checks this estimate; it is not a physical heap/RSS measure.
fn graph(value:&Value,depth:usize,nodes:&mut usize)->Result<usize>{
 if depth>128{return Err("Snapshot metadata depth exceeded".into());}
 *nodes=nodes.checked_add(1).ok_or(PRESSURE)?;if *nodes>1_000_000{return Err(PRESSURE.into());}
 let mut bytes=768;
 match value{
  Value::String(text)=>add(&mut bytes,mul(text.len(),2)?)?,
  Value::Array(values)=>for value in values{add(&mut bytes,graph(value,depth+1,nodes)?)?;},
  Value::Object(values)=>for(key,value)in values{add(&mut bytes,256)?;add(&mut bytes,mul(key.len(),2)?)?;add(&mut bytes,graph(value,depth+1,nodes)?)?;},
  _=>{},
 }Ok(bytes)
}
pub fn plan<'a>(capture:&Value,viewport:&Value,old_entries:impl Iterator<Item=&'a str>,index_entries:usize,raw_bytes:usize)->Result<Plan>{
 let(mut nodes,mut snapshot)=(0,64*1024+SCENE_BYTES);
 for value in [viewport,&capture["captureId"],&capture["producer"],&capture["frameToken"],&capture["sourceFrame"],&capture["timing"],&capture["viz"]["namespace"],&capture["viz"]["passes"]]{add(&mut snapshot,graph(value,0,&mut nodes)?)?;}
 let records=capture["resources"].as_array().map_or(0,Vec::len);
 let mut quad_count=0usize;let mut pictures=0usize;
 if let Some(passes)=capture["viz"]["passes"].as_array(){for pass in passes{if let Some(quads)=pass["quads"].as_array(){
  quad_count=quad_count.checked_add(quads.len()).ok_or(PRESSURE)?;
  pictures=pictures.checked_add(quads.iter().filter(|q|q["kind"]=="picture").count()).ok_or(PRESSURE)?;
  // A shared record's stable-layer Value is cloned once for each picture,
  // not once per record. Arbitrary admitted JSON here cannot evade the price
  // by reusing one localId on many quads.
  if let Some(records)=capture["resources"].as_array(){for quad in quads.iter().filter(|q|q["kind"]=="picture"){
   if let Some(record)=records.iter().find(|record|record["localId"]==quad["localId"]){add(&mut snapshot,graph(&record["sourceLocalId"],0,&mut nodes)?)?;}
  }}
 }}}
 // Output adds logical/hash/source fields and metadata mappings which are not
 // all present on input quads. Invalid oversized producer IDs still get priced
 // before formatting them; existing Mapper validation remains authoritative.
 let logical=capture["producer"].as_str().map_or(0,str::len).checked_add(80).ok_or(PRESSURE)?;
 // All quad kinds gain a default clip field; picture adds the larger
 // logical/hash/source schema and metadata mapping records.
 add(&mut snapshot,mul(quad_count,2*1024)?)?;
 add(&mut snapshot,mul(pictures,14*1024)?)?;
 add(&mut snapshot,mul(pictures,mul(logical,8)?)?)?;
 if let Some(records)=capture["resources"].as_array(){for record in records{
  // SKP/Base64/payload bytes have separate resource/input owners; they are not
  // copied into Snapshot. Only these record Values are copied into its scene.
  for field in ["width","height","sourceLocalId"]{add(&mut snapshot,graph(&record[field],0,&mut nodes)?)?;}
 }}
 add(&mut snapshot,mul(records,2048)?)?;
 for logical in old_entries{add(&mut snapshot,1024)?;add(&mut snapshot,mul(logical.len(),2)?)?;}
 let entries=8192usize.checked_add(mul(pictures,2048usize.checked_add(mul(logical,2)?).ok_or(PRESSURE)?)?).ok_or(PRESSURE)?;
 // Mapped Values overlap the final graph; the final bounded JSON buffer has
 // its own SCENE_BYTES allowance and is never grown/copied during encoding.
 let mut staging=mul(snapshot-SCENE_BYTES,2)?;add(&mut staging,mul(entries,2)?)?;
 add(&mut staging,mul(index_entries,512)?)?;add(&mut staging,mul(records,2048)?)?;
 let mut payload=raw_bytes;
 if let Some(records)=capture["resources"].as_array(){for record in records{if let Some(encoded)=record["skp"].as_str(){add(&mut payload,encoded.len()/4*3+3)?;}}}
 let chunks=payload.checked_add(32767).ok_or(PRESSURE)?/32768;add(&mut staging,mul(chunks,1024)?)?;
 Ok(Plan{snapshot,entries,staging})
}
struct Counter{bytes:usize}
impl Write for Counter{
 fn write(&mut self,bytes:&[u8])->io::Result<usize>{let next=self.bytes.checked_add(bytes.len()).filter(|n|*n<=SCENE_BYTES).ok_or_else(||io::Error::other("Scene metadata budget exceeded"))?;self.bytes=next;Ok(bytes.len())}
 fn flush(&mut self)->io::Result<()>{Ok(())}
}
struct Exact(Vec<u8>);
impl Write for Exact{
 fn write(&mut self,bytes:&[u8])->io::Result<usize>{if bytes.len()>self.0.capacity()-self.0.len(){return Err(io::Error::other("Scene JSON size changed"));}self.0.extend_from_slice(bytes);Ok(bytes.len())}
 fn flush(&mut self)->io::Result<()>{Ok(())}
}
impl Admission{
 pub fn scene_json(&self,scene:&Value)->Result<String>{
  let mut count=Counter{bytes:0};serde_json::to_writer(&mut count,scene).map_err(|_|"Scene metadata budget exceeded")?;
  let mut output=Exact(Vec::with_capacity(count.bytes));if output.0.capacity()!=count.bytes{return Err("Unexpected scene JSON capacity".into());}
  serde_json::to_writer(&mut output,scene).map_err(|error|error.to_string())?;
  String::from_utf8(output.0).map_err(|_|"Invalid scene JSON UTF8".into())
 }
}

#[cfg(test)]mod sizing_tests{use super::*;#[test]fn successful_sizing_has_no_eager_error_string_allocations(){let capture=serde_json::json!({"captureId":"sizing","producer":"fixture","resources":[],"viz":{"namespace":[1,2],"passes":[{"id":"root","quads":[]}]}});let viewport=serde_json::json!({"cssWidth":10,"cssHeight":10});let(result,peak)=crate::allocation_probe::measure(||plan(&capture,&viewport,std::iter::once("retained"),8192,65536));assert!(result.is_ok());assert_eq!(peak,0);println!("mapper-sizing-after: requested_peak={peak}");}}
