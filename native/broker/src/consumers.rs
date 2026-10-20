use serde_json::Value;
use std::time::{Duration,Instant};
use crate::scene::Result;
pub const TICKET_SLOTS:usize=8;
pub const AUTOMATION_SLOTS:usize=2;
pub const DISPLAY_SLOTS:usize=4;
pub const TICKET_LIFETIME:Duration=Duration::from_secs(10);
#[derive(Clone,Copy,Debug,PartialEq,Eq)]pub enum Kind{Display,Observation,Recording}
impl Kind{
 pub fn label(self)->&'static str{match self{Self::Display=>"display",Self::Observation=>"observation",Self::Recording=>"recording"}}
 pub fn parse(value:&str)->Result<Self>{match value{"observation"=>Ok(Self::Observation),"recording"=>Ok(Self::Recording),_=>Err("Invalid native consumer kind".into())}}
 pub fn display(self)->bool{self==Self::Display}
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]pub struct Fence{pub serial:u64,pub ordinal:u64,pub epoch:u64,pub viewport:u64,pub input:u64}
impl Fence{
 pub fn read(request:&Value,serial:u64)->Result<Self>{
  fn number(value:&Value,min:u64)->Result<u64>{value.as_u64().filter(|n|*n>=min&&*n<=9_007_199_254_740_991).ok_or("Invalid native consumer context".into())}
  Ok(Self{serial,ordinal:number(&request["captureOrdinal"],0)?,epoch:number(&request["pageEpoch"],1)?,viewport:number(&request["viewportVersion"],1)?,input:number(&request["inputSeq"],0)?})
 }
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]pub struct Role{pub kind:Kind,pub fence:Option<Fence>}
#[derive(Debug,PartialEq,Eq)]pub enum Decision{Wait,Deliver,Changed}
impl Role{
 pub fn display()->Self{Self{kind:Kind::Display,fence:None}}
 pub fn decision(self,serial:u64,metadata:&Value)->Decision{
  let Some(f)=self.fence else{return Decision::Deliver};
  if self.kind==Kind::Observation{let Some(epoch)=metadata["pageEpoch"].as_u64()else{return Decision::Wait};let Some(viewport)=metadata["viewportVersion"].as_u64()else{return Decision::Wait};if epoch<f.epoch||epoch==f.epoch&&viewport<f.viewport{return Decision::Wait;}if epoch!=f.epoch||viewport!=f.viewport{return Decision::Changed;}}
  if serial<=f.serial||metadata["native"]["captureOrdinal"].as_u64().is_none_or(|n|n<=f.ordinal)||metadata["lastProcessedInputSeq"].as_u64().is_none_or(|n|n<f.input){return Decision::Wait;}
  Decision::Deliver
 }
}
#[derive(Clone,Copy)]struct Grant{bytes:[u8;32],created:Instant,role:Role}
// Fixed retained metadata is part of Gateway's pre-admitted registry allowance.
// Only the returned JSON/control packet contains an allocated token String.
pub struct Tickets{slots:[Option<Grant>;TICKET_SLOTS]}
impl Default for Tickets{fn default()->Self{Self{slots:[None;TICKET_SLOTS]}}}
impl Tickets{
 fn expire(&mut self,now:Instant){for slot in &mut self.slots{if slot.is_some_and(|g|now.saturating_duration_since(g.created)>=TICKET_LIFETIME){*slot=None;}}}
 pub fn clear(&mut self){self.slots.fill(None);}
 pub fn issue(&mut self,kind:Kind,fence:Fence,now:Instant)->Result<String>{
  if kind.display(){return Err("Display consumers use the existing Viewer authorization".into());}self.expire(now);
  let slot=self.slots.iter_mut().find(|slot|slot.is_none()).ok_or("Native consumer ticket limit")?;
  let mut bytes=[0;32];getrandom::fill(&mut bytes).map_err(|e|e.to_string())?;
  let mut token=String::with_capacity(64);const HEX:&[u8;16]=b"0123456789abcdef";for b in bytes{token.push(HEX[(b>>4)as usize]as char);token.push(HEX[(b&15)as usize]as char);}
  *slot=Some(Grant{bytes,created:now,role:Role{kind,fence:Some(fence)}});Ok(token)
 }
 pub fn claim(&mut self,token:&str,now:Instant)->Option<Role>{
  self.expire(now);if token.len()!=64{return None;}let mut bytes=[0;32];
  fn nibble(b:u8)->Option<u8>{match b{b'0'..=b'9'=>Some(b-b'0'),b'a'..=b'f'=>Some(b-b'a'+10),_=>None}}
  for(i,pair)in token.as_bytes().chunks_exact(2).enumerate(){bytes[i]=(nibble(pair[0])?<<4)|nibble(pair[1])?;}
  let index=self.slots.iter().position(|slot|slot.is_some_and(|g|g.bytes.iter().zip(bytes).fold(0u8,|diff,(a,b)|diff|(*a^b))==0))?;
  self.slots[index].take().map(|g|g.role)
 }
}
#[cfg(test)]mod tests{
 use super::*;use serde_json::json;
 fn fence()->Fence{Fence{serial:4,ordinal:8,epoch:2,viewport:3,input:5}}
 #[test]fn one_use_ticket_keeps_server_selected_role_and_context(){let now=Instant::now();let mut book=Tickets::default();let token=book.issue(Kind::Observation,fence(),now).unwrap();assert_eq!(token.len(),64);assert!(token.bytes().all(|b|b.is_ascii_hexdigit()));assert_eq!(book.claim(&token,now),Some(Role{kind:Kind::Observation,fence:Some(fence())}));assert!(book.claim(&token,now).is_none());}
 #[test]fn wrong_tokens_do_not_consume_the_valid_credential(){let now=Instant::now();let mut book=Tickets::default();let token=book.issue(Kind::Recording,fence(),now).unwrap();for invalid in ["".to_owned(),"f".repeat(64),"g".repeat(64),token[..63].to_owned()]{assert!(book.claim(&invalid,now).is_none());}assert_eq!(book.claim(&token,now).unwrap().kind,Kind::Recording);}
 #[test]fn expiry_is_exact_and_capacity_recovers_without_growing_the_registry(){let now=Instant::now();let mut book=Tickets::default();let tokens:Vec<_>=(0..TICKET_SLOTS).map(|_|book.issue(Kind::Observation,fence(),now).unwrap()).collect();assert!(book.issue(Kind::Recording,fence(),now).is_err());assert!(book.claim(&tokens[0],now+TICKET_LIFETIME).is_none());let fresh=book.issue(Kind::Recording,fence(),now+TICKET_LIFETIME).unwrap();assert_eq!(book.claim(&fresh,now+TICKET_LIFETIME).unwrap().kind,Kind::Recording);}
 #[test]fn authorization_is_not_transferable_to_another_source_and_stop_revokes_it(){let now=Instant::now();let mut first=Tickets::default();let mut second=Tickets::default();let token=first.issue(Kind::Observation,fence(),now).unwrap();assert!(second.claim(&token,now).is_none());first.clear();assert!(first.claim(&token,now).is_none());assert!(first.issue(Kind::Display,fence(),now).is_err());}
 #[test]fn registry_uses_fixed_inline_backing_and_no_creation_allocation(){let(book,peak)=crate::allocation_probe::measure(Tickets::default);assert_eq!(peak,0);assert!(std::mem::size_of_val(&book)<2048);}
 #[test]fn context_rejects_invalid_or_unsafe_numbers(){for v in [json!({}),json!({"captureOrdinal":0,"pageEpoch":0,"viewportVersion":1,"inputSeq":0}),json!({"captureOrdinal":9_007_199_254_740_992u64,"pageEpoch":1,"viewportVersion":1,"inputSeq":0})]{assert!(Fence::read(&v,0).is_err());}assert_eq!(Fence::read(&json!({"captureOrdinal":8,"pageEpoch":2,"viewportVersion":3,"inputSeq":5}),4).unwrap(),fence());}
 #[test]fn observation_requires_a_new_capture_with_exact_target_and_input_fences(){let role=Role{kind:Kind::Observation,fence:Some(fence())};let mut metadata=json!({"pageEpoch":2,"viewportVersion":3,"lastProcessedInputSeq":5,"native":{"captureOrdinal":9}});assert_eq!(role.decision(5,&metadata),Decision::Deliver);assert_eq!(role.decision(4,&metadata),Decision::Wait);metadata["native"]["captureOrdinal"]=json!(8);assert_eq!(role.decision(5,&metadata),Decision::Wait);metadata["native"]["captureOrdinal"]=json!(9);metadata["lastProcessedInputSeq"]=json!(4);assert_eq!(role.decision(5,&metadata),Decision::Wait);metadata["pageEpoch"]=json!(3);assert_eq!(role.decision(5,&metadata),Decision::Changed);metadata["pageEpoch"]=json!(2);metadata["viewportVersion"]=json!(4);assert_eq!(role.decision(5,&metadata),Decision::Changed);}
 #[test]fn recording_continues_across_document_changes_but_does_not_replay_pre_request_frames(){let role=Role{kind:Kind::Recording,fence:Some(fence())};let m=json!({"pageEpoch":9,"viewportVersion":7,"lastProcessedInputSeq":6,"native":{"captureOrdinal":10}});assert_eq!(role.decision(6,&m),Decision::Deliver);assert_eq!(role.decision(3,&m),Decision::Wait);assert_eq!(Role::display().decision(0,&Value::Null),Decision::Deliver);}
}
