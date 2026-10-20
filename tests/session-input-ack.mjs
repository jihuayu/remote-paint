import assert from 'node:assert/strict';

// Observe only actual successful WebSocket.send(Input) and its exact ACK.
// Never retain lease tokens, socket URLs, input text or unbounded history.
export async function installSessionInputObserver(page){
 await page.addInitScript(()=>{
  const Socket=WebSocket,state=window.__sessionInputObserver={nonce:crypto.randomUUID(),pending:new Map(),records:[],errors:[],active:null,sent:0,acked:0,rejected:0,texts:0,peakPending:0,probes:0};
  const fail=message=>{if(state.errors.length<32)state.errors.push(message);};
  window.WebSocket=class extends Socket{
   send(packet){
    let input;try{if(typeof packet==='string'){const m=JSON.parse(packet);if(m.type==='Input')input=m;}}catch{fail('Input observer could not parse outgoing metadata');}
    const sentAt=performance.now(),result=super.send(packet);
    if(input){
     if(state.pending.size>=64||state.pending.has(input.seq)){fail('Input observer pending bound orduplicate sequence');return result;}
     const record={seq:input.seq,pageEpoch:input.pageEpoch,viewportVersion:input.viewportVersion,eventKind:input.event?.kind,sentAt};
     if(record.eventKind==='text'&&state.active&&state.active.seq===null){record.probe=state.active;state.active.seq=input.seq;}
     state.pending.set(input.seq,record);state.sent++;state.peakPending=Math.max(state.peakPending,state.pending.size);
    }
    return result;
   }
   constructor(...args){
    super(...args);this.addEventListener('message',({data})=>{
     if(typeof data!=='string')return;let message;try{message=JSON.parse(data);}catch{fail('Input observer could not parse incoming metadata');return;}if(message.type!=='InputAck')return;
     const sent=state.pending.get(message.seq);if(!sent){fail('Input ACK has no actual outgoing sequence');return;}state.pending.delete(message.seq);state.acked++;if(!message.accepted)state.rejected++;
     const ack={observationOrdinal:state.acked,seq:message.seq,accepted:message.accepted,stage:message.stage,code:message.code,pageEpoch:sent.pageEpoch,viewportVersion:sent.viewportVersion,eventKind:sent.eventKind,sentAt:sent.sentAt,at:performance.now()};
     state.records.push(ack);if(state.records.length>128)state.records.shift();
     const probe=sent.probe;if(probe&&state.active===probe){clearTimeout(probe.timer);state.active=null;state.texts++;probe.resolve({...ack,probeId:probe.id,dispatchAt:probe.dispatchAt,queueMs:sent.sentAt-probe.dispatchAt,ms:ack.at-probe.dispatchAt});}
    });
   }
  };
  state.dispatchText=text=>new Promise((resolve,reject)=>{
   if(state.active){reject(new Error('Concurrent text ACK probes are not allowed'));return;}
   if(typeof text!=='string'||!text.length||text.length>256){reject(new Error('Invalid bounded test text'));return;}
   const proxy=document.querySelector('#inputProxy');if(!proxy){reject(new Error('Actual Viewer input proxy missing'));return;}
   const probe={id:++state.probes,seq:null,dispatchAt:performance.now(),resolve,reject};
   probe.timer=setTimeout(()=>{if(state.active===probe)state.active=null;reject(new Error('Actual text input ACK exceeded3000ms from dispatch'));},3000);state.active=probe;
   proxy.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:text,bubbles:true,cancelable:true}));
  });
 });
}
export async function measureSessionTextAck(page,text='x'){
 const ack=await page.evaluate(text=>window.__sessionInputObserver.dispatchText(text),text);
 assert.equal(ack.accepted,true);assert.equal(ack.stage,'input-injected');assert.equal(ack.eventKind,'text');assert.ok(Number.isSafeInteger(ack.seq)&&ack.seq>0);assert.ok(Number.isSafeInteger(ack.pageEpoch)&&ack.pageEpoch>0);assert.ok(Number.isSafeInteger(ack.viewportVersion)&&ack.viewportVersion>0);assert.ok(ack.queueMs>=0&&ack.ms>=ack.queueMs&&ack.ms<3000);
 return ack;
}
export async function sessionInputObserverStats(page){
 return page.evaluate(()=>{const s=window.__sessionInputObserver;return {nonce:s.nonce,sent:s.sent,acked:s.acked,rejected:s.rejected,texts:s.texts,peakPending:s.peakPending,pending:s.pending.size,retained:s.records.length,errors:s.errors.slice(),active:s.active!==null};});
}
