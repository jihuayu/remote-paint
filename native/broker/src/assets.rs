use crate::scene::{Resource, Result};
use bytes::Bytes;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
};
pub struct Chunk {
    pub id: String,
    pub wire: Bytes,
}
pub fn resource(
    payload: Vec<u8>,
    id: &str,
    ranges: &Value,
    cache: &mut HashMap<String, Weak<Chunk>>,
) -> Result<Resource> {
    let mut sections = vec![];
    let mut offset = 0;
    if let Some(ranges) = ranges.as_array() {
        if ranges.len() > 256 {
            return Err("Asset range limit".into());
        }
        for range in ranges {
            let start = range["offset"].as_u64().ok_or("Invalid asset offset")? as usize;
            let size = range["bytes"].as_u64().ok_or("Invalid asset size")? as usize;
            let kind = range["kind"]
                .as_str()
                .filter(|k| matches!(*k, "font" | "image"))
                .ok_or("Invalid asset kind")?;
            if start < offset
                || size < 16
                || start
                    .checked_add(size)
                    .is_none_or(|end| end > payload.len())
            {
                return Err("Invalid or overlapping asset range".into());
            }
            if start > offset {
                sections.push((offset, start, "skp"));
            }
            sections.push((start, start + size, kind));
            offset = start + size;
        }
    }
    if offset < payload.len() {
        sections.push((offset, payload.len(), "skp"));
    }
    let mut chunks = vec![];
    let mut entries = vec![];
    for (start, end, kind) in sections {
        let size = if kind == "skp" {
            32 * 1024
        } else {
            end - start
        };
        for part in payload[start..end].chunks(size) {
            let digest = Sha256::digest(part);
            let hash = format!("{:x}", digest);
            let chunk = cache
                .get(&hash)
                .and_then(|entry| entry.upgrade())
                .unwrap_or_else(|| {
                    let mut wire = b"RPNT\x01\x02\0\0".to_vec();
                    wire.extend((part.len() as u32).to_be_bytes());
                    wire.extend(digest);
                    wire.extend(part);
                    let chunk = Arc::new(Chunk {
                        id: hash.clone(),
                        wire: Bytes::from(wire),
                    });
                    cache.insert(hash, Arc::downgrade(&chunk));
                    chunk
                });
            entries.push(json!({"id":chunk.id,"kind":kind}));
            chunks.push(chunk);
        }
    }
    if cache.len() > 8192 {
        cache.retain(|_, v| v.strong_count() > 0);
    }
    let manifest =
        json!({"type":"ResourceManifest","id":id,"bytes":payload.len(),"chunks":entries})
            .to_string();
    let mut wire = b"RPNT\x01\x01\0\0".to_vec();
    wire.extend((payload.len() as u32).to_be_bytes());
    wire.extend(Sha256::digest(&payload));
    wire.extend(&payload);
    Ok(Resource {
        payload: Bytes::from(payload),
        wire: Bytes::from(wire),
        chunks: Arc::new(chunks),
        manifest,
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
