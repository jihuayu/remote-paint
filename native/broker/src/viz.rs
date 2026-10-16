use crate::{emit, scene::Result};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    os::unix::{fs::PermissionsExt, net::UnixListener},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};
pub struct Viz {
    expected: Mutex<HashSet<String>>,
    scenes: Mutex<HashMap<String, Value>>,
    resources_expected: Mutex<HashSet<String>>,
    resources: Mutex<HashMap<String, NativeResources>>,
    resource_ready: Condvar,
    running: AtomicBool,
}
impl Viz {
    pub fn start(path: &str) -> Result<Arc<Self>> {
        let listener = UnixListener::bind(path).map_err(|e| e.to_string())?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let viz = Arc::new(Self {
            expected: Mutex::new(HashSet::new()),
            scenes: Mutex::new(HashMap::new()),
            resources_expected: Mutex::new(HashSet::new()),
            resources: Mutex::new(HashMap::new()),
            resource_ready: Condvar::new(),
            running: AtomicBool::new(true),
        });
        let owner = viz.clone();
        let connections = Arc::new(AtomicUsize::new(0));
        thread::spawn(move || {
            while owner.running.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        if connections.fetch_add(1, Ordering::Relaxed) >= 4 {
                            connections.fetch_sub(1, Ordering::Relaxed);
                            continue;
                        }
                        let server = owner.clone();
                        let connections = connections.clone();
                        thread::spawn(move || {
                            let _ = stream.set_nonblocking(false);
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
                            loop {
                                let mut header = [0; 4];
                                if stream.read_exact(&mut header).is_err() {
                                    break;
                                }
                                let length = u32::from_be_bytes(header) as usize;
                                if length == 0 || length > 72 * 1024 * 1024 {
                                    emit(json!({"event":"VizRejected"}));
                                    break;
                                }
                                let mut bytes = vec![0; length];
                                if stream.read_exact(&mut bytes).is_err() {
                                    break;
                                }
                                if bytes.starts_with(b"RPA2") {
                                    match decode_resources(&bytes) {
                                        Ok(resources) => {
                                            let id = resources.metadata["captureId"]
                                                .as_str()
                                                .unwrap()
                                                .to_owned();
                                            if server.resources_expected.lock().unwrap().remove(&id)
                                            {
                                                server
                                                    .resources
                                                    .lock()
                                                    .unwrap()
                                                    .insert(id, resources);
                                                server.resource_ready.notify_all();
                                            } else {
                                                emit(json!({"event":"VizRejected"}));
                                            }
                                        }
                                        Err(_) => emit(json!({"event":"VizRejected"})),
                                    }
                                    continue;
                                }
                                if bytes.len() > 256 * 1024 {
                                    emit(json!({"event":"VizRejected"}));
                                    break;
                                }
                                match decode(&bytes) {
                                    Ok(scene) => {
                                        let id = scene["captureId"].as_str().unwrap().to_owned();
                                        if !server.expected.lock().unwrap().remove(&id) {
                                            emit(json!({"event":"VizRejected"}));
                                            continue;
                                        }
                                        if let Some(error) = scene["error"].as_str() {
                                            emit(
                                                json!({"event":"VizReady","captureId":id,"error":error}),
                                            );
                                        } else {
                                            server.scenes.lock().unwrap().insert(id.clone(), scene);
                                            emit(json!({"event":"VizReady","captureId":id}));
                                        }
                                    }
                                    Err(_) => emit(json!({"event":"VizRejected"})),
                                }
                            }
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
    pub fn expect(&self, id: &str, resources: bool) -> Result<Value> {
        let mut expected = self.expected.lock().unwrap();
        if expected.len() >= 4 || expected.contains(id) || id.len() > 128 {
            return Err("Viz request unavailable".into());
        }
        expected.insert(id.into());
        if resources {
            let mut pending = self.resources_expected.lock().unwrap();
            if pending.len() >= 4 {
                expected.remove(id);
                return Err("Native resource request limit".into());
            }
            pending.insert(id.into());
        }
        Ok(json!(true))
    }
    pub fn cancel(&self, id: &str) {
        self.expected.lock().unwrap().remove(id);
        self.scenes.lock().unwrap().remove(id);
        self.resources_expected.lock().unwrap().remove(id);
        self.resources.lock().unwrap().remove(id);
    }
    pub fn take(&self, id: &str) -> Result<Value> {
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
            .wait_timeout_while(resources, Duration::from_secs(3), |r| !r.contains_key(id))
            .unwrap();
        resources
            .remove(id)
            .ok_or("Native resource pairing unavailable".into())
    }
    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
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
        let len = self.u32()? as usize;
        if len > limit {
            return Err("Viz string limit".into());
        }
        String::from_utf8(self.take(len)?.to_vec()).map_err(|_| "Invalid Viz UTF8".into())
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
    pub blocks: HashMap<String, Vec<u8>>,
}
pub fn decode_resources(bytes: &[u8]) -> Result<NativeResources> {
    let mut r = Reader { bytes, offset: 0 };
    if r.take(6)? != b"RPA2\x01\x01" {
        return Err("Invalid resource header".into());
    }
    let id = r.string(128)?;
    let metadata: Value = serde_json::from_str(&r.string(4 * 1024 * 1024)?)
        .map_err(|_| "Invalid resource metadata")?;
    if metadata["captureId"] != id || !metadata["resources"].is_array() {
        return Err("Unpaired resource metadata".into());
    }
    let count = r.u32()?;
    if count > 256 {
        return Err("Resource count limit".into());
    }
    let mut blocks = HashMap::new();
    let mut total = 0;
    for _ in 0..count {
        let hash = r.string(64)?;
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
        blocks.insert(hash, payload.to_vec());
    }
    if r.offset != bytes.len() {
        return Err("Trailing resource bytes".into());
    }
    Ok(NativeResources { metadata, blocks })
}
