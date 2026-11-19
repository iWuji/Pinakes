#!/usr/bin/env node
// Explicit local migration. Reads paper timestamps; never edits notes or PDFs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { localDay, mergeActivityHistory, total } = require('../src/activity-log.js');
const model = require('../src/main.js');

function papersIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return papersIn(file);
    return entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('【索引】') ? [file] : [];
  });
}
function makePlan(vault, snapshotDir, ledger, repairDay, now = new Date()) {
  const schema = JSON.parse(fs.readFileSync(path.join(vault, '_schema/.compiled.json'), 'utf8'));
  const notes = papersIn(path.join(vault, 'papers')).filter(file => {
    const relative = path.relative(vault, file).split(path.sep).join('/');
    return (model.parseFrontmatter(fs.readFileSync(file, 'utf8')).kind || model.kindOfPath(schema, relative)) === 'paper';
  });
  const plan = { version: 1, events: [], remove: [] };
  let snapshotFiles = 0;
  for (const file of notes) {
    const relative = path.relative(vault, file).split(path.sep).join('/');
    const stat = fs.statSync(file);
    const oldFile = snapshotDir && path.join(snapshotDir, relative);
    if (snapshotDir && !fs.existsSync(oldFile)) throw Error('备份缺少笔记：' + relative);
    const modified = oldFile ? fs.statSync(oldFile).mtimeMs : stat.mtimeMs;
    if (oldFile) snapshotFiles++;
    if (!Number.isFinite(stat.birthtimeMs) || stat.birthtimeMs <= 0) throw Error('文件创建时间不可用：' + relative);
    const created = Math.min(stat.birthtimeMs, modified);
    if (created > now.getTime() || modified > now.getTime()) throw Error('文件时间在未来：' + relative);
    const addDay = localDay(new Date(created)), editDay = localDay(new Date(modified));
    const event = (type, day) => ({ type, day,
      id: 'history:' + crypto.createHash('sha256').update(relative + '\0' + type + '\0' + day).digest('hex') });
    plan.events.push(event('added', addDay));
    // Same-day creation and final save are one visible action, not two guesses.
    if (editDay > addDay) plan.events.push(event('edited', editDay));
  }
  if (repairDay) {
    const values = ledger.days[repairDay];
    const ledgerStat = fs.statSync(path.join(vault, '.obsidian/plugins/pinakes-explorer/activity.json'));
    if (!notes.length || !values || !values.added || values.added % notes.length !== 0 || total(values) !== values.added ||
      values.ids?.length !== values.added || values.ids.some(id => !/^[0-9a-f-]{36}$/i.test(id)) ||
      notes.some(file => fs.statSync(file).birthtimeMs >= ledgerStat.birthtimeMs))
      throw Error('当前记录不符合整库启动扫描误计的条件，不能自动修正。');
    plan.remove.push({ day: repairDay, type: 'added', ids: [...values.ids] });
  }
  return { plan, papers: notes.length, snapshotFiles };
}
function atomicWrite(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, value); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function run(args) {
  const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const vault = path.resolve(option('--vault') || 'wiki');
  const snapshot = option('--note-snapshot');
  const file = path.join(vault, '.obsidian/plugins/pinakes-explorer/activity.json');
  const original = fs.readFileSync(file, 'utf8');
  const ledger = JSON.parse(original);
  const { plan, papers, snapshotFiles } = makePlan(vault, snapshot && path.resolve(snapshot), ledger, option('--repair-discovery-day'));
  const next = mergeActivityHistory(ledger, plan);
  const summary = { papers, snapshotFiles, recoveredAdded: plan.events.filter(e => e.type === 'added').length,
    recoveredEdits: plan.events.filter(e => e.type === 'edited').length,
    removedDiscoveryEvents: plan.remove.reduce((n, item) => n + item.ids.length, 0),
    firstDay: next.startedOn, total: Object.values(next.days).reduce((n, day) => n + total(day), 0),
    activeDays: Object.values(next.days).filter(day => total(day) > 0).length,
    days: Object.fromEntries(Object.entries(next.days).sort().map(([day, values]) => [day, { added: values.added, status: values.status, edited: values.edited }])) };
  if (args.includes('--apply')) {
    const backup = path.join(os.homedir(), '.joycode/backups/pinakes', localDay() + '-activity-history-' + crypto.randomUUID());
    fs.mkdirSync(backup, { recursive: true });
    for (const suffix of ['', '.bak', '.import']) if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, path.join(backup, 'activity.json' + suffix));
    fs.writeFileSync(path.join(backup, 'summary.json'), JSON.stringify(summary, null, 2));
    if (fs.readFileSync(file, 'utf8') !== original) throw Error('活跃度正在更新，已保留备份，请重新运行。');
    // Keep the plan for the plugin to replay safely after reload if the old instance
    // writes its in-memory ledger in the meantime. It contains hashes, not paths.
    atomicWrite(file + '.import', JSON.stringify(plan, null, 2));
    atomicWrite(file + '.bak', original);
    atomicWrite(file, JSON.stringify(next, null, 2));
    summary.backup = backup;
    summary.applied = true;
  }
  console.log(JSON.stringify(summary, null, 2));
}
if (require.main === module) {
  try { run(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { makePlan };
