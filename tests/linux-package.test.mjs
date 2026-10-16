import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runtimePath,verifyElf} from '../native/package-linux.mjs';

test('runtime dependencies cannot escape the packaged browser directory',()=>{
 assert.equal(runtimePath('/browser','./icudtl.dat').rel,'icudtl.dat');
 for(const path of ['../secret','/etc/passwd','.'])assert.throws(()=>runtimePath('/browser',path));
});
test('packaging rejects swapped architecture and non-ELF binaries',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-package-'));
 try{
  const path=join(directory,'binary'),header=Buffer.alloc(20);header.set(Buffer.from('7f454c460201','hex'));header.writeUInt16LE(183,18);
  await writeFile(path,header);await verifyElf(path,'arm64');await assert.rejects(verifyElf(path,'x64'));
  header.writeUInt16LE(62,18);await writeFile(path,header);await verifyElf(path,'x64');await assert.rejects(verifyElf(path,'arm64'));
  await writeFile(path,'not a Linux executable');await assert.rejects(verifyElf(path,'arm64'));
 }finally{await rm(directory,{recursive:true,force:true});}
});
