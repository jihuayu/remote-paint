import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {createAgentObservationRealm} from '../../live/agent-observation-realm.mjs';
import {captureManagedAgentObservation} from '../../live/agent-observation.mjs';
const ids=()=>Array.from({length:16},()=> 'elh_'+crypto.randomUUID());
export function setup(){
 const doc={URL:'https://fixture.test/?order=42',title:'Test',createTreeWalker(root){const list=[];function collect(node){list.push(node);for(const child of node.children)collect(child);}collect(root);let i=0;return {nextNode:()=>list[++i]??null};}};
 class Element {constructor(tag,attrs={},text=''){this.nodeType=1;this.localName=tag;this.attrs=attrs;this.children=[];this.ownerDocument=doc;this.isConnected=true;this.parentNode=null;this.previousSibling=null;this.nextSibling=null;this.value='';if(text){const t={nodeType:3,data:text,length:text.length,substringData:(a,b)=>text.slice(a,a+b),ownerDocument:doc,isConnected:true,children:[],parentNode:this,previousSibling:null,nextSibling:null};this.children.push(t);}}getAttribute(name){return this.attrs[name]??null;}get firstChild(){return this.children[0]??null;}get textContent(){throw Error('Unbounded DOM text getter is forbidden');}}
 function append(parent,node){const old=parent.children.at(-1);if(old)old.nextSibling=node;node.previousSibling=old??null;node.parentNode=parent;parent.children.push(node);return node;}
 const root=doc.body=new Element('body'),button=append(root,new Element('button',{id:'submit','data-testid':'order'},'Submit')),password=append(root,new Element('input',{id:'password',type:'password'}));password.value='SECRET';let nativeToken='document-1';
 const context={document:doc,Element,NodeFilter:{SHOW_ALL:0xffffffff},WeakRef,TextEncoder,chrome:{gpuBenchmarking:{remotePaintSubscription:(secret,operation,id)=>{assert.equal(secret,'private');assert.equal(operation,'describe');assert.equal(id,'subscription');return {ok:true,documentToken:nativeToken};}}}};
 const realm=runInNewContext('('+createAgentObservationRealm.toString()+')("private","document-1","subscription")',context),read=(query,limits={})=>realm.read(captureManagedAgentObservation(query,limits),ids());return {doc,Element,root,button,password,append,read,realm,set nativeToken(v){nativeToken=v;}};
}
