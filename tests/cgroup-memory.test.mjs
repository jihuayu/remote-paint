import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveLinuxCgroupLocation,parseLinuxCgroupCounters,parseLinuxCgroupProcs,sampleLinuxCgroupMemory} from '../native/cgroup-memory-linux.mjs';
import {runtimeMetrics} from '../native/runtime-metrics.mjs';
const mount=(root='/',point='/sys/fs/cgroup')=>`42 30 0:28 ${root} ${point} ro,nosuid,nodev,noexec - cgroup2 cgroup rw\n`;
test('cgroup location resolves actual membership against mount roots and rejects unavailable,ambiguous or escaping paths',()=>{
 assert.equal(resolveLinuxCgroupLocation('0::/\n',mount()).directory,'/sys/fs/cgroup');assert.equal(resolveLinuxCgroupLocation('0::/team/session\n',mount('/team')).directory,'/sys/fs/cgroup/session');assert.equal(resolveLinuxCgroupLocation('0::/team/session\n',mount('/team','/cgroup\\040mount')).directory,'/cgroup mount/session');
 assert.equal(resolveLinuxCgroupLocation('0::/team/session\n',mount()+mount('/team','/nested')).directory,'/nested/session');for(const [membership,mountinfo]of[['1:memory:/team',mount()],['0::/\n0::/team',mount()],['0::/../outside',mount()],['0::/team',mount('/other')],['0::/','bad mount'],['0::relative',mount()]])assert.throws(()=>resolveLinuxCgroupLocation(membership,mountinfo));
});
test('cgroup counters preserve actual zero and unknown valid keys while rejecting duplicates,missing and unsafe data',()=>{
 assert.deepEqual(parseLinuxCgroupCounters('oom_kill 0\nfuture_counter 2\n'),{oom_kill:0,future_counter:2});for(const text of ['', 'oom_kill 0\noom_kill 1','oom_kill -1','file 9007199254740992','anon nonsense'])assert.throws(()=>parseLinuxCgroupCounters(text));
});
test('cgroup PID membership reports duplicate and invisible entries and enforces its finite inventory',()=>{
 assert.deepEqual(parseLinuxCgroupProcs('0\n12\n12\n13\n0'),{pids:[12,13],invisibleEntries:2,duplicateEntries:1});for(const text of ['-1','abc','2147483648',Array(1025).fill('1').join('\n')])assert.throws(()=>parseLinuxCgroupProcs(text));
});
test('actual unified cgroup memory verifies own membership,mount provenance,anon/file counters and one pending read', {skip:process.platform!=='linux'},async t=>{
 const a=sampleLinuxCgroupMemory({observedPids:[process.pid]}),b=sampleLinuxCgroupMemory();await assert.rejects(b,e=>e.code==='LINUX_CGROUP_BUSY');const value=await a;assert.equal(value.provenance.status,'observed');assert.equal(value.provenance.processMembershipConfirmed,true);assert.ok(value.provenance.membersBefore.pids.includes(process.pid)&&value.provenance.membersAfter.pids.includes(process.pid));assert.ok(!value.provenance.outsideObservedPids.includes(process.pid));assert.ok(Number.isSafeInteger(value['memory.current'])&&value['memory.current']>0);for(const key of ['anon','file'])assert.ok(Number.isSafeInteger(value['memory.stat'][key]));assert.ok(Number.isSafeInteger(value['memory.events'].oom_kill));t.diagnostic(JSON.stringify({scope:'Actualcontrollercgroup+nondescedant/kernel/filecache;notuniqueSession',provenance:value.provenance,current:value['memory.current'],anon:value['memory.stat'].anon,file:value['memory.stat'].file}));
});
test('actual runtime bridge keeps simple caller fields and reports separately scoped complete observed PSS,cgroup and identities',{skip:process.platform!=='linux'},async()=>{
 const source={stats:{captures:0}},simple=await runtimeMetrics(source);assert.ok(Number.isFinite(simple.byKind.node.cpuMs));assert.ok(simple.byKind.node.rssBytes>0);assert.equal(simple.processSampling.status,'observed-stable');assert.equal(simple.pss,undefined);const detailed=await runtimeMetrics(source,{details:true});assert.equal(detailed.pss.completeObservedCohort,true);assert.ok(detailed.pss.bytes>0);assert.equal(detailed.processes.find(p=>p.pid===process.pid).kind,'node');assert.equal(detailed.cgroup.provenance.processMembershipConfirmed,true);
});
