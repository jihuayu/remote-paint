// Bounded byte preflight/locator. It never materializes the entire UTF-8 text
// or JSON graph; JSON.parse remains the syntax authority after admission.
export class ResponseEnvelope {
 constructor(){this.depth=0;this.peakDepth=0;this.nodes=0;this.string=false;this.escape=false;this.atom=false;this.started=false;this.ended=false;this.top='key';this.field='';this.kind='';this.token=Buffer.allocUnsafeSlow(512);this.length=0;this.overflow=false;this.id=undefined;this.event=undefined;this.idSeen=false;this.eventSeen=false;this.duplicate=false;this.limit=null;}
 node(){this.nodes++;if(this.nodes>1_000_000)this.limit??='metadata entries';}
 begin(kind){this.kind=kind;this.length=0;this.overflow=false;}
 append(byte){if(!this.kind)return;if(this.length<this.token.length)this.token[this.length++]=byte;else this.overflow=true;}
 value(){if(this.overflow)return undefined;try{return JSON.parse(this.token.subarray(0,this.length).toString('utf8'));}catch{return undefined;}}
 key(){
  if(this.overflow||this.length>32)return '';let id=0,event=0,count=0;
  for(let i=1;i<this.length-1;i++){
   let byte=this.token[i];
   if(byte===92){if(this.token[++i]!==117||i+4>=this.length)return '';let code=0;for(let n=0;n<4;n++){const digit=this.token[++i],hex=digit>=48&&digit<=57?digit-48:digit>=65&&digit<=70?digit-55:digit>=97&&digit<=102?digit-87:-1;if(hex<0)return '';code=code*16+hex;}byte=code;}
   if(count<2&&byte==='id'.charCodeAt(count))id++;if(count<5&&byte==='event'.charCodeAt(count))event++;count++;
  }
  return count===2&&id===2?'id':count===5&&event===5?'event':'';
 }
 end(){
  if(this.kind==='key'){this.field=this.key();this.top='colon';}
  else if(this.kind==='id'){if(this.idSeen)this.duplicate=true;this.idSeen=true;const id=this.value();if(id===null||typeof id==='string'&&id.length<=128||Number.isSafeInteger(id))this.id=id;this.top='after';}
  else if(this.kind==='event'){if(this.eventSeen)this.duplicate=true;this.eventSeen=true;const event=this.value();if(typeof event==='string'&&event.length<=64)this.event=event;this.top='after';}
  else if(this.depth===1)this.top='after';
  this.kind='';
 }
 valueKind(){return this.depth===1&&this.top==='value'?this.field:'';}
 feed(bytes){
  for(const byte of bytes){
   if(this.string){this.append(byte);if(this.escape)this.escape=false;else if(byte===92)this.escape=true;else if(byte===34){this.string=false;this.end();}continue;}
   if(this.atom){if(byte!==44&&byte!==93&&byte!==125&&byte!==32&&byte!==10&&byte!==13&&byte!==9){this.append(byte);continue;}this.atom=false;this.end();}
   if(byte===32||byte===10||byte===13||byte===9)continue;
   if(byte===34){this.node();this.begin(this.depth===1&&this.top==='key'?'key':this.valueKind());this.string=true;this.escape=false;this.append(byte);}
   else if(byte===123||byte===91){this.node();if(!this.started){this.started=true;this.top='key';}else if(this.depth===1)this.top='after';this.depth++;this.peakDepth=Math.max(this.peakDepth,this.depth);if(this.depth>128)this.limit??='metadata nesting';}
   else if(byte===125||byte===93){this.depth--;if(this.depth===0)this.ended=true;}
   else if(byte===58){if(this.depth===1)this.top='value';}
   else if(byte===44){if(this.depth===1){this.top='key';this.field='';}}
   else{this.node();this.begin(this.valueKind());this.atom=true;this.append(byte);}
  }
 }
 finish(){if(this.atom){this.atom=false;this.end();}}
 estimate(bytes){return 8192+bytes*6+this.nodes*256+this.peakDepth*64;}
}
