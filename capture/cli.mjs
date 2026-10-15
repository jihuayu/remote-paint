import { parseArgs } from 'node:util';
import { capture } from './capture.mjs';
import { startFixtureServer } from './fixture.mjs';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, output: { type: 'string', default: 'artifacts/capture' },
  width: { type: 'string', default: '960' }, height: { type: 'string', default: '640' },
} });
const fixture = values.url ? null : await startFixtureServer();
try {
  const result = await capture({ url: values.url ?? fixture.url, output: values.output,
    width: Number(values.width), height: Number(values.height) });
  console.log(JSON.stringify(result, null, 2));
} finally { await fixture?.close(); }
