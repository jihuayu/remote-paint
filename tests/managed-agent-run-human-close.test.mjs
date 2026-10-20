import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ControlLease,AgentInputError} from '../live/input.mjs';
import {createManagedAgentRun} from '../live/managed-agent-run.mjs';
function setup(t){
 const source=Object.assign(new EventEmitter(),{pageEpoch:1,viewportVersion:1,viewport:{cssWidth:640,cssHeight:480},latest:{},page:{isClosed:()=>false}}),calls=[],gates=[],control=new ControlLease(source,{send:async(method,params)=>{calls.push({method,params});},detach:async()=>{}});source.control=control;
 const run=createManagedAgentRun(control,{tenantId:'tenant',sessionId:'ses_00000000-0000-4000-8000-000000000001',authorize:()=>true});
 const hold=predicate=>{let release,enter;const gate=new Promise(r=>release=r),entered=new Promise(r=>enter=r),send=control.cdp.send;gates.push(release);control.cdp.send=async(method,params)=>{await send(method,params);if(predicate(method,params)){enter();await gate;}};return {entered,release};};
 t.after(async()=>{for(const release of gates)release();await run.close();await control.close();});return {control,run,calls,hold};
}
const tags=c=>({sessionId:c.sessionId,pageEpoch:c.source.pageEpoch,viewportVersion:c.source.viewportVersion});
const key=(type,code='KeyH')=>({kind:'key',type,key:code==='KeyH'?'h':'a',code,...(type==='keyDown'?{text:code==='KeyH'?'H':'A'}:{})});
test('ending the Agent run preserves the human lease, held keys/buttons and valid next input',async t=>{
 const {control:c,run,calls}=setup(t),grant=await c.acquire('human',tags(c));let seq=grant.nextSeq;const input=event=>c.input('human',{...grant,seq:seq++,event});await input(key('keyDown'));await input({kind:'mouse',type:'mousePressed',x:20,y:20,button:'left',buttons:1,clickCount:1});const before={version:c.version,lease:c.lease,expiresAt:c.expiresAt,nextSeq:c.nextSeq},count=calls.length;await run.close();assert.equal(c.mode,'human');assert.equal(c.holder,'human');assert.deepEqual({version:c.version,lease:c.lease,expiresAt:c.expiresAt,nextSeq:c.nextSeq},before);assert.equal(c.keys.has('KeyH'),true);assert.equal(c.buttons.has('left'),true);assert.equal(calls.length,count,'Agent close must not send cleanup into human-owned input');await input(key('keyUp'));await input({kind:'mouse',type:'mouseReleased',x:20,y:20,button:'left',buttons:0,clickCount:1});assert.equal(c.keys.size,0);assert.equal(c.buttons.size,0);assert.equal(c.mode,'human');
});
test('ending an Agent run during handoff does not cancel the pending human grant',async t=>{
 const {control:c,run,calls,hold}=setup(t),gate=hold((_m,p)=>p.type==='keyDown'),active=assert.rejects(run.perform('press',{key:'a',code:'KeyA',text:'A'},run.context()),e=>e instanceof AgentInputError&&e.outcome==='unknown');await gate.entered;const acquiring=c.acquire('human',tags(c)).then(grant=>({ok:true,grant}),error=>({ok:false,code:error.code}));assert.equal(c.mode,'handoff');const version=c.version,closing=run.close();assert.equal(c.version,version,'Agent close must preserve the human handoff generation');gate.release();await active;const result=await acquiring;await closing;assert.equal(result.ok,true);assert.equal(c.mode,'human');assert.equal(c.holder,'human');assert.equal(c.keys.size,0);assert.equal(calls.filter(x=>x.params.type==='keyUp'&&x.params.code==='KeyA').length,1);await c.input('human',{...result.grant,seq:result.grant.nextSeq,event:{kind:'text',text:'H'}});assert.equal(calls.at(-1).params.text,'H');
});
test('Agent close waits an active human input without revoking it or neutralizing its key',async t=>{
 const {control:c,run,calls,hold}=setup(t),grant=await c.acquire('human',tags(c)),gate=hold((_m,p)=>p.type==='keyDown'),active=c.input('human',{...grant,seq:grant.nextSeq,event:key('keyDown')});await gate.entered;const closing=run.close();let settled=false;void closing.then(()=>{settled=true;});await new Promise(r=>setImmediate(r));assert.equal(settled,false);gate.release();await active;await closing;assert.equal(c.mode,'human');assert.equal(c.lease,grant.lease);assert.equal(c.keys.has('KeyH'),true);assert.ok(!calls.some(x=>x.params.type==='keyUp'&&x.params.code==='KeyH'));await c.input('human',{...grant,seq:grant.nextSeq+1,event:key('keyUp')});assert.equal(c.keys.size,0);
});
