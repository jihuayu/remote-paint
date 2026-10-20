import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

test('Retained closed Broker streams release unread stdout/stderr backing without dispatch',{timeout:20000},async()=>{
 const child=spawn(process.execPath,['--expose-gc',fileURLToPath(new URL('./verify-node-stream-close.mjs',import.meta.url))],{stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>error+=bytes);const[code]=await once(child,'close');assert.equal(code,0,error||output);assert.equal(JSON.parse(output).status,'passed');
});
