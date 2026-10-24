// Standard GitHub-hosted jobs stop after six hours. Leave time for packaging
// and for always() cache/diagnostic steps before that hard deadline.
import {pathToFileURL} from 'node:url';
export const JOB_SECONDS = 360 * 60;
export const FINALIZATION_SECONDS = 25 * 60;
export function compileBudget(startedAt, now = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0 ||
      !Number.isSafeInteger(now) || now < startedAt) {
    throw new Error('Invalid hosted job start time; refusing an unsafe compile budget');
  }
  return Math.max(0, JOB_SECONDS - FINALIZATION_SECONDS - (now - startedAt));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const value = process.env.REMOTE_PAINT_JOB_STARTED_AT ?? '';
  if (!/^[0-9]+$/.test(value)) throw new Error('Missing hosted job start time');
  console.log(compileBudget(Number(value)));
}
