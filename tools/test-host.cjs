// Exercise the modal against an in-memory vault. This is not a real Obsidian UI test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const data = require('../src/main.js');
let reducedMotion = false;
let itemViewConstructions = 0;
const openedModals = [];

class Element {
  constructor(tag = 'div', opts = {}) {
    this.tag = tag;
    this.children = [];
    this.events = {};
    this.value = '';
    this.disabled = false;
    this.textContent = opts.text || '';
    this.classes = new Set((opts.cls || '').split(' '));
    this.attributes = opts.attr || {};
    this.ownerDocument = { defaultView: { matchMedia: () => ({ matches: reducedMotion }) } };
    this.animations = [];
    this.style = {};
    this.scrollHeight = 180;
  }
  createEl(tag, opts) { const child = new Element(tag, opts); this.children.push(child); return child; }
  createDiv(opts) { return this.createEl('div', opts); }
  createSpan(opts) { return this.createEl('span', opts); }
  get value() { return this._value || ''; }
  set value(text) { this._value = this.tag === 'textarea' ? text.replace(/\r\n|\r/g, '\n') : text; }
  setText(text) { this.textContent = text; }
  addClass(name) { this.classes.add(name); }
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  focus() {}
  appendChild(child) { this.children.push(child); return child; }
  animate(frames, options) { const animation = { frames, options, cancel() { this.cancelled = true; } }; this.animations.push(animation); return animation; }
  toggle(show) { this.visible = show; }
  empty() { this.children = []; this.textContent = ''; }
  addEventListener(name, fn) { this.events[name] = fn; }
  querySelectorAll(tag) { return this.children.flatMap((c) => [ ...(tag.split(',').map(t => t.trim()).includes(c.tag) ? [c] : []), ...c.querySelectorAll(tag) ]); }
}
class Component {
  constructor() { this.children = new Set(); this.loaded = true; }
  addChild(child) { this.children.add(child); return child; }
  removeChild(child) { this.children.delete(child); child.loaded = false; return child; }
  register() {}
  registerEvent() {}
  registerInterval(id) { clearInterval(id); }
}
class ItemView extends Component {
  constructor(leaf) { super(); itemViewConstructions++; this.leaf = leaf; this.app = leaf.app; this.contentEl = new Element(); }
}
class PluginStub extends Component {
  loadData() { return Promise.resolve({ welcomed: true }); }
  saveData() { return Promise.resolve(); }
  addSettingTab() {}
  registerView(type, factory) { (this.views ||= new Map()).set(type, factory); }
  addRibbonIcon(icon, label, callback) { (this.ribbons ||= []).push({ icon, label, callback }); }
  addCommand(command) { (this.commands ||= []).push(command); }
}
class Modal {
  constructor(app) { this.app = app; this.modalEl = new Element(); this.contentEl = new Element(); this.containerEl = new Element(); this.titleEl = new Element(); }
  open() { openedModals.push(this); this.opened = this.onOpen?.(); }
  close() { this.nativeClosed = true; this.onClose?.(); }
  setTitle(text) { this.titleEl.setText(text); }
}
class TFile {
  constructor(filePath) { this.path = filePath; this.basename = path.posix.basename(filePath, '.md'); this.extension = path.posix.extname(filePath).slice(1); }
}
const notices = [];
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const moduleStub = { exports: {} };
const randomMath = Object.create(Math);
randomMath.random = () => 0;
vm.runInNewContext(source, {
  module: moduleStub, exports: moduleStub.exports, Math: randomMath,
  setInterval, clearInterval, setTimeout, clearTimeout, window: { setTimeout: (callback) => setTimeout(callback, 0), clearTimeout },
  require: (name) => name === 'obsidian' ? {
    Plugin: PluginStub, ItemView, PluginSettingTab: class {}, SuggestModal: class {},
    Modal, Component, TFile, Notice: class { constructor(text) { notices.push(text); } },
    setIcon: () => {}, debounce: (fn) => fn,
    MarkdownRenderer: { render: async (app, markdown, el, sourcePath, component) => {
      assert.equal(component.loaded, true);
      el.rendered = markdown;
      el.sourcePath = sourcePath;
    } },
  } : name === './adapters.js' ? require('../src/adapters.js') : name === './library-service.js' ? require('../src/library-service.js') : name === './reading-session.js' ? require('../src/reading-session.js') : require(name),
});
const Plugin = moduleStub.exports;

const dir = 'papers/test';
const indexPath = `${dir}/【索引】test.md`;
const paperPath = (slug) => `${dir}/【2026】${slug}/【2026】${slug}.md`;
const note = (slug) => `---\ntitle: '${slug}'\nyear: 2026\nreading: 未读\nimportance: 1\ntable_summary: '简介${slug}'\ntags: [test]\n---\n## 整体综述\n综述${slug}\n\n### 关键机制\n机制说明\n\n## 方法\n不可覆盖的方法${slug}\n\n## 我的批注与 Open debates\n个人记录${slug}\n`;
function fixture(empty = false) {
  const contents = new Map(empty ? [] : [
    [indexPath, '---\ntitle: Test\n---\n介绍应保留\n\n## 论文\n旧表\n'],
    [paperPath('a'), note('a')], [paperPath('b'), note('b')],
    ['ideas/【idea】skip.md', '---\nkind: idea\nreading: 未读\n---\n想法'],
  ]);
  const files = new Map([...contents.keys()].map((p) => [p, new TFile(p)]));
  const attach = (file) => {
    const parentPath = path.posix.dirname(file.path);
    if (parentPath === '.') return;
    let parent = files.get(parentPath);
    if (!parent) { parent = { path: parentPath, children: [] }; files.set(parentPath, parent); attach(parent); }
    if (!parent.children.includes(file)) parent.children.push(file);
  };
  [...files.values()].forEach(attach);
  const metadata = new Map([['_schema/.compiled.json', JSON.stringify(data.DEFAULT_SCHEMA)]]);
  const adapterDirs = new Set(['_schema']);
  let failure = null;
  const leaves = [];
  const events = new Map();
  const app = {
    vault: {
      configDir: '.obsidian',
      adapter: {
        exists: async (p) => metadata.has(p) || adapterDirs.has(p),
        read: async (p) => { if (!metadata.has(p)) throw new Error('missing adapter file'); return metadata.get(p); },
        write: async (p, text) => metadata.set(p, text),
        writeBinary: async (p, bytes) => metadata.set(p, bytes),
        readBinary: async (p) => metadata.get(p),
        mkdir: async (p) => adapterDirs.add(p),
      },
      getMarkdownFiles: () => [...files.values()].filter((f) => f.extension === 'md'),
      getAbstractFileByPath: (p) => files.get(p),
      read: async (f) => { if (!contents.has(f.path)) throw new Error('笔记已删除'); return contents.get(f.path); },
      readBinary: async (f) => contents.get(f.path),
      modifyBinary: async (f, bytes) => contents.set(f.path, bytes),
      cachedRead: async (f) => contents.get(f.path),
      process: async (f, fn) => {
        if (failure) { const e = failure; failure = null; throw e; }
        if (!contents.has(f.path)) throw new Error('笔记已删除');
        const text = fn(contents.get(f.path)); contents.set(f.path, text); return text;
      },
      createFolder: async (p) => { if (files.has(p)) throw new Error('folder exists'); const folder = { path: p, children: [] }; files.set(p, folder); attach(folder); return folder; },
      create: async (p, text) => { if (files.has(p)) throw new Error('file exists'); const file = new TFile(p); files.set(p, file); contents.set(p, text); attach(file); return file; },
      createBinary: async (p, bytes) => { const file = new TFile(p); files.set(p, file); contents.set(p, bytes); attach(file); return file; },
      trash: async (folder) => {
        for (const p of [...files.keys()]) if (p === folder.path || p.startsWith(folder.path + '/')) { files.delete(p); contents.delete(p); }
        const parent = files.get(path.posix.dirname(folder.path)); if (parent) parent.children = parent.children.filter((f) => f.path !== folder.path);
      },
      on: (event, fn) => { events.set('vault:' + event, fn); return {}; },
    },
    workspace: {
      getLeavesOfType: (type) => leaves.filter((leaf) => leaf.type === type),
      on: (event, fn) => { events.set(event, fn); return {}; },
      onLayoutReady: () => {},
      revealLeaf: async (leaf) => { app.workspace.activeLeaf = leaf; },
      getLeaf: () => ({ app,
        openFile: async (f, state) => { app.openedFile = f; app.openedState = state; },
        setViewState: async function(state) {
          this.type = state.type; this.view = plugin.views.get(state.type)(this);
          leaves.push(this); await this.view.onOpen();
        },
      }),
    },
  };
  app.fileManager = { renameFile: async (folder, newPath) => {
    const oldPath = folder.path;
    if (files.has(newPath)) throw Error('target exists');
    const moved = [...files.values()].filter(f => f.path === oldPath || f.path.startsWith(oldPath + '/'));
    const parent = files.get(path.posix.dirname(oldPath));
    if (parent) parent.children = parent.children.filter(f => f !== folder);
    for (const file of moved) {
      const old = file.path, next = newPath + old.slice(oldPath.length);
      files.delete(old); files.set(next, file); file.path = next;
      if (contents.has(old)) { contents.set(next, contents.get(old)); contents.delete(old); }
    }
    attach(folder);
  } };
  const plugin = new Plugin(); plugin.app = app; plugin.settings = { readingStates: [] };
  return { plugin, app, contents, events, leaves, fail: () => { failure = new Error('模拟写入失败'); } };
}
async function click(modal, label) {
  const matchesLabel = (e) => e.textContent === label || e.children.some(matchesLabel);
  const b = modal.contentEl.querySelectorAll('button').find(matchesLabel);
  assert.ok(b, `Missing button: ${label}`);
  assert.equal(b.disabled, false, `${label} disabled`);
  await b.events.click();
}
async function open(plugin) { plugin.openBrowse(); const modal = plugin.browseModal; await modal.opened; return modal; }

module.exports = { fixture, open, click, Element, Plugin, ItemView, notices, openedModals,
  setReducedMotion(value) { reducedMotion = value; },
  getItemViewConstructions() { return itemViewConstructions; },
};
