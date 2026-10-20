// Separate allocation attribution only. This tracing diagnostic can perturb
// timings and must not stand in for the native footprint/growth acceptance.
import assert from 'node:assert/strict';
import {openSync, writeFileSync, closeSync} from 'node:fs';
import {appendFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';

export function memoryScalar(value) {
  assert.equal(typeof value, 'string', 'Trace memory scalar must be a hexadecimal string');
  assert.match(value, /^(?:0x)?[0-9a-f]+$/i, 'Invalid trace memory scalar');
  const number = BigInt(/^0x/i.test(value) ? value : '0x' + value);
  assert.ok(number <= BigInt(Number.MAX_SAFE_INTEGER), 'Trace memory scalar exceeds exact integer range');
  return Number(number);
}

function guid(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^(?:0x)?[0-9a-f]+$/i);
  return BigInt(/^0x/i.test(value) ? value : '0x' + value).toString(16);
}

export function allocationRecord(event) {
  if (event.ph !== 'v' || !event.args?.dumps?.allocators) return null;
  assert.ok(Number.isSafeInteger(event.pid) && event.pid > 0);
  const allocators = {};
  for (const [name, dump] of Object.entries(event.args.dumps.allocators)) {
    // Keep aggregate paths; full bucket/ownership detail is already on disk.
    // Parent and child aggregates overlap and must never be added as totals.
    if (name.split('/').length > 3 && !name.startsWith('v8/')) continue;
    assert.ok(Object.keys(allocators).length < 1024, 'Allocation aggregate bound exceeded');
    const scalars = {};
    for (const [key, attr] of Object.entries(dump.attrs ?? {})) {
      if (attr.type === 'scalar') scalars[key] = {units: attr.units, value: memoryScalar(attr.value)};
    }
    allocators[name] = scalars;
  }
  assert.ok(Number.isFinite(event.ts) && event.ts >= 0);
  return {pid: event.pid, exportedSnapshotId: guid(event.id), timestampMicros: event.ts, levelOfDetail: event.args.dumps.level_of_detail,
    allocators, processTotalsRaw: event.args.dumps.process_totals ?? null};
}

export function selectAllocationRecords(records, expectedPids) {
  // Perfetto's JSON exporter uses its snapshot-table row ID, not the CDP
  // request GUID, and hardcodes the event name to periodic_interval. A fresh
  // owned trace has exactly one explicit request and no periodic triggers.
  // Reject extra snapshot groups rather than rewriting or guessing an ID.
  const groups = new Set(records.map(record => JSON.stringify([record.exportedSnapshotId, record.timestampMicros, record.levelOfDetail])));
  assert.equal(groups.size, 1, 'Expected one actual exported memory snapshot');
  const selected = records.filter(record => expectedPids.includes(record.pid));
  const pids = new Set(selected.map(record => record.pid));
  for (const pid of expectedPids) assert.ok(pids.has(pid), 'Requested owned renderer missing from allocation dump:' + pid);
  assert.ok(selected.length, 'No owned renderer allocation events');
  assert.equal(pids.size, selected.length, 'Duplicate process allocation dump');
  return selected;
}

function within(promise, timeoutMs, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' deadline exceeded')), Math.max(1, timeoutMs));
  })]).finally(() => clearTimeout(timer));
}

export async function createSessionMemoryDump(root, directory, {deadlineMs = 5000, maxBytes = 32 * 1024 * 1024} = {}) {
  assert.ok(Number.isInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 5000);
  assert.ok(Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= 32 * 1024 * 1024);
  await mkdir(directory, {recursive: true});
  let active = false, ordinal = 0;
  return {async capture({cycle, identities}) {
    assert.equal(active, false, 'Overlapping allocation dump');
    assert.ok(identities.length > 0 && identities.length <= 1024);
    assert.ok(++ordinal <= 1024, 'Allocation dump count exceeded');
    active = true;
    const start = performance.now(), path = join(directory, ordinal + '.raw.jsonl');
    const records = []; let fd, bytes = 0, events = 0, failure, collectionFailure, started = false, reply, complete, completeResolve;
    const completed = new Promise(resolve => {completeResolve = resolve;});
    const onComplete = value => {complete = value; completeResolve();};
    const onData = chunk => {
      if (collectionFailure) return;
      try {
        const line = JSON.stringify(chunk) + '\n', size = Buffer.byteLength(line);
        assert.ok(bytes + size <= maxBytes, 'Allocation trace output exceeded frozen byte bound');
        writeFileSync(fd, line); bytes += size;
        for (const event of chunk.value) {
          events++;
          const record = allocationRecord(event);
          if (record) {assert.ok(records.length < 1024, 'Process allocation record bound exceeded'); records.push(record);}
        }
      } catch (error) {collectionFailure = error; failure ??= error;}
    };
    const send = (method, params) => within(root.send(method, params), deadlineMs - (performance.now() - start), method);
    root.on('Tracing.dataCollected', onData); root.on('Tracing.tracingComplete', onComplete);
    try {
      fd = openSync(path, 'wx', 0o600);
      await send('Tracing.start', {transferMode: 'ReportEvents', traceConfig: {
        recordMode: 'recordAsMuchAsPossible', includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'],
        memoryDumpConfig: {allowedDumpModes: ['light'], triggers: []}
      }});
      started = true;
      // Chrome155's handler maps false to kNone. Both V8 and Blink providers
      // call LowMemoryNotification only for kForceGc. No GC command is sent.
      reply = await send('Tracing.requestMemoryDump', {deterministic: false, levelOfDetail: 'light'});
      assert.equal(reply.success, true, 'Memory dump provider reported incomplete global dump');
    } catch (error) {failure ??= error;}
    finally {
      if (started) {
        try {
          // Share the original request5s+cleanup2s total budget. An early
          // dump reply leaves its unused time available to trace conversion.
          const remaining = () => deadlineMs + 2000 - (performance.now() - start);
          await within(root.send('Tracing.end'), remaining(), 'Tracing.end cleanup');
          await within(completed, remaining(), 'Tracing.tracingComplete cleanup');
          assert.notEqual(complete?.dataLossOccurred, true, 'Allocation trace reported data loss');
        } catch (error) {failure ??= error;}
      }
      root.off('Tracing.dataCollected', onData); root.off('Tracing.tracingComplete', onComplete);
      try {if (fd !== undefined) closeSync(fd);} catch (error) {failure ??= error;}
      active = false;
    }
    let selected;
    if (!failure) {
      try {
        assert.ok(performance.now() - start <= deadlineMs + 2000, 'Allocation diagnostic total deadline exceeded');
        selected = selectAllocationRecords(records, identities.map(p => p.pid));
        assert.ok(selected.every(p => p.levelOfDetail === 'light'), 'Unexpected allocation detail mode');
      }
      catch (error) {failure = error;}
    }
    const receipt = {at: new Date().toISOString(), ordinal, cycle, status: failure ? 'failed' : 'captured',
      elapsedMs: performance.now() - start, path, bytes, events, dumpGuid: reply?.dumpGuid,
      expectedIdentities: identities, deterministic: false, levelOfDetail: 'light', deadlineMs, totalDeadlineMs: deadlineMs + 2000, maxBytes,
      association: {singleExplicitRequest: true, periodicTriggersDisabled: true, exportedSnapshotId: selected?.[0]?.exportedSnapshotId, exportedTimestampMicros: selected?.[0]?.timestampMicros},
      allocations: selected, error: failure?.stack, collectionError: collectionFailure?.stack,
      scope: 'Separate nondeterministic CDP memory-infra attribution. CDP dumpGuid and exported snapshot-table ID are distinct,unmodified fields. Exactly one exported snapshot perfresh owned trace/no periodic triggers. No forcedGC;aggregate allocator paths overlap,not additive unique physical memory. Native footprint gates remain separate.'};
    await appendFile(join(directory, 'receipts.jsonl'), JSON.stringify(receipt) + '\n');
    if (failure) throw failure;
    return {ordinal, cycle, dumpGuid: reply.dumpGuid, bytes, elapsedMs: receipt.elapsedMs};
  }};
}
