import test from 'node:test';
import assert from 'node:assert/strict';
import {privateCdpArgs} from '../live/private-cdp.mjs';
import {containerOptions} from '../service/container-options.mjs';

test('private CDP is off for ordinary Sources and cannot select a public address',()=>{
 assert.deepEqual(privateCdpArgs(),[]);
 assert.deepEqual(privateCdpArgs(9222),['--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1']);
 for(const port of [0,-1,65536,1.5,'9222',NaN,Infinity])assert.throws(()=>privateCdpArgs(port));
});
test('container listener options remain loopback and require distinct valid ports',()=>{
 assert.deepEqual(containerOptions({}),{port:4176,nativePort:4177,cdpPort:9222,url:'about:blank',host:'127.0.0.1'});
 assert.equal(containerOptions({REMOTE_PAINT_HOST:'0.0.0.0'}).host,'127.0.0.1');
 for(const text of ['0','65536','-1','1.5','9222x',''])assert.throws(()=>containerOptions({REMOTE_PAINT_CDP_PORT:text}));
 assert.throws(()=>containerOptions({REMOTE_PAINT_CDP_PORT:'4176'}));
 assert.throws(()=>containerOptions({REMOTE_PAINT_URL:'file:///etc/passwd'}));
});
