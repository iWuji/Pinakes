"use strict";
/*
 * Pinakes adapters —— 把 `locator` 变成可 stat / 可打开的资源。
 *
 * 不依赖 Obsidian，node 里可直接单测（见 test.js）。
 * 支持的定位形式：
 *   （空）                     vault 内笔记/目录（由调用方处理）
 *   file:///abs/path          本地文件/目录
 *   /abs/path 或 ~/path       同上（容错）
 *   git@host:org/repo(.git)   git 仓库（远程）
 *   https://host/…(.git)      同上
 *   ssh://user@host:/path     远程机器上的路径
 *   https://…  / http://…     普通网页
 */

let _fs = null, _path = null, _os = null, _child = null;
try { _fs = require("fs"); } catch (e) { /* 非 Node 环境 */ }
try { _path = require("path"); } catch (e) { /* noop */ }
try { _os = require("os"); } catch (e) { /* noop */ }
try { _child = require("child_process"); } catch (e) { /* noop */ }

/** 把 locator 拆成 { scheme, host, path, url, raw } */
function parseLocator(locator) {
  const raw = String(locator || "").trim();
  if (!raw) return { scheme: "note", raw };
  if (/^file:\/\//i.test(raw)) {
    let p = raw.replace(/^file:\/\//i, "");
    try { p = decodeURIComponent(p); } catch (e) { /* 保留原样 */ }
    return { scheme: "file", path: normalizeHome(p), raw };
  }
  if (/^ssh:\/\//i.test(raw)) {
    // ssh://user@host:/path  或  ssh://user@host/path
    const m = raw.match(/^ssh:\/\/([^/:]+)(?::?(\/.*))?$/i);
    if (m) return { scheme: "ssh", host: m[1], path: m[2] || "", raw };
    return { scheme: "ssh", host: raw.slice(6), path: "", raw };
  }
  if (/^git@[^:]+:/i.test(raw)) {
    const m = raw.match(/^git@([^:]+):(.+)$/);
    return {
      scheme: "git", host: m ? m[1] : "", path: m ? m[2] : "",
      url: "https://" + (m ? m[1] + "/" + m[2] : raw.slice(4)).replace(/\.git$/, ""),
      raw,
    };
  }
  if (/^https?:\/\//i.test(raw)) {
    if (/\.git$/i.test(raw)) return { scheme: "git", url: raw.replace(/\.git$/, ""), raw };
    return { scheme: "web", url: raw, raw };
  }
  if (raw.startsWith("~")) return { scheme: "file", path: normalizeHome(raw), raw };
  if (raw.startsWith("/")) return { scheme: "file", path: raw, raw };
  return { scheme: "note", raw };
}

function normalizeHome(p) {
  if (_os && p.startsWith("~")) return _path.join(_os.homedir(), p.slice(1));
  return p;
}

/** 本地路径的资源概况：{ ok, isDir, files, dirs, error }。只读一层，封顶 5000 项。 */
function statLocal(path) {
  if (!_fs || !path) return { ok: false, error: "no-fs" };
  try {
    const st = _fs.statSync(path);
    if (!st.isDirectory()) return { ok: true, isDir: false, files: 1, dirs: 0 };
    let files = 0, dirs = 0, seen = 0;
    // withFileTypes 省掉逐项 stat（大目录快一个数量级）
    const entries = _fs.readdirSync(path, { withFileTypes: true });
    for (const ent of entries) {
      if (++seen > 5000) break;
      if (ent.isDirectory()) dirs++;
      else if (ent.isFile()) files++;
    }
    return { ok: true, isDir: true, files, dirs, truncated: entries.length > 5000 };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
}

/** 资源概况。远程资源不做网络探测（保持 UI 非阻塞），返回 unknown。 */
function statResource(locator) {
  const p = parseLocator(locator);
  if (p.scheme === "file") return Object.assign({ kind: "file" }, statLocal(p.path));
  if (p.scheme === "git") return { kind: "git", ok: true, isDir: true, files: null, dirs: null, remote: true };
  if (p.scheme === "ssh") return { kind: "ssh", ok: true, isDir: true, files: null, dirs: null, remote: true };
  if (p.scheme === "web") return { kind: "web", ok: true, isDir: false, files: null, dirs: null };
  return { kind: "note", ok: true };
}

/** 打开资源。返回 { ok, how, error }；不会抛异常。 */
function openResource(locator, deps = {}) {
  const p = parseLocator(locator);
  const shell = deps.shell || electronShell();
  const openLocal = deps.openPath || ((path) => {
    if (shell && typeof shell.openPath === "function") return shell.openPath(path);
    return execOpen(path);
  });
  const openUrl = deps.openExternal || ((url) => {
    if (shell && typeof shell.openExternal === "function") return shell.openExternal(url);
    if (typeof window !== "undefined" && window.open) { window.open(url); return "window"; }
    return execOpen(url);
  });

  try {
    if (p.scheme === "file") {
      const r = openLocal(p.path);
      return { ok: r !== false, how: "file", path: p.path };
    }
    if (p.scheme === "git") { openUrl(p.url); return { ok: true, how: "browser", url: p.url }; }
    if (p.scheme === "web") { openUrl(p.url); return { ok: true, how: "browser", url: p.url }; }
    if (p.scheme === "ssh") {
      const cmd = `ssh ${p.host}`;
      if (deps.clipboard && typeof deps.clipboard.writeText === "function") {
        deps.clipboard.writeText(cmd);
        return { ok: true, how: "clipboard", command: cmd };
      }
      return { ok: false, how: "none", command: cmd, error: "no-clipboard" };
    }
    return { ok: false, how: "none", error: "note" };
  } catch (e) {
    return { ok: false, how: "none", error: e.message };
  }
}

function electronShell() {
  try { return require("electron").shell || null; } catch (e) { return null; }
}

function execOpen(target) {
  if (!_child) return false;
  try {
    const cmd = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "explorer" : "xdg-open";
    _child.spawn(cmd, [target], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch (e) {
    return false;
  }
}

/** 给人看的资源摘要：`内部自由管理 · 12 文件 / 3 目录`。 */
function describeStat(stat) {
  if (!stat) return "";
  if (!stat.ok) return `资源不可达（${stat.error || "未知错误"}）`;
  if (stat.remote) return stat.kind === "git" ? "远程 git 仓库" : "远程路径";
  if (stat.kind === "web") return "网页";
  if (!stat.isDir) return "单个文件";
  const n = stat.files == null ? "?" : stat.files;
  const d = stat.dirs == null ? "?" : stat.dirs;
  return `内部自由管理 · ${n} 文件 / ${d} 目录` + (stat.truncated ? "（只统计前 5000 项）" : "");
}

module.exports = {
  parseLocator, statLocal, statResource, openResource, describeStat,
};
