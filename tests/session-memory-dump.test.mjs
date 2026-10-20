import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {memoryScalar, allocationRecord, selectAllocationRecords, createSessionMemoryDump} from './session-memory-dump.mjs';

const event = (pid = 31, id = '0x0') => ({ph: 'v', pid, id, ts: 1234, args: {dumps: {level_of_detail: 'light', allocators: {
  malloc: {attrs: {size: {type: 'scalar', units: 'bytes', value: '100'}}},
  'malloc/allocated_objects': {attrs: {size: {type: 'scalar', units: 'bytes', value: '80'}}}
}}}});

test('allocation hex decoding is exact and overlapping hierarchy remains separate', () => {
  assert.equal(memoryScalar('100'), 256);
  assert.throws(() => memoryScalar('20000000000000'), /exact integer/);
  assert.throws(() => memoryScalar('12junk'), /Invalid/);
  const record = allocationRecord(event());
  assert.equal(record.allocators.malloc.size.value, 256);
  assert.equal(record.allocators['malloc/allocated_objects'].size.value, 128);
  assert.equal(selectAllocationRecords([record], [31]).length, 1);
  assert.throws(() => selectAllocationRecords([record], [32]), /missing/);
  assert.throws(() => selectAllocationRecords([record, record], [31]), /Duplicate/);
  assert.throws(() => selectAllocationRecords([record, allocationRecord(event(31, '0x1'))], [31]), /one actual/);
});

test('per-object Blink details cannot exhaust the aggregate projection bound', () => {
  const sample = event();
  for (let n = 0; n < 1500; n++) sample.args.dumps.allocators['blink_gc/main/allocated_objects/__' + n] = {attrs: {size: {type: 'scalar', units: 'bytes', value: '10'}}};
  const record = allocationRecord(sample);
  assert.deepEqual(Object.keys(record.allocators), ['malloc', 'malloc/allocated_objects']);
});

test('incomplete dump and output overflow persist failures and end only owned trace', async () => {
  for (const scenario of ['incomplete', 'overflow', 'occupied', 'success']) {
    const directory = await mkdtemp(join(tmpdir(), 'remote-paint-memory-dump-'));
    const root = new EventEmitter(), calls = [];
    root.send = async (method, params) => {
      calls.push({method, params});
      if (method === 'Tracing.start' && scenario === 'occupied') throw new Error('Already tracing');
      if (method === 'Tracing.requestMemoryDump') return {success: scenario !== 'incomplete', dumpGuid: '0xab'};
      if (method === 'Tracing.end') {
        root.emit('Tracing.dataCollected', {value: [event()]});
        root.emit('Tracing.tracingComplete', {dataLossOccurred: false});
      }
      return {};
    };
    try {
      const dump = await createSessionMemoryDump(root, directory, {maxBytes: scenario === 'overflow' ? 1 : 4096});
      const operation = dump.capture({cycle: 400, identities: [{pid: 31, identity: {start: 7}}]});
      if (scenario === 'success') await operation;
      else await assert.rejects(operation);
      assert.equal(calls.filter(c => c.method === 'Tracing.end').length, scenario === 'occupied' ? 0 : 1);
      const request = calls.find(c => c.method === 'Tracing.requestMemoryDump');
      if (request) {assert.equal(request.params.deterministic, false); assert.equal(request.params.levelOfDetail, 'light');}
      assert.equal(root.listenerCount('Tracing.dataCollected'), 0);
      assert.equal(root.listenerCount('Tracing.tracingComplete'), 0);
      const receipt = JSON.parse((await readFile(join(directory, 'receipts.jsonl'), 'utf8')).trim());
      assert.equal(receipt.status, scenario === 'success' ? 'captured' : 'failed');
      if (scenario === 'success') {assert.equal(receipt.dumpGuid, '0xab'); assert.equal(receipt.association.exportedSnapshotId, '0');}
      assert.ok(receipt.bytes <= (scenario === 'overflow' ? 1 : 4096));
      if (scenario === 'incomplete') assert.ok(receipt.bytes > 0, 'Preserve raw partial dump even when provider fails');
    } finally {await rm(directory, {recursive: true, force: true});}
  }
});
