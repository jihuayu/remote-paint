use crate::scene::{DecodeMemory, Resource, Result};
use bytes::Bytes;
use serde::{Serialize, Serializer, ser::{SerializeMap, SerializeSeq}};
use serde_json::Value;
#[cfg(test)] use serde_json::json;
use std::io::{self, Write};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
};
pub struct Chunk {
    pub id: String,
    pub wire: Bytes,
    pub charge: usize,
    pub _metadata: crate::budget::Lease,
}
#[derive(Clone, Copy)]
#[repr(u8)]
enum ChunkKind { Skp, Font, Image }
impl ChunkKind {
    fn name(self) -> &'static str {
        match self { Self::Skp => "skp", Self::Font => "font", Self::Image => "image" }
    }
}
// Kind belongs to each occurrence, not the hash-shared Chunk. All typed
// storage is admitted before allocation and drops before its final credit.
pub struct ChunkList {
    values: Vec<Arc<Chunk>>,
    kinds: Vec<ChunkKind>,
    id: String,
    _metadata: crate::budget::Lease,
}
impl std::ops::Deref for ChunkList {type Target=Vec<Arc<Chunk>>;fn deref(&self)->&Self::Target{&self.values}}
impl ChunkList {
    pub fn metadata_bytes(&self) -> usize {
        self.values.capacity()*std::mem::size_of::<Arc<Chunk>>()
            + self.kinds.capacity()*std::mem::size_of::<ChunkKind>()
            + self.id.capacity() + std::mem::size_of::<Self>() + 128
    }
}
#[cfg(test)]
pub fn resource(
    payload: Vec<u8>,
    id: &str,
    ranges: &Value,
    cache: &mut HashMap<String, Weak<Chunk>>,
) -> Result<Resource> {
    let mut staged = HashMap::new();
    let budget=crate::budget::Budget::new(crate::budget::DEFAULT_BYTES);
    let result = resource_with_profile(budget.payload(payload)?, id, ranges, false, cache, &mut staged,&budget)?;
    cache.extend(staged);
    Ok(result)
}
#[cfg(test)]
pub fn native_resource(
    payload: Vec<u8>,
    id: &str,
    record: &Value,
    cache: &mut HashMap<String, Weak<Chunk>>,
) -> Result<Resource> {
    let mut staged = HashMap::new();
    let budget=crate::budget::Budget::new(crate::budget::DEFAULT_BYTES);
    let result = staged_native_resource(budget.payload(payload)?, id, record, cache, &mut staged,&budget)?;
    cache.extend(staged);
    Ok(result)
}
fn complete_profile(record: &Value) -> Result<bool> {
    let claimed =
        record.get("assetRangeVersion").is_some() || record.get("assetRangesComplete").is_some();
    if claimed
        && (record["assetRangeVersion"] != 1
            || record["assetRangesComplete"] != true
            || !record["assetRanges"].is_array())
    {
        return Err("Incomplete or incompatible native asset memory index".into());
    }
    Ok(claimed)
}
pub fn native_memory(payload: &[u8], record: &Value) -> Result<Option<DecodeMemory>> {
    let complete = complete_profile(record)?;
    let memory = visit_sections(payload, &record["assetRanges"], complete, |_, _, _| Ok(()))?;
    Ok(complete.then_some(memory))
}
pub fn staged_native_resource(
    payload: crate::budget::Payload, id: &str, record: &Value,
    cache: &HashMap<String, Weak<Chunk>>,
    staged: &mut HashMap<String, Weak<Chunk>>,
    budget:&crate::budget::Budget,
) -> Result<Resource> {
    let complete = complete_profile(record)?;
    resource_with_profile(payload, id, &record["assetRanges"], complete, cache, staged,budget)
}
pub fn upgrade_memory(existing:&Resource,memory:DecodeMemory,budget:&crate::budget::Budget)->Result<Resource>{
    let metadata=budget.reserve(std::mem::size_of::<Resource>()+128)?;
    let manifest=resource_manifest(&existing.chunks,existing.payload.len(),Some(memory),budget)?;
    let manifest_capacity=manifest.len();
    Ok(Resource{payload:existing.payload.clone(),wire:existing.wire.clone(),chunks:existing.chunks.clone(),manifest,decode_memory:Some(memory),payload_capacity:existing.payload_capacity,wire_capacity:existing.wire_capacity,manifest_capacity,_metadata:metadata})
}
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ if crc & 1 != 0 { 0xedb88320 } else { 0 };
        }
    }
    !crc
}
fn png_memory(bytes: &[u8]) -> Result<u64> {
    if bytes.len() < 33
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || bytes[8..12] != 13u32.to_be_bytes()
        || &bytes[12..16] != b"IHDR"
    {
        return Err("Invalid indexed PNG header".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    let depth = bytes[24];
    let color = bytes[25];
    let valid = match color {
        0 => matches!(depth, 1 | 2 | 4 | 8 | 16),
        2 | 4 | 6 => matches!(depth, 8 | 16),
        3 => matches!(depth, 1 | 2 | 4 | 8),
        _ => false,
    };
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || !valid
        || bytes[26] != 0
        || bytes[27] != 0
        || bytes[28] > 1
        || crc32(&bytes[12..29]) != u32::from_be_bytes(bytes[29..33].try_into().unwrap())
    {
        return Err("Invalid indexed PNG dimensions or format".into());
    }
    // Upper pixel estimate includes RGBA F16. Codec scratch is admitted by
    // the Viewer separately; encoded PNG byte size is not a decoded budget.
    Ok(u64::from(width) * u64::from(height) * 8)
}
fn visit_sections(
    payload: &[u8],
    ranges: &Value,
    complete: bool,
    mut visit: impl FnMut(usize, usize, ChunkKind) -> Result<()>,
) -> Result<DecodeMemory> {
    let mut offset = 0;
    let mut memory = DecodeMemory {
        image_bytes: 0,
        font_bytes: 0,
    };
    if let Some(ranges) = ranges.as_array() {
        if ranges.len() > 256 {
            return Err("Asset range limit".into());
        }
        for range in ranges {
            let start = range["offset"].as_u64().ok_or("Invalid asset offset")? as usize;
            let size = range["bytes"].as_u64().ok_or("Invalid asset size")? as usize;
            let kind = match range["kind"].as_str() {
                Some("font") => ChunkKind::Font, Some("image") => ChunkKind::Image,
                _ => return Err("Invalid asset kind".into()),
            };
            if start < offset
                || size < 16
                || start
                    .checked_add(size)
                    .is_none_or(|end| end > payload.len())
            {
                return Err("Invalid or overlapping asset range".into());
            }
            if start > offset {
                visit(offset, start, ChunkKind::Skp)?;
            }
            if complete {
                if matches!(kind, ChunkKind::Image) {
                    memory.image_bytes = memory
                        .image_bytes
                        .checked_add(png_memory(&payload[start..start + size])?)
                        .ok_or("Image memory estimate overflow")?;
                } else {
                    let slots = range["glyphSlots"]
                        .as_u64()
                        .filter(|n| *n > 0 && *n <= 65536)
                        .ok_or("Invalid indexed font glyph slots")?;
                    memory.font_bytes = memory
                        .font_bytes
                        .checked_add(size as u64 * 4 + slots * 128 + 65536)
                        .ok_or("Font memory estimate overflow")?;
                }
            }
            visit(start, start + size, kind)?;
            offset = start + size;
        }
    }
    if offset < payload.len() {
        visit(offset, payload.len(), ChunkKind::Skp)?;
    }
    Ok(memory)
}
struct Manifest<'a> { chunks: &'a ChunkList, bytes: usize, memory: Option<DecodeMemory> }
impl Serialize for Manifest<'_> {
    fn serialize<S:Serializer>(&self, serializer:S)->std::result::Result<S::Ok,S::Error> {
        // Retain the previous Value map's key order as well as its schema.
        let mut map=serializer.serialize_map(Some(5))?;
        map.serialize_entry("bytes",&self.bytes)?;
        map.serialize_entry("chunks",&ManifestChunks(self.chunks))?;
        map.serialize_entry("decodeMemory",&self.memory.map(ManifestMemory))?;
        map.serialize_entry("id",&self.chunks.id)?;
        map.serialize_entry("type","ResourceManifest")?;
        map.end()
    }
}
struct ManifestChunks<'a>(&'a ChunkList);
impl Serialize for ManifestChunks<'_> {
    fn serialize<S:Serializer>(&self, serializer:S)->std::result::Result<S::Ok,S::Error> {
        let mut seq=serializer.serialize_seq(Some(self.0.len()))?;
        for (chunk,kind) in self.0.values.iter().zip(&self.0.kinds) {
            seq.serialize_element(&ManifestChunk{chunk,kind:*kind})?;
        }
        seq.end()
    }
}
struct ManifestChunk<'a> { chunk: &'a Chunk, kind: ChunkKind }
impl Serialize for ManifestChunk<'_> {
    fn serialize<S:Serializer>(&self, serializer:S)->std::result::Result<S::Ok,S::Error> {
        let mut map=serializer.serialize_map(Some(2))?;
        map.serialize_entry("id",&self.chunk.id)?;
        map.serialize_entry("kind",self.kind.name())?;
        map.end()
    }
}
struct ManifestMemory(DecodeMemory);
impl Serialize for ManifestMemory {
    fn serialize<S:Serializer>(&self, serializer:S)->std::result::Result<S::Ok,S::Error> {
        let mut map=serializer.serialize_map(Some(2))?;
        map.serialize_entry("fontBytes",&self.0.font_bytes)?;
        map.serialize_entry("imageBytes",&self.0.image_bytes)?;
        map.end()
    }
}
struct ManifestSize { bytes: usize, limit: usize }
impl Write for ManifestSize {
    fn write(&mut self, bytes:&[u8])->io::Result<usize> {
        self.bytes=self.bytes.checked_add(bytes.len()).filter(|n|*n<=self.limit)
            .ok_or_else(||io::Error::other(crate::budget::PRESSURE))?;
        Ok(bytes.len())
    }
    fn flush(&mut self)->io::Result<()> { Ok(()) }
}
struct ManifestWriter<'a>(&'a mut crate::budget::OwnedVec);
impl Write for ManifestWriter<'_> {
    fn write(&mut self, bytes:&[u8])->io::Result<usize> {
        if bytes.len()>self.0.capacity()-self.0.len() {
            return Err(io::Error::other("Resource manifest size changed"));
        }
        self.0.extend(bytes);Ok(bytes.len())
    }
    fn flush(&mut self)->io::Result<()> { Ok(()) }
}
fn resource_manifest(chunks:&ChunkList,bytes:usize,memory:Option<DecodeMemory>,budget:&crate::budget::Budget)->Result<tungstenite::Utf8Bytes> {
    let value=Manifest{chunks,bytes,memory};let mut size=ManifestSize{bytes:0,limit:budget.limit()};
    serde_json::to_writer(&mut size,&value).map_err(|_|crate::budget::PRESSURE)?;
    let mut output=budget.buffer(size.bytes)?;
    serde_json::to_writer(ManifestWriter(&mut output),&value).map_err(|error|error.to_string())?;
    if output.len()!=size.bytes { return Err("Resource manifest size changed".into()); }
    // The exact admitted backing moves into Utf8Bytes; aliases pin its owner.
    tungstenite::Utf8Bytes::try_from(output.finish()).map_err(|_|"Invalid resource manifest UTF8".into())
}
fn resource_with_profile(
    payload: crate::budget::Payload, id: &str, ranges: &Value, complete: bool,
    cache: &HashMap<String, Weak<Chunk>>,
    staged: &mut HashMap<String, Weak<Chunk>>,
    budget:&crate::budget::Budget,
) -> Result<Resource> {
    // Validate the entire index before constructing any chunk. The first
    // borrowed pass also determines exact final typed-list storage.
    let mut count=0usize;
    let memory=visit_sections(&payload,ranges,complete,|start,end,_| {
        count=count.checked_add((end-start).div_ceil(32*1024)).ok_or(crate::budget::PRESSURE)?;Ok(())
    })?;
    let list_bytes=count.checked_mul(std::mem::size_of::<Arc<Chunk>>()+std::mem::size_of::<ChunkKind>())
        .and_then(|n|n.checked_add(id.len()))
        .and_then(|n|n.checked_add(std::mem::size_of::<ChunkList>()+128)).ok_or(crate::budget::PRESSURE)?;
    let list_metadata=budget.reserve(list_bytes)?;
    let mut chunks=Vec::with_capacity(count);let mut kinds=Vec::with_capacity(count);
    let mut resource_id=String::with_capacity(id.len());resource_id.push_str(id);
    if chunks.capacity()!=count || kinds.capacity()!=count || resource_id.capacity()!=id.len() {
        return Err("Unexpected resource metadata capacity".into());
    }
    let payload_capacity=payload.capacity;let payload=payload.bytes;
    visit_sections(&payload,ranges,complete,|start,end,kind| {
        // Bound every packet, including fonts/images. The manifest preserves
        // the asset kind and exact byte order; hashes still deduplicate chunks.
        let size = 32 * 1024;
        for part in payload[start..end].chunks(size) {
            let digest = Sha256::digest(part);
            let hash = format!("{:x}", digest);
            let cached = staged
                .get(&hash)
                .or_else(|| cache.get(&hash))
                .and_then(|entry| entry.upgrade());
            let chunk=if let Some(chunk)=cached{chunk}else{
                    let metadata=budget.reserve(std::mem::size_of::<Chunk>()+hash.capacity()+128)?;
                    let mut wire=budget.buffer(part.len()+44)?;wire.extend(b"RPNT\x01\x02\0\0");
                    wire.extend((part.len() as u32).to_be_bytes());
                    wire.extend(digest);
                    wire.extend(part);
                    let chunk = Arc::new(Chunk {
                        id: hash.clone(),
                        charge: wire.capacity()+hash.capacity()+std::mem::size_of::<Chunk>()+256,
                        wire: wire.finish(),_metadata:metadata,
                    });
                    if staged.len()<crate::scene::CHUNK_INDEX_ENTRIES {
                        staged.insert(hash, Arc::downgrade(&chunk));
                    }
                    chunk
                };
            kinds.push(kind);chunks.push(chunk);
        }
        Ok(())
    })?;
    let chunks=Arc::new(ChunkList{values:chunks,kinds,id:resource_id,_metadata:list_metadata});
    let metadata=budget.reserve(std::mem::size_of::<Resource>()+128)?;
    let manifest=resource_manifest(&chunks,payload.len(),complete.then_some(memory),budget)?;
    let manifest_capacity=manifest.len();
    let mut wire=budget.buffer(payload.len()+44)?;wire.extend(b"RPNT\x01\x01\0\0");
    wire.extend((payload.len() as u32).to_be_bytes());
    wire.extend(Sha256::digest(&payload));
    wire.extend(&payload);
    Ok(Resource {
        payload_capacity,wire_capacity: wire.capacity(),manifest_capacity,
        payload,
        wire: wire.finish(),
        chunks,
        manifest,_metadata:metadata,
        decode_memory: complete.then_some(memory),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changed_commands_share_font_and_image_chunks() {
        let mut cache = HashMap::new();
        let mut a = b"skiapict-command-one".to_vec();
        a.extend([17; 32]);
        a.extend([29; 64]);
        let mut b = a.clone();
        b[8] = b'X';
        let ranges =
            json!([{"offset":19,"bytes":32,"kind":"font"},{"offset":51,"bytes":64,"kind":"image"}]);
        let ra = resource(
            a.clone(),
            &format!("{:x}", Sha256::digest(&a)),
            &ranges,
            &mut cache,
        )
        .unwrap();
        let rb = resource(
            b.clone(),
            &format!("{:x}", Sha256::digest(&b)),
            &ranges,
            &mut cache,
        )
        .unwrap();
        assert!(!Arc::ptr_eq(&ra.chunks[0], &rb.chunks[0]));
        assert!(Arc::ptr_eq(&ra.chunks[1], &rb.chunks[1]));
        assert!(Arc::ptr_eq(&ra.chunks[2], &rb.chunks[2]));
        let rebuilt: Vec<u8> = rb
            .chunks
            .iter()
            .flat_map(|c| c.wire[44..].iter().copied())
            .collect();
        assert_eq!(rebuilt, b);
        for invalid in [
            json!([{"offset":19,"bytes":999,"kind":"font"}]),
            json!([{"offset":19,"bytes":32,"kind":"font"},{"offset":20,"bytes":32,"kind":"image"}]),
        ] {
            assert!(resource(a.clone(), "test", &invalid, &mut cache).is_err());
        }
    }
}

#[cfg(test)]
mod memory_tests {
    use super::*;
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend(13u32.to_be_bytes());
        bytes.extend(b"IHDR");
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes.extend([8, 6, 0, 0, 0]);
        let crc = crc32(&bytes[12..29]);
        bytes.extend(crc.to_be_bytes());
        bytes
    }
    #[test]
    fn complete_index_uses_png_dimensions_and_retained_font_slots() {
        let mut cache = HashMap::new();
        let image = png(2, 3);
        let mut payload = b"skiapict-padding".to_vec();
        let start = payload.len();
        payload.extend(&image);
        let font = payload.len();
        payload.extend([5; 32]);
        let record = json!({"assetRangeVersion":1,"assetRangesComplete":true,"assetRanges":[{"offset":start,"bytes":image.len(),"kind":"image"},{"offset":font,"bytes":32,"kind":"font","glyphSlots":65536}]});
        let resource = native_resource(payload, "test", &record, &mut cache).unwrap();
        let memory = resource.decode_memory.unwrap();
        assert_eq!(memory.image_bytes, 48);
        assert_eq!(memory.font_bytes, 32 * 4 + 65536 * 128 + 65536);
        let manifest: Value = serde_json::from_str(&resource.manifest).unwrap();
        assert_eq!(manifest["decodeMemory"]["imageBytes"], 48);
    }
    #[test]
    fn partial_versioned_indexes_cannot_downgrade_to_legacy() {
        for record in [
            json!({"assetRangeVersion":1,"assetRangesComplete":false,"assetRanges":[]}),
            json!({"assetRangeVersion":2,"assetRangesComplete":true,"assetRanges":[]}),
            json!({"assetRangeVersion":1,"assetRangesComplete":true}),
            json!({"assetRangesComplete":true,"assetRanges":[]}),
        ] {
            assert!(
                native_resource(
                    b"skiapict-padding".to_vec(),
                    "test",
                    &record,
                    &mut HashMap::new()
                )
                .is_err()
            );
        }
        let legacy = native_resource(
            b"skiapict-padding".to_vec(),
            "test",
            &json!({}),
            &mut HashMap::new(),
        )
        .unwrap();
        assert_eq!(legacy.decode_memory, None);
    }
    #[test]
    fn indexed_png_and_font_metadata_are_validated_before_forwarding() {
        let mut corrupt = png(2, 3);
        corrupt[16] ^= 1;
        assert!(png_memory(&corrupt).is_err());
        assert!(png_memory(&png(8193, 1)).is_err());
        assert!(png_memory(&png(0, 1)).is_err());
        for slots in [0, 65537] {
            let payload = b"skiapict-font-bytes-long-enough!!".to_vec();
            let record = json!({"assetRangeVersion":1,"assetRangesComplete":true,"assetRanges":[{"offset":8,"bytes":payload.len()-8,"kind":"font","glyphSlots":slots}]});
            assert!(native_resource(payload, "test", &record, &mut HashMap::new()).is_err());
        }
    }
}

#[cfg(test)]
mod manifest_tests {
    use super::*;
    fn synthetic_list(count:usize,id:&str)->ChunkList {
        let budget=crate::budget::Budget::new(crate::budget::DEFAULT_BYTES);
        let metadata=budget.reserve(count*(std::mem::size_of::<Arc<Chunk>>()+1)+id.len()+std::mem::size_of::<ChunkList>()+128).unwrap();
        let values=(0..count).map(|n|Arc::new(Chunk{id:format!("{n:064x}"),wire:Bytes::new(),charge:0,_metadata:budget.reserve(std::mem::size_of::<Chunk>()+64+128).unwrap()})).collect();
        let kinds=(0..count).map(|n|if n%2==0{ChunkKind::Font}else{ChunkKind::Image}).collect();
        ChunkList{values,kinds,id:id.to_owned(),_metadata:metadata}
    }
    fn legacy_json(list:&ChunkList,bytes:usize,memory:Option<DecodeMemory>)->String {
        let entries:Vec<_>=list.values.iter().zip(&list.kinds).map(|(chunk,kind)|json!({"id":chunk.id,"kind":kind.name()})).collect();
        json!({"type":"ResourceManifest","id":list.id,"bytes":bytes,"chunks":entries,"decodeMemory":memory.map(DecodeMemory::json)}).to_string()
    }
    fn legacy_resource()->(crate::budget::Budget,Resource) {
        let mut bytes=vec![11;16*1024*1024];bytes[..8].copy_from_slice(b"skiapict");
        let budget=crate::budget::Budget::new(crate::budget::DEFAULT_BYTES);let payload=budget.payload(bytes).unwrap();
        let resource=resource_with_profile(payload,"legacy-resource",&Value::Null,false,&HashMap::new(),&mut HashMap::new(),&budget).unwrap();
        (budget,resource)
    }
    #[test]
    fn borrowed_manifest_preserves_exact_schema_order_unicode_and_single_backing_layout() {
        let list=synthetic_list(512,"manifest-中文😀\"\n");
        for memory in [None,Some(DecodeMemory{image_bytes:u64::MAX,font_bytes:456})] {
            let expected=legacy_json(&list,16*1024*1024,memory);
            let budget=crate::budget::Budget::new(1024*1024);
            let(text,peak)=crate::allocation_probe::measure(||resource_manifest(&list,16*1024*1024,memory,&budget).unwrap());
            assert_eq!(text.as_str(),expected);assert_eq!(budget.used(),text.len()+128);assert!(peak<=budget.used());
            println!("asset-after-manifest: chunks=512 bytes={} requested_peak={peak} reservation={}",text.len(),budget.used());
            let alias=text.clone();let pointer=text.as_ptr();drop(text);assert_eq!(alias.as_ptr(),pointer);assert_eq!(budget.used(),expected.len()+128);drop(alias);assert_eq!(budget.used(),0);
        }
        let list=synthetic_list(0,"");let budget=crate::budget::Budget::new(1024);
        assert_eq!(resource_manifest(&list,0,None,&budget).unwrap().as_str(),legacy_json(&list,0,None));
    }
    #[test]
    fn complete_index_counting_has_no_section_allocation_and_late_failure_builds_no_chunks() {
        let mut bytes=vec![];let mut ranges=vec![];
        for _ in 0..256 {bytes.extend([3;16]);let start=bytes.len();bytes.extend([7;32]);ranges.push(json!({"offset":start,"bytes":32,"kind":"font","glyphSlots":1}));}
        let mut record=json!({"assetRangeVersion":1,"assetRangesComplete":true,"assetRanges":ranges});
        let(memory,peak)=crate::allocation_probe::measure(||native_memory(&bytes,&record).unwrap());
        assert_eq!(peak,0);assert_eq!(memory,Some(DecodeMemory{image_bytes:0,font_bytes:256*(32*4+128+65536)}));
        println!("asset-after-native-memory: ranges=256 requested_peak={peak}");
        record["assetRanges"][255]["glyphSlots"]=json!(0);
        let budget=crate::budget::Budget::new(1024*1024);let payload=budget.payload(bytes).unwrap();let mut staged=HashMap::new();
        let(result,peak)=crate::allocation_probe::measure(||staged_native_resource(payload,"late-invalid",&record,&HashMap::new(),&mut staged,&budget));
        assert!(result.err().unwrap().contains("font glyph slots"));assert!(staged.is_empty());assert_eq!(budget.used(),0);assert!(peak<256);
    }
    #[test]
    fn manifest_admission_denies_before_allocating_text_and_releases_credit() {
        let list=synthetic_list(512,"quota");let length=legacy_json(&list,16*1024*1024,None).len();
        for available in [length-1,length+127] {
            let budget=crate::budget::Budget::new(length+128);let held=budget.reserve(budget.limit()-available).unwrap();let before=budget.used();
            let(result,peak)=crate::allocation_probe::measure(||resource_manifest(&list,16*1024*1024,None,&budget));
            assert_eq!(result.err().unwrap(),crate::budget::PRESSURE);assert!(peak<1024);assert_eq!(budget.used(),before);drop(held);assert_eq!(budget.used(),0);
        }
        let budget=crate::budget::Budget::new(length+128);let text=resource_manifest(&list,16*1024*1024,None,&budget).unwrap();assert_eq!(budget.used(),budget.limit());drop(text);assert_eq!(budget.used(),0);
    }
    #[test]
    fn shared_chunk_hashes_retain_each_occurrence_kind_and_upgrade_shares_typed_owners() {
        let mut bytes=vec![3;16];bytes.extend([7;32]);bytes.extend([7;32]);bytes.extend([9;16]);
        let ranges=json!([{"offset":16,"bytes":32,"kind":"font"},{"offset":48,"bytes":32,"kind":"image"}]);
        let budget=crate::budget::Budget::new(1024*1024);let payload=budget.payload(bytes.clone()).unwrap();
        let old=resource_with_profile(payload,"kind-collision",&ranges,false,&HashMap::new(),&mut HashMap::new(),&budget).unwrap();
        assert!(Arc::ptr_eq(&old.chunks[1],&old.chunks[2]));let parsed:Value=serde_json::from_str(&old.manifest).unwrap();
        assert_eq!(parsed["chunks"].as_array().unwrap().iter().map(|entry|entry["kind"].as_str().unwrap()).collect::<Vec<_>>(),["skp","font","image","skp"]);
        assert_eq!(old.chunks.iter().flat_map(|chunk|chunk.wire[44..].iter().copied()).collect::<Vec<_>>(),bytes);
        assert_eq!(old.chunks.metadata_bytes(),old.chunks.len()*(std::mem::size_of::<Arc<Chunk>>()+1)+old.chunks.id.len()+std::mem::size_of::<ChunkList>()+128);
        let new=upgrade_memory(&old,DecodeMemory{image_bytes:8,font_bytes:128},&budget).unwrap();assert!(Arc::ptr_eq(&old.chunks,&new.chunks));assert_eq!(old.payload.as_ptr(),new.payload.as_ptr());assert_eq!(old.wire.as_ptr(),new.wire.as_ptr());
        assert_eq!(new.manifest.as_str(),legacy_json(&old.chunks,bytes.len(),new.decode_memory));assert_eq!(old.decode_memory,None);assert!(old.manifest.contains("\"decodeMemory\":null"));
        let list=old.chunks.clone();drop(old);drop(new);assert!(budget.used()>=list.metadata_bytes());drop(list);assert_eq!(budget.used(),0);
    }
    #[test]
    fn descriptor_upgrade_uses_only_new_exact_text_and_metadata_with_preallocation_denial() {
        let(budget,old)=legacy_resource();let before=budget.used();let memory=DecodeMemory{image_bytes:123,font_bytes:456};
        let(new,peak)=crate::allocation_probe::measure(||upgrade_memory(&old,memory,&budget).unwrap());let added=budget.used()-before;
        assert_eq!(new.chunks.len(),512);assert_eq!(new.manifest.len(),44672);assert_eq!(new.manifest_capacity,new.manifest.len());assert!(peak<=added);assert_eq!(added,std::mem::size_of::<Resource>()+128+new.manifest.len()+128);
        println!("asset-after-upgrade: chunks=512 bytes={} requested_peak={peak} final_added={added}",new.manifest.len());
        assert_eq!(old.decode_memory,None);assert_eq!(old.payload.as_ptr(),new.payload.as_ptr());assert!(Arc::ptr_eq(&old.chunks,&new.chunks));
        let denied=crate::budget::Budget::new(added-1);let(result,peak)=crate::allocation_probe::measure(||upgrade_memory(&old,memory,&denied));assert_eq!(result.err().unwrap(),crate::budget::PRESSURE);assert!(peak<1024);assert_eq!(denied.used(),0);
        let alias=new.manifest.clone();drop(new);assert_eq!(budget.used(),before+alias.len()+128);drop(alias);assert_eq!(budget.used(),before);drop(old);assert_eq!(budget.used(),0);
    }
    #[test]
    fn typed_id_and_kind_metadata_are_admitted_before_any_list_or_chunk_allocation() {
        let budget=crate::budget::Budget::new(1024*1024);let payload=budget.payload(vec![3;32*1024]).unwrap();let before=budget.used();let id="x".repeat(65536);
        let count=1;let metadata=count*(std::mem::size_of::<Arc<Chunk>>()+std::mem::size_of::<ChunkKind>())+id.len()+std::mem::size_of::<ChunkList>()+128;
        let hold=budget.reserve(budget.limit()-before-metadata+1).unwrap();let mut staged=HashMap::new();
        let(result,peak)=crate::allocation_probe::measure(||resource_with_profile(payload,&id,&Value::Null,false,&HashMap::new(),&mut staged,&budget));
        assert_eq!(result.err().unwrap(),crate::budget::PRESSURE);assert!(peak<1024);assert!(staged.is_empty());assert_eq!(budget.used(),budget.limit()-before-metadata+1);drop(hold);assert_eq!(budget.used(),0);
    }
}
