const STREAM_KINDS=Object.freeze(['display','observation','recording']);
const counts=value=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!STREAM_KINDS.includes(key)))throw new TypeError('Invalid source stream demand');
 const next={display:0,observation:0,recording:0};
 for(const key of STREAM_KINDS){const count=value[key]??0;if(!Number.isSafeInteger(count)||count<0||count>1024)throw new RangeError('Invalid source stream demand');next[key]=count;}
 if(next.display+next.observation+next.recording>1024)throw new RangeError('Source stream demand limit');return next;
};
const aborted=()=>Object.assign(new Error('Page-run lease was aborted'),{name:'AbortError'});
// Clock demand and encoded-frame demand are independent. Count updates are
// atomic and page-run leases are caller-owned,abortable and individually bounded.
export class SourceDemand {
 constructor({onChange=()=>{},maxPageRuns=128}={}){
  if(typeof onChange!=='function'||!Number.isInteger(maxPageRuns)||maxPageRuns<1||maxPageRuns>1024)throw new TypeError('Invalid source demand configuration');
  this.closed=false;this.maxPageRuns=maxPageRuns;this._streams=counts({});this._pageRuns=new Set();this._onChange=onChange;
 }
 get display(){return this._streams.display;}
 get encoding(){return this._streams.display+this._streams.observation+this._streams.recording;}
 get pageRuns(){return this._pageRuns.size;}
 get clock(){return this.encoding+this.pageRuns;}
 snapshot(){return Object.freeze({...this._streams,pageRun:this.pageRuns,encoding:this.encoding,clock:this.clock,closed:this.closed,maxPageRuns:this.maxPageRuns});}
 setStreams(value){
  const next=counts(value);if(this.closed)return false;
  if(STREAM_KINDS.every(key=>next[key]===this._streams[key]))return false;
  this._streams=next;this._onChange?.();return true;
 }
 setDisplay(display){return this.setStreams({...this._streams,display});}
 acquirePageRun({signal}={}){
  if(this.closed)throw new Error('Source is closed');
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw new TypeError('Invalid page-run AbortSignal');
  if(signal?.aborted)throw aborted();
  if(this.pageRuns>=this.maxPageRuns)throw Object.assign(new Error('Page-run consumer limit'),{code:'PAGE_RUN_LIMIT'});
  let owner=this,record={signal:signal??null,release:null};
  const release=()=>{
   if(!owner)return false;const current=owner;owner=null;
   record.signal?.removeEventListener('abort',release);current._pageRuns.delete(record);record=null;
   if(!current.closed)current._onChange?.();return true;
  };
  record.release=release;this._pageRuns.add(record);signal?.addEventListener('abort',release,{once:true});this._onChange?.();return release;
 }
 close(){
  if(this.closed)return;this.closed=true;this._streams=counts({});
  for(const record of this._pageRuns)record.release();
  const notify=this._onChange;this._onChange=null;notify?.();
 }
}
