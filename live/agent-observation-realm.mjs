// Serialized as fixed trusted code into the existing Native isolated world.
// Requests contain data only. No selector expressions, scripts, callbacks or CDP.
export function createAgentObservationRealm(secret,documentToken,subscriptionId){
 const doc=document,encoder=new TextEncoder(),nodes=new Map();let revision=0,closed=false;
 const native=chrome.gpuBenchmarking.remotePaintSubscription.bind(chrome.gpuBenchmarking),attribute=Element.prototype.getAttribute;
 const current=()=>{const state=native(secret,'describe',subscriptionId);return !closed&&state?.ok===true&&state.documentToken===documentToken&&document===doc;};
 if(!current())throw Error('STALE_AGENT_PAGE');
 const weak=node=>node?new WeakRef(node):null,matches=(reference,node)=>reference===null?node===null:reference.deref()===node;
 const text=(value,cap,flags)=>{if(value===null||value===undefined)return '';value=String(value);if(value.length>cap)flags.truncated=true;return value.slice(0,cap);};
 function row(node,elementId,budget,flags){
  const attr=(name,cap)=>text(attribute.call(node,name),cap,flags),tag=text(node.localName,32,flags),type=tag==='input'?attr('type',32).toLowerCase():'',redacted=tag==='input'&&['password','hidden'].includes(type);
  let direct='',child=node.firstChild,scanned=0;
  while(child&&scanned++<16){if(child.nodeType===3){const remaining=Math.max(0,budget-direct.length);if(child.length>remaining)flags.truncated=true;if(remaining)direct+=child.substringData(0,remaining);}child=child.nextSibling;}
  if(child)flags.truncated=true;
  let value=null;if(!redacted&&['input','textarea','select'].includes(tag)){value=text(node.value,budget,flags);budget-=value.length;}
  direct=redacted?'':text(direct,budget,flags);
  return {elementId,tag,id:attr('id',64),role:attr('role',32),name:attr('aria-label',64)||attr('name',64)||attr('alt',64),text:direct,value,redacted};
 }
 const signature=value=>JSON.stringify({...value,elementId:null});
 const resolve=elementId=>{if(!current())throw Error('STALE_AGENT_PAGE');const old=nodes.get(elementId),node=old?.node.deref();if(!node||!node.isConnected||node.ownerDocument!==doc||!matches(old.parent,node.parentNode)||!matches(old.previous,node.previousSibling)||!matches(old.next,node.nextSibling)||signature(row(node,null,old.budget,{truncated:false}))!==old.signature){nodes.clear();throw Error('STALE_AGENT_ELEMENT');}return node;};

 return Object.freeze({
  read(request,handles){
   if(!current())return {ok:false,code:'STALE_AGENT_PAGE'};
   if(revision>=Number.MAX_SAFE_INTEGER)return {ok:false,code:'AGENT_OBSERVATION_LIMIT'};
   const {query,limits}=request,flags={truncated:false};let target=null;
   if(query.kind==='element'){
    const old=nodes.get(query.elementId),node=old?.node.deref();
    if(!node||!node.isConnected||node.ownerDocument!==doc||!matches(old.parent,node.parentNode)||!matches(old.previous,node.previousSibling)||!matches(old.next,node.nextSibling)||signature(row(node,null,old.budget,{truncated:false}))!==old.signature){nodes.clear();return {ok:false,code:'STALE_AGENT_ELEMENT'};}
    target=node;
   }
   // Replace, never accumulate snapshots. WeakRefs never own DOM subtrees.
   nodes.clear();revision++;
   const result={ok:true,revision,url:text(doc.URL,1024,flags),title:text(doc.title,256,flags),visited:0,truncated:false,nodes:[]};
   let budget=limits.maxChars,bytes=encoder.encode(JSON.stringify(result)).byteLength+32;
   const append=node=>{
    let selectedBudget=budget,value=row(node,handles[result.nodes.length],selectedBudget,flags),cost=encoder.encode(JSON.stringify(value)).byteLength+1;
    // Characters and UTF-8 bytes are independent budgets. Re-read only this
    // bounded node projection with a smaller character budget until it fits.
    while(bytes+cost>4096&&selectedBudget>0){flags.truncated=true;selectedBudget=Math.floor(selectedBudget/2);value=row(node,handles[result.nodes.length],selectedBudget,flags);cost=encoder.encode(JSON.stringify(value)).byteLength+1;}
    if(bytes+cost>4096){flags.truncated=true;return false;}bytes+=cost;budget-=value.text.length+(value.value?.length??0);result.nodes.push(value);
    nodes.set(value.elementId,{node:weak(node),parent:weak(node.parentNode),previous:weak(node.previousSibling),next:weak(node.nextSibling),budget:selectedBudget,signature:signature(value)});return true;
   };
   if(target){result.visited=1;if(!append(target))return {ok:false,code:'AGENT_OBSERVATION_LIMIT'};}
   else{
    const root=doc.body??doc.documentElement,walker=root?doc.createTreeWalker(root,NodeFilter.SHOW_ALL):null;let node=root;
    while(node&&result.visited<limits.maxVisited){
     result.visited++;
     if(node.nodeType===1&&!['script','style','template','noscript','iframe','object','embed'].includes(node.localName)){
      const found=query.kind==='snapshot'||query.by==='tag'&&node.localName===query.value||query.by==='id'&&attribute.call(node,'id')===query.value||query.by==='testId'&&attribute.call(node,'data-testid')===query.value;
      if(found&&!append(node))break;
     }
     node=walker.nextNode();
     if(result.nodes.length>=limits.maxNodes){if(node)flags.truncated=true;break;}
    }
    if(node&&result.visited>=limits.maxVisited)flags.truncated=true;
   }
   if(!current()){nodes.clear();return {ok:false,code:'STALE_AGENT_PAGE'};}
   result.truncated=flags.truncated;return result;
  },
  screenshotMetadata(){if(!current())return {ok:false,code:'STALE_AGENT_PAGE'};const flags={truncated:false},result={ok:true,url:text(doc.URL,1024,flags),title:text(doc.title,256,flags),truncated:false};result.truncated=flags.truncated;if(!current())return {ok:false,code:'STALE_AGENT_PAGE'};return result;},
  axContext(elementId){try{const node=resolve(elementId),old=nodes.get(elementId);return {ok:true,revision,tag:row(node,null,0,{truncated:false}).tag,redacted:row(node,null,0,{truncated:false}).redacted,previousBudget:old.axBudget??null};}catch(error){return {ok:false,code:error.message==='STALE_AGENT_PAGE'?'STALE_AGENT_PAGE':'STALE_AGENT_ELEMENT'};}},
  axElement(elementId){return resolve(elementId);},
  commitAX(elementId,original,previousSignature,signature,budget){try{const node=resolve(elementId),old=nodes.get(elementId);if(node!==original||old.axSignature!==undefined&&old.axSignature!==previousSignature){nodes.clear();return {ok:false,code:'STALE_AGENT_ELEMENT'};}old.axSignature=signature;old.axBudget=budget;const flags={truncated:false},result={ok:true,revision,url:text(doc.URL,1024,flags),title:text(doc.title,256,flags),truncated:false};result.truncated=flags.truncated;if(encoder.encode(JSON.stringify(result)).byteLength>4096)return {ok:false,code:'AGENT_OBSERVATION_LIMIT'};return result;}catch(error){return {ok:false,code:error.message==='STALE_AGENT_PAGE'?'STALE_AGENT_PAGE':'STALE_AGENT_ELEMENT'};}},
  close(){closed=true;nodes.clear();return true;}
 });
}
