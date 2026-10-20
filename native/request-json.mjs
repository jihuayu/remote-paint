import {types} from 'node:util';
export const MAX_REQUEST_BYTES=90*1024*1024;
const MAX_CONTROL_BYTES=256*1024,MAX_NODES=1_000_000,MAX_DEPTH=64;
const HEX='0123456789abcdef';
function invalid(){return new TypeError('Native Broker request requires plain JSON data without accessors or serialization hooks');}
function rootPrototype(proto,name){
 if(proto===null)return true;if(types.isProxy(proto))return false;
 const ctor=Object.getOwnPropertyDescriptor(proto,'constructor')?.value;
 return typeof ctor==='function'&&!types.isProxy(ctor)&&Object.getOwnPropertyDescriptor(ctor,'name')?.value===name;
}
function plain(value,array){
 if(types.isProxy(value))throw invalid();const proto=Object.getPrototypeOf(value);
 for(const target of proto===null?[value]:[value,proto]){const hook=Object.getOwnPropertyDescriptor(target,'toJSON');if(hook&&(hook.get||hook.set||typeof hook.value==='function'))throw invalid();}
 if(proto===null)return;
 if(!rootPrototype(proto,array?'Array':'Object'))throw invalid();
 const parent=Object.getPrototypeOf(proto);if(array){if(parent!==null&&(!rootPrototype(parent,'Object')||Object.getPrototypeOf(parent)!==null))throw invalid();}
 else if(parent!==null)throw invalid();
}

// A bounded snapshot avoids re-reading caller properties during encoding.
// Existing caller values and engine enumeration/GC internals are not an exact
// VM heap budget; plan/graph/string headroom is deliberately conservative.
export function encodeRequest(id,op,args,memory,owner){
 if(typeof op!=='string'||!op.length||op.length>128)throw new TypeError('Invalid Native Broker operation');
 if(args===null)args={};if(typeof args!=='object'||Array.isArray(args)||types.isProxy(args))throw invalid();plain(args,false);
 if(Object.getOwnPropertyDescriptor(args,'id')||Object.getOwnPropertyDescriptor(args,'op'))throw new TypeError('Native Broker id/op are reserved');
 const limit=owner.lane==='control'?MAX_CONTROL_BYTES:MAX_REQUEST_BYTES;let bytes=0,nodes=0;
 const ancestors=new Set();
 const add=n=>{bytes+=n;if(bytes>limit)throw new RangeError('Native Broker packet limit');};
 const node=()=>{if(++nodes>MAX_NODES)throw new RangeError('Native Broker metadata node limit');memory.node(owner);};
 const string=value=>{
  node();if(value.length+bytes+2>limit)throw new RangeError('Native Broker packet limit');memory.text(owner,value.length);let size=2;
  for(let i=0;i<value.length;i++){
   const code=value.charCodeAt(i);
   if(code===34||code===92||code===8||code===9||code===10||code===12||code===13)size+=2;
   else if(code<32)size+=6;
   else if(code>=0xd800&&code<=0xdbff){const next=value.charCodeAt(i+1);if(next>=0xdc00&&next<=0xdfff){size+=4;i++;}else size+=6;}
   else if(code>=0xdc00&&code<=0xdfff)size+=6;
   else size+=code<128?1:code<2048?2:3;
   if(bytes+size>limit)throw new RangeError('Native Broker packet limit');
  }
  add(size);return {type:1,value};
 };
 const literal=value=>{node();add(value.length);return {type:0,value};};
 const own=(value,key)=>{const desc=Object.getOwnPropertyDescriptor(value,key);if(!desc)return undefined;if(desc.get||desc.set)throw invalid();return desc.value;};
 const visit=(value,depth)=>{
  if(depth>MAX_DEPTH)throw new RangeError('Native Broker metadata depth limit');
  if(value===null||value===undefined)return literal('null');
  if(typeof value==='string')return string(value);
  if(typeof value==='boolean')return literal(value?'true':'false');
  if(typeof value==='number')return literal(Number.isFinite(value)?String(value):'null');
  if(typeof value!=='object'||types.isProxy(value))throw invalid();
  const array=Array.isArray(value);plain(value,array);if(ancestors.has(value))throw new TypeError('Circular Native Broker request');ancestors.add(value);node();
  try{
   add(2);const items=[];
   if(array){
    const length=own(value,'length');if(length*2-1+bytes>limit)throw new RangeError('Native Broker packet limit');
    for(let i=0;i<length;i++){if(i)add(1);items.push(visit(own(value,String(i)),depth+1));}
   }else{
    for(const key in value){const desc=Object.getOwnPropertyDescriptor(value,key);if(!desc?.enumerable)continue;if(desc.get||desc.set)throw invalid();if(desc.value===undefined)continue;if(items.length)add(1);const keyPlan=string(key);add(1);items.push([keyPlan,visit(desc.value,depth+1)]);}
   }
   return {type:array?2:3,items};
  }finally{ancestors.delete(value);}
 };
 node();add(2);const entries=[];
 const property=(key,value)=>{if(entries.length)add(1);const keyPlan=string(key);add(1);entries.push([keyPlan,visit(value,1)]);};
 property('id',id);property('op',op);
 for(const key in args){const desc=Object.getOwnPropertyDescriptor(args,key);if(!desc?.enumerable)continue;if(desc.get||desc.set)throw invalid();if(desc.value!==undefined)property(key,desc.value);}
 memory.packet(owner,bytes+4);const packet=Buffer.allocUnsafeSlow(bytes+4);if(packet.buffer.byteLength!==packet.length)throw new Error('Unexpected Native Broker packet backing');packet.writeUInt32BE(bytes);let offset=4;
 const run=(value,start,end)=>{if(end>start)offset+=packet.write(start===0&&end===value.length?value:value.slice(start,end),offset,packet.length-offset,'utf8');};
 const writeString=value=>{
  packet[offset++]=34;let start=0;
  for(let i=0;i<value.length;i++){
   const code=value.charCodeAt(i),next=value.charCodeAt(i+1),pair=code>=0xd800&&code<=0xdbff&&next>=0xdc00&&next<=0xdfff;
   if(pair){i++;continue;}
   if(code>=32&&code!==34&&code!==92&&(code<0xd800||code>0xdfff))continue;
   run(value,start,i);packet[offset++]=92;
   const short=code===34?34:code===92?92:code===8?98:code===9?116:code===10?110:code===12?102:code===13?114:0;
   if(short)packet[offset++]=short;else{packet[offset++]=117;for(let shift=12;shift>=0;shift-=4)packet[offset++]=HEX.charCodeAt(code>>shift&15);}
   start=i+1;
  }
  run(value,start,value.length);packet[offset++]=34;
 };
 const write=plan=>{
  if(plan.type===0){offset+=packet.write(plan.value,offset,'ascii');return;}
  if(plan.type===1){writeString(plan.value);return;}
  const array=plan.type===2;packet[offset++]=array?91:123;
  for(let i=0;i<plan.items.length;i++){if(i)packet[offset++]=44;if(array)write(plan.items[i]);else{write(plan.items[i][0]);packet[offset++]=58;write(plan.items[i][1]);}}
  packet[offset++]=array?93:125;
 };
 write({type:3,items:entries});if(offset!==packet.length)throw new Error('Native Broker JSON measurement mismatch');memory.encoded(owner);return packet;
}
