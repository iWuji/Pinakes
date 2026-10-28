// Test exactly the three files Obsidian downloads, without sibling source modules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinakes-plugin-'));
try {
  for (const name of ['main.js', 'manifest.json', 'styles.css']) {
    fs.copyFileSync(path.join(root, name), path.join(tmp, name));
  }
  const bundled = require(path.join(tmp, 'main.js'));
  const source = require('../src/main.js');
  assert.ok(bundled.adapters, 'Locator adapter must be bundled');
  assert.deepEqual(bundled.adapters.parseLocator('ssh://user@host/path'), source.adapters.parseLocator('ssh://user@host/path'));
  assert.deepEqual(bundled.REL_META, source.REL_META);
  assert.deepEqual(bundled.DEFAULT_SCHEMA, source.DEFAULT_SCHEMA);
  const moduleStub = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(tmp, 'main.js'), 'utf8'), {
    module: moduleStub,
    exports: moduleStub.exports,
    require: (id) => id === 'obsidian' ? {
      Plugin: class {}, ItemView: class {}, PluginSettingTab: class {},
      SuggestModal: class {}, Modal: class {},
    } : require(id),
  });
  assert.equal(typeof moduleStub.exports, 'function', 'Obsidian must receive the plugin class');
  console.log('Standalone three-file plugin bundle verified.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
