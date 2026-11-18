# Pinakes：开发与维护约定

本仓库首先是 Obsidian 桌面插件项目。用户入口是 [README.md](../README.md)，开发流程见 [开发指南](development.md)，版本与发行物见 [发布规范](releasing.md)。论文阅读、录入与写作规则见 [知识库约定](wiki-conventions.md)，本文件只规定软件维护。

## 源码与发行物

- 插件 JavaScript 只维护 `src/` 中的源码：`main.js` 为界面入口，`library-service.js` 为共享索引、导入与恢复服务，`adapters.js` 为资源适配器。根目录 `styles.css` 是样式源文件。
- `manifest.json` 是插件元数据真源；ID 固定为 `pinakes-explorer`。版本与 `package.json`、`versions.json` 同步。
- esbuild 将源码与适配器打包为根目录 `main.js`。Obsidian 只需 `main.js`、`manifest.json`、`styles.css`，不能依赖额外的本地模块。
- `wiki/.obsidian/plugins/pinakes-explorer/` 是本机运行副本；`installer/template/` 是可选完整库模板。不要直接改这些副本再反推源码。
- `tools/make_template.py` 从根目录构建产物复制 Pinakes。其他配套插件仍由完整库模板提供，不属于 Pinakes 的依赖。
- `raw/` 是只读来源。个人笔记、PDF、调研、想法与日志不提交；公开规范、schema、工具与空库骨架纳入版本管理。
- 项目所需的源码、工具、规范与参考文档均放在本仓库内，不依赖上一级工作区。LLM Wiki 参考原文存放于 `docs/llm-wiki.md`，README 注明作者与上游来源；原文与本项目规范分开维护。

## 工具与检查

```bash
npm ci
npm run build
npm run check
npm test
python3 -m pip install -r requirements.txt
python3 tools/lint.py --wiki-dir wiki/
```

插件变更运行构建、元数据检查、公开模板回归与三文件发行包测试。本地完整内容回归可运行 `npm run test:vault`。lint 的 error 必须为 0，warn 是已有待补内容，不允许通过编造元数据消除。测试库与真实 Obsidian 界面验证分开报告，Node 测试不能证明界面已验证。

`npm test` 还运行 `tools/test-workflows.cjs` 的固定小库故障测试，覆盖关系写入中断与补偿、导入重试、空方向归档、原生首页入口和异步表单。真实库数量断言根据当前笔记字段与目录计算，不更新固定数量去追随内容增长。

跨文件关系翻转与导入先写入插件目录下的 `operations.json`； `.bak` 保留上一份有效记录。未完成操作在首页和命令面板提供恢复入口。补偿只修改相关关系成员；撤销导入只处理本次新建且内容未改变的文件夹，人工改动和未知文件必须保留。

PDF 更新和归档也通过共享服务记录操作。PDF 先备份旧文件与笔记，保存后校验内容，失败只恢复关联属性与原文入口；其他正文不整篇覆盖。归档保留原笔记备份，并在文件夹移动后继续同步归属、索引、颜色和阅读历史，失败在首页提供继续完成入口。仅符合独立论文文件夹格式的笔记可整目录归档。

最近阅读与位置由 `src/reading-session.js` 保存到插件设置；`reading` 和 `importance` 仍只从 Markdown 获取。打开、恢复阅读不会自动改动阅读状态。阅读设置应保持本地个人数据，不写入模板或知识笔记。

`npm run dev` 只持续构建，不自动改写用户 vault。手动安装到独立测试 vault 后启用插件，验证导入、移动、关系编辑与生命周期。

## Schema、索引与关系

实体与字段的唯一真源是 `wiki/_schema/kinds.yml` 和 `fields.yml`；插件读取编译结果 `.compiled.json`。修改后运行：

```bash
python3 tools/pinakes.py schema --apply
```

修改论文 frontmatter 的 `title`、`tags`、`table_summary` 或年份后重建方向索引：

```bash
python3 tools/research_wiki.py rebuild-index wiki/ --apply
```

`rebuild-index`、`scaffold`、`resync`、链接修复与批量关系工具默认预览，确认范围后使用 `--apply`。year/slug 改动通过 `resync` 同步文件名与链接。路径与 PDF 引用大小写必须和磁盘一致。

标签取自 `tools/tag_vocabulary.yml`。关系语义来自 `tools/relation_vocabulary.yml`；新增关系需同步 schema 与 `src/main.js` 中的 `REL_KEYS`、`REL_META`，编译并测试。当前四类为 `extends`、`uses`、`competes`、`contradicts`；不能手写派生反向边。旧的 `sync-relations` 仅服务已停用的图谱插件。

## 模板与发布

修改插件、schema 或模板配置后，可选完整库包按以下顺序生成：

```bash
npm run build
python3 tools/make_template.py
python3 tools/make_installer.py
```

模板生成会重建 `installer/template/`，先备份、检查 diff，避免夹带个人状态或无关第三方更新。完整库安装器不能替代标准插件附件。

标准插件 tag 与 manifest 版本完全相同，不带 `v`。tag 工作流只创建草稿 Release；发布和社区登记按 [发布规范](releasing.md) 执行。没有通过社区审核前，不宣称已上架。许可证尚待作者确定，不擅自新增授权条款。

## 变更边界

对插件核心图谱、详情卡或知识库格式的行为调整，先阅读相关测试和实体模型。保持同一节点从树、卡片、面包屑与画布进入时的子图语义一致；frontmatter 是状态与关系的共享真源，避免维护第二份状态。

删除、批量重命名或模板重建前，确认有当前版本的可恢复备份。不要改写 `raw/` 或覆盖用户笔记。完成时说明改动、验证结果和未完成的真实界面验证。
