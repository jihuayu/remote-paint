import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {createAgentObservationRealm} from '../live/agent-observation-realm.mjs';
import {captureManagedAgentObservation} from '../live/agent-observation.mjs';
const ids=()=>Array.from({length:16},(_,n)=>'elh_'+crypto.randomUUID());
function setup(){
 const doc={URL:'https://fixture.test/?order=42',title:'Test',createTreeWalker(root){const list=[];function collect(node){list.push(node);for(const child of node.children)collect(child);}collect(root);let i=0;return {nextNode:()=>list[++i]??null};}};
 class Element {constructor(tag,attrs={},text=''){this.nodeType=1;this.localName=tag;this.attrs=attrs;this.children=[];this.ownerDocument=doc;this.isConnected=true;this.parentNode=null;this.previousSibling=null;this.nextSibling=null;this.value='';if(text){const t={nodeType:3,data:text,length:text.length,substringData:(a,b)=>text.slice(a,a+b),ownerDocument:doc,isConnected:true,children:[],parentNode:this,previousSibling:null,nextSibling:null};this.children.push(t);}}getAttribute(name){return this.attrs[name]??null;}get firstChild(){return this.children[0]??null;}get textContent(){throw Error('Unbounded DOM text getter is forbidden');}}
 function append(parent,node){const old=parent.children.at(-1);if(old)old.nextSibling=node;node.previousSibling=old??null;node.parentNode=parent;parent.children.push(node);return node;}
 const root=doc.body=new Element('body'),button=append(root,new Element('button',{id:'submit','data-testid':'order'},'Submit')),password=append(root,new Element('input',{id:'password',type:'password'}));password.value='SECRET';let nativeToken='document-1';
 const context={document:doc,Element,NodeFilter:{SHOW_ALL:0xffffffff},WeakRef,TextEncoder,chrome:{gpuBenchmarking:{remotePaintSubscription:(secret,operation,id)=>{assert.equal(secret,'private');assert.equal(operation,'describe');assert.equal(id,'subscription');return {ok:true,documentToken:nativeToken};}}}};
 const realm=runInNewContext('('+createAgentObservationRealm.toString()+')("private","document-1","subscription")',context),read=(query,limits={})=>realm.read(captureManagedAgentObservation(query,limits),ids());return {doc,Element,root,button,password,append,read,realm,set nativeToken(v){nativeToken=v;}};
}
test('realm reads bounded direct DOM text and form values while redacting password/hidden inputs',()=>{
 const h=setup(),result=h.read({kind:'snapshot'});assert.equal(result.ok,true);const button=result.nodes.find(n=>n.id==='submit');assert.equal(button.text,'Submit');const password=result.nodes.find(n=>n.id==='password');assert.equal(password.value,null);assert.equal(password.redacted,true);assert.equal(JSON.stringify(result).includes('SECRET'),false);assert.equal(result.url,'https://fixture.test/?order=42');const metadata=setup().read({kind:'snapshot'},{maxChars:0});assert.equal(metadata.truncated,true);assert.ok(metadata.nodes.every(n=>n.text===''&&(n.value===null||n.value==='')));
});
test('opaque handle resolves only the original connected node, never a replacement matching its locator',()=>{
 const h=setup(),first=h.read({kind:'locate',by:'id',value:'submit'}),handle=first.nodes[0].elementId;h.button.isConnected=false;const replacement=new h.Element('button',{id:'submit'},'Submit');replacement.parentNode=h.root;replacement.nextSibling=h.password;h.root.children[0]=replacement;const stale=h.read({kind:'element',elementId:handle});assert.equal(stale.ok,false);assert.equal(stale.code,'STALE_AGENT_ELEMENT');const current=h.read({kind:'locate',by:'id',value:'submit'});assert.equal(current.nodes.length,1);assert.notEqual(current.nodes[0].elementId,handle);
});
test('handle metadata, parent and sibling changes reject rather than silently rebind',()=>{
 for(const cause of ['text','parent','sibling']){const h=setup(),first=h.read({kind:'locate',by:'id',value:'submit'}),handle=first.nodes[0].elementId;if(cause==='text')h.button.attrs['aria-label']='Changed';if(cause==='parent')h.button.parentNode=new h.Element('div');if(cause==='sibling')h.button.nextSibling=null;const stale=h.read({kind:'element',elementId:handle});assert.equal(stale.code,'STALE_AGENT_ELEMENT');}
});
test('every fresh snapshot replaces its bounded handle registry, with monotonic snapshot revision',()=>{
 const h=setup(),a=h.read({kind:'locate',by:'testId',value:'order'}),b=h.read({kind:'locate',by:'tag',value:'button'});assert.ok(b.revision>a.revision);assert.equal(h.read({kind:'element',elementId:a.nodes[0].elementId}).code,'STALE_AGENT_ELEMENT');
});
test('traversal, node, text and serialized byte limits report truncation with no whole-document text materialization',()=>{
 const h=setup();for(let n=0;n<1000;n++)h.append(h.root,new h.Element('p',{id:'中'.repeat(64),'aria-label':'中'.repeat(64)},'z'.repeat(1000)));const sparse=h.read({kind:'locate',by:'id',value:'absent'},{maxVisited:7});assert.equal(sparse.visited,7);assert.equal(sparse.truncated,true);const large=h.read({kind:'snapshot'},{maxNodes:16,maxChars:2048,maxVisited:256});assert.ok(large.nodes.length<=16);assert.ok(new TextEncoder().encode(JSON.stringify(large)).length<=4096);assert.ok(large.nodes.reduce((n,r)=>n+r.text.length+(r.value?.length??0),0)<=2048);assert.equal(large.truncated,true);
});
test('same-evaluation native document identity and explicit close invalidate all reads',()=>{
 const h=setup();h.nativeToken='new-document';assert.equal(h.read({kind:'snapshot'}).code,'STALE_AGENT_PAGE');h.nativeToken='document-1';assert.equal(h.realm.close(),true);assert.equal(h.read({kind:'snapshot'}).code,'STALE_AGENT_PAGE');
});

test('UTF-8 byte truncation preserves a resolvable handle for large non-ASCII text rather than rejecting a valid read',()=>{
 const h=setup();h.append(h.root,new h.Element('span',{id:'unicode'},'中'.repeat(4000)));const first=h.read({kind:'locate',by:'id',value:'unicode'},{maxChars:2048});assert.equal(first.ok,true);assert.equal(first.nodes.length,1);assert.ok(first.nodes[0].text.length>0&&first.nodes[0].text.length<2048);assert.equal(first.truncated,true);assert.ok(new TextEncoder().encode(JSON.stringify(first)).length<=4096);const inspected=h.read({kind:'element',elementId:first.nodes[0].elementId},{maxChars:2048});assert.equal(inspected.ok,true);assert.equal(inspected.nodes[0].text,first.nodes[0].text);assert.equal(inspected.truncated,true);
});
