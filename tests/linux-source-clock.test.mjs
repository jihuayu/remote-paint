import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifyLinuxClockInterval} from './linux-source-clock.mjs';
test('Linux native clock proof uses actual monotonic interval with only integer-stamp allowance',()=>{
 const reply={clock:'chromium-time-ticks-v1',nowMicros:123456789};
 const r=verifyLinuxClockInterval(reply,123456789100n,123456790000n);assert.equal(r.integerStampAllowanceNs,1000);
 for(const args of [[123456790001n,123456790002n],[123456780000n,123456787999n],[20n,10n]])assert.throws(()=>verifyLinuxClockInterval(reply,...args));
 assert.throws(()=>verifyLinuxClockInterval({...reply,clock:'wall'},0n,123456790000n));assert.throws(()=>verifyLinuxClockInterval({...reply,nowMicros:NaN},0n,123456790000n));
});
