# 工具手册

这些 Python 脚本负责收录论文、重建索引和检查知识库。它们直接读写 Markdown，可以在 Obsidian 关闭时使用。

以下命令从仓库根目录运行。知识库默认是 `wiki/`；使用安装器创建的知识库时，换成实际路径。

```bash
python3 -m pip install -r requirements.txt
```

## 常用命令

| 任务 | 命令 |
| --- | --- |
| 搜索论文笔记 | `python3 tools/research_wiki.py search wiki/ "关键词"` |
| 统计论文数量 | `python3 tools/research_wiki.py stats wiki/` |
| 预览索引更新 | `python3 tools/research_wiki.py rebuild-index wiki/` |
| 写入索引更新 | `python3 tools/research_wiki.py rebuild-index wiki/ --apply` |
| 检查知识库 | `python3 tools/lint.py --wiki-dir wiki/` |
| 查看库结构 | `python3 tools/pinakes.py describe --json` |
| 记录内容变更 | `python3 tools/research_wiki.py log wiki/ "变更说明"` |

`rebuild-index`、`scaffold`、`resync`、`sync-relations`、关系批量写入、链接修复和字段整理，默认只预览；加 `--apply` 才写入。`new` 和 `log` 会直接创建或修改文件，模板与安装包生成也会直接写入输出目录。

## 收录论文

先搜索标题或缩写，确认库中没有同一篇论文。主方向未定时，用已有的 `_unfiled` 分区：

```bash
python3 tools/research_wiki.py new wiki/ \
  --direction _unfiled \
  --year 2026 \
  --slug my-paper \
  --pdf /path/to/paper.pdf \
  --paper-title "English Original Title" \
  --authors "Author A, Author B" \
  --tags "semantic-id, codebook" \
  --summary "用分层语义编码表示物品，并通过自回归解码完成检索。"
```

方向文件夹及其索引笔记需要已存在。脚本会创建 `【2026】my-paper/`，把 PDF 复制为 `【2026】my-paper.pdf`，并生成同名笔记。已有论文文件夹不会被覆盖。

`--paper-title` 用来生成 `title`，不会额外写入一个原题字段。需要前置论文缩写时，另传 `--title "ACRO: English Original Title"`。机构用 `--org` 指定。

可以省略 `--pdf` 先建笔记；此时 `pdf` 字段为空，校验会报告缺少原文。补齐 PDF 和元数据后再验收。`new` 不更新方向索引，完成正文后运行：

```bash
python3 tools/research_wiki.py rebuild-index wiki/ --apply
python3 tools/lint.py --wiki-dir wiki/
```

字段与写作约定见 [知识库约定](wiki-conventions.md)。

## 索引与目录

方向索引中 `## 论文` 上方的简介由人维护，下方的四列表格从笔记属性生成。修改标题、年份、标签或 `table_summary` 后重建索引：

```bash
python3 tools/research_wiki.py rebuild-index wiki/
python3 tools/research_wiki.py rebuild-index wiki/ --apply
```

只更新一个方向，可以追加 `--direction "方向文件夹名"`。脚本仍会先检查全库方向骨架与配色。

`scaffold` 给 `papers/` 中已有的方向文件夹补索引笔记；在 `.obsidian/graph.json` 已存在时，也会补缺少的配色组。`rebuild-index` 已包含这一步，通常无需另跑：

```bash
python3 tools/research_wiki.py scaffold wiki/
```

在 Obsidian 中移动论文，使用 Pinakes 的拖放或右键菜单。命令行的 `resync` 用于改过 `year`、`slug` 后同步名称和链接：

```bash
python3 tools/research_wiki.py resync wiki/
```

先看预览，再决定是否加 `--apply`。批量改名涉及笔记、附件和全库引用，操作前保留可恢复的副本。

## 校验

```bash
python3 tools/lint.py --wiki-dir wiki/
python3 tools/lint.py --wiki-dir wiki/ --json
python3 tools/lint.py --wiki-dir wiki/ --all
python3 tools/lint.py --wiki-dir wiki/ --strict
```

| 级别 | 常见问题 | 退出状态 |
| --- | --- | --- |
| `error` | YAML 无法解析、文件名与字段不一致、PDF 不存在、关系目标错误、索引或 schema 过期 | 1 |
| `warn` | 元数据待补、标签数量不合适、失效的普通相对链接、疑似未格式化公式 | 默认不影响退出状态；`--strict` 下为 1 |

`--all` 展开每条问题，`--json` 输出完整清单。正文的章节名称和数量不参与校验。普通链接与 PDF 引用还会核对磁盘上的实际大小写。

图谱的数据层另有一套 Node 测试，覆盖解析、层级、关系、字段修改和索引格式：

```bash
npm run test:vault
```

脚本只读传入的知识库。完整库会运行内容断言；公开骨架库自动跳过这些断言，仍检查 schema 与纯函数行为。

## 批量整理

### 写入关系

`apply_relations.py` 接收已核对的 JSON 数组。每条记录对应一篇笔记，关系目标用文件名去掉 `.md` 后的名称：

```json
[
  {
    "file": "papers/example/【2026】my-paper/【2026】my-paper.md",
    "uses": ["【2023】reference-paper"],
    "evidence": "方法部分说明复用了该工作的编码模块。"
  }
]
```

```bash
python3 tools/apply_relations.py \
  --wiki-dir wiki/ --records /path/to/relations-approved.json
```

脚本先校验整批记录，检查目标、字段、自链和重复项，再准备写入。记录中出现的关系字段会整体替换，空数组删除该字段；未出现的关系字段保留。`evidence` 供人工核对，不会写进笔记，脚本也不会验证证据是否成立。

确认预览后加 `--apply`，写入完成再跑 `lint`。关系定义见 [relation_vocabulary.yml](../tools/relation_vocabulary.yml)。

### 修复链接与整理属性

```bash
python3 tools/fix_dangling_links.py --wiki-dir wiki/
python3 tools/normalize_frontmatter.py --wiki-dir wiki/
```

前者按笔记文件名找回失效的 Markdown 相对链接；同名目标有多个时跳过。后者重排论文属性，保留列表写法与正文。两者默认只预览。

`backfill_arxiv.py` 是辅助回填脚本，读取固定的 `/tmp/arxiv_lookup.json`，按标题匹配已有查询结果。它不负责联网检索，也不是日常收录入口。

## Schema 与词表

实体类型和字段定义在 `wiki/_schema/`。修改 YAML 后重新编译，插件读取 `.compiled.json`：

```bash
python3 tools/pinakes.py schema
python3 tools/pinakes.py schema --apply
python3 tools/pinakes.py schema --json
python3 tools/pinakes.py describe --json
```

另一个知识库需要把 `--wiki-dir` 放在子命令前：

```bash
python3 tools/pinakes.py --wiki-dir /path/to/vault describe --json
```

标签与关系词表仍放在本目录。新增标签写入 `tag_vocabulary.yml`；修改关系类型时，同步 `relation_vocabulary.yml`、`wiki/_schema/fields.yml` 和插件的 `REL_KEYS`、`REL_META`，再编译 schema、运行测试。

`sync-relations` 只服务旧的 Breadcrumbs 与 Extended Graph 配置。当前 Pinakes 图谱不读取这些配置，日常无需运行这个命令。实体模型的实现范围见 [实体模型](entity-model.md)。

## 生成模板与安装包

```bash
npm ci
npm run build
python3 tools/make_template.py --wiki-dir wiki/ --out installer/template/
python3 tools/make_installer.py --repo . --out dist/
```

`make_template.py` 重建输出目录，写入预设的空库骨架，复制 schema、看板、Templater 模板和配套插件。Pinakes 从根目录的三个标准构建文件复制，源码位于 `src/`；必须先构建。论文笔记与专题正文不复制到模板中；骨架正文定义在脚本中，修改 `wiki/` 的首页不会改动这份正文。

`make_installer.py` 将安装脚本和 `installer/template/` 打包为 `dist/Pinakes-Installer.zip`，并在包内保留安装脚本的执行权限。它不重新生成模板，也不包含 Python 工具或项目说明。修改插件或模板后，按上面的顺序运行两条命令。
