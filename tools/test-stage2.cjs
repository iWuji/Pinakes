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

test('Delete paper backs up and trashes the entire folder, updates index and keeps other papers', async () => {
  const f = await setup(); const svc = service(f);
  const pdf = a.replace(/\.md$/, '.pdf');
  await f.app.vault.createBinary(pdf, await pdfFile('delete original').arrayBuffer());
  await f.app.vault.createFolder('papers/test/【2026】a/assets');
  await f.app.vault.createBinary('papers/test/【2026】a/assets/image.png', new Uint8Array([1, 2, 3]).buffer);
  const before = f.contents.get(a);
  await createReadingSession(f.plugin).remember(a, 'A');
  f.plugin.settings.nodeColors = { [a]: '#ff0000', [b]: '#00ff00' };
  const result = await svc.deletePaper(a);
  assert.equal(result.deleted, true); assert.equal(result.warning, null);
  assert.equal(f.app.vault.getAbstractFileByPath('papers/test/【2026】a'), undefined);
  assert.ok(f.contents.has(b));
  assert.equal(textOf(await f.app.vault.adapter.readBinary(result.backupDir + '/【2026】a.md')), before);
  assert.ok(textOf(await f.app.vault.adapter.readBinary(result.backupDir + '/【2026】a.pdf')).includes('delete original'));
  assert.deepEqual([...new Uint8Array(await f.app.vault.adapter.readBinary(result.backupDir + '/assets/image.png'))], [1, 2, 3]);
  assert.equal(f.plugin.settings.nodeColors[a], undefined); assert.equal(f.plugin.settings.nodeColors[b], '#00ff00');
  assert.equal(f.plugin.settings.readingHistory.length, 0);
  assert.ok(!f.contents.get('papers/test/【索引】test.md').includes('简介a'));
  assert.deepEqual(await svc.pendingOperations(), []);
});
test('Deletion confirmation can be cancelled and confirmed from the list', async () => {
  const f = await setup(); const list = await f.plugin.activateLibrary('papers');
  await click(list, '删除论文'); const dialog = openedModals.at(-1);
  assert.ok(f.contents.has(a)); assert.ok(f.contents.has(b));
  await click(dialog, '取消'); assert.equal(f.app.vault.getMarkdownFiles().filter(file => [a, b].includes(file.path)).length, 2);
  const modal = await f.plugin.openDeletePaper(a);
  await click(modal, '移到回收站'); assert.equal(modal.nativeClosed, true);
  assert.equal(f.contents.has(a), false); assert.ok(f.contents.has(b));
});
test('Backup or trash failure leaves paper intact; post-delete index failure is recoverable', async () => {
  const f = await setup(); const svc = service(f); const write = f.app.vault.adapter.writeBinary;
  f.app.vault.adapter.writeBinary = async () => { throw Error('backup unavailable'); };
  await assert.rejects(svc.deletePaper(a)); assert.ok(f.contents.has(a));
  f.app.vault.adapter.writeBinary = write;
  const trash = f.app.vault.trash;
  f.app.vault.trash = async () => { throw Error('trash unavailable'); };
  await assert.rejects(svc.deletePaper(a), /仍保留/); assert.ok(f.contents.has(a)); assert.deepEqual(await svc.pendingOperations(), []);
  f.app.vault.trash = trash;
  const process = f.app.vault.process;
  f.app.vault.process = async () => { throw Error('index unavailable'); };
  const result = await svc.deletePaper(a); assert.equal(result.deleted, true); assert.match(result.warning, /恢复操作/);
  assert.equal(f.contents.has(a), false);
  const operation = (await svc.pendingOperations())[0]; assert.equal(operation.kind, 'delete');
  f.app.vault.process = process;
  await service(f).recoverOperation(operation.id); assert.deepEqual(await svc.pendingOperations(), []);
});
test('Delete refuses directory indices and closes Browse only after confirmation', async () => {
  const f = await setup();
  await assert.rejects(service(f).deletePaper('papers/test/【索引】test.md'), /未删除/);
  f.plugin.openBrowse(a); const reader = f.plugin.browseModal; await reader.opened;
  await click(reader, '删除论文'); const dialog = openedModals.at(-1);
  assert.equal(reader.closed, false); await click(dialog, '取消'); assert.equal(reader.closed, false);
  await click(reader, '删除论文'); await click(openedModals.at(-1), '移到回收站');
  assert.equal(reader.closed, true); assert.equal(f.plugin.browseModal, null); assert.equal(f.contents.has(a), false);
});

test('Paper titles open the unified card; full notes open explicitly from inside the card', async () => {
  const f = await setup(); const list = await f.plugin.activateLibrary('papers');
  await list.openFile(a); const card = f.plugin.browseModal; await card.opened;
  assert.equal(card.file.path, a); assert.equal(f.app.openedFile, undefined);
  assert.ok(card.contentEl.querySelectorAll('h2').some(el => el.textContent === '论文卡片'));
  await click(card, '打开笔记'); assert.equal(f.app.openedFile.path, a); assert.equal(card.closed, true);
  const state = await service(f).snapshot();
  const graph = f.plugin.views.get('pinakes-explorer-view')({ app: f.app });
  graph.schema = state.schema;
  await graph.openNote(state.index.nodes.get(b)); await f.plugin.browseModal.opened;
  assert.equal(f.plugin.browseModal.file.path, b); await f.plugin.browseModal.close();
});

test('Three-part note keeps long paper details out of the card and edits only personal notes', async () => {
  const f = await setup();
  const text = "---\ntitle: A\nreading: 未读\n---\n## 整体概括\n短综述\n\n## 论文细节\n### 方法\n长篇机制与公式\n### 实验\n大量表格\n\n## 阅读随记\n我的理解\n\n## 路径\n返回链接\n";
  f.contents.set(a, text); f.plugin.openBrowse(a); const card = f.plugin.browseModal; await card.opened;
  assert.ok(card.sections.overview.content.rendered.includes('短综述'));
  assert.ok(card.sections.notes.content.rendered.includes('我的理解'));
  assert.ok(!card.sections.notes.content.rendered.includes('长篇机制'));
  await click(card, '编辑内容'); card.sections.notes.input.value = '新的个人理解'; card.updateDirty();
  await click(card, '保存修改');
  const saved = f.contents.get(a);
  assert.ok(saved.includes('## 论文细节\n### 方法\n长篇机制与公式\n### 实验\n大量表格\n\n'));
  assert.ok(saved.includes('## 阅读随记\n\n新的个人理解')); await card.close();
});
test('Legacy detailed Notes is preserved while a separate personal section is created', async () => {
  const f = await setup();
  const text = '---\ntitle: A\n---\n## 整体综述\n概括\n\n## Notes\n### 方法\n旧方法细节\n### 实验与结论\n旧实验依据\n\n## 路径\n导航\n';
  f.contents.set(a, text); f.plugin.openBrowse(a); const card = f.plugin.browseModal; await card.opened;
  assert.equal(card.base.notes, ''); assert.equal(card.base.legacyDetailedNotes, true);
  assert.ok(card.sections.notes.content.children[0].textContent.includes('旧 Notes'));
  assert.equal(card.sections.notes.input.value, '');
  await click(card, '编辑内容'); card.sections.notes.input.value = '属于自己的判断'; card.updateDirty();
  await click(card, '保存修改'); const saved = f.contents.get(a);
  assert.ok(saved.includes('## Notes\n### 方法\n旧方法细节\n### 实验与结论\n旧实验依据\n\n'));
  assert.ok(saved.indexOf('## 阅读随记') < saved.indexOf('## 路径'));
  assert.ok(model.browseNoteSnapshot(saved).notes.includes('属于自己的判断'));
  assert.ok(!model.browseNoteSnapshot(saved).notes.includes('旧方法细节')); await card.close();
});
test('New import template has three sections and personal notes start empty', async () => {
  const f = await setup(); const note = model.buildPaperNote({ dirName: 'test', year: '2026', slug: 'three', title: 'Three', tags: [], authors: [], summary: '', pdfName: '', abstract: '' });
  assert.deepEqual([...note.text.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['整体综述', '论文细节', '阅读随记', '路径']);
  const snapshot = model.browseNoteSnapshot(note.text);
  assert.equal(model.hasReadableSection(snapshot.overview), false); assert.equal(model.hasReadableSection(snapshot.notes), false);
  await f.app.vault.create('papers/test/【2026】three/【2026】three.md', note.text);
  f.plugin.openBrowse('papers/test/【2026】three/【2026】three.md'); const card = f.plugin.browseModal; await card.opened;
  assert.equal(card.sections.notes.input.value, ''); assert.equal(card.isDirty(), false);
  await card.close(); assert.equal(f.contents.get('papers/test/【2026】three/【2026】three.md'), note.text);
});
test('Personal section takes precedence over old Notes, which remain untouched', async () => {
  const text = '## 整体综述\n综述\n## Notes\n### 方法\n旧的细节\n## 阅读随记\n我的看法\n### 疑问\n待核对的问题\n## 路径\n返回链接\n';
  const base = model.browseNoteSnapshot(text);
  assert.ok(base.notes.includes('我的看法')); assert.ok(base.notes.includes('待核对的问题'));
  assert.ok(!base.notes.includes('旧的细节')); assert.equal(base.notesSection.ambiguous, false);
  const updated = model.patchBrowseNote(text, base, { overview: base.overview, notes: '新的看法' });
  assert.ok(updated.includes('## Notes\n### 方法\n旧的细节\n'));
  const legacyEnglish = model.browseNoteSnapshot('## Overview\nBrief\n## Notes\n### Methods\nLong method\n### Experiments\nResults\n');
  assert.equal(legacyEnglish.notes, ''); assert.equal(legacyEnglish.legacyDetailedNotes, true);
});

test('Return from a full note saves new content and restores the same paper card position', async () => {
  const f = await setup(); f.plugin.openBrowse(a);
  const card = f.plugin.browseModal; await card.opened;
  card.article.scrollHeight = 1200; card.article.clientHeight = 400; card.article.scrollTop = 320;
  await click(card, '打开笔记');
  assert.equal(f.plugin.browseModal, null);
  const view = f.app.workspace.activeLeaf.view;
  const entry = f.plugin.noteCardActions.get(view);
  assert.equal(entry.button.getAttribute('aria-label'), '返回论文卡片');
  view.pendingText = f.contents.get(a).replace('综述a', '刚在笔记里修改的综述');
  await entry.button.events.click();
  const returned = f.plugin.browseModal;
  returned.article.scrollHeight = 1200; returned.article.clientHeight = 400;
  await returned.opened;
  assert.equal(returned.file.path, a);
  assert.equal(returned.article.scrollTop, 320);
  assert.ok(returned.sections.overview.content.rendered.includes('刚在笔记里修改的综述'));
  assert.equal(model.parseFrontmatter(f.contents.get(a)).reading, '未读');
  await returned.close();
});
test('Return actions follow the current paper through switches and moves, and disappear for non-papers', async () => {
  const f = await setup(); const leaf = await f.plugin.openPaperNote(f.app.vault.getAbstractFileByPath(a));
  const view = leaf.view; const entry = f.plugin.noteCardActions.get(view);
  entry.position = { kind: 'browse', top: 99 };
  view.file = f.app.vault.getAbstractFileByPath(b);
  await f.events.get('file-open')(view.file);
  assert.equal(f.plugin.noteCardActions.get(view).position, null);
  assert.equal(view.actions.length, 1);
  const folder = f.app.vault.getAbstractFileByPath('papers/test/【2026】b');
  await f.app.fileManager.renameFile(folder, 'papers/next/【2026】b');
  await entry.button.events.click(); await f.plugin.browseModal.opened;
  assert.equal(f.plugin.browseModal.file.path, 'papers/next/【2026】b/【2026】b.md');
  await f.plugin.browseModal.close();
  view.file = f.app.vault.getAbstractFileByPath('ideas/【idea】skip.md');
  await f.events.get('file-open')(view.file);
  assert.equal(entry.button.removed, true); assert.equal(f.plugin.noteCardActions.has(view), false);
  assert.equal(f.plugin.commands.find(c => c.id === 'return-paper-card').checkCallback(true), false);
});
test('A failed save keeps the note open, and keyboard return works after retry', async () => {
  const f = await setup(); const leaf = await f.plugin.openPaperNote(f.app.vault.getAbstractFileByPath(a));
  const view = leaf.view; const entry = f.plugin.noteCardActions.get(view);
  view.saveError = Error('保存失败');
  await entry.button.events.click(); assert.equal(f.plugin.browseModal, undefined);
  assert.equal(entry.busy, false); assert.equal(f.app.workspace.activeLeaf.view, view);
  delete view.saveError;
  let prevented = false;
  entry.button.events.keydown({ key: 'Enter', preventDefault() { prevented = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true); await f.plugin.browseModal.opened;
  assert.equal(f.plugin.browseModal.file.path, a); await f.plugin.browseModal.close();
  const cleanup = f.plugin.cleanups.find(callback => callback.toString().includes('noteCardActions.values'));
  cleanup(); assert.equal(entry.button.removed, true); assert.equal(f.plugin.noteCardActions.size, 0);
});
test('Returning during a pending save never opens a different or deleted note', async () => {
  const f = await setup(); const leaf = await f.plugin.openPaperNote(f.app.vault.getAbstractFileByPath(a));
  const view = leaf.view;
  let finish;
  view.save = () => new Promise(resolve => { finish = resolve; });
  const pending = f.plugin.returnToPaperCard(view);
  view.file = f.app.vault.getAbstractFileByPath(b); finish(); await pending;
  assert.equal(f.plugin.browseModal, undefined);
  await f.app.vault.trash(f.app.vault.getAbstractFileByPath('papers/test/【2026】b'));
  await f.events.get('vault:delete')(view.file);
  assert.equal(f.plugin.noteCardActions.has(view), false);
});

(async () => {
  for (const { name, fn } of tests) { await fn(); console.log('  ✓ ' + name); }
  console.log(`All ${tests.length} stage-two workflows passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
