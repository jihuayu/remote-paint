use crate::{
    emit,
    gateway_memory::{self as owners,Reservation},
    gateway_packets::{self as packets,Notification,Lane},
    command::{Command,Closure,Mailbox,Inbox},
    output::{Event,EventField::{Bool,Json,Text}},
    scene::{Result, Snapshot},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    Message, accept_hdr_with_config,
    handshake::server::{ErrorResponse, Request, Response},
};

use crate::consumers::{Kind as ConsumerKind,Role as ConsumerRole,Decision as ConsumerDecision,Tickets as ConsumerTickets,Fence as ConsumerFence};
enum Closing {Command(Arc<Closure>),Local(u16,&'static str)}
struct Flight {
    id: u64,
    snapshot: Arc<Snapshot>,
    sent: Instant,
    bytes: usize,
}
struct PendingFrame {
    flight: Flight,
    packets: VecDeque<Message>,
    remaining: usize,
    resources: usize,
    full: bool,
    progress_at: Instant,
}
struct Peer {
    kind:ConsumerKind,
    data: Mailbox,
    control: Arc<crate::control::Channel>,
}
enum Route {
    Data(
        String,
        Inbox,
        Arc<crate::control::Channel>,
        Reservation,
        ConsumerRole,
    ),
    Control(String, Arc<crate::control::Channel>),
}

fn resource_order(snapshot: &Snapshot) -> Vec<&str> {
    fn visit<'a>(
        id: &'a str,
        passes: &HashMap<&'a str, &'a Value>,
        visited: &mut HashSet<&'a str>,
        seen: &mut HashSet<&'a str>,
        order: &mut Vec<&'a str>,
    ) {
        if !visited.insert(id) {
            return;
        }
        let Some(pass) = passes.get(id) else {
            return;
        };
        for quad in pass["quads"].as_array().unwrap() {
            let visible = &quad["visible"];
            if quad["opacity"].as_f64() == Some(0.0)
                || visible[2].as_f64().unwrap() <= visible[0].as_f64().unwrap()
                || visible[3].as_f64().unwrap() <= visible[1].as_f64().unwrap()
            {
                continue;
            }
            if quad["kind"] == "pass" {
                visit(
                    quad["passId"].as_str().unwrap(),
                    passes,
                    visited,
                    seen,
                    order,
                );
            } else if let Some(resource) = quad["resourceId"].as_str() {
                if seen.insert(resource) {
                    order.push(resource);
                }
            }
        }
    }
    // Viz lists frontmost quads first. Walk the root's visible dependencies,
    // then send all remaining required resources, preserving the commit gate.
    let passes: HashMap<_, _> = snapshot.scene["passes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pass| (pass["id"].as_str().unwrap(), pass))
        .collect();
    let mut order = vec![];
    let mut seen = HashSet::new();
    visit(
        snapshot.scene["rootPass"].as_str().unwrap(),
        &passes,
        &mut HashSet::new(),
        &mut seen,
        &mut order,
    );
    let mut remaining: Vec<_> = snapshot
        .resources
        .keys()
        .map(String::as_str)
        .filter(|id| !seen.contains(id))
        .collect();
    remaining.sort_unstable();
    order.extend(remaining);
    order
}

const CHUNK_CACHE_ENTRIES:usize=32768;
const CHUNK_CACHE_BYTES:usize=64*1024*1024;
// Current compact Viewer ledger:640 cache index +512 owner +96 backing record.
const CHUNK_INDEX_BYTES:usize=640+512+96;
const RESET_BYTES:usize=b"{\"type\":\"ChunkCacheReset\"}".len();
struct Delivery<'a>{id:&'a str,resource:&'a crate::scene::Resource,chunks:bool,reset:bool}
struct DeliveryPlan<'a>{items:Vec<Delivery<'a>>,bytes:usize,initial_reset:bool}
fn delivery_plan<'a>(snapshot:&'a Snapshot,known:&HashSet<String>,known_chunks:&HashSet<String>,chunk_bytes:usize,use_chunks:bool)->Result<DeliveryPlan<'a>>{
 let initial_reset=known_chunks.len()>CHUNK_CACHE_ENTRIES||chunk_bytes>CHUNK_CACHE_BYTES;
 let mut cache:HashSet<&str>=if initial_reset{HashSet::new()}else{known_chunks.iter().map(String::as_str).collect()};let mut cache_bytes=if initial_reset{0}else{chunk_bytes};
 let mut plan=DeliveryPlan{items:Vec::with_capacity(snapshot.resources.len()),bytes:if initial_reset{RESET_BYTES}else{0},initial_reset};
 for id in resource_order(snapshot){
  if known.contains(id){continue;}let resource=&snapshot.resources[id];
  let unique:HashSet<_>=resource.chunks.iter().map(|chunk|chunk.id.as_str()).collect();
  // Many tiny sections can cost more in receiver metadata than the full SKP.
  // Raw resource packets are already supported by chunk-capable Viewers.
  // Ordinary small font/image sharing stays on the chunk path;64KiB of
  // index work is the threshold for the dense-section alternative. Keep
  // ordinary/large chunk sharing,choose raw for a denser representation.
  let index_bytes=unique.len().saturating_mul(CHUNK_INDEX_BYTES);
  let dense=index_bytes>=64*1024&&index_bytes>resource.payload.len();
  let chunks=use_chunks&&resource.manifest.len()<resource.wire.len()&&!dense;
  let mut reset=false;
  if chunks{
   let mut fresh=HashSet::new();let mut fresh_bytes=0usize;
   for chunk in resource.chunks.iter(){if !cache.contains(chunk.id.as_str())&&fresh.insert(chunk.id.as_str()){fresh_bytes+=chunk.wire.len()-44;}}
   if cache.len()+fresh.len()>CHUNK_CACHE_ENTRIES||cache_bytes+fresh_bytes>CHUNK_CACHE_BYTES{cache.clear();cache_bytes=0;reset=true;plan.bytes+=RESET_BYTES;}
   for chunk in resource.chunks.iter(){if cache.insert(chunk.id.as_str()){cache_bytes+=chunk.wire.len()-44;plan.bytes+=chunk.wire.len();}}
   plan.bytes+=resource.manifest.len();
  }else{plan.bytes+=resource.wire.len();}
  plan.items.push(Delivery{id,resource,chunks,reset});
 }Ok(plan)
}

pub struct Gateway {
    pub latest: Mutex<Option<Arc<Snapshot>>>,
    peers: Mutex<HashMap<String, Peer>>,
    config: owners::Config,
    consumer_tickets: Mutex<ConsumerTickets>,
    running: AtomicBool,
    next: AtomicU64,
    connections: AtomicU64,
    deltas: Mutex<packets::Cache>,
    _registry: Reservation,
}
impl Gateway {
    pub fn start(config: &mut Value) -> Result<(Arc<Self>, u16)> {
        if config["origin"].as_str().is_none_or(str::is_empty)
            || config["key"].as_str().is_none_or(str::is_empty)
        {
            return Err("Gateway requires an Origin and access key".into());
        }
        let config=owners::global().config(config)?;
        let registry=owners::global().registry()?;
        let host = config["host"].as_str().unwrap_or("127.0.0.1");
        let port = config["port"].as_u64().unwrap_or(0);
        let listener = TcpListener::bind(format!("{host}:{port}")).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let gateway = Arc::new(Self {
            latest: Mutex::new(None),
            peers: Mutex::new(HashMap::new()),
            config,
            consumer_tickets: Mutex::new(ConsumerTickets::default()),
            running: AtomicBool::new(true),
            next: AtomicU64::new(0),
            connections: AtomicU64::new(0),
            deltas: Mutex::new(packets::global().cache()?),
            _registry:registry,
        });
        let owner = gateway.clone();
        thread::spawn(move || {
            while owner.running.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if owner.connections.fetch_add(1, Ordering::AcqRel) >= 12 {
                            owner.connections.fetch_sub(1, Ordering::AcqRel);
                            continue;
                        }
                        let server = owner.clone();
                        thread::spawn(move || {
                            if let Err(error) = server.serve(stream) {
                                eprintln!("Native connection: {error}");
                            }
                            server.connections.fetch_sub(1, Ordering::AcqRel);
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
        self.running.store(false,Ordering::Relaxed);
        self.consumer_tickets.lock().unwrap().clear();
        let closure=crate::command::global().closure(1001,"Gateway stopped").ok();
        for peer in self.peers.lock().unwrap().values(){
            if let Some(closure)=&closure{let _=peer.data.request_close(closure.clone());let _=peer.control.send_close(closure.clone());}
            peer.control.close();
        }
    }
    pub fn consumer_ticket(&self,kind:ConsumerKind,fence:ConsumerFence)->Result<Value>{if !self.running.load(Ordering::Acquire){return Err("Gateway stopped".into());}let ticket=self.consumer_tickets.lock().unwrap().issue(kind,fence,Instant::now())?;Ok(json!({"ticket":ticket,"kind":kind.label(),"expiresInMs":10000,"capability":"scene-consumer-v1","ackStage":"consumer-released"}))}
    pub fn send(&self,id:&str,message:&Value)->Result<Value>{
        let peers=self.peers.lock().unwrap();
        if let Some(peer)=peers.get(id){
            if peer.control.closed.load(Ordering::Acquire){return Ok(json!(true));}
            // The original RPC graph stays under its input admission. Only a
            // final admitted packet/reason crosses the queue boundary.
            match crate::command::global().encode(message)?{
                Command::Close(closure)=>{
                    if peer.control.enabled.load(Ordering::Acquire){let _=peer.data.request_close(closure.clone());peer.control.send_close(closure)?;}
                    else{peer.data.request_close(closure).map_err(|_|"Native peer control queue full")?;}
                },
                Command::Text(text)=>{
                    if peer.control.enabled.load(Ordering::Acquire){peer.control.send(text)?;}
                    else{peer.data.send(text).map_err(|_|"Native peer control queue full")?;}
                },
            }
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
        self.deltas.lock().unwrap().on_publish();
    }
    pub fn reclaim_packets(&self)->usize{self.deltas.lock().unwrap().reclaim(packets::global())}
    pub fn reset(&self){*self.latest.lock().unwrap()=None;self.deltas.lock().unwrap().clear();}
    fn delta(&self,previous:&Snapshot,next:&Snapshot)->Result<tungstenite::Utf8Bytes>{self.deltas.lock().unwrap().delta(packets::global(),previous,next)}
    fn serve(&self, stream: TcpStream) -> Result<()> {
        let _route=owners::global().route()?;
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_millis(500)))
            .map_err(|e| e.to_string())?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        socket2::SockRef::from(&stream)
            .set_send_buffer_size(32 * 1024)
            .map_err(|e| e.to_string())?;
        let mut backing=crate::ws_memory::global().connection()?;
        let mut route = None;
        let callback = |request: &Request,
                        response: Response|
         -> std::result::Result<Response, ErrorResponse> {
            let forbidden = || {
                tungstenite::http::Response::builder()
                    .status(403)
                    .body(Some("Forbidden".into()))
                    .unwrap()
            };
            let query = |key: &str| {
                request.uri().query().and_then(|query| {
                    query.split('&').find_map(|part| {
                        part.split_once('=')
                            .filter(|(name, _)| *name == key)
                            .map(|(_, value)| value)
                    })
                })
            };
            if request
                .headers()
                .get("origin")
                .and_then(|value| value.to_str().ok())
                != self.config["origin"].as_str() || !self.running.load(Ordering::Acquire)
            {
                return Err(forbidden());
            }
            match request.uri().path() {
                "/stream" | "/consume" => {
                    let role=if request.uri().path()=="/consume"{self.consumer_tickets.lock().unwrap().claim(query("ticket").unwrap_or(""),Instant::now()).ok_or_else(forbidden)?}else{if query("key")!=self.config["key"].as_str(){return Err(forbidden());}ConsumerRole::display()};
                    let mut peers = self.peers.lock().unwrap();
                    let same_class=peers.values().filter(|peer|peer.kind.display()==role.kind.display()).count();
                    if same_class>=if role.kind.display(){crate::consumers::DISPLAY_SLOTS}else{crate::consumers::AUTOMATION_SLOTS} {return Err(forbidden());}
                    backing.role(crate::ws_memory::Kind::Data).map_err(|_|tungstenite::http::Response::builder().status(503).body(Some("WebSocket backing allocation pressure".into())).unwrap())?;
                    let peer_memory=owners::global().peer().map_err(|_|tungstenite::http::Response::builder().status(503).body(Some("Gateway state allocation pressure".into())).unwrap())?;
                    let id = format!("native-{}", self.next.fetch_add(1, Ordering::Relaxed));
                    let unavailable=||tungstenite::http::Response::builder().status(503).body(Some("Command queue allocation pressure".into())).unwrap();
                    let data=Mailbox::new(crate::command::global()).map_err(|_|unavailable())?;
                    let commands=data.receiver().ok_or_else(unavailable)?;
                    let control=Arc::new(crate::control::Channel::new().map_err(|_|unavailable())?);
                    peers.insert(
                        id.clone(),
                        Peer {
                            kind:role.kind,
                            data,
                            control: control.clone(),
                        },
                    );
                    route = Some(Route::Data(id, commands, control,peer_memory,role));
                }
                "/control" => {
                    if query("key")!=self.config["key"].as_str(){return Err(forbidden());}
                    let id = query("peer").ok_or_else(forbidden)?;
                    let peers = self.peers.lock().unwrap();
                    let peer = peers.get(id).ok_or_else(forbidden)?;
                    if !peer.kind.display(){return Err(forbidden());}
                    if !peer.control.claim(query("ticket").unwrap_or("")) {
                        return Err(forbidden());
                    }
                    backing.role(crate::ws_memory::Kind::Control).map_err(|_|tungstenite::http::Response::builder().status(503).body(Some("WebSocket backing allocation pressure".into())).unwrap())?;
                    route = Some(Route::Control(id.to_owned(), peer.control.clone()));
                }
                _ => return Err(forbidden()),
            }
            Ok(response)
        };
        let result=accept_hdr_with_config(stream,callback,Some(crate::ws_memory::config())).map_err(|e|e.to_string());
        let result=result.map(|ws|crate::ws_memory::Socket::new(ws,backing));
        match route {
            Some(Route::Data(id, commands, control,peer_memory,role)) => {
                let result =
                    result.and_then(|ws| self.serve_data(ws, &id, commands, control.clone(),peer_memory,role));
                control.close();
                self.peers.lock().unwrap().remove(&id);
                emit(Event("PeerClosed",&[("peerId",Text(&id))]));
                result
            }
            Some(Route::Control(id, control)) => {
                let result = result.and_then(|ws| control.serve(ws, &id, &self.config));
                control.close();
                emit(Event("ControlClosed",&[("peerId",Text(&id))]));
                result
            }
            None => result.map(|_| ()),
        }
    }
    fn serve_data(
        &self,
        mut ws: crate::ws_memory::Socket<TcpStream>,
        id: &str,
        commands: Inbox,
        control: Arc<crate::control::Channel>,
        _peer_memory:Reservation,
        role:ConsumerRole,
    ) -> Result<()> {
        let result=(||->Result<()>{
        ws.get_mut()
            .set_nonblocking(true)
            .map_err(|e| e.to_string())?;
        let started = Instant::now();
        let policy = |ws: &mut crate::ws_memory::Socket<TcpStream>, reason: &'static str| {
            crate::writer::close(ws, 1008, reason);
        };
        let mut input_window = Instant::now();
        let mut input_count = 0;
        let mut ready = false;
        let mut acked: Option<(u64, Arc<Snapshot>)> = None;
        let mut inflight: VecDeque<Flight> = VecDeque::new();
        let mut pending: Option<PendingFrame> = None;
        let mut notifications = VecDeque::new();
        let mut activity = false;
        // Old clients retain their one-frame contract. New clients explicitly
        // negotiate ordered commits and keep at most six unacknowledged frames.
        let mut frame_window = 1usize;
        let mut inflight_bytes = 0usize;
        let byte_window = 16 * 1024 * 1024;
        let mut abandoned = HashSet::new();
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
            if !activity {
                thread::sleep(Duration::from_millis(2));
            }
            activity = false;
            let mut closing=commands.close_command().map(Closing::Command);
            while closing.is_none() && notifications.len() < 64 {
                let Ok(message) = commands.try_recv() else {
                    break;
                };
                activity = true;
                match message {
                    Command::Close(closure)=>{closing=Some(Closing::Command(closure));break;},
                    Command::Text(text)=>notifications.push_back(Message::Text(text)),
                }
            }
            if !self.running.load(Ordering::Relaxed) {
                closing = Some(Closing::Local(1001,"Gateway stopped"));
            }
            if closing.is_none() && control.closed.load(Ordering::Acquire) && self.running.load(Ordering::Relaxed) {
                closing = Some(Closing::Local(1012,"Paired control connection closed"));
            }
            if (!ready
                || control.enabled.load(Ordering::Acquire)
                    && !control.ready.load(Ordering::Acquire))
                && started.elapsed() > Duration::from_secs(10)
            {
                closing = Some(Closing::Local(1008,"Handshake timeout"));
            }
            if inflight
                .front()
                .is_some_and(|flight| flight.sent.elapsed() > deadline)
            {
                closing = Some(Closing::Local(1013,"Viewer acknowledgement deadline; reconnect for keyframe"));
                stats["slowDisconnects"] = json!(1);
            }
            if pending
                .as_ref()
                .is_some_and(|frame| frame.progress_at.elapsed() > Duration::from_secs(15))
            {
                closing = Some(Closing::Local(1013,"Resource transport progress deadline"));
                stats["slowDisconnects"] = json!(1);
            }
            if let Some(closing)=closing {
                match &closing {
                    Closing::Command(closure)=>crate::writer::close(&mut ws,closure.code,&closure.reason),
                    Closing::Local(code,reason)=>crate::writer::close(&mut ws,*code,reason),
                }
                break;
            }
            match ws.read() {
                Ok(Message::Text(text)) => {
                    activity = true;
                    let message = match crate::ws_json::global().parse(text.as_bytes()) {
                        Ok(value) => value,
                        Err(error) => {
                            if error==crate::ws_json::PRESSURE {
                                crate::writer::close(&mut ws,1013,"WebSocket JSON allocation pressure");
                            } else { policy(&mut ws,"Invalid client JSON"); }
                            break;
                        }
                    };
                    if input_window.elapsed() > Duration::from_secs(1) {
                        input_window = Instant::now();
                        input_count = 0;
                    }
                    input_count += 1;
                    if input_count > 512 {
                        policy(&mut ws, "Client message rate exceeded");
                        break;
                    }
                    if !ready {
                        if message["type"] != "Hello"
                            || message["protocol"] != 4
                            || message["renderer"] != self.config["renderer"]
                        {
                            crate::writer::close(
                                &mut ws,
                                1008,
                                "Incompatible protocol or renderer",
                            );
                            break;
                        }
                        if !message["viewerBuild"].is_null()
                            && message["viewerBuild"] != self.config["viewerBuild"]
                        {
                            crate::writer::close(
                                &mut ws,
                                1008,
                                "Incompatible Viewer build; reload Viewer",
                            );
                            break;
                        }
                        if role.kind.display(){if !message["consumerKind"].is_null()&&message["consumerKind"]!="display"{policy(&mut ws,"Consumer authorization mismatch");break;}}
                        else if message["consumerKind"]!=role.kind.label()||!message["capabilities"].as_array().is_some_and(|caps|caps.iter().any(|c|c=="scene-consumer-v1")){policy(&mut ws,"Consumer capability mismatch");break;}
                        use_chunks = message["capabilities"]
                            .as_array()
                            .is_some_and(|caps| caps.iter().any(|c| c == "asset-chunks-v1"));
                        ws.set_write_limit(crate::ws_memory::DATA_WRITE)?;
                        if message["capabilities"]
                            .as_array()
                            .is_some_and(|caps| caps.iter().any(|c| c == "frame-window-v1"))
                        {
                            frame_window =
                                message["frameWindow"].as_u64().unwrap_or(6).clamp(1, 6) as usize;
                        }
                        ready = true;
                        let separate_control = role.kind.display() && self.config["input"] == true
                            && message["capabilities"]
                                .as_array()
                                .is_some_and(|caps| caps.iter().any(|c| c == "control-channel-v1"));
                        let ticket=if separate_control{Some(control.enable()?)}else{None};
                        let input_feedback = role.kind.display() && self.config["input"] == true
                            && message["capabilities"]
                                .as_array()
                                .is_some_and(|caps| caps.iter().any(|c| c == "input-feedback-v1"));
                        let resource_memory = self.config["resourceMemory"] == true
                            && message["capabilities"]
                                .as_array()
                                .is_some_and(|caps| caps.iter().any(|c| c == "resource-memory-v1"));
                        let welcome=if role.kind.display(){packets::global().notification(Lane::Data,&Notification::Welcome{config:&self.config,peer:id,window:frame_window,input_feedback,resource_memory,ticket:ticket.as_deref()})?}else{packets::global().notification(Lane::Data,&Notification::ConsumerWelcome{config:&self.config,peer:id,window:frame_window,resource_memory,kind:role.kind.label()})?};
                        notifications.push_back(Message::Text(welcome));
                        emit(Event("PeerReady",&[("consumerKind",Text(role.kind.label())),("inputFeedback",Bool(input_feedback)),("peerId",Text(id))]));
                    } else if message["type"] == "FrameAck" {
                        if !role.kind.display()&&message["stage"]!="consumer-released"{policy(&mut ws,"Invalid consumer acknowledgement stage");break;}
                        let ack_id = message["frameId"].as_u64().unwrap_or(0);
                        let ack_epoch = message["pageEpoch"].as_u64().unwrap_or(0);
                        // Recovery can overtake ACKs for frames already in the
                        // socket. Ignore only exact frames abandoned by us.
                        if abandoned.remove(&(ack_id, ack_epoch)) {
                            continue;
                        }
                        let Some(flight) = inflight.pop_front() else {
                            policy(&mut ws, "Unexpected acknowledgement");
                            break;
                        };
                        if message["frameId"] != flight.id
                            || message["pageEpoch"] != flight.snapshot.metadata["pageEpoch"]
                        {
                            policy(&mut ws, "Unexpected acknowledgement");
                            break;
                        }
                        inflight_bytes -= flight.bytes;
                        stats["ackRttMs"] = json!(flight.sent.elapsed().as_secs_f64() * 1000.0);
                        let mut current: HashSet<String> =
                            flight.snapshot.resources.keys().cloned().collect();
                        for pending in &inflight {
                            current.extend(pending.snapshot.resources.keys().cloned());
                        }
                        if let Some(preparing) = &pending {
                            current.extend(preparing.flight.snapshot.resources.keys().cloned());
                        }
                        let retired: Vec<_> = known.difference(&current).cloned().collect();
                        known = current;
                        if !retired.is_empty() {
                            notifications.push_back(Message::Text(packets::global().notification(Lane::Control,&Notification::Release(&retired))?));
                        }
                        acked = Some((flight.id, flight.snapshot));
                    } else if message["type"] == "RequestKeyframe" {
                        if recovery_start.elapsed() > Duration::from_secs(10) {
                            recovery_start = Instant::now();
                            recoveries = 0;
                        }
                        recoveries += 1;
                        if recoveries > 8 {
                            policy(&mut ws, "Too many recovery requests");
                            break;
                        }
                        for flight in inflight.drain(..) {
                            abandoned.insert((
                                flight.id,
                                flight.snapshot.metadata["pageEpoch"].as_u64().unwrap(),
                            ));
                        }
                        abandoned.retain(|(frame, _)| *frame + 64 >= next_id);
                        inflight_bytes = 0;
                        pending = None;
                        acked = None;
                        known.clear();
                        known_chunks.clear();
                        chunk_bytes = 0;
                        force_full = true;
                    } else if role.kind.display() && self.config["input"] == true
                        && matches!(
                            message["type"].as_str(),
                            Some("AcquireControl" | "RenewControl" | "ReleaseControl" | "Input")
                        )
                    {
                        if control.enabled.load(Ordering::Acquire) {
                            policy(&mut ws, "Use paired control connection");
                            break;
                        }
                        emit(Event("Control",&[("message",Json(&message)),("peerId",Text(id))]));
                    } else {
                        policy(&mut ws, "Unsupported message");
                        break;
                    }
                }
                Ok(Message::Close(_)) => {
                    crate::writer::close(&mut ws, 1000, "Closed");
                    break;
                }
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                    activity = true;
                }
                Ok(_) => {
                    policy(&mut ws, "Binary client messages unsupported");
                    break;
                }
                Err(error) if crate::ws_memory::is_pressure(&error)=>{
                    crate::writer::close(&mut ws,1013,"WebSocket backing allocation pressure");break;
                }
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(tungstenite::Error::ConnectionClosed)
                | Err(tungstenite::Error::AlreadyClosed) => break,
                Err(e) => return Err(e.to_string()),
            }
            let progress = crate::writer::drain(&mut ws, &mut notifications, 16)?;
            activity |= progress.packets > 0||progress.transport_progress;
            if progress.transport_progress{if let Some(frame)=&mut pending{frame.progress_at=Instant::now();}}
            if !progress.blocked && notifications.is_empty() {
                if let Some(frame) = &mut pending {
                    let progress = crate::writer::drain(&mut ws, &mut frame.packets, 2)?;
                    frame.remaining -= progress.bytes;
                    if progress.packets > 0||progress.transport_progress {
                        frame.progress_at = Instant::now();
                        activity = true;
                    }
                }
            }
            if pending
                .as_ref()
                .is_some_and(|frame| frame.packets.is_empty())
            {
                let mut completed = pending.take().unwrap();
                completed.flight.sent = Instant::now();
                let field = if completed.full { "full" } else { "delta" };
                stats[field] = json!(stats[field].as_u64().unwrap() + 1);
                stats["resources"] =
                    json!(stats["resources"].as_u64().unwrap() + completed.resources as u64);
                stats["bytes"] =
                    json!(stats["bytes"].as_u64().unwrap() + completed.flight.bytes as u64);
                inflight_bytes += completed.flight.bytes;
                stats["maxInflight"] = json!(
                    stats["maxInflight"]
                        .as_u64()
                        .unwrap()
                        .max((inflight.len() + 1) as u64)
                );
                stats["maxInflightBytes"] = json!(
                    stats["maxInflightBytes"]
                        .as_u64()
                        .unwrap_or(0)
                        .max(inflight_bytes as u64)
                );
                stats["pendingBytes"] = json!(0);
                inflight.push_back(completed.flight);
                emit(Event("PeerStats",&[("peerId",Text(id)),("stats",Json(&stats))]));
            }
            if pending.is_some()
                || !ready
                || control.enabled.load(Ordering::Acquire) && !control.ready.load(Ordering::Acquire)
                || inflight.len() >= frame_window
                || inflight_bytes >= byte_window
            {
                continue;
            }
            let Some(snapshot) = self.latest.lock().unwrap().clone() else {
                continue;
            };
            match role.decision(snapshot.serial,&snapshot.metadata){ConsumerDecision::Wait=>continue,ConsumerDecision::Changed=>{crate::writer::close(&mut ws,1012,"Consumer target changed");break;},ConsumerDecision::Deliver=>{}}
            owners::check_snapshot(&snapshot)?;
            let previous = inflight
                .back()
                .map(|flight| (flight.id, &flight.snapshot))
                .or_else(|| acked.as_ref().map(|(id, snapshot)| (*id, snapshot)));
            if !force_full && previous.is_some_and(|(_, old)| old.serial == snapshot.serial) {
                continue;
            }
            let full = force_full
                || previous.as_ref().is_none_or(|(_, old)| {
                    old.metadata["pageEpoch"] != snapshot.metadata["pageEpoch"]
                        || old.metadata["viewportVersion"] != snapshot.metadata["viewportVersion"]
                });
            next_id += 1;
            let delta=if full{None}else{Some(self.delta(previous.as_ref().unwrap().1,&snapshot)?)};
            let scene=packets::global().frame(&snapshot,next_id,if full{None}else{Some(previous.as_ref().unwrap().0)},delta.as_ref())?;
            let plan=delivery_plan(&snapshot,&known,&known_chunks,chunk_bytes,use_chunks)?;
            let commit=packets::global().notification(Lane::Control,&Notification::Commit{epoch:&snapshot.metadata["pageEpoch"],frame:next_id})?;
            let pending_bytes=plan.bytes+scene.len()+commit.len();
            let new_resources = snapshot
                .resources
                .keys()
                .filter(|hash| !known.contains(*hash))
                .count();
            if !inflight.is_empty()
                && (inflight_bytes + pending_bytes > byte_window
                    || known.len() + new_resources > 512)
            {
                // No frame ID has escaped yet; try the latest snapshot when
                // credit returns, keeping dependencies on the last sent frame.
                next_id -= 1;
                continue;
            }
            if let Some((_, old)) = &previous {
                stats["coalesced"] = json!(
                    stats["coalesced"].as_u64().unwrap()
                        + snapshot.serial.saturating_sub(old.serial + 1)
                );
            }
            let mut packets=VecDeque::new();
            if plan.initial_reset{packets.push_back(Message::Text(packets::global().notification(Lane::Control,&Notification::Reset)?));known_chunks.clear();chunk_bytes=0;}
            let resource_count=plan.items.len();
            for delivery in plan.items{
                if delivery.reset{packets.push_back(Message::Text(packets::global().notification(Lane::Control,&Notification::Reset)?));known_chunks.clear();chunk_bytes=0;}
                let resource=delivery.resource;
                if delivery.chunks{
                    for chunk in resource.chunks.iter(){if known_chunks.insert(chunk.id.clone()){packets.push_back(Message::Binary(chunk.wire.clone()));chunk_bytes+=chunk.wire.len()-44;}}
                    packets.push_back(Message::Text(resource.manifest.clone()));
                }else{packets.push_back(Message::Binary(resource.wire.clone()));}
                known.insert(delivery.id.to_owned());
            }
            packets.push_back(Message::Text(scene));packets.push_back(Message::Text(commit));
            let bytes = packets.iter().map(Message::len).sum();
            if bytes!=pending_bytes{return Err("Gateway delivery plan changed".into());}
            stats["maxPendingBytes"] = json!(
                stats["maxPendingBytes"]
                    .as_u64()
                    .unwrap_or(0)
                    .max(bytes as u64)
            );
            stats["pendingBytes"] = json!(bytes);
            if bytes > 256 * 1024 {
                emit(Event("PeerStats",&[("peerId",Text(id)),("stats",Json(&stats))]));
            }
            pending = Some(PendingFrame {
                flight: Flight {
                    id: next_id,
                    snapshot,
                    sent: Instant::now(),
                    bytes,
                },
                packets,
                remaining: bytes,
                resources: resource_count,
                full,
                progress_at: Instant::now(),
            });
            activity = true;
            force_full = false;
        }
        emit(Event("PeerStats",&[("peerId",Text(id)),("stats",Json(&stats))]));
        Ok(())
        })();
        if result.as_ref().is_err_and(|error|error==packets::PRESSURE){crate::writer::close(&mut ws,1013,"Gateway packet allocation pressure");}
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_auth_configuration_never_starts_a_listener() {
        for mut config in [
            json!({}),
            json!({"origin":"http://127.0.0.1"}),
            json!({"key":"secret"}),
        ] {
            assert!(Gateway::start(&mut config).is_err());
        }
    }
    #[test]
    fn root_visible_resources_precede_hidden_and_unreferenced_dependencies() {
        let resource = Arc::new(crate::assets::resource(
            b"skiapictabcdefghijklmnopqrst".to_vec(),
            "fixture",
            &Value::Null,
            &mut HashMap::new(),
        )
        .unwrap());
        let resources = ["front", "child", "hidden"]
            .into_iter()
            .map(|id| (id.to_owned(), resource.clone()))
            .collect();
        let scene = json!({"rootPass":"root","passes":[
            {"id":"child-pass","quads":[{"resourceId":"child","visible":[0,0,10,10],"opacity":1}]},
            {"id":"root","quads":[
                {"resourceId":"hidden","visible":[0,0,10,10],"opacity":0.0},
                {"resourceId":"front","visible":[0,0,10,10],"opacity":1},
                {"kind":"pass","passId":"child-pass","visible":[0,0,10,10],"opacity":1}
            ]}
        ]});
        let snapshot = Snapshot {
            serial: 1,
            scene,
            resources,
            metadata: Value::Null,
            full_json: String::new(),
            _graph:crate::snapshot_memory::SnapshotPool::new(1024).0.reserve(1024).unwrap(),
        };
        assert_eq!(resource_order(&snapshot), ["front", "child", "hidden"]);
    }
}
#[cfg(test)]mod state_ownership_tests{
 use super::*;
 use crate::allocation_probe::observe;
 fn fixture()->Arc<Snapshot>{let resource=Arc::new(crate::assets::resource(b"skiapictabcdefghijklmnopqrst".to_vec(),"fixture",&Value::Null,&mut HashMap::new()).unwrap());let resources=(0..256).map(|n|(format!("{n:064x}"),resource.clone())).collect();let mut passes=vec![];for n in 0..64{let mut quads:Vec<_>=(0..4).map(|q|json!({"kind":"picture","resourceId":format!("{:064x}",n*4+q),"visible":[0,0,10,10],"opacity":1})).collect();if n>0{quads.push(json!({"kind":"pass","passId":format!("pass-{}",n-1),"visible":[0,0,10,10],"opacity":1}));}passes.push(json!({"id":format!("pass-{n}"),"quads":quads}));}Arc::new(Snapshot{serial:1,scene:json!({"rootPass":"pass-63","passes":passes}),resources,metadata:json!({"pageEpoch":1}),full_json:String::new(),_graph:crate::snapshot_memory::SnapshotPool::new(4*1024*1024).0.reserve(4*1024*1024).unwrap()})}
 #[test]fn complete_peer_and_scratch_upper_bound_layout_fits_lifetime_reservation(){
  let snapshot=fixture();owners::check_snapshot(&snapshot).unwrap();let ids:Vec<_>=(0..owners::KNOWN_CHUNKS).map(|n|format!("{n:064x}")).collect();let binary=bytes::Bytes::from_static(b"RPNTfixture");let text=tungstenite::Utf8Bytes::from_static("manifest");let pool=owners::Pool::new(owners::DEFAULT_BYTES);let peer=pool.peer().unwrap();
  let(held,live,peak)=observe(||{
   let mut known_chunks=HashSet::new();for id in &ids[..32768]{known_chunks.insert(id.clone());}let mut pending_chunks=HashSet::new();for id in &ids[32768..]{pending_chunks.insert(id.as_str());}let mut packets=VecDeque::new();for id in &ids[32768..]{if known_chunks.insert(id.clone()){packets.push_back(Message::Binary(binary.clone()));}}for _ in 0..259{packets.push_back(Message::Text(text.clone()));}
   let known:HashSet<_>=ids[..512].iter().cloned().collect();let current:HashSet<_>=ids[..7*256].iter().cloned().collect();let retired:Vec<_>=ids[..512].to_vec();let abandoned:HashSet<_>=(0..65).map(|n|(n,1)).collect();let inflight:VecDeque<_>=(0..6).map(|n|Flight{id:n,snapshot:snapshot.clone(),sent:Instant::now(),bytes:1}).collect();let notifications:VecDeque<_>=(0..72).map(|_|Message::Text(text.clone())).collect();let mut stats=json!({"full":0,"delta":0,"resources":0,"bytes":0,"coalesced":0,"slowDisconnects":0,"maxInflight":0});for key in ["ackRttMs","maxInflightBytes","pendingBytes","maxPendingBytes"]{stats[key]=json!(1);}let order=resource_order(&snapshot);(known_chunks,pending_chunks,packets,known,current,retired,abandoned,inflight,notifications,stats,order)
  });assert!(peak<=owners::PEER_BYTES);assert_eq!(held.0.len(),owners::KNOWN_CHUNKS);assert_eq!(held.2.len(),owners::FRAME_CHUNKS+259);assert_eq!(held.10.len(),256);println!("gateway-state-after: known_chunks={} known_capacity={} pending_capacity={} packet_len={} packet_capacity={} message_size={} live={live} requested_peak={peak} reservation={}",held.0.len(),held.0.capacity(),held.1.capacity(),held.2.len(),held.2.capacity(),std::mem::size_of::<Message>(),owners::PEER_BYTES);drop(held);assert_eq!(pool.stats()["peer"]["bytes"],owners::PEER_BYTES,"clear/drop of data must not pretend to retire the live guard");drop(peer);assert_eq!(pool.stats()["bytes"],0);assert_eq!(pool.stats()["allocations"],0);
 }
 #[test]fn snapshot_shape_checks_preserve_maximum_valid_pass_and_resource_counts(){
  let mut valid=fixture();assert!(owners::check_snapshot(&valid).is_ok());Arc::get_mut(&mut valid).unwrap().scene["passes"].as_array_mut().unwrap().push(json!({"id":"extra"}));assert!(owners::check_snapshot(&valid).is_err());let mut valid=fixture();let snapshot=Arc::get_mut(&mut valid).unwrap();let value=snapshot.resources.values().next().unwrap().clone();snapshot.resources.insert("bad".to_owned(),value);assert!(owners::check_snapshot(&valid).is_err());assert_eq!(owners::FRAME_CHUNKS,133376);assert_eq!(owners::KNOWN_CHUNKS,166144);
 }
 // Arc strong_count reaches zero before its destructor has finished. Keep
 // the original1s gate and waitforactualfinallease retirement aswell.
 #[test]fn actual_start_moves_retained_config_and_waits_for_last_gateway_arc_before_credit_returns(){
  let _=owners::global().stats();let _=packets::global();let mut config=json!({"origin":"http://127.0.0.1","key":"fixture","host":"127.0.0.1","port":0,"renderer":{},"padding":"x".repeat(128*1024),"unknown":vec![0;4000]});let pointer=config["padding"].as_str().unwrap().as_ptr();let((gateway,_),live,peak)=observe(||Gateway::start(&mut config).unwrap());assert!(config.is_null());assert_eq!(gateway.config["padding"].as_str().unwrap().as_ptr(),pointer);assert_eq!(gateway.config["unknown"].as_array().unwrap().len(),4000);let stats=owners::global().stats();assert_eq!(stats["config"]["owners"],1);assert_eq!(stats["registry"]["owners"],1);assert!(peak<=stats["bytes"].as_u64().unwrap()as usize);println!("gateway-start-after: live={live} requested_peak={peak} reservation={} config_pointer_preserved=true",stats["bytes"]);let weak=Arc::downgrade(&gateway);gateway.stop();assert!(owners::global().stats()["bytes"].as_u64().unwrap()>0);drop(gateway);let end=Instant::now()+Duration::from_secs(1);while weak.strong_count()>0||owners::global().stats()["bytes"].as_u64().unwrap()>0{assert!(Instant::now()<end);thread::sleep(Duration::from_millis(2));}assert_eq!(owners::global().stats()["bytes"],0);assert_eq!(owners::global().stats()["config"]["owners"],0);assert_eq!(owners::global().stats()["registry"]["owners"],0);
 }
}
#[cfg(test)]mod delivery_tests{
 use super::*;
 use sha2::{Digest,Sha256};
 fn resource(seed:u32,bytes:usize,dense:bool)->Arc<crate::scene::Resource>{let mut data=vec![0;bytes];let mut state=seed;for byte in &mut data{state^=state<<13;state^=state>>17;state^=state<<5;*byte=state as u8;}data[..8].copy_from_slice(b"skiapict");let id=format!("{:x}",Sha256::digest(&data));let ranges=if dense{json!((0..256).map(|n|json!({"offset":16+n*32,"bytes":16,"kind":"font"})).collect::<Vec<_>>())}else{Value::Null};Arc::new(crate::assets::resource(data,&id,&ranges,&mut HashMap::new()).unwrap())}
 fn snapshot(resources:Vec<Arc<crate::scene::Resource>>)->Arc<Snapshot>{let ids:Vec<_>=resources.iter().map(|r|serde_json::from_str::<Value>(&r.manifest).unwrap()["id"].as_str().unwrap().to_owned()).collect();let quads:Vec<_>=ids.iter().map(|id|json!({"kind":"picture","resourceId":id,"visible":[0,0,10,10],"opacity":1})).collect();Arc::new(Snapshot{serial:1,scene:json!({"rootPass":"root","passes":[{"id":"root","quads":quads}]}),resources:ids.into_iter().zip(resources).collect(),metadata:json!({"pageEpoch":1}),full_json:String::new(),_graph:crate::snapshot_memory::SnapshotPool::new(1024).0.reserve(1024).unwrap()})}
 fn unique_wire(resource:&crate::scene::Resource)->usize{let mut seen=HashSet::new();resource.chunks.iter().filter(|c|seen.insert(c.id.as_str())).map(|c|c.wire.len()).sum()}
 #[test]fn dense_sections_use_existing_raw_format_without_disabling_normal_large_chunk_reuse(){
  let dense=resource(1,256*32+16,true);assert_eq!(dense.chunks.len(),513);let small=resource(3,4096,false);let small_snapshot=snapshot(vec![small]);assert!(delivery_plan(&small_snapshot,&HashSet::new(),&HashSet::new(),0,true).unwrap().items[0].chunks);let normal=resource(2,2*1024*1024,false);let snapshot=snapshot(vec![dense.clone(),normal.clone()]);let plan=delivery_plan(&snapshot,&HashSet::new(),&HashSet::new(),0,true).unwrap();assert!(!plan.items[0].chunks);assert!(plan.items[1].chunks);assert_eq!(plan.bytes,dense.wire.len()+normal.manifest.len()+unique_wire(&normal));
  let known_chunks:HashSet<_>=normal.chunks.iter().map(|chunk|chunk.id.clone()).collect();let plan=delivery_plan(&snapshot,&HashSet::new(),&known_chunks,normal.payload.len(),true).unwrap();assert!(!plan.items[0].chunks);assert!(plan.items[1].chunks);assert_eq!(plan.bytes,dense.wire.len()+normal.manifest.len());println!("gateway-delivery-choice: dense_chunks=513 raw_bytes={} manifest_bytes={} normal_bytes={} normal_chunks={} warm_bytes={}",dense.wire.len(),dense.manifest.len(),normal.payload.len(),normal.chunks.len(),plan.bytes);
 }
 #[test]fn within_frame_reset_precedes_resource_and_exact_plan_counts_all_resent_chunks(){
  let first=resource(7,2*1024*1024,false);let second=resource(11,2*1024*1024,false);let unique=first.chunks.iter().map(|c|c.id.as_str()).collect::<HashSet<_>>().len();let known_chunks:HashSet<_>=(0..CHUNK_CACHE_ENTRIES-unique).map(|n|format!("{n:064x}")).collect();let snapshot=snapshot(vec![first.clone(),second.clone()]);let plan=delivery_plan(&snapshot,&HashSet::new(),&known_chunks,known_chunks.len()*16,true).unwrap();assert!(!plan.initial_reset);assert!(!plan.items[0].reset);assert!(plan.items[1].reset);assert!(plan.items.iter().all(|x|x.chunks));assert_eq!(plan.bytes,first.manifest.len()+unique_wire(&first)+RESET_BYTES+second.manifest.len()+unique_wire(&second));
  let initial:HashSet<_>=(0..CHUNK_CACHE_ENTRIES+1).map(|n|format!("{n:064x}")).collect();let plan=delivery_plan(&snapshot,&HashSet::new(),&initial,1,true).unwrap();assert!(plan.initial_reset);assert_eq!(plan.bytes,RESET_BYTES+first.manifest.len()+unique_wire(&first)+second.manifest.len()+unique_wire(&second));
 }
}
