const assert = require('node:assert/strict');
const { fixture, click, openedModals } = require('./test-host.cjs');
const model = require('../src/main.js');
const { createLibraryService } = require('../src/library-service.js');
const createService = (f) => createLibraryService({ app: f.app, plugin: f.plugin, model });
const source = 'papers/test/【2026】a/【2026】a.md';
const target = 'papers/test/【2026】b/【2026】b.md';
const nodes = [{ path: source, basename: '【2026】a' }, { path: target, basename: '【2026】b' }];
const pdf = { name: 'paper.pdf', arrayBuffer: async () => new Uint8Array([37, 80, 68, 70, 45, 49]).buffer };
const payload = { file: pdf, dirName: 'test', year: '2026', slug: 'imported', title: 'Imported paper', tags: ['test'], authors: ['Author'], summary: 'Meaningful summary', abstract: '' };
const importedPath = 'papers/test/【2026】imported/【2026】imported.md';
async function ready() {
  const f = fixture();
  await f.app.vault.create('【索引】研究总览.md', '---\ntitle: 研究总览\n---\n');
  return f;
}
async function relationFixture() {
  const f = await ready();
  f.contents.set(source, model.patchRelation(f.contents.get(source), { add: { field: 'extends', target: nodes[1].basename } }));
  return f;
}
const has = (f, path, base) => model.readRelation(f.contents.get(path), 'extends').includes(base);
const tests = [];
const test = (name, run) => tests.push({ name, run });

test('Relation flip commits both endpoints and preserves unrelated notes', async () => {
  const f = await relationFixture(); const service = createService(f);
  await service.reverseRelation(...nodes, 'extends');
  assert.equal(has(f, source, nodes[1].basename), false);
  assert.equal(has(f, target, nodes[0].basename), true);
  assert.ok(f.contents.get(source).includes('不可覆盖的方法a'));
  assert.deepEqual(await service.pendingOperations(), []);
});
test('Failure of the second relation write restores the original', async () => {
  const f = await relationFixture(); const process = f.app.vault.process; let once = true;
  f.app.vault.process = async (file, fn) => {
    if (file.path === source && once) { once = false; throw new Error('disk full'); }
    return process(file, fn);
  };
  const service = createService(f);
  await assert.rejects(service.reverseRelation(...nodes, 'extends'), /原关系已恢复/);
  assert.equal(has(f, source, nodes[1].basename), true);
  assert.equal(has(f, target, nodes[0].basename), false);
  assert.deepEqual(await service.pendingOperations(), []);
});
test('A write that mutates then throws is also compensated', async () => {
  const f = await relationFixture(); const process = f.app.vault.process; let count = 0;
  f.app.vault.process = async (file, fn) => {
    const result = await process(file, fn);
    if (++count === 2) throw new Error('write completed but callback failed');
    return result;
  };
  await assert.rejects(createService(f).reverseRelation(...nodes, 'extends'), /原关系已恢复/);
  assert.ok(has(f, source, nodes[1].basename)); assert.ok(!has(f, target, nodes[0].basename));
});
test('Compensation failure leaves a surviving relation and can be recovered after restart', async () => {
  const f = await relationFixture(); const process = f.app.vault.process; let count = 0;
  f.app.vault.process = async (file, fn) => {
    if ([2, 4].includes(++count)) throw new Error('injected failure');
    return process(file, fn);
  };
  const service = createService(f);
  await assert.rejects(service.reverseRelation(...nodes, 'extends'), /恢复未完成操作/);
  assert.ok(has(f, source, nodes[1].basename) || has(f, target, nodes[0].basename));
  assert.equal((await service.pendingOperations()).length, 1);
  // Other edits made between the failure and recovery must survive.
  f.contents.set(source, f.contents.get(source) + '\n人工新增批注\n');
  f.app.vault.process = process;
  const restarted = createService(f);
  assert.equal((await restarted.recoverRelations())[0].ok, true);
  assert.ok(has(f, source, nodes[1].basename)); assert.ok(!has(f, target, nodes[0].basename));
  assert.ok(f.contents.get(source).includes('人工新增批注'));
  assert.deepEqual(await restarted.pendingOperations(), []);
});
test('A pre-existing reverse edge is not removed by compensation', async () => {
  const f = await relationFixture();
  f.contents.set(target, model.patchRelation(f.contents.get(target), { add: { field: 'extends', target: nodes[0].basename } }));
  const process = f.app.vault.process; let once = true;
  f.app.vault.process = async (file, fn) => { if (file.path === source && once) { once = false; throw Error('fail'); } return process(file, fn); };
  await assert.rejects(createService(f).reverseRelation(...nodes, 'extends'));
  assert.ok(has(f, source, nodes[1].basename)); assert.ok(has(f, target, nodes[0].basename));
});
test('Interrupted operation-record write recovers from the last good backup', async () => {
  const f = await relationFixture(); const service = createService(f);
  const process = f.app.vault.process; let count = 0;
  f.app.vault.process = async (file, fn) => { if ([2, 4].includes(++count)) throw Error('stop'); return process(file, fn); };
  await assert.rejects(service.reverseRelation(...nodes, 'extends'));
  const journal = '.obsidian/plugins/pinakes-explorer/operations.json';
  await f.app.vault.adapter.write(journal + '.bak', await f.app.vault.adapter.read(journal));
  await f.app.vault.adapter.write(journal, '{interrupted');
  f.app.vault.process = process;
  assert.equal((await createService(f).recoverRelations())[0].ok, true);
  assert.ok(has(f, source, nodes[1].basename)); assert.ok(!has(f, target, nodes[0].basename));
});
test('PDF source-read failure creates no paper directory', async () => {
  const f = await ready(); const service = createService(f);
  await assert.rejects(service.importPaper({ ...payload, file: { arrayBuffer: async () => { throw Error('cannot read'); } } }));
  assert.equal(f.app.vault.getAbstractFileByPath('papers/test/【2026】imported'), undefined);
  assert.deepEqual(await service.pendingOperations(), []);
});
test('PDF copy failure is retryable with exactly one PDF and note', async () => {
  const f = await ready(); const original = f.app.vault.createBinary; let once = true;
  f.app.vault.createBinary = async (...args) => { if (once) { once = false; throw Error('copy failed'); } return original(...args); };
  await assert.rejects(createService(f).importPaper(payload), /重试导入/);
  assert.ok(f.app.vault.getAbstractFileByPath('papers/test/【2026】imported'));
  const service = createService(f); const result = await service.importPaper(payload);
  assert.equal(result.notePath, importedPath);
  assert.equal(f.app.vault.getAbstractFileByPath(result.folderPath).children.length, 2);
  assert.ok(f.contents.get('papers/test/【索引】test.md').includes('Imported paper'));
  assert.deepEqual(await service.pendingOperations(), []);
});
test('Note creation failure resumes with an already copied PDF', async () => {
  const f = await ready(); const original = f.app.vault.create; let once = true;
  f.app.vault.create = async (path, text) => { if (path === importedPath && once) { once = false; throw Error('note failed'); } return original(path, text); };
  const service = createService(f);
  await assert.rejects(service.importPaper(payload));
  await service.importPaper(payload);
  assert.equal(f.app.vault.getAbstractFileByPath('papers/test/【2026】imported').children.length, 2);
});
test('Index write failure can be completed from persisted recovery records', async () => {
  const f = await ready(); const original = f.app.vault.process; let once = true;
  f.app.vault.process = async (file, fn) => { if (file.path.endsWith('【索引】test.md') && once) { once = false; throw Error('index failed'); } return original(file, fn); };
  const service = createService(f); await assert.rejects(service.importPaper(payload));
  const operation = (await service.pendingOperations())[0]; assert.ok(f.contents.has(importedPath));
  await createService(f).finishImport(operation.id);
  assert.ok(f.contents.get('papers/test/【索引】test.md').includes('Imported paper'));
  assert.deepEqual(await service.pendingOperations(), []);
});
test('Retry never overwrites manually changed imported notes', async () => {
  const f = await ready(); const original = f.app.vault.process;
  f.app.vault.process = async () => { throw Error('index blocked'); };
  const service = createService(f); await assert.rejects(service.importPaper(payload));
  f.contents.set(importedPath, f.contents.get(importedPath) + '\n人工内容\n');
  f.app.vault.process = original;
  await assert.rejects(service.importPaper(payload), /已被修改/);
  await assert.rejects(service.cancelImport((await service.pendingOperations())[0].id), /已被修改/);
  assert.ok(f.contents.get(importedPath).includes('人工内容'));
});
test('Undo only trashes unchanged files created by this import', async () => {
  const f = await ready(); f.app.vault.createBinary = async () => { throw Error('copy failed'); };
  const service = createService(f); await assert.rejects(service.importPaper(payload));
  const op = (await service.pendingOperations())[0];
  await service.cancelImport(op.id);
  assert.equal(f.app.vault.getAbstractFileByPath(op.folderPath), undefined);
  assert.ok(f.contents.has(source)); assert.ok(f.contents.has(target));
});
test('A newly created empty direction is a valid drop target and subtree', async () => {
  const f = await ready(); await f.plugin.onload();
  await f.app.vault.createFolder('papers/empty');
  await f.app.vault.create('papers/empty/【索引】empty.md', '---\nkind: direction\ntitle: Empty\n---\n## 论文\n');
  const service = createService(f); const state = await service.snapshot();
  const view = f.plugin.views.get('pinakes-explorer-view')({ app: f.app });
  view.index = state.index; view.schema = state.schema; view.dragPath = source;
  const node = state.index.nodes.get('papers/empty/【索引】empty.md');
  assert.equal(node.children.length, 0);
  assert.equal(view.canMoveTo(node), true);
  assert.equal(view.canMoveTo(state.index.root), false);
  assert.equal(model.computeSubGraph(state.index, node.path).mode, 'subtree');
  const sourcePdf = source.replace(/\.md$/, '.pdf');
  await f.app.vault.createBinary(sourcePdf, await pdf.arrayBuffer());
  f.app.fileManager = { renameFile: async (folder, newPath) => {
    const files = [...folder.children];
    const root = folder.path;
    await f.app.vault.createFolder(newPath);
    for (const file of files) {
      const newFilePath = newPath + file.path.slice(root.length);
      const text = f.contents.get(file.path);
      if (file.extension === 'pdf') await f.app.vault.createBinary(newFilePath, text);
      else await f.app.vault.create(newFilePath, text);
    }
    await f.app.vault.trash(folder);
  } };
  view.reindexAndRender = async () => view.reindex();
  await view.moveNote(source, node);
  const movedPath = 'papers/empty/【2026】a/【2026】a.md';
  assert.ok(f.contents.has(movedPath)); assert.equal(f.contents.has(source), false);
  assert.ok(f.contents.has(movedPath.replace(/\.md$/, '.pdf'))); assert.equal(f.contents.has(sourcePdf), false);
  assert.ok(f.contents.get(movedPath).includes('[[【索引】empty]]'));
  assert.ok(f.contents.get(node.path).includes('【2026】a'));
});
test('Standalone empty-vault Home opens all four native content pages and can create research notes', async () => {
  const f = fixture(true); await f.plugin.onload(); const home = await f.plugin.activateHome();
  for (const [label, mode] of [['阅读队列', 'queue'], ['论文库', 'papers'], ['专题研究', 'topic'], ['研究想法', 'idea']]) {
    await click(home, label); const view = f.app.workspace.activeLeaf.view;
    assert.equal(view.mode, mode); assert.equal(view.entries.length, 0);
    assert.ok(view.list.children.length > 0);
  }
  const service = createService(f);
  await service.ensurePaperStructure();
  await service.importPaper({ ...payload, file: null, dirName: '_unfiled' });
  await click(home, '阅读队列');
  const queue = f.app.workspace.activeLeaf.view; assert.equal(queue.entries.length, 1);
  await click(queue, '打开论文卡片'); const reader = f.plugin.browseModal; await reader.opened;
  assert.ok(reader.file.path.includes('imported')); await click(reader, '已读'); await reader.close();
  assert.equal(queue.list.children[0].tag, 'div', 'Read papers leave the active reading queue');
  await click(home, '专题研究'); const topic = f.app.workspace.activeLeaf.view;
  await click(topic, '新建专题'); const modal = openedModals.at(-1);
  modal.contentEl.querySelectorAll('input')[0].value = '研究问题';
  await click(modal, '创建并打开');
  assert.equal(modal.nativeClosed, true); assert.ok(f.app.openedFile.path.includes('【Deep Research】'));
  await click(home, '研究想法'); const idea = f.app.workspace.activeLeaf.view;
  await click(idea, '记录想法'); const ideaModal = openedModals.at(-1);
  ideaModal.contentEl.querySelectorAll('input')[0].value = '新的方案';
  await click(ideaModal, '创建并打开');
  assert.ok(f.app.openedFile.path.includes('【idea】')); assert.equal(model.parseFrontmatter(f.contents.get(f.app.openedFile.path)).stage, '待做');
  assert.equal(f.leaves.filter(l => l.type === 'pinakes-explorer-view').length, 0);
});
test('Import dialog retains its form on async failure and closes only after a successful result', async () => {
  const f = await ready(); await f.plugin.onload(); const home = await f.plugin.activateHome();
  await click(home, '添加论文'); const modal = openedModals.at(-1);
  const inputs = modal.contentEl.querySelectorAll('input');
  inputs.find(i => i.placeholder === String(new Date().getFullYear())).value = '2026';
  inputs.find(i => (i.placeholder || '').includes('my-paper')).value = 'dialog';
  inputs.find(i => i.placeholder === '英文原题').value = 'Dialog paper';
  let resolve; let calls = 0;
  modal.onSubmit = async () => { calls++; return new Promise(r => { resolve = r; }); };
  const save = click(modal, '创建');
  await Promise.resolve(); assert.equal(modal.nativeClosed, undefined); assert.equal(calls, 1);
  modal.close(); assert.equal(modal.nativeClosed, undefined, 'Close during writing must not discard form');
  resolve(null); await save;
  assert.equal(modal.nativeClosed, undefined); assert.ok(modal.contentEl.querySelectorAll('input').length > 0);
  assert.equal(inputs.find(i => i.placeholder === '英文原题').value, 'Dialog paper');
  modal.onSubmit = async (input) => createService(f).importPaper(input);
  await click(modal, '重试导入');
  assert.ok(modal.contentEl.querySelectorAll('button').some(b => b.textContent === '打开论文卡片'));
  await click(modal, '打开论文卡片'); assert.equal(modal.nativeClosed, true); await f.plugin.browseModal.opened; assert.ok(f.plugin.browseModal.file.path.includes('dialog')); await f.plugin.browseModal.close();
});
test('Creating a research idea first still initializes a usable graph root for later paper import', async () => {
  const f = fixture(true); const service = createService(f);
  await service.createResearchNote('idea', 'First idea');
  const imported = await service.importPaper({ ...payload, file: null, dirName: '_unfiled' });
  const state = await service.snapshot();
  assert.ok(state.index.root);
  assert.ok(state.index.nodes.get(imported.notePath).parent);
  assert.equal(state.index.nodes.get(imported.notePath).statusField, 'reading');
  assert.equal([...state.index.nodes.values()].filter(n => n.kind === 'idea').length, 1);
});
test('Native paper list filters year, state, importance, tags and summary without a template', async () => {
  const f = await ready(); await f.plugin.onload();
  f.contents.set(source, f.contents.get(source).replace('year: 2026', 'year: 2025').replace('importance: 1\n', '').replace('简介a', 'ranking method'));
  const view = await f.plugin.activateLibrary('papers');
  assert.equal(view.entries.length, 2);
  const filter = async (key, value) => { view.selects[key].value = value; await view.selects[key].events.change(); };
  await filter('year', '2025'); assert.equal(view.list.children.length, 1); assert.ok(view.list.children[0].querySelectorAll('button')[0].textContent.includes('a'));
  await filter('year', ''); await filter('importance', 'none'); assert.equal(view.list.children.length, 1);
  await filter('importance', ''); view.search.value = 'ranking'; view.search.events.input(); assert.equal(view.list.children.length, 1);
  view.search.value = ''; view.search.events.input(); await filter('tag', 'missing'); assert.equal(view.list.children[0].tag, 'div');
  await filter('tag', ''); await filter('reading', '已读'); assert.equal(view.list.children[0].tag, 'div');
});
test('Home and graph navigation reuse the same page without a split', async () => {
  const f = fixture(true); await f.plugin.onload();
  await f.plugin.activateHome();
  const leaf = f.app.workspace.activeLeaf;
  let leafRequests = 0;
  const getLeaf = f.app.workspace.getLeaf;
  f.app.workspace.getLeaf = (...args) => { leafRequests++; assert.notEqual(args[0], 'split'); return getLeaf(...args); };
  // This test checks routing, not Canvas rendering.
  f.plugin.views.set('pinakes-explorer-view', () => ({ getViewType: () => 'pinakes-explorer-view', onOpen: async () => {} }));
  await f.plugin.activateView();
  assert.equal(f.app.workspace.activeLeaf, leaf);
  assert.equal(leafRequests, 0);
  await f.plugin.activateHome();
  assert.equal(f.app.workspace.activeLeaf, leaf);
  assert.equal(leaf.view.getViewType(), 'pinakes-home-view');
  assert.equal(leafRequests, 0);
});
test('Late PDF parsing cannot overwrite a newer file selection or manual title', async () => {
  const f = await ready(); await f.plugin.onload(); const home = await f.plugin.activateHome();
  await click(home, '添加论文'); const modal = openedModals.at(-1);
  const input = modal.contentEl.querySelectorAll('input').find(i => i.attributes.accept);
  const title = modal.contentEl.querySelectorAll('input').find(i => i.placeholder === '英文原题');
  let release; const slow = { name: '2026-first.pdf', size: 8, arrayBuffer: () => new Promise(r => { release = r; }) };
  input.files = [slow]; const first = input.events.change();
  input.files = [{ name: '2026-second.pdf', size: 8, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 /Title (Second Paper)').buffer }];
  await input.events.change(); title.value = '我的标题'; title.events.input();
  release(new TextEncoder().encode('%PDF-1.4 /Title (First Delayed Paper)').buffer); await first;
  assert.equal(title.value, '我的标题'); assert.equal(modal.file.name, '2026-second.pdf');
  const third = { name: '2026-third.pdf', size: 8, arrayBuffer: () => new Promise(r => { release = r; }) };
  input.files = [third]; const pending = input.events.change();
  title.value = '人工输入'; title.events.input();
  release(new TextEncoder().encode('%PDF-1.4 /Title (Should Not Replace Manual Title)').buffer); await pending;
  assert.equal(title.value, '人工输入'); modal.close();
});

(async () => {
  for (const { name, run } of tests) { await run(); console.log('  ✓ ' + name); }
  console.log(`All ${tests.length} reliability workflows passed using a fixed in-memory vault.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
