import assert from 'node:assert/strict';
import {test} from 'node:test';
import {networkProfileCounters} from './session-network-profile.mjs';
test('network observation requires the exact owned queue and actual integer counters',()=>{
 const q={kind:'netem',handle:'30:',bytes:4000,packets:3,drops:1,overlimits:0,requeues:0,backlog:0,qlen:0};
 assert.deepEqual(networkProfileCounters([q]),{bytes:4000,packets:3,drops:1,overlimits:0,requeues:0,backlog:0,qlen:0});
 for(const rows of [[],[q,q],[{...q,handle:'2:'}],[{...q,drops:undefined}],[{...q,bytes:null}],[{...q,packets:-1}]])assert.throws(()=>networkProfileCounters(rows));
});
