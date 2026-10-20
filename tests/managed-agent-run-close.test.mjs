import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ControlLease,AgentInputError} from '../live/input.mjs';
import {createManagedAgentRun} from '../live/managed-agent-run.mjs';
test('run close still waits for real active input when the outer controller has already started closing',async t=>{
 let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r),source=Object.assign(new EventEmitter(),{pageEpoch:1,viewportVersion:1,viewport:{cssWidth:640,cssHeight:480},latest:{},page:{isClosed:()=>false}}),control=new ControlLease(source,{send:async(method,params)=>{if(method==='Input.dispatchKeyEvent'&&params.type==='keyDown'){enter();await gate;}},detach:async()=>{}});source.control=control;
 const run=createManagedAgentRun(control,{tenantId:'tenant',sessionId:'ses_00000000-0000-4000-8000-000000000001',authorize:()=>true});t.after(async()=>{release();await run.close();await control.close();});
 const active=assert.rejects(run.perform('press',{key:'a',code:'KeyA',text:'A'},run.context()),e=>e instanceof AgentInputError&&e.outcome==='unknown');await entered;const outer=control.close();assert.equal(control.closed,true);const closing=run.close();let settled=false;void closing.then(()=>{settled=true;});await new Promise(r=>setImmediate(r));assert.equal(settled,false,'run-closed must not precede the actual in-flight CDP settlement');release();await active;await closing;await outer;assert.equal(settled,true);assert.equal(control.queued,0);assert.equal(control.keys.size,0);
});
