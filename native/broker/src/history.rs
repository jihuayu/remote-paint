use crate::scene::Snapshot;
use std::{collections::{BTreeMap,VecDeque},sync::Arc};

#[derive(Default)]
pub struct History {
    pub latest: Option<Arc<Snapshot>>,
    snapshots: BTreeMap<u64,Arc<Snapshot>>,
    retired: VecDeque<u64>,
}
impl History {
    pub fn insert(&mut self,snapshot:Arc<Snapshot>) {
        self.snapshots.insert(snapshot.serial,snapshot.clone());
        self.latest=Some(snapshot);
        while self.snapshots.len()>4 {self.snapshots.pop_first();}
    }
    pub fn clear(&mut self) {self.snapshots.clear();self.latest=None;self.retired.clear();}
    pub fn reclaim(&mut self)->usize {
        let latest=self.latest.as_ref().map(|snapshot|snapshot.serial);
        let old:Vec<_>=self.snapshots.keys().copied().filter(|serial|Some(*serial)!=latest).collect();
        for serial in &old {
            self.snapshots.remove(serial);
            self.retired.push_back(*serial);
            if self.retired.len()>256 {self.retired.pop_front();}
        }
        old.len()
    }
    // A pressure-retired, superseded request has a receipt, but must never
    // publish a later map before Source validates its epoch/viewport fence.
    pub fn publication(&self,serial:u64)->Result<Option<Arc<Snapshot>>,String> {
        if let Some(snapshot)=self.snapshots.get(&serial) {return Ok(Some(snapshot.clone()));}
        if self.retired.contains(&serial) {return Ok(None);}
        Err("Stale native snapshot".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn snapshot(serial:u64)->Arc<Snapshot>{Arc::new(Snapshot{serial,scene:json!({}),resources:Default::default(),metadata:json!({}),full_json:String::new(),_graph:crate::snapshot_memory::SnapshotPool::new(1024).0.reserve(1024).unwrap()})}
    #[test]fn pressure_retires_history_without_replacing_a_peer_pin_or_publishing_a_newer_frame(){
        let mut history=History::default();let peer=snapshot(1);let weak=Arc::downgrade(&peer);history.insert(peer.clone());history.insert(snapshot(2));history.insert(snapshot(3));
        assert_eq!(history.reclaim(),2);assert!(history.publication(1).unwrap().is_none());assert!(history.publication(2).unwrap().is_none());assert_eq!(history.publication(3).unwrap().unwrap().serial,3);assert!(history.publication(99).is_err());
        assert!(weak.upgrade().is_some());drop(peer);assert!(weak.upgrade().is_none());history.clear();assert!(history.publication(1).is_err());assert!(history.latest.is_none());
    }
    #[test]fn retired_receipts_are_bounded_and_normal_history_eviction_stays_stale(){
        let mut history=History::default();for serial in 1..=5 {history.insert(snapshot(serial));}assert!(history.publication(1).is_err());
        for serial in 6..=310 {history.reclaim();history.insert(snapshot(serial));}assert_eq!(history.retired.len(),256);assert!(history.publication(2).is_err());assert!(history.publication(309).unwrap().is_some());
    }
}
