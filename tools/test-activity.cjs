const assert = require('node:assert/strict');
const { createActivityLog, activityCalendar, activityLevel, localDay, shiftDay, total, mergeActivityHistory } = require('../src/activity-log.js');
const { fixture, click } = require('./test-host.cjs');
const model = require('../src/main.js');
const { createLibraryService } = require('../src/library-service.js');
const a = 'papers/test/【2026】a/【2026】a.md';
const b = 'papers/test/【2026】b/【2026】b.md';
const storage = '.obsidian/plugins/pinakes-explorer/activity.json';
const clock = () => new Date(2026, 10, 19, 12);
const ledger = (f, now = clock, extra = {}) => createActivityLog({ vault: f.app.vault,
  schema: async () => model.DEFAULT_SCHEMA, model, now, ...extra });
const svc = f => createLibraryService({ app: f.app, plugin: f.plugin, model });
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('Initialization and browsing never count existing papers or fabricate earlier history', async () => {
  const f = fixture(), log = ledger(f); await log.init();
  assert.deepEqual((await log.snapshot()).days, {});
  await log.observe(f.app.vault.getAbstractFileByPath(a));
  await log.observe(f.app.vault.getAbstractFileByPath(a), true);
  assert.deepEqual((await log.snapshot()).days, {});
  const restart = ledger(f, () => new Date(2026, 10, 20, 12)); await restart.init();
  assert.equal((await restart.snapshot()).startedOn, '2026-11-19');
});
test('Local-day actions survive restart, de-duplicate import IDs, and increase color levels', async () => {
  const f = fixture(); const log = ledger(f); await log.init();
  await log.record('added', 'import-one'); await log.record('added', 'import-one');
  await log.record('status', 'state-one'); await log.record('edited', 'edit-one');
  const data = await ledger(f).snapshot();
  assert.equal(data.days['2026-11-19'].added, 1); assert.equal(data.days['2026-11-19'].status, 1);
  assert.equal(data.days['2026-11-19'].edited, 1);
  const chart = activityCalendar(data, clock());
  assert.equal(chart.total, 3); assert.equal(chart.activeDays, 1); assert.equal(chart.todayCount, 3);
  assert.deepEqual([0, 1, 2, 3, 4, 6, 7, 50].map(activityLevel), [0, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(chart.weeks.flat().filter(cell => cell.inRange).length, 365);
  assert.equal(chart.weeks.flat().filter(cell => cell.count)[0].level, 2);
});
test('Same state and duplicate vault notifications count once; actual toggles count again', async () => {
  const f = fixture(); const log = ledger(f); await log.init();
  f.contents.set(a, model.patchScalarField(f.contents.get(a), 'reading', '已读'));
  const file = f.app.vault.getAbstractFileByPath(a);
  await log.observe(file); await log.observe(file);
  f.contents.set(a, model.patchScalarField(f.contents.get(a), 'reading', '已读')); await log.observe(file);
  assert.equal(total((await log.snapshot()).days['2026-11-19']), 1);
  f.contents.set(a, model.patchScalarField(f.contents.get(a), 'reading', '未读')); await log.observe(file);
  assert.equal((await log.snapshot()).days['2026-11-19'].status, 2);
});
test('Personal notes and overview saves count edits; no-op edits, attachment and index changes do not', async () => {
  const f = fixture(); const log = ledger(f); await log.init(); const file = f.app.vault.getAbstractFileByPath(a);
  f.contents.set(a, f.contents.get(a).replace('个人记录a', '个人记录a\n我的新理解')); await log.observe(file);
  f.contents.set(a, f.contents.get(a).replace('综述a', '更新后的综述')); await log.observe(file);
  await log.observe(file);
  f.contents.set(a, model.patchScalarField(f.contents.get(a), 'direction', '"[[【索引】next]]"')); await log.observe(file);
  f.contents.set(a, model.patchPdfReference(f.contents.get(a), 'a.pdf', '')); await log.observe(file);
  const index = f.app.vault.getAbstractFileByPath('papers/test/【索引】test.md');
  f.contents.set(index.path, f.contents.get(index.path) + '\n自动索引表\n'); await log.observe(index);
  assert.equal((await log.snapshot()).days['2026-11-19'].edited, 2);
  assert.equal(total((await log.snapshot()).days['2026-11-19']), 2);
});
test('External creates and debounced typing count once per settled save', async () => {
  const f = fixture(); const log = ledger(f); await log.init();
  const file = await f.app.vault.create('papers/test/【2026】new/【2026】new.md', '---\ntitle: New\n---\n## 整体综述\n');
  log.schedule(file, true); log.schedule(file); await log.flush();
  assert.equal((await log.snapshot()).days['2026-11-19'].added, 1);
  for (const value of ['one', 'two', 'three']) { f.contents.set(file.path, f.contents.get(file.path) + value); log.schedule(file); }
  await log.flush();
  assert.equal((await log.snapshot()).days['2026-11-19'].edited, 1);
  await log.dispose();
});
test('Typing before midnight belongs to the original local day even if the debounce flushes tomorrow', async () => {
  const f = fixture(); let time = new Date(2026, 10, 19, 23, 59, 59); const log = ledger(f, () => time); await log.init();
  f.contents.set(a, f.contents.get(a) + '\n跨日之前的笔记'); log.schedule(f.app.vault.getAbstractFileByPath(a));
  time = new Date(2026, 10, 20, 0, 0, 1); await log.flush();
  assert.equal((await log.snapshot()).days['2026-11-19'].edited, 1); assert.equal((await log.snapshot()).days['2026-11-20'], undefined);
});
test('Year grid handles leap days, month transitions, streaks and future cells', () => {
  assert.equal(shiftDay('2024-03-01', -1), '2024-02-29');
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  const date = new Date(2024, 2, 1, 12);
  const data = { startedOn: '2024-02-28', days: { '2024-02-28': { edited: 1 }, '2024-02-29': { status: 2 }, '2024-03-01': { added: 1 }, '2024-03-02': { added: 99 } } };
  const chart = activityCalendar(data, date);
  assert.equal(chart.total, 4); assert.equal(chart.streak, 3); assert.equal(chart.activeDays, 3);
  assert.equal(chart.weeks.flat().filter(cell => cell.inRange).length, 365);
  assert.equal(chart.weeks.flat().find(cell => cell.day === '2024-02-29').count, 2);
  assert.ok(chart.weeks.flat().filter(cell => cell.day > chart.today).every(cell => !cell.inRange));
  assert.equal(activityCalendar(data, new Date(2024, 2, 2, 12)).streak, 4);
});
test('Guarded imports count only success and repeated cleanup does not double count', async () => {
  const f = fixture(); await f.plugin.onload();
  const original = f.app.vault.createBinary; let once = true;
  f.app.vault.createBinary = async (...args) => { if (once) { once = false; throw Error('copy failed'); } return original(...args); };
  const payload = { file: { name: 'new.pdf', arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4').buffer }, dirName: 'test', year: '2026', slug: 'activity-import', title: 'New', tags: [], authors: [], summary: '', abstract: '' };
  await assert.rejects(svc(f).importPaper(payload));
  assert.equal(Object.keys((await f.plugin.activityLog.snapshot()).days).length, 0);
  await svc(f).importPaper(payload);
  const day = localDay(new Date());
  assert.equal((await f.plugin.activityLog.snapshot()).days[day].added, 1);
  const file = f.app.vault.getAbstractFileByPath('papers/test/【2026】activity-import/【2026】activity-import.md');
  await f.plugin.activityLog.observe(file, true); assert.equal((await f.plugin.activityLog.snapshot()).days[day].added, 1);
});
test('Plugin status/card saves count, failed writes and simply opening cards do not', async () => {
  const f = fixture(); await f.plugin.onload(); const file = f.app.vault.getAbstractFileByPath(a);
  await f.plugin.setNoteField(file, 'reading', '已读'); await f.plugin.setNoteField(file, 'reading', '已读');
  f.plugin.openBrowse(a); const card = f.plugin.browseModal; await card.opened;
  await click(card, '编辑内容'); card.sections.notes.input.value = '新理解'; card.updateDirty(); await click(card, '保存修改');
  await card.close();
  const day = (await f.plugin.activityLog.snapshot()).days[localDay()]; assert.equal(day.status, 1); assert.equal(day.edited, 1);
  f.fail(); await assert.rejects(f.plugin.setNoteField(file, 'reading', '精读'));
  assert.equal(total((await f.plugin.activityLog.snapshot()).days[localDay()]), 2);
});
test('Renaming a paper retains baselines, deletion does not erase past activity', async () => {
  const f = fixture(); const log = ledger(f); await log.init();
  f.contents.set(a, f.contents.get(a) + '\n我的笔记'); await log.observe(f.app.vault.getAbstractFileByPath(a));
  const folder = f.app.vault.getAbstractFileByPath('papers/test/【2026】a');
  await f.app.vault.createFolder('papers/next');
  const old = folder.path; await f.app.fileManager.renameFile(folder, 'papers/next/【2026】a'); log.rename(folder, old);
  await log.observe(f.app.vault.getAbstractFileByPath('papers/next/【2026】a/【2026】a.md'));
  log.remove(folder); await f.app.vault.trash(folder);
  assert.equal(total((await log.snapshot()).days['2026-11-19']), 1);
});
test('Activity write failure preserves pending counts for retry; corrupted storage is never silently reset', async () => {
  const f = fixture(); const log = ledger(f); await log.init(); const write = f.app.vault.adapter.write; let fail = true;
  f.app.vault.adapter.write = async (path, text) => { if (path === storage && fail) throw Error('activity disk full'); return write(path, text); };
  await assert.rejects(log.record('edited', 'saved-edit'));
  fail = false; await log.record('edited', 'saved-edit');
  assert.equal((await ledger(f).snapshot()).days['2026-11-19'].edited, 1);
  await f.app.vault.adapter.write(storage, '{bad');
  const backupData = await ledger(f).snapshot(); assert.ok(backupData.startedOn);
  await f.app.vault.adapter.write(storage + '.bak', '{bad too');
  await assert.rejects(ledger(f).snapshot(), /原文件和备份已保留/);
  assert.equal(await f.app.vault.adapter.read(storage), '{bad');
});
test('Home has 365 date squares, accessible daily breakdown and updates without resetting its recommendation', async () => {
  const f = fixture(); await f.plugin.onload(); const home = await f.plugin.activateHome();
  const recommendation = home.featuredPath; home.contentEl.scrollTop = 140;
  await f.plugin.setNoteField(f.app.vault.getAbstractFileByPath(a), 'reading', '在读');
  await home.refreshActivity();
  const days = home.activityEl.querySelectorAll('button'); assert.equal(days.length, 365);
  const today = days.find(button => button.getAttribute('data-date') === localDay());
  assert.equal(today.getAttribute('data-level'), '1');
  assert.ok(today.getAttribute('aria-label').includes('修改状态 1')); assert.equal(today.getAttribute('aria-current'), 'date');
  today.events.focus(); assert.equal(today.getAttribute('tabindex'), '0');
  assert.equal(home.featuredPath, recommendation); assert.equal(home.contentEl.scrollTop, 140);
  home.onClose();
});
test('Registered vault edit events record direct Markdown edits without double-counting explicit status changes', async () => {
  const f = fixture(); await f.plugin.onload(); const file = f.app.vault.getAbstractFileByPath(a);
  f.contents.set(a, f.contents.get(a) + '\n完整笔记里的随记'); await f.events.get('vault:modify')(file);
  await f.plugin.activityLog.flush();
  assert.equal((await f.plugin.activityLog.snapshot()).days[localDay()].edited, 1);
  await f.plugin.setNoteField(file, 'reading', '已读');
  await f.events.get('vault:modify')(file); await f.plugin.activityLog.flush();
  const values = (await f.plugin.activityLog.snapshot()).days[localDay()];
  assert.equal(values.status, 1); assert.equal(values.edited, 1);
  await f.plugin.activityLog.dispose();
});
test('Editing title or tags counts as a note edit, but automatic PDF/direction updates do not', async () => {
  const f = fixture(); const log = ledger(f); await log.init(); const file = f.app.vault.getAbstractFileByPath(a);
  f.contents.set(a, model.patchScalarField(f.contents.get(a), 'title', '"New title"')); await log.observe(file);
  f.contents.set(a, model.patchTags(f.contents.get(a), { add: 'semantic-id' })); await log.observe(file);
  f.contents.set(a, model.patchScalarField(f.contents.get(a), 'pdf', "'a.pdf'")); await log.observe(file);
  assert.equal((await log.snapshot()).days['2026-11-19'].edited, 2);
});
test('Completed imports count once even when journal cleanup fails and is retried next day', async () => {
  const f = fixture(); await f.plugin.onload();
  const write = f.app.vault.adapter.write; let count = 0;
  f.app.vault.adapter.write = async (path, text) => {
    if (path.endsWith('operations.json') && ++count === 2) throw Error('cleanup unavailable');
    return write(path, text);
  };
  const service = svc(f);
  const payload = { file: null, dirName: 'test', year: '2026', slug: 'cleanup', title: 'Cleanup', tags: [], authors: [], summary: '', abstract: '' };
  await assert.rejects(service.importPaper(payload));
  const operation = (await service.pendingOperations())[0];
  await service.finishImport(operation.id);
  const values = (await f.plugin.activityLog.snapshot()).days[localDay()];
  assert.equal(values.added, 1);
});
test('An activity-only storage failure does not report a successful paper status write as failed', async () => {
  const f = fixture(); await f.plugin.onload(); const original = f.app.vault.adapter.write;
  f.app.vault.adapter.write = async (path, text) => { if (path === storage) throw Error('activity storage down'); return original(path, text); };
  await f.plugin.setNoteField(f.app.vault.getAbstractFileByPath(a), 'reading', '精读');
  assert.equal(model.parseFrontmatter(f.contents.get(a)).reading, '精读');
  assert.ok(f.plugin.activityError.includes('activity storage down'));
  f.app.vault.adapter.write = original; await f.plugin.activityLog.flush();
  assert.equal((await ledger(f).snapshot()).days[localDay()].status, 1);
});

test('Explicit history import repairs discovery counts, retains live actions and retries without duplicates', async () => {
  const original = { version: 1, startedOn: '2026-11-19', days: {
    '2026-11-19': { added: 2, status: 1, edited: 1, ids: ['scan-a', 'scan-b', 'live-state', 'live-edit'] },
  } };
  const plan = { version: 1, remove: [{ day: '2026-11-19', type: 'added', ids: ['scan-a', 'scan-b'] }], events: [
    { type: 'added', day: '2026-10-09', id: 'history:a' }, { type: 'edited', day: '2026-10-28', id: 'history:edit-a' },
  ] };
  const updated = mergeActivityHistory(original, plan);
  assert.equal(updated.startedOn, '2026-10-09'); assert.equal(updated.days['2026-11-19'].added, 0);
  assert.equal(updated.days['2026-11-19'].status, 1); assert.equal(updated.days['2026-11-19'].edited, 1);
  assert.equal(updated.days['2026-10-09'].added, 1); assert.equal(updated.days['2026-10-28'].edited, 1);
  assert.deepEqual(mergeActivityHistory(updated, plan), updated);
  assert.equal(original.days['2026-11-19'].added, 2);
  const f = fixture();
  await f.app.vault.adapter.write(storage, JSON.stringify(original));
  await f.app.vault.adapter.write(storage + '.import', JSON.stringify(plan));
  assert.deepEqual(await ledger(f).snapshot(), updated);
  await ledger(f).record('status', 'new-state');
  assert.equal((await ledger(f).snapshot()).days['2026-11-19'].status, 2);
});
test('Invalid history plans leave the original ledger unchanged', async () => {
  const f = fixture(); const log = ledger(f); await log.init(); await log.record('status', 'state');
  const before = await f.app.vault.adapter.read(storage);
  await f.app.vault.adapter.write(storage + '.import', JSON.stringify({ version: 1, events: [{ day: '2026-02-30', type: 'added', id: 'bad' }] }));
  await assert.rejects(ledger(f).init(), /导入文件无效/);
  assert.equal(await f.app.vault.adapter.read(storage), before);
});
test('Startup discovery of old files does not count as adding new papers', async () => {
  const f = fixture(true); const log = ledger(f); await log.init();
  const old = await f.app.vault.create(a, '---\ntitle: A\n---\n## 整体综述\nOld');
  old.stat = { ctime: new Date(2026, 9, 9, 12).getTime() };
  log.schedule(old, true); await log.flush(); assert.deepEqual((await log.snapshot()).days, {});
  f.contents.set(a, f.contents.get(a) + '\n真正的新编辑'); log.schedule(old); await log.flush();
  assert.equal((await log.snapshot()).days['2026-11-19'].edited, 1);
  const fresh = await f.app.vault.create(b, '---\ntitle: B\n---\n## 整体综述\nNew');
  fresh.stat = { ctime: clock().getTime() };
  log.schedule(fresh, true); await log.flush();
  assert.equal((await log.snapshot()).days['2026-11-19'].added, 1);
});

(async () => { for (const { name, fn } of tests) { await fn(); console.log('  ✓ ' + name); } console.log(`All ${tests.length} activity workflows passed.`); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
