use serde_json::Value;
use crate::scene::Result;

pub const INVALID_TIMING:&str="Native timing metadata is not an object";

// Both parsed input owners remain admitted in main until this merged capture
// has left Mapper. Transfer their actual keys/Values instead of duplicating
// the CDP graph. Overrides remain shallow,one field at a time.
pub fn merge_timing(capture:&mut Value,timing:Value)->Result<()> {
    let Value::Object(timing)=timing else{return Ok(())};
    if timing.is_empty(){return Ok(())}
    let capture=capture.as_object_mut().ok_or(INVALID_TIMING)?;
    if let Some(slot)=capture.get_mut("timing") {
        if slot.is_null()||slot.as_object().is_some_and(|map|map.is_empty()) {
            *slot=Value::Object(timing);
        }else if let Value::Object(target)=slot {
            target.extend(timing);
        }else{return Err(INVALID_TIMING.into())}
    }else{capture.insert("timing".into(),Value::Object(timing));}
    Ok(())
}

#[cfg(test)]mod tests {
    use super::*;
    use serde_json::json;
    use crate::{budget::{Budget,Lease},input::InputPool,rpc::{Frame,ParsedRequest,RpcInput}};
    fn legacy(capture:&mut Value,timing:Value){if let Some(timing)=timing.as_object(){for(key,value)in timing{capture["timing"][key]=value.clone();}}}
    #[test]fn overrides_are_shallow_and_keep_native_only_fields(){
        let mut capture=json!({"resources":[],"timing":{"native":17,"both":{"old":1,"shared":2}}});
        merge_timing(&mut capture,json!({"cdp":19,"both":{"new":3}})).unwrap();
        assert_eq!(capture,json!({"resources":[],"timing":{"native":17,"cdp":19,"both":{"new":3}}}));
    }
    #[test]fn new_keys_strings_nested_vectors_and_override_payloads_keep_actual_owners(){
        let key="k".repeat(8192);let lookup=key.clone();let key_ptr=key.as_ptr();
        let text="v".repeat(2_100_000);let text_ptr=text.as_ptr();
        let nested=vec![json!("nested".repeat(1000))];let vector_ptr=nested.as_ptr();let nested_ptr=nested[0].as_str().unwrap().as_ptr();
        let replaced="replacement".repeat(1000);let replaced_ptr=replaced.as_ptr();
        let mut timing=serde_json::Map::new();timing.insert(key,Value::String(text));timing.insert("nested".into(),Value::Array(nested));timing.insert("existing".into(),Value::String(replaced));
        let mut capture=json!({"timing":{"native":1,"existing":"old"}});merge_timing(&mut capture,Value::Object(timing)).unwrap();
        let(key,value)=capture["timing"].as_object().unwrap().get_key_value(&lookup).unwrap();assert_eq!(key.as_ptr(),key_ptr);assert_eq!(value.as_str().unwrap().as_ptr(),text_ptr);
        assert_eq!(capture["timing"]["nested"].as_array().unwrap().as_ptr(),vector_ptr);assert_eq!(capture["timing"]["nested"][0].as_str().unwrap().as_ptr(),nested_ptr);assert_eq!(capture["timing"]["existing"].as_str().unwrap().as_ptr(),replaced_ptr);
    }
    #[test]fn null_and_empty_destinations_take_the_whole_map_without_allocation(){
        for initial in [Value::Null,json!({})]{let mut capture=json!({"timing":initial});let incoming=json!({"big":"x".repeat(1_000_000)});let ptr=incoming["big"].as_str().unwrap().as_ptr();let(result,peak)=crate::allocation_probe::measure(||merge_timing(&mut capture,incoming));result.unwrap();assert_eq!(peak,0);assert_eq!(capture["timing"]["big"].as_str().unwrap().as_ptr(),ptr);}
        let mut capture=json!({"resources":[]});merge_timing(&mut capture,json!({"new":1})).unwrap();assert_eq!(capture["timing"],json!({"new":1}));
    }
    #[test]fn ignored_timing_kinds_preserve_existing_native_shape(){
        for timing in [Value::Null,json!(true),json!(3),json!("ignored"),json!([1]),json!({})]{let mut capture=json!({"timing":"native-shape"});merge_timing(&mut capture,timing).unwrap();assert_eq!(capture,json!({"timing":"native-shape"}));}
    }
    #[test]fn invalid_native_timing_returns_an_error_without_mutating_metadata(){
        for timing in [json!(true),json!(3),json!("bad"),json!([1])]{let mut capture=json!({"resources":[],"timing":timing});let expected=capture.clone();assert_eq!(merge_timing(&mut capture,json!({"cdp":1})).err().unwrap(),INVALID_TIMING);assert_eq!(capture,expected);}
        let mut capture=json!([1]);assert_eq!(merge_timing(&mut capture,json!({"cdp":1})).err().unwrap(),INVALID_TIMING);assert_eq!(capture,json!([1]));
    }
    struct Owners{capture:Value,_rpc:ParsedRequest,_native:Vec<Lease>}
    fn wire(id:&str,metadata:&Value)->Vec<u8>{let mut p=b"RPA2\x01\x01".to_vec();for s in [id.to_owned(),metadata.to_string()]{p.extend((s.len()as u32).to_be_bytes());p.extend(s.as_bytes());}p.extend(0u32.to_be_bytes());p}
    fn cases()->Vec<(&'static str,Value,Value)>{
        let nodes=json!((0..4096).map(|i|json!({"text":"q".repeat(64),"values":[i,1,2]})).collect::<Vec<_>>());let mut keys=serde_json::Map::new();for n in 0..1024{keys.insert(format!("{n:04}{}","k".repeat(2048)),json!("owned"));}
        vec![("replace-large-string",json!({"big":"x".repeat(2_100_000)}),json!({"big":"y".repeat(2_100_000)})),("add-large-string",json!({}),json!({"big":"x".repeat(2_100_000)})),("nested-values",json!({}),json!({"nodes":nodes})),("long-keys",json!({}),Value::Object(keys)),("escaped-metadata",json!({"original":17}),json!({"quote":"x\\\"\n中文😀".repeat(100_000),"empty":{}}))]
    }
    #[test]fn actual_parse_and_merge_peaks_fit_retained_input_owners_and_release_together(){
        for(name,native,cdp)in cases(){
            let native_text=json!({"captureId":"measure","resources":[],"timing":native});let raw=wire("measure",&native_text);let request=json!({"id":1,"op":"map","capture":{"timing":cdp}}).to_string();let mut rpc_bytes=(request.len()as u32).to_be_bytes().to_vec();rpc_bytes.extend(request.as_bytes());
            let mut before_peak=0;
            for moving in [false,true]{
                let native_pool=InputPool::new(128*1024*1024);let rpc_pool=RpcInput::new(128*1024*1024,4*1024*1024).unwrap();let payload=Budget::new(128*1024*1024);
                let(owners,peak)=crate::allocation_probe::measure(||{
                    let mut packet=native_pool.packet(raw.len()).unwrap();packet.initialized().copy_from_slice(&raw);let resources=crate::viz::decode_resources(&packet,&native_pool,&payload).unwrap();drop(packet);
                    let mut rpc=match rpc_pool.read(&mut std::io::Cursor::new(&rpc_bytes)).unwrap().unwrap(){Frame::Request(v)=>v,_=>panic!("denied fixture")};let timing=rpc.value["capture"]["timing"].take();let mut capture=resources.metadata;
                    if moving{merge_timing(&mut capture,timing).unwrap();}else{legacy(&mut capture,timing);}
                    Owners{capture,_rpc:rpc,_native:resources.admission}
                });
                let native_reserved=native_pool.0.used();let stats=rpc_pool.stats();let rpc_reserved=stats["data"]["bytes"].as_u64().unwrap()as usize+stats["control"]["bytes"].as_u64().unwrap()as usize;
                assert!(peak<=native_reserved+rpc_reserved,"{name}: peak{peak} allowance{}",native_reserved+rpc_reserved);
                let mut expected=native_text.clone();legacy(&mut expected,cdp.clone());assert_eq!(owners.capture,expected);
                if !moving{before_peak=peak;}else if name=="nested-values"{assert!(peak<before_peak);}
                println!("timing-merge: case={name} moving={moving} native_wire={} rpc_wire={} requested_peak={peak} native_retained_allowance={native_reserved} rpc_retained_allowance={rpc_reserved} input_allowance_covers_observed=true",raw.len(),rpc_bytes.len());
                drop(owners);assert_eq!(native_pool.0.used(),0);assert_eq!(rpc_pool.stats()["data"]["bytes"],0);assert_eq!(rpc_pool.stats()["control"]["bytes"],65536);
            }
        }
    }
}
