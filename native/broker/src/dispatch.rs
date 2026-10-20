// Stdin framing/control runs independently of the single Mapper owner. The
// fixed queue transfers the original admitted request, including its lease.
use crate::{gateway::Gateway,input::InputPool,rpc::{ParsedRequest,RpcInput},subscriptions::{self,Wake},viz::Viz};
use serde_json::{Value,json};
use std::{io::Read,sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,Ordering}}};
const SLOTS:usize=4;
const BOOK_BYTES:usize=4096;
pub const FULL:&str="Broker request dispatch limit";
pub struct Queued{pub request:ParsedRequest,pub epoch:u64}
struct Requests{slots:[Option<Queued>;SLOTS],head:usize,len:usize}
impl Default for Requests{fn default()->Self{Self{slots:std::array::from_fn(|_|None),head:0,len:0}}}
impl Requests{
    fn push(&mut self,request:ParsedRequest,epoch:u64)->Result<(),ParsedRequest>{
        if self.len==SLOTS{return Err(request);}
        self.slots[(self.head+self.len)%SLOTS]=Some(Queued{request,epoch});self.len+=1;Ok(())
    }
    fn pop(&mut self)->Option<Queued>{
        if self.len==0{return None;}let request=self.slots[self.head].take();self.head=(self.head+1)%SLOTS;self.len-=1;request
    }
}
#[derive(Default)]struct Routes{viz:Option<Arc<Viz>>,gateway:Option<Arc<Gateway>>,epoch:u64}
pub struct Shared{
    requests:Mutex<Requests>,routes:Mutex<Routes>,pub wake:Arc<Wake>,
    closing:AtomicBool,serial:AtomicU64,_book:crate::budget::Lease,
}
impl Shared{
    pub fn new(rpc:&RpcInput)->Result<Arc<Self>,String>{
        assert!(std::mem::size_of::<Self>()<BOOK_BYTES);
        let book=rpc.dispatch_admission(BOOK_BYTES)?;
        Ok(Arc::new(Self{requests:Mutex::new(Requests::default()),routes:Mutex::new(Routes::default()),
            wake:Arc::new(Wake::default()),closing:AtomicBool::new(false),serial:AtomicU64::new(0),_book:book}))
    }
    pub fn pop(&self)->Option<Queued>{self.requests.lock().unwrap().pop()}
    pub fn has_requests(&self)->bool{self.requests.lock().unwrap().len!=0}
    pub fn closing(&self)->bool{self.closing.load(Ordering::Acquire)}
    pub fn serial(&self,serial:u64){self.serial.store(serial,Ordering::Release);}
    pub fn viz(&self)->Option<Arc<Viz>>{self.routes.lock().unwrap().viz.clone()}
    pub fn gateway(&self)->Option<Arc<Gateway>>{self.routes.lock().unwrap().gateway.clone()}
    pub fn set_viz(&self,viz:Arc<Viz>){
        if self.closing(){viz.stop();return;}
        self.routes.lock().unwrap().viz=Some(viz.clone());
        // EOF may race listener installation. A second check prevents a live
        // producer from escaping the synchronous shutdown publication fence.
        if self.closing(){viz.stop();}
    }
    pub fn set_gateway(&self,gateway:Arc<Gateway>,epoch:u64)->Result<(),String>{
        let mut routes=self.routes.lock().unwrap();
        if routes.epoch!=epoch||self.closing(){drop(routes);gateway.stop();return Err("Gateway start canceled".into());}
        routes.gateway=Some(gateway);Ok(())
    }
    fn revoke(&self){if let Some(v)=self.viz(){v.native.cancel_all();}}
    pub fn close(&self){
        self.closing.store(true,Ordering::Release);
        if let Some(v)=self.viz(){v.stop();}
        self.wake.notify();
    }
    fn fast(&self,request:&Value,input:&InputPool)->Option<Result<Value,String>>{
        let with_viz=|f:fn(&Viz,&Value)->Result<Value,String>|self.viz().ok_or("Viz not listening".into()).and_then(|v|f(&v,request));
        Some(match request["op"].as_str()?{
            "inputBudget"=>Ok(input.stats()),
            "registerNative"=>with_viz(|v,r|subscriptions::Config::read(&r["config"]).and_then(|c|v.register_native(c))),
            "nativePolicy"=>with_viz(|v,r|{
                let key=subscriptions::Key::parse(r["scopeId"].as_str().unwrap_or("")).ok_or(subscriptions::INVALID)?;
                let input=subscriptions::integer(&r["inputSeq"],0,subscriptions::MAX_SAFE)?;
                let enabled=r["enabled"].as_bool().ok_or(subscriptions::INVALID)?;v.native.policy(key,input,enabled)
            }),
            "cancelNative"=>with_viz(|v,r|{
                let key=subscriptions::Key::parse(r["scopeId"].as_str().unwrap_or("")).ok_or(subscriptions::INVALID)?;Ok(json!(v.native.cancel(key)))
            }),
            "nativeState"=>with_viz(|v,_|Ok(v.native.stats())),
            "cancelViz"=>{if let Some(v)=self.viz(){v.cancel(request["captureId"].as_str().unwrap_or(""));}Ok(json!(true))},
            "send"=>self.gateway().ok_or("Gateway not listening".into()).and_then(|g|g.send(request["peerId"].as_str().unwrap_or(""),&request["message"])),
            "consumerTicket"=>self.gateway().ok_or("Gateway not listening".into()).and_then(|g|{
                let kind=crate::consumers::Kind::parse(request["kind"].as_str().unwrap_or(""))?;
                let fence=crate::consumers::Fence::read(request,self.serial.load(Ordering::Acquire))?;g.consumer_ticket(kind,fence)
            }),
            "stop"=>{
                self.revoke();let g={let mut r=self.routes.lock().unwrap();r.epoch=r.epoch.saturating_add(1);r.gateway.take()};if let Some(g)=g{g.stop();}Ok(json!(true))
            },
            _=>return None,
        })
    }
    pub fn read(self:&Arc<Self>,rpc:&RpcInput,input_pool:&InputPool,input:&mut impl Read){
        loop{
            let frame=match rpc.read(input){Ok(Some(frame))=>frame,Ok(None)=>break,Err(error)=>{eprintln!("Broker input framing failed: {error}");break;}};
            match frame{
                crate::rpc::Frame::Rejected{id,error,code}=>crate::rpc_reply(&id,crate::output::Reply::Error{message:&error,code:Some(code),budget:Some("rust-rpc-input")},crate::output::Lane::Control),
                crate::rpc::Frame::Request(mut admitted)=>{
                    if let Some(result)=self.fast(&admitted.value,input_pool){
                        let id=admitted.value["id"].take();
                        match result{Ok(result)=>crate::rpc_reply(&id,crate::output::Reply::Value(&result),crate::output::Lane::Control),Err(error)=>crate::rpc_error(&id,&error)}
                        continue;
                    }
                    // Reset must revoke already mapping native work before it
                    // waits for the Mapper owner; a later map cannot publish.
                    if matches!(admitted.value["op"].as_str(),Some("reset"|"resetScene")){self.revoke();}
                    let epoch=self.routes.lock().unwrap().epoch;
                    let result=self.requests.lock().unwrap().push(admitted,epoch);
                    if let Err(mut request)=result{
                        let id=request.value["id"].take();
                        crate::rpc_reply(&id,crate::output::Reply::Error{message:FULL,code:Some("INPUT_BUDGET_PRESSURE"),budget:Some("rust-rpc-input")},crate::output::Lane::Control);
                    }else{self.wake.notify();}
                }
            }
        }
        self.close();
    }
}

// Called only by the Mapper owner. Publication is fenced under the same
// subscription lock as cancel/new registration, and credit follows real
// history/Gateway publication. No scene/resource graph crosses stdout.
pub fn native(mut work:subscriptions::Work,mapper:&mut crate::scene::Mapper,history:&mut crate::history::History,
    expansion:&crate::capture_expansion::Pool,shared:&Shared){
    use subscriptions::Outcome;
    if shared.closing()||!work.valid(){work.reject(subscriptions::INACTIVE,Outcome::Pause);return;}
    if !mapper.budget.ready(){history.reclaim();mapper.reclaim_cache();}
    else if !mapper.snapshot_pool.ready(){history.reclaim();}
    let resources=work.resources.as_ref().unwrap();
    let raw_bytes=resources.blocks.values().map(|b|b.len()as u64).sum();let raw_count=resources.blocks.len()as u64;
    let complete=resources.metadata["resourcesComplete"].as_bool().unwrap();
    let started=std::time::Instant::now();
    match work.map(mapper,expansion){
        Ok(snapshot)=>{
            let gateway=shared.gateway();
            let published=work.publish(&snapshot,||{
                history.insert(snapshot.clone());shared.serial(snapshot.serial);
                if let Some(g)=gateway{g.publish(snapshot.clone());}
            }).is_some();
            if !published{
                // Mapper committed, but revocation won publication. Discard
                // that private revision baseline before processing new work.
                mapper.reset_scene();work.reject(subscriptions::INACTIVE,Outcome::Pause);return;
            }
            let c=work.config;let identity=work.stamp.identity;let input=work.input;
            let map_micros=started.elapsed().as_micros().min(u64::MAX as u128)as u64;
            work.finish(Outcome::Consumed);
            use crate::output::{Event,EventField::{Text,U64,Bool}};
            let id=identity.id();let n=&snapshot.metadata["native"];
            // Native intake validated these scalar identities; no arbitrary
            // timing object, resource list or metadata extension is forwarded.
            crate::emit(Event("NativeFrame",&[
                ("captureId",Text(&id)),("captureOrdinal",U64(identity.ordinal)),
                ("frameToken",U64(subscriptions::integer(&n["frameToken"],1,u32::MAX as u64).unwrap())),
                ("generation",U64(c.generation)),("inputSeq",U64(input)),
                ("mapMicros",U64(map_micros)),
                ("pageEpoch",U64(c.epoch)),("producer",Text(n["producer"].as_str().unwrap())),
                ("rawResourceBytes",U64(raw_bytes)),("rawResourceCount",U64(raw_count)),("resourcesComplete",Bool(complete)),
                ("sceneResources",U64(snapshot.resources.len()as u64)),("scopeId",Text(c.key.text())),("serial",U64(snapshot.serial)),
                ("sourceFrame",U64(subscriptions::integer(&n["sourceFrame"],0,i32::MAX as u64).unwrap())),
                ("viewportVersion",U64(c.viewport)),
            ]));
        },
        Err(error)=>{
            let retry=error.contains("cache miss");
            work.reject(&error,if retry{Outcome::Retry}else{Outcome::Pause});
        },
    }
}

#[cfg(test)]mod tests{
    use super::*;
    use std::io::Cursor;
    fn packet(value:Value)->Vec<u8>{let b=serde_json::to_vec(&value).unwrap();let mut p=(b.len()as u32).to_be_bytes().to_vec();p.extend(b);p}
    fn request(rpc:&RpcInput,n:u64)->ParsedRequest{match rpc.read(&mut Cursor::new(packet(json!({"id":n,"op":"map","padding":[1,2,3]})))).unwrap().unwrap(){crate::rpc::Frame::Request(r)=>r,_=>panic!()}}
    #[test]fn fixed_queue_transfers_admission_until_pop_and_its_final_owner(){
        let rpc=RpcInput::new(1024*1024,1024*1024).unwrap();let shared=Shared::new(&rpc).unwrap();let base=rpc.stats();
        for n in 0..SLOTS{assert!(shared.requests.lock().unwrap().push(request(&rpc,n as u64),7).is_ok());}
        let held=rpc.stats()["data"]["bytes"].as_u64().unwrap();assert!(held>0);
        let denied=shared.requests.lock().unwrap().push(request(&rpc,99),7);assert!(denied.is_err());drop(denied);assert_eq!(rpc.stats()["data"]["bytes"],held);
        for n in 0..SLOTS{let r=shared.pop().unwrap();assert_eq!(r.request.value["id"],n);assert_eq!(r.epoch,7);assert!(rpc.stats()["data"]["bytes"].as_u64().unwrap()>0);drop(r);}
        assert!(shared.pop().is_none());assert_eq!(rpc.stats()["data"]["bytes"],0);assert_eq!(rpc.stats()["control"]["bytes"],base["control"]["bytes"]);
        drop(shared);assert_eq!(rpc.stats()["control"]["bytes"],64*1024);
    }
    #[test]fn native_control_bypasses_a_full_request_queue_and_eof_wakes_owner(){
        let rpc=RpcInput::new(1024*1024,1024*1024).unwrap();let shared=Shared::new(&rpc).unwrap();
        for n in 0..SLOTS{assert!(shared.requests.lock().unwrap().push(request(&rpc,n as u64),0).is_ok());}
        let pool=InputPool::new(1024*1024);assert!(shared.fast(&json!({"op":"inputBudget"}),&pool).unwrap().is_ok());
        let version=shared.wake.version();shared.close();assert!(shared.closing());assert_ne!(shared.wake.version(),version);
        assert!(shared.has_requests());drop(shared);assert_eq!(rpc.stats()["data"]["bytes"],0);
    }
}
