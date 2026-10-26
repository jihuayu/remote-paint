// Test-only one-day identities, created in a caller-owned temporary directory.
// Never used by a production bootstrap or committed to the repository.
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {X509Certificate,createHash} from 'node:crypto';
export function createClusterTestPki(directory,{openssl='/usr/bin/openssl'}={}){
 mkdirSync(directory,{recursive:true,mode:0o700});
 const run=args=>execFileSync(openssl,args,{cwd:directory,stdio:['ignore','ignore','pipe'],timeout:10000});
 writeFileSync(join(directory,'ca.conf'),'[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Remote Paint ephemeral cluster test CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
 run(['ecparam','-name','prime256v1','-genkey','-noout','-out','ca.key']);run(['req','-new','-x509','-sha256','-key','ca.key','-out','ca.crt','-days','1','-config','ca.conf']);
 let serial=1;const pins={};
 for(const name of ['controller','worker-a','worker-b','other-client']){
  const client=['controller','other-client'].includes(name);writeFileSync(join(directory,name+'.ext'),'[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage='+ (client?'clientAuth':'serverAuth')+'\nsubjectAltName=DNS:'+name+'.test\n');
  run(['ecparam','-name','prime256v1','-genkey','-noout','-out',name+'.key']);chmodSync(join(directory,name+'.key'),0o600);
  run(['req','-new','-sha256','-key',name+'.key','-subj','/CN='+name+'.test','-out',name+'.csr']);
  run(['x509','-req','-sha256','-in',name+'.csr','-CA','ca.crt','-CAkey','ca.key','-set_serial',String(++serial),'-days','1','-out',name+'.crt','-extfile',name+'.ext','-extensions','leaf']);
  pins[name]=createHash('sha256').update(new X509Certificate(readFileSync(join(directory,name+'.crt'))).raw).digest('hex');
 }
 chmodSync(join(directory,'ca.key'),0o600);writeFileSync(join(directory,'pins.json'),JSON.stringify(pins)+'\n');return pins;
}
export function readClusterTestTls(directory,name){return {key:readFileSync(join(directory,name+'.key')),cert:readFileSync(join(directory,name+'.crt')),ca:readFileSync(join(directory,'ca.crt'))};}
