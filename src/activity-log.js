"use strict";

const { randomUUID } = require("crypto");
const TYPES = ["added", "status", "edited"];
const pad = number => String(number).padStart(2, "0");
function localDay(date = new Date()) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; }
function dayDate(day) { const [year, month, date] = day.split("-").map(Number); return new Date(year, month - 1, date, 12); }
function shiftDay(day, offset) { const date = dayDate(day); date.setDate(date.getDate() + offset); return localDay(date); }
const total = day => TYPES.reduce((sum, type) => sum + (day?.[type] || 0), 0);
function activityLevel(count) { return !count ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4; }

function mergeActivityHistory(ledger, plan) {
  const validDay = day => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) && localDay(dayDate(day)) === day;
  if (plan.version !== 1 || !Array.isArray(plan.events) ||
    plan.events.some(event => !validDay(event.day) || !TYPES.includes(event.type) || typeof event.id !== "string" || !event.id) ||
    (plan.remove || []).some(item => !validDay(item.day) || !TYPES.includes(item.type) || !Array.isArray(item.ids) || item.ids.some(id => typeof id !== "string")))
    throw new Error("历史活跃度导入文件无效，原记录已保留。");
  const data = JSON.parse(JSON.stringify(ledger));
  for (const item of plan.remove || []) {
    const values = data.days[item.day];
    if (!values) continue;
    const selected = new Set(item.ids);
    const count = (values.ids || []).filter(id => selected.has(id)).length;
    if (count > (values[item.type] || 0)) throw new Error("历史活跃度修正与当前记录不一致，原记录已保留。");
    values[item.type] = (values[item.type] || 0) - count;
    values.ids = (values.ids || []).filter(id => !selected.has(id));
  }
  const ids = new Set(Object.values(data.days).flatMap(day => day.ids || []));
  for (const event of plan.events) {
    if (ids.has(event.id)) continue;
    const values = data.days[event.day] ||= { added: 0, status: 0, edited: 0, ids: [] };
    values[event.type] = (values[event.type] || 0) + 1;
    (values.ids ||= []).push(event.id);
    ids.add(event.id);
    if (event.day < data.startedOn) data.startedOn = event.day;
  }
  return data;
}

function activityCalendar(data, now = new Date()) {
  const today = localDay(now), first = shiftDay(today, -364);
  const start = dayDate(first);
  start.setDate(start.getDate() - (start.getDay() + 6) % 7); // Monday first; use calendar math, not milliseconds.
  const weeks = [], months = [];
  let activeDays = 0, count = 0;
  const todayData = data.days[today] || {};
  for (let day = localDay(start), week = 0; day <= today; week++) {
    const cells = [];
    for (let row = 0; row < 7; row++, day = shiftDay(day, 1)) {
      const inRange = day >= first && day <= today;
      const values = data.days[day] || {};
      const contributions = inRange ? total(values) : 0;
      if (inRange && contributions) { activeDays++; count += contributions; }
      const date = dayDate(day);
      if (inRange && (date.getDate() === 1 || !months.length)) {
        const month = date.getMonth() + 1;
        if (!months.length || months[months.length - 1].month !== month) months.push({ week, month });
      }
      cells.push({ day, inRange, tracked: day >= data.startedOn || !!data.days[day], count: contributions, level: activityLevel(contributions),
        added: values.added || 0, status: values.status || 0, edited: values.edited || 0 });
    }
    weeks.push(cells);
  }
  let streak = 0, cursor = total(todayData) ? today : shiftDay(today, -1);
  while (cursor >= first && total(data.days[cursor])) { streak++; cursor = shiftDay(cursor, -1); }
  return { today, first, weeks, months, activeDays, total: count, todayCount: total(todayData), streak,
    startedOn: data.startedOn };
}

function comparableBody(text) {
  // Auto-updated attachment/navigation paths are not note-writing activity.
  return String(text).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "")
    .replace(/^> \[!note\][^\r\n]*原文 PDF[^\r\n]*(?:\r?\n)?/gm, "")
    .replace(/^##[ \t]+路径[ \t]*\r?\n[\s\S]*?(?=^##[ \t]|$(?![\s\S]))/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, path, label) => label || path.split("/").pop())
    .replace(/\r\n/g, "\n").trim();
}

/** Local successful actions only. Opening a paper does not change this ledger. */
function createActivityLog({ vault, schema, model, now = () => new Date(), onChange = () => {}, onError = () => {} }) {
  const path = `${vault.configDir || ".obsidian"}/plugins/pinakes-explorer/activity.json`;
  let data = null, initialized = null, queue = Promise.resolve(), stopped = false;
  const known = new Map(), suppressed = new Map(), timers = new Map();
  let schemaCache = null;
  const collectionStartedAt = now().getTime();
  const serial = task => { const result = queue.then(task); queue = result.catch(() => {}); return result; };
  const stateOf = text => {
    const fm = model.parseFrontmatter(text);
    const metadata = JSON.stringify({ title: fm.title || "", summary: fm.summary || "", year: fm.year || "",
      tags: [...fm.tags || []].sort(), authors: fm.authors || [],
      relations: ["extends", "uses", "competes", "contradicts"].map(key => fm[key] || "") });
    return { reading: fm.reading || "未读", importance: fm.importance ?? null, body: comparableBody(text), metadata };
  };
  const paper = (file, text) => file?.extension === "md" &&
    !(schemaCache.scan?.skip_dirs || []).some(dir => file.path.split("/").includes(dir)) &&
    (model.parseFrontmatter(text).kind || model.kindOfPath(schemaCache, file.path)) === "paper";
  function validate(raw) {
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 || typeof parsed.days !== "object" || !parsed.days || Array.isArray(parsed.days) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.startedOn || "") || localDay(dayDate(parsed.startedOn)) !== parsed.startedOn)
      throw new Error("invalid activity ledger");
    for (const [day, values] of Object.entries(parsed.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || localDay(dayDate(day)) !== day || !values ||
        TYPES.some(type => !Number.isInteger(values[type] ?? 0) || (values[type] ?? 0) < 0) ||
        (values.ids && (!Array.isArray(values.ids) || values.ids.some(id => typeof id !== "string")))) throw new Error("invalid activity day");
    }
    return parsed;
  }
  async function mkdir(dir) {
    if (!dir || await vault.adapter.exists(dir)) return;
    const at = dir.lastIndexOf("/"); if (at >= 0) await mkdir(dir.slice(0, at));
    await vault.adapter.mkdir(dir);
  }
  async function persist() {
    await mkdir(path.slice(0, path.lastIndexOf("/")));
    if (await vault.adapter.exists(path)) {
      const existing = await vault.adapter.read(path);
      try { validate(existing); await vault.adapter.write(path + ".bak", existing); }
      catch (error) { if (!(error instanceof SyntaxError) && error.message !== "invalid activity ledger" && error.message !== "invalid activity day") throw error; }
    }
    await vault.adapter.write(path, JSON.stringify(data, null, 2));
  }
  async function init() {
    if (initialized) return initialized;
    initialized = (async () => {
      schemaCache = await schema();
      if (await vault.adapter.exists(path)) {
        try { data = validate(await vault.adapter.read(path)); }
        catch (error) {
          if (await vault.adapter.exists(path + ".bak")) {
            try { data = validate(await vault.adapter.read(path + ".bak")); } catch (_) { /* Keep originals. */ }
          }
          if (!data) throw new Error("活跃度记录无法读取，原文件和备份已保留，请检查 activity.json。");
        }
      } else data = { version: 1, startedOn: localDay(now()), days: {} };
      // Explicit, user-authorized import only. Its stable IDs make retries safe.
      if (await vault.adapter.exists(path + ".import")) {
        const next = mergeActivityHistory(data, JSON.parse(await vault.adapter.read(path + ".import")));
        if (JSON.stringify(next) !== JSON.stringify(data)) { data = next; await persist(); }
      }
      // First scan seeds state only: never invent activity from existing notes or file timestamps.
      await Promise.all(vault.getMarkdownFiles().map(async file => {
        let text;
        try { text = await vault.cachedRead(file); }
        catch (error) { if (!vault.getAbstractFileByPath(file.path)) return; throw error; }
        if (paper(file, text)) known.set(file.path, stateOf(text));
      }));
      if (!(await vault.adapter.exists(path))) await persist();
    })();
    return initialized;
  }
  async function append(type, id, date = now()) {
    if (!TYPES.includes(type)) throw new Error("未知活跃度类型");
    if (!data) throw new Error("活跃度尚未初始化");
    if (id && Object.values(data.days).some(day => (day.ids || []).includes(id))) {
      await persist(); return false;
    }
    const day = localDay(date), values = data.days[day] || { added: 0, status: 0, edited: 0, ids: [] };
    values[type] = (values[type] || 0) + 1;
    if (id) { if (!values.ids) values.ids = []; values.ids.push(id); }
    data.days[day] = values;
    await persist(); onChange(); return true;
  }
  async function record(type, id = randomUUID(), date = now()) {
    await init(); return serial(() => append(type, id, date));
  }
  async function observe(file, created = false, date = now()) {
    await init();
    return serial(async () => {
      if (stopped || !file || suppressed.has(file.path)) return;
      const current = vault.getAbstractFileByPath(file.path);
      if (!current) { known.delete(file.path); return; }
      const text = await vault.read(current);
      if (!paper(current, text)) { known.delete(file.path); return; }
      const state = stateOf(text), before = known.get(file.path);
      known.set(file.path, state);
      if (!before) {
        // Obsidian may emit create while discovering existing vault files at startup.
        const createdAt = current.stat?.ctime;
        if (created && (!Number.isFinite(createdAt) || createdAt >= collectionStartedAt)) await append("added", randomUUID(), date);
        return;
      }
      // One saved operation counts once; reading/importance is the status category.
      if (state.reading !== before.reading || state.importance !== before.importance) await append("status", randomUUID(), date);
      else if (state.body !== before.body || state.metadata !== before.metadata) await append("edited", randomUUID(), date);
    });
  }
  async function sync(notePath) {
    await init();
    return serial(async () => {
      const file = vault.getAbstractFileByPath(notePath);
      if (!file) { known.delete(notePath); return; }
      const text = await vault.read(file);
      if (paper(file, text)) known.set(notePath, stateOf(text));
    });
  }
  async function guard(notePaths) {
    await init();
    for (const path of notePaths) {
      suppressed.set(path, (suppressed.get(path) || 0) + 1);
      if (timers.has(path)) { clearTimeout(timers.get(path).timer); timers.delete(path); }
    }
    let released = false;
    return async () => {
      if (released) return; released = true;
      try { for (const path of notePaths) await sync(path); }
      finally { for (const path of notePaths) { const count = suppressed.get(path) - 1; if (count > 0) suppressed.set(path, count); else suppressed.delete(path); } }
    };
  }
  function schedule(file, created = false) {
    if (stopped || !file || file.extension !== "md" || suppressed.has(file.path)) return;
    const previous = timers.get(file.path);
    if (previous) clearTimeout(previous.timer);
    const path = file.path;
    const entry = { file, created: created || !!previous?.created, date: now(), timer: null };
    entry.timer = setTimeout(() => {
      timers.delete(path);
      observe(entry.file, entry.created, entry.date).catch(onError);
    }, 800);
    timers.set(path, entry);
  }
  function rename(file, oldPath) {
    if (timers.has(oldPath)) { clearTimeout(timers.get(oldPath).timer); timers.delete(oldPath); }
    for (const path of [...known.keys()]) {
      if (path === oldPath || path.startsWith(oldPath + "/")) { known.set(file.path + path.slice(oldPath.length), known.get(path)); known.delete(path); }
    }
  }
  function remove(file) {
    for (const path of [...known.keys()]) if (path === file.path || path.startsWith(file.path + "/")) known.delete(path);
    for (const path of [...timers.keys()]) if (path === file.path || path.startsWith(file.path + "/")) { clearTimeout(timers.get(path).timer); timers.delete(path); }
  }
  async function snapshot() { await init(); await queue; return JSON.parse(JSON.stringify(data)); }
  async function flush() {
    const pending = [...timers.values()]; timers.clear();
    for (const entry of pending) { clearTimeout(entry.timer); await observe(entry.file, entry.created, entry.date); }
    await init(); return serial(persist);
  }
  function dispose() {
    // Finish already queued saves; capture pending note edits before disabling event collection.
    const pending = [...timers.values()]; timers.clear();
    for (const entry of pending) clearTimeout(entry.timer);
    return (async () => {
      for (const entry of pending) await observe(entry.file, entry.created, entry.date);
      stopped = true; await queue;
    })();
  }
  return { init, record, observe, schedule, guard, sync, rename, remove, snapshot, flush, dispose };
}

module.exports = { createActivityLog, activityCalendar, activityLevel, localDay, shiftDay, total, mergeActivityHistory };
