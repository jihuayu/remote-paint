import {once} from 'node:events';

export async function stopOwnedTestChild(child){
 if(child.exitCode===null&&child.signalCode===null){
  const closed=once(child,'close');child.kill('SIGKILL');await closed;
 }
}

// Own the child before running any asynchronous setup. A setup rejection must
// still close its IPC handle and reap it before the original error escapes.
export async function withOwnedTestChild(start,run){
 const child=start();
 try{return await run(child);}finally{await stopOwnedTestChild(child);}
}
