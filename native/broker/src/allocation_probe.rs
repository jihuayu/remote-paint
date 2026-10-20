// Test-only requested-layout probe; allocator usable size/RSS remain outside
// this observation. Realloc counts overlapping old/new layouts conservatively.
use std::{alloc::{GlobalAlloc,Layout,System},cell::Cell};
thread_local! {static TRACK:Cell<(bool,usize,usize)>=const{Cell::new((false,0,0))};}
struct Probe;
fn added(old:usize,new:usize){let _=TRACK.try_with(|state|{let(enabled,used,peak)=state.get();if enabled{state.set((true,used.saturating_sub(old)+new,peak.max(used+new)));}});}
fn removed(bytes:usize){let _=TRACK.try_with(|state|{let(enabled,used,peak)=state.get();if enabled{state.set((true,used.saturating_sub(bytes),peak));}});}
unsafe impl GlobalAlloc for Probe {
    unsafe fn alloc(&self,layout:Layout)->*mut u8{let ptr=unsafe{System.alloc(layout)};if !ptr.is_null(){added(0,layout.size());}ptr}
    unsafe fn alloc_zeroed(&self,layout:Layout)->*mut u8{let ptr=unsafe{System.alloc_zeroed(layout)};if !ptr.is_null(){added(0,layout.size());}ptr}
    unsafe fn dealloc(&self,ptr:*mut u8,layout:Layout){removed(layout.size());unsafe{System.dealloc(ptr,layout)}}
    unsafe fn realloc(&self,ptr:*mut u8,layout:Layout,new:usize)->*mut u8{let ptr=unsafe{System.realloc(ptr,layout,new)};if !ptr.is_null(){added(layout.size(),new);}ptr}
}
#[global_allocator]static ALLOCATOR:Probe=Probe;
pub fn measure<T>(run:impl FnOnce()->T)->(T,usize){TRACK.with(|state|state.set((true,0,0)));let value=run();let peak=TRACK.with(|state|{let(_,_,peak)=state.get();state.set((false,0,0));peak});(value,peak)}

// Observe live requested layouts as well as conservative realloc overlap.
// The measured closure must not free allocations created before observation.
pub fn observe<T>(run:impl FnOnce()->T)->(T,usize,usize){TRACK.with(|state|state.set((true,0,0)));let value=run();let(live,peak)=TRACK.with(|state|{let(_,live,peak)=state.get();state.set((false,0,0));(live,peak)});(value,live,peak)}
