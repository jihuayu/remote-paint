import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run=promisify(execFile);
export const nativeExecutable=()=>process.env.REMOTE_PAINT_NATIVE??fileURLToPath(new URL('./bin/skp_subset',import.meta.url));
export async function subsetPicture(input,output,png){
  const {stdout}=await run(nativeExecutable(),[input,output,...(png?[png]:[])],{timeout:30_000,maxBuffer:1024*1024});
  return JSON.parse(stdout);
}
