use crate::{emit, scene::Result, output::{Event,EventField::{Json,Text}}, command::{Command,Closure,Mailbox}};
use serde_json::Value;
use std::{
    net::TcpStream,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tungstenite::Message;

// A channel belongs to one data peer and is never transferable to a new data
// connection. Claiming the ticket consumes it, including on failed handshakes.
pub struct Channel {
    pub enabled: AtomicBool,
    pub ready: AtomicBool,
    pub closed: AtomicBool,
    ticket: Mutex<Option<(String, Instant)>>,
    mailbox: Mailbox,
}
impl Channel {
    pub fn new() -> Result<Self> {
        let mailbox=Mailbox::new(crate::command::global())?;
        Ok(Self {
            enabled: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            ticket: Mutex::new(None),
            mailbox,
        })
    }
    pub fn enable(&self) -> Result<String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
        let ticket: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        *self.ticket.lock().unwrap() = Some((ticket.clone(), Instant::now()));
        self.enabled.store(true, Ordering::Release);
        Ok(ticket)
    }
    pub fn claim(&self, supplied: &str) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        let mut ticket = self.ticket.lock().unwrap();
        let Some((expected, created)) = ticket.as_ref() else {
            return false;
        };
        if created.elapsed() > Duration::from_secs(10) || supplied.len() != expected.len() {
            return false;
        }
        let difference = supplied
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |bits, (a, b)| bits | (a ^ b));
        if difference != 0 {
            return false;
        }
        ticket.take();
        true
    }
    pub fn send(&self, text:tungstenite::Utf8Bytes) -> Result<()> {
        if self.closed.load(Ordering::Acquire){return Err("Control channel closed".into());}
        self.mailbox.send(text).map_err(|_|"Native control queue full".into())
    }
    pub fn send_close(&self, closure:Arc<Closure>) -> Result<()> {
        if self.closed.load(Ordering::Acquire){return Err("Control channel closed".into());}
        self.mailbox.request_close(closure).map_err(|_|"Native control queue full".into())
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.ready.store(false, Ordering::Release);
        self.ticket.lock().unwrap().take();
        self.mailbox.close();
    }
    pub fn serve(&self, mut ws: crate::ws_memory::Socket<TcpStream>, id: &str, config: &Value) -> Result<()> {
        ws.set_write_limit(crate::ws_memory::CONTROL_WRITE)?;
        ws.get_mut()
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        let hello = match ws.read() {
            Err(error)=>{if crate::ws_memory::is_pressure(&error){crate::writer::close(&mut ws,1013,"WebSocket backing allocation pressure");}return Err(error.to_string());}
            Ok(message)=>match message {
            Message::Text(text) => match crate::ws_json::global().parse(text.as_bytes()) {
                Ok(message) => message,
                Err(error) => {
                    crate::writer::close(&mut ws, crate::ws_json::close_code(&error), if error==crate::ws_json::PRESSURE {"WebSocket JSON allocation pressure"} else {"Invalid control JSON"});
                    return Err(error);
                }
            },
            _ => return Err("Expected control handshake".into()),
            }
        };
        if hello["type"] != "HelloControl"
            || hello["protocol"] != 4
            || hello["peerId"] != id
            || hello["sessionId"] != config["sessionId"]
        {
            crate::writer::close(&mut ws, 1008, "Incompatible control handshake");
            return Err("Incompatible control handshake".into());
        }
        // Authentication is complete;do not retain padded hello graphs for
        // the connection lifetime.
        drop(hello);
        let welcome=match crate::gateway_packets::global().notification(crate::gateway_packets::Lane::Control,&crate::gateway_packets::Notification::ControlWelcome{peer:id,session:&config["sessionId"]}){
            Ok(text)=>text,Err(error)=>{if error==crate::gateway_packets::PRESSURE{crate::writer::close(&mut ws,1013,"Gateway packet allocation pressure");}return Err(error);}
        };
        ws.send(Message::Text(welcome)).map_err(|e|e.to_string())?;
        let commands = self.mailbox.receiver().ok_or("Control channel already attached")?;
        self.ready.store(true, Ordering::Release);
        ws.get_mut()
            .set_read_timeout(Some(Duration::from_millis(2)))
            .map_err(|e| e.to_string())?;
        let mut rate_start = Instant::now();
        let mut count = 0;
        while !self.closed.load(Ordering::Acquire) {
            for _ in 0..16 {
                let Ok(message) = commands.try_recv() else {
                    break;
                };
                match message {
                    Command::Close(closure)=>{crate::writer::close(&mut ws,closure.code,&closure.reason);return Ok(());},
                    Command::Text(text)=>ws.send(Message::Text(text)).map_err(|e|e.to_string())?,
                }
            }
            match ws.read() {
                Ok(Message::Text(text)) => {
                    let message = match crate::ws_json::global().parse(text.as_bytes()) {
                        Ok(message) => message,
                        Err(error) => {
                            crate::writer::close(&mut ws, crate::ws_json::close_code(&error), if error==crate::ws_json::PRESSURE {"WebSocket JSON allocation pressure"} else {"Invalid control JSON"});
                            return Err(error);
                        }
                    };
                    if rate_start.elapsed() > Duration::from_secs(1) {
                        rate_start = Instant::now();
                        count = 0;
                    }
                    count += 1;
                    if count > 512
                        || !matches!(
                            message["type"].as_str(),
                            Some("AcquireControl" | "RenewControl" | "ReleaseControl" | "Input")
                        )
                    {
                        crate::writer::close(
                            &mut ws,
                            1008,
                            "Unsupported control message or rate exceeded",
                        );
                        break;
                    }
                    emit(Event("Control",&[("message",Json(&message)),("peerId",Text(id))]));
                }
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(_) | Message::Pong(_)) => {}
                Err(error) if crate::ws_memory::is_pressure(&error)=>{
                    crate::writer::close(&mut ws,1013,"WebSocket backing allocation pressure");break;
                }
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    break;
                }
                Ok(_) => {
                    crate::writer::close(&mut ws, 1008, "Binary control message unsupported");
                    break;
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        if let Some(closure)=commands.close_command(){crate::writer::close(&mut ws,closure.code,&closure.reason);}else{let _=ws.close(None);}
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tickets_are_independent_single_use_and_invalid_after_close() {
        let first = Channel::new().unwrap();
        let second = Channel::new().unwrap();
        let a = first.enable().unwrap();
        let b = second.enable().unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(!first.claim(&b));
        assert!(first.claim(&a));
        assert!(!first.claim(&a));
        second.close();
        assert!(!second.claim(&b));
        let expired = Channel::new().unwrap();
        let c = expired.enable().unwrap();
        *expired.ticket.lock().unwrap() =
            Some((c.clone(), Instant::now() - Duration::from_secs(11)));
        assert!(!expired.claim(&c));
    }
}
