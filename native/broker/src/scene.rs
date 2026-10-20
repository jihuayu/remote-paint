use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Weak},
};

pub type Result<T> = std::result::Result<T, String>;
pub const CACHE_BYTES: usize = 128 * 1024 * 1024;
const CACHE_ENTRIES: usize = 512;
const REFERENCE_ENTRIES: usize = 512;
pub const CHUNK_INDEX_ENTRIES: usize = 8192;
pub const SCENE_BYTES: usize = 256 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeMemory {
    pub image_bytes: u64,
    pub font_bytes: u64,
}
impl DecodeMemory {
    pub fn json(self) -> Value {
        json!({"imageBytes":self.image_bytes,"fontBytes":self.font_bytes})
    }
}
pub struct Resource {
    pub payload: Bytes,
    pub wire: Bytes,
    pub chunks: Arc<crate::assets::ChunkList>,
    pub manifest: tungstenite::Utf8Bytes,
    pub decode_memory: Option<DecodeMemory>,
    pub payload_capacity: usize,
    pub wire_capacity: usize,
    pub manifest_capacity: usize,
    pub _metadata: crate::budget::Lease,
}
impl Resource {
    // Conservative strong-cache owner charge. Shared/repeated chunks may be
    // overcharged here; the allocation pool is a separate ownership domain.
    pub fn cache_charge(&self) -> usize {
        self.payload_capacity.saturating_add(self.wire_capacity)
            .saturating_add(self.manifest_capacity)
            .saturating_add(self.chunks.metadata_bytes())
            .saturating_add(std::mem::size_of::<Self>()+1024)
            .saturating_add(self.chunks.iter().map(|chunk|chunk.charge).sum::<usize>())
    }
}
pub struct Snapshot {
    pub serial: u64,
    pub scene: Value,
    pub resources: HashMap<String, Arc<Resource>>,
    pub metadata: Value,
    pub full_json: String,
    // Field order keeps every owned graph/string/map ahead of its credit.
    pub _graph: crate::budget::Lease,
}
pub struct Mapper {
    entries: HashMap<String, (String, u64)>,
    resources: HashMap<String, Arc<Resource>>,
    recency: HashMap<String, u64>,
    references: HashMap<String, (Weak<Resource>, u64)>,
    chunks: HashMap<String, Weak<crate::assets::Chunk>>,
    revision: u64,
    serial: u64,
    epoch: u64,
    cache_limit: usize,
    resource_limit: usize,
    reference_limit: usize,
    chunk_limit: usize,
    cache_bytes: usize,
    cache_evictions: u64,
    pub budget: crate::budget::Budget,
    pub snapshot_pool: crate::snapshot_memory::SnapshotPool,
    entry_lease: Option<crate::budget::Lease>,
    pub index_pool: crate::mapper_memory::Pool,
    // All index maps precede this final capacity/scratch credit.
    index_lease: Option<crate::budget::Lease>,
}
impl Mapper {
    pub fn new() -> Self {
        Self::with_limits(CACHE_BYTES,CACHE_ENTRIES,REFERENCE_ENTRIES,CHUNK_INDEX_ENTRIES)
    }
    pub fn with_budget(budget: crate::budget::Budget) -> Self {
        let mut mapper=Self::new();mapper.budget=budget;mapper
    }
    pub fn with_pools(budget:crate::budget::Budget,snapshot_pool:crate::snapshot_memory::SnapshotPool)->Self{
        let mut mapper=Self::with_budget(budget);mapper.snapshot_pool=snapshot_pool;mapper
    }
    fn with_limits(cache_limit: usize,resource_limit: usize,reference_limit: usize,chunk_limit: usize) -> Self {
        Self {
            entries: HashMap::new(),
            resources: HashMap::new(),
            recency: HashMap::new(),
            references: HashMap::new(),
            chunks: HashMap::new(),
            revision: 0,
            serial: 0,
            epoch: 0,
            cache_limit, resource_limit, reference_limit, chunk_limit,
            cache_bytes: 0, cache_evictions: 0,
            budget: crate::budget::Budget::new(crate::budget::DEFAULT_BYTES),
            snapshot_pool: crate::snapshot_memory::SnapshotPool::new(crate::snapshot_memory::DEFAULT_BYTES),
            entry_lease: None,
            index_pool: crate::mapper_memory::Pool::new(crate::mapper_memory::DEFAULT_BYTES),
            index_lease: None,
        }
    }
    pub fn reset(&mut self) {
        self.reset_scene();
        // Replace buckets before returning their lifetime allowance. Outside
        // Snapshot/resource aliases keep their separate payload/graph owners.
        self.resources=HashMap::new();
        self.recency=HashMap::new();self.references=HashMap::new();self.cache_bytes=0;
        self.chunks=HashMap::new();
        self.index_lease=None;
    }
    pub fn reset_scene(&mut self) {
        self.entries=HashMap::new();
        self.entry_lease=None;
        self.revision = 0;
        self.epoch = 0;
    }
    pub fn reclaim_cache(&mut self) {
        self.cache_evictions+=self.resources.len() as u64;
        self.resources.clear();self.recency.clear();self.cache_bytes=0;
        self.references.retain(|_,(entry,_)|entry.strong_count()>0);
        self.chunks.retain(|_,entry|entry.strong_count()>0);
    }
    pub fn stats(&self) -> Value {
        let mut chunks = HashSet::new();
        let chunk_bytes: usize = self.resources.values().flat_map(|resource|resource.chunks.iter())
            .filter(|chunk|chunks.insert(Arc::as_ptr(chunk)))
            .map(|chunk|chunk.wire.len()).sum();
        json!({"scope":"mapper-retained-cache","resources":self.resources.len(),"entries":self.entries.len(),
            "cacheBytes":self.cache_bytes,"cacheByteLimit":self.cache_limit,"cacheEntryLimit":self.resource_limit,"cacheEvictions":self.cache_evictions,
            "resourcePoolBytes":self.budget.used(),"resourcePoolLimit":self.budget.limit(),
            "indexAllowanceBytes":if self.index_lease.is_some(){crate::mapper_memory::ALLOWANCE_BYTES}else{0},"mapperIndices":self.index_pool.stats(),
            "strongIndexCapacity":self.resources.capacity(),"recencyIndexCapacity":self.recency.capacity(),"referenceIndexCapacity":self.references.capacity(),"chunkIndexCapacity":self.chunks.capacity(),
            "referenceIndexEntries":self.references.len(),"referenceIndexLimit":self.reference_limit,"referenceIndexEstimateBytes":self.references.len()*256,
            "chunkIndexLimit":self.chunk_limit,"chunkIndexEstimateBytes":self.chunks.len()*160,
            "chunkIndexEntries":self.chunks.len(),"liveChunkIndexEntries":self.chunks.values().filter(|entry|entry.strong_count()>0).count(),
            "payloadBytes":self.resources.values().map(|r|r.payload.len()).sum::<usize>(),
            "resourceWireBytes":self.resources.values().map(|r|r.wire.len()).sum::<usize>(),
            "manifestBytes":self.resources.values().map(|r|r.manifest.len()).sum::<usize>(),"cacheOwnedChunkBytes":chunk_bytes,
            "revision":self.revision,"serial":self.serial,"epoch":self.epoch})
    }
    #[cfg(test)]
    pub fn map(
        &mut self,
        capture: &Value,
        epoch: u64,
        viewport: &Value,
        viewport_version: u64,
        input_seq: u64,
    ) -> Result<Arc<Snapshot>> {
        self.map_native(capture, epoch, viewport, viewport_version, input_seq, HashMap::new())
    }
    #[cfg(test)]
    pub fn map_native(&mut self,capture:&Value,epoch:u64,viewport:&Value,viewport_version:u64,input_seq:u64,blocks:HashMap<String,Vec<u8>>)->Result<Arc<Snapshot>>{
        let admitted=blocks.into_iter().map(|(id,bytes)|self.budget.payload(bytes).map(|payload|(id,payload))).collect::<Result<HashMap<_,_>>>()?;
        self.map_admitted(capture,epoch,viewport,viewport_version,input_seq,admitted)
    }
    pub fn map_admitted(
        &mut self, capture: &Value, epoch: u64, viewport: &Value,
        viewport_version: u64, input_seq: u64, mut blocks: HashMap<String, crate::budget::Payload>,
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
        // Stage only this capture's changes. A failed native ingest, epoch
        // transition or late scene check must preserve the committed state.
        let mut revision = if self.epoch == epoch { self.revision } else { 0 };
        let records = capture["resources"]
            .as_array()
            .ok_or("Missing native resources")?;
        let passes = viz["passes"].as_array().ok_or("Missing native passes")?;
        if records.len() > 256 || passes.is_empty() || passes.len() > 64 {
            return Err("Native scene budget exceeded".into());
        }
        // A failed first transaction drops this temporary allowance after
        // its scratch. Successful commit transfers it to the retained maps.
        let index_admission=if self.index_lease.is_none(){Some(self.index_pool.admit()?)}else{None};
        // Declare admission before all allocated graph/map locals. Errors drop
        // their data before credit; successful Snapshot/entries take leases.
        let admission=self.snapshot_pool.admit(crate::snapshot_memory::plan(capture,viewport,self.entries.keys().map(String::as_str),self.resources.len()+self.references.len()+self.chunks.len(),blocks.values().map(|b|b.len()).sum())?)?;
        let mut staged = HashMap::<String, Arc<Resource>>::new();
        let mut staged_chunks = HashMap::new();
        let mut staged_bytes = 0usize;
        let mut by_id = HashMap::new();
        let mut hashes = HashMap::new();
        for record in records {
            let id = record["localId"].as_i64().ok_or("Invalid content ID")?;
            if by_id.insert(id, record).is_some() {
                return Err("Duplicate content ID".into());
            }
            let payload = if let Some(encoded) = record["skp"].as_str() {
                if encoded.len() > 24 * 1024 * 1024 {
                    return Err("Resource byte budget exceeded".into());
                }
                let mut decoded=self.budget.buffer(base64::decoded_len_estimate(encoded.len()))?;
                let length=STANDARD.decode_slice(encoded,decoded.initialized()).map_err(|_|"Invalid native SKP base64")?;
                decoded.truncate(length);Some(decoded.payload())
            } else {
                let hash = record["resourceId"].as_str().ok_or("Missing native resource checksum")?;
                if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
                    return Err("Invalid native resource checksum".into());
                }
                blocks.remove(hash)
            };
            let hash = if let Some(payload) = &payload {
                if payload.len() < 28 || payload.len() > 16 * 1024 * 1024 || !payload.starts_with(b"skiapict") {
                    return Err("Invalid native SKP".into());
                }
                let hash = format!("{:x}", Sha256::digest(payload.as_ref()));
                if record.get("resourceId").is_some_and(|id| id.as_str() != Some(hash.as_str())) {
                    return Err("Native resource checksum mismatch".into());
                }
                hash
            } else {
                record["resourceId"].as_str().unwrap().to_owned()
            };
            let existing=staged.get(&hash).cloned().or_else(||self.resources.get(&hash).cloned())
                .or_else(||self.references.get(&hash).and_then(|(value,_)|value.upgrade()));
            if let Some(existing) = existing {
                let observed = crate::assets::native_memory(&existing.payload, record)?;
                if existing.decode_memory.zip(observed).is_some_and(|(old, new)| old != new) {
                    return Err("Conflicting resource memory descriptor".into());
                }
                if existing.decode_memory.is_none() && observed.is_some() {
                    let upgraded=crate::assets::upgrade_memory(&existing,observed.unwrap(),&self.budget)?;
                    staged.insert(hash.clone(), Arc::new(upgraded));
                } else if !self.resources.contains_key(&hash) {
                    staged.insert(hash.clone(),existing);
                }
            } else if let Some(payload) = payload {
                staged_bytes = staged_bytes.checked_add(payload.len()).ok_or("Staged resource budget exceeded")?;
                if staged_bytes > 64 * 1024 * 1024 { return Err("Staged resource budget exceeded".into()); }
                let resource = crate::assets::staged_native_resource(payload, &hash, record, &self.chunks, &mut staged_chunks,&self.budget)?;
                staged.insert(hash.clone(), Arc::new(resource));
            }
            hashes.insert(id, hash);
        }
        if !blocks.is_empty() { return Err("Unreferenced native resource".into()); }
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
                    Some("placeholder") => {
                        if q["reason"] != "webgl" {
                            return Err("Unknown placeholder reason".into());
                        }
                        out["reason"] = json!("webgl");
                    }
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
                        if logical.len() > 512 { return Err("Invalid native logical ID".into()); }
                        if !entries.contains_key(&logical) {
                            let hash = hashes[&local].clone();
                            let resource = staged.get(&hash).or_else(|| self.resources.get(&hash))
                                .ok_or("Incremental native resource cache miss")?;
                            let previous = (self.epoch == epoch).then(|| self.entries.get(&logical)).flatten();
                            let entry_revision = match previous {
                                Some((old, rev)) if old == &hash => *rev,
                                _ => {
                                    revision = revision.checked_add(1).ok_or("Revision overflow")?;
                                    revision
                                }
                            };
                            entries.insert(logical.clone(), (hash.clone(), entry_revision));
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
                                json!({"namespace":q["namespace"],"stableLayerId":r.get("sourceLocalId").unwrap_or(&q["localId"]),"vizResource":q["vizResource"]}),
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
            || numbers(&mapped.last().unwrap()["output"], 4)?
                != vec![0., 0., width as f64, height as f64]
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
        let scene = json!({"rootPass":mapped.last().unwrap()["id"],"passes":mapped});
        let full_json = admission.scene_json(&scene)?;
        let mut required: Vec<_> = resources.keys().cloned().collect();
        required.sort();
        let mappings: Vec<_> = entries
            .iter()
            .map(|(logical, (id, rev))| json!({"logical":logical,"resourceId":id,"revision":rev}))
            .collect();
        let resource_memory = if resources.values().all(|r| r.decode_memory.is_some()) {
            let bounds: serde_json::Map<String, Value> = resources
                .iter()
                .map(|(id, r)| (id.clone(), r.decode_memory.unwrap().json()))
                .collect();
            json!({"version":1,"resources":bounds})
        } else {
            Value::Null
        };
        let bitmap_glyphs=records.iter().try_fold(0u64,|sum,record| {
            let count=record.get("bitmapGlyphs").map(|value|value.as_u64().ok_or("Invalid bitmap glyph count")).transpose()?.unwrap_or(0);
            sum.checked_add(count).filter(|n|*n<=(1u64<<53)-1).ok_or("Invalid bitmap glyph count")
        })?;
        let mut metadata = json!({"pageEpoch":epoch,"viewportVersion":viewport_version,"viewport":viewport,"lastProcessedInputSeq":input_seq,"requiredResources":required,"resourceMemory":resource_memory,"released":released,"mappings":mappings,"native":{"captureId":capture["captureId"],"producer":capture["producer"],"namespace":viz["namespace"],"frameToken":capture["frameToken"],"sourceFrame":capture["sourceFrame"],"bitmapGlyphs":bitmap_glyphs,"timing":capture["timing"]}});
        if let Some(ordinal)=capture.get("captureOrdinal").and_then(Value::as_u64){metadata["native"]["captureOrdinal"]=ordinal.into();}
        let serial = self.serial.checked_add(1).ok_or("Snapshot serial overflow")?;
        let snapshot = Arc::new(Snapshot {
            serial,
            scene,
            resources,
            metadata,
            full_json,
            _graph:admission.snapshot,
        });
        // No validation can fail beyond this point. Keep existing Arc/Bytes
        // owners immutable and merge only this transaction's additions.
        if self.index_lease.is_none(){self.index_lease=index_admission;}
        self.resources.extend(staged);
        for hash in hashes.values() {
            if self.resources.contains_key(hash) { self.recency.insert(hash.clone(),serial); }
        }
        // Every candidate first gets a bounded weak lookup. Evicting a strong
        // cache entry never invalidates a snapshot or an accepted wire owner.
        for (hash,resource) in &self.resources {
            let used=self.recency.get(hash).copied().unwrap_or(0);
            self.references.insert(hash.clone(),(Arc::downgrade(resource),used));
        }
        self.cache_bytes=self.resources.values().map(|r|r.cache_charge()).sum();
        let mut cold:Vec<_>=self.resources.keys().map(|hash|(self.recency.get(hash).copied().unwrap_or(0),hash.clone())).collect();
        cold.sort();
        for (_,hash) in cold {
            if self.cache_bytes<=self.cache_limit&&self.resources.len()<=self.resource_limit { break; }
            if let Some(resource)=self.resources.remove(&hash) {
                self.cache_bytes-=resource.cache_charge();self.recency.remove(&hash);self.cache_evictions+=1;
            }
        }
        self.references.retain(|_,(value,_)|value.strong_count()>0);
        let mut reference_order:Vec<_>=self.references.iter().map(|(hash,(_,used))|{
            let priority=if snapshot.resources.contains_key(hash){0}else if !self.resources.contains_key(hash){1}else{2};
            (priority,std::cmp::Reverse(*used),hash.clone())
        }).collect();reference_order.sort();
        for (_,_,hash) in reference_order.into_iter().skip(self.reference_limit) { self.references.remove(&hash); }
        self.chunks.extend(staged_chunks);
        self.chunks.retain(|_,entry|entry.strong_count()>0);
        if self.chunks.len()>self.chunk_limit {
            let mut hashes:Vec<_>=self.chunks.keys().cloned().collect();hashes.sort();
            for hash in hashes.into_iter().skip(self.chunk_limit) { self.chunks.remove(&hash); }
        }
        self.entries = entries; self.entry_lease=Some(admission.entries);
        self.revision = revision; self.epoch = epoch; self.serial = serial;
        Ok(snapshot)
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

#[cfg(test)]
mod transaction_tests {
    use super::*;
    fn viewport() -> Value { json!({"cssWidth":100,"cssHeight":100,"deviceScaleFactor":1}) }
    fn solids(count:usize)->Value{
        let quad=json!({"kind":"solid","matrix":[1,0,0,0,1,0,0,0,1],"rect":[0,0,100,100],"visible":[0,0,100,100],"opacity":1,"color":[0.1,0.2,0.3,1]});
        json!({"captureId":"snapshot-test","producer":"snapshot-test","resources":[],"viz":{"captureId":"snapshot-test","namespace":[1,2],"passes":[{"id":"root","output":[0,0,100,100],"quads":vec![quad;count]}]}})
    }
    #[test]fn snapshot_graph_credit_follows_final_arc_and_entries_release_actual_backing(){
        let pool=crate::snapshot_memory::SnapshotPool::new(32*1024*1024);let mut mapper=Mapper::new();mapper.snapshot_pool=pool.clone();
        let mut native=capture(1,32);native["timing"]=json!({"payload":"x".repeat(2*1024*1024)});
        let plan=crate::snapshot_memory::plan(&native,&viewport(),std::iter::empty(),0,0).unwrap();let charge=plan.snapshot;
        let snapshot=mapper.map(&native,1,&viewport(),1,0).unwrap();assert_eq!(pool.0.used(),charge+plan.entries);assert!(pool.0.used()>2*1024*1024);
        let alias=snapshot.clone();let weak=Arc::downgrade(&snapshot);drop(snapshot);assert_eq!(pool.0.used(),charge+plan.entries);assert!(mapper.entries.capacity()>0);
        mapper.reset_scene();assert_eq!(mapper.entries.capacity(),0);assert_eq!(pool.0.used(),charge);
        drop(mapper);assert!(weak.upgrade().is_some());assert_eq!(pool.0.used(),charge);drop(alias);assert!(weak.upgrade().is_none());assert_eq!(pool.0.used(),0);
    }
    #[test]fn snapshot_admission_denies_before_large_clone_without_mutating_committed_state(){
        let pool=crate::snapshot_memory::SnapshotPool::new(1024*1024);let mut mapper=Mapper::new();mapper.snapshot_pool=pool.clone();
        let old=mapper.map(&solids(1),1,&viewport(),1,0).unwrap();let state=fingerprint(&mapper);let before=pool.0.used();
        let mut oversized=solids(1);oversized["timing"]=json!({"payload":"x".repeat(2*1024*1024)});
        let(result,peak)=crate::allocation_probe::measure(||mapper.map(&oversized,2,&viewport(),2,0));
        assert_eq!(result.err().unwrap(),crate::snapshot_memory::PRESSURE);assert!(peak<4096,"denial allocated {peak} bytes before admission");assert_eq!(pool.0.used(),before);assert_eq!(fingerprint(&mapper),state);
        assert_eq!(old.metadata["pageEpoch"],1);drop(old);mapper.reset();assert_eq!(pool.0.used(),0);
    }
    #[test]fn snapshot_layout_reservation_covers_dense_and_escaped_graphs_and_bounded_scene_json(){
        let mut long=solids(1);long["timing"]=json!({"escaped":"x".repeat(2_100_000)+"\n\u{0}\\\""});
        let mut dense=solids(1);dense["timing"]=json!((0..2000).map(|n|json!({"key":n,"nested":[0,true,null]})).collect::<Vec<_>>());
        let mut escaped=solids(1);escaped["viz"]["passes"][0]["id"]=json!("\u{0}".repeat(64));
        let cases=[("minimal",solids(1)),("long-metadata",long),("dense-metadata",dense),("escaped-scene",escaped),("wide-scene",solids(1750)),("oversize-scene",solids(2048))];
        for(name,native)in cases{
            let mut mapper=Mapper::new();let pool=mapper.snapshot_pool.clone();let plan=crate::snapshot_memory::plan(&native,&viewport(),std::iter::empty(),0,0).unwrap();let reserved=plan.snapshot+plan.entries+plan.staging;
            let(result,peak)=crate::allocation_probe::measure(||mapper.map(&native,1,&viewport(),1,0));
            println!("snapshot-layout {name}: reserved={reserved} requested_peak={peak} live={} scene_bytes={}",pool.0.used(),result.as_ref().map(|s|s.full_json.len()).unwrap_or(0));assert!(peak<=reserved,"{name}: requested {peak} exceeds admission {reserved}");
            if name=="oversize-scene"{assert_eq!(result.err().unwrap(),"Scene metadata budget exceeded");assert_eq!(pool.0.used(),0);}else{let snapshot=result.unwrap();if name=="wide-scene"{assert!(snapshot.full_json.len()>200*1024);}drop(snapshot);mapper.reset();assert_eq!(pool.0.used(),0);}
        }
    }
    #[test]fn snapshot_plan_excludes_base64_payload_from_retained_graph_and_keeps_large_contract(){
        let native=capture(1,15*1024*1024);let plan=crate::snapshot_memory::plan(&native,&viewport(),std::iter::empty(),0,0).unwrap();
        assert!(plan.snapshot<1024*1024);assert!(plan.staging<2*1024*1024);assert!(native["resources"][0]["skp"].as_str().unwrap().len()>20*1024*1024-4);
    }
    #[test]fn repeated_record_values_are_priced_per_picture_before_they_are_cloned(){
        let pool=crate::snapshot_memory::SnapshotPool::new(16*1024*1024);let mut mapper=Mapper::new();mapper.snapshot_pool=pool.clone();
        let mut native=capture(1,32);native["resources"][0]["sourceLocalId"]=json!({"large":"x".repeat(128*1024)});let quad=native["viz"]["passes"][0]["quads"][0].clone();native["viz"]["passes"][0]["quads"]=json!(vec![quad;64]);
        let(result,peak)=crate::allocation_probe::measure(||mapper.map(&native,1,&viewport(),1,0));assert_eq!(result.err().unwrap(),crate::snapshot_memory::PRESSURE);assert!(peak<4096);assert_eq!(pool.0.used(),0);assert_eq!(mapper.serial,0);
    }
    fn payload(n: u32, size: usize) -> Vec<u8> {
        let mut bytes=vec![0;size];bytes[..8].copy_from_slice(b"skiapict");bytes[8..12].copy_from_slice(&n.to_le_bytes());bytes
    }
    fn capture(n: u32, size: usize) -> Value {
        json!({"captureId":"transaction","producer":"mapper-test","resources":[{"localId":1,"quadScale":1,"width":100,"height":100,"skp":STANDARD.encode(payload(n,size))}],"viz":{"captureId":"transaction","namespace":[1,2],"passes":[{"id":"root","output":[0,0,100,100],"quads":[{"kind":"picture","namespace":[1,2],"localId":1,"matrix":[1,0,0,0,1,0,0,0,1],"rect":[0,0,100,100],"visible":[0,0,100,100],"contentOrigin":[0,0],"opacity":1}]}]}})
    }
    fn raw(capture: &mut Value) -> HashMap<String,Vec<u8>> {
        let mut blocks=HashMap::new();for record in capture["resources"].as_array_mut().unwrap(){
            let bytes=STANDARD.decode(record["skp"].as_str().unwrap()).unwrap();let hash=format!("{:x}",Sha256::digest(&bytes));
            record.as_object_mut().unwrap().remove("skp");record["resourceId"]=json!(hash);blocks.insert(hash,bytes);
        }blocks
    }
    fn fingerprint(mapper: &Mapper) -> Value {
        let mut resources:Vec<_>=mapper.resources.iter().map(|(id,r)|json!([id,r.payload.as_ptr() as usize,r.wire.as_ptr() as usize,Arc::as_ptr(&r.chunks) as usize,r.manifest.as_str(),r.decode_memory.map(DecodeMemory::json)])).collect();resources.sort_by_key(Value::to_string);
        let mut chunks:Vec<_>=mapper.chunks.iter().map(|(id,c)|json!([id,c.as_ptr() as usize,c.strong_count()])).collect();chunks.sort_by_key(Value::to_string);
        json!({"entries":mapper.entries,"resources":resources,"chunks":chunks,"revision":mapper.revision,"serial":mapper.serial,"epoch":mapper.epoch})
    }
    fn rejected(mapper: &mut Mapper, native: &Value, epoch: u64, blocks: HashMap<String,Vec<u8>>, message: &str) {
        let before=fingerprint(mapper);let error=mapper.map_native(native,epoch,&viewport(),1,0,blocks).err().unwrap();assert!(error.contains(message),"{error}");assert_eq!(fingerprint(mapper),before);
    }
    #[test]
    fn base64_and_native_failure_floods_preserve_resources_chunks_and_all_generations() {
        let mut mapper=Mapper::new();let mut first=capture(0,32);let snapshot=mapper.map(&first,1,&viewport(),1,0).unwrap();let hash=snapshot.resources.keys().next().unwrap().clone();
        for n in 1..=140 {
            let mut bad=capture(n,1024*1024);let mut quad=bad["viz"]["passes"][0]["quads"][0].clone();quad["kind"]=json!("invalid");bad["viz"]["passes"][0]["quads"].as_array_mut().unwrap().push(quad);
            rejected(&mut mapper,&bad,if n%2==0{2}else{1},HashMap::new(),"Unknown quad kind");
            let blocks=raw(&mut bad);rejected(&mut mapper,&bad,2,blocks,"Unknown quad kind");
            rejected(&mut mapper,&bad,1,HashMap::new(),"cache miss");
        }
        first["resources"][0].as_object_mut().unwrap().remove("skp");first["resources"][0]["resourceId"]=json!(hash);
        let recovered=mapper.map(&first,1,&viewport(),1,0).unwrap();assert_eq!(recovered.serial,2);assert_eq!(recovered.scene,snapshot.scene);assert_eq!(mapper.revision,1);
        assert_eq!(mapper.resources.len(),1);assert_eq!(mapper.chunks.len(),1);
    }
    #[test]
    fn late_metadata_viewport_and_duplicate_failures_do_not_commit_native_ingest() {
        let mut mapper=Mapper::new();mapper.map(&capture(0,32),1,&viewport(),1,0).unwrap();
        let mut metadata=capture(1,32);let quad=metadata["viz"]["passes"][0]["quads"][0].clone();metadata["viz"]["passes"][0]["quads"]=json!(vec![quad;1500]);let blocks=raw(&mut metadata);
        rejected(&mut mapper,&metadata,2,blocks,"Scene metadata budget exceeded");
        let mut wrong=capture(2,32);wrong["viz"]["passes"][0]["output"][2]=json!(99);let blocks=raw(&mut wrong);rejected(&mut mapper,&wrong,2,blocks,"Root viewport mismatch");
        let mut duplicate=capture(3,32);let record=duplicate["resources"][0].clone();duplicate["resources"].as_array_mut().unwrap().push(record);let blocks=raw(&mut duplicate);rejected(&mut mapper,&duplicate,1,blocks,"Duplicate content ID");
        let mut unreferenced=capture(4,32);let mut blocks=raw(&mut unreferenced);let extra=payload(5,32);blocks.insert(format!("{:x}",Sha256::digest(&extra)),extra);rejected(&mut mapper,&unreferenced,1,blocks,"Unreferenced native resource");
        let mut logical=capture(6,32);logical["producer"]=json!("p".repeat(600));let blocks=raw(&mut logical);rejected(&mut mapper,&logical,2,blocks,"Invalid native logical ID");
        let mut glyphs=capture(7,32);glyphs["resources"][0]["bitmapGlyphs"]=json!(u64::MAX);let blocks=raw(&mut glyphs);rejected(&mut mapper,&glyphs,2,blocks,"Invalid bitmap glyph count");
    }
    #[test]
    fn descriptor_upgrades_are_atomic_and_do_not_mutate_prior_snapshots() {
        let mut mapper=Mapper::new();let legacy=capture(0,32);let old=mapper.map(&legacy,1,&viewport(),1,0).unwrap();let id=old.resources.keys().next().unwrap().clone();
        let mut complete=legacy.clone();complete["resources"][0]["assetRangeVersion"]=json!(1);complete["resources"][0]["assetRangesComplete"]=json!(true);complete["resources"][0]["assetRanges"]=json!([]);
        let mut bad=complete.clone();bad["viz"]["passes"][0]["output"][2]=json!(99);let blocks=raw(&mut bad);rejected(&mut mapper,&bad,2,blocks,"Root viewport mismatch");assert_eq!(mapper.resources[&id].decode_memory,None);
        let new=mapper.map(&complete,1,&viewport(),1,0).unwrap();assert_eq!(new.resources[&id].decode_memory,Some(DecodeMemory{image_bytes:0,font_bytes:0}));assert_eq!(old.resources[&id].decode_memory,None);assert_eq!(old.resources[&id].payload.as_ptr(),new.resources[&id].payload.as_ptr());assert_eq!(old.resources[&id].manifest.contains("\"decodeMemory\":null"),true);
        let mut conflict=complete.clone();conflict["resources"][0]["assetRanges"]=json!([{"offset":8,"bytes":16,"kind":"font","glyphSlots":1}]);rejected(&mut mapper,&conflict,1,HashMap::new(),"Conflicting resource memory descriptor");
        raw(&mut conflict);conflict["resources"][0]["assetRangesComplete"]=json!(false);rejected(&mut mapper,&conflict,1,HashMap::new(),"Incomplete or incompatible");
    }
    #[test]
    fn native_checksums_and_staged_byte_budget_reject_without_retention() {
        let mut mapper=Mapper::new();mapper.map(&capture(0,32),1,&viewport(),1,0).unwrap();
        let mut wrong=capture(1,32);let mut blocks=raw(&mut wrong);let id=wrong["resources"][0]["resourceId"].as_str().unwrap().to_owned();blocks.insert(id,payload(2,32));rejected(&mut mapper,&wrong,1,blocks,"checksum mismatch");
        let mut huge=capture(3,32);huge["resources"]=json!([]);let mut blocks=HashMap::new();
        for n in 0..5 {let mut part=capture(n+10,13*1024*1024);part["resources"][0]["localId"]=json!(n+1);blocks.extend(raw(&mut part));huge["resources"].as_array_mut().unwrap().push(part["resources"][0].clone());}
        rejected(&mut mapper,&huge,2,blocks,"Staged resource budget exceeded");
    }
    #[test]
    fn cached_chunks_are_shared_across_a_successful_new_resource_transaction() {
        let mut mapper=Mapper::new();let first=mapper.map(&capture(1,64*1024),1,&viewport(),1,0).unwrap();let next=mapper.map(&capture(2,64*1024),1,&viewport(),1,0).unwrap();
        let a=first.resources.values().next().unwrap();let b=next.resources.values().next().unwrap();assert!(!Arc::ptr_eq(&a.chunks[0],&b.chunks[0]));assert!(Arc::ptr_eq(&a.chunks[1],&b.chunks[1]));
    }
    #[test]
    fn allocation_failure_rolls_back_and_final_wire_aliases_survive_snapshot_and_cache_release() {
        let budget=crate::budget::Budget::new(300*1024);let mut mapper=Mapper::with_budget(budget.clone());
        let snapshot=mapper.map(&capture(1,64*1024),1,&viewport(),1,0).unwrap();let before=budget.used();let state=fingerprint(&mapper);
        let failure=mapper.map(&capture(2,64*1024),2,&viewport(),1,0).err().unwrap();assert_eq!(failure,crate::budget::PRESSURE);assert_eq!(budget.used(),before);assert_eq!(fingerprint(&mapper),state);
        let resource=snapshot.resources.values().next().unwrap();let payload=resource.payload.slice(0..1);let wire=resource.wire.clone();let chunk=resource.chunks[0].wire.clone();let text=resource.manifest.clone();
        mapper.reset();drop(snapshot);assert!(budget.used()>64*1024);assert_eq!(payload.as_ref(),b"s");assert!(text.contains("ResourceManifest"));assert_eq!(&wire[..4],b"RPNT");assert_eq!(&chunk[..4],b"RPNT");
        drop(payload);drop(wire);drop(chunk);assert!(budget.used()>0);drop(text);assert_eq!(budget.used(),0);
    }
    #[test]
    fn descriptor_upgrades_only_reserve_new_metadata_and_share_live_buffer_credits() {
        let budget=crate::budget::Budget::new(1024*1024);let mut mapper=Mapper::with_budget(budget.clone());let legacy=capture(1,64*1024);
        let old=mapper.map(&legacy,1,&viewport(),1,0).unwrap();let before=budget.used();let mut complete=legacy.clone();complete["resources"][0]["assetRangeVersion"]=json!(1);complete["resources"][0]["assetRangesComplete"]=json!(true);complete["resources"][0]["assetRanges"]=json!([]);
        let new=mapper.map(&complete,1,&viewport(),1,0).unwrap();let added=budget.used()-before;assert!(added>0&&added<4096);let a=old.resources.values().next().unwrap();let b=new.resources.values().next().unwrap();assert_eq!(a.payload.as_ptr(),b.payload.as_ptr());assert_eq!(a.wire.as_ptr(),b.wire.as_ptr());assert!(Arc::ptr_eq(&a.chunks,&b.chunks));
        mapper.reclaim_cache();drop(old);assert!(budget.used()<before+added);assert!(budget.used()>64*1024);drop(new);assert_eq!(budget.used(),0);
    }
    #[test]
    fn large_supported_working_set_bypasses_cache_without_losing_hash_only_snapshot_reuse() {
        let mut mapper=Mapper::new();let mut native=capture(0,32);native["resources"]=json!([]);native["viz"]["passes"][0]["quads"]=json!([]);let mut blocks=HashMap::new();
        for n in 1..=3 {
            let bytes=payload(n,15*1024*1024);let hash=format!("{:x}",Sha256::digest(&bytes));
            native["resources"].as_array_mut().unwrap().push(json!({"localId":n,"quadScale":1,"width":100,"height":100,"resourceId":hash}));
            let mut q=capture(0,32)["viz"]["passes"][0]["quads"][0].clone();q["localId"]=json!(n);native["viz"]["passes"][0]["quads"].as_array_mut().unwrap().push(q);blocks.insert(hash,bytes);
        }
        let first=mapper.map_native(&native,1,&viewport(),1,0,blocks).unwrap();
        assert_eq!(first.resources.len(),3);assert_eq!(mapper.resources.len(),2);assert!(mapper.cache_bytes<=CACHE_BYTES);assert!(mapper.cache_evictions>0);
        let second=mapper.map(&native,1,&viewport(),1,0).unwrap();assert_eq!(first.scene,second.scene);
        for (hash,resource) in &first.resources {
            assert!(Arc::ptr_eq(resource,&second.resources[hash]));assert_eq!(resource.manifest.as_ptr(),second.resources[hash].manifest.as_ptr());
        }
        let retained=Arc::downgrade(first.resources.values().next().unwrap());mapper.reset();
        assert!(retained.upgrade().is_some());assert_eq!(mapper.cache_bytes,0);
        drop(first);drop(second);assert!(retained.upgrade().is_none());
    }
    #[test]
    fn cache_lru_touches_old_hashes_and_preserves_retired_snapshot_pins() {
        let mut mapper=Mapper::with_limits(usize::MAX,2,512,8192);
        let a=mapper.map(&capture(1,32),1,&viewport(),1,0).unwrap();let b=mapper.map(&capture(2,32),1,&viewport(),1,0).unwrap();
        let ah=a.resources.keys().next().unwrap().clone();let bh=b.resources.keys().next().unwrap().clone();
        let mut touch=capture(1,32);touch["resources"][0].as_object_mut().unwrap().remove("skp");touch["resources"][0]["resourceId"]=json!(ah);mapper.map(&touch,1,&viewport(),1,0).unwrap();
        let c=mapper.map(&capture(3,32),1,&viewport(),1,0).unwrap();assert!(mapper.resources.contains_key(&ah));assert!(!mapper.resources.contains_key(&bh));assert!(mapper.resources.contains_key(c.resources.keys().next().unwrap()));
        let mut revive=capture(2,32);revive["resources"][0].as_object_mut().unwrap().remove("skp");revive["resources"][0]["resourceId"]=json!(bh);
        let recovered=mapper.map(&revive,1,&viewport(),1,0).unwrap();assert!(Arc::ptr_eq(&b.resources[&bh],&recovered.resources[&bh]));
    }
    #[test]
    fn live_snapshot_count_cannot_expand_weak_resource_or_chunk_indexes() {
        let mut mapper=Mapper::with_limits(usize::MAX,2,4,3);let mut pins=vec![];
        for n in 1..=20 {
            pins.push(mapper.map(&capture(n,32),1,&viewport(),1,0).unwrap());
            assert!(mapper.resources.len()<=2);assert!(mapper.references.len()<=4);assert!(mapper.chunks.len()<=3);
        }
        let hash=pins.last().unwrap().resources.keys().next().unwrap().clone();let mut latest=capture(20,32);latest["resources"][0].as_object_mut().unwrap().remove("skp");latest["resources"][0]["resourceId"]=json!(hash);
        assert!(mapper.map(&latest,1,&viewport(),1,0).is_ok());
        let old_hash=pins[0].resources.keys().next().unwrap().clone();latest["resources"][0]["resourceId"]=json!(old_hash);
        rejected(&mut mapper,&latest,1,HashMap::new(),"cache miss");assert_eq!(pins[0].resources[&old_hash].payload[..8],*b"skiapict");
    }
    #[test]fn tile_expansion_moves_encoded_resources_and_stops_before_unbounded_quad_cloning(){
        let pool=crate::capture_expansion::Pool::new(crate::capture_expansion::DEFAULT_BYTES);
        let native=capture(1,1024*1024);let ptr=native["resources"][0]["skp"].as_str().unwrap().as_ptr();let expanded=crate::capture_expansion::expand(native,&pool).unwrap();assert_eq!(expanded["resources"][0]["skp"].as_str().unwrap().as_ptr(),ptr);
        let mut tiled=capture(1,32);tiled["resources"][0]["tileOrigin"]=json!([0,0]);let ptr=tiled["resources"][0]["skp"].as_str().unwrap().as_ptr();let expanded=crate::capture_expansion::expand(tiled,&pool).unwrap();assert_eq!(expanded["resources"][0]["sourceLocalId"],1);assert_eq!(expanded["resources"][0]["localId"],1024);assert_eq!(expanded["resources"][0]["skp"].as_str().unwrap().as_ptr(),ptr);
        let mut tiled=capture(1,32);tiled["resources"][0]["tileOrigin"]=json!([0,0]);
        let quad=tiled["viz"]["passes"][0]["quads"][0].clone();tiled["viz"]["passes"][0]["quads"]=json!(vec![quad;2049]);assert!(crate::capture_expansion::expand(tiled,&pool).err().unwrap().contains("Expanded tile quad budget"));
    }
}

#[cfg(test)]mod index_ownership_tests{
 use super::*;
 use crate::{allocation_probe::{measure,observe},mapper_memory::{Pool,ALLOWANCE_BYTES,PRESSURE}};
 fn viewport()->Value{json!({"cssWidth":10,"cssHeight":10,"deviceScaleFactor":1})}
 fn native(seed:u8,dense:bool)->Value{let mut bytes=vec![seed;if dense{8208}else{65536}];bytes[..8].copy_from_slice(b"skiapict");let mut record=json!({"localId":1,"quadScale":1,"width":10,"height":10,"skp":STANDARD.encode(bytes)});if dense{record["assetRanges"]=json!((0..256).map(|n|json!({"offset":16+n*32,"bytes":16,"kind":"font"})).collect::<Vec<_>>());}json!({"captureId":"index-fixture","producer":"index-fixture","resources":[record],"viz":{"captureId":"index-fixture","namespace":[1,2],"passes":[{"id":"root","output":[0,0,10,10],"quads":[{"kind":"picture","localId":1,"namespace":[1,2],"matrix":[1,0,0,0,1,0,0,0,1],"rect":[0,0,10,10],"visible":[0,0,10,10],"contentOrigin":[0,0],"opacity":1}]}]}})}
 fn bad(mut native:Value)->Value{native["viz"]["passes"][0]["quads"].as_array_mut().unwrap().push(json!({"kind":"invalid","matrix":[1,0,0,0,1,0,0,0,1],"rect":[0,0,10,10],"visible":[0,0,10,10],"opacity":1}));native}
 fn state(mapper:&Mapper)->Value{let mut value=mapper.stats();value.as_object_mut().unwrap().remove("mapperIndices");value}
 #[test]fn index_capacity_credit_survives_clear_and_reclaim_then_reset_drops_real_buckets(){
  let pool=Pool::new(ALLOWANCE_BYTES);let mut mapper=Mapper::new();mapper.index_pool=pool.clone();let capture=native(3,false);let snapshot=mapper.map(&capture,1,&viewport(),1,0).unwrap();let id=snapshot.resources.keys().next().unwrap().clone();let pointer=Arc::as_ptr(&snapshot.resources[&id]);let wire=snapshot.resources[&id].wire.clone();assert_eq!(pool.0.used(),ALLOWANCE_BYTES);assert!(mapper.resources.capacity()>0&&mapper.chunks.capacity()>0);
  mapper.reset_scene();assert!(mapper.entries.is_empty());assert_eq!(pool.0.used(),ALLOWANCE_BYTES);mapper.reclaim_cache();assert!(mapper.resources.is_empty());assert!(mapper.resources.capacity()>0);assert!(mapper.chunks.capacity()>0);assert_eq!(pool.0.used(),ALLOWANCE_BYTES);assert!(pool.ready());assert_eq!(pool.stats()["canAdmitMapper"],false);
  let mut hash_only=capture;hash_only["resources"][0].as_object_mut().unwrap().remove("skp");hash_only["resources"][0]["resourceId"]=json!(id);let recovered=mapper.map(&hash_only,1,&viewport(),1,0).unwrap();assert_eq!(Arc::as_ptr(&recovered.resources[&id]),pointer);
  mapper.reset();assert!(mapper.index_lease.is_none());assert_eq!(pool.0.used(),0);assert_eq!((mapper.resources.capacity(),mapper.recency.capacity(),mapper.references.capacity(),mapper.chunks.capacity()),(0,0,0,0));assert_eq!(&wire[..4],b"RPNT");drop(mapper);assert_eq!(pool.0.used(),0);assert_eq!(Arc::as_ptr(&recovered.resources[&id]),pointer);drop((snapshot,recovered,wire));
 }
 #[test]fn first_admission_and_late_mapping_failures_leave_all_persistent_state_unchanged(){
  let capture=native(1,false);let mut mapper=Mapper::new();mapper.index_pool=Pool::new(ALLOWANCE_BYTES-1);let(result,peak)=measure(||mapper.map(&capture,1,&viewport(),1,0));assert_eq!(result.err().unwrap(),PRESSURE);assert!(peak<4096);assert_eq!(mapper.index_pool.0.used(),0);assert!(mapper.index_lease.is_none());assert!(mapper.resources.is_empty());assert_eq!(mapper.serial,0);assert_eq!(mapper.snapshot_pool.0.used(),0);
  mapper.index_pool=Pool::new(ALLOWANCE_BYTES);let pool=mapper.index_pool.clone();assert!(mapper.map(&bad(native(2,true)),1,&viewport(),1,0).is_err());assert_eq!(pool.0.used(),0);assert!(mapper.index_lease.is_none());assert_eq!(mapper.resources.capacity(),0);
  let snapshot=mapper.map(&capture,1,&viewport(),1,0).unwrap();let before=state(&mapper);assert!(mapper.map(&bad(native(4,true)),2,&viewport(),2,0).is_err());assert_eq!(state(&mapper),before);assert_eq!(pool.0.used(),ALLOWANCE_BYTES);drop(mapper);assert_eq!(pool.0.used(),0);assert!(!snapshot.resources.is_empty());
 }
 #[test]fn actual_index_growth_sorting_and_stats_upper_bound_fits_lifetime_allowance(){
  let ids:Vec<_>=(0..16384).map(|n|format!("{n:064x}")).collect();let resource=Arc::new(crate::assets::resource(b"skiapictabcdefghijklmnopqrst".to_vec(),"fixture",&Value::Null,&mut HashMap::new()).unwrap());let pool=Pool::new(ALLOWANCE_BYTES);let lease=pool.admit().unwrap();let weak_budget=crate::budget::Budget::new(1);let minimum_chunk_charge=44+64+std::mem::size_of::<crate::assets::Chunk>()+256+std::mem::size_of::<Arc<crate::assets::Chunk>>()+1;let stats_bound=CACHE_BYTES/minimum_chunk_charge;
  let(held,live,peak)=observe(||{
   let mut resources=HashMap::new();let mut recency=HashMap::new();let mut references=HashMap::new();let mut chunks=HashMap::new();for id in &ids[..768]{resources.insert(id.clone(),resource.clone());recency.insert(id.clone(),1u64);}for id in &ids[..1280]{let target=Arc::new(Resource{payload:Bytes::new(),wire:Bytes::new(),chunks:resource.chunks.clone(),manifest:tungstenite::Utf8Bytes::from_static(""),decode_memory:None,payload_capacity:0,wire_capacity:0,manifest_capacity:0,_metadata:weak_budget.reserve(0).unwrap()});references.insert(id.clone(),(Arc::downgrade(&target),1u64));drop(target);}
   let weak_chunk=||{let target=Arc::new(crate::assets::Chunk{id:String::new(),wire:Bytes::new(),charge:0,_metadata:weak_budget.reserve(0).unwrap()});let weak=Arc::downgrade(&target);drop(target);weak};
   for id in &ids[..8192]{chunks.insert(id.clone(),weak_chunk());}let mut staged=HashMap::new();for id in &ids[8192..]{staged.insert(id.clone(),weak_chunk());}chunks.extend(staged);
   let mut cold:Vec<_>=resources.keys().map(|id|(1u64,id.clone())).collect();cold.sort();let mut order:Vec<_>=references.keys().map(|id|(0u8,std::cmp::Reverse(1u64),id.clone())).collect();order.sort();let mut retired:Vec<_>=chunks.keys().cloned().collect();retired.sort();let mut stats=HashSet::new();for n in 0..stats_bound{stats.insert(n as *const crate::assets::Chunk);}assert_eq!(stats.len(),stats_bound);(resources,recency,references,chunks,cold,order,retired,stats)
  });assert!(peak<=ALLOWANCE_BYTES);assert_eq!(held.3.len(),16384);assert_eq!(held.7.len(),stats_bound);assert_eq!(weak_budget.used(),0);assert!(held.2.values().all(|(target,_)|target.strong_count()==0));assert!(held.3.values().all(|target|target.strong_count()==0));println!("mapper-index-after: live={live} requested_peak={peak} reservation={ALLOWANCE_BYTES} strong_capacity={} recency_capacity={} reference_capacity={} chunk_capacity={} stats_bound={stats_bound} stale_weak_resources=1280 stale_weak_chunks=16384",held.0.capacity(),held.1.capacity(),held.2.capacity(),held.3.capacity());drop(held);assert_eq!(pool.0.used(),ALLOWANCE_BYTES);drop(lease);assert_eq!(pool.0.used(),0);
 }
 #[test]fn actual_dense_asset_hash_staging_and_stats_remain_within_combined_owned_domains(){
  let capture=native(7,true);let mut mapper=Mapper::new();let snapshot_pool=mapper.snapshot_pool.clone();let resource_pool=mapper.budget.clone();let index_pool=mapper.index_pool.clone();let(snapshot,peak)=measure(||mapper.map(&capture,1,&viewport(),1,0).unwrap());assert_eq!(snapshot.resources.values().next().unwrap().chunks.len(),513);let admitted=[resource_pool.stats(),snapshot_pool.stats(),index_pool.stats()].iter().map(|s|s["peak"].as_u64().unwrap()as usize).sum::<usize>();assert!(peak<=admitted);let stats=mapper.stats();assert_eq!(stats["indexAllowanceBytes"],ALLOWANCE_BYTES);assert_eq!(stats["mapperIndices"]["allocations"],1);println!("mapper-dense-hash-after: requested_peak={peak} combined_peak_allowance={admitted} weak_chunks={} chunk_capacity={}",mapper.chunks.len(),mapper.chunks.capacity());mapper.reset();assert_eq!(index_pool.0.used(),0);assert_eq!(snapshot.resources.values().next().unwrap().chunks.len(),513);
 }
}
