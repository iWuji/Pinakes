const assert = require('node:assert/strict');
const { fixture, click, openedModals } = require('./test-host.cjs');
const model = require('../src/main.js');
const { createLibraryService } = require('../src/library-service.js');
const { createReadingSession } = require('../src/reading-session.js');
const service = f => createLibraryService({ app: f.app, plugin: f.plugin, model });
const a = 'papers/test/【2026】a/【2026】a.md', b = 'papers/test/【2026】b/【2026】b.md';
const pdfFile = content => ({ name: 'original.pdf', arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4\n' + content).buffer });
const textOf = bytes => Buffer.from(bytes).toString();
async function setup() {
  const f = fixture();
  await f.app.vault.create('【索引】研究总览.md', '---\ntitle: Root\n---\n');
  await f.plugin.onload();
  await f.app.vault.createFolder('papers/next');
  await f.app.vault.create('papers/next/【索引】next.md', '---\nkind: direction\ntitle: Next\n---\n## 论文\n');
  return f;
}
const target = 'papers/next/【索引】next.md';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('Continue reading restores Browse scroll and leaves reading status unchanged', async () => {
  const f = await setup();
  f.plugin.openBrowse(a); let modal = f.plugin.browseModal; await modal.opened;
  modal.article.scrollHeight = 1200; modal.article.clientHeight = 400; modal.article.scrollTop = 320;
  await modal.close();
  assert.equal(model.parseFrontmatter(f.contents.get(a)).reading, '未读');
  assert.equal(f.plugin.settings.readingHistory[0].path, a);
  assert.equal(f.plugin.settings.readingHistory[0].position.top, 320);
  // Layout dimensions are available after render in real Obsidian.
  f.plugin.openBrowse(a, true); modal = f.plugin.browseModal;
  modal.article.scrollHeight = 1200; modal.article.clientHeight = 400;
  await modal.opened;
  assert.equal(modal.article.scrollTop, 320);
  assert.equal(modal.sections.overview.input.visible, false);
  await modal.close();
  const home = await f.plugin.activateHome();
  assert.ok(home.continueEl.querySelectorAll('button').length === 1);
  await click(home, '继续阅读'); await f.plugin.browseModal.opened; await f.plugin.browseModal.close();
});
test('History persists across session instances and ignores missing papers on Home', async () => {
  const f = await setup(); const session = createReadingSession(f.plugin);
  await session.remember(a, 'A', { kind: 'browse', top: 42, ratio: .2, max: 210 });
  const resumed = createReadingSession(f.plugin);
  assert.equal(resumed.position(a).top, 42);
  await resumed.remember('papers/deleted.md', 'Deleted');
  const home = await f.plugin.activateHome();
  await click(home, '继续阅读'); await f.plugin.browseModal.opened;
  assert.equal(f.plugin.browseModal.file.path, a); await f.plugin.browseModal.close();
});
test('Native Markdown reading resumes with the public view state', async () => {
  const f = await setup();
  await createReadingSession(f.plugin).remember(a, 'A', { kind: 'markdown', state: { mode: 'preview', scroll: 17 } });
  const home = await f.plugin.activateHome(); await click(home, '继续阅读');
  assert.equal(f.app.openedFile.path, a);
  assert.equal(f.app.openedState.state.scroll, 17);
});
test('Home search enters native list with the query and refresh retains filters', async () => {
  const f = await setup(); const home = await f.plugin.activateHome();
  home.search.value = '简介a';
  const form = home.page.children.find(c => c.tag === 'form');
  await form.events.submit({ preventDefault() {} });
  const list = f.app.workspace.activeLeaf.view;
  assert.equal(list.filters.q, '简介a'); assert.equal(list.search.value, '简介a');
  assert.equal(list.visibleEntries.length, 1); assert.equal(list.visibleEntries[0].path, a);
  list.selects.year.value = '2026'; list.selects.year.events.change();
  await f.plugin.activateLibrary('papers');
  assert.equal(list.filters.q, '简介a'); assert.equal(list.filters.year, '2026');
  assert.equal(JSON.stringify(list.getState().filters), JSON.stringify(list.filters));
});
test('Add PDF updates frontmatter and the original entry, preserving notes and other fields', async () => {
  const f = await setup(); const svc = service(f); const before = f.contents.get(a);
  const result = await svc.replacePdf(a, pdfFile('new original'));
  const after = f.contents.get(a);
  const expected = '【2026】a.pdf';
  assert.equal(model.parseFrontmatter(after).pdf, expected);
  assert.ok(after.includes('[[【2026】a.pdf|在侧栏打开原文]]'));
  assert.ok(after.includes('不可覆盖的方法a')); assert.ok(after.includes('个人记录a'));
  assert.equal(model.parseFrontmatter(after).reading, '未读');
  assert.ok(textOf(f.contents.get(result.pdfPath)).includes('new original'));
  assert.equal(await f.app.vault.adapter.read(result.backupDir + '/note.md'), before);
  assert.deepEqual(await svc.pendingOperations(), []);
});
test('Replace PDF backs up old bytes and reuses the same file name', async () => {
  const f = await setup(); const svc = service(f);
  const first = await svc.replacePdf(a, pdfFile('old original'));
  const second = await svc.replacePdf(a, pdfFile('new original'));
  assert.equal(second.pdfPath, first.pdfPath);
  assert.ok(textOf(await f.app.vault.adapter.readBinary(second.backupDir + '/original.pdf')).includes('old original'));
  assert.ok(textOf(f.contents.get(second.pdfPath)).includes('new original'));
  assert.equal((f.contents.get(a).match(/原文 PDF：/g) || []).length, 1);
});
test('PDF metadata-write failure restores original bytes and reference', async () => {
  const f = await setup(); const svc = service(f); const first = await svc.replacePdf(a, pdfFile('old'));
  const before = f.contents.get(a); const process = f.app.vault.process; let once = true;
  f.app.vault.process = async (file, fn) => { if (file.path === a && once) { once = false; throw Error('metadata failed'); } return process(file, fn); };
  await assert.rejects(svc.replacePdf(a, pdfFile('replacement')), /已恢复/);
  assert.equal(f.contents.get(a), before); assert.ok(textOf(f.contents.get(first.pdfPath)).includes('old'));
  assert.deepEqual(await svc.pendingOperations(), []);
});
test('A PDF rollback failure survives restart and can restore from the backup', async () => {
  const f = await setup(); const svc = service(f); const first = await svc.replacePdf(a, pdfFile('old'));
  const process = f.app.vault.process, modify = f.app.vault.modifyBinary; let count = 0;
  f.app.vault.process = async () => { throw Error('metadata stopped'); };
  f.app.vault.modifyBinary = async (...args) => { if (++count === 2) throw Error('restore stopped'); return modify(...args); };
  await assert.rejects(svc.replacePdf(a, pdfFile('replacement')), /恢复操作/);
  const pending = (await svc.pendingOperations())[0]; assert.equal(pending.kind, 'pdf');
  f.app.vault.process = process; f.app.vault.modifyBinary = modify;
  await service(f).recoverOperation(pending.id);
  assert.ok(textOf(f.contents.get(first.pdfPath)).includes('old'));
  assert.deepEqual(await svc.pendingOperations(), []);
});
test('Invalid or unassociated colliding PDFs are not overwritten', async () => {
  const f = await setup(); const svc = service(f);
  await assert.rejects(svc.replacePdf(a, { name: 'bad.pdf', arrayBuffer: async () => new TextEncoder().encode('not PDF').buffer }), /不是可读取/);
  const colliding = a.replace(/\.md$/, '.pdf'); await f.app.vault.createBinary(colliding, await pdfFile('unassociated').arrayBuffer());
  await assert.rejects(svc.replacePdf(a, pdfFile('replacement')), /已有同名/);
  assert.ok(textOf(f.contents.get(colliding)).includes('unassociated')); assert.deepEqual(await svc.pendingOperations(), []);
});
test('PDF dialog selects a file and saves without manual metadata edits', async () => {
  const f = await setup(); const modal = await f.plugin.openPdfDialog(a);
  modal.contentEl.querySelectorAll('input')[0].files = [pdfFile('dialog original')];
  await click(modal, '保存 PDF');
  assert.equal(model.parseFrontmatter(f.contents.get(a)).pdf, '【2026】a.pdf');
  await click(modal, '打开 PDF'); assert.ok(f.app.openedFile.path.endsWith('.pdf'));
  await click(modal, '完成'); assert.equal(modal.nativeClosed, true);
});
test('Batch archive moves both notes/PDFs, updates indices and reading history', async () => {
  const f = await setup(); const svc = service(f); await svc.replacePdf(a, pdfFile('A PDF'));
  await createReadingSession(f.plugin).remember(a, 'A', { kind: 'browse', top: 40 });
  f.plugin.settings.nodeColors = { [a]: '#ff0000' };
  const results = await svc.movePapers([a, b, a], target);
  assert.equal(results.length, 2); assert.ok(results.every(r => r.ok));
  const moved = a.replace('/test/', '/next/');
  assert.ok(f.contents.has(moved)); assert.ok(f.contents.has(moved.replace(/\.md$/, '.pdf')));
  assert.ok(f.contents.get(moved).includes('[[【索引】next]]'));
  assert.equal(f.plugin.settings.readingHistory[0].path, moved);
  assert.equal(f.plugin.settings.nodeColors[moved], '#ff0000');
  assert.ok(!f.contents.get('papers/test/【索引】test.md').includes('【2026】a'));
  assert.ok(f.contents.get(target).includes('【2026】a')); assert.deepEqual(await svc.pendingOperations(), []);
});
test('Batch collisions report per-paper results and leave conflicting notes untouched', async () => {
  const f = await setup(); const svc = service(f);
  await f.app.vault.createFolder('papers/next/【2026】a');
  await f.app.vault.create('papers/next/【2026】a/【2026】a.md', 'Existing note');
  const results = await svc.movePapers([a, b], target);
  assert.equal(results[0].ok, false); assert.match(results[0].error, /同名/); assert.equal(results[1].ok, true);
  assert.ok(f.contents.has(a)); assert.equal(f.contents.get(a.replace('/test/', '/next/')), 'Existing note');
});
test('Interrupted archive continues after restart and keeps human body edits', async () => {
  const f = await setup(); const svc = service(f); const process = f.app.vault.process; let once = true;
  const moved = a.replace('/test/', '/next/');
  f.app.vault.process = async (file, fn) => { if (file.path === moved && once) { once = false; throw Error('direction interrupted'); } return process(file, fn); };
  const result = await svc.movePapers([a, b], target);
  assert.equal(result[0].ok, false); assert.equal(result[0].moved, true); assert.equal(result[1].ok, true);
  f.contents.set(moved, f.contents.get(moved) + '\n移动后的人工批注\n');
  const operation = (await svc.pendingOperations())[0]; assert.equal(operation.kind, 'move');
  f.app.vault.process = process; await service(f).recoverOperation(operation.id);
  assert.ok(f.contents.get(moved).includes('移动后的人工批注'));
  assert.ok(f.contents.get(moved).includes('[[【索引】next]]')); assert.deepEqual(await svc.pendingOperations(), []);
});
test('List selection persists across filters; archive requires explicit confirmation', async () => {
  const f = await setup(); const list = await f.plugin.activateLibrary('papers');
  await click(list, '选择本页结果'); assert.equal(list.selectedPapers.size, 2);
  list.search.value = '简介a'; list.search.events.input(); assert.equal(list.visibleEntries.length, 1);
  assert.equal(list.selectedPapers.size, 2);
  await click(list, '归档所选论文'); const modal = openedModals.at(-1);
  assert.ok(f.contents.has(a)); assert.ok(f.contents.has(b));
  modal.contentEl.querySelectorAll('select')[0].value = target;
  await click(modal, '确认归档');
  assert.ok(f.contents.has(a.replace('/test/', '/next/'))); assert.ok(f.contents.has(b.replace('/test/', '/next/')));
  assert.equal(list.selectedPapers.size, 0); await click(modal, '关闭');
});

(async () => {
  for (const { name, fn } of tests) { await fn(); console.log('  ✓ ' + name); }
  console.log(`All ${tests.length} stage-two workflows passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
