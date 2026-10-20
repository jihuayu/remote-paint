use crate::{budget::{Budget,Lease,OwnedVec},scene::Result};
use serde_json::{Value,json};
use std::{io::{self,Write},sync::{Arc,Mutex,OnceLock,atomic::{AtomicBool,Ordering},mpsc::{self,Receiver,SyncSender,TryRecvError}}};
use tungstenite::Utf8Bytes;

pub const PRESSURE:&str="Command queue allocation budget exceeded";
pub const LIMIT:&str="Control message budget exceeded";
pub const MAX_MESSAGE:usize=32*1024;
pub const QUEUE_MESSAGES:usize=64;
pub const QUEUE_METADATA:usize=8192;
pub const NORMAL_BYTES:usize=32*1024*1024;
pub const CLOSE_BYTES:usize=1024*1024;
#[derive(Clone)]
pub struct Pool { normal:Budget,close:Budget }
static GLOBAL:OnceLock<Pool>=OnceLock::new();
pub fn global()->&'static Pool{GLOBAL.get_or_init(||Pool::new(NORMAL_BYTES,CLOSE_BYTES))}
pub fn configure()->Result<&'static Pool>{
 let read=|name:&str,default,max|->Result<usize>{let value=match std::env::var(name){Ok(value)=>value.parse::<usize>().map_err(|_|format!("Invalid {name}"))?,Err(_)=>default};if !(64*1024..=max).contains(&value){return Err(format!("Invalid {name} range"));}Ok(value)};
 let normal=read("REMOTE_PAINT_COMMAND_QUEUE_BYTES",NORMAL_BYTES,256*1024*1024)?;
 let close=read("REMOTE_PAINT_COMMAND_CLOSE_BYTES",CLOSE_BYTES,16*1024*1024)?;
 GLOBAL.set(Pool::new(normal,close)).map_err(|_|"Command queue pool already configured")?;Ok(global())
}
// Each packet/reason owns its admitted backing through every Utf8Bytes alias.
// Tungstenite can later copy it into a separate frame/write allocation.
#[derive(Clone)]
pub enum Command { Text(Utf8Bytes),Close(Arc<Closure>) }
pub struct Closure {pub code:u16,pub reason:Utf8Bytes,_metadata:Lease}
impl Pool {
 pub fn new(normal:usize,close:usize)->Self{Self{normal:Budget::scoped(normal,PRESSURE,"outgoing-command-packets"),close:Budget::scoped(close,PRESSURE,"outgoing-command-close")}}
 pub fn encode(&self,value:&Value)->Result<Command>{
  let mut size=Size{bytes:0};serde_json::to_writer(&mut size,value).map_err(|_|LIMIT)?;
  if value["type"]=="$close"{return self.closure(value["code"].as_u64().unwrap_or(1000)as u16,value["reason"].as_str().unwrap_or("Closed")).map(Command::Close);}
  let mut output=self.normal.buffer(size.bytes)?;
  serde_json::to_writer(Exact(&mut output),value).map_err(|error|error.to_string())?;
  if output.len()!=size.bytes{return Err("Command serialization size changed".into());}
  Ok(Command::Text(utf8(output)?))
 }
 pub fn closure(&self,code:u16,reason:&str)->Result<Arc<Closure>>{
  if reason.len()>MAX_MESSAGE{return Err(LIMIT.into());}
  let metadata=self.close.reserve(std::mem::size_of::<Closure>()+128)?;
  let mut bytes=self.close.buffer(reason.len())?;bytes.extend(reason.as_bytes());
  Ok(Arc::new(Closure{code,reason:utf8(bytes)?,_metadata:metadata}))
 }
 pub fn ready(&self)->bool{self.normal.used()<=self.normal.limit()-(8*1024*1024).min(self.normal.limit()/2)}
 pub fn stats(&self)->Value{let mut normal=self.normal.stats();normal["headroom"]=(8*1024*1024).min(self.normal.limit()/2).into();normal["ready"]=self.ready().into();json!({"scope":"outgoing-command-pool","normal":normal,"close":self.close.stats(),"ready":self.ready(),"maximumMessage":MAX_MESSAGE,"normalSlots":QUEUE_MESSAGES,"mailboxReservation":QUEUE_METADATA,"closeSlot":"one priority slot per mailbox","tungsteniteCopies":"outside command owner"})}
}
fn utf8(bytes:OwnedVec)->Result<Utf8Bytes>{Utf8Bytes::try_from(bytes.finish()).map_err(|_|"Invalid command UTF8".into())}
struct Size {bytes:usize}
impl Write for Size {
 fn write(&mut self,bytes:&[u8])->io::Result<usize>{self.bytes=self.bytes.checked_add(bytes.len()).filter(|n|*n<=MAX_MESSAGE).ok_or_else(||io::Error::other(LIMIT))?;Ok(bytes.len())}
 fn flush(&mut self)->io::Result<()>{Ok(())}
}
struct Exact<'a>(&'a mut OwnedVec);
impl Write for Exact<'_>{
 fn write(&mut self,bytes:&[u8])->io::Result<usize>{if bytes.len()>self.0.capacity()-self.0.len(){return Err(io::Error::other("Command serialization size changed"));}self.0.extend(bytes);Ok(bytes.len())}
 fn flush(&mut self)->io::Result<()>{Ok(())}
}
// Queue/state backing is admitted before sync_channel allocates. Its credit
// stays with both sender and receiver; receiver/data drop before final state.
struct State {closed:AtomicBool,closing:Mutex<Option<Arc<Closure>>>,_metadata:Lease}
pub struct Mailbox {tx:SyncSender<Utf8Bytes>,rx:Mutex<Option<Receiver<Utf8Bytes>>>,state:Arc<State>}
pub struct Inbox {data:Receiver<Utf8Bytes>,state:Arc<State>}
impl Mailbox {
 pub fn new(pool:&Pool)->Result<Self>{
  let metadata=pool.normal.reserve(QUEUE_METADATA)?;let(tx,rx)=mpsc::sync_channel(QUEUE_MESSAGES);
  Ok(Self{tx,rx:Mutex::new(Some(rx)),state:Arc::new(State{closed:AtomicBool::new(false),closing:Mutex::new(None),_metadata:metadata})})
 }
 pub fn receiver(&self)->Option<Inbox>{self.rx.lock().unwrap().take().map(|data|Inbox{data,state:self.state.clone()})}
 pub fn send(&self,text:Utf8Bytes)->std::result::Result<(),()>{if self.state.closed.load(Ordering::Acquire){return Err(());}self.tx.try_send(text).map_err(|_|())}
 pub fn request_close(&self,closure:Arc<Closure>)->std::result::Result<(),()>{
  let mut closing=self.state.closing.lock().unwrap();if self.state.closed.load(Ordering::Acquire){return Err(());}
  // First accepted close wins; normal byte/count saturation cannot occupy it.
  if closing.is_none(){*closing=Some(closure);}Ok(())
 }
 pub fn close(&self){
  let receiver=self.rx.lock().unwrap().take();self.state.closed.store(true,Ordering::Release);
  if receiver.is_some(){self.state.closing.lock().unwrap().take();}
  // An active inbox keeps its close reason and queued owners until its real
  // consumer stops. An unattached receiver drops every queued packet now.
  drop(receiver);
 }
}
impl Drop for Mailbox{fn drop(&mut self){self.close();}}
impl Inbox {
 pub fn close_command(&self)->Option<Arc<Closure>>{self.state.closing.lock().unwrap().take()}
 pub fn try_recv(&self)->std::result::Result<Command,TryRecvError>{
  if let Some(closure)=self.close_command(){return Ok(Command::Close(closure));}
  if self.state.closed.load(Ordering::Acquire){return Err(TryRecvError::Disconnected);}
  self.data.try_recv().map(Command::Text)
 }
}
impl Drop for Inbox {
 fn drop(&mut self){self.state.closed.store(true,Ordering::Release);self.state.closing.lock().unwrap().take();}
}

#[cfg(test)]mod tests {
 use super::*;
 use std::{io::{Cursor,Read},sync::Barrier};
 use tungstenite::{Message,WebSocket,protocol::Role};
 fn text(command:Command)->Utf8Bytes{match command{Command::Text(text)=>text,Command::Close(_)=>panic!("Expected normal command")}}
 fn closure(command:Command)->Arc<Closure>{match command{Command::Close(close)=>close,Command::Text(_)=>panic!("Expected close")}}
 #[test]fn borrowed_encoding_has_one_exact_backing_without_a_queued_value_graph(){
  let pool=Pool::new(NORMAL_BYTES,CLOSE_BYTES);let source=json!({"type":"Fixture","array":vec![0u8;4000]});let expected=source.to_string();let pointer=source["array"].as_array().unwrap().as_ptr();
  let(command,peak)=crate::allocation_probe::measure(||pool.encode(&source).unwrap());let bytes=text(command);assert_eq!(bytes.as_str(),expected);assert_eq!(source["array"].as_array().unwrap().as_ptr(),pointer);assert_eq!(pool.normal.used(),bytes.len()+128);assert!(peak<=pool.normal.used());
  println!("command-queue-after-layout: wire_bytes={} requested_peak={peak} reservation={}",bytes.len(),pool.normal.used());let alias=bytes.clone();let pointer=bytes.as_ptr();drop(bytes);assert_eq!(alias.as_ptr(),pointer);assert_eq!(pool.normal.used(),expected.len()+128);drop(alias);assert_eq!(pool.normal.used(),0);
  for value in [Value::Null,json!(true),json!([1,-2,1.25,null]),json!({"type":"unknown","unicode":"中文😀\u{0}\\\"\n","nested":[{"a":true}],"n":u64::MAX})]{let expected=value.to_string();let encoded=text(pool.encode(&value).unwrap());assert_eq!(encoded.as_str(),expected);drop(encoded);assert_eq!(pool.normal.used(),0);}
 }
 #[test]fn size_and_byte_denials_happen_before_packet_allocation_and_close_keeps_old_defaults(){
  let source=json!("x".repeat(MAX_MESSAGE-2));let pool=Pool::new(NORMAL_BYTES,CLOSE_BYTES);let bytes=text(pool.encode(&source).unwrap());assert_eq!(bytes.len(),MAX_MESSAGE);drop(bytes);
  let small=Pool::new(MAX_MESSAGE+127,CLOSE_BYTES);let(result,peak)=crate::allocation_probe::measure(||small.encode(&source));assert_eq!(result.err().unwrap(),PRESSURE);assert!(peak<4096);assert_eq!(small.normal.used(),0);
  let oversized=json!("x".repeat(MAX_MESSAGE));let(result,peak)=crate::allocation_probe::measure(||pool.encode(&oversized));assert_eq!(result.err().unwrap(),LIMIT);assert!(peak<4096);assert_eq!(pool.normal.used(),0);
  assert_eq!(pool.encode(&json!({"type":"$close","extra":"x".repeat(MAX_MESSAGE)})).err().unwrap(),LIMIT);assert_eq!(pool.close.used(),0);
  for(code,reason,expected_code,expected_reason)in [(json!(-1),json!(7),1000,"Closed"),(json!(65537),json!("reason中文😀"),1,"reason中文😀")]{let packet=closure(pool.encode(&json!({"type":"$close","code":code,"reason":reason,"ignored":[1,2]})).unwrap());assert_eq!(packet.code,expected_code);assert_eq!(packet.reason.as_str(),expected_reason);drop(packet);assert_eq!(pool.close.used(),0);}
 }
 #[test]fn full_count_queue_keeps_a_separate_first_close_slot(){
  let pool=Pool::new(NORMAL_BYTES,CLOSE_BYTES);let queue=Mailbox::new(&pool).unwrap();let value=json!({"type":"Fixture"});for _ in 0..QUEUE_MESSAGES{queue.send(text(pool.encode(&value).unwrap())).unwrap();}let before=pool.normal.used();assert!(queue.send(text(pool.encode(&value).unwrap())).is_err());assert_eq!(pool.normal.used(),before);
  let first=pool.closure(1001,"first").unwrap();let pointer=Arc::as_ptr(&first);queue.request_close(first).unwrap();let held=pool.close.used();queue.request_close(pool.closure(1008,"second").unwrap()).unwrap();assert_eq!(pool.close.used(),held);
  let inbox=queue.receiver().unwrap();let received=closure(inbox.try_recv().unwrap());assert_eq!(Arc::as_ptr(&received),pointer);assert_eq!(received.code,1001);assert_eq!(pool.normal.used(),before);drop(received);assert_eq!(pool.close.used(),0);drop(inbox);assert_eq!(pool.normal.used(),QUEUE_METADATA);drop(queue);assert_eq!(pool.normal.used(),0);
 }
 #[test]fn normal_byte_saturation_does_not_consume_close_credit(){
  let source=json!("x".repeat(MAX_MESSAGE-2));let pool=Pool::new(QUEUE_METADATA+MAX_MESSAGE+128,CLOSE_BYTES);let queue=Mailbox::new(&pool).unwrap();queue.send(text(pool.encode(&source).unwrap())).unwrap();assert_eq!(pool.normal.used(),pool.normal.limit());assert_eq!(pool.encode(&json!(true)).err().unwrap(),PRESSURE);
  queue.request_close(pool.closure(1001,"byte full close").unwrap()).unwrap();let inbox=queue.receiver().unwrap();let close=closure(inbox.try_recv().unwrap());assert_eq!(close.code,1001);drop(close);drop(inbox);drop(queue);assert_eq!(pool.normal.used(),0);assert_eq!(pool.close.used(),0);
 }
 #[test]fn close_releases_unattached_payloads_but_active_receiver_and_aliases_keep_real_owners(){
  let pool=Pool::new(NORMAL_BYTES,CLOSE_BYTES);let queue=Mailbox::new(&pool).unwrap();queue.send(text(pool.encode(&json!("x".repeat(8192))).unwrap())).unwrap();queue.request_close(pool.closure(1001,"close").unwrap()).unwrap();queue.close();queue.close();assert_eq!(pool.normal.used(),QUEUE_METADATA);assert_eq!(pool.close.used(),0);assert!(queue.receiver().is_none());assert!(queue.send(text(pool.encode(&json!(true)).unwrap())).is_err());assert_eq!(pool.normal.used(),QUEUE_METADATA);drop(queue);assert_eq!(pool.normal.used(),0);
  let queue=Mailbox::new(&pool).unwrap();let inbox=queue.receiver().unwrap();queue.send(text(pool.encode(&json!("held")).unwrap())).unwrap();let before=pool.normal.used();queue.request_close(pool.closure(1008,"active").unwrap()).unwrap();queue.close();assert_eq!(pool.normal.used(),before);let close=inbox.close_command().unwrap();assert_eq!(close.code,1008);drop(close);assert_eq!(pool.close.used(),0);drop(inbox);assert_eq!(pool.normal.used(),QUEUE_METADATA);drop(queue);assert_eq!(pool.normal.used(),0);
  let queue=Mailbox::new(&pool).unwrap();let inbox=queue.receiver().unwrap();queue.send(text(pool.encode(&json!("alias")).unwrap())).unwrap();let alias=text(inbox.try_recv().unwrap());drop(queue);drop(inbox);assert_eq!(pool.normal.used(),alias.len()+128);drop(alias);assert_eq!(pool.normal.used(),0);
 }
 #[test]fn paired_close_slots_share_one_reason_and_final_utf8_alias_retains_its_credit(){
  let pool=Pool::new(NORMAL_BYTES,CLOSE_BYTES);let a=Mailbox::new(&pool).unwrap();let b=Mailbox::new(&pool).unwrap();let close=pool.closure(1001,"shared中文😀").unwrap();let before=pool.close.used();a.request_close(close.clone()).unwrap();b.request_close(close.clone()).unwrap();drop(close);
  let ai=a.receiver().unwrap();let bi=b.receiver().unwrap();let first=closure(ai.try_recv().unwrap());let second=closure(bi.try_recv().unwrap());assert!(Arc::ptr_eq(&first,&second));assert_eq!(pool.close.used(),before);let reason=second.reason.clone();drop(first);assert_eq!(pool.close.used(),before);drop(second);assert_eq!(pool.close.used(),reason.len()+128);drop(reason);assert_eq!(pool.close.used(),0);drop(ai);drop(bi);drop(a);drop(b);assert_eq!(pool.normal.used(),0);
 }
 #[test]fn fixed_mailbox_backing_is_admitted_and_survives_until_both_ends_drop(){
  let pool=Pool::new(NORMAL_BYTES,CLOSE_BYTES);let(queue,peak)=crate::allocation_probe::measure(||Mailbox::new(&pool).unwrap());assert_eq!(pool.normal.used(),QUEUE_METADATA);assert!(peak<=QUEUE_METADATA);println!("command-mailbox-layout: requested_peak={peak} reservation={QUEUE_METADATA}");let inbox=queue.receiver().unwrap();drop(queue);assert_eq!(pool.normal.used(),QUEUE_METADATA);drop(inbox);assert_eq!(pool.normal.used(),0);
  let small=Pool::new(QUEUE_METADATA-1,CLOSE_BYTES);let(result,peak)=crate::allocation_probe::measure(||Mailbox::new(&small));assert_eq!(result.err().unwrap(),PRESSURE);assert!(peak<4096);assert_eq!(small.normal.used(),0);
  let source=Arc::new(json!("x".repeat(1024)));let charge=source.to_string().len()+128;let pool=Pool::new(2*charge,CLOSE_BYTES);let barrier=Arc::new(Barrier::new(9));let mut jobs=vec![];for _ in 0..8{let source=source.clone();let pool=pool.clone();let barrier=barrier.clone();jobs.push(std::thread::spawn(move||{barrier.wait();pool.encode(&source).ok()}));}barrier.wait();let pins:Vec<_>=jobs.into_iter().filter_map(|job|job.join().unwrap()).collect();assert_eq!(pins.len(),2);assert_eq!(pool.normal.used(),2*charge);let close=pool.closure(1001,"independent").unwrap();drop(close);drop(pins);assert_eq!(pool.normal.used(),0);assert_eq!(pool.close.used(),0);
 }
 struct Gate {blocked:bool,bytes:Vec<u8>}
 impl Read for Gate{fn read(&mut self,_:&mut[u8])->io::Result<usize>{Err(io::ErrorKind::WouldBlock.into())}}
 impl Write for Gate{fn write(&mut self,bytes:&[u8])->io::Result<usize>{if self.blocked{return Err(io::ErrorKind::WouldBlock.into());}self.bytes.extend_from_slice(bytes);Ok(bytes.len())}fn flush(&mut self)->io::Result<()>{Ok(())}}
 #[test]fn tungstenite_write_copy_is_separate_from_the_original_command_owner(){
  let pool=Pool::new(NORMAL_BYTES,CLOSE_BYTES);let source=json!({"type":"Fixture","text":"x".repeat(8192)});let bytes=text(pool.encode(&source).unwrap());let mut ws=WebSocket::from_raw_socket(Gate{blocked:true,bytes:vec![]},Role::Server,Some(tungstenite::protocol::WebSocketConfig::default().write_buffer_size(0)));let error=ws.write(Message::Text(bytes)).err().unwrap();assert!(matches!(error,tungstenite::Error::Io(error)if error.kind()==io::ErrorKind::WouldBlock));assert_eq!(pool.normal.used(),0);assert!(ws.get_ref().bytes.is_empty());
  ws.get_mut().blocked=false;ws.flush().unwrap();let wire=ws.into_inner().bytes;let mut reader=WebSocket::from_raw_socket(Cursor::new(wire),Role::Client,None);let Message::Text(text)=reader.read().unwrap()else{panic!("Expected copied text frame")};assert_eq!(serde_json::from_str::<Value>(&text).unwrap(),source);
 }
}
