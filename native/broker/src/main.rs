mod scene;
use serde_json::{Value, json};
use std::io::{self, Read, Write};
fn emit(value: Value) {
    let bytes = serde_json::to_vec(&value).unwrap();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let _ = out.write_all(&(bytes.len() as u32).to_be_bytes());
    let _ = out.write_all(&bytes);
    let _ = out.flush();
}
fn main() {
    let mut mapper = scene::Mapper::new();
    let stdin = io::stdin();
    let mut input = stdin.lock();
    loop {
        let mut header = [0; 4];
        if input.read_exact(&mut header).is_err() {
            break;
        }
        let size = u32::from_be_bytes(header) as usize;
        if size > 90 * 1024 * 1024 {
            break;
        }
        let mut bytes = vec![0; size];
        if input.read_exact(&mut bytes).is_err() {
            break;
        }
        let request: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => break,
        };
        let id = request["id"].clone();
        let result=match request["op"].as_str(){Some("map")=>mapper.map(&request["capture"],request["epoch"].as_u64().unwrap_or(0),&request["viewport"],request["viewportVersion"].as_u64().unwrap_or(0),request["inputSeq"].as_u64().unwrap_or(0)).map(|s|json!({"serial":s.serial,"scene":s.scene,"metadata":s.metadata,"resources":s.resources.iter().map(|(id,r)|json!({"id":id,"bytes":r.payload.len()})).collect::<Vec<_>>()})),Some("reset")=>{mapper.reset();Ok(json!(true))},_=>Err("Unknown broker command".into())};
        emit(match result {
            Ok(result) => json!({"id":id,"result":result}),
            Err(error) => json!({"id":id,"error":error}),
        });
    }
}
