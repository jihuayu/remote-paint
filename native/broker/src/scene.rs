use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

pub type Result<T> = std::result::Result<T, String>;
pub const CACHE_BYTES: usize = 128 * 1024 * 1024;
pub const SCENE_BYTES: usize = 256 * 1024;
#[derive(Clone)]
pub struct Resource {
    pub payload: Bytes,
    pub wire: Bytes,
}
#[derive(Clone)]
pub struct Snapshot {
    pub serial: u64,
    pub scene: Value,
    pub resources: HashMap<String, Resource>,
    pub metadata: Value,
    pub full_json: String,
}
pub struct Mapper {
    entries: HashMap<String, (String, u64)>,
    resources: HashMap<String, Resource>,
    revision: u64,
    serial: u64,
    epoch: u64,
}
impl Mapper {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            resources: HashMap::new(),
            revision: 0,
            serial: 0,
            epoch: 0,
        }
    }
    pub fn reset(&mut self) {
        self.entries.clear();
        self.resources.clear();
        self.revision = 0;
        self.epoch = 0;
    }
    pub fn map(
        &mut self,
        capture: &Value,
        epoch: u64,
        viewport: &Value,
        viewport_version: u64,
        input_seq: u64,
    ) -> Result<Arc<Snapshot>> {
        let viz = &capture["viz"];
        if epoch == 0
            || capture["captureId"].as_str().is_none()
            || viz["captureId"] != capture["captureId"]
            || capture["producer"].as_str().is_none()
        {
            return Err("Unpaired compositor/Viz capture".into());
        }
        let ns = array(&viz["namespace"], 2)?;
        if ns
            .iter()
            .any(|n| n.as_u64().is_none_or(|n| n > u32::MAX as u64))
        {
            return Err("Invalid namespace".into());
        }
        if self.epoch != epoch {
            self.reset();
            self.epoch = epoch;
        }
        let records = capture["resources"]
            .as_array()
            .ok_or("Missing native resources")?;
        let passes = viz["passes"].as_array().ok_or("Missing native passes")?;
        if records.len() > 256 || passes.is_empty() || passes.len() > 64 {
            return Err("Native scene budget exceeded".into());
        }
        let mut by_id = HashMap::new();
        for record in records {
            let id = record["localId"].as_i64().ok_or("Invalid content ID")?;
            if by_id.insert(id, record).is_some() {
                return Err("Duplicate content ID".into());
            }
        }
        let mut entries = HashMap::new();
        let mut resources = HashMap::new();
        let mut mapped = vec![];
        let mut ids = HashSet::new();
        let mut quad_count = 0;
        let mut pixels = 0f64;
        for pass in passes {
            let id = pass["id"]
                .as_str()
                .filter(|id| id.len() <= 64)
                .ok_or("Invalid pass ID")?;
            if ids.contains(id) {
                return Err("Duplicate pass ID".into());
            }
            let output = numbers(&pass["output"], 4)?;
            let width = output[2] - output[0];
            let height = output[3] - output[1];
            pixels += width * height;
            if width <= 0.
                || height <= 0.
                || width > 8192.
                || height > 8192.
                || pixels > 32. * 1024. * 1024.
                || output.iter().any(|v| v.fract() != 0.)
            {
                return Err("Render-pass budget exceeded".into());
            }
            let mut quads = vec![];
            for q in pass["quads"].as_array().ok_or("Invalid pass quads")? {
                quad_count += 1;
                if quad_count > 2048 {
                    return Err("Quad budget exceeded".into());
                }
                numbers(&q["matrix"], 9)?;
                numbers(&q["visible"], 4)?;
                numbers(&q["rect"], 4)?;
                if !q["clip"].is_null() {
                    numbers(&q["clip"], 4)?;
                }
                let opacity = q["opacity"]
                    .as_f64()
                    .filter(|n| (0.0..=1.0).contains(n))
                    .ok_or("Invalid opacity")?;
                let mut out = json!({"kind":q["kind"],"matrix":q["matrix"],"visible":q["visible"],"rect":q["rect"],"clip":q["clip"],"opacity":opacity});
                if !q["roundedClip"].is_null() {
                    let r = numbers(&q["roundedClip"], 12)?;
                    if r[2] <= r[0] || r[3] <= r[1] || r[4..].iter().any(|n| *n < 0. || *n > 8192.)
                    {
                        return Err("Invalid rounded clip".into());
                    }
                    out["roundedClip"] = q["roundedClip"].clone();
                }
                match q["kind"].as_str() {
                    Some("solid") => {
                        if numbers(&q["color"], 4)?
                            .iter()
                            .any(|n| !(0.0..=1.0).contains(n))
                        {
                            return Err("Invalid color".into());
                        }
                        out["color"] = q["color"].clone();
                    }
                    Some("pass") => {
                        let child = q["passId"].as_str().ok_or("Missing child pass")?;
                        if !ids.contains(child) {
                            return Err("Cyclic or missing pass".into());
                        }
                        out["passId"] = q["passId"].clone();
                    }
                    Some("picture") => {
                        if q["namespace"] != viz["namespace"] {
                            return Err("Child Surface painting is not implemented".into());
                        }
                        numbers(&q["contentOrigin"], 2)?;
                        let local = q["localId"].as_i64().ok_or("Invalid layer ID")?;
                        let r = by_id.get(&local).ok_or("Missing native layer")?;
                        let scale = r["quadScale"]
                            .as_f64()
                            .filter(|n| *n > 0. && *n <= 128.)
                            .ok_or("Invalid scale")?;
                        for field in ["width", "height"] {
                            if r[field].as_u64().is_none_or(|n| n == 0 || n > 8192) {
                                return Err("Invalid layer dimensions".into());
                            }
                        }
                        let logical = format!(
                            "{}/{}/{}:{}/{}",
                            epoch,
                            capture["producer"].as_str().unwrap(),
                            ns[0],
                            ns[1],
                            local
                        );
                        if !entries.contains_key(&logical) {
                            let hash;
                            if let Some(encoded) = r["skp"].as_str() {
                                if encoded.len() > 24 * 1024 * 1024 {
                                    return Err("Resource byte budget exceeded".into());
                                }
                                let payload = STANDARD
                                    .decode(encoded)
                                    .map_err(|_| "Invalid native SKP base64")?;
                                if payload.len() < 28
                                    || payload.len() > 16 * 1024 * 1024
                                    || !payload.starts_with(b"skiapict")
                                {
                                    return Err("Invalid native SKP".into());
                                }
                                hash = format!("{:x}", Sha256::digest(&payload));
                                if r["resourceId"].as_str().is_some_and(|id| id != hash) {
                                    return Err("Native resource checksum mismatch".into());
                                }
                                if !self.resources.contains_key(&hash) {
                                    let mut wire = b"RPNT\x01\x01\0\0".to_vec();
                                    wire.extend((payload.len() as u32).to_be_bytes());
                                    wire.extend(Sha256::digest(&payload));
                                    wire.extend(&payload);
                                    self.resources.insert(
                                        hash.clone(),
                                        Resource {
                                            payload: Bytes::from(payload),
                                            wire: Bytes::from(wire),
                                        },
                                    );
                                }
                            } else {
                                hash = r["resourceId"]
                                    .as_str()
                                    .ok_or("Missing native resource checksum")?
                                    .to_owned();
                            }
                            let resource = self
                                .resources
                                .get(&hash)
                                .ok_or("Incremental native resource cache miss")?;
                            let revision = match self.entries.get(&logical) {
                                Some((old, rev)) if old == &hash => *rev,
                                _ => {
                                    self.revision += 1;
                                    self.revision
                                }
                            };
                            entries.insert(logical.clone(), (hash.clone(), revision));
                            resources.insert(hash, resource.clone());
                        }
                        let (hash, revision) = &entries[&logical];
                        for (key, value) in [
                            ("logical", json!(logical)),
                            ("resourceId", json!(hash)),
                            ("revision", json!(revision)),
                            ("quadScale", json!(scale)),
                            ("width", r["width"].clone()),
                            ("height", r["height"].clone()),
                            ("contentOrigin", q["contentOrigin"].clone()),
                            ("requiresIsolation", json!(r["requiresIsolation"] != false)),
                            (
                                "source",
                                json!({"namespace":q["namespace"],"stableLayerId":local,"vizResource":q["vizResource"]}),
                            ),
                        ] {
                            out[key] = value;
                        }
                    }
                    _ => return Err("Unknown quad kind".into()),
                }
                quads.push(out);
            }
            ids.insert(id.to_string());
            mapped.push(json!({"id":id,"output":pass["output"],"quads":quads}));
        }
        let width = viewport["cssWidth"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 4096)
            .ok_or("Invalid viewport")?;
        let height = viewport["cssHeight"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 4096)
            .ok_or("Invalid viewport")?;
        if viewport["deviceScaleFactor"] != 1
            || numbers(&mapped.last().unwrap()["output"],4)? != vec![0.,0.,width as f64,height as f64]
        {
            return Err("Root viewport mismatch".into());
        }
        if resources.values().map(|r| r.payload.len()).sum::<usize>() > 64 * 1024 * 1024 {
            return Err("Scene resource budget exceeded".into());
        }
        let released: Vec<_> = self
            .entries
            .keys()
            .filter(|k| !entries.contains_key(*k))
            .cloned()
            .collect();
        self.entries = entries;
        let scene = json!({"rootPass":mapped.last().unwrap()["id"],"passes":mapped});
        let full_json = serde_json::to_string(&scene).map_err(|e| e.to_string())?;
        if full_json.len() > SCENE_BYTES {
            return Err("Scene metadata budget exceeded".into());
        }
        // Retain the current working set plus a bounded history for native hash
        // references. Arc-backed payloads held by in-flight frames remain valid.
        if self
            .resources
            .values()
            .map(|r| r.payload.len() + r.wire.len())
            .sum::<usize>()
            > CACHE_BYTES
        {
            self.resources.retain(|id, _| resources.contains_key(id));
        }
        self.serial += 1;
        let mut required: Vec<_> = resources.keys().cloned().collect();
        required.sort();
        let mappings: Vec<_> = self
            .entries
            .iter()
            .map(|(logical, (id, rev))| json!({"logical":logical,"resourceId":id,"revision":rev}))
            .collect();
        let metadata = json!({"pageEpoch":epoch,"viewportVersion":viewport_version,"viewport":viewport,"lastProcessedInputSeq":input_seq,"requiredResources":required,"released":released,"mappings":mappings,"native":{"captureId":capture["captureId"],"producer":capture["producer"],"namespace":viz["namespace"],"frameToken":capture["frameToken"],"sourceFrame":capture["sourceFrame"],"bitmapGlyphs":records.iter().map(|r|r["bitmapGlyphs"].as_u64().unwrap_or(0)).sum::<u64>(),"timing":capture["timing"]}});
        Ok(Arc::new(Snapshot {
            serial: self.serial,
            scene,
            resources,
            metadata,
            full_json,
        }))
    }
}
fn array(value: &Value, count: usize) -> Result<&Vec<Value>> {
    value
        .as_array()
        .filter(|v| v.len() == count)
        .ok_or("Invalid native number array".into())
}
fn numbers(value: &Value, count: usize) -> Result<Vec<f64>> {
    array(value, count)?
        .iter()
        .map(|n| {
            n.as_f64()
                .filter(|n| n.is_finite() && n.abs() < 1e7)
                .ok_or("Invalid native number".into())
        })
        .collect()
}
