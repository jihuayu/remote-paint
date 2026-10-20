// Authenticated native intake, separate from the diagnostic one-shot registry.
// Fixed scope/job metadata; payload/JSON owners stay under existing pools.
use crate::{budget::{Lease,OwnedVec},input::InputPool,scene::Result,viz::NativeResources};
use serde_json::{Value,json};
use std::{io::Write,net::Shutdown,os::unix::net::UnixStream,
    sync::{Arc,Condvar,Mutex,Weak,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};

pub const SLOTS:usize=4;
pub const MAX_SAFE:u64=9_007_199_254_740_991;
const REGISTRY_BYTES:usize=32*1024;
pub const PAIR_TIMEOUT:Duration=Duration::from_secs(5);
pub const INVALID:&str="Invalid native subscription context";
pub const INACTIVE:&str="Native subscription inactive";
pub const TARGET_CHANGED:&str="Native subscription target changed";
pub const PAIR_EXPIRED:&str="Native subscription pairing deadline exceeded";
pub const LIMIT:&str="Native subscription admission limit";

pub fn integer(value:&Value,min:u64,max:u64)->Result<u64>{
    // Chromium JSON preserves double type (for example 7.0). Reject unsafe
    // integer representations before any f64 rounding can hide their value.
    let result=if let Some(n)=value.as_u64(){n}else{
        let n=value.as_f64().filter(|n|n.is_finite()&&*n>=0.&&n.fract()==0.&&*n<=MAX_SAFE as f64).ok_or(INVALID)?;
        n as u64
    };
    if result<min||result>max||result>MAX_SAFE{return Err(INVALID.into());}Ok(result)
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct Key([u8;32]);
impl Key{
    pub fn parse(value:&str)->Option<Self>{
        if value.len()!=32||!value.bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c)){return None;}
        Some(Self(value.as_bytes().try_into().ok()?))
    }
    pub fn text(&self)->&str{std::str::from_utf8(&self.0).unwrap()}
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct Config{
    pub key:Key,pub generation:u64,pub base:u64,pub limit:u64,
    pub epoch:u64,pub viewport:u64,pub initial_input:u64,
    pub width:u32,pub height:u32,pub host:u32,pub source_floor:u32,
}
impl Config{
    pub fn read(value:&Value)->Result<Self>{
        let number=|key,min,max|integer(&value[key],min,max);
        let out=Self{
            key:Key::parse(value["id"].as_str().ok_or(INVALID)?).ok_or(INVALID)?,
            generation:number("generation",1,MAX_SAFE)?,base:number("ordinalBase",0,MAX_SAFE)?,
            limit:number("ordinalLimit",1,MAX_SAFE)?,epoch:number("pageEpoch",1,MAX_SAFE)?,
            viewport:number("viewportVersion",1,MAX_SAFE)?,initial_input:number("inputSeq",0,MAX_SAFE)?,
            width:number("cssWidth",1,4096)? as u32,height:number("cssHeight",1,4096)? as u32,
            host:number("host",1,i32::MAX as u64)? as u32,
            source_floor:number("minimumSourceFrame",0,i32::MAX as u64)? as u32,
        };
        let span=out.limit.checked_sub(out.base).and_then(|n|n.checked_add(1)).ok_or(INVALID)?;
        if span<2||span>(1u64<<32)||!span.is_power_of_two()||out.base%span!=0{return Err(INVALID.into());}
        Ok(out)
    }
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct Identity{pub key:Key,pub ordinal:u64,pub generation:u64}
impl Identity{
    pub fn from_id(id:&str)->Option<(Key,u64)>{
        let(key,n)=id.split_once(':')?;let key=Key::parse(key)?;
        if n.is_empty()||n.len()>16||n.starts_with('0')||!n.bytes().all(|c|c.is_ascii_digit()){return None;}
        let ordinal=n.parse().ok()?;if ordinal>MAX_SAFE{return None;}Some((key,ordinal))
    }
    pub fn id(&self)->String{format!("{}:{}",self.key.text(),self.ordinal)}
    pub fn credit(self,outcome:Outcome)->[u8;56]{
        let mut bytes=[0;56];bytes[..5].copy_from_slice(b"RPC3\x01");bytes[5]=outcome as u8;
        bytes[8..40].copy_from_slice(&self.key.0);bytes[40..48].copy_from_slice(&self.ordinal.to_be_bytes());
        bytes[48..56].copy_from_slice(&self.generation.to_be_bytes());bytes
    }
}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
#[repr(u8)]pub enum Outcome{Consumed=1,Retry=2,Pause=3}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]pub enum Kind{Scene,Resources}
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub struct Stamp{pub identity:Identity,slot:usize,serial:u64}
#[derive(Debug)]pub struct Rejected{pub identity:Option<Identity>,pub reason:&'static str,pub outcome:Outcome}

pub struct Connection{stream:Mutex<UnixStream>,active:AtomicBool}
impl Connection{
    pub fn new(stream:UnixStream)->Self{let _=stream.set_write_timeout(Some(Duration::from_secs(1)));Self{stream:Mutex::new(stream),active:AtomicBool::new(true)}}
    pub fn send(&self,identity:Identity,outcome:Outcome)->bool{
        self.stream.lock().unwrap().write_all(&identity.credit(outcome)).is_ok()
    }
    pub fn active(&self)->bool{self.active.load(Ordering::Acquire)}
    pub fn close(&self){self.active.store(false,Ordering::Release);let _=self.stream.lock().unwrap().shutdown(Shutdown::Both);}
}
// One wake sequence can be shared by the stdin reader and the native intake.
// Waiting never consumes work; check queues after reading the sequence.
#[derive(Default)]pub struct Wake{version:Mutex<u64>,ready:Condvar}
impl Wake{
    pub fn version(&self)->u64{*self.version.lock().unwrap()}
    pub fn notify(&self){let mut n=self.version.lock().unwrap();*n=n.wrapping_add(1);self.ready.notify_all();}
    pub fn wait(&self,version:u64,timeout:Duration){let n=self.version.lock().unwrap();let _=self.ready.wait_timeout_while(n,timeout,|n|*n==version).unwrap();}
}
pub struct ScenePacket{
    pub bytes:OwnedVec,pub root:[f64;4],pub graph_bytes:usize,pub error:Option<String>,
}
struct Pending{
    identity:Identity,deadline:Instant,scene_claimed:bool,raw_claimed:bool,mapping:bool,published:bool,
    scene:Option<ScenePacket>,resources:Option<NativeResources>,connection:Option<Arc<Connection>>,
}
struct Scope{
    config:Config,serial:u64,enabled:bool,retiring:bool,last:u64,input:u64,allowed_input:u64,
    retries:u8,receipt:Option<(Identity,Outcome)>,connection:Weak<Connection>,job:Option<Pending>,
}
struct State{
    scopes:[Option<Scope>;SLOTS],next_serial:u64,next_base:u64,next_input:u64,active_serial:u64,published_ordinal:u64,
    target:(u64,u64),cursor:usize,stopped:bool,retired:[Option<(Config,Instant)>;SLOTS],retired_cursor:usize,_admission:Option<Lease>,
}
pub struct Subscriptions{state:Mutex<State>,pub input:InputPool,pub wake:Arc<Wake>}
impl Subscriptions{
    pub fn new(input:InputPool,wake:Arc<Wake>)->Self{
        Self{state:Mutex::new(State{scopes:std::array::from_fn(|_|None),next_serial:1,
            next_base:0,next_input:0,active_serial:0,published_ordinal:0,target:(0,0),cursor:0,stopped:false,retired:[None;SLOTS],retired_cursor:0,_admission:None}),input,wake}
    }
    pub fn register(&self,config:Config)->Result<Value>{
        let mut s=self.state.lock().unwrap();if s.stopped{return Err(INACTIVE.into());}
        if let Some(scope)=s.scopes.iter().flatten().find(|scope|scope.config.key==config.key){
            let mut old=scope.config;old.initial_input=config.initial_input;old.source_floor=config.source_floor;
            if old!=config||config.initial_input>scope.allowed_input||scope.retiring{return Err(INVALID.into());}return Ok(summary(scope));
        }
        if s.retired.iter().flatten().any(|(old,until)|old.key==config.key&&*until>Instant::now()){return Err(INACTIVE.into());}
        let index=s.scopes.iter().position(Option::is_none).ok_or(LIMIT)?;
        if config.base<s.next_base||config.initial_input<s.next_input||(config.epoch,config.viewport)<s.target{return Err(INVALID.into());}
        let next=s.next_serial.checked_add(1).ok_or(INVALID)?;
        if s._admission.is_none(){s._admission=Some(self.input.0.reserve(REGISTRY_BYTES)?);}
        let scope=Scope{config,serial:s.next_serial,enabled:true,retiring:false,last:config.base,
            input:config.initial_input,allowed_input:config.initial_input,retries:0,receipt:None,connection:Weak::new(),job:None};
        let result=summary(&scope);s.scopes[index]=Some(scope);s.active_serial=s.next_serial;s.next_serial=next;s.next_base=config.limit+1;
        s.next_input=s.next_input.max(config.initial_input);s.target=(config.epoch,config.viewport);Ok(result)
    }
    pub fn policy(&self,key:Key,input:u64,enabled:bool)->Result<Value>{
        let mut s=self.state.lock().unwrap();
        let scope=s.scopes.iter_mut().flatten().find(|scope|scope.config.key==key&&!scope.retiring).ok_or(INACTIVE)?;
        if input<scope.allowed_input||input>MAX_SAFE{return Err(INVALID.into());}
        scope.allowed_input=input;scope.enabled=enabled;
        let pending=if !enabled{scope.job.as_ref().filter(|j|!j.mapping).map(|j|Stamp{identity:j.identity,slot:0,serial:scope.serial})}else{None};
        let result=summary(scope);s.next_input=s.next_input.max(input);
        let pending=pending.map(|mut stamp|{stamp.slot=s.scopes.iter().position(|v|v.as_ref().is_some_and(|v|v.serial==stamp.serial)).unwrap();stamp});drop(s);
        if let Some(stamp)=pending{self.fail(stamp,INACTIVE,Outcome::Pause);}
        self.wake.notify();Ok(result)
    }
    pub fn stats(&self)->Value{
        let s=self.state.lock().unwrap();
        json!({"scope":"native-subscription-intake","limit":SLOTS,
            "registered":s.scopes.iter().flatten().count(),"inflight":s.scopes.iter().flatten().filter(|v|v.job.is_some()).count(),
            "nextOrdinalBase":s.next_base,"lastPublishedOrdinal":s.published_ordinal,"registryBytes":if s._admission.is_some(){REGISTRY_BYTES}else{0},
            "subscriptions":s.scopes.iter().flatten().map(summary).collect::<Vec<_>>()})
    }
    pub fn contains(&self,key:Key)->bool{let s=self.state.lock().unwrap();s.scopes.iter().flatten().any(|s|s.config.key==key)||s.retired.iter().flatten().any(|(c,until)|c.key==key&&*until>Instant::now())}
    pub fn inflight(&self)->usize{self.state.lock().unwrap().scopes.iter().flatten().filter(|s|s.job.is_some()).count()}
    // None is a legacy ID. A syntactically native ID must never fall through
    // to the one-shot path merely because its scope is unknown or revoked.
    pub fn reserve(&self,id:&str,kind:Kind,connection:Option<Arc<Connection>>,capacity:bool)->Option<std::result::Result<Stamp,Rejected>>{
        let(key,ordinal)=Identity::from_id(id)?;
        let mut s=self.state.lock().unwrap();
        let Some(index)=s.scopes.iter().position(|v|v.as_ref().is_some_and(|v|v.config.key==key))else{
            let identity=s.retired.iter().flatten().find(|(c,until)|c.key==key&&*until>Instant::now()&&ordinal>c.base&&ordinal<=c.limit)
                .map(|(c,_)|Identity{key,ordinal,generation:c.generation});
            return Some(Err(Rejected{identity,reason:INACTIVE,outcome:Outcome::Pause}));
        };
        let active_serial=s.active_serial;
        let scope=s.scopes[index].as_mut().unwrap();
        let identity=Identity{key,ordinal,generation:scope.config.generation};
        let reject=|reason|Some(Err(Rejected{identity:Some(identity),reason,outcome:Outcome::Pause}));
        if kind==Kind::Resources&&scope.receipt.is_some_and(|(old,_)|old==identity){
            let(_,outcome)=scope.receipt.take().unwrap();
            let outcome=if scope.serial==active_serial{outcome}else{Outcome::Pause};
            return Some(Err(Rejected{identity:Some(identity),reason:"Rejected native subscription frame",outcome}));
        }
        if ordinal<=scope.config.base||ordinal>scope.config.limit{return reject(INVALID);}
        if scope.retiring||!scope.enabled||scope.serial!=active_serial{return reject(INACTIVE);}
        if let Some(job)=&scope.job{
            if job.identity!=identity||job.mapping{return reject(LIMIT);}
        }else{
            if ordinal<=scope.last{return reject("Replayed native subscription frame");}
            if !capacity{return reject(LIMIT);}
            scope.last=ordinal;
            scope.job=Some(Pending{identity,deadline:Instant::now()+PAIR_TIMEOUT,scene_claimed:false,raw_claimed:false,
                mapping:false,published:false,scene:None,resources:None,connection:None});
        }
        let job=scope.job.as_mut().unwrap();
        let claimed=match kind{Kind::Scene=>&mut job.scene_claimed,Kind::Resources=>&mut job.raw_claimed};
        if *claimed{return reject("Duplicate native subscription packet");}*claimed=true;
        if let Some(connection)=connection{scope.connection=Arc::downgrade(&connection);job.connection=Some(connection);}
        Some(Ok(Stamp{identity,slot:index,serial:scope.serial}))
    }
    pub fn resources(&self,stamp:Stamp,resources:NativeResources)->bool{
        let mut s=self.state.lock().unwrap();
        let Some(scope)=matched(&mut s,stamp)else{return false;};
        if !scope.enabled||scope.retiring{return false;}
        let metadata=&resources.metadata;let frame=&metadata["subscription"];let c=scope.config;
        let valid=(||->Result<u64>{
            if integer(&frame["version"],1,1)?!=1||frame["id"].as_str()!=Some(c.key.text())||
                integer(&frame["generation"],1,MAX_SAFE)?!=c.generation||
                integer(&frame["captureOrdinal"],1,MAX_SAFE)?!=stamp.identity.ordinal||
                integer(&frame["pageEpoch"],1,MAX_SAFE)?!=c.epoch||
                integer(&frame["viewportVersion"],1,MAX_SAFE)?!=c.viewport||
                integer(&frame["cssWidth"],1,4096)?!=c.width as u64||
                integer(&frame["cssHeight"],1,4096)?!=c.height as u64{return Err(INVALID.into());}
            let producer=metadata["producer"].as_str().ok_or(INVALID)?;
            let(pid,host)=producer.split_once(':').ok_or(INVALID)?;
            if pid.parse::<u32>().ok().is_none_or(|n|n==0)||host.parse::<u32>().ok()!=Some(c.host){return Err(INVALID.into());}
            integer(&metadata["frameToken"],1,u32::MAX as u64)?;
            integer(&metadata["sourceFrame"],c.source_floor as u64,i32::MAX as u64)?;
            let input=integer(&frame["inputSeq"],scope.input,scope.allowed_input)?;
            if metadata["captureId"].as_str()!=Some(stamp.identity.id().as_str())||
                !metadata["resourcesComplete"].is_boolean(){return Err(INVALID.into());}
            Ok(input)
        })();
        let Ok(input)=valid else{drop(s);drop(resources);self.fail(stamp,INVALID,Outcome::Pause);return false;};
        if let Some(error)=metadata["error"].as_str(){
            let reason=if metadata["code"]=="RESOURCE_BUDGET_PRESSURE"{crate::budget::PRESSURE}
                else if metadata["code"]=="NATIVE_SUBSCRIPTION_TARGET_CHANGED"{TARGET_CHANGED}
                else if error.len()>4096{"Native subscription error limit"}else{"Native subscription encoding failed"};
            drop(s);drop(resources);self.fail(stamp,reason,Outcome::Pause);return false;
        }
        scope.input=input;scope.job.as_mut().unwrap().resources=Some(resources);
        drop(s);self.wake.notify();true
    }
    pub fn scene(&self,stamp:Stamp,scene:ScenePacket)->bool{
        if let Some(error)=&scene.error{
            let (reason,outcome)=if error=="Captured compositor frame superseded before aggregation"{
                ("Captured compositor frame superseded before aggregation",Outcome::Retry)
            }else{("Native subscription Viz failed",Outcome::Pause)};
            drop(scene);self.fail(stamp,reason,outcome);return false;
        }
        let mut s=self.state.lock().unwrap();let Some(scope)=matched(&mut s,stamp)else{return false;};
        if !scope.enabled||scope.retiring{return false;}
        if scene.root!=[0.,0.,scope.config.width as f64,scope.config.height as f64]{
            drop(s);drop(scene);self.fail(stamp,TARGET_CHANGED,Outcome::Pause);return false;
        }
        scope.job.as_mut().unwrap().scene=Some(scene);drop(s);self.wake.notify();true
    }
    pub fn take(self:&Arc<Self>)->Option<Work>{
        let mut s=self.state.lock().unwrap();
        for offset in 0..SLOTS{
            let index=(s.cursor+offset)%SLOTS;
            let Some(scope)=s.scopes[index].as_mut()else{continue;};
            let Some(job)=scope.job.as_mut()else{continue;};
            if !scope.enabled||scope.retiring||job.mapping||job.resources.is_none()||job.scene.is_none(){continue;}
            job.mapping=true;
            let stamp=Stamp{identity:job.identity,slot:index,serial:scope.serial};
            let work=Work{scene:job.scene.take(),resources:job.resources.take(),
                config:scope.config,input:scope.input,stamp,owner:self.clone(),finished:false,mapped:None};
            s.cursor=(index+1)%SLOTS;return Some(work);
        }None
    }
    fn valid(&self,stamp:Stamp)->bool{
        let mut s=self.state.lock().unwrap();
        if stamp.serial!=s.active_serial||stamp.identity.ordinal<=s.published_ordinal{return false;}
        matched(&mut s,stamp).is_some_and(|scope|scope.enabled&&!scope.retiring&&
            scope.job.as_ref().is_some_and(|j|j.deadline>Instant::now()&&j.connection.as_ref().is_some_and(|c|c.active())))
    }
    // The short publish closure must not perform parsing, encoding or IO.
    // Revocation uses this same lock, making the final publication fence real.
    fn publish<T>(&self,stamp:Stamp,publish:impl FnOnce()->T)->Option<T>{
        let mut s=self.state.lock().unwrap();
        if stamp.serial!=s.active_serial||stamp.identity.ordinal<=s.published_ordinal{return None;}
        let scope=matched(&mut s,stamp)?;
        if !scope.enabled||scope.retiring||scope.job.as_ref()?.deadline<=Instant::now()||
            scope.job.as_ref()?.connection.as_ref().is_none_or(|c|!c.active())||
            !scope.job.as_ref()?.mapping||scope.job.as_ref()?.published{return None;}
        let result=publish();scope.job.as_mut()?.published=true;s.published_ordinal=stamp.identity.ordinal;Some(result)
    }
    pub fn fail(&self,stamp:Stamp,reason:&'static str,outcome:Outcome){
        let mut s=self.state.lock().unwrap();let Some(scope)=matched(&mut s,stamp)else{return;};
        if scope.job.as_ref().unwrap().mapping{
            scope.enabled=false;drop(s);emit_failure(stamp.identity,reason,Outcome::Pause);self.wake.notify();return;
        }
        let job=scope.job.take().unwrap();let outcome=if outcome==Outcome::Retry{
            scope.retries=scope.retries.saturating_add(1);if scope.retries>=3{Outcome::Pause}else{Outcome::Retry}
        }else{outcome};
        if outcome==Outcome::Pause{scope.enabled=false;}
        let connection=job.connection.clone();
        if connection.is_none(){scope.receipt=Some((stamp.identity,outcome));}
        drop(s);drop(job);
        if let Some(connection)=connection{connection.send(stamp.identity,outcome);}
        emit_failure(stamp.identity,reason,outcome);self.wake.notify();
    }
    pub fn cancel(&self,key:Key)->bool{
        let mut s=self.state.lock().unwrap();
        let Some(index)=s.scopes.iter().position(|v|v.as_ref().is_some_and(|v|v.config.key==key))else{return false;};
        let scope=s.scopes[index].as_mut().unwrap();scope.enabled=false;scope.retiring=true;
        if scope.job.as_ref().is_some_and(|j|j.mapping){drop(s);self.wake.notify();return true;}
        let retired=s.scopes[index].take().unwrap();remember_retired(&mut s,retired.config);
        drop(s);
        if let Some(job)=retired.job{
            let connection=job.connection.clone();let identity=job.identity;drop(job);
            if let Some(connection)=connection{connection.send(identity,Outcome::Pause);}
        }
        self.wake.notify();true
    }
    pub fn expire(&self,now:Instant){
        let stamps={
            let s=self.state.lock().unwrap();let mut out=[None;SLOTS];
            for(i,scope)in s.scopes.iter().enumerate(){if let Some(scope)=scope{
                if scope.job.as_ref().is_some_and(|j|!j.mapping&&j.deadline<=now){
                    out[i]=Some(Stamp{identity:scope.job.as_ref().unwrap().identity,slot:i,serial:scope.serial});
                }
            }}out
        };
        for stamp in stamps.into_iter().flatten(){self.fail(stamp,PAIR_EXPIRED,Outcome::Pause);}
    }
    pub fn fault(&self,reason:&'static str){
        let stamps={
            let s=self.state.lock().unwrap();
            std::array::from_fn::<_,SLOTS,_>(|i|{
                let scope=s.scopes[i].as_ref()?;let job=scope.job.as_ref()?;
                (!job.mapping&&(job.scene.is_none()||job.resources.is_none()))
                    .then_some(Stamp{identity:job.identity,slot:i,serial:scope.serial})
            })
        };
        for stamp in stamps.into_iter().flatten(){self.fail(stamp,reason,Outcome::Pause);}
    }
    pub fn connection_closed(&self,connection:&Arc<Connection>){
        let stamps={
            let s=self.state.lock().unwrap();
            std::array::from_fn::<_,SLOTS,_>(|i|{
                let scope=s.scopes[i].as_ref()?;let job=scope.job.as_ref()?;
                (scope.enabled&&!scope.retiring&&job.connection.as_ref().is_some_and(|c|Arc::ptr_eq(c,connection)))
                    .then_some(Stamp{identity:job.identity,slot:i,serial:scope.serial})
            })
        };
        for stamp in stamps.into_iter().flatten(){self.fail(stamp,"Native resource connection closed",Outcome::Pause);}
    }
    pub fn cancel_all(&self){
        let keys={let s=self.state.lock().unwrap();std::array::from_fn::<_,SLOTS,_>(|i|s.scopes[i].as_ref().map(|s|s.config.key))};
        for key in keys.into_iter().flatten(){self.cancel(key);}
    }
    pub fn stop(&self){
        let keys={let mut s=self.state.lock().unwrap();s.stopped=true;
            std::array::from_fn::<_,SLOTS,_>(|i|s.scopes[i].as_ref().map(|s|s.config.key))};
        for key in keys.into_iter().flatten(){self.cancel(key);}
        let admission={let mut s=self.state.lock().unwrap();release_stopped(&mut s)};
        drop(admission);
    }
    fn finish(&self,stamp:Stamp,outcome:Outcome)->Outcome{
        let mut s=self.state.lock().unwrap();let Some(scope)=matched(&mut s,stamp)else{return Outcome::Pause;};
        let outcome=if !scope.enabled||scope.retiring||
            outcome==Outcome::Consumed&&!scope.job.as_ref().unwrap().published{Outcome::Pause}else{outcome};
        if outcome==Outcome::Consumed{scope.retries=0;}else{
            scope.retries=scope.retries.saturating_add(1);
            if outcome==Outcome::Pause||scope.retries>=3{scope.enabled=false;}
        }
        let outcome=if !scope.enabled{Outcome::Pause}else{outcome};
        let job=scope.job.take().unwrap();let retiring=scope.retiring;
        if retiring{let old=s.scopes[stamp.slot].take().unwrap();remember_retired(&mut s,old.config);}
        let admission=release_stopped(&mut s);
        drop(s);
        if let Some(connection)=job.connection{connection.send(stamp.identity,outcome);}
        drop(admission);
        self.wake.notify();
        outcome
    }
}
fn release_stopped(s:&mut State)->Option<Lease>{
    if s.stopped&&s.scopes.iter().all(Option::is_none){s.retired=[None;SLOTS];s._admission.take()}else{None}
}
fn remember_retired(s:&mut State,config:Config){let index=s.retired_cursor%SLOTS;s.retired[index]=Some((config,Instant::now()+Duration::from_secs(10)));s.retired_cursor=(index+1)%SLOTS;}
fn matched(s:&mut State,stamp:Stamp)->Option<&mut Scope>{
    let scope=s.scopes.get_mut(stamp.slot)?.as_mut()?;
    (scope.serial==stamp.serial&&scope.config.key==stamp.identity.key&&
        scope.job.as_ref().is_some_and(|j|j.identity==stamp.identity)).then_some(scope)
}
fn summary(s:&Scope)->Value{
    json!({"id":s.config.key.text(),"generation":s.config.generation,"ordinalBase":s.config.base,
        "ordinalLimit":s.config.limit,"lastStarted":s.last,"inputSeq":s.allowed_input,"enabled":s.enabled,
        "retiring":s.retiring,"inflight":s.job.is_some(),"mapping":s.job.as_ref().is_some_and(|j|j.mapping)})
}
fn emit_failure(identity:Identity,reason:&str,outcome:Outcome){
    if reason==INACTIVE{return;}
    use crate::output::{Event,EventField::{Text,MaybeText}};
    let id=identity.id();let code=crate::error_code(reason).or_else(||match reason{
        TARGET_CHANGED=>Some("NATIVE_SUBSCRIPTION_TARGET_CHANGED"),PAIR_EXPIRED=>Some("NATIVE_SUBSCRIPTION_TIMEOUT"),
        "Captured compositor frame superseded before aggregation"=>Some("VIZ_CAPTURE_SUPERSEDED"),_=>Some("NATIVE_SUBSCRIPTION_FAILED")});
    crate::emit(Event("NativeFrameRejected",&[("captureId",Text(&id)),("code",MaybeText(code)),
        ("outcome",Text(if outcome==Outcome::Retry{"retry"}else{"pause"})),("reason",Text(reason))]));
}
pub struct Work{
    pub scene:Option<ScenePacket>,pub resources:Option<NativeResources>,
    pub config:Config,pub input:u64,pub stamp:Stamp,owner:Arc<Subscriptions>,finished:bool,mapped:Option<u64>,
}
impl Work{
    pub fn valid(&self)->bool{self.owner.valid(self.stamp)}
    pub fn map(&mut self,mapper:&mut crate::scene::Mapper,expansion:&crate::capture_expansion::Pool)->Result<Arc<crate::scene::Snapshot>>{
        let scene=self.scene.take().ok_or("Native work already prepared")?;
        let graph=self.owner.input.0.reserve(scene.graph_bytes)?;
        let viz=crate::viz::decode(&scene.bytes)?;drop(scene);
        let resources=self.resources.as_mut().ok_or("Missing native work resources")?;
        resources.admission.push(graph);
        resources.metadata["viz"]=viz;
        resources.metadata["captureOrdinal"]=json!(self.stamp.identity.ordinal);
        let capture=crate::capture_expansion::expand(resources.metadata.take(),expansion)?;
        let viewport=json!({"cssWidth":self.config.width,"cssHeight":self.config.height,"deviceScaleFactor":1});
        let snapshot=mapper.map_admitted(&capture,self.config.epoch,&viewport,self.config.viewport,
            self.input,std::mem::take(&mut resources.blocks))?;
        self.mapped=Some(snapshot.serial);Ok(snapshot)
    }
    pub fn publish<T>(&self,snapshot:&crate::scene::Snapshot,publish:impl FnOnce()->T)->Option<T>{
        let m=&snapshot.metadata;
        if self.mapped!=Some(snapshot.serial)||
            m["native"]["captureId"].as_str()!=Some(self.stamp.identity.id().as_str())||
            m["native"]["captureOrdinal"].as_u64()!=Some(self.stamp.identity.ordinal)||
            m["pageEpoch"].as_u64()!=Some(self.config.epoch)||
            m["viewportVersion"].as_u64()!=Some(self.config.viewport)||
            m["lastProcessedInputSeq"].as_u64()!=Some(self.input){return None;}
        self.owner.publish(self.stamp,publish)
    }
    pub fn reject(self,reason:&str,outcome:Outcome){
        let identity=self.stamp.identity;let outcome=self.finish(outcome);emit_failure(identity,reason,outcome);
    }
    pub fn finish(mut self,outcome:Outcome)->Outcome{
        // Destroy original scene/raw/native input graphs before returning job
        // credit. Mapped Snapshot aliases keep their own independent leases.
        drop(self.scene.take());drop(self.resources.take());
        let outcome=self.owner.finish(self.stamp,outcome);self.finished=true;outcome
    }
}
#[cfg(test)]mod tests{
    use super::*;
    use std::{io::Read,sync::atomic::{AtomicU64,Ordering},thread};
    pub(crate) fn config(n:u8,base:u64)->Config{
        Config{key:Key::parse(&std::iter::repeat_n(n as char,32).collect::<String>()).unwrap(),
            generation:1,base,limit:base+7,epoch:1,viewport:1,initial_input:0,width:100,height:100,host:2,source_floor:0}
    }
    pub(crate) fn metadata(c:Config,n:u64)->Value{
        json!({"captureId":format!("{}:{n}",c.key.text()),"producer":"7:2","frameToken":1.0,"sourceFrame":0,
            "resources":[],"resourcesComplete":true,"nativeResources":true,"subscription":{
                "version":1,"id":c.key.text(),"generation":c.generation as f64,"captureOrdinal":n as f64,
                "pageEpoch":c.epoch as f64,"viewportVersion":c.viewport as f64,"inputSeq":c.initial_input as f64,
                "cssWidth":c.width,"cssHeight":c.height}})
    }
    pub(crate) fn rpa(metadata:&Value)->Vec<u8>{
        let mut p=b"RPA2\x01\x01".to_vec();let text=metadata.to_string();
        for s in [metadata["captureId"].as_str().unwrap(),text.as_str()]{p.extend((s.len()as u32).to_be_bytes());p.extend(s.as_bytes());}
        p.extend(0u32.to_be_bytes());p
    }
    pub(crate) fn rvb(id:&str,width:f64,error:Option<&str>,quads:usize)->Vec<u8>{
        fn text(p:&mut Vec<u8>,s:&str){p.extend((s.len()as u32).to_be_bytes());p.extend(s.as_bytes());}
        fn numbers(p:&mut Vec<u8>,a:&[f64]){for n in a{p.extend(n.to_be_bytes());}}
        let mut p=b"RVB2\x01\x01".to_vec();text(&mut p,id);p.extend(1u32.to_be_bytes());p.extend(2u32.to_be_bytes());
        p.extend(1u32.to_be_bytes());text(&mut p,"root");numbers(&mut p,&[0.,0.,width,100.]);p.extend((quads as u32).to_be_bytes());
        for _ in 0..quads{
            p.push(1);for n in [1u32,1,2]{p.extend(n.to_be_bytes());}
            numbers(&mut p,&[1.,0.,0.,0.,1.,0.,0.,0.,1.]);numbers(&mut p,&[0.,0.,width,100.]);
            numbers(&mut p,&[0.,0.,width,100.]);numbers(&mut p,&[0.,0.]);numbers(&mut p,&[1.]);
            p.extend([0,0]);p.extend(0u32.to_be_bytes());numbers(&mut p,&[0.1,0.2,0.3,1.]);
        }
        p.push(u8::from(error.is_some()));if let Some(error)=error{text(&mut p,error);}p
    }
    fn owned(pool:&InputPool,bytes:&[u8])->OwnedVec{
        let mut out=pool.packet(bytes.len()).unwrap();out.initialized().copy_from_slice(bytes);out
    }
    fn registry()->Arc<Subscriptions>{
        Arc::new(Subscriptions::new(InputPool::new(256*1024*1024),Arc::new(Wake::default())))
    }
    fn connection()->(Arc<Connection>,UnixStream){
        let(server,client)=UnixStream::pair().unwrap();client.set_read_timeout(Some(Duration::from_millis(30))).unwrap();
        (Arc::new(Connection::new(server)),client)
    }
    fn receipt(client:&mut UnixStream,identity:Identity,outcome:Outcome){
        // Credit is synchronously queued before finish returns. Changing
        // SO_RCVTIMEO after the socketpair peer closed fails on Darwin.
        let mut bytes=[0;56];client.read_exact(&mut bytes).unwrap();assert_eq!(bytes,identity.credit(outcome));
    }
    fn no_receipt(client:&mut UnixStream){
        client.set_read_timeout(Some(Duration::from_millis(30))).unwrap();
        let mut b=[0];assert!(client.read(&mut b).is_err());
    }
    fn pair(book:&Arc<Subscriptions>,c:Config,n:u64,resource_first:bool)->(Work,UnixStream){
        let id=format!("{}:{n}",c.key.text());let(connection,client)=connection();
        let raw=book.reserve(&id,Kind::Resources,Some(connection),true).unwrap().unwrap();
        let scene=book.reserve(&id,Kind::Scene,None,true).unwrap().unwrap();
        let resources=crate::viz::decode_resources(&rpa(&metadata(c,n)),&book.input,&crate::budget::Budget::new(crate::budget::DEFAULT_BYTES)).unwrap();
        let bytes=owned(&book.input,&rvb(&id,100.,None,1));let value=crate::viz::native_scene_packet(bytes).unwrap();
        if resource_first{assert!(book.resources(raw,resources));assert!(book.scene(scene,value));}
        else{assert!(book.scene(scene,value));assert!(book.resources(raw,resources));}
        (book.take().unwrap(),client)
    }
    fn map(work:&mut Work,mapper:&mut crate::scene::Mapper)->Arc<crate::scene::Snapshot>{
        work.map(mapper,&crate::capture_expansion::Pool::new(crate::capture_expansion::DEFAULT_BYTES)).unwrap()
    }
    #[test]fn safe_native_doubles_and_unsafe_numbers_are_distinguished_before_rounding(){
        for value in [json!(7),json!(7.0)]{assert_eq!(integer(&value,1,MAX_SAFE).unwrap(),7);}
        for value in [json!(-1),json!(0.5),json!(MAX_SAFE+1),json!(u64::MAX),json!(9_007_199_254_740_992f64),Value::Null,json!("7")]{assert!(integer(&value,0,MAX_SAFE).is_err());}
        assert!(Identity::from_id(&format!("{}:01","a".repeat(32))).is_none());
        assert!(Identity::from_id(&format!("{}:9007199254740992","a".repeat(32))).is_none());
    }
    #[test]fn ordinal_reservations_capacity_and_replay_never_roll_back(){
        let b=registry();
        for n in 0..SLOTS{b.register(config(b'a'+n as u8,n as u64*8)).unwrap();}
        assert_eq!(b.register(config(b'e',32)).err().unwrap(),LIMIT);
        let c=config(b'a',0);assert_eq!(b.register(c).unwrap()["lastStarted"],0);
        assert!(b.policy(c.key,7,true).is_ok());assert!(b.policy(c.key,6,true).is_err());
        assert_eq!(b.register(c).unwrap()["inputSeq"],7);
        b.cancel(c.key);assert!(b.register(c).is_err());assert!(b.register(config(b'e',0)).is_err());
        let mut next=config(b'e',32);next.initial_input=7;b.register(next).unwrap();assert_eq!(b.stats()["registered"],4);
        assert_eq!(b.stats()["registryBytes"],REGISTRY_BYTES);assert!(std::mem::size_of::<State>()<REGISTRY_BYTES);
    }
    #[test]fn unknown_scopes_and_four_busy_scopes_cannot_admit_a_fifth_job(){
        let b=registry();let unknown=format!("{}:1","a".repeat(32));
        assert!(b.reserve(&unknown,Kind::Scene,None,true).unwrap().unwrap_err().identity.is_none());
        for n in 0..SLOTS{
            let c=config(b'a'+n as u8,n as u64*8);b.register(c).unwrap();
            let id=format!("{}:{}",c.key.text(),c.base+1);b.reserve(&id,Kind::Scene,None,true).unwrap().unwrap();
            let next=format!("{}:{}",c.key.text(),c.base+2);
            assert_eq!(b.reserve(&next,Kind::Scene,None,true).unwrap().unwrap_err().reason,LIMIT);
        }
        assert_eq!(b.inflight(),4);assert!(b.take().is_none());
    }
    #[test]fn both_packet_orders_require_real_mapping_publication_and_final_credit(){
        for first in [false,true]{
            let b=registry();let c=config(b'a',0);b.register(c).unwrap();let(mut work,mut client)=pair(&b,c,1,first);
            no_receipt(&mut client);let mut mapper=crate::scene::Mapper::new();let snapshot=map(&mut work,&mut mapper);
            no_receipt(&mut client);assert_eq!(snapshot.metadata["native"]["captureOrdinal"],1);
            assert_eq!(work.publish(&snapshot,||41),Some(41));assert_eq!(work.publish(&snapshot,||42),None);
            no_receipt(&mut client);let identity=work.stamp.identity;work.finish(Outcome::Consumed);
            receipt(&mut client,identity,Outcome::Consumed);assert_eq!(b.inflight(),0);
            assert_eq!(b.reserve(&identity.id(),Kind::Scene,None,true).unwrap().unwrap_err().reason,"Replayed native subscription frame");
        }
    }
    #[test]fn consumed_without_publication_and_dropped_work_fail_closed(){
        for drop_work in [false,true]{
            let b=registry();let c=config(b'a',0);b.register(c).unwrap();let(work,mut client)=pair(&b,c,1,true);
            let identity=work.stamp.identity;
            if drop_work{drop(work);}else{work.finish(Outcome::Consumed);}
            receipt(&mut client,identity,Outcome::Pause);assert_eq!(b.inflight(),0);
            assert_eq!(b.stats()["subscriptions"][0]["enabled"],false);
        }
    }
    #[test]fn cancellation_during_mapping_fences_publication_and_keeps_slot_until_drop(){
        let b=registry();let c=config(b'a',0);b.register(c).unwrap();let(mut work,mut client)=pair(&b,c,1,true);
        let mut mapper=crate::scene::Mapper::new();let snapshot=map(&mut work,&mut mapper);
        assert!(b.cancel(c.key));assert_eq!(b.inflight(),1);assert_eq!(work.publish(&snapshot,||panic!("revoked publication")),None::<()>);
        let identity=work.stamp.identity;no_receipt(&mut client);work.finish(Outcome::Consumed);
        receipt(&mut client,identity,Outcome::Pause);assert_eq!(b.stats()["registered"],0);
        let late=b.reserve(&identity.id(),Kind::Resources,Some(connection().0),true).unwrap().unwrap_err();
        assert_eq!(late.identity,Some(identity));assert_eq!(late.outcome,Outcome::Pause);
    }
    #[test]fn new_registration_fences_an_older_already_mapped_frame(){
        let b=registry();let old=config(b'a',0);b.register(old).unwrap();
        let(mut work,mut client)=pair(&b,old,1,true);let mut mapper=crate::scene::Mapper::new();
        let snapshot=map(&mut work,&mut mapper);let mut next=config(b'b',8);next.epoch=2;
        b.register(next).unwrap();assert_eq!(work.publish(&snapshot,||panic!("old target published")),None::<()>);
        let identity=work.stamp.identity;work.finish(Outcome::Consumed);receipt(&mut client,identity,Outcome::Pause);
        let(mut fresh,mut client)=pair(&b,next,9,true);let snapshot=map(&mut fresh,&mut mapper);
        assert!(fresh.publish(&snapshot,||()).is_some());let identity=fresh.stamp.identity;
        fresh.finish(Outcome::Consumed);receipt(&mut client,identity,Outcome::Consumed);
        assert_eq!(b.stats()["lastPublishedOrdinal"],9);
    }
    #[test]fn supersession_before_resources_has_a_bounded_exact_retry_receipt(){
        let b=registry();let c=config(b'a',0);b.register(c).unwrap();let id=format!("{}:1",c.key.text());
        let stamp=b.reserve(&id,Kind::Scene,None,true).unwrap().unwrap();
        let scene=crate::viz::native_scene_packet(owned(&b.input,&rvb(&id,100.,Some("Captured compositor frame superseded before aggregation"),1))).unwrap();
        assert!(!b.scene(stamp,scene));assert_eq!(b.inflight(),0);
        let rejected=b.reserve(&id,Kind::Resources,Some(connection().0),true).unwrap().unwrap_err();
        assert_eq!(rejected.outcome,Outcome::Retry);assert_eq!(rejected.identity,Some(stamp.identity));
        assert_eq!(b.stats()["subscriptions"][0]["enabled"],true);
    }
    #[test]fn aggregate_root_change_and_untrusted_watermarks_are_never_published(){
        for bad in 0..5{
            let b=registry();let c=config(b'a',0);b.register(c).unwrap();let id=format!("{}:1",c.key.text());
            let(connection,mut client)=connection();
            let stamp=b.reserve(&id,Kind::Resources,Some(connection),true).unwrap().unwrap();
            let mut m=metadata(c,1);
            if bad==0{m["subscription"]["inputSeq"]=json!(1.0);}
            if bad==1{m["subscription"]["pageEpoch"]=json!(2.0);}
            if bad==2{m["subscription"]["generation"]=json!(2.0);}
            if bad==3{m["producer"]=json!("7:99");}
            let resources=crate::viz::decode_resources(&rpa(&m),&b.input,&crate::budget::Budget::new(crate::budget::DEFAULT_BYTES)).unwrap();
            if bad<4{assert!(!b.resources(stamp,resources));}else{
                assert!(b.resources(stamp,resources));let scene=b.reserve(&id,Kind::Scene,None,true).unwrap().unwrap();
                assert!(!b.scene(scene,crate::viz::native_scene_packet(owned(&b.input,&rvb(&id,101.,None,1))).unwrap()));
            }
            receipt(&mut client,stamp.identity,Outcome::Pause);assert!(b.take().is_none());assert_eq!(b.inflight(),0);
        }
    }
    #[test]fn policy_pause_retires_queued_owners_and_timeout_does_not_touch_a_complete_mapping(){
        let b=registry();let c=config(b'a',0);b.register(c).unwrap();let(work,mut client)=pair(&b,c,1,true);
        b.expire(Instant::now()+Duration::from_secs(10));assert_eq!(b.inflight(),1);
        b.policy(c.key,0,false).unwrap();assert_eq!(b.inflight(),1);
        let identity=work.stamp.identity;drop(work);receipt(&mut client,identity,Outcome::Pause);
        b.policy(c.key,0,true).unwrap();
        let id=format!("{}:2",c.key.text());let(connection,mut client)=connection();
        let stamp=b.reserve(&id,Kind::Resources,Some(connection),true).unwrap().unwrap();
        let resources=crate::viz::decode_resources(&rpa(&metadata(c,2)),&b.input,&crate::budget::Budget::new(crate::budget::DEFAULT_BYTES)).unwrap();b.resources(stamp,resources);
        b.policy(c.key,0,false).unwrap();receipt(&mut client,stamp.identity,Outcome::Pause);assert_eq!(b.inflight(),0);
    }
    #[test]fn dense_binary_scene_is_admitted_before_decoder_allocations_and_pressure_returns_owners(){
        let b=registry();let c=config(b'a',0);b.register(c).unwrap();
        let id=format!("{}:1",c.key.text());let(connection,_client)=connection();
        let r=b.reserve(&id,Kind::Resources,Some(connection),true).unwrap().unwrap();
        b.resources(r,crate::viz::decode_resources(&rpa(&metadata(c,1)),&b.input,&crate::budget::Budget::new(crate::budget::DEFAULT_BYTES)).unwrap());
        let s=b.reserve(&id,Kind::Scene,None,true).unwrap().unwrap();
        let bytes=rvb(&id,100.,None,1024);assert!(bytes.len()<256*1024);
        let scene=crate::viz::native_scene_packet(owned(&b.input,&bytes)).unwrap();let charge=scene.graph_bytes;
        let(value,peak)=crate::allocation_probe::measure(||crate::viz::decode(&scene.bytes).unwrap());
        assert!(peak<=charge);assert_eq!(value["passes"][0]["quads"].as_array().unwrap().len(),1024);drop(value);
        assert!(b.scene(s,scene));let mut work=b.take().unwrap();
        let held=b.input.0.reserve(b.input.0.limit()-b.input.0.used()-65536).unwrap();
        let mut mapper=crate::scene::Mapper::new();assert_eq!(work.map(&mut mapper,&crate::capture_expansion::Pool::new(crate::capture_expansion::DEFAULT_BYTES)).err().unwrap(),crate::input::PRESSURE);
        drop(held);drop(work);assert_eq!(b.input.0.used(),REGISTRY_BYTES);
    }
    #[test]fn real_viz_socket_pairs_native_data_and_writes_credit_only_after_actual_mapper_commit(){
        static NEXT:AtomicU64=AtomicU64::new(0);
        let directory=std::env::temp_dir().join(format!("remote-paint-native-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));
        std::fs::create_dir(&directory).unwrap();let path=directory.join("viz.sock");
        let input=InputPool::new(crate::input::DEFAULT_BYTES);let budget=crate::budget::Budget::new(crate::budget::DEFAULT_BYTES);
        let viz=crate::viz::Viz::start(path.to_str().unwrap(),input.clone(),budget).unwrap();
        let c=config(b'a',0);viz.register_native(c).unwrap();
        let mut raw=UnixStream::connect(&path).unwrap();let mut scene=UnixStream::connect(&path).unwrap();
        let rp=rpa(&metadata(c,1));raw.write_all(&(rp.len()as u32).to_be_bytes()).unwrap();raw.write_all(&rp).unwrap();
        let sp=rvb(&format!("{}:1",c.key.text()),100.,None,1);scene.write_all(&(sp.len()as u32).to_be_bytes()).unwrap();scene.write_all(&sp).unwrap();
        let end=Instant::now()+Duration::from_secs(2);
        let mut work=loop{if let Some(work)=viz.native.take(){break work;}assert!(Instant::now()<end);thread::sleep(Duration::from_millis(1));};
        no_receipt(&mut raw);let mut mapper=crate::scene::Mapper::new();let snapshot=map(&mut work,&mut mapper);
        let mut history=crate::history::History::default();assert!(work.publish(&snapshot,||history.insert(snapshot.clone())).is_some());
        let identity=work.stamp.identity;work.finish(Outcome::Consumed);receipt(&mut raw,identity,Outcome::Consumed);
        assert_eq!(history.latest.as_ref().unwrap().metadata["native"]["captureOrdinal"],1);
        drop(raw);drop(scene);viz.stop();std::fs::remove_file(path).unwrap();std::fs::remove_dir(directory).unwrap();
    }
    #[test]fn partial_timeout_and_writer_fault_preserve_definitive_receipt_and_complete_work(){
        let b=registry();let c=config(b'a',0);b.register(c).unwrap();
        for (ordinal,timeout) in [(1,true),(2,false)]{
            let id=format!("{}:{ordinal}",c.key.text());let(connection,mut client)=connection();
            let stamp=b.reserve(&id,Kind::Resources,Some(connection),true).unwrap().unwrap();
            let resources=crate::viz::decode_resources(&rpa(&metadata(c,ordinal)),&b.input,&crate::budget::Budget::new(crate::budget::DEFAULT_BYTES)).unwrap();
            b.resources(stamp,resources);
            if timeout{b.expire(Instant::now()+Duration::from_secs(6));}
            else{b.fault(crate::viz::OUTPUT_OVERLOAD);}
            receipt(&mut client,stamp.identity,Outcome::Pause);assert_eq!(b.inflight(),0);
            assert_eq!(b.input.0.used(),REGISTRY_BYTES);b.policy(c.key,0,true).unwrap();
        }
        let(mut work,mut client)=pair(&b,c,3,true);b.fault(crate::viz::OUTPUT_TRANSPORT);
        assert!(work.valid());let mut mapper=crate::scene::Mapper::new();let snapshot=map(&mut work,&mut mapper);
        assert!(work.publish(&snapshot,||()).is_some());let identity=work.stamp.identity;work.finish(Outcome::Consumed);
        receipt(&mut client,identity,Outcome::Consumed);
    }
    #[test]fn stop_keeps_mapping_owners_until_drain_and_then_returns_the_registry_admission(){
        let b=registry();let c=config(b'a',0);b.register(c).unwrap();let(work,mut client)=pair(&b,c,1,true);
        let identity=work.stamp.identity;b.stop();assert!(!work.valid());assert!(b.input.0.used()>REGISTRY_BYTES);
        no_receipt(&mut client);drop(work);receipt(&mut client,identity,Outcome::Pause);
        assert_eq!(b.inflight(),0);assert_eq!(b.input.0.used(),0);assert!(b.register(config(b'b',8)).is_err());
    }
    #[test]fn producer_eof_fences_a_complete_pair_and_releases_its_input_after_worker_drop(){
        let b=registry();let c=config(b'a',0);b.register(c).unwrap();let(work,_client)=pair(&b,c,1,true);
        let connection=b.state.lock().unwrap().scopes[0].as_ref().unwrap().job.as_ref().unwrap().connection.clone().unwrap();
        connection.close();b.connection_closed(&connection);assert!(!work.valid());
        drop(work);assert_eq!(b.inflight(),0);assert_eq!(b.input.0.used(),REGISTRY_BYTES);
        assert_eq!(b.stats()["subscriptions"][0]["enabled"],false);
    }
    #[test]fn unknown_and_revoked_native_payloads_are_drained_without_resource_or_json_admission(){
        static NEXT:AtomicU64=AtomicU64::new(0);
        let directory=std::env::temp_dir().join(format!("remote-paint-rejected-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));
        std::fs::create_dir(&directory).unwrap();let path=directory.join("viz.sock");
        let input=InputPool::new(1024*1024);let budget=crate::budget::Budget::new(crate::budget::DEFAULT_BYTES);
        let viz=crate::viz::Viz::start(path.to_str().unwrap(),input.clone(),budget.clone()).unwrap();let c=config(b'a',0);
        let mut packet_metadata=metadata(c,1);packet_metadata["padding"]=json!("x".repeat(512*1024));
        let bytes=rpa(&packet_metadata);let mut raw=UnixStream::connect(&path).unwrap();
        raw.write_all(&(bytes.len()as u32).to_be_bytes()).unwrap();raw.write_all(&bytes).unwrap();
        // An authorized tiny legacy packet on the same stream is a real
        // processing barrier after the rejected large native packet.
        viz.expect("barrier",false).unwrap();let barrier=rvb("barrier",100.,None,1);
        raw.write_all(&(barrier.len()as u32).to_be_bytes()).unwrap();raw.write_all(&barrier).unwrap();
        let end=Instant::now()+Duration::from_secs(2);
        loop{if viz.take("barrier").is_ok(){break;}assert!(Instant::now()<end);thread::sleep(Duration::from_millis(1));}
        assert!(input.0.stats()["peak"].as_u64().unwrap()<65536);assert_eq!(budget.used(),0);
        viz.register_native(c).unwrap();viz.native.cancel(c.key);
        raw.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        raw.write_all(&(bytes.len()as u32).to_be_bytes()).unwrap();raw.write_all(&bytes).unwrap();
        receipt(&mut raw,Identity{key:c.key,ordinal:1,generation:1},Outcome::Pause);
        assert_eq!(input.0.used(),REGISTRY_BYTES);assert_eq!(input.0.stats()["peak"],REGISTRY_BYTES);
        assert_eq!(budget.used(),0);drop(raw);viz.stop();assert_eq!(input.0.used(),0);
        std::fs::remove_file(path).unwrap();std::fs::remove_dir(directory).unwrap();
    }
}
impl Drop for Work{
    fn drop(&mut self){
        if !self.finished{
            drop(self.scene.take());drop(self.resources.take());
            self.owner.finish(self.stamp,Outcome::Pause);
        }
    }
}
