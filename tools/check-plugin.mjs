import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL('../' + name, import.meta.url)));
const manifest = read('manifest.json');
const pkg = read('package.json');
const versions = read('versions.json');
assert.equal(manifest.id, 'pinakes-explorer');
for (const key of ['name', 'description', 'author', 'minAppVersion']) {
  assert.equal(typeof manifest[key], 'string', key);
  assert.ok(manifest[key].trim(), key);
}
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.match(manifest.minAppVersion, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.isDesktopOnly, true);
assert.equal(pkg.version, manifest.version);
assert.equal(versions[manifest.version], manifest.minAppVersion);
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, manifest.version,
    `Release tag "${process.env.GITHUB_REF_NAME}" does not match manifest.version "${manifest.version}". ` +
    `Update manifest.json, package.json and versions.json together before tagging. Use "${manifest.version}" without a v prefix.`);
}
for (const file of ['main.js', 'styles.css']) {
  assert.ok(readFileSync(new URL('../' + file, import.meta.url)).length, file);
}
console.log('Plugin metadata and release files verified.');

// The optional vault installer must ship every plugin it enables.
const template = 'installer/template/.obsidian/';
const enabled = read(template + 'community-plugins.json');
assert.ok(Array.isArray(enabled) && enabled.length, 'Template must declare enabled plugins');
assert.equal(new Set(enabled).size, enabled.length, 'Duplicate enabled plugin IDs');
const bundled = readdirSync(new URL('../' + template + 'plugins/', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
assert.deepEqual([...enabled].sort(), bundled.sort(), 'Bundled plugins and enabled list must match');
let minimum = manifest.minAppVersion;
const compareVersion = (a, b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
};
for (const id of enabled) {
  assert.match(id, /^[a-z0-9-]+$/);
  const prefix = template + 'plugins/' + id + '/';
  const plugin = read(prefix + 'manifest.json');
  assert.equal(plugin.id, id, 'Plugin directory must match manifest.id');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.match(plugin.minAppVersion, /^\d+\.\d+\.\d+$/);
  assert.ok(readFileSync(new URL('../' + prefix + 'main.js', import.meta.url)).length, id + ' entry point');
  if (id === manifest.id) assert.deepEqual(plugin, manifest, 'Template Pinakes manifest must match root');
  if (compareVersion(plugin.minAppVersion, minimum) > 0) minimum = plugin.minAppVersion;
}
console.log(`Vault bundle verified: ${enabled.length} plugins; minimum Obsidian ${minimum}.`);
