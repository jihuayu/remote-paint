use crate::scene::Result;
use std::{
    collections::VecDeque,
    io::{Read, Write},
    net::TcpStream,
    thread,
    time::{Duration, Instant},
};
use tungstenite::Message;

pub struct Progress {
    pub bytes: usize,
    pub packets: usize,
    pub blocked: bool,
}

pub fn close(ws: &mut crate::ws_memory::Socket<TcpStream>, code: u16, reason: &str) {
    let _ = ws.get_mut().set_nonblocking(true);
    close_with_deadline(ws,code,reason,Duration::from_millis(200));
}
fn close_with_deadline<S:Read+Write>(ws:&mut crate::ws_memory::Socket<S>,code:u16,reason:&str,timeout:Duration){
    let until=Instant::now()+timeout;let mut queued=false;
    while Instant::now()<until{
        // read() retries automatic pong/close responses,not our own close
        // after WouldBlock. Explicitly drain every queued write. Flush old
        // data before queueing close so a full length cap cannot lose it.
        match ws.flush(){
            Ok(())=>if !queued{
                queued=true;
                match ws.close(Some(tungstenite::protocol::CloseFrame{code:code.into(),reason:reason.to_owned().into()})){
                    Ok(())=>{},
                    Err(tungstenite::Error::Io(error))if error.kind()==std::io::ErrorKind::WouldBlock=>{},
                    Err(_)=>break,
                }
            },
            Err(tungstenite::Error::Io(error))if error.kind()==std::io::ErrorKind::WouldBlock=>{},
            Err(_)=>break,
        }
        match ws.discard_read(){
            Err(tungstenite::Error::ConnectionClosed|tungstenite::Error::AlreadyClosed)=>break,
            Err(tungstenite::Error::Io(error))if error.kind()==std::io::ErrorKind::WouldBlock=>thread::sleep(Duration::from_millis(2)),
            Err(_)=>break,
            Ok(())=>{},
        }
    }
}
// WouldBlock after write() means tungstenite already owns the packet. Only
// WriteBufferFull returns an unaccepted packet; retrying the former duplicates
// bytes on a slow connection. Flush the one outstanding packet before more.
pub fn drain<S: Read + Write>(
    ws: &mut crate::ws_memory::Socket<S>,
    queue: &mut VecDeque<Message>,
    limit: usize,
) -> Result<Progress> {
    let mut progress = Progress {
        bytes: 0,
        packets: 0,
        blocked: false,
    };
    match ws.flush() {
        Ok(()) => {}
        Err(tungstenite::Error::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock => {
            progress.blocked = true;
            return Ok(progress);
        }
        Err(error) => return Err(error.to_string()),
    }
    for _ in 0..limit {
        let Some(packet) = queue.pop_front() else {
            break;
        };
        let bytes = match &packet {
            Message::Frame(frame) => frame.payload().len(),
            _ => packet.len(),
        };
        match ws.write(packet) {
            Ok(()) => {}
            Err(tungstenite::Error::Io(error))
                if error.kind() == std::io::ErrorKind::WouldBlock =>
            {
                progress.blocked = true;
            }
            Err(tungstenite::Error::WriteBufferFull(packet)) => {
                queue.push_front(*packet);
                progress.blocked = true;
                break;
            }
            Err(error) => return Err(error.to_string()),
        }
        progress.bytes += bytes;
        progress.packets += 1;
        if progress.blocked {
            break;
        }
    }
    Ok(progress)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Cursor};
    use tungstenite::{WebSocket,protocol::Role};
    struct Partial {
        bytes: Vec<u8>,
        block: bool,
    }
    impl Read for Partial {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::ErrorKind::WouldBlock.into())
        }
    }
    impl Write for Partial {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.block = !self.block;
            if self.block {
                return Err(io::ErrorKind::WouldBlock.into());
            }
            let count = bytes.len().min(3);
            self.bytes.extend(&bytes[..count]);
            Ok(count)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn partial_writes_preserve_exact_packet_order_without_duplicate_submissions() {
        let expected = [
            Message::Binary(vec![17; 131].into()),
            Message::Binary(vec![29; 211].into()),
            Message::Text("commit".into()),
        ];
        let mut queue = VecDeque::from(expected.clone());
        let pool=crate::ws_memory::Pool::new(crate::ws_memory::DEFAULT_BYTES);let mut admission=pool.connection().unwrap();admission.role(crate::ws_memory::Kind::Data).unwrap();
        let mut ws = crate::ws_memory::Socket::new(WebSocket::from_raw_socket(
            Partial {
                bytes: vec![],
                block: false,
            },
            Role::Server,
            Some(crate::ws_memory::config()),
        ),admission);
        for _ in 0..1000 {
            drain(&mut ws, &mut queue, 2).unwrap();
        }
        assert!(queue.is_empty());
        let bytes = ws.into_inner().bytes;
        let mut reader = WebSocket::from_raw_socket(Cursor::new(bytes), Role::Client, None);
        for message in expected {
            assert_eq!(reader.read().unwrap(), message);
        }
        assert!(reader.read().is_err());
    }
    struct CloseGate{output:Vec<u8>,input:Vec<u8>,position:usize,blocked:usize,partial:bool,ready_after:usize,writes:usize,reads:usize}
    impl Read for CloseGate{fn read(&mut self,out:&mut[u8])->io::Result<usize>{self.reads+=1;if self.output.len()<self.ready_after{return Err(io::ErrorKind::WouldBlock.into());}let n=out.len().min(self.input.len()-self.position);out[..n].copy_from_slice(&self.input[self.position..self.position+n]);self.position+=n;Ok(n)}}
    impl Write for CloseGate{fn write(&mut self,bytes:&[u8])->io::Result<usize>{self.writes+=1;if self.blocked>0{self.blocked-=1;return Err(io::ErrorKind::WouldBlock.into());}if self.partial&&self.writes%2==0{return Err(io::ErrorKind::WouldBlock.into());}let n=if self.partial{bytes.len().min(3)}else{bytes.len()};self.output.extend_from_slice(&bytes[..n]);Ok(n)}fn flush(&mut self)->io::Result<()>{Ok(())}}
    fn closing_socket(gate:CloseGate)->(crate::ws_memory::Pool,crate::ws_memory::Socket<CloseGate>){let pool=crate::ws_memory::Pool::new(crate::ws_memory::DEFAULT_BYTES);let mut admission=pool.connection().unwrap();admission.role(crate::ws_memory::Kind::Data).unwrap();let socket=crate::ws_memory::Socket::new(WebSocket::from_raw_socket(gate,Role::Server,Some(crate::ws_memory::config())),admission);(pool,socket)}
    fn close_frame(masked:bool)->Vec<u8>{let mut frame=tungstenite::protocol::frame::Frame::close(Some(tungstenite::protocol::CloseFrame{code:1001.into(),reason:"queueclose".into()}));if masked{frame.header_mut().mask=Some([11,29,43,59]);}let mut bytes=vec![];frame.format(&mut bytes).unwrap();bytes}
    #[test]
    fn read_only_drain_does_not_retry_our_blocked_close_until_explicit_flush(){
        let(pool,mut ws)=closing_socket(CloseGate{output:vec![],input:vec![],position:0,blocked:1,partial:false,ready_after:usize::MAX,writes:0,reads:0});
        assert!(matches!(ws.close(Some(tungstenite::protocol::CloseFrame{code:1001.into(),reason:"queueclose".into()})),Err(tungstenite::Error::Io(e))if e.kind()==io::ErrorKind::WouldBlock));
        for _ in 0..3{assert!(matches!(ws.discard_read(),Err(tungstenite::Error::Io(e))if e.kind()==io::ErrorKind::WouldBlock));}
        assert!(ws.get_ref().output.is_empty());assert_eq!(ws.get_ref().writes,1);assert_eq!(ws.get_ref().reads,3);println!("close-read-retry-before: read_calls=3 write_calls=1 output_bytes=0;own_close_not_automatically_retried");
        ws.flush().unwrap();assert_eq!(ws.get_ref().output,close_frame(false));drop(ws);assert_eq!(pool.stats()["bytes"],0);
    }
    #[test]
    fn full_write_limit_cannot_queue_close_before_existing_data_is_flushed(){
        let(pool,mut ws)=closing_socket(CloseGate{output:vec![],input:vec![],position:0,blocked:1,partial:false,ready_after:usize::MAX,writes:0,reads:0});ws.set_write_limit(68).unwrap();
        assert!(matches!(ws.write(Message::Text("x".repeat(64).into())),Err(tungstenite::Error::Io(e))if e.kind()==io::ErrorKind::WouldBlock));
        assert!(matches!(ws.close(Some(tungstenite::protocol::CloseFrame{code:1001.into(),reason:"queueclose".into()})),Err(tungstenite::Error::WriteBufferFull(_))));ws.flush().unwrap();assert_eq!(ws.get_ref().output.len(),66,"Rejected close was not queued by the library");println!("close-full-before: limit=68 pending_frame=66;close_write_buffer_full_and_not_queued");drop(ws);assert_eq!(pool.stats()["bytes"],0);
    }
    #[test]
    fn bounded_close_flushes_partial_full_buffer_then_exactly_one_close_in_order(){
        let mut expected=vec![0x81,64];expected.extend([b'x';64]);expected.extend(close_frame(false));
        let(pool,mut ws)=closing_socket(CloseGate{output:vec![],input:close_frame(true),position:0,blocked:6,partial:true,ready_after:expected.len(),writes:0,reads:0});ws.set_write_limit(68).unwrap();
        assert!(matches!(ws.write(Message::Text("x".repeat(64).into())),Err(tungstenite::Error::Io(e))if e.kind()==io::ErrorKind::WouldBlock));let started=Instant::now();close_with_deadline(&mut ws,1001,"queueclose",Duration::from_millis(200));let elapsed=started.elapsed();
        assert_eq!(ws.get_ref().output,expected);assert!(ws.get_ref().writes>6);assert_eq!(ws.get_ref().position,ws.get_ref().input.len());println!("close-flush-after: elapsed_ms={} write_calls={} exact_frame_bytes={} close_code=1001 deadline_ms=200",elapsed.as_millis(),ws.get_ref().writes,expected.len());let bytes=ws.into_inner().output;assert_eq!(pool.stats()["bytes"],0);let mut reader=WebSocket::from_raw_socket(Cursor::new(bytes),Role::Client,None);assert_eq!(reader.read().unwrap(),Message::Text("x".repeat(64).into()));let Message::Close(Some(frame))=reader.read().unwrap()else{panic!("Missing close")};assert_eq!(frame.code,u16::from(1001u16).into());assert_eq!(frame.reason,"queueclose");
    }
}
