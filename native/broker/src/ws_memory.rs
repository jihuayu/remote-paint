use crate::{budget::{Budget,Lease},scene::Result};
use bytes::Bytes;
use serde_json::Value;
use std::{fmt,io,sync::OnceLock};
use tungstenite::{Message,WebSocket,Utf8Bytes,protocol::WebSocketConfig};

pub const PRESSURE:&str="WebSocket backing allocation budget exceeded";
pub const DEFAULT_BYTES:usize=512*1024*1024;
pub const FIXED_BYTES:usize=2*1024*1024;
pub const MESSAGE_BYTES:usize=2*1024*1024;
pub const READ_BYTES:usize=128*1024;
pub const MAX_INPUT:usize=32*1024;
pub const DATA_WRITE:usize=16*1024*1024+64*1024;
pub const CONTROL_WRITE:usize=128*1024;
const WRITE_FACTOR:usize=3;
#[derive(Clone)]
pub struct Pool(Budget);
#[derive(Clone,Copy)]pub enum Kind{Data,Control}
impl Kind{fn write_limit(self)->usize{match self{Self::Data=>DATA_WRITE,Self::Control=>CONTROL_WRITE}}}
static GLOBAL:OnceLock<Pool>=OnceLock::new();
pub fn global()->&'static Pool{GLOBAL.get_or_init(||Pool::new(DEFAULT_BYTES))}
pub fn configure()->Result<&'static Pool>{
 let bytes=match std::env::var("REMOTE_PAINT_WEBSOCKET_BACKING_BYTES"){Ok(value)=>value.parse::<usize>().map_err(|_|"Invalid REMOTE_PAINT_WEBSOCKET_BACKING_BYTES")?,Err(_)=>DEFAULT_BYTES};
 if !(8*1024*1024..=2*1024*1024*1024).contains(&bytes){return Err("WebSocket backing pool must be 8MiB..2GiB".into());}
 GLOBAL.set(Pool::new(bytes)).map_err(|_|"WebSocket backing pool already configured")?;Ok(global())
}
pub fn config()->WebSocketConfig{WebSocketConfig::default().read_buffer_size(READ_BYTES).max_message_size(Some(MAX_INPUT)).max_frame_size(Some(MAX_INPUT)).write_buffer_size(0).max_write_buffer_size(DATA_WRITE)}
// Fixed HTTP/read backing is admitted before the handshake;role write backing
// before the codec can write. Keep the larger data reserve after negotiation:
// changing a length cap does not shrink an already allocated Vec capacity.
pub struct Connection {write:Option<Lease>,kind:Option<Kind>,pool:Pool,_fixed:Lease}
impl Pool{
 pub fn new(bytes:usize)->Self{Self(Budget::scoped(bytes,PRESSURE,"websocket-library-backing-pool"))}
 pub fn connection(&self)->Result<Connection>{Ok(Connection{write:None,kind:None,pool:self.clone(),_fixed:self.0.reserve(FIXED_BYTES)?})}
 fn headroom(&self)->usize{(128*1024*1024).min(self.0.limit()/2)}
 pub fn ready(&self)->bool{self.0.used()<=self.0.limit()-self.headroom()}
 pub fn stats(&self)->Value{
  let mut stats=self.0.stats();stats["headroom"]=self.headroom().into();stats["ready"]=self.ready().into();stats["fixedConnectionBytes"]=FIXED_BYTES.into();stats["rawMessageBytes"]=MESSAGE_BYTES.into();stats["writeFactor"]=WRITE_FACTOR.into();stats["dataWriteLimit"]=DATA_WRITE.into();stats["controlWriteLimit"]=CONTROL_WRITE.into();stats["scopeNote"]="library requested-capacity allowance;OS/kernel/thread stacks/allocator/RSS outside".into();stats
 }
}
impl Connection{
 pub fn role(&mut self,kind:Kind)->Result<()>{if self.write.is_some(){return Err("WebSocket role already admitted".into());}self.write=Some(self.pool.0.reserve(kind.write_limit()*WRITE_FACTOR)?);self.kind=Some(kind);Ok(())}
}
// Field order frees the actual codec/retained write capacity before its lease.
// Received raw payloads get a separate owner so their aliases can outlive it.
pub struct Socket<S>{ws:WebSocket<S>,connection:Connection}
impl<S:io::Read+io::Write> Socket<S>{
 pub fn new(mut ws:WebSocket<S>,connection:Connection)->Self{
  let kind=connection.kind.expect("WebSocket role must be admitted");let config=ws.get_config();
  assert!(config.max_message_size==Some(MAX_INPUT)&&config.max_frame_size==Some(MAX_INPUT)&&config.read_buffer_size==READ_BYTES&&config.write_buffer_size==0,"WebSocket config must match admitted bounds");
  ws.set_config(|config|config.max_write_buffer_size=kind.write_limit());Self{ws,connection}
 }
 pub fn get_mut(&mut self)->&mut S{self.ws.get_mut()}
 #[cfg(test)]pub fn get_ref(&self)->&S{self.ws.get_ref()}
 pub fn set_write_limit(&mut self,limit:usize)->Result<()>{
  if limit==0||limit>self.connection.kind.unwrap().write_limit(){return Err("WebSocket write limit exceeds admitted role".into());}
  self.ws.set_config(|config|config.max_write_buffer_size=limit);Ok(())
 }
 pub fn write(&mut self,message:Message)->tungstenite::Result<()>{self.ws.write(message)}
 pub fn send(&mut self,message:Message)->tungstenite::Result<()>{self.ws.send(message)}
 pub fn flush(&mut self)->tungstenite::Result<()>{self.ws.flush()}
 pub fn close(&mut self,frame:Option<tungstenite::protocol::CloseFrame>)->tungstenite::Result<()>{self.ws.close(frame)}
 // Close-handshake draining never returns a raw payload to another owner.
 // The fixed allowance remains while these ephemeral messages are discarded.
 pub fn discard_read(&mut self)->tungstenite::Result<()>{self.ws.read().map(drop)}
 #[cfg(test)]pub fn into_inner(self)->S{let Self{ws,connection}=self;let stream=ws.into_inner();drop(connection);stream}
}
struct RawPayload{bytes:Bytes,_lease:Lease}
impl AsRef<[u8]> for RawPayload{fn as_ref(&self)->&[u8]{&self.bytes}}
#[derive(Debug)]struct ReadPressure;
impl fmt::Display for ReadPressure{fn fmt(&self,out:&mut fmt::Formatter<'_>)->fmt::Result{out.write_str(PRESSURE)}}
impl std::error::Error for ReadPressure{}
pub fn is_pressure(error:&tungstenite::Error)->bool{matches!(error,tungstenite::Error::Io(error)if error.get_ref().is_some_and(|error|error.is::<ReadPressure>()))}
fn raw(bytes:Bytes,lease:Lease)->Bytes{Bytes::from_owner(RawPayload{bytes,_lease:lease})}
fn text(bytes:Bytes,lease:Lease)->Utf8Bytes{Utf8Bytes::try_from(raw(bytes,lease)).expect("Tungstenite returned validated UTF8")}
impl<S:io::Read+io::Write> Socket<S>{
 pub fn read(&mut self)->tungstenite::Result<Message>{
  // Reserve before calling into opaque frame/fragment parsing. A final Bytes
  // owner carries this allowance through every Message clone/slice after the
  // socket has gone;no raw payload is detached from its accounting.
  let lease=self.connection.pool.0.reserve(MESSAGE_BYTES).map_err(|_|tungstenite::Error::Io(io::Error::other(ReadPressure)))?;
  Ok(match self.ws.read()?{
   Message::Text(value)=>Message::Text(text(value.into(),lease)),
   Message::Binary(value)=>Message::Binary(raw(value,lease)),
   Message::Ping(value)=>Message::Ping(raw(value,lease)),
   Message::Pong(value)=>Message::Pong(raw(value,lease)),
   Message::Close(Some(mut frame))=>{frame.reason=text(frame.reason.into(),lease);Message::Close(Some(frame))},
   Message::Close(None)=>Message::Close(None),
   Message::Frame(_)=>return Err(tungstenite::Error::Io(io::Error::other("Unexpected raw WebSocket frame"))),
  })
 }
}

#[cfg(test)]mod tests{
 use super::*;
 use std::io::{Read,Write};
 use tungstenite::{accept_hdr_with_config,protocol::{Role,frame::{Frame,coding::{OpCode,Data}}}};
 struct Gate<'a>{input:&'a[u8],position:usize,chunk:usize,blocked:bool,broken:bool,written:usize,reads:usize}
 impl<'a>Gate<'a>{fn new(input:&'a[u8],chunk:usize)->Self{Self{input,position:0,chunk,blocked:false,broken:false,written:0,reads:0}}}
 impl Read for Gate<'_>{fn read(&mut self,out:&mut[u8])->io::Result<usize>{self.reads+=1;let n=out.len().min(self.chunk).min(self.input.len()-self.position);out[..n].copy_from_slice(&self.input[self.position..self.position+n]);self.position+=n;Ok(n)}}
 impl Write for Gate<'_>{fn write(&mut self,bytes:&[u8])->io::Result<usize>{if self.broken{return Err(io::ErrorKind::BrokenPipe.into());}if self.blocked{return Err(io::ErrorKind::WouldBlock.into());}self.written+=bytes.len();Ok(bytes.len())}fn flush(&mut self)->io::Result<()>{Ok(())}}
 fn header(padding:usize,extra:usize)->Vec<u8>{let mut request=format!("GET /stream?key=fixture HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://localhost\r\nX-Padding: {}\r\n","x".repeat(padding));for n in 0..extra{request.push_str(&format!("X-{n}: value\r\n"));}request.push_str("\r\n");request.into_bytes()}
 fn frame(out:&mut Vec<u8>,payload:&[u8],opcode:OpCode,final_:bool){let mut frame=Frame::message(Bytes::copy_from_slice(payload),opcode,final_);frame.header_mut().mask=Some([17,29,41,53]);frame.format(out).unwrap();}
 fn wire(text:&str,fragment:usize,ping:bool)->Vec<u8>{let mut out=vec![];let parts:Vec<_>=text.as_bytes().chunks(fragment).collect();for(n,part)in parts.iter().enumerate(){frame(&mut out,part,OpCode::Data(if n==0{Data::Text}else{Data::Continue}),n+1==parts.len());if ping&&n+1<parts.len(){frame(&mut out,b"ping",OpCode::Control(tungstenite::protocol::frame::coding::Control::Ping),true);}}out}
 fn admission(pool:&Pool,kind:Kind)->Connection{let mut connection=pool.connection().unwrap();connection.role(kind).unwrap();connection}
 #[test]fn fixed_role_and_raw_message_quota_denials_precede_library_side_effects(){
  let pool=Pool::new(FIXED_BYTES-1);let(result,peak)=crate::allocation_probe::measure(||pool.connection());assert_eq!(result.err().unwrap(),PRESSURE);assert!(peak<4096);assert_eq!(pool.0.used(),0);
  let pool=Pool::new(FIXED_BYTES+3*CONTROL_WRITE-1);let mut connection=pool.connection().unwrap();let(result,peak)=crate::allocation_probe::measure(||connection.role(Kind::Control));assert_eq!(result.err().unwrap(),PRESSURE);assert!(peak<4096);assert_eq!(pool.0.used(),FIXED_BYTES);drop(connection);assert_eq!(pool.0.used(),0);
  let pool=Pool::new(FIXED_BYTES+3*CONTROL_WRITE+MESSAGE_BYTES-1);let connection=admission(&pool,Kind::Control);let input=wire("message",32,false);let mut socket=Socket::new(WebSocket::from_raw_socket(Gate::new(&input,128),Role::Server,Some(config())),connection);let before=pool.0.used();let(result,peak)=crate::allocation_probe::measure(||socket.read());assert!(is_pressure(&result.err().unwrap()));assert!(peak<4096);assert_eq!(socket.get_ref().reads,0);assert_eq!(pool.0.used(),before);drop(socket);assert_eq!(pool.0.used(),0);
 }
 #[test]fn actual_http_handshake_layouts_fit_fixed_credit_including_maximum_headers(){
  let base=header(0,0).len();let cases=[("small",header(0,0),4096),("max-bytes",header(65536-base,0),4096),("fragmented",header(64000,0),256),("124-headers",header(50000,117),4096)];
  for(name,request,chunk)in cases{assert!(request.len()<=65536);let pool=Pool::new(DEFAULT_BYTES);let mut connection=pool.connection().unwrap();let(socket,live,peak)=crate::allocation_probe::observe(||{let ws=accept_hdr_with_config(Gate::new(&request,chunk),|_:&tungstenite::handshake::server::Request,response|{connection.role(Kind::Data).unwrap();Ok(response)},Some(config())).unwrap();Socket::new(ws,connection)});assert!(peak<=FIXED_BYTES,"{name}: {peak}");assert!(live>0);assert!(pool.0.used()>=FIXED_BYTES+3*DATA_WRITE);println!("ws-backing-handshake {name}: bytes={} live={live} requested_peak={peak} fixed={FIXED_BYTES}",request.len());drop(socket);assert_eq!(pool.0.used(),0);}
 }
 #[test]fn masked_fragmented_utf8_and_control_payload_aliases_keep_final_raw_credit(){
  let text="中文😀".repeat(3000);for(fragment,chunk,ping)in [(32768,131072,false),(1,1,false),(31,256,true)]{let input=wire(&text,fragment,ping);let pool=Pool::new(DEFAULT_BYTES);let connection=admission(&pool,Kind::Control);let((socket,message),live,peak)=crate::allocation_probe::observe(||{let mut socket=Socket::new(WebSocket::from_raw_socket(Gate::new(&input,chunk),Role::Server,Some(config())),connection);loop{let message=socket.read().unwrap();if matches!(message,Message::Text(_)){break(socket,message);}assert!(matches!(message,Message::Ping(_)));}});assert_eq!(message.to_text().unwrap(),text);assert!(peak<=FIXED_BYTES);let alias=message.clone();drop(message);drop(socket);assert_eq!(pool.0.used(),MESSAGE_BYTES);assert_eq!(alias.to_text().unwrap(),text);drop(alias);assert_eq!(pool.0.used(),0);println!("ws-backing-read: fragment={fragment} chunk={chunk} ping={ping} live={live} requested_peak={peak} fixed={FIXED_BYTES} raw_owner={MESSAGE_BYTES}");}
  for(opcode,payload)in [(OpCode::Data(Data::Binary),vec![11;MAX_INPUT]),(OpCode::Control(tungstenite::protocol::frame::coding::Control::Ping),vec![17;125]),(OpCode::Control(tungstenite::protocol::frame::coding::Control::Pong),vec![29;125]),(OpCode::Control(tungstenite::protocol::frame::coding::Control::Close),[1000u16.to_be_bytes().as_slice(),b"reason"].concat())]{let mut input=vec![];frame(&mut input,&payload,opcode,true);let pool=Pool::new(DEFAULT_BYTES);let connection=admission(&pool,Kind::Control);let mut socket=Socket::new(WebSocket::from_raw_socket(Gate::new(&input,131072),Role::Server,Some(config())),connection);let message=socket.read().unwrap();let alias=message.clone();drop(message);drop(socket);assert_eq!(pool.0.used(),MESSAGE_BYTES);drop(alias);assert_eq!(pool.0.used(),0);}
 }
 #[test]fn write_growth_blocking_and_postflush_capacity_remain_admitted_until_socket_drop(){
  for(kind,name)in [(Kind::Data,"data"),(Kind::Control,"control")]{let limit=kind.write_limit();let sizes=[32768,limit/2+44,limit-10];let payloads:Vec<_>=sizes.into_iter().map(|n|{let bytes=Bytes::from(vec![11;n]);drop(bytes.clone());bytes}).collect();let pool=Pool::new(DEFAULT_BYTES);let connection=admission(&pool,kind);let reserved=pool.0.used();let(socket,live,peak)=crate::allocation_probe::observe(||{let mut socket=Socket::new(WebSocket::from_raw_socket(Gate::new(&[],4096),Role::Server,Some(config())),connection);for payload in &payloads{socket.write(Message::Binary(payload.clone())).unwrap();socket.flush().unwrap();}socket});assert!(peak<=reserved);assert!(live>=limit-10);assert_eq!(pool.0.used(),reserved);println!("ws-backing-write {name}: live_after_flush={live} requested_peak={peak} reservation={reserved} limit={limit}");let mut socket=socket;assert!(socket.set_write_limit(limit+1).is_err());socket.set_write_limit((MAX_INPUT+64).min(limit)).unwrap();assert_eq!(pool.0.used(),reserved);socket.get_mut().blocked=true;let error=socket.write(Message::Binary(payloads[0].clone())).err().unwrap();assert!(matches!(error,tungstenite::Error::Io(error)if error.kind()==io::ErrorKind::WouldBlock));assert_eq!(pool.0.used(),reserved);socket.get_mut().blocked=false;socket.flush().unwrap();assert_eq!(pool.0.used(),reserved);drop(socket);assert_eq!(pool.0.used(),0);}
 }
 #[test]fn raw_message_quota_survives_socket_and_many_aliases_without_an_unleased_detach(){
  let input=[wire("first",32,false),wire("second",32,false),wire("third",32,false)].concat();let pool=Pool::new(FIXED_BYTES+3*CONTROL_WRITE+2*MESSAGE_BYTES);let connection=admission(&pool,Kind::Control);let mut socket=Socket::new(WebSocket::from_raw_socket(Gate::new(&input,131072),Role::Server,Some(config())),connection);let a=socket.read().unwrap();let b=socket.read().unwrap();let reads=socket.get_ref().reads;let alias=a.clone();assert!(is_pressure(&socket.read().err().unwrap()));assert_eq!(socket.get_ref().reads,reads);drop(socket);assert_eq!(pool.0.used(),2*MESSAGE_BYTES);drop(a);assert_eq!(pool.0.used(),2*MESSAGE_BYTES);drop(alias);assert_eq!(pool.0.used(),MESSAGE_BYTES);drop(b);assert_eq!(pool.0.used(),0);
  let pool=Pool::new(DEFAULT_BYTES);let mut connections=vec![];for n in 0..12{let mut connection=pool.connection().unwrap();if n<4{connection.role(Kind::Data).unwrap();}else if n<8{connection.role(Kind::Control).unwrap();}connections.push(connection);}assert_eq!(pool.0.used(),12*FIXED_BYTES+4*3*DATA_WRITE+4*3*CONTROL_WRITE);assert!(pool.ready());drop(connections);assert_eq!(pool.0.used(),0);
 }
 #[test]fn failed_partial_http_and_oversized_frames_return_credit_after_real_buffers_drop(){
  for(name,request,chunk,broken,reject)in [("partial",b"GET /stream HTTP/1.1\r\nHost: localhost\r\n".to_vec(),4096,false,false),("too-many-headers",header(0,118),4096,false,false),("small-packet-attack",header(10000,0),64,false,false),("broken-response",header(0,0),4096,true,false),("reject-after-role",header(0,0),4096,false,true)]{let pool=Pool::new(DEFAULT_BYTES);let mut connection=pool.connection().unwrap();let(result,_,peak)=crate::allocation_probe::observe(||{let mut gate=Gate::new(&request,chunk);gate.broken=broken;accept_hdr_with_config(gate,|_:&tungstenite::handshake::server::Request,response|{connection.role(Kind::Data).unwrap();if reject{Err(tungstenite::http::Response::builder().status(503).body(Some("rejected".into())).unwrap())}else{Ok(response)}},Some(config())).map_err(|error|error.to_string())});assert!(result.is_err(),"{name}");assert!(peak<=FIXED_BYTES);drop(result);drop(connection);assert_eq!(pool.0.used(),0);println!("ws-backing-failure {name}: requested_peak={peak} fixed={FIXED_BYTES}");}
  let input=[0x82,0xff,0,0,0,0,0x40,0,0,0,17,29,41,53];let pool=Pool::new(DEFAULT_BYTES);let connection=admission(&pool,Kind::Data);let mut socket=Socket::new(WebSocket::from_raw_socket(Gate::new(&input,128),Role::Server,Some(config())),connection);let(result,peak)=crate::allocation_probe::measure(||socket.read());assert!(result.is_err());assert!(peak<FIXED_BYTES);assert_eq!(pool.0.used(),FIXED_BYTES+3*DATA_WRITE);drop(socket);assert_eq!(pool.0.used(),0);
 }
}
