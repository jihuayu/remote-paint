import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MessageChannel} from 'node:worker_threads';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {ViewerFrameConnection} from '../sdk/viewer-frame.mjs';
import {viewerHello,viewerNonce} from '../sdk/viewer-channel.mjs';
import {attachViewerChild} from '../viewer/embed-bridge.mjs';
const parentOrigin='https://host.example',frameOrigin='https://viewer.example',gatewayOrigin='https://gateway.example',sessionId='ses_fixture',build='b'.repeat(64);
const pending=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
async function until(check){for(let i=0;i<400;i++){if(check())return;await delay(5);}assert.fail('Frame condition deadline');}
function target(){const listeners=new Map();return {addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},dispatchEvent(event){for(const fn of [...listeners.get(event.type)??[]])fn(event);return true;}};}
function grant(extra={}){const ticket='vwt1.'+'a'.repeat(43);return {grantId:'vgr_'+randomUUID(),sessionId,version:'v1',role:'readonly',audience:frameOrigin,expiresAt:new Date(Date.now()+60000).toISOString(),ticket,streamPath:'/v1/viewer/stream?ticket='+ticket,...extra};}
function fixture(t,{ready,allowedParents=[parentOrigin],gateway=gatewayOrigin,source,origin=parentOrigin}={}){
 const parent=target(),child={...target(),location:{origin:frameOrigin},parent},hellos=[],calls=[],states=[];let current={state:'waiting'},abort;
 const api={get state(){return current;},connect(options){calls.push(options);abort?.abort();abort=new AbortController();const signal=abort.signal;current={state:'connecting',sessionId:options.sessionId,role:options.role,attempt:0,version:null};child.dispatchEvent({type:'remote-paint-connection',detail:current});void options.getTicket({signal,reason:'connect',previousGrantId:null}).then(ticket=>{if(signal.aborted)return;current={state:'connected',sessionId:options.sessionId,role:options.role,attempt:0,version:ticket.version};child.dispatchEvent({type:'remote-paint-connection',detail:current});},error=>{if(signal.aborted)return;current={state:'failed',sessionId:options.sessionId,role:options.role,attempt:1,version:null,code:error.code};child.dispatchEvent({type:'remote-paint-connection',detail:current});});},disconnect(){abort?.abort();current={...current,state:'paused'};child.dispatchEvent({type:'remote-paint-connection',detail:current});}};
 const config=ready??Promise.resolve({schema:'public-viewer-v1',gatewayOrigin:gateway,allowedParentOrigins:allowedParents,viewerBuild:build});const dispose=attachViewerChild({targetWindow:child,ready:config,api});t.after(dispose);
 child.postMessage=(data,targetOrigin,ports)=>{assert.equal(targetOrigin,frameOrigin);hellos.push(data);const transferred=structuredClone({data,ports},{transfer:ports});queueMicrotask(()=>child.dispatchEvent({type:'message',...transferred,origin,source:parent}));};
 const client=new ViewerFrameConnection({frameWindow:child,frameOrigin,gatewayOrigin,sessionId,role:'readonly',getTicket:source??(()=>grant()),onState:value=>states.push(value)});t.after(()=>client.close());return {parent,child,client,api,hellos,calls,states,dispose};
}

test('real transferred MessagePort authorizes parent Origin and connects only after explicit host intent',async t=>{
 let tickets=0;const f=fixture(t,{source:()=>{tickets++;return grant();}});const ready=await f.client.ready;assert.equal(ready.gatewayOrigin,gatewayOrigin);assert.equal(tickets,0);assert.equal(f.calls.length,0);assert.ok(!f.hellos[0].includes('ticket'));
 const [first,duplicate]=await Promise.all([f.client.connect(),f.client.connect()]);assert.equal(first.state,'connected');assert.equal(duplicate.state,'connected');assert.equal(tickets,1);assert.equal((await f.client.getState()).sessionId,sessionId);await f.client.disconnect();assert.equal(f.client.state.state,'paused');await f.client.connect();assert.equal(tickets,2);assert.equal(f.calls.length,2);
});

test('metadata pending holds one port and waits for the configured parent allowlist',async t=>{
 const gate=pending();let tickets=0;const f=fixture(t,{ready:gate.promise,source:()=>{tickets++;return grant();}}),connecting=f.client.connect();await delay(20);assert.equal(tickets,0);assert.equal(f.calls.length,0);gate.resolve({schema:'public-viewer-v1',gatewayOrigin,allowedParentOrigins:[parentOrigin],viewerBuild:build});assert.equal((await connecting).state,'connected');assert.equal(tickets,1);
});

test('wrong Origin and empty allowlist never deliver a ticket callback',async t=>{
 for(const options of [{origin:'https://unlisted.example'},{allowedParents:[]}]){let tickets=0;const f=fixture(t,{...options,source:()=>{tickets++;return grant();}});await assert.rejects(f.client.ready,e=>e.code==='CHANNEL_CLOSED');assert.equal(tickets,0);assert.equal(f.calls.length,0);}
});

test('wrong source, malformed ports and duplicate hello cannot replace an authorized channel',async t=>{
 const f=fixture(t);await f.client.ready;
 for(const source of [target(),null]){
  const pair=new MessageChannel();t.after(()=>{pair.port1.close();pair.port2.close();});const closed=once(pair.port1,'close');f.child.dispatchEvent({type:'message',data:viewerHello(viewerNonce()),origin:parentOrigin,source,ports:[pair.port2]});await closed;
 }
 const duplicate=new MessageChannel();t.after(()=>{duplicate.port1.close();duplicate.port2.close();});const closed=once(duplicate.port1,'close');f.child.dispatchEvent({type:'message',data:f.hellos[0],origin:parentOrigin,source:f.parent,ports:[duplicate.port2]});await closed;assert.equal((await f.client.connect()).state,'connected');assert.equal(f.calls.length,1);
});

test('gateway metadata mismatch and metadata rejection close bootstrap before any connection',async t=>{
 const wrong=fixture(t,{gateway:'https://other-gateway.example'});await assert.rejects(wrong.client.ready,e=>e.code==='VIEWER_INVALID_CONFIG');assert.equal(wrong.calls.length,0);
 const gate=pending(),failed=fixture(t,{ready:gate.promise});gate.resolve({schema:'wrong'});await assert.rejects(failed.client.ready,e=>e.code==='CHANNEL_CLOSED');assert.equal(failed.calls.length,0);
});

test('disconnect during a slow host callback cannot connect and reconnect retains callback admission',async t=>{
 const gate=pending(),started=pending();let tickets=0;const f=fixture(t,{source:async()=>{tickets++;started.resolve();await gate.promise;return grant();}}),connecting=f.client.connect();const rejected=assert.rejects(connecting,e=>e.code==='CHANNEL_ABORTED');await started.promise;await f.client.disconnect();await rejected;assert.equal(f.api.state.state,'paused');
 await assert.rejects(f.client.connect(),e=>e.code==='VIEWER_TICKET_BUSY');assert.equal(tickets,1);gate.resolve();await delay(10);await f.client.connect();assert.equal(tickets,2);assert.equal(f.client.state.state,'connected');
});

test('closing during metadata/callback wait rejects promptly and the child is stopped',async t=>{
 const gate=pending(),f=fixture(t,{ready:gate.promise}),ready=assert.rejects(f.client.ready,e=>e.code==='CHANNEL_CLOSED');f.client.close();await ready;gate.resolve({schema:'public-viewer-v1',gatewayOrigin,allowedParentOrigins:[parentOrigin],viewerBuild:build});await delay(20);assert.equal(f.calls.length,0);
 const slow=pending(),started=pending(),g=fixture(t,{source:async()=>{started.resolve();await slow.promise;return grant();}}),connecting=g.client.connect(),rejected=assert.rejects(connecting,e=>e.code==='CHANNEL_CLOSED');await started.promise;g.client.close();await rejected;slow.resolve();await until(()=>g.api.state.state==='paused');
});

test('parent ticket validation rejects wrong role, Session and audience instead of forwarding them',async t=>{
 for(const extra of [{role:'controller'},{sessionId:'ses_other'},{audience:'https://other.example'}]){const f=fixture(t,{source:()=>grant(extra)});await assert.rejects(f.client.connect(),e=>e.code==='VIEWER_INVALID_TICKET');assert.equal(f.client.state.state,'failed');}
});

test('a connected notification already in transit cannot revive a disconnected host or invalidate its channel',async t=>{
 const f=fixture(t);await f.client.connect();const stopped=f.client.disconnect();f.child.dispatchEvent({type:'remote-paint-connection',detail:{state:'connected',sessionId,role:'readonly',attempt:0,version:'v1'}});await stopped;assert.equal(f.client.state.state,'paused');assert.equal((await f.client.connect()).state,'connected');
});
