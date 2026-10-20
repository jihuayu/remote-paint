use crate::{budget::{Budget,Lease,OwnedVec},scene::Result};
use serde_json::Value;

pub const PRESSURE:&str="Input allocation budget exceeded";
pub const DEFAULT_BYTES:usize=256*1024*1024;
#[derive(Clone)]
pub struct InputPool(pub Budget);
pub struct ParsedJson {pub value:Value,pub lease:Lease}
impl InputPool {
    pub fn new(bytes:usize)->Self{Self(Budget::scoped(bytes,PRESSURE,"viz-input-pool"))}
    pub fn configured()->Result<Self>{
        let bytes=match std::env::var("REMOTE_PAINT_INPUT_POOL_BYTES"){Ok(value)=>value.parse::<usize>().map_err(|_|"Invalid REMOTE_PAINT_INPUT_POOL_BYTES")?,Err(_)=>DEFAULT_BYTES};
        if !(1024*1024..=1024*1024*1024).contains(&bytes){return Err("Input pool must be 1MiB..1GiB".into());}Ok(Self::new(bytes))
    }
    pub fn packet(&self,bytes:usize)->Result<OwnedVec>{self.0.buffer(bytes)}
    pub fn json(&self,bytes:&[u8])->Result<ParsedJson>{
        let lease=self.0.reserve(json_charge(bytes)?)?;
        let value=serde_json::from_slice(bytes).map_err(|_|"Invalid resource metadata")?;
        Ok(ParsedJson{value,lease})
    }
    pub fn ready(&self)->bool{self.0.used()<=self.0.limit()-self.headroom()}
    fn headroom(&self)->usize{(80*1024*1024).min(self.0.limit()/2)}
    pub fn stats(&self)->Value{let mut stats=self.0.stats();stats["headroom"]=self.headroom().into();stats["ready"]=self.ready().into();stats}
}
// Preflight before serde allocates. Charge every string (including keys),
// container and scalar plus escaped-string scratch/final text capacity.
// Per-node headroom covers
// Value/Vec growth and sparse BTreeMap nodes; this is an estimate, not RSS.
pub(crate) fn json_charge(bytes:&[u8])->Result<usize>{
    let(mut nodes,mut i,mut depth)=(0usize,0usize,0usize);
    while i<bytes.len(){match bytes[i]{
        b'"'=>{nodes+=1;i+=1;while i<bytes.len(){if bytes[i]==b'\\'{i+=2;}else if bytes[i]==b'"'{i+=1;break;}else{i+=1;}}},
        b'['|b'{'=>{nodes+=1;depth+=1;if depth>128{return Err("Resource metadata depth exceeded".into());}i+=1;},
        b']'|b'}'=>{depth=depth.saturating_sub(1);i+=1;},
        b'-'|b'0'..=b'9'|b't'|b'f'|b'n'=>{nodes+=1;i+=1;while i<bytes.len()&&!matches!(bytes[i],b','|b']'|b'}'|b' '|b'\n'|b'\r'|b'\t'){i+=1;}},
        _=>i+=1,
    }}
    nodes.checked_mul(768).and_then(|n|n.checked_add(bytes.len().checked_mul(4)?)).and_then(|n|n.checked_add(64*1024)).ok_or(PRESSURE.into())
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn metadata_headroom_is_admitted_before_parsing_and_returned_after_failure(){
        let pool=InputPool::new(128*1024);let packet=pool.packet(64*1024).unwrap();let before=pool.0.used();assert_eq!(pool.json(br#"{"one":[1,2,3]}"#).err().unwrap(),PRESSURE);assert_eq!(pool.0.used(),before);drop(packet);assert_eq!(pool.0.used(),0);
        assert!(pool.json(b"{invalid").is_err());assert_eq!(pool.0.used(),0);let parsed=pool.json(br#"{"escaped":"x\\\"[1]","a":[true,null,-12.5]}"#).unwrap();assert!(parsed.value["a"].is_array());assert!(pool.0.used()>0);drop(parsed);assert_eq!(pool.0.used(),0);
    }
    #[test]fn many_small_nodes_and_deep_metadata_cannot_bypass_admission(){
        let pool=InputPool::new(1024*1024);let many=format!("[{}]",vec!["0";4096].join(","));assert_eq!(pool.json(many.as_bytes()).err().unwrap(),PRESSURE);assert_eq!(pool.0.used(),0);
        let deep=format!("{}0{}","[".repeat(129),"]".repeat(129));assert!(pool.json(deep.as_bytes()).err().unwrap().contains("depth"));assert_eq!(pool.0.used(),0);
    }
    #[test]fn parser_headroom_covers_observed_layout_peaks_including_escaped_string_scratch(){
        let cases=[format!("\"{}\\n\"","x".repeat(2_100_000)),format!("\"{}\"","x".repeat(2_100_000)),format!("[{}]",vec!["{\"a\":0}";2000].join(",")),format!("[{}]",vec!["[0]";2000].join(",")),format!("{{{}}}",(0..2000).map(|n|format!("\"key{n}\":\"value\" ")).collect::<Vec<_>>().join(","))];
        for (index,bytes) in cases.iter().enumerate(){
            let pool=InputPool::new(32*1024*1024);let(parsed,peak)=crate::allocation_probe::measure(||pool.json(bytes.as_bytes()).unwrap());let reserved=pool.0.used();println!("metadata-layout-case {index}: input={} reserved={reserved} requested_peak={peak}",bytes.len());assert!(peak<=reserved,"case{index}: observed requested-layout peak {peak} exceeds reserved {reserved}");drop(parsed);assert_eq!(pool.0.used(),0);
        }
    }
}
