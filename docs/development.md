# 开发指南

Pinakes 使用 JavaScript 和 Obsidian API，esbuild 将本地模块打包成一个 CommonJS `main.js`。保持现有插件 ID `pinakes-explorer`，避免用户更新后丢失设置或出现重复插件。

## 环境与命令

需要 Node.js 22 或以上版本及 npm。Python 3 与 `requirements.txt` 仅用于知识库工具和完整校验。

```bash
npm ci
npm run build
npm run check
npm test
```

`npm run dev` 持续构建；`npm run test:vault` 在本地完整研究库上运行回归。`npm test` 使用公开空库模板并验证发布包只依靠三个标准文件即可加载，覆盖内嵌 locator 模块。

## 目录与唯一来源

| 路径 | 用途 |
| --- | --- |
| `src/main.js` | 插件入口、界面与数据层 |
| `src/adapters.js` | locator 资源适配器，构建时内嵌 |
| `src/test.js` | 数据层与知识库回归 |
| `manifest.json` | 插件标识、版本与兼容要求 |
| `styles.css` | 插件样式 |
| `versions.json` | 插件版本到最低 Obsidian 版本的映射 |
| `main.js` | 构建产物，不提交 Git；发布时作为附件上传 |
| `docs/` | 用户指南、知识库规范、开发维护与参考原文 |
| `AGENTS.md`、`wiki/AGENTS.md` | agent 自动发现入口，指向 `docs/` 中的规范正文 |
| `wiki/_schema/` | 实体类型与字段定义 |
| `installer/` | 可选的完整研究库发行方案 |
| `tools/` | 构建、模板生成与可选 Python 工具 |

只编辑 `src/`、根目录 manifest 和样式。`wiki/.obsidian/plugins/pinakes-explorer/` 是本机安装副本，`installer/template/.obsidian/plugins/pinakes-explorer/` 是完整库模板中的发行副本，都不是源码入口。

## 本地试用

先构建，再将根目录的 `main.js`、`manifest.json`、`styles.css` 复制到测试 vault 的 `.obsidian/plugins/pinakes-explorer/`。重启 Obsidian 并启用插件。仅使用独立测试库，确认导入、移动、关系编辑与卸载行为后再更新日常研究库。

构建产物已包含 locator 适配器，无需额外安装 `adapters.js`、npm 包或 Python。源码仓库自身不直接作为运行中的插件目录。

## 知识库与模板变更

```bash
python3 -m pip install -r requirements.txt
python3 tools/lint.py --wiki-dir wiki/
```

schema、frontmatter、标签和关系变更遵循 [维护约定](maintenance.md) 与 [知识库约定](wiki-conventions.md)。修改插件后生成完整库模板时，先运行 `npm run build`，再运行 `python3 tools/make_template.py`；该命令从根目录发行文件复制 Pinakes，不从个人 vault 取源码。模板生成会重建 `installer/template/`，提交前检查 diff。

## 贡献

提交修改时说明触发场景、改动后的行为和验证结果。不要提交个人笔记、PDF、插件 `data.json`、Obsidian 工作区状态或依赖目录。接口或数据格式调整需说明兼容行为；涉及移动、删除或批量改名时，先保留可恢复的备份。
