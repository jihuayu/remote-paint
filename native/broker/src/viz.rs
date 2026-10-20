use crate::output::{Event,EventField::{MaybeText,Text}};
use crate::{emit, scene::Result};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    os::unix::{fs::PermissionsExt, net::{UnixListener,UnixStream}},
    sync::{
        Arc, Condvar, Mutex, Weak,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};
pub const OUTPUT_OVERLOAD:&str="Viz scene writer overloaded";
pub const OUTPUT_TRANSPORT:&str="Viz scene transport failed";
fn drain(stream:&mut UnixStream,mut remaining:usize)->bool{
    let mut scratch=[0;8192];
    while remaining>0{
        let n=remaining.min(scratch.len());
        if stream.read_exact(&mut scratch[..n]).is_err(){return false;}remaining-=n;
    }true
}
struct ScenePlan{root:[f64;4],graph_bytes:usize,error:Option<String>}
fn native_scene_plan(bytes:&[u8])->Result<ScenePlan>{
    if bytes.len()>256*1024{return Err("Native Viz packet limit".into());}
    let mut r=Reader{bytes,offset:0};
    if r.take(6)?!=b"RVB2\x01\x01"{return Err("Invalid native Viz header".into());}
    r.text(128)?;r.u32()?;r.u32()?;
    let passes=r.u32()? as usize;if passes>64{return Err("Viz pass limit".into());}
    let mut root=[0.;4];let mut quads=0usize;
    for _ in 0..passes{
        r.text(64)?;for n in &mut root{*n=r.f64()?;}
        let count=r.u32()? as usize;quads=quads.checked_add(count).ok_or("Viz quad limit")?;
        if quads>2048{return Err("Viz quad limit".into());}
        for _ in 0..count{
            let kind=r.u8()?;if !(1..=3).contains(&kind){return Err("Unknown Viz kind".into());}
            for _ in 0..3{r.u32()?;}
            for _ in 0..20{r.f64()?;} // matrix9,visible4,rect4,origin2,opacity1
            if r.u8()?!=0{for _ in 0..4{r.f64()?;}}
            if r.u8()?!=0{for _ in 0..12{r.f64()?;}}
            r.u32()?;
            if kind==1{for _ in 0..4{r.f64()?;}}
            else if kind==2{r.text(64)?;}
        }
    }
    let error=if r.u8()?!=0{Some(r.text(4096)?.to_owned())}else{None};
    if r.offset!=bytes.len()||passes==0&&error.is_none(){return Err("Invalid native Viz packet".into());}
    // Price more nodes than the decoder can emit (including temporary number
    // vectors, keys and BTreeMap nodes). Raw wire backing keeps its own lease.
    let graph_bytes=65536usize.checked_add(bytes.len()*4)
        .and_then(|n|n.checked_add(passes*32*768))
        .and_then(|n|n.checked_add(quads*128*768)).ok_or(crate::input::PRESSURE)?;
    Ok(ScenePlan{root,graph_bytes,error})
}
pub(crate) fn native_scene_packet(bytes:crate::budget::OwnedVec)->Result<crate::subscriptions::ScenePacket>{
    let plan=native_scene_plan(&bytes)?;
    Ok(crate::subscriptions::ScenePacket{bytes,root:plan.root,graph_bytes:plan.graph_bytes,error:plan.error})
}
pub struct Viz {
    pub native:Arc<crate::subscriptions::Subscriptions>,
    admission:Mutex<()>,
    streams:Mutex<[Option<Weak<crate::subscriptions::Connection>>;4]>,
    mapping:Mutex<Option<MappingOwner>>,
    expected: Mutex<HashSet<String>>,
    scenes: Mutex<HashMap<String, Value>>,
    resources_expected: Mutex<HashSet<String>>,
    resources: Mutex<HashMap<String, NativeResources>>,
    failures: Mutex<HashMap<String,String>>,
    pub input: crate::input::InputPool,
    budget: crate::budget::Budget,
    resource_ready: Condvar,
    running: AtomicBool,
}
// Inline scalar identity: mapping must still enter the control/fault wait
// when the entire data input pool is already occupied by partial packets.
struct MappingOwner{id:[u8;128],length:usize}
impl MappingOwner{fn text(&self)->&str{std::str::from_utf8(&self.id[..self.length]).unwrap()}}
pub struct LegacyMapping(Arc<Viz>);
impl Drop for LegacyMapping{
    fn drop(&mut self){let owner={let _gate=self.0.admission.lock().unwrap();self.0.mapping.lock().unwrap().take()};drop(owner);}
}
impl Viz {
    pub fn start(path: &str,input:crate::input::InputPool,budget:crate::budget::Budget) -> Result<Arc<Self>> {
        Self::start_with_wake(path,input,budget,Arc::new(crate::subscriptions::Wake::default()))
    }
    pub fn start_with_wake(path:&str,input:crate::input::InputPool,budget:crate::budget::Budget,wake:Arc<crate::subscriptions::Wake>)->Result<Arc<Self>>{
        let listener = UnixListener::bind(path).map_err(|e| e.to_string())?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let native=Arc::new(crate::subscriptions::Subscriptions::new(input.clone(),wake));
        let viz = Arc::new(Self {
            native,admission:Mutex::new(()),streams:Mutex::new(std::array::from_fn(|_|None)),mapping:Mutex::new(None),
            expected: Mutex::new(HashSet::new()),
            scenes: Mutex::new(HashMap::new()),
            resources_expected: Mutex::new(HashSet::new()),
            resources: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),input,budget,
            resource_ready: Condvar::new(),
            running: AtomicBool::new(true),
        });
        let owner = viz.clone();
        let connections = Arc::new(AtomicUsize::new(0));
        thread::spawn(move || {
            let mut expiration=std::time::Instant::now();
            while owner.running.load(Ordering::Relaxed) {
                if expiration.elapsed()>=Duration::from_millis(100){owner.native.expire(std::time::Instant::now());expiration=std::time::Instant::now();}
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if connections.fetch_add(1, Ordering::Relaxed) >= 4 {
                            connections.fetch_sub(1, Ordering::Relaxed);
                            continue;
                        }
                        let server = owner.clone();
                        let connections = connections.clone();
                        thread::spawn(move || {
                            server.receive(&mut stream);
                            connections.fetch_sub(1, Ordering::Relaxed);
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(viz)
    }
    fn legacy_ids(&self)->HashSet<String>{
        // Only removals/transfers can race this snapshot; new admissions share
        // admission. IDs are bounded and deduplicated across their two planes.
        let mut ids=self.expected.lock().unwrap().clone();
        ids.extend(self.resources_expected.lock().unwrap().iter().cloned());
        ids.extend(self.scenes.lock().unwrap().keys().cloned());
        ids.extend(self.resources.lock().unwrap().keys().cloned());
        ids.extend(self.failures.lock().unwrap().keys().cloned());
        if let Some(owner)=self.mapping.lock().unwrap().as_ref(){ids.insert(owner.text().to_owned());}ids
    }
    fn native_capacity(&self)->bool{self.legacy_ids().len()+self.native.inflight()<4}
    pub fn begin_mapping(self:&Arc<Self>,id:&str)->Result<LegacyMapping>{
        let _gate=self.admission.lock().unwrap();
        if id.len()>128||!self.legacy_ids().contains(id){return Err("Native capture not registered".into());}
        let mut mapping=self.mapping.lock().unwrap();if mapping.is_some(){return Err("Legacy mapping already active".into());}
        let mut bytes=[0;128];bytes[..id.len()].copy_from_slice(id.as_bytes());*mapping=Some(MappingOwner{id:bytes,length:id.len()});
        Ok(LegacyMapping(self.clone()))
    }
    pub fn register_native(&self,config:crate::subscriptions::Config)->Result<Value>{
        let _admission=self.admission.lock().unwrap();
        if self.legacy_ids().iter().any(|id|crate::subscriptions::Identity::from_id(id).is_some_and(|(key,_)|key==config.key)){
            return Err("Native scope conflicts with legacy capture".into());
        }
        self.native.register(config)
    }
    fn receive(&self,stream:&mut UnixStream){
        use crate::subscriptions::{Connection,Kind,Identity,Outcome};
        let _=stream.set_nonblocking(false);
        let connection=match stream.try_clone(){Ok(stream)=>Arc::new(Connection::new(stream)),Err(_)=>return};
        {
            let mut streams=self.streams.lock().unwrap();
            let Some(slot)=streams.iter_mut().find(|slot|slot.as_ref().and_then(Weak::upgrade).is_none_or(|c|!c.active()))else{return;};
            *slot=Some(Arc::downgrade(&connection));
        }
        loop{
            let _=stream.set_read_timeout(None);
            let mut header=[0;4];if stream.read_exact(&mut header).is_err(){break;}
            let length=u32::from_be_bytes(header)as usize;
            let _=stream.set_read_timeout(Some(Duration::from_secs(15)));
            if length==0||length>72*1024*1024{emit(Event("VizRejected",&[]));break;}
            if length==7{
                let mut fault=[0;7];if stream.read_exact(&mut fault).is_err(){break;}
                self.handle_fault(&fault);continue;
            }
            // Authorize native identities before allocating/decoding an RPA
            // payload. The bounded prefix is enough for every native frame ID.
            let mut prefix=[0;256];let mut first=length.min(10);
            if stream.read_exact(&mut prefix[..first]).is_err(){break;}
            // Read only the complete ID, not an arbitrary256-byte prefix.
            // A declared partial packet must obtain its raw admission before
            // waiting for metadata/body bytes that may never arrive.
            if first==10&&(prefix[..first].starts_with(b"RPA2\x01\x01")||prefix[..first].starts_with(b"RVB2\x01\x01")){
                let id_bytes=u32::from_be_bytes(prefix[6..10].try_into().unwrap())as usize;
                if id_bytes<=128&&10+id_bytes<=length{
                    if stream.read_exact(&mut prefix[10..10+id_bytes]).is_err(){break;}
                    first=10+id_bytes;
                }
            }
            let id=packet_id(&prefix[..first]);
            let kind=if prefix[..first].starts_with(b"RPA2\x01\x01"){Some(Kind::Resources)}
                else if prefix[..first].starts_with(b"RVB2\x01\x01"){Some(Kind::Scene)}else{None};
            let legacy_authorized=match(kind,id.as_deref()){
                (Some(Kind::Resources),Some(id))=>self.resources_expected.lock().unwrap().contains(id),
                (Some(Kind::Scene),Some(id))=>self.expected.lock().unwrap().contains(id),
                _=>false,
            };
            let native=if let(Some(id),Some(kind))=(id.as_deref(),kind){
                if let Some((key,_))=Identity::from_id(id){
                    let _admission=self.admission.lock().unwrap();
                    if !self.native.contains(key)&&legacy_authorized{None}else{
                        self.native.reserve(id,kind,(kind==Kind::Resources).then(||connection.clone()),
                            self.native_capacity())
                    }
                }else{None}
            }else{None};
            if native.is_none()&&kind.is_some()&&!legacy_authorized{
                if !drain(stream,length-first){break;}
                emit(Event("VizRejected",&[("captureId",MaybeText(id.as_deref())),
                    ("reason",Text(if kind==Some(Kind::Resources){"unexpected-resources"}else{"unexpected-scene"}))]));
                continue;
            }
            let stamp=match native{
                Some(Ok(stamp))=>Some(stamp),
                Some(Err(rejected))=>{
                    if !drain(stream,length-first){break;}
                    if kind==Some(Kind::Resources){
                        if let Some(identity)=rejected.identity{connection.send(identity,rejected.outcome);}
                    }
                    emit(Event("VizRejected",&[("captureId",MaybeText(id.as_deref())),("reason",Text(rejected.reason))]));
                    continue;
                }
                None=>None,
            };
            if let Some(stamp)=stamp{
                if kind==Some(Kind::Scene)&&length>256*1024{
                    let drained=drain(stream,length-first);
                    self.native.fail(stamp,"Native Viz packet limit",Outcome::Pause);
                    if !drained{break;}continue;
                }
            }
            let mut bytes=match self.input.packet(length){
                Ok(bytes)=>bytes,
                Err(error)=>{
                    let drained=drain(stream,length-first);
                    if let Some(stamp)=stamp{self.native.fail(stamp,crate::input::PRESSURE,Outcome::Pause);}
                    else{self.reject_packet(id.as_deref(),&error);}
                    if !drained{break;}continue;
                }
            };
            bytes.initialized()[..first].copy_from_slice(&prefix[..first]);
            if stream.read_exact(&mut bytes.initialized()[first..]).is_err(){
                drop(bytes);
                if let Some(stamp)=stamp{self.native.fail(stamp,"Native packet transport failed",Outcome::Pause);}
                break;
            }
            if let Some(stamp)=stamp{
                match kind.unwrap(){
                    Kind::Resources=>{
                        let resources=decode_resources(&bytes,&self.input,&self.budget);drop(bytes);
                        match resources{
                            Ok(resources)=>{self.native.resources(stamp,resources);},
                            Err(error)=>{
                                let reason=if error==crate::budget::PRESSURE{crate::budget::PRESSURE}
                                    else if error==crate::input::PRESSURE{crate::input::PRESSURE}else{"Invalid native resource packet"};
                                self.native.fail(stamp,reason,Outcome::Pause);
                            }
                        }
                    }
                    Kind::Scene=>{
                        match native_scene_packet(bytes){
                            Ok(scene)=>{self.native.scene(stamp,scene);}
                            Err(_)=>{self.native.fail(stamp,"Invalid native Viz packet",Outcome::Pause);}
                        }
                    }
                }
                continue;
            }
            if bytes.starts_with(b"RVE2"){self.handle_fault(&bytes);continue;}
            if bytes.starts_with(b"RPA2"){
                let decoded=decode_resources(&bytes,&self.input,&self.budget);
                drop(bytes);
                match decoded{
                    Ok(resources)=>{
                        let id=resources.metadata["captureId"].as_str().unwrap().to_owned();
                        if !self.accept_resources(id.clone(),resources){
                            emit(Event("VizRejected",&[("captureId",Text(&id)),("reason",Text("unexpected-resources"))]));
                        }
                    }
                    Err(error)=>self.reject_packet(id.as_deref(),&error),
                }continue;
            }
            if bytes.len()>256*1024{emit(Event("VizRejected",&[]));break;}
            let decoded=decode(&bytes);
            // A ready notification can immediately trigger control/metadata
            // admission in another thread. The decoded graph no longer needs
            // this raw packet; retire its backing before publishing readiness.
            drop(bytes);
            match decoded{
                Ok(scene)=>{
                    let id=scene["captureId"].as_str().unwrap().to_owned();
                    let error=scene["error"].as_str().map(str::to_owned);
                    if !self.accept_scene(&id,scene){
                        emit(Event("VizRejected",&[("captureId",Text(&id)),("reason",Text("unexpected-scene"))]));continue;
                    }
                    if let Some(error)=error{emit(Event("VizReady",&[("captureId",Text(&id)),("code",MaybeText(scene_error_code(&error))),("error",Text(&error))]));}
                    else{emit(Event("VizReady",&[("captureId",Text(&id))]));}
                }
                Err(error)=>emit(Event("VizRejected",&[("reason",Text(&error))])),
            }
        }
        connection.close();
        self.native.connection_closed(&connection);
    }
    pub fn expect(&self, id: &str, resources: bool) -> Result<Value> {
        let _admission=self.admission.lock().unwrap();
        if crate::subscriptions::Identity::from_id(id).is_some_and(|(key,_)|self.native.contains(key)){
            return Err("Capture ID belongs to native subscription".into());
        }
        let native=self.native.inflight();
        if native>0&&native+self.legacy_ids().len()>=4{return Err("Viz request unavailable".into());}
        let mut expected = self.expected.lock().unwrap();
        if expected.len()+self.scenes.lock().unwrap().len()+self.failures.lock().unwrap().len() >= 4 || expected.contains(id) || id.len() > 128 {
            return Err("Viz request unavailable".into());
        }
        expected.insert(id.into());
        if resources {
            let mut pending = self.resources_expected.lock().unwrap();
            if pending.len()+self.resources.lock().unwrap().len() >= 4 {
                expected.remove(id);
                return Err("Native resource request limit".into());
            }
            pending.insert(id.into());
        }
        Ok(json!(true))
    }
    fn accept_resources(&self, id: String, resources: NativeResources) -> bool {
        let mut expected = self.resources_expected.lock().unwrap();
        if !expected.remove(&id) { return false; }
        // Hold membership through publication: cancellation/fault cleanup may
        // otherwise miss bytes inserted just after it removed the expectation.
        self.resources.lock().unwrap().insert(id, resources);
        self.resource_ready.notify_all();
        true
    }
    fn accept_scene(&self, id: &str, scene: Value) -> bool {
        let mut expected = self.expected.lock().unwrap();
        if !expected.remove(id) { return false; }
        if !scene["error"].is_string() { self.scenes.lock().unwrap().insert(id.into(), scene); }
        true
    }
    pub fn cancel(&self, id: &str) {
        self.expected.lock().unwrap().remove(id);
        self.scenes.lock().unwrap().remove(id);
        self.resources_expected.lock().unwrap().remove(id);
        self.resources.lock().unwrap().remove(id);
        self.failures.lock().unwrap().remove(id);
    }
    fn reject_packet(&self,id:Option<&str>,error:&str){
        if let Some(id)=id {
            let mut expected=self.expected.lock().unwrap();let mut resources_expected=self.resources_expected.lock().unwrap();
            if expected.contains(id)||resources_expected.contains(id){
                expected.remove(id);resources_expected.remove(id);
                let scene=self.scenes.lock().unwrap().remove(id);let resources=self.resources.lock().unwrap().remove(id);
                self.failures.lock().unwrap().insert(id.to_owned(),error.to_owned());self.resource_ready.notify_all();
                drop(resources_expected);drop(expected);drop(scene);drop(resources);
                emit(Event("VizReady",&[("captureId",Text(id)),("code",MaybeText(crate::error_code(error))),("error",Text(error))]));return;
            }
        }
        emit(Event("VizRejected",&[("captureId",MaybeText(id)),("code",MaybeText(crate::error_code(error))),("reason",Text(error))]));
    }
    fn handle_fault(&self,bytes:&[u8]){
        match decode_fault(bytes){
            Ok((code,error))=>{
                self.native.fault(error);
                for id in self.reject_expected(error){emit(Event("VizReady",&[("captureId",Text(&id)),("code",Text(code)),("error",Text(error))]));}
            },
            Err(error)=>emit(Event("VizRejected",&[("reason",Text(&error))])),
        }
    }
    fn reject_expected(&self,error:&str) -> Vec<String> {
        let mut expected=self.expected.lock().unwrap();
        let mut resources_expected=self.resources_expected.lock().unwrap();
        // Membership locks stay held through retirement, matching both
        // publication paths. A completed pair has left both sets. A scene
        // already delivered/taken can still be waiting for raw resources.
        let awaiting_raw:HashSet<_>=resources_expected.iter().filter(|id|!expected.contains(*id)).cloned().collect();
        let mut ids:Vec<_>=expected.drain().chain(resources_expected.drain()).collect();ids.sort();ids.dedup();
        let mut scenes=self.scenes.lock().unwrap();let mut resources=self.resources.lock().unwrap();let mut failures=self.failures.lock().unwrap();
        let mut retired_scenes=Vec::new();let mut retired_resources=Vec::new();
        for id in &ids{
            if let Some(scene)=scenes.remove(id){retired_scenes.push(scene);}
            if let Some(raw)=resources.remove(id){retired_resources.push(raw);}
            // A pending scene has an error callback below and no map can yet
            // wait for its raw data. Only an already delivered/taken scene
            // needs a retained receipt. Otherwise failed callbacks would pin
            // registration slots until a redundant cancel/take arrives.
            if awaiting_raw.contains(id){failures.insert(id.clone(),error.to_owned());}
        }
        self.resource_ready.notify_all();
        drop(failures);drop(resources);drop(scenes);drop(resources_expected);drop(expected);
        // Metadata/payload owners can be expensive to free; do it outside
        // registry locks, and never return their credits before data dies.
        drop(retired_scenes);drop(retired_resources);
        ids
    }
    pub fn take(&self, id: &str) -> Result<Value> {
        let _expected=self.expected.lock().unwrap();
        if let Some(error)=self.failures.lock().unwrap().remove(id){return Err(error);}
        self.scenes
            .lock()
            .unwrap()
            .remove(id)
            .ok_or("Native Viz pairing unavailable".into())
    }
    pub fn take_resources(&self, id: &str) -> Result<NativeResources> {
        let resources = self.resources.lock().unwrap();
        let (mut resources, _) = self
            .resource_ready
            .wait_timeout_while(resources, Duration::from_secs(3), |r| !r.contains_key(id)&&!self.failures.lock().unwrap().contains_key(id))
            .unwrap();
        if let Some(error)=self.failures.lock().unwrap().remove(id){return Err(error);}
        resources
            .remove(id)
            .ok_or("Native resource pairing unavailable".into())
    }
    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);self.native.stop();
        let streams=self.streams.lock().unwrap().clone();
        for connection in streams.into_iter().flatten().filter_map(|c|c.upgrade()){connection.close();}
    }
}
pub fn fault_error_code(error:&str)->Option<&'static str>{match error{OUTPUT_OVERLOAD=>Some("VIZ_OUTPUT_OVERLOAD"),OUTPUT_TRANSPORT=>Some("VIZ_OUTPUT_TRANSPORT"),_=>None}}
fn scene_error_code(error: &str) -> Option<&'static str> {
    (error == "Captured compositor frame superseded before aggregation").then_some("VIZ_CAPTURE_SUPERSEDED")
}
fn decode_fault(bytes: &[u8]) -> Result<(&'static str, &'static str)> {
    if bytes.len() != 7 || &bytes[..6] != b"RVE2\x01\x01" {
        return Err("Invalid Viz fault receipt".into());
    }
    match bytes[6] {
        1 => Ok(("VIZ_OUTPUT_OVERLOAD", OUTPUT_OVERLOAD)),
        2 => Ok(("VIZ_OUTPUT_TRANSPORT", OUTPUT_TRANSPORT)),
        _ => Err("Invalid Viz fault reason".into()),
    }
}
struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if n > self.bytes.len() - self.offset {
            return Err("Truncated Viz packet".into());
        }
        let start = self.offset;
        self.offset += n;
        Ok(&self.bytes[start..self.offset])
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn f64(&mut self) -> Result<f64> {
        let n = f64::from_be_bytes(self.take(8)?.try_into().unwrap());
        if !n.is_finite() || n.abs() >= 1e7 {
            return Err("Invalid Viz number".into());
        }
        Ok(n)
    }
    fn string(&mut self, limit: usize) -> Result<String> {
        Ok(self.text(limit)?.to_owned())
    }
    fn text(&mut self,limit:usize)->Result<&'a str>{
        let len = self.u32()? as usize;
        if len > limit {
            return Err("Viz string limit".into());
        }
        std::str::from_utf8(self.take(len)?).map_err(|_| "Invalid Viz UTF8".into())
    }
    fn numbers(&mut self, n: usize) -> Result<Value> {
        Ok(json!(
            (0..n).map(|_| self.f64()).collect::<Result<Vec<_>>>()?
        ))
    }
}
pub fn decode(bytes: &[u8]) -> Result<Value> {
    if bytes.starts_with(b"{") {
        let scene: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid legacy Viz JSON")?;
        if scene["type"] != "VizScene" || scene["captureId"].as_str().is_none() {
            return Err("Invalid legacy Viz scene".into());
        }
        return Ok(scene);
    }
    let mut r = Reader { bytes, offset: 0 };
    if r.take(6)? != b"RVB2\x01\x01" {
        return Err("Invalid Viz header".into());
    }
    let id = r.string(128)?;
    let ns = [r.u32()?, r.u32()?];
    let pass_count = r.u32()?;
    if pass_count > 64 {
        return Err("Viz pass limit".into());
    }
    let mut passes = vec![];
    let mut count = 0;
    for _ in 0..pass_count {
        let pass_id = r.string(64)?;
        let output = r.numbers(4)?;
        let quads_count = r.u32()?;
        count += quads_count;
        if count > 2048 {
            return Err("Viz quad limit".into());
        }
        let mut quads = vec![];
        for _ in 0..quads_count {
            let kind = match r.u8()? {
                1 => "solid",
                2 => "pass",
                3 => "picture",
                _ => return Err("Unknown Viz kind".into()),
            };
            let local = r.u32()? as i32;
            let namespace = [r.u32()?, r.u32()?];
            let matrix = r.numbers(9)?;
            let visible = r.numbers(4)?;
            let rect = r.numbers(4)?;
            let content_origin = r.numbers(2)?;
            let opacity = r.f64()?;
            let clip = if r.u8()? != 0 {
                r.numbers(4)?
            } else {
                Value::Null
            };
            let rounded = if r.u8()? != 0 {
                r.numbers(12)?
            } else {
                Value::Null
            };
            let resource = r.u32()?;
            let mut q = json!({"kind":kind,"localId":local,"namespace":namespace,"matrix":matrix,"visible":visible,"rect":rect,"contentOrigin":content_origin,"opacity":opacity,"clip":clip,"vizResource":resource});
            if !rounded.is_null() {
                q["roundedClip"] = rounded;
            }
            match kind {
                "solid" => q["color"] = r.numbers(4)?,
                "pass" => q["passId"] = json!(r.string(64)?),
                _ => {}
            }
            quads.push(q);
        }
        passes.push(json!({"id":pass_id,"output":output,"quads":quads}));
    }
    let error = if r.u8()? != 0 {
        Some(r.string(4096)?)
    } else {
        None
    };
    if r.offset != bytes.len() {
        return Err("Trailing Viz bytes".into());
    }
    let mut scene = json!({"type":"VizScene","captureId":id,"namespace":ns,"passes":passes});
    if let Some(error) = error {
        scene["error"] = json!(error);
    }
    Ok(scene)
}

pub struct NativeResources {
    pub metadata: Value,
    pub blocks: HashMap<String,crate::budget::Payload>,
    pub admission:Vec<crate::budget::Lease>,
}
pub fn decode_resources(bytes: &[u8],input:&crate::input::InputPool,budget:&crate::budget::Budget) -> Result<NativeResources> {
    let mut r = Reader { bytes, offset: 0 };
    if r.take(6)? != b"RPA2\x01\x01" {
        return Err("Invalid resource header".into());
    }
    let id = r.string(128)?;
    let parsed=input.json(r.text(4*1024*1024)?.as_bytes())?;
    let metadata=parsed.value;
    if metadata["captureId"] != id || (!metadata["resources"].is_array() &&
        !(metadata["subscription"].is_object()&&metadata["error"].is_string())) {
        return Err("Unpaired resource metadata".into());
    }
    let count = r.u32()?;
    if count > 256 || (metadata["error"].is_string()&&count!=0) {
        return Err("Resource count limit".into());
    }
    let index=input.0.reserve(count as usize*512)?;
    let mut blocks = HashMap::with_capacity(count as usize);
    let mut total = 0;
    for _ in 0..count {
        let hash = r.string(64)?;
        if blocks.contains_key(&hash){return Err("Duplicate native resource block".into());}
        let length = r.u32()? as usize;
        total += length;
        if length < 28 || length > 16 * 1024 * 1024 || total > 64 * 1024 * 1024 {
            return Err("Resource byte limit".into());
        }
        let payload = r.take(length)?;
        use sha2::{Digest, Sha256};
        if hash != format!("{:x}", Sha256::digest(payload)) {
            return Err("Native resource checksum mismatch".into());
        }
        let mut owned=budget.buffer(length)?;owned.extend(payload);blocks.insert(hash,owned.payload());
    }
    if r.offset != bytes.len() {
        return Err("Trailing resource bytes".into());
    }
    Ok(NativeResources { metadata, blocks,admission:vec![parsed.lease,index] })
}

fn packet_id(bytes:&[u8])->Option<String>{
    if bytes.starts_with(b"RPA2\x01\x01")||bytes.starts_with(b"RVB2\x01\x01"){
        return Reader{bytes,offset:6}.string(128).ok();
    }
    // Legacy JSON is bounded separately; a complete small receipt can also
    // identify itself. Never guess an ID from truncated or malformed text.
    serde_json::from_slice::<Value>(bytes).ok()?.get("captureId")?.as_str().filter(|id|id.len()<=128).map(str::to_owned)
}

#[cfg(test)]
mod delivery_tests {
    use super::*;
    fn empty() -> Viz {
        let input=crate::input::InputPool::new(crate::input::DEFAULT_BYTES);
        let native=Arc::new(crate::subscriptions::Subscriptions::new(input.clone(),Arc::new(crate::subscriptions::Wake::default())));
        Viz {
            native,admission:Mutex::new(()),streams:Mutex::new(std::array::from_fn(|_|None)),mapping:Mutex::new(None),
            expected: Mutex::new(HashSet::new()),
            scenes: Mutex::new(HashMap::new()),
            resources_expected: Mutex::new(HashSet::new()),
            resources: Mutex::new(HashMap::new()),
            failures:Mutex::new(HashMap::new()),input,budget:crate::budget::Budget::new(crate::budget::DEFAULT_BYTES),
            resource_ready: Condvar::new(),
            running: AtomicBool::new(true),
        }
    }
    #[test]fn a_taken_legacy_scene_keeps_its_mixed_mode_slot_until_final_mapping_owner(){
        use crate::subscriptions::{self,Kind};
        let config=|n:u8,base:u64|subscriptions::Config::read(&json!({
            "id":(n as char).to_string().repeat(32),"generation":1,"ordinalBase":base,"ordinalLimit":base+7,
            "pageEpoch":1,"viewportVersion":1,"inputSeq":0,"cssWidth":100,"cssHeight":100,"host":2,"minimumSourceFrame":0})).unwrap();
        let viz=Arc::new(empty());viz.expect("legacy",false).unwrap();assert!(viz.accept_scene("legacy",json!({"captureId":"legacy"})));
        let owner=viz.begin_mapping("legacy").unwrap();assert_eq!(viz.input.0.used(),0);assert!(std::mem::size_of::<MappingOwner>()<=144);
        drop(viz.take("legacy").unwrap());assert!(viz.legacy_ids().contains("legacy"));
        for(n,base)in [('a',0),('b',8),('c',16)]{
            let c=config(n as u8,base);viz.register_native(c).unwrap();
            assert!(viz.native.reserve(&format!("{}:{}",c.key.text(),base+1),Kind::Scene,None,viz.native_capacity()).unwrap().is_ok());
        }
        let fourth=config(b'd',24);viz.register_native(fourth).unwrap();let id=format!("{}:25",fourth.key.text());
        assert!(!viz.native_capacity());assert!(viz.native.reserve(&id,Kind::Scene,None,viz.native_capacity()).unwrap().is_err());
        drop(owner);assert!(!viz.legacy_ids().contains("legacy"));assert_eq!(viz.input.0.used(),32*1024);
        assert!(viz.native.reserve(&id,Kind::Scene,None,viz.native_capacity()).unwrap().is_ok());viz.native.stop();assert_eq!(viz.input.0.used(),0);
    }
    fn packet(id:&str,bytes:&[u8])->Vec<u8>{
        use sha2::{Digest,Sha256};
        let hash=format!("{:x}",Sha256::digest(bytes));let metadata=json!({"captureId":id,"resources":[]}).to_string();let mut packet=b"RPA2\x01\x01".to_vec();
        for text in [id,metadata.as_str()]{packet.extend((text.len() as u32).to_be_bytes());packet.extend(text.as_bytes());}
        packet.extend(1u32.to_be_bytes());packet.extend(64u32.to_be_bytes());packet.extend(hash.as_bytes());packet.extend((bytes.len() as u32).to_be_bytes());packet.extend(bytes);packet
    }
    #[test]fn raw_payload_is_admitted_before_copy_and_its_final_alias_owns_the_resource_credit(){
        let input=crate::input::InputPool::new(1024*1024);let budget=crate::budget::Budget::new(128*1024);let bytes=packet("raw",&vec![31;64*1024]);
        let resources=decode_resources(&bytes,&input,&budget).unwrap();assert!(input.0.used()>0);assert_eq!(budget.used(),64*1024+128);
        let alias=resources.blocks.values().next().unwrap().bytes.slice(0..1);drop(resources);assert_eq!(input.0.used(),0);assert_eq!(budget.used(),64*1024+128);drop(alias);assert_eq!(budget.used(),0);
        let tiny=crate::budget::Budget::new(32*1024);assert_eq!(decode_resources(&bytes,&input,&tiny).err().unwrap(),crate::budget::PRESSURE);assert_eq!(tiny.used(),0);assert_eq!(input.0.used(),0);
        let mut malformed=bytes.clone();malformed.push(0);assert!(decode_resources(&malformed,&input,&budget).is_err());assert_eq!(budget.used(),0);assert_eq!(input.0.used(),0);
    }
    #[test]fn input_denial_targets_only_an_unfinished_pair_and_preserves_a_completed_capture(){
        let viz=empty();viz.expect("ready",true).unwrap();assert!(viz.accept_resources("ready".into(),NativeResources{metadata:json!({}),blocks:HashMap::new(),admission:vec![]}));assert!(viz.accept_scene("ready",json!({"captureId":"ready"})));
        viz.expect("bad",true).unwrap();viz.reject_packet(Some("bad"),crate::input::PRESSURE);assert_eq!(viz.take("bad").err().unwrap(),crate::input::PRESSURE);
        viz.reject_packet(Some("ready"),crate::input::PRESSURE);assert!(viz.take("ready").is_ok());assert!(viz.take_resources("ready").is_ok());assert!(viz.failures.lock().unwrap().is_empty());
    }
    #[test]fn a_resource_failure_after_scene_delivery_wakes_the_waiting_map_with_its_typed_reason(){
        let viz=Arc::new(empty());viz.expect("late",true).unwrap();viz.accept_scene("late",json!({"captureId":"late"}));viz.take("late").unwrap();
        let owner=viz.clone();let began=std::time::Instant::now();let job=thread::spawn(move||owner.take_resources("late").err().unwrap());
        viz.reject_packet(Some("late"),crate::budget::PRESSURE);assert_eq!(job.join().unwrap(),crate::budget::PRESSURE);assert!(began.elapsed()<Duration::from_secs(2));assert!(viz.failures.lock().unwrap().is_empty());
    }
    #[test]fn capture_ids_can_be_read_from_bounded_prefixes_without_allocating_the_packet(){
        let packet=packet("partial-id",&vec![0;1024]);assert_eq!(packet_id(&packet[..256]),Some("partial-id".into()));assert_eq!(packet_id(b"RPA2\x01\x01\xff\xff\xff\xff"),None);
    }
    #[test]
    fn fault_receipts_have_fixed_validated_reason_codes() {
        assert_eq!(scene_error_code("Captured compositor frame superseded before aggregation"), Some("VIZ_CAPTURE_SUPERSEDED"));
        assert_eq!(scene_error_code("Unsupported Viz material"), None);
        assert_eq!(decode_fault(b"RVE2\x01\x01\x01").unwrap().0, "VIZ_OUTPUT_OVERLOAD");
        assert_eq!(decode_fault(b"RVE2\x01\x01\x02").unwrap().0, "VIZ_OUTPUT_TRANSPORT");
        assert_eq!(crate::error_code(OUTPUT_OVERLOAD),Some("VIZ_OUTPUT_OVERLOAD"));
        assert_eq!(crate::error_code(OUTPUT_TRANSPORT),Some("VIZ_OUTPUT_TRANSPORT"));
        for bytes in [b"RVE2".as_slice(), b"RVE2\x02\x01\x01", b"RVE2\x01\x01\x00", b"RVE2\x01\x01\x01x"] {
            assert!(decode_fault(bytes).is_err());
        }
    }
    #[test]
    fn a_writer_fault_retires_only_unfinished_scene_and_resource_owners() {
        let viz = empty();
        viz.expect("a", true).unwrap();
        assert!(viz.accept_resources("a".into(),NativeResources{metadata:json!({}),blocks:HashMap::new(),admission:vec![]}));
        viz.expect("b", true).unwrap();
        viz.expect("c",true).unwrap();
        assert!(viz.accept_scene("c",json!({"captureId":"c"})));
        viz.expect("completed", true).unwrap();
        assert!(viz.accept_resources("completed".into(),NativeResources{metadata:json!({}),blocks:HashMap::new(),admission:vec![]}));
        assert!(viz.accept_scene("completed",json!({"captureId":"completed"})));
        assert_eq!(viz.reject_expected(OUTPUT_OVERLOAD), vec!["a", "b", "c"]);
        assert!(viz.expected.lock().unwrap().is_empty());
        assert!(!viz.resources_expected.lock().unwrap().contains("a"));
        assert!(!viz.resources_expected.lock().unwrap().contains("b"));
        assert!(!viz.resources_expected.lock().unwrap().contains("c"));
        assert!(!viz.scenes.lock().unwrap().contains_key("c"));
        assert!(viz.scenes.lock().unwrap().contains_key("completed"));
        assert!(viz.resources.lock().unwrap().contains_key("completed"));
        assert_eq!(viz.resources.lock().unwrap().len(), 1);
        assert!(viz.reject_expected(OUTPUT_TRANSPORT).is_empty());
        for id in ["a","b"]{assert_eq!(viz.take(id).err().unwrap(),"Native Viz pairing unavailable");}
        assert_eq!(viz.take("c").err().unwrap(),OUTPUT_OVERLOAD);
        viz.expect("retry", true).unwrap();
    }
    #[test]fn writer_fault_wakes_a_scene_already_taken_by_a_resource_waiter(){
        for error in [OUTPUT_OVERLOAD,OUTPUT_TRANSPORT]{
            let viz=Arc::new(empty());viz.expect("late",true).unwrap();assert!(viz.accept_scene("late",json!({"captureId":"late"})));viz.take("late").unwrap();
            let owner=viz.clone();let began=std::time::Instant::now();let job=thread::spawn(move||owner.take_resources("late").err().unwrap());
            assert_eq!(viz.reject_expected(error),vec!["late"]);assert_eq!(job.join().unwrap(),error);assert!(began.elapsed()<Duration::from_secs(2));assert!(viz.failures.lock().unwrap().is_empty());
        }
    }
    #[test]fn malformed_fault_does_not_retire_pairs_and_failure_receipts_cannot_grow_unbounded(){
        let viz=empty();for index in 0..4{let id=format!("raw-{index}");viz.expect(&id,true).unwrap();assert!(viz.accept_scene(&id,json!({"captureId":id})));viz.take(&id).unwrap();}
        for index in 0..4{viz.expect(&format!("scene-{index}"),false).unwrap();}
        viz.handle_fault(b"BAD2\x01\x01\x01");assert_eq!(viz.expected.lock().unwrap().len(),4);assert_eq!(viz.resources_expected.lock().unwrap().len(),4);assert!(viz.failures.lock().unwrap().is_empty());
        assert_eq!(viz.reject_expected(OUTPUT_OVERLOAD).len(),8);assert_eq!(viz.failures.lock().unwrap().len(),4);assert!(viz.reject_expected(OUTPUT_TRANSPORT).is_empty());assert_eq!(viz.failures.lock().unwrap().len(),4);assert!(viz.expect("blocked",false).is_err());
        for index in 0..4{assert_eq!(viz.take(&format!("raw-{index}")).err().unwrap(),OUTPUT_OVERLOAD);assert_eq!(viz.take(&format!("scene-{index}")).err().unwrap(),"Native Viz pairing unavailable");}
        assert!(viz.failures.lock().unwrap().is_empty());assert!(viz.expect("fresh",true).is_ok());
    }
    #[test]fn fault_retirement_cannot_miss_a_resource_publication_already_holding_membership(){
        let viz=Arc::new(empty());viz.expect("race",true).unwrap();let held=viz.resources.lock().unwrap();let owner=viz.clone();
        let writer=thread::spawn(move||owner.accept_resources("race".into(),NativeResources{metadata:json!({}),blocks:HashMap::new(),admission:vec![]}));
        let deadline=std::time::Instant::now()+Duration::from_secs(2);while viz.resources_expected.try_lock().is_ok(){assert!(std::time::Instant::now()<deadline);thread::yield_now();}
        let owner=viz.clone();let fault=thread::spawn(move||owner.reject_expected(OUTPUT_OVERLOAD));drop(held);
        assert!(writer.join().unwrap());assert_eq!(fault.join().unwrap(),vec!["race"]);assert!(viz.resources.lock().unwrap().is_empty());assert!(viz.resources_expected.lock().unwrap().is_empty());assert!(viz.expected.lock().unwrap().is_empty());
        assert!(!viz.accept_resources("race".into(),NativeResources{metadata:json!({}),blocks:HashMap::new(),admission:vec![]}));assert!(!viz.accept_scene("race",json!({"captureId":"race"})));assert!(viz.failures.lock().unwrap().is_empty());
    }
    #[test]fn scene_error_callbacks_do_not_pin_registration_slots_without_a_resource_waiter(){
        let viz=empty();viz.expect("completed",false).unwrap();assert!(viz.accept_scene("completed",json!({"captureId":"completed"})));
        for round in 0..100{
            for id in ["a","b"]{viz.expect(id,round%2==0).unwrap();}
            assert_eq!(viz.reject_expected(OUTPUT_OVERLOAD),vec!["a","b"]);assert!(viz.failures.lock().unwrap().is_empty());assert!(viz.resources_expected.lock().unwrap().is_empty());
            viz.expect("retry",false).unwrap();assert!(viz.accept_scene("retry",json!({"captureId":"retry"})));assert!(viz.scenes.lock().unwrap().contains_key("completed"));assert_eq!(viz.scenes.lock().unwrap().len(),2);
        }
    }
    #[test]
    fn cancellation_cannot_leave_resources_published_after_cleanup() {
        let viz = Arc::new(empty());
        viz.expect("race", true).unwrap();
        let held = viz.resources.lock().unwrap();
        let owner = viz.clone();
        let writer = thread::spawn(move || owner.accept_resources("race".into(), NativeResources {metadata:json!({}), blocks:HashMap::new(),admission:vec![]}));
        // Publication is now blocked on resources. Its expectation lock must
        // stay held until the insert, so a concurrent cancel cannot pass it.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if viz.resources_expected.try_lock().is_err() { break; }
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
        let owner = viz.clone();
        let canceled = thread::spawn(move || owner.cancel("race"));
        drop(held);
        assert!(writer.join().unwrap());
        canceled.join().unwrap();
        assert!(viz.resources.lock().unwrap().is_empty());
        assert!(viz.expected.lock().unwrap().is_empty());
        assert!(viz.resources_expected.lock().unwrap().is_empty());
        assert!(!viz.accept_resources("race".into(), NativeResources {metadata:json!({}), blocks:HashMap::new(),admission:vec![]}));
        assert!(!viz.accept_scene("race", json!({"captureId":"race"})));
    }
}
