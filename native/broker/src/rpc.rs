use crate::{budget::{Budget,Lease},input::{self,PRESSURE}};
use serde_json::{Value,json};
use std::io::{self,Read};

pub const MAX_PACKET:usize=90*1024*1024;
pub const MAX_CONTROL_PACKET:usize=256*1024;
const FRAMING_BYTES:usize=64*1024;
const PREFIX:usize=512;
const SCRATCH:usize=8192;

// Only one stdin handler runs at a time. The framing reservation covers its
// fixed prefix/drain/token buffers and bounded envelope strings, even when no
// packet can be admitted. Output, derived Snapshot/Gateway copies and VM/RSS
// are separate scopes. Value must drop before its parser credit.
pub struct ParsedRequest {pub value:Value,_lease:Lease}
pub enum Frame {Request(ParsedRequest),Rejected{id:Value,error:String,code:&'static str}}
pub struct RpcInput {data:Budget,control:Budget,_framing:Lease}
impl RpcInput {
    pub fn new(data:usize,control:usize)->Result<Self,String>{
        let data=Budget::scoped(data,PRESSURE,"rpc-data-input");
        let control=Budget::scoped(control,PRESSURE,"rpc-control-input");
        let framing=control.reserve(FRAMING_BYTES)?;
        Ok(Self{data,control,_framing:framing})
    }
    pub fn configured()->Result<Self,String>{
        fn limit(name:&str,default:usize,min:usize,max:usize)->Result<usize,String>{
            let bytes=match std::env::var(name){Ok(value)=>value.parse::<usize>().map_err(|_|format!("Invalid {name}"))?,Err(_)=>default};
            if !(min..=max).contains(&bytes){return Err(format!("Invalid {name} range"));}Ok(bytes)
        }
        Self::new(limit("REMOTE_PAINT_RPC_INPUT_BYTES",512*1024*1024,1024*1024,2*1024*1024*1024)?,limit("REMOTE_PAINT_RPC_CONTROL_BYTES",4*1024*1024,256*1024,16*1024*1024)?)
    }
    pub fn ready(&self)->bool{self.data.ready()}
    pub fn dispatch_admission(&self,bytes:usize)->Result<Lease,String>{self.control.reserve(bytes)}
    pub fn stats(&self)->Value{json!({"scope":"rpc-input-pool","data":self.data.stats(),"control":self.control.stats(),"framingBytes":FRAMING_BYTES,"maximumPacket":MAX_PACKET,"maximumControlPacket":MAX_CONTROL_PACKET,"ready":self.ready()})}
    fn reject(envelope:&Envelope,error:String)->Frame{
        let code=if error==PRESSURE{"INPUT_BUDGET_PRESSURE"}else{"INVALID_REQUEST"};
        Frame::Rejected{id:envelope.id.clone().unwrap_or(Value::Null),error,code}
    }
    pub fn read(&self,input:&mut impl Read)->io::Result<Option<Frame>>{
        let mut header=[0;4];
        // Clean EOF is different from an interrupted length header. A broken
        // byte frame cannot be resynchronized; a complete invalid JSON can.
        loop{match input.read(&mut header[..1]){Ok(0)=>return Ok(None),Ok(_)=>break,Err(error)if error.kind()==io::ErrorKind::Interrupted=>continue,Err(error)=>return Err(error)}}
        input.read_exact(&mut header[1..])?;
        let size=u32::from_be_bytes(header)as usize;
        let mut prefix=[0;PREFIX];let first=size.min(PREFIX);input.read_exact(&mut prefix[..first])?;
        let mut envelope=Envelope::new();envelope.feed(&prefix[..first]);
        // A small envelope with op after a large argument can still obtain
        // reserved control space. If it is data, rebind that exact packet to
        // the data pool before parsing. It cannot keep the control credit.
        let mut provisional_control=envelope.op.as_deref().map(control_op).unwrap_or(size<=MAX_CONTROL_PACKET);
        let initial=if provisional_control{&self.control}else{&self.data};
        let mut failure=if size>MAX_PACKET||provisional_control&&size>MAX_CONTROL_PACKET{Some("Broker input packet limit".into())}else{None};
        let mut packet=if failure.is_none(){
            let result=match initial.buffer(size){
                // Unknown small headers may try either raw staging pool. A
                // tight control quota must not become the effective data cap.
                Err(_)if provisional_control&&envelope.op.is_none()=>{provisional_control=false;self.data.buffer(size)},
                result=>result,
            };
            match result{Ok(mut packet)=>{packet.initialized()[..first].copy_from_slice(&prefix[..first]);Some(packet)},Err(error)=>{failure=Some(error);None}}
        }else{None};
        if let Some(packet)=&mut packet{
            let bytes=packet.initialized();input.read_exact(&mut bytes[first..])?;envelope.feed(&bytes[first..]);
        }else{
            // Scan all top-level fields during drain, so a late id still gets
            // its own rejection. No full-size temporary or serde Value here.
            let mut remaining=size-first;let mut scratch=[0;SCRATCH];
            while remaining>0{let count=remaining.min(SCRATCH);input.read_exact(&mut scratch[..count])?;envelope.feed(&scratch[..count]);remaining-=count;}
        }
        envelope.finish();
        if !envelope.valid(){return Ok(Some(Self::reject(&envelope,"Invalid Broker request envelope".into())));}
        if let Some(error)=failure{return Ok(Some(Self::reject(&envelope,error)));}
        let control=control_op(envelope.op.as_deref().unwrap());
        if control&&size>MAX_CONTROL_PACKET{return Ok(Some(Self::reject(&envelope,"Broker control packet limit".into())));}
        let pool=if control{&self.control}else{&self.data};
        let packet=packet.take().unwrap();
        let packet=if control==provisional_control{packet}else{match packet.transfer(pool){Ok(packet)=>packet,Err(error)=>return Ok(Some(Self::reject(&envelope,error)))}};
        let charge=match input::json_charge(&packet){Ok(bytes)=>bytes,Err(error)=>return Ok(Some(Self::reject(&envelope,error)))};
        let lease=match pool.reserve(charge){Ok(lease)=>lease,Err(error)=>return Ok(Some(Self::reject(&envelope,error)))};
        let value:Value=match serde_json::from_slice(&packet){Ok(value)=>value,Err(_)=>return Ok(Some(Self::reject(&envelope,"Invalid Broker request JSON".into())))};
        // The scanner is for bounded correlation/admission, never a JSON
        // authority. Check its final id/op against the actual parsed object.
        if !value.is_object()||Some(&value["id"])!=envelope.id.as_ref()||value["op"].as_str()!=envelope.op.as_deref(){return Ok(Some(Self::reject(&envelope,"Invalid Broker request envelope".into())));}
        drop(packet);
        Ok(Some(Frame::Request(ParsedRequest{value,_lease:lease})))
    }
}
fn control_op(op:&str)->bool{matches!(op,"listen"|"listenViz"|"expectViz"|"cancelViz"|"publish"|"send"|"reset"|"resetScene"|"stop"|"mapperStats"|"inputBudget"|"resourceBudget"|"consumerTicket"|"registerNative"|"nativePolicy"|"cancelNative"|"nativeState")}

#[derive(Clone,Copy,PartialEq)]enum Top {Key,Colon,Value,After}
#[derive(Clone,Copy,PartialEq)]enum Field {Other,Id,Op}
#[derive(Clone,Copy,PartialEq)]enum Token {Other,Key,Id,Op}
// A streaming locator with bounded tokens. Full syntax/Unicode validation is
// still serde's job after admission; this accepts no duplicate id/op fields.
struct Envelope {
    id:Option<Value>,op:Option<String>,id_seen:bool,op_seen:bool,invalid:bool,
    started:bool,ended:bool,depth:usize,top:Top,field:Field,
    string:bool,escape:bool,atom:bool,token:Token,bytes:[u8;512],length:usize,overflow:bool,
}
impl Envelope {
    fn new()->Self{Self{id:None,op:None,id_seen:false,op_seen:false,invalid:false,started:false,ended:false,depth:0,top:Top::Key,field:Field::Other,string:false,escape:false,atom:false,token:Token::Other,bytes:[0;512],length:0,overflow:false}}
    fn start_token(&mut self,token:Token){self.token=token;self.length=0;self.overflow=false;}
    fn push(&mut self,byte:u8){if self.token==Token::Other{return;}if self.length<self.bytes.len(){self.bytes[self.length]=byte;self.length+=1;}else{self.overflow=true;}}
    fn token_value(&self)->Option<Value>{if self.overflow{None}else{serde_json::from_slice(&self.bytes[..self.length]).ok()}}
    fn end_token(&mut self){
        match self.token {
            Token::Key=>{self.field=match self.token_value().as_ref().and_then(Value::as_str){Some("id")=>Field::Id,Some("op")=>Field::Op,_=>Field::Other};self.top=Top::Colon;},
            Token::Id=>{if self.id_seen{self.invalid=true;}self.id_seen=true;let value=self.token_value();if value.as_ref().is_some_and(|value|value.is_number()||value.is_null()||value.as_str().is_some_and(|s|s.len()<=128)){self.id=value;}else{self.invalid=true;}self.top=Top::After;},
            Token::Op=>{if self.op_seen{self.invalid=true;}self.op_seen=true;self.op=self.token_value().as_ref().and_then(Value::as_str).filter(|op|!op.is_empty()&&op.len()<=64).map(str::to_owned);if self.op.is_none(){self.invalid=true;}self.top=Top::After;},
            Token::Other=>{if self.depth==1{self.top=Top::After;}},
        }
        self.token=Token::Other;
    }
    fn value_token(&self)->Token{if self.depth==1&&self.top==Top::Value{match self.field{Field::Id=>Token::Id,Field::Op=>Token::Op,_=>Token::Other}}else{Token::Other}}
    fn feed(&mut self,bytes:&[u8]){
        for &byte in bytes {
            if self.string{self.push(byte);if self.escape{self.escape=false;}else if byte==b'\\'{self.escape=true;}else if byte==b'"'{self.string=false;self.end_token();}continue;}
            if self.atom{
                if !matches!(byte,b','|b']'|b'}'|b' '|b'\n'|b'\r'|b'\t'){self.push(byte);continue;}
                self.atom=false;self.end_token();
            }
            if matches!(byte,b' '|b'\n'|b'\r'|b'\t'){continue;}
            if self.ended{self.invalid=true;continue;}
            match byte {
                b'"'=>{let token=if self.depth==1&&self.top==Top::Key{Token::Key}else{self.value_token()};self.start_token(token);self.string=true;self.escape=false;self.push(byte);},
                b'{'|b'['=>{
                    if !self.started{self.started=true;if byte!=b'{'{self.invalid=true;}self.depth=1;self.top=Top::Key;}
                    else{if self.depth==1{if self.top!=Top::Value||self.field!=Field::Other{self.invalid=true;}self.top=Top::After;}self.depth=self.depth.saturating_add(1);}
                },
                b'}'|b']'=>{if self.depth==0{self.invalid=true;}else{if self.depth==1&&(byte!=b'}'||!matches!(self.top,Top::After|Top::Key)){self.invalid=true;}self.depth-=1;if self.depth==0{self.ended=true;}}},
                b':'=>{if self.depth==1{if self.top!=Top::Colon{self.invalid=true;}self.top=Top::Value;}},
                b','=>{if self.depth==1{if self.top!=Top::After{self.invalid=true;}self.top=Top::Key;self.field=Field::Other;}},
                _=>{let token=self.value_token();self.start_token(token);self.atom=true;self.push(byte);},
            }
        }
    }
    fn finish(&mut self){if self.atom{self.atom=false;self.end_token();}if self.string||self.depth!=0||!self.ended{self.invalid=true;}}
    fn valid(&self)->bool{!self.invalid&&self.started&&self.ended&&self.id_seen&&self.op_seen&&self.id.is_some()&&self.op.is_some()}
}

#[cfg(test)]mod tests {
    use super::*;
    use std::io::Cursor;
    fn packet(text:&str)->Vec<u8>{let mut bytes=(text.len()as u32).to_be_bytes().to_vec();bytes.extend_from_slice(text.as_bytes());bytes}
    fn request(pool:&RpcInput,text:&str)->ParsedRequest{match pool.read(&mut Cursor::new(packet(text))).unwrap().unwrap(){Frame::Request(request)=>request,Frame::Rejected{error,..}=>panic!("Unexpected rejection: {error}")}}
    fn rejection(pool:&RpcInput,text:&str)->(Value,String,&'static str){match pool.read(&mut Cursor::new(packet(text))).unwrap().unwrap(){Frame::Rejected{id,error,code}=>(id,error,code),Frame::Request(_)=>panic!("Unexpected admission")}}
    #[test]fn small_controls_have_reserved_space_even_with_late_op_and_id(){
        let pool=RpcInput::new(1024*1024,4*1024*1024).unwrap();let held=pool.data.reserve(1024*1024).unwrap();
        let text=format!("{{\"padding\":\"{}\",\"id\":7,\"op\":\"resourceBudget\"}}","x".repeat(160*1024));
        let parsed=request(&pool,&text);assert_eq!(parsed.value["id"],7);assert_eq!(pool.data.used(),1024*1024);assert!(pool.control.used()>FRAMING_BYTES);drop(parsed);assert_eq!(pool.control.used(),FRAMING_BYTES);drop(held);assert_eq!(pool.data.used(),0);
    }
    #[test]fn late_data_headers_do_not_make_the_control_staging_quota_a_data_limit(){
        let pool=RpcInput::new(4*1024*1024,256*1024).unwrap();let text=format!("{{\"padding\":\"{}\",\"id\":21,\"op\":\"map\"}}","x".repeat(200*1024));
        let parsed=request(&pool,&text);assert_eq!(parsed.value["id"],21);assert!(pool.data.used()>0);assert_eq!(pool.control.used(),FRAMING_BYTES);drop(parsed);assert_eq!(pool.data.used(),0);
    }
    #[test]fn data_cannot_keep_provisional_control_credit_and_error_drains_following_frame(){
        let pool=RpcInput::new(1024*1024,4*1024*1024).unwrap();let held=pool.data.reserve(1024*1024).unwrap();
        let text=format!("{{\"padding\":\"{}\",\"op\":\"map\",\"id\":8}}","x".repeat(64*1024));let mut bytes=packet(&text);bytes.extend(packet(r#"{"id":9,"op":"mapperStats"}"#));let mut reader=Cursor::new(bytes);
        assert!(matches!(pool.read(&mut reader).unwrap(),Some(Frame::Rejected{id,code:"INPUT_BUDGET_PRESSURE",..})if id==8));assert_eq!(pool.control.used(),FRAMING_BYTES);
        assert!(matches!(pool.read(&mut reader).unwrap(),Some(Frame::Request(request))if request.value["id"]==9));drop(held);assert_eq!(pool.data.used(),0);assert_eq!(pool.control.used(),FRAMING_BYTES);
    }
    #[test]fn packet_and_parser_quota_denials_preserve_ids_and_release_every_temporary(){
        let pool=RpcInput::new(1024*1024,4*1024*1024).unwrap();
        for bytes in [250*1024,1200*1024]{let text=format!("{{\"op\":\"map\",\"padding\":\"{}\",\"id\":11}}","x".repeat(bytes));let(id,error,code)=rejection(&pool,&text);assert_eq!(id,11);assert_eq!(error,PRESSURE);assert_eq!(code,"INPUT_BUDGET_PRESSURE");assert_eq!(pool.data.used(),0);assert_eq!(pool.control.used(),FRAMING_BYTES);}
        assert!(pool.data.stats()["denied"].as_u64().unwrap()>=2);
    }
    #[test]fn malformed_unicode_duplicate_headers_and_nested_spoofs_never_steal_next_frame(){
        let pool=RpcInput::new(16*1024*1024,4*1024*1024).unwrap();
        for text in [r#"{"id":2,"op":"send","message":"\ud800"}"#,r#"{"id":2,"op":"send","message":"\udc00"}"#,r#"{"id":2,"op":"send","message":"# ,r#"{"id":2,"op":"send","op":"map"}"#,r#"{"id":2,"op":"send","nested":{"op":"map","id":99},"x":[}] }"#]{
            let mut bytes=packet(text);bytes.extend(packet(r#"{"id":3,"op":"resourceBudget"}"#));let mut reader=Cursor::new(bytes);
            assert!(matches!(pool.read(&mut reader).unwrap(),Some(Frame::Rejected{id,code:"INVALID_REQUEST",..})if id==2),"{text}");
            assert!(matches!(pool.read(&mut reader).unwrap(),Some(Frame::Request(request))if request.value["id"]==3));assert_eq!(pool.data.used(),0);assert_eq!(pool.control.used(),FRAMING_BYTES);
        }
    }
    #[test]fn scanner_is_chunk_independent_and_understands_escaped_top_level_names(){
        let text=r#"{"nested":{"id":999,"op":"map","quote":"x\\\"[,]"},"\u0069d":"correlated","\u006fp":"resourceBudget","x":[1,true,null]}"#;
        for size in 1..=text.len(){let mut envelope=Envelope::new();for part in text.as_bytes().chunks(size){envelope.feed(part);}envelope.finish();assert!(envelope.valid(),"split {size}");assert_eq!(envelope.id,Some(json!("correlated")));assert_eq!(envelope.op.as_deref(),Some("resourceBudget"));}
        let pool=RpcInput::new(16*1024*1024,4*1024*1024).unwrap();assert_eq!(request(&pool,text).value["id"],"correlated");
    }
    #[test]fn only_complete_frames_recover_and_eof_does_not_allocate_a_large_buffer(){
        let pool=RpcInput::new(1024*1024,4*1024*1024).unwrap();assert!(pool.read(&mut Cursor::new([])).unwrap().is_none());
        assert_eq!(pool.read(&mut Cursor::new([0,0])).err().unwrap().kind(),io::ErrorKind::UnexpectedEof);
        let mut bytes=packet(r#"{"id":1,"op":"map"}"#);bytes.truncate(bytes.len()-1);assert_eq!(pool.read(&mut Cursor::new(bytes)).err().unwrap().kind(),io::ErrorKind::UnexpectedEof);assert_eq!(pool.data.used(),0);assert_eq!(pool.control.used(),FRAMING_BYTES);
    }
    #[test]fn requested_layout_peaks_fit_packet_and_parser_reservations(){
        let cases=[format!("{{\"id\":1,\"op\":\"map\",\"data\":\"{}\\n\"}}","x".repeat(2_100_000)),format!("{{\"id\":2,\"op\":\"map\",\"data\":[{}]}}",vec!["{\"a\":0}";2000].join(",")),format!("{{\"id\":3,\"op\":\"map\",\"data\":{{{}}}}}",(0..2000).map(|n|format!("\"key{n}\":\"value\"")).collect::<Vec<_>>().join(","))];
        for (index,text)in cases.iter().enumerate(){let pool=RpcInput::new(64*1024*1024,4*1024*1024).unwrap();let mut reader=Cursor::new(packet(text));let(parsed,peak)=crate::allocation_probe::measure(||pool.read(&mut reader).unwrap().unwrap());assert!(matches!(&parsed,Frame::Request(_)));let reserved=pool.data.stats()["peak"].as_u64().unwrap()+pool.control.stats()["peak"].as_u64().unwrap();println!("rpc-layout-case{index}: input={} requested_peak={peak} reserved_peak={reserved}",text.len());assert!(peak<=reserved as usize);drop(parsed);assert_eq!(pool.data.used(),0);assert_eq!(pool.control.used(),FRAMING_BYTES);}
    }
    #[test]fn oversized_stream_is_drained_with_bounded_allocations_and_correlates_a_late_id(){
        let pool=RpcInput::new(1024*1024,4*1024*1024).unwrap();let front=b"{\"padding\":\"";let back=br#"","id":22,"op":"map"}"#;let count=MAX_PACKET+1-front.len()-back.len();
        let mut reader=Cursor::new(((MAX_PACKET+1)as u32).to_be_bytes()).chain(Cursor::new(front)).chain(io::repeat(b'x').take(count as u64)).chain(Cursor::new(back));
        let(result,peak)=crate::allocation_probe::measure(||pool.read(&mut reader).unwrap().unwrap());assert!(matches!(result,Frame::Rejected{id,code:"INVALID_REQUEST",..}if id==22));assert!(peak<FRAMING_BYTES);assert_eq!(pool.data.stats()["peak"],0);assert_eq!(pool.control.used(),FRAMING_BYTES);
    }
    #[test]fn generated_valid_json_matches_serde_with_nested_punctuation_and_late_headers(){
        fn value(state:&mut u64,depth:usize)->Value{
            *state=state.wrapping_mul(6364136223846793005).wrapping_add(1);let n=(*state>>32)as usize;
            match if depth==0{n%5}else{n%8}{
                0=>Value::Null,1=>json!(n%2==0),2=>json!(n as u64),3=>json!((n%1000)as f64/7.0),4=>json!(["x\\\"[{,}]:","中文😀","\n\t\r\u{0}",""][n%4]),5|6=>Value::Array((0..n%5).map(|_|value(state,depth-1)).collect()),_=>{let mut object=serde_json::Map::new();for index in 0..n%5{object.insert(format!("key\"\\:{index}"),value(state,depth-1));}Value::Object(object)}
            }
        }
        let pool=RpcInput::new(64*1024*1024,4*1024*1024).unwrap();let mut seed=19;
        for id in 1..=1200{let item=value(&mut seed,5);let text=format!("{{\"payload\":{},\"long-key-{}\":null,\"id\":{id},\"op\":\"resourceBudget\"}}",item,"z".repeat(id%7*100));let expected:Value=serde_json::from_str(&text).unwrap();assert_eq!(request(&pool,&text).value,expected);assert_eq!(pool.data.used(),0);assert_eq!(pool.control.used(),FRAMING_BYTES);}
    }
}
