import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
for (const [type, ref, expected] of [
  ['branch', 'main', 0],
  ['tag', version, 0],
  ['tag', '0.0.2', 1],
  ['tag', `v${version}`, 1],
]) {
  const result = spawnSync(process.execPath, ['tools/check-plugin.mjs'], {
    cwd: root,
    env: { ...process.env, GITHUB_REF_TYPE: type, GITHUB_REF_NAME: ref },
    encoding: 'utf8',
  });
  assert.equal(result.status, expected, `${type} ${ref}: ${result.stdout}\n${result.stderr}`);
  if (expected) assert.match(result.stderr, /does not match manifest.version/);
}
console.log('Branch, matching release tag, mismatched tag and v-prefix checks verified.');
