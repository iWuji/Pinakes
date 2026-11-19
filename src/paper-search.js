"use strict";

const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const words = value => normalize(value).match(/[a-z0-9\u3400-\u9fff]+/g) || [];
const compact = value => normalize(value).replace(/[^a-z0-9\u3400-\u9fff]/g, "");

function nearWord(query, word) {
  if (query.length < 4 || Math.abs(query.length - word.length) > 1) return false;
  if (query.length === word.length) {
    const mismatches = [];
    for (let i = 0; i < query.length; i++) if (query[i] !== word[i]) mismatches.push(i);
    return mismatches.length <= 1 || (mismatches.length === 2 && mismatches[1] === mismatches[0] + 1 &&
      query[mismatches[0]] === word[mismatches[1]] && query[mismatches[1]] === word[mismatches[0]]);
  }
  const short = query.length < word.length ? query : word;
  const long = query.length < word.length ? word : query;
  let i = 0, j = 0, skips = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; }
    else { if (++skips > 1) return false; j++; }
  }
  return true;
}

function subsequence(query, value) {
  if (query.length < 2 || query.length > 18 || !/^[a-z0-9]+$/.test(query)) return 0;
  let matched = 0, first = -1, last = -1;
  for (let i = 0; i < value.length && matched < query.length; i++) {
    if (value[i] === query[matched]) { if (first < 0) first = i; last = i; matched++; }
  }
  return matched === query.length && last - first < query.length * 3 ? 24 - (last - first - query.length) : 0;
}

function prepareSearchEntry(entry) {
  const title = normalize(entry.title || entry.fm?.title || entry.basename);
  const tags = normalize((entry.tags || entry.fm?.tags || []).join(" "));
  const summary = normalize(entry.summary || entry.fm?.summary);
  const body = normalize(entry.body || entry.content || "");
  const basename = normalize(entry.basename);
  return { ...entry, search: { title, tags, summary, body, basename,
    titleCompact: compact(title), titleWords: words(title + " " + basename + " " + tags),
    initials: words(title).filter(word => /^[a-z]/.test(word) && !["with", "and", "the", "of", "for", "a", "an", "in", "to"].includes(word)).map(word => word[0]).join("") } };
}

function scoreEntry(entry, query) {
  const data = entry.search;
  const terms = words(query);
  if (!terms.length) return 0;
  let score = 0;
  for (const term of terms) {
    let match = 0;
    if (data.title.includes(term)) match = data.titleWords.includes(term) ? 120 : 100;
    if (data.basename.includes(term)) match = Math.max(match, 95);
    if (data.tags.includes(term)) match = Math.max(match, 85);
    if (data.summary.includes(term)) match = Math.max(match, 60);
    if (data.body.includes(term)) match = Math.max(match, 25);
    if (!match && /^[a-z0-9]+$/.test(term)) {
      if (data.titleWords.some(word => nearWord(term, word))) match = 65;
      else match = Math.max(0, subsequence(term, data.titleCompact), subsequence(term, data.initials));
    }
    if (!match) return 0;
    score += match;
  }
  if (data.title.includes(normalize(query))) score += 70;
  return score;
}

function searchEntries(entries, query, limit = Infinity) {
  if (!normalize(query)) return entries.map(entry => ({ entry, score: 0 }));
  return entries.map(entry => ({ entry, score: scoreEntry(entry.search ? entry : prepareSearchEntry(entry), query) }))
    .filter(result => result.score > 0).sort((a, b) => b.score - a.score ||
      String(a.entry.title || a.entry.basename).localeCompare(String(b.entry.title || b.entry.basename)) || a.entry.path.localeCompare(b.entry.path)).slice(0, limit);
}

function searchExcerpt(entry, query) {
  const terms = words(query);
  const source = String(entry.overview || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
    .replace(/[`#>*\[\]]/g, "").replace(/\s+/g, " ").trim();
  const text = normalize(source);
  const at = terms.map(term => text.indexOf(term)).find(index => index >= 0);
  const start = at > 90 ? Math.max(0, at - 40) : 0;
  return (start ? "…" : "") + source.slice(start, start + 150) + (source.length > start + 150 ? "…" : "");
}

function createPaperSearch({ vault, schema, parseFrontmatter, kindOfPath, fallbackSchema, getOmnisearch, extractOverview }) {
  let version = 0, cache = null, building = null;
  const invalidate = () => { version++; cache = null; };
  async function entries() {
    if (cache?.version === version) return cache.entries;
    if (building?.version === version) return building.promise;
    const stamp = version;
    const promise = (async () => {
      const sc = await schema();
      const scan = sc.scan || fallbackSchema.scan;
      const files = vault.getMarkdownFiles().filter(file =>
        !file.path.split("/").some(segment => (scan.skip_dirs || []).includes(segment)) &&
        !(scan.skip_files || []).includes(file.basename));
      const records = await Promise.all(files.map(async file => {
        // Files may disappear during a vault event; skip only missing files.
        let content;
        try { content = await vault.cachedRead(file); }
        catch (error) { if (!vault.getAbstractFileByPath(file.path)) return null; throw error; }
        const fm = parseFrontmatter(content);
        if ((fm.kind || kindOfPath(sc, file.path)) !== "paper") return null;
        return prepareSearchEntry({ file, path: file.path, basename: file.basename, title: fm.title || file.basename,
          tags: fm.tags || [], summary: fm.summary || "", reading: fm.reading || "未读", year: fm.year || "",
          overview: extractOverview ? extractOverview(content) : "",
          body: content.replace(/^---\r?\n[\s\S]*?\r?\n---/, "") });
      }));
      const result = records.filter(Boolean);
      if (stamp === version) cache = { version: stamp, entries: result };
      return result;
    })();
    building = { version: stamp, promise };
    try { return await promise; }
    finally { if (building?.promise === promise) building = null; }
  }
  async function suggest(query, limit = 6, useOmnisearch = true) {
    if (!words(query).length) return { results: [], source: "local" };
    const records = await entries();
    const local = searchEntries(records, query);
    const results = local.map(({ entry, score }) => ({ ...entry, score, excerpt: searchExcerpt(entry, query) }));
    const api = useOmnisearch && getOmnisearch && getOmnisearch();
    if (!api || typeof api.search !== "function") return { results: results.slice(0, limit), source: "local" };
    let timer;
    try {
      const remote = await Promise.race([
        Promise.resolve().then(() => api.search(query)),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 900); }),
      ]);
      if (!Array.isArray(remote)) return { results: results.slice(0, limit), source: "local" };
      const byPath = new Map(records.map(entry => [entry.path, entry]));
      const merged = new Map(results.map(entry => [entry.path, entry]));
      let rank = 0;
      for (const item of remote) {
        if (!item || typeof item.path !== "string") continue;
        if (typeof vault.getName === "function" && item.vault && item.vault !== vault.getName()) continue;
        const entry = byPath.get(item.path);
        if (!entry || !vault.getAbstractFileByPath(item.path)) continue;
        const existing = merged.get(item.path);
        const score = (existing?.score || 0) + Math.max(10, 55 - rank++ * 2);
        merged.set(item.path, { ...entry, score, excerpt: searchExcerpt(entry, query) });
      }
      return { results: [...merged.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit), source: "omnisearch" };
    } catch (error) { return { results: results.slice(0, limit), source: "local" }; }
    finally { if (timer) clearTimeout(timer); }
  }
  return { invalidate, entries, suggest };
}

module.exports = { createPaperSearch, prepareSearchEntry, searchEntries, searchExcerpt };
