mod assets;
mod budget;
mod snapshot_memory;
mod capture_expansion;
mod native_metadata;
mod consumers;
mod subscriptions;
mod dispatch;
mod output;
mod ws_json;
mod ws_memory;
mod gateway_packets;
mod gateway_memory;
mod mapper_memory;
mod command;
mod input;
mod rpc;
#[cfg(test)]mod allocation_probe;
mod history;
mod gateway;
mod control;
mod writer;
mod scene;
mod viz;
use serde_json::{Value, json};
use std::{
    io,
    sync::Arc,
};
pub fn emit(value: output::Event<'_>) {
    if let Err(error)=output::global().send(output::Lane::Control,&value){output_failed(error);}
}
fn output_failed(error:output::Failure)->!{
    // Never leave a critical event undelivered,or continue a partially written
    // byte frame. EOF makes the parent reject all affected pending work.
    use std::io::Write;
    let _=writeln!(io::stderr().lock(),"Broker output failed: {}",error.message());std::process::exit(2)
}
fn rpc_reply(id:&Value,reply:output::Reply<'_>,lane:output::Lane){
    if let Err(error)=output::global().send(lane,&output::RpcReply{id,reply}){
        // Admission/counting failed before any bytes were written. The remote
        // map may already have committed;report delivery pressure precisely.
        if matches!(lane,output::Lane::Data)&&error!=output::Failure::Transport{
            if let Err(error)=output::global().send(output::Lane::Control,&output::RpcReply{id,reply:output::Reply::Error{message:error.message(),code:Some(error.code()),budget:Some("rust-rpc-output")}}){output_failed(error);}
        }else{output_failed(error);}
    }
}
pub fn error_code(error:&str)->Option<&'static str>{match error{budget::PRESSURE|snapshot_memory::PRESSURE|output::PRESSURE|command::PRESSURE|ws_memory::PRESSURE|gateway_packets::PRESSURE|gateway_memory::PRESSURE|mapper_memory::PRESSURE|capture_expansion::PRESSURE=>Some("RESOURCE_BUDGET_PRESSURE"),input::PRESSURE=>Some("INPUT_BUDGET_PRESSURE"),_=>viz::fault_error_code(error)}}
fn rpc_error(id:&Value,error:&str){rpc_reply(id,output::Reply::Error{message:error,code:error_code(error),budget:None},output::Lane::Control);}
fn main() {
    let budget=budget::Budget::configured().unwrap_or_else(|error|{eprintln!("{error}");std::process::exit(2)});
    let input_pool=input::InputPool::configured().unwrap_or_else(|error|{eprintln!("{error}");std::process::exit(2)});
    let rpc_input=Arc::new(rpc::RpcInput::configured().unwrap_or_else(|error|{eprintln!("{error}");std::process::exit(2)}));
    let snapshot_pool=snapshot_memory::SnapshotPool::configured().unwrap_or_else(|error|{eprintln!("{error}");std::process::exit(2)});
    let websocket_json=ws_json::configure().unwrap_or_else(|error|{eprintln!("{error}");std::process::exit(2)});
    let commands=command::configure().unwrap_or_else(|error|{eprintln!("{error}");std::process::exit(2)});
    let websocket_backing=ws_memory::configure().unwrap_or_else(|error|{eprintln!("{error}");std::process::exit(2)});
    let gateway_state=gateway_memory::configure().unwrap_or_else(|error|{eprintln!("{error}");std::process::exit(2)});
    let gateway_packets=gateway_packets::configure().unwrap_or_else(|error|{eprintln!("{error}");std::process::exit(2)});
    let output_pool=output::configure().unwrap_or_else(|error|{eprintln!("{error}");std::process::exit(2)});
    let expansion_pool=capture_expansion::Pool::configured().unwrap_or_else(|error|{eprintln!("{error}");std::process::exit(2)});
    let mut mapper = scene::Mapper::with_pools(budget,snapshot_pool);
    mapper.index_pool=mapper_memory::Pool::configured().unwrap_or_else(|error|{eprintln!("{error}");std::process::exit(2)});
    let mut history = history::History::default();
    let shared=dispatch::Shared::new(&rpc_input).unwrap_or_else(|error|{eprintln!("{error}");std::process::exit(2)});
    let reader=shared.clone();let reader_rpc=rpc_input.clone();let reader_pool=input_pool.clone();
    std::thread::spawn(move||{let stdin=io::stdin();reader.read(&reader_rpc,&reader_pool,&mut stdin.lock());});
    let mut native_turn=true;
    loop {
        let version=shared.wake.version();
        if !shared.closing()&&(native_turn||!shared.has_requests()){
            if let Some(work)=shared.viz().and_then(|v|v.native.take()){
                dispatch::native(work,&mut mapper,&mut history,&expansion_pool,&shared);native_turn=false;continue;
            }
        }
        // Transferred Viz metadata must drop before its admission. Keep this
        // binding before the owner that will receive those Values below.
        let mut _legacy_mapping=None;
        let mut _native_admission=Vec::new();
        let queued=match shared.pop(){
            Some(request)=>request,
            None=>{if shared.closing(){break;}native_turn=true;shared.wake.wait(version,std::time::Duration::from_millis(100));continue;},
        };
        let mut admitted=queued.request;let route_epoch=queued.epoch;
        native_turn=true;
        let viz=shared.viz();let gateway=shared.gateway();
        let request=&mut admitted.value;
        // Keep the moved ID under the admitted input lease through writing.
        let id = request["id"].take();
        if request["op"]=="map"||request["op"]=="expectViz" {
            if !mapper.budget.ready(){history.reclaim();mapper.reclaim_cache();}
            else if !mapper.snapshot_pool.ready(){history.reclaim();}
        }
        let mut native_blocks = std::collections::HashMap::new();
        if request["op"]=="map"&&(request["capture"]["viz"]["native"]==true||request["capture"]["nativeResources"]==true){
            let capture_id=request["capture"]["captureId"].as_str().unwrap_or("");
            match viz.as_ref().ok_or("Native Viz unavailable".to_string()).and_then(|v|v.begin_mapping(capture_id)){
                Ok(mapping)=>_legacy_mapping=Some(mapping),Err(error)=>{rpc_error(&id,&error);continue;},
            }
        }
        if request["op"] == "map" && request["capture"]["viz"]["native"] == true {
            let capture_id = request["capture"]["captureId"].as_str().unwrap_or("");
            match viz
                .as_ref()
                .ok_or("Native Viz unavailable".to_string())
                .and_then(|v| v.take(capture_id))
            {
                Ok(scene) => request["capture"]["viz"] = scene,
                Err(error) => {
                    rpc_error(&id,&error);
                    continue;
                }
            }
        }
        if request["op"] == "map" && request["capture"]["nativeResources"] == true {
            let capture_id = request["capture"]["captureId"].as_str().unwrap_or("");
            let result = viz
                .as_ref()
                .ok_or("Native resources unavailable".to_string())
                .and_then(|v| v.take_resources(capture_id))
                .and_then(|resources| {
                    _native_admission=resources.admission;native_blocks = resources.blocks;
                    let scene = request["capture"]["viz"].take();
                    let timing=request["capture"]["timing"].take();
                    request["capture"] = resources.metadata;
                    native_metadata::merge_timing(&mut request["capture"],timing)?;
                    request["capture"]["viz"] = scene;
                    Ok(())
                });
            if let Err(error) = result {
                rpc_error(&id,&error);
                continue;
            }
        }
        if request["op"]=="map"{
            if request.get("captureOrdinal").is_some(){
                if request["captureOrdinal"].as_u64().is_none_or(|n|n>9_007_199_254_740_991){rpc_error(&id,"Invalid capture ordinal");continue;}
                let ordinal=request["captureOrdinal"].take();
                let Some(capture)=request["capture"].as_object_mut()else{rpc_error(&id,"Invalid capture metadata");continue;};capture.insert("captureOrdinal".into(),ordinal);
            }
            let metadata_only=request["metadataOnly"]==true;
            let result=capture_expansion::expand(request["capture"].take(),&expansion_pool).and_then(|capture|mapper.map_admitted(&capture,request["epoch"].as_u64().unwrap_or(0),&request["viewport"],request["viewportVersion"].as_u64().unwrap_or(0),request["inputSeq"].as_u64().unwrap_or(0),native_blocks));
            match result{
                Ok(snapshot)=>{history.insert(snapshot.clone());shared.serial(snapshot.serial);rpc_reply(&id,output::Reply::Mapped(&snapshot,metadata_only),output::Lane::Data);},
                Err(error)=>rpc_error(&id,&error),
            }
            continue;
        }
        let result=match request["op"].as_str(){
 Some("mapperStats")=>Ok(mapper.stats()),
 Some("resourceBudget")=>{let retired_deltas=gateway.as_ref().map_or(0,|g|g.reclaim_packets());let retired=history.reclaim();mapper.reclaim_cache();let mut stats=mapper.budget.stats();stats["retiredSnapshots"]=json!(retired);stats["retiredGatewayDeltas"]=json!(retired_deltas);stats["ready"]=json!(mapper.budget.ready()&&mapper.snapshot_pool.ready()&&input_pool.ready()&&rpc_input.ready()&&output_pool.ready()&&websocket_json.ready()&&commands.ready()&&websocket_backing.ready()&&gateway_packets.ready()&&gateway_state.ready()&&mapper.index_pool.ready()&&expansion_pool.ready());stats["captureExpansion"]=expansion_pool.stats();stats["output"]=output_pool.stats();stats["snapshots"]=mapper.snapshot_pool.stats();stats["input"]=input_pool.stats();stats["rpcInput"]=rpc_input.stats();stats["websocketJson"]=websocket_json.stats();stats["commands"]=commands.stats();stats["websocketBacking"]=websocket_backing.stats();stats["gatewayPackets"]=gateway_packets.stats();stats["gatewayState"]=gateway_state.stats();stats["mapperIndices"]=mapper.index_pool.stats();Ok(stats)},
 Some("listenViz")=>{if viz.is_some(){Err("Viz already listening".into())}else{viz::Viz::start_with_wake(request["path"].as_str().unwrap_or(""),input_pool.clone(),mapper.budget.clone(),shared.wake.clone()).map(|v|{shared.set_viz(v);json!(true)})}},
 Some("expectViz")=>viz.as_ref().ok_or("Viz not listening".into()).and_then(|v|v.expect(request["captureId"].as_str().unwrap_or(""),request["resources"].as_bool().unwrap_or(false))),
 Some("publish")=>gateway.as_ref().ok_or("Gateway not listening".into()).and_then(|g|history.publication(request["serial"].as_u64().unwrap_or(0)).map(|snapshot|{if let Some(s)=snapshot{g.publish(s);json!(true)}else{json!({"coalesced":true})}})),
 Some("listen")=>{if gateway.is_some(){Err("Gateway already listening".into())}else{gateway::Gateway::start(&mut request["config"]).and_then(|(g,port)|{if let Some(s)=&history.latest{g.publish(s.clone());}shared.set_gateway(g,route_epoch)?;Ok(json!({"port":port}))})}},
 Some("resetScene")=>{mapper.reset_scene();history.clear();shared.serial(0);if let Some(g)=&gateway{g.reset();}Ok(json!(true))},
 Some("reset")=>{mapper.reset();history.clear();shared.serial(0);if let Some(g)=&gateway{g.reset();}Ok(json!(true))},
 _=>Err("Unknown broker command".into())};
        match result {
            Ok(result) => rpc_reply(&id,output::Reply::Value(&result),output::Lane::Control),
            Err(error) => rpc_error(&id,&error),
        }
    }
    if let Some(v) = shared.viz() {
        v.stop();
    }
    if let Some(g) = shared.gateway() {
        g.stop();
    }
}
