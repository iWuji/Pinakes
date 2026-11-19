const assert = require('node:assert/strict');
const { createPaperSearch, prepareSearchEntry, searchEntries } = require('../src/paper-search.js');
const { fixture, click, setOmnisearch } = require('./test-host.cjs');
const model = require('../src/main.js');
const paperPath = name => `papers/test/【2026】${name}/【2026】${name}.md`;
const record = (path, title, tags, summary, body) => prepareSearchEntry({ path, title, basename: path.split('/').pop().slice(0, -3), tags, summary, body });
const records = [
  record(paperPath('tiger'), 'TIGER: Generative Retrieval with Semantic IDs', ['semantic-id'], '用层次编码做生成式检索', '## 整体综述\n提出 vector quantization 机制。'),
  record(paperPath('rank'), 'Ranking with Language Models', ['ranking'], '排序与召回的对照', '## 整体综述\nGenerative Retrieval is a useful comparison.'),
  record(paperPath('embedding'), 'Embedding Alignment', ['representation'], '嵌入对齐', '## 整体综述\n偏好学习和用户表征。'),
];
function build(f, getOmnisearch = () => null) {
  return createPaperSearch({ vault: f.app.vault, schema: async () => model.DEFAULT_SCHEMA,
    parseFrontmatter: model.parseFrontmatter, kindOfPath: model.kindOfPath, fallbackSchema: model.DEFAULT_SCHEMA, getOmnisearch,
    extractOverview: content => model.browseNoteSnapshot(content).overview });
}
async function populated() {
  const f = fixture(true);
  for (const record of records) await f.app.vault.create(record.path, `---\ntitle: '${record.title}'\ntags: [${record.tags.join(', ')}]\nyear: 2026\nreading: 未读\ntable_summary: '${record.summary}'\n---\n${record.body}\n`);
  await f.app.vault.create('papers/test/【索引】test.md', '---\ntitle: TIGER Index\n---\nTIGER');
  await f.app.vault.create('_templates/example.md', '---\nkind: paper\ntitle: TIGER fake template\n---\n');
  return f;
}
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
test('Partial titles, tags, Chinese keywords and body text return relevant papers', () => {
  assert.equal(searchEntries(records, 'generative')[0].entry.path, records[0].path);
  assert.equal(searchEntries(records, 'semantic')[0].entry.path, records[0].path);
  assert.equal(searchEntries(records, '层次编码')[0].entry.path, records[0].path);
  assert.equal(searchEntries(records, 'quantization')[0].entry.path, records[0].path);
  assert.equal(searchEntries(records, '偏好学习')[0].entry.path, records[2].path);
});
test('English misspellings, transposition, omitted characters and abbreviations work', () => {
  for (const query of ['retrievel', 'retrieavl', 'retrival', 'grsi'])
    assert.equal(searchEntries(records, query)[0]?.entry.path, records[0].path, query);
});
test('Multiple query terms may occur across different fields; title outranks body-only matches', () => {
  assert.equal(searchEntries(records, 'tiger quantization')[0].entry.path, records[0].path);
  const matches = searchEntries(records, 'generative retrieval');
  assert.equal(matches.length, 2); assert.equal(matches[0].entry.path, records[0].path);
  assert.equal(searchEntries(records, 'tiger nonexistent').length, 0);
});
test('Empty/punctuation queries are harmless and full-width text normalizes', () => {
  assert.equal(searchEntries(records, 'ＴＩＧＥＲ')[0].entry.path, records[0].path);
  assert.equal(searchEntries(records, '[] ()').length, 0);
  assert.equal(searchEntries(records, '').length, records.length);
});
test('Search cache reads notes once, filters non-papers and refreshes after invalidation', async () => {
  const f = await populated(); let reads = 0; const read = f.app.vault.cachedRead;
  f.app.vault.cachedRead = async file => { reads++; return read(file); };
  const engine = build(f); const first = await engine.suggest('tiger');
  assert.equal(first.results.length, 1); const initial = reads;
  await engine.suggest('semantic'); assert.equal(reads, initial);
  f.contents.set(records[2].path, f.contents.get(records[2].path).replace('偏好学习', 'specialtoken'));
  engine.invalidate(); assert.equal((await engine.suggest('specialtoken')).results[0].path, records[2].path);
  assert.ok(reads > initial);
});
test('Optional Omnisearch integration calls the public API and merges only current paper notes', async () => {
  const f = await populated(); let called;
  const engine = build(f, () => ({ search: async query => { called = query; return [
    { path: records[2].path, score: 100, excerpt: '<b>remote context</b>' },
    { path: records[2].path, score: 90, excerpt: 'duplicate' },
    { path: 'papers/test/【索引】test.md', score: 200 }, { path: 'missing.md', score: 300 },
  ]; } }));
  const result = await engine.suggest('omnisearch-only term');
  assert.equal(called, 'omnisearch-only term'); assert.equal(result.source, 'omnisearch');
  assert.equal(result.results.length, 1); assert.equal(result.results[0].path, records[2].path);
  assert.equal(result.results[0].excerpt, '偏好学习和用户表征。');
});
test('Candidate excerpts show only the overview, never PDF links, details or external snippets', async () => {
  const f = await populated();
  f.contents.set(records[0].path, "---\ntitle: TIGER\n---\n> [!note] 原文 PDF：[[paper.pdf]]\n## 整体概括\n<!-- 写作提示 -->\n只显示这段综述。\n## 论文细节\nquantization 的长篇细节\n## 阅读随记\n个人判断\n");
  const engine = build(f, () => ({ search: async () => [{ path: records[0].path, excerpt: 'PDF external detail' }] }));
  assert.equal((await engine.suggest('quantization')).results[0].excerpt, '只显示这段综述。');
  f.contents.set(records[0].path, '---\ntitle: TIGER\n---\n原文 PDF：paper.pdf\n## 论文细节\nquantization\n');
  engine.invalidate();
  assert.equal((await engine.suggest('quantization')).results[0].excerpt, '');
});
test('Missing, broken, rejected or slow Omnisearch falls back to the built-in search', async () => {
  const f = await populated();
  for (const api of [null, {}, { search: async () => { throw Error('not indexed'); } }, { search: async () => ({ broken: true }) }, { search: () => new Promise(() => {}) }]) {
    const result = await build(f, () => api).suggest('tiger');
    assert.equal(result.source, 'local'); assert.equal(result.results[0].path, records[0].path);
  }
});
test('Results are capped at six and remain local: no upload/HTTP API used', async () => {
  const f = await populated();
  for (let i = 0; i < 9; i++) await f.app.vault.create(paperPath('extra-' + i), `---\ntitle: TIGER example ${i}\n---\n`);
  const result = await build(f).suggest('tiger', 6);
  assert.equal(result.results.length, 6); assert.equal(result.source, 'local');
});
test('Home suggestions open matching papers and support arrow/Enter/Escape without moving Home scroll', async () => {
  const f = await populated(); await f.plugin.onload(); const home = await f.plugin.activateHome();
  home.contentEl.scrollTop = 123; home.search.value = 'retrievel'; await home.refreshSuggestions();
  assert.equal(home.searchResults[0].path, records[0].path); assert.equal(home.search.getAttribute('aria-expanded'), 'true');
  home.search.events.keydown({ key: 'ArrowDown', preventDefault() {} }); assert.equal(home.searchActive, 0);
  assert.ok(home.search.getAttribute('aria-activedescendant'));
  home.search.events.keydown({ key: 'Enter', preventDefault() {} });
  await f.plugin.browseModal.opened; assert.equal(f.plugin.browseModal.file.path, records[0].path);
  assert.equal(home.contentEl.scrollTop, 123); await f.plugin.browseModal.close();
  home.search.value = 'alignment'; await home.refreshSuggestions();
  home.search.events.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(home.search.getAttribute('aria-expanded'), 'false'); assert.equal(home.searchResults.length, 0);
});
test('Candidate click opens note; plain submit still searches all results', async () => {
  const f = await populated(); await f.plugin.onload(); const home = await f.plugin.activateHome();
  home.search.value = 'tiger'; await home.refreshSuggestions();
  await home.suggestions.querySelectorAll('button')[0].events.click(); await f.plugin.browseModal.opened;
  assert.equal(f.plugin.browseModal.file.path, records[0].path); await f.plugin.browseModal.close();
  home.search.value = 'retrievel';
  await home.page.children.find(child => child.tag === 'form').events.submit({ preventDefault() {} });
  const list = f.app.workspace.activeLeaf.view; assert.equal(list.filters.q, 'retrievel');
  assert.equal(list.visibleEntries[0].path, records[0].path);
});
test('Rapid new input and closing Home discard old asynchronous search responses', async () => {
  const f = await populated(); await f.plugin.onload(); const home = await f.plugin.activateHome();
  let release; const read = f.app.vault.cachedRead;
  f.app.vault.cachedRead = async file => { if (file.path === records[0].path && !release) await new Promise(resolve => { release = resolve; }); return read(file); };
  home.search.value = 'tiger'; const old = home.refreshSuggestions();
  while (!release) await Promise.resolve();
  home.search.value = 'alignment'; const next = home.refreshSuggestions(); release(); await Promise.all([old, next]);
  assert.equal(home.searchResults[0].path, records[2].path);
  home.search.value = 'tiger'; const search = home.refreshSuggestions(); home.onClose(); await search;
  assert.equal(home.searchResults.length, 0);
});
test('IME composition does not search or submit partial Chinese text and clearing removes suggestions', async () => {
  const f = await populated(); await f.plugin.onload(); const home = await f.plugin.activateHome();
  home.search.events.compositionstart(); home.search.value = '层'; home.search.events.input();
  assert.equal(home.searchResults.length, 0); assert.equal(home.searchTimer, undefined);
  const count = f.leaves.length;
  await home.page.children.find(child => child.tag === 'form').events.submit({ preventDefault() {} }); assert.equal(f.leaves.length, count);
  home.search.value = '层次'; home.search.events.compositionend();
  home.closeSuggestions(); await home.refreshSuggestions(); assert.equal(home.searchResults[0].path, records[0].path);
  home.search.value = ''; home.search.events.input(); assert.equal(home.searchResults.length, 0);
  assert.equal(home.search.getAttribute('aria-expanded'), 'false');
});
test('Home detects the Omnisearch global and discards late API results for an old query', async () => {
  const f = await populated(); await f.plugin.onload(); const home = await f.plugin.activateHome();
  let release;
  setOmnisearch({ search: async query => {
    if (query === 'oldquery') return new Promise(resolve => { release = resolve; });
    return [{ path: records[2].path, score: 100, excerpt: 'API result' }];
  } });
  try {
    home.search.value = 'oldquery'; const old = home.refreshSuggestions();
    while (!release) await Promise.resolve();
    home.search.value = 'alignment'; await home.refreshSuggestions();
    release([{ path: records[0].path, score: 500 }]); await old;
    assert.equal(home.searchResults[0].path, records[2].path);
    assert.ok(home.suggestions.children[0].textContent.includes('Omnisearch'));
    home.search.events.blur({ relatedTarget: null });
    assert.equal(home.search.getAttribute('aria-expanded'), 'false');
    home.onClose();
  } finally { setOmnisearch(null); }
});

(async () => { for (const { name, fn } of tests) { await fn(); console.log('  ✓ ' + name); } console.log(`All ${tests.length} search workflows passed.`); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
