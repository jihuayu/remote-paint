import {observationFixture} from './agent-observation-fixture.mjs';
export const axReply=(patch={})=>({nodes:[{nodeId:'ax-private',backendDOMNodeId:71,ignored:false,role:{type:'role',value:'button'},name:{type:'computedString',value:'Computed order'},description:{type:'computedString',value:'Browser description'},properties:[{name:'disabled',value:{type:'boolean',value:false}},{name:'pressed',value:{type:'tristate',value:'mixed'}}],...patch}]});
export async function accessibilityFixture(t){
 const base=observationFixture(t);let hook=null,redacted=false,reply=axReply();base.handler=async(method,params)=>{const custom=await hook?.(method,params);if(custom!==undefined)return custom;
 if(method==='Runtime.callFunctionOn'&&params.functionDeclaration.includes('this.axContext'))return {result:{value:{ok:true,revision:1,tag:'button',redacted,previousBudget:null}}};
 if(method==='Runtime.callFunctionOn'&&params.functionDeclaration.includes('this.axElement'))return {result:{subtype:'node',objectId:'private-element-object'}};
 if(method==='Runtime.callFunctionOn'&&params.functionDeclaration.includes('this.commitAX'))return {result:{value:{ok:true,revision:1,url:'https://fixture.test/',title:'Fixture',truncated:false}}};
 if(method==='DOM.describeNode')return {node:{nodeType:1,localName:'button',backendNodeId:71}};
 if(method==='Accessibility.getPartialAXTree')return reply;
 };const ctx=base.run.observationContext(),dom=await base.run.observe({kind:'snapshot'},ctx);return {base,ctx,elementId:dom.nodes[0].elementId,read:(limits={})=>base.run.observeAccessibility(dom.nodes[0].elementId,ctx,limits),set hook(v){hook=v;},set redacted(v){redacted=v;},set reply(v){reply=v;}};
}
