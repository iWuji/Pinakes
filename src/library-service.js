"use strict";

const { createHash, randomUUID } = require("crypto");
const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : Buffer.from(value)).digest("hex");
const dirname = (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** File operations and their recovery records. No view, DOM, or graph simulation. */
function createLibraryService({ app, plugin, model }) {
  const vault = app.vault;
  const journalPath = `${vault.configDir || ".obsidian"}/plugins/pinakes-explorer/operations.json`;
  let queue = Promise.resolve();
  const serial = (task) => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };
  const fileAt = (path) => vault.getAbstractFileByPath(path);
  const requireNote = (path) => {
    const file = fileAt(path);
    if (!file || !path.endsWith(".md") || file.children) throw new Error(`找不到笔记：${path}`);
    return file;
  };
  async function mkdir(path, adapter = false) {
    if (!path) return;
    if (adapter) {
      if (await vault.adapter.exists(path)) return;
      await mkdir(dirname(path), true);
      await vault.adapter.mkdir(path);
    } else {
      const existing = fileAt(path);
      if (existing) {
        if (!existing.children && existing.extension) throw new Error(`这个位置已有文件：${path}`);
        return;
      }
      await mkdir(dirname(path));
      try { await vault.createFolder(path); }
      catch (error) { if (!fileAt(path)) throw error; }
    }
  }
  async function readJournal() {
    if (!(await vault.adapter.exists(journalPath))) return [];
    const parse = (text) => {
      const data = JSON.parse(text);
      if (data.version !== 1 || !Array.isArray(data.operations)) throw new Error("invalid journal");
      return data.operations;
    };
    try { return parse(await vault.adapter.read(journalPath)); }
    catch (error) {
      if (await vault.adapter.exists(journalPath + ".bak")) {
        try { return parse(await vault.adapter.read(journalPath + ".bak")); } catch (_) { /* Preserve both files. */ }
      }
      throw new Error("操作记录无法读取，请保留 operations.json 和 .bak 备份，再检查它们。" );
    }
  }
  async function storeJournal(operations) {
    await mkdir(dirname(journalPath), true);
    // Keep a last-good backup before replacing the record file.
    if (await vault.adapter.exists(journalPath)) {
      const current = await vault.adapter.read(journalPath);
      try {
        const data = JSON.parse(current);
        if (data.version === 1 && Array.isArray(data.operations)) await vault.adapter.write(journalPath + ".bak", current);
      }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    await vault.adapter.write(journalPath, JSON.stringify({ version: 1, operations }, null, 2));
  }
  async function saveOperation(operation) {
    const operations = await readJournal();
    const at = operations.findIndex((o) => o.id === operation.id);
    if (at >= 0) operations[at] = operation; else operations.push(operation);
    await storeJournal(operations);
  }
  async function finishOperation(id) {
    await storeJournal((await readJournal()).filter((o) => o.id !== id));
  }
  async function schema() {
    if (!(await vault.adapter.exists("_schema/.compiled.json"))) return model.DEFAULT_SCHEMA;
    try { return JSON.parse(await vault.adapter.read("_schema/.compiled.json")); }
    catch (error) { throw new Error("实体配置无法读取，请检查 _schema/.compiled.json。" ); }
  }
  async function snapshot() {
    const sc = await schema();
    const scan = sc.scan || model.DEFAULT_SCHEMA.scan;
    const files = vault.getMarkdownFiles().filter((f) =>
      !f.path.split("/").some((s) => (scan.skip_dirs || []).includes(s)) &&
      !(scan.skip_files || []).includes(f.basename));
    const records = await Promise.all(files.map(async (f) => ({ path: f.path, basename: f.basename, content: await vault.read(f) })));
    let rootNote = plugin.settings.rootNote || "【索引】研究总览.md";
    if (!records.some((r) => r.path === rootNote)) {
      const root = records.find((r) => !r.path.includes("/") && /^【索引】/.test(r.basename));
      if (root) {
        rootNote = root.path;
        plugin.settings.rootNote = rootNote;
        await plugin.saveData(plugin.settings);
      }
    }
    const index = model.buildWikiIndex(records, { schema: sc, rootNote });
    return { schema: sc, records, index };
  }
  const paperRoot = (sc) => Object.values(sc.kinds || {}).find((s) => s.member_kind === "paper" && s.root_dir)?.root_dir || "papers";
  async function ensurePaperStructure() {
    const sc = await schema();
    const root = paperRoot(sc);
    const unfiledPath = `${root}/_unfiled/【索引】_unfiled.md`;
    // Existing vaults are not reorganized. Only an empty vault gets a root/library.
    if (!vault.getMarkdownFiles().length) {
      await vault.create("【索引】研究总览.md", `---\nkind: root\ntitle: "【索引】研究总览"\n---\n\n## 大类别\n\n- [[【索引】papers]]\n`);
      await mkdir(root);
      await vault.create(`${root}/【索引】papers.md`, '---\nkind: library\ntitle: "【索引】papers"\n---\n\n## 大类别\n\n## 待归档\n\n- [[【索引】_unfiled]]\n');
    }
    await mkdir(`${root}/_unfiled`);
    if (!fileAt(unfiledPath)) await vault.create(unfiledPath, '---\nkind: partition\ntitle: "【索引】_unfiled"\n---\n\n## 论文\n');
    return snapshot();
  }
  function directions(state) {
    const root = paperRoot(state.schema);
    return [...state.index.nodes.values()].filter((n) => model.isPaperContainer(n, state.schema) && n.path.startsWith(root + "/"))
      .map((n) => ({ name: dirname(n.path).split("/").pop(), label: n.title || n.basename, path: n.path }))
      .sort((a, b) => (a.name === "_unfiled" ? -1 : b.name === "_unfiled" ? 1 : a.label.localeCompare(b.label)));
  }
  async function rebuildDirection(dir) {
    const state = await snapshot();
    const node = [...state.index.nodes.values()].find((n) => dirname(n.path) === dir && model.isPaperContainer(n, state.schema));
    if (!node) throw new Error(`找不到方向索引：${dir}`);
    const columns = state.schema.kinds[node.kind]?.index_columns;
    const section = model.buildIndexSection(node, state.index.nodes, columns);
    await vault.process(requireNote(node.path), (text) => {
      const at = text.search(/^## 论文[ \t]*$/m);
      return (at >= 0 ? text.slice(0, at) : text.replace(/\s*$/, "") + "\n\n") + section;
    });
  }
  async function setRelation(path, type, target, present) {
    await vault.process(requireNote(path), (text) => {
      const has = model.readRelation(text, type).includes(target);
      if (has === present) return text;
      return model.patchRelation(text, { [present ? "add" : "remove"]: { field: type, target } });
    });
    const text = await vault.read(requireNote(path));
    if (model.readRelation(text, type).includes(target) !== present) throw new Error(`关系回读不一致：${path}`);
  }
  async function restoreRelation(operation) {
    // Restore original first, so compensation itself cannot erase the last copy.
    await setRelation(operation.src, operation.type, operation.dstBase, true);
    await setRelation(operation.dst, operation.type, operation.srcBase, operation.reverseBefore);
    await finishOperation(operation.id);
  }
  async function reverseRelation(src, dst, type) {
    return serial(async () => {
      if (!model.REL_META[type] || model.REL_META[type].symmetric || src.path === dst.path) throw new Error("这类关系不需要翻转方向。");
      const sourceText = await vault.read(requireNote(src.path));
      const targetText = await vault.read(requireNote(dst.path));
      if (!model.readRelation(sourceText, type).includes(dst.basename)) throw new Error("原关系已经改变，请刷新图谱后再试。");
      const operation = { id: randomUUID(), kind: "reverse", createdAt: new Date().toISOString(),
        src: src.path, dst: dst.path, srcBase: src.basename, dstBase: dst.basename, type,
        reverseBefore: model.readRelation(targetText, type).includes(src.basename), stage: "pending" };
      await saveOperation(operation);
      try {
        await setRelation(dst.path, type, src.basename, true);
        await setRelation(src.path, type, dst.basename, false);
        operation.stage = "committed";
        await saveOperation(operation);
      } catch (error) {
        // If a journal write failed after both notes changed, roll back to the original.
        operation.stage = "pending";
        try { await restoreRelation(operation); }
        catch (recoveryError) {
          const state = async (path, base) => {
            try { return model.readRelation(await vault.read(requireNote(path)), type).includes(base) ? "已保存" : "未找到"; }
            catch (_) { return "无法读取"; }
          };
          const original = await state(src.path, dst.basename);
          const reverse = await state(dst.path, src.basename);
          const err = new Error(`翻转未完成。当前回读：原关系${original}，反向关系${reverse}。请点击“恢复未完成操作”。详情：${error.message}；恢复：${recoveryError.message}`);
          err.operationId = operation.id;
          throw err;
        }
        throw new Error(`翻转未完成，原关系已恢复。可以重试。详情：${error.message}`);
      }
      try { await finishOperation(operation.id); }
      catch (error) { return { warning: "关系已翻转，操作记录待清理，可在恢复未完成操作中完成。" }; }
      return { warning: null };
    });
  }
  async function importPaper(payload) {
    return serial(async () => {
      const state = await ensurePaperStructure();
      const { file, dirName, year, slug } = payload;
      if (!/^\d{4}$/.test(String(year)) || !/^[a-z0-9][a-z0-9-]*$/.test(slug || "")) throw new Error("请填写四位年份和英文文件名，例如 2026、my-paper。");
      const direction = directions(state).find((d) => d.name === dirName);
      if (!direction) throw new Error("这个研究方向已不存在，请重新选择。");
      // Read the source before making a directory. A source-read failure leaves nothing behind.
      const bytes = file ? await file.arrayBuffer() : null;
      const pdfName = file ? `【${year}】${slug}.pdf` : "";
      const { folderName, text } = model.buildPaperNote({ ...payload, pdfName });
      const dir = dirname(direction.path);
      const folderPath = `${dir}/${folderName}`;
      const notePath = `${folderPath}/${folderName}.md`;
      const pdfPath = pdfName ? `${folderPath}/${pdfName}` : null;
      const operations = await readJournal();
      let operation = operations.find((o) => o.kind === "import" && o.notePath === notePath);
      if (operation) {
        if (operation.noteHash !== hash(text) || operation.pdfHash !== (bytes ? hash(bytes) : null))
          throw new Error("这个位置有未完成的导入，请用原来的内容继续，或在“恢复未完成操作”中撤销后重新导入。");
      } else {
        if (fileAt(folderPath) || fileAt(notePath)) throw new Error("这篇笔记的文件夹已存在，请打开已有笔记或换一个文件名。");
        operation = { id: randomUUID(), kind: "import", createdAt: new Date().toISOString(), stage: "pending",
          folderPath, notePath, pdfPath, noteHash: hash(text), pdfHash: bytes ? hash(bytes) : null, direction: dir };
        await saveOperation(operation);
      }
      try {
        await mkdir(folderPath);
        if (pdfPath) {
          const existing = fileAt(pdfPath);
          if (!existing) await vault.createBinary(pdfPath, bytes);
          else if (hash(await vault.readBinary(existing)) !== operation.pdfHash)
            throw new Error("未完成导入中的 PDF 与本次文件不同，原文件已保留，请先检查。" );
        }
        const note = fileAt(notePath);
        if (!note) await vault.create(notePath, text);
        else if (hash(await vault.read(note)) !== operation.noteHash)
          throw new Error("这篇笔记已被修改，内容已保留，请打开已有笔记。" );
        await rebuildDirection(dir);
        await finishOperation(operation.id);
        return { notePath, pdfPath, folderPath };
      } catch (error) {
        const err = new Error(`导入未完成，表单内容已保留。可点击“重试导入”继续，或在首页恢复未完成操作。详情：${error.message}`);
        err.operationId = operation.id;
        throw err;
      }
    });
  }
  async function cancelImport(id) {
    return serial(async () => {
      const operation = (await readJournal()).find((o) => o.id === id && o.kind === "import");
      if (!operation) return;
      const folder = fileAt(operation.folderPath);
      const expected = [operation.notePath, operation.pdfPath].filter(Boolean);
      if (folder && (folder.children || []).some((f) => !expected.includes(f.path)))
        throw new Error("文件夹中有其他内容，已保留全部文件，请手动检查后再处理。");
      for (const [path, expectedHash, binary] of [[operation.notePath, operation.noteHash, false], [operation.pdfPath, operation.pdfHash, true]]) {
        const file = path && fileAt(path);
        if (file && hash(binary ? await vault.readBinary(file) : await vault.read(file)) !== expectedHash)
          throw new Error("导入文件已被修改，已保留全部内容，请手动检查。");
      }
      // Only the operation's newly created, unchanged folder may go to the trash.
      if (folder) {
        if (app.fileManager?.trashFile) await app.fileManager.trashFile(folder);
        else await vault.trash(folder, true);
      }
      await finishOperation(id);
    });
  }
  async function recoverRelations() {
    return serial(async () => {
      const results = [];
      for (const operation of await readJournal()) {
        if (operation.kind !== "reverse") continue;
        try {
          if (operation.stage === "committed") await finishOperation(operation.id);
          else await restoreRelation(operation);
          results.push({ id: operation.id, ok: true });
        } catch (error) { results.push({ id: operation.id, ok: false, error: error.message }); }
      }
      return results;
    });
  }
  async function finishImport(id) {
    return serial(async () => {
      const operation = (await readJournal()).find((o) => o.id === id && o.kind === "import");
      if (!operation) return;
      if (!fileAt(operation.notePath) || (operation.pdfPath && !fileAt(operation.pdfPath)))
        throw new Error("笔记或 PDF 尚未写完，请用原表单重试导入，或撤销本次导入。");
      if (hash(await vault.read(requireNote(operation.notePath))) !== operation.noteHash ||
        (operation.pdfPath && hash(await vault.readBinary(fileAt(operation.pdfPath))) !== operation.pdfHash))
        throw new Error("文件已改变，已保留内容，请打开笔记检查。" );
      await rebuildDirection(operation.direction);
      await finishOperation(id);
    });
  }
  async function createResearchNote(kind, title) {
    return serial(async () => {
      if (!vault.getMarkdownFiles().length) await ensurePaperStructure();
      const sc = await schema();
      const clean = String(title || "").trim();
      if (!clean || /[\\/:*?"<>|#\[\]\n\r]/.test(clean)) throw new Error("请填写不含路径符号的名称。");
      const root = sc.kinds[kind]?.root_dir || (kind === "topic" ? "deep-research" : "ideas");
      const libraryPath = `${root}/【索引】${kind === "topic" ? "深度调研专题总览" : "Ideas"}.md`;
      const notePath = kind === "topic" ? `${root}/${clean}/【Deep Research】${clean}.md` : `${root}/【idea】${clean}.md`;
      if (fileAt(notePath)) throw new Error("同名笔记已存在，请打开它继续编辑。");
      await mkdir(dirname(libraryPath));
      if (!fileAt(libraryPath)) await vault.create(libraryPath, `---\nkind: ${kind === "topic" ? "topic_library" : "idea_library"}\ntitle: "${libraryPath.split('/').pop().slice(0, -3)}"\n---\n`);
      await mkdir(dirname(notePath));
      const text = `---\nkind: ${kind}\ntitle: '${clean.replace(/'/g, "''")}'\n${kind === "idea" ? "stage: 待做\n" : ""}---\n\n` +
        (kind === "topic" ? "## 研究问题\n\n## 论文与发现\n\n" : "## 想法\n\n## 下一步\n\n");
      await vault.create(notePath, text);
      return notePath;
    });
  }
  async function replacePdf(notePath, file) {
    return serial(async () => {
      const note = requireNote(notePath);
      const before = await vault.read(note);
      const fm = model.parseFrontmatter(before);
      const sc = await schema();
      if ((fm.kind || model.kindOfPath(sc, notePath)) !== "paper")
        throw new Error("只能为论文笔记添加原文 PDF。");
      if (!file || !/\.pdf$/i.test(file.name || "")) throw new Error("请选择 PDF 文件。");
      const bytes = await file.arrayBuffer();
      if (!bytes.byteLength || Buffer.from(bytes).subarray(0, 5).toString() !== "%PDF-") throw new Error("文件不是可读取的 PDF，请重新选择。");
      const oldPdf = fm.pdf || "";
      if (oldPdf && (/[\\/]/.test(oldPdf) || !/\.pdf$/i.test(oldPdf))) throw new Error("当前 PDF 属性不是同目录文件名，请先检查笔记。");
      const pdfName = oldPdf || notePath.split("/").pop().replace(/\.md$/, ".pdf");
      const pdfPath = `${dirname(notePath)}/${pdfName}`;
      if (!oldPdf && fileAt(pdfPath)) throw new Error("目录中已有同名 PDF，请先确认并填写 pdf 属性，避免覆盖未关联的文件。");
      const pending = await readJournal();
      if (pending.some((o) => o.notePath === notePath || o.newNotePath === notePath || o.src === notePath || o.dst === notePath))
        throw new Error("这篇论文有未完成操作，请先恢复，再替换 PDF。");
      const id = randomUUID();
      const backupDir = `${dirname(journalPath)}/backups/${id}`;
      await mkdir(backupDir, true);
      const oldFile = fileAt(pdfPath);
      const oldBytes = oldFile ? await vault.readBinary(oldFile) : null;
      if (oldBytes) await vault.adapter.writeBinary(`${backupDir}/original.pdf`, oldBytes);
      await vault.adapter.write(`${backupDir}/note.md`, before);
      const operation = { id, kind: "pdf", createdAt: new Date().toISOString(), notePath, pdfPath, oldPdf, pdfName,
        beforeHash: hash(before), oldHash: oldBytes ? hash(oldBytes) : null, newHash: hash(bytes), backupDir,
        calloutBefore: (before.match(/^> \[!note\][^\r\n]*原文 PDF[^\r\n]*(?:\r?\n)?/m) || [""])[0], stage: "pending" };
      await saveOperation(operation);
      try {
        if (oldFile) {
          if (hash(await vault.readBinary(oldFile)) !== operation.oldHash) throw new Error("PDF 在备份后被其他操作修改，未覆盖，请检查现有文件。");
          await vault.modifyBinary(oldFile, bytes);
        } else await vault.createBinary(pdfPath, bytes);
        if (hash(await vault.readBinary(fileAt(pdfPath))) !== operation.newHash) throw new Error("PDF 保存后校验不一致。");
        await vault.process(note, (text) => model.patchPdfReference(text, pdfName, oldPdf));
        operation.stage = "committed";
        await saveOperation(operation);
      } catch (error) {
        operation.stage = "pending";
        try { await restorePdf(operation); }
        catch (recoveryError) { throw new Error(`PDF 更新未完成，备份已保留，请从首页恢复操作。详情：${error.message}；恢复：${recoveryError.message}`); }
        throw new Error(`PDF 更新未完成，已恢复原来的文件和引用，可以重试。详情：${error.message}`);
      }
      try { await finishOperation(id); }
      catch (error) { return { pdfPath, backupDir, warning: "PDF 已保存，操作记录待清理，请从首页恢复操作。" }; }
      return { pdfPath, backupDir, warning: null };
    });
  }
  async function restorePdf(operation) {
    const file = fileAt(operation.pdfPath);
    if (file) {
      const currentHash = hash(await vault.readBinary(file));
      if (![operation.oldHash, operation.newHash].includes(currentHash)) throw new Error("PDF 已被其他操作修改，保留现有文件和备份，请手动检查。");
      if (operation.oldHash) {
        const bytes = await vault.adapter.readBinary(`${operation.backupDir}/original.pdf`);
        if (hash(bytes) !== operation.oldHash) throw new Error("原 PDF 备份校验失败。");
        await vault.modifyBinary(file, bytes);
      } else await vault.trash(file, true);
    } else if (operation.oldHash) {
      const bytes = await vault.adapter.readBinary(`${operation.backupDir}/original.pdf`);
      if (hash(bytes) !== operation.oldHash) throw new Error("原 PDF 备份校验失败。");
      await vault.createBinary(operation.pdfPath, bytes);
    }
    const note = requireNote(operation.notePath);
    const latest = await vault.read(note);
    const fm = model.parseFrontmatter(latest);
    if ((fm.pdf || "") === operation.pdfName && hash(latest) !== operation.beforeHash) {
      await vault.process(note, (text) => model.patchPdfReference(text, operation.oldPdf, operation.pdfName, operation.calloutBefore));
    } else if ((fm.pdf || "") !== operation.oldPdf) throw new Error("PDF 属性已被修改，现有笔记已保留。");
    await finishOperation(operation.id);
  }
  async function movePaperInternal(notePath, targetIndexPath) {
    const state = await snapshot();
    const node = state.index.nodes.get(notePath);
    const target = state.index.nodes.get(targetIndexPath);
    if (!node || node.kind !== "paper" || !model.isPaperContainer(target, state.schema)) throw new Error("论文或目标方向已不存在，请刷新后重试。");
    const oldFolder = dirname(notePath);
    const oldDir = dirname(oldFolder);
    const newDir = dirname(targetIndexPath);
    const root = paperRoot(state.schema);
    if (dirname(oldDir) !== root || dirname(newDir) !== root ||
      oldFolder.split("/").pop() + ".md" !== notePath.split("/").pop())
      throw new Error("这篇笔记不是独立论文文件夹，不能整目录归档。请先检查目录结构。");
    if (oldDir === newDir) return { notePath, skipped: true };
    const newFolder = `${newDir}/${oldFolder.split("/").pop()}`;
    const newNotePath = `${newFolder}/${notePath.split("/").pop()}`;
    if (fileAt(newFolder)) throw new Error("目标方向中有同名文件夹，未移动这篇论文。");
    if ((await readJournal()).some((o) => o.notePath === notePath || o.newNotePath === notePath || o.src === notePath || o.dst === notePath))
      throw new Error("这篇论文有未完成操作，请先恢复。");
    if (!app.fileManager?.renameFile) throw new Error("当前环境不支持更新文件引用，请在 Obsidian 中归档。");
    const before = await vault.read(requireNote(notePath));
    const id = randomUUID();
    const backupDir = `${dirname(journalPath)}/backups/${id}`;
    await mkdir(backupDir, true);
    await vault.adapter.write(`${backupDir}/note.md`, before);
    const operation = { id, kind: "move", createdAt: new Date().toISOString(), notePath, newNotePath, oldFolder, newFolder,
      oldDir, newDir, targetIndexPath, targetBase: target.basename, beforeTitle: model.parseFrontmatter(before).title || "",
      backupDir, stage: "pending" };
    await saveOperation(operation);
    try {
      await app.fileManager.renameFile(fileAt(oldFolder), newFolder);
      await finishMove(operation);
      return { notePath: newNotePath, oldFolder, newFolder, skipped: false };
    } catch (error) {
      const moved = !!fileAt(newNotePath) && !fileAt(notePath);
      throw Object.assign(new Error(`${moved ? "文件已移到目标方向，但归属或索引更新未完成" : "归档未完成"}，请从首页恢复操作。详情：${error.message}`),
        { moved, notePath: moved ? newNotePath : notePath, operationId: id });
    }
  }
  async function finishMove(operation) {
    let old = fileAt(operation.oldFolder), next = fileAt(operation.newFolder);
    if (old && next) throw new Error("源和目标文件夹同时存在，已保留两处内容，请手动检查。");
    if (old) {
      if (!fileAt(operation.targetIndexPath)) throw new Error("目标方向已删除，未移动源文件。");
      await app.fileManager.renameFile(old, operation.newFolder);
      next = fileAt(operation.newFolder);
    }
    if (!next) throw new Error("找不到移动后的论文文件夹，操作记录已保留。");
    const state = await snapshot();
    const target = state.index.nodes.get(operation.targetIndexPath);
    if (!model.isPaperContainer(target, state.schema)) throw new Error("目标方向不再是论文容器，请手动确认。");
    await vault.process(requireNote(operation.newNotePath), (text) => {
      let updated = model.patchScalarField(text, "direction", `"[[${operation.targetBase}]]"`);
      const dirs = model.readRelation(updated, "sub_directions");
      for (const base of dirs) {
        if (base === operation.targetBase || target.kind === "partition")
          updated = model.patchRelation(updated, { remove: { field: "sub_directions", target: base } });
      }
      return updated;
    });
    const colors = plugin.settings.nodeColors || {};
    for (const path of Object.keys(colors)) if (path === operation.oldFolder || path.startsWith(operation.oldFolder + "/")) {
      colors[operation.newFolder + path.slice(operation.oldFolder.length)] = colors[path]; delete colors[path];
    }
    plugin.settings.readingHistory = (plugin.settings.readingHistory || []).map((entry) => entry.path.startsWith(operation.oldFolder + "/")
      ? { ...entry, path: operation.newFolder + entry.path.slice(operation.oldFolder.length) } : entry);
    await plugin.saveData(plugin.settings);
    await rebuildDirection(operation.oldDir);
    await rebuildDirection(operation.newDir);
    await finishOperation(operation.id);
  }
  async function movePaper(notePath, targetIndexPath) { return serial(() => movePaperInternal(notePath, targetIndexPath)); }
  async function movePapers(notePaths, targetIndexPath) {
    return serial(async () => {
      const results = [];
      for (const path of [...new Set(notePaths)]) {
        try { results.push({ path, ok: true, ...await movePaperInternal(path, targetIndexPath) }); }
        catch (error) { results.push({ path, ok: false, moved: !!error.moved, notePath: error.notePath || path, error: error.message }); }
      }
      return results;
    });
  }
  async function recoverOperation(id) {
    return serial(async () => {
      const operation = (await readJournal()).find((o) => o.id === id);
      if (!operation) return;
      if (operation.kind === "move") await finishMove(operation);
      else if (operation.kind === "pdf") {
        if (operation.stage === "committed") await finishOperation(id); else await restorePdf(operation);
      } else throw new Error("请使用对应类型的恢复操作。");
    });
  }
  return { schema, snapshot, directions, ensurePaperStructure, rebuildDirection, reverseRelation, importPaper,
    pendingOperations: readJournal, recoverRelations, cancelImport, finishImport, createResearchNote,
    replacePdf, movePaper, movePapers, recoverOperation };
}

module.exports = { createLibraryService };
