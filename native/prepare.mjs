import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const source = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node native/prepare.mjs /path/to/chromium/src');
const expected = 'a49e2e3d4addfd84e765b52afe230bedb81096db';
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (revision !== expected) throw new Error(`Expected Chromium ${expected}, got ${revision}`);
await mkdir(join(source, 'components/remote_paint'), { recursive: true });
await cp(new URL('./chromium/', import.meta.url), join(source, 'components/remote_paint'), { recursive: true });
const rootBuild = join(source, 'BUILD.gn');
let build = await readFile(rootBuild, 'utf8');
if (!build.includes('group("remote_paint_tools")')) {
  build += '\n# Local Remote Paint targets (native/prepare.mjs).\ngroup("remote_paint_tools") {\n  deps = [ "//components/remote_paint:serializer_tests" ]\n}\n';
  await writeFile(rootBuild, build);
}
const output = join(source, 'out/RemotePaint');
await mkdir(output, { recursive: true });
await cp(new URL('./mac-arm64.args.gn', import.meta.url), join(output, 'args.gn'));
console.log(`Prepared ${source}; generate out/RemotePaint and build remote_paint_tools`);
