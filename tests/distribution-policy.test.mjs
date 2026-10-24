import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {excludedDistributionPath,prepareDistribution} from '../deploy/sanitize-server-package.mjs';
import {fileHash} from '../native/linux-receipt.mjs';
test('server distribution excludes keys, account configuration and recorded run data',()=>{
 for(const file of ['app/tests/fixtures/webhook-localhost-key.pem','app/key.KEY','app/file.pfx','app/.env','app/.env.production','app/.ssh/config','app/.aws/credentials','app/.npmrc','app/examples/verified-capture','app/examples/verified-capture/manifest.json','app/artifacts/session/report.json'])assert.equal(excludedDistributionPath(file),true,file);
 for(const file of ['browser/headless_shell','node/bin/node','app/native/bin/remote-paint-broker','app/live.mjs','app/service/container-entry.mjs','app/artifacts','app/node_modules/example/artifacts/runtime.mjs','BUILD.json'])assert.equal(excludedDistributionPath(file),false,file);
});
test('distribution removes keys and recorded data while preserving runtime files and regenerated checksums',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'distribution-policy-'));
 try{
  const name='remote-paint-linux-arm64-012345abcdef',root=join(temp,name);
  await mkdir(join(root,'app/tests/fixtures'),{recursive:true});
  await mkdir(join(root,'app/examples/verified-capture'),{recursive:true});
  await mkdir(join(root,'app/artifacts/session'),{recursive:true});
  await writeFile(join(root,'BUILD.json'),JSON.stringify({format:1,cpu:'arm64',projectRevision:'fixture-only'}));
  await writeFile(join(root,'app/server.mjs'),'// fixture runtime payload\n');
  await writeFile(join(root,'app/tests/fixtures/test-key.pem'),'fixture-only marker, not a credential');
  await writeFile(join(root,'app/.env.production'),'fixture-only marker');
  await writeFile(join(root,'app/examples/verified-capture/manifest.json'),'fixture recorded data');
  await writeFile(join(root,'app/artifacts/session/report.json'),'fixture generated runtime data');
  await writeFile(join(root,'SHA256SUMS'),'old fixture checksum');
  await prepareDistribution(temp);
  const archive=join(temp,`${name}.tar.gz`),listing=execFileSync('tar',['-tzf',archive],{encoding:'utf8'});
  assert.ok(!listing.includes('test-key.pem'));assert.ok(!listing.includes('.env.production'));assert.ok(listing.includes('app/server.mjs'));
  assert.ok(!listing.includes('verified-capture'));assert.ok(!listing.includes('session/report.json'));
  assert.ok(listing.includes('app/artifacts/'),'Preserve the empty read-only mountpoint for smoke evidence');
  assert.equal((await readFile(`${archive}.sha256`,'utf8')).split(' ')[0],await fileHash(archive));
  const extracted=join(temp,'extracted');await mkdir(extracted);
  execFileSync('tar',['-xzf',archive,'-C',extracted]);
  for(const line of (await readFile(join(extracted,name,'SHA256SUMS'),'utf8')).trim().split('\n')){
   const [hash,file]=line.split('  ');assert.equal(hash,await fileHash(join(extracted,name,file)));
  }
  const build=JSON.parse(await readFile(join(extracted,name,'BUILD.json'),'utf8'));
  assert.equal(build.distribution.policy,'no-key-config-or-recorded-data-v2');
  assert.equal(build.distribution.removedPaths,4);
 }finally{await rm(temp,{recursive:true,force:true});}
});
