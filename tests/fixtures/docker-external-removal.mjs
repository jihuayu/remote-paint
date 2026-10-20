// Opt-in fixture actor,not production retirement evidence. Only the exact
// fully verified object emitted by this fixture's owning provider is removed.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyDockerRuntime} from '../../service/docker-runtime-spec.mjs';
const execute=promisify(execFile);
export async function removeOwnedFixture({plan,inspection,containerId,socketPath}){
 const profile=verifyDockerRuntime(plan,inspection,{containerId});
 if(profile.containerId!==containerId||typeof containerId!=='string'||!/^[a-f0-9]{64}$/.test(containerId)||typeof socketPath!=='string'||!socketPath.startsWith('/'))throw new TypeError('Expected exact private fixture ownership');
 const {stdout,stderr}=await execute('/usr/local/bin/docker',['--host','unix://'+socketPath,'container','rm','--force',containerId],{timeout:5000,maxBuffer:4096,killSignal:'SIGKILL'});
 if(stdout.trim()!==containerId||stderr.trim())throw Error('External fixture removal did not acknowledge the exact object');
 return Object.freeze({kind:'external-fixture-removal',containerId,daemonId:plan.daemonId,actualExitCode:0,stdout:stdout.trim(),ownershipVerifiedBeforeEffect:true});
}
