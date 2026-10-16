use crate::{
    emit,
    scene::{Result, SCENE_BYTES, Snapshot},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{SyncSender, sync_channel},
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    Message, accept_hdr_with_config,
    handshake::server::{ErrorResponse, Request, Response},
    protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
};

pub struct Gateway {
    pub latest: Mutex<Option<Arc<Snapshot>>>,
    peers: Mutex<HashMap<String, SyncSender<Value>>>,
    config: Value,
    running: AtomicBool,
    next: AtomicU64,
    deltas: Mutex<HashMap<(u64, u64), String>>,
}
impl Gateway {
    pub fn start(config: Value) -> Result<(Arc<Self>, u16)> {
        let host = config["host"].as_str().unwrap_or("127.0.0.1");
        let port = config["port"].as_u64().unwrap_or(0);
        let listener = TcpListener::bind(format!("{host}:{port}")).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let gateway = Arc::new(Self {
            latest: Mutex::new(None),
            peers: Mutex::new(HashMap::new()),
            config,
            running: AtomicBool::new(true),
            next: AtomicU64::new(0),
            deltas: Mutex::new(HashMap::new()),
        });
        let owner = gateway.clone();
        thread::spawn(move || {
            while owner.running.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if owner.peers.lock().unwrap().len() >= 4 {
                            continue;
                        }
                        let id = format!("native-{}", owner.next.fetch_add(1, Ordering::Relaxed));
                        let (tx, rx) = sync_channel(64);
                        owner.peers.lock().unwrap().insert(id.clone(), tx);
                        let server = owner.clone();
                        thread::spawn(move || {
                            if let Err(error) = server.serve(stream, &id, rx) {
                                eprintln!("Peer {id}: {error}");
                            }
                            server.peers.lock().unwrap().remove(&id);
                            emit(json!({"event":"PeerClosed","peerId":id}));
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok((gateway, port))
    }
    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
        for tx in self.peers.lock().unwrap().values() {
            let _ = tx.try_send(json!({"type":"$close","code":1001,"reason":"Gateway stopped"}));
        }
    }
    pub fn send(&self, id: &str, message: Value) -> Result<Value> {
        let peers = self.peers.lock().unwrap();
        if let Some(tx) = peers.get(id) {
            tx.try_send(message)
                .map_err(|_| "Native peer control queue full".to_string())?;
        }
        Ok(json!(true))
    }
    pub fn publish(&self, snapshot: Arc<Snapshot>) {
        let mut latest = self.latest.lock().unwrap();
        if latest
            .as_ref()
            .is_some_and(|old| old.serial >= snapshot.serial)
        {
            return;
        }
        *latest = Some(snapshot);
        drop(latest);
        let mut cache = self.deltas.lock().unwrap();
        if cache.len() > 64 {
            cache.clear();
        }
    }
    fn delta(&self, previous: &Snapshot, next: &Snapshot) -> String {
        let mut cache = self.deltas.lock().unwrap();
        cache.entry((previous.serial,next.serial)).or_insert_with(||{
   let old=previous.scene["passes"].as_array().unwrap();let new=next.scene["passes"].as_array().unwrap();
   serde_json::to_string(&json!({"rootPass":next.scene["rootPass"],"order":new.iter().map(|p|p["id"].clone()).collect::<Vec<_>>(),"upsert":new.iter().filter(|p|!old.iter().any(|o|o==*p)).collect::<Vec<_>>(),"remove":old.iter().filter(|p|!new.iter().any(|n|n["id"]==p["id"])).map(|p|p["id"].clone()).collect::<Vec<_>>()})).unwrap()
  }).clone()
    }
    fn serve(
        &self,
        stream: TcpStream,
        id: &str,
        commands: std::sync::mpsc::Receiver<Value>,
    ) -> Result<()> {
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_millis(5000)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_millis(500)))
            .map_err(|e| e.to_string())?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        let expected_origin = self.config["origin"].as_str().unwrap_or("").to_owned();
        let key = self.config["key"].as_str().unwrap_or("").to_owned();
        let callback = move |request: &Request,
                             response: Response|
              -> std::result::Result<Response, ErrorResponse> {
            let valid = request
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok())
                == Some(expected_origin.as_str())
                && request.uri().path() == "/stream"
                && request
                    .uri()
                    .query()
                    .is_some_and(|query| query.split('&').any(|v| v == format!("key={key}")));
            if !valid {
                return Err(tungstenite::http::Response::builder()
                    .status(403)
                    .body(Some("Forbidden".into()))
                    .unwrap());
            }
            Ok(response)
        };
        let cfg = WebSocketConfig::default()
            .max_message_size(Some(32 * 1024))
            .max_frame_size(Some(32 * 1024))
            .write_buffer_size(0)
            .max_write_buffer_size(66 * 1024 * 1024);
        let mut ws =
            accept_hdr_with_config(stream, callback, Some(cfg)).map_err(|e| e.to_string())?;
        ws.get_mut()
            .set_read_timeout(Some(Duration::from_millis(2)))
            .map_err(|e| e.to_string())?;
        let started = Instant::now();
        let policy=|ws:&mut tungstenite::WebSocket<TcpStream>,reason:&'static str|{let _=ws.close(Some(CloseFrame{code:CloseCode::Policy,reason:reason.into()}));};
        let mut input_window=Instant::now();let mut input_count=0;
        let mut ready = false;
        let mut acked: Option<(u64, Arc<Snapshot>)> = None;
        let mut inflight: Option<(u64, Arc<Snapshot>, Instant)> = None;
        let mut known = HashSet::new();
        let mut next_id = 0u64;
        let mut force_full = true;
        let mut use_chunks = false;
        let mut known_chunks = HashSet::new();
        let mut chunk_bytes = 0usize;
        let mut stats = json!({"full":0,"delta":0,"resources":0,"bytes":0,"coalesced":0,"slowDisconnects":0,"maxInflight":0});
        let mut recovery_start = Instant::now();
        let mut recoveries = 0;
        let deadline = Duration::from_millis(self.config["ackTimeout"].as_u64().unwrap_or(5000));
        loop {
            let mut closing = None;
            while let Ok(message) = commands.try_recv() {
                if message["type"] == "$close" {
                    closing = Some((
                        message["code"].as_u64().unwrap_or(1000) as u16,
                        message["reason"].as_str().unwrap_or("Closed").to_owned(),
                    ));
                    break;
                }
                ws.send(Message::Text(message.to_string().into()))
                    .map_err(|e| e.to_string())?;
            }
            if !self.running.load(Ordering::Relaxed) {
                closing = Some((1001, "Gateway stopped".to_string()));
            }
            if !ready && started.elapsed() > Duration::from_secs(10) {
                closing = Some((1008, "Handshake timeout".into()));
            }
            if inflight
                .as_ref()
                .is_some_and(|(_, _, sent)| sent.elapsed() > deadline)
            {
                closing = Some((
                    1013,
                    "Viewer acknowledgement deadline; reconnect for keyframe".into(),
                ));
                stats["slowDisconnects"] = json!(1);
            }
            if let Some((code, reason)) = closing {
                let _ = ws.close(Some(CloseFrame {
                    code: CloseCode::from(code),
                    reason: reason.into(),
                }));
                break;
            }
            match ws.read() {
                Ok(Message::Text(text)) => {
                    let message: Value = match serde_json::from_str(&text) { Ok(value)=>value,Err(_)=>{policy(&mut ws,"Invalid client JSON");break;} };
                    if input_window.elapsed()>Duration::from_secs(1){input_window=Instant::now();input_count=0;}
                    input_count+=1;if input_count>512 {policy(&mut ws,"Client message rate exceeded");break;}
                    if !ready {
                        if message["type"] != "Hello"
                            || message["protocol"] != 4
                            || message["renderer"] != self.config["renderer"]
                        {
                            let _ = ws.close(Some(CloseFrame {
                                code: CloseCode::Policy,
                                reason: "Incompatible protocol or renderer".into(),
                            }));
                            break;
                        }
                        use_chunks = message["capabilities"]
                            .as_array()
                            .is_some_and(|caps| caps.iter().any(|c| c == "asset-chunks-v1"));
                        ready = true;
                        let welcome = json!({"type":"Welcome","protocol":4,"renderer":self.config["renderer"],"producer":self.config["producer"],"mode":"live-skia-viz","input":self.config["input"]==true,"peerId":id,"sessionId":self.config["sessionId"]});
                        ws.send(Message::Text(welcome.to_string().into()))
                            .map_err(|e| e.to_string())?;
                        emit(json!({"event":"PeerReady","peerId":id}));
                    } else if message["type"] == "FrameAck" {
                        let Some((frame, snapshot, _)) = inflight.take() else {
                            policy(&mut ws,"Unexpected acknowledgement");break;
                        };
                        if message["frameId"] != frame
                            || message["pageEpoch"] != snapshot.metadata["pageEpoch"]
                        {
                            policy(&mut ws,"Unexpected acknowledgement");break;
                        }
                        let current: HashSet<String> = snapshot.resources.keys().cloned().collect();
                        let retired: Vec<_> = known.difference(&current).cloned().collect();
                        known = current;
                        if !retired.is_empty() {
                            ws.send(Message::Text(
                                json!({"type":"ResourceRelease","ids":retired})
                                    .to_string()
                                    .into(),
                            ))
                            .map_err(|e| e.to_string())?;
                        }
                        acked = Some((frame, snapshot));
                    } else if message["type"] == "RequestKeyframe" {
                        if recovery_start.elapsed() > Duration::from_secs(10) {
                            recovery_start = Instant::now();
                            recoveries = 0;
                        }
                        recoveries += 1;
                        if recoveries > 8 {
                            policy(&mut ws,"Too many recovery requests");break;
                        }
                        inflight = None;
                        acked = None;
                        known.clear();
                        known_chunks.clear();
                        chunk_bytes = 0;
                        force_full = true;
                    } else if self.config["input"] == true && matches!(message["type"].as_str(),Some("AcquireControl"|"RenewControl"|"ReleaseControl"|"Input")) {
                        emit(json!({"event":"Control","peerId":id,"message":message}));
                    } else {
                        policy(&mut ws,"Unsupported message");break;
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
                Ok(_) => {policy(&mut ws,"Binary client messages unsupported");break;},
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(tungstenite::Error::ConnectionClosed)
                | Err(tungstenite::Error::AlreadyClosed) => break,
                Err(e) => return Err(e.to_string()),
            }
            if !ready || inflight.is_some() {
                continue;
            }
            let Some(snapshot) = self.latest.lock().unwrap().clone() else {
                continue;
            };
            if !force_full
                && acked
                    .as_ref()
                    .is_some_and(|(_, old)| old.serial == snapshot.serial)
            {
                continue;
            }
            if let Some((_,old))=&acked {stats["coalesced"]=json!(stats["coalesced"].as_u64().unwrap()+snapshot.serial.saturating_sub(old.serial+1));}
            let full = force_full
                || acked.as_ref().is_none_or(|(_, old)| {
                    old.metadata["pageEpoch"] != snapshot.metadata["pageEpoch"]
                        || old.metadata["viewportVersion"] != snapshot.metadata["viewportVersion"]
                });
            next_id += 1;
            let mut frame = snapshot.metadata.clone();
            for key in ["mappings", "released"] {
                frame.as_object_mut().unwrap().remove(key);
            }
            frame["protocol"] = json!(4);
            frame["frameId"] = json!(next_id);
            frame["baseFrameId"] = if full {
                Value::Null
            } else {
                json!(acked.as_ref().unwrap().0)
            };
            let header = serde_json::to_string(&frame).unwrap();
            let body = if full {
                snapshot.full_json.clone()
            } else {
                self.delta(&acked.as_ref().unwrap().1, &snapshot)
            };
            let scene = format!(
                "{{\"type\":\"SceneUpdate\",\"frame\":{{{},\"{}\":{}}}}}",
                &header[1..header.len() - 1],
                if full { "scene" } else { "delta" },
                body
            );
            if scene.len() > SCENE_BYTES {
                return Err("Frame metadata budget exceeded".into());
            }
            let mut resource_count = 0;
            let mut bytes = scene.len();
            if known_chunks.len() > 32768 || chunk_bytes > 64 * 1024 * 1024 {
                ws.send(Message::Text(
                    json!({"type":"ChunkCacheReset"}).to_string().into(),
                ))
                .map_err(|e| e.to_string())?;
                known_chunks.clear();
                chunk_bytes = 0;
            }
            for (hash, resource) in &snapshot.resources {
                if known.contains(hash) {
                    continue;
                }
                if use_chunks {
                    for chunk in resource.chunks.iter() {
                        if known_chunks.insert(chunk.id.clone()) {
                            ws.send(Message::Binary(chunk.wire.clone()))
                                .map_err(|e| e.to_string())?;
                            bytes += chunk.wire.len();
                            chunk_bytes += chunk.wire.len() - 44;
                        }
                    }
                    ws.send(Message::Text(resource.manifest.clone().into()))
                        .map_err(|e| e.to_string())?;
                    bytes += resource.manifest.len();
                } else {
                    ws.send(Message::Binary(resource.wire.clone()))
                        .map_err(|e| e.to_string())?;
                    bytes += resource.wire.len();
                }
                known.insert(hash.clone());
                resource_count += 1;
            }
            ws.send(Message::Text(scene.into()))
                .map_err(|e| e.to_string())?;
            ws.send(Message::Text(json!({"type":"FrameCommit","pageEpoch":snapshot.metadata["pageEpoch"],"frameId":next_id}).to_string().into())).map_err(|e|e.to_string())?;
            let field = if full { "full" } else { "delta" };
            stats[field] = json!(stats[field].as_u64().unwrap() + 1);
            stats["resources"] = json!(stats["resources"].as_u64().unwrap() + resource_count);
            stats["bytes"] = json!(stats["bytes"].as_u64().unwrap() + bytes as u64);
            stats["maxInflight"] = json!(1);
            emit(json!({"event":"PeerStats","peerId":id,"stats":stats}));
            inflight = Some((next_id, snapshot, Instant::now()));
            force_full = false;
        }
        emit(json!({"event":"PeerStats","peerId":id,"stats":stats}));
        Ok(())
    }
}
