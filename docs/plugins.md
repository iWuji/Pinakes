# 配套插件与依赖

Pinakes 本身不依赖其他第三方插件。完整研究库中的看板、模板和增强功能分别使用下面的配套插件。

## 随包范围

| 安装方式 | 包含内容 |
| --- | --- |
| 三个独立插件附件：`main.js`、`manifest.json`、`styles.css` | 仅 Pinakes，需自行安装所需的配套插件 |
| `Pinakes-Installer.zip` | Pinakes + 8 个配套插件、启用配置、空库骨架、看板与模板 |
| 仓库的 `installer/template/` | 与完整库安装器对应的模板，已包含上述插件文件 |

配套插件已纳入 Git，位于 `installer/template/.obsidian/plugins/`；启用列表在 `installer/template/.obsidian/community-plugins.json`。完整库安装后，仍需在 Obsidian 中确认信任并启用第三方插件，不需要逐个下载。

## 插件清单

以下版本与最低 Obsidian 版本来自当前随库 manifest。Pinakes 的版本以根目录 `manifest.json` 为准。

| 插件与上游来源 | 随包版本 | 最低 Obsidian | 用途与依赖关系 |
| --- | --- | --- | --- |
| Pinakes（本项目） | 0.0.0 | 1.7.0 | 研究目录树、关系图、论文导入与属性编辑；不依赖下面的插件 |
| [Dataview](https://github.com/blacksmithgu/obsidian-dataview) | 0.5.68 | 0.13.11 | **看板依赖**：渲染 `_dashboards/` 中的论文表格与阅读队列 |
| [Templater](https://github.com/silentvoid13/Templater) | 2.25.1 | 1.13.0 | **模板依赖**：执行 `_templates/论文笔记.md` 中的提示、字段生成与文件整理逻辑 |
| [QuickAdd](https://github.com/chhoumann/quickadd) | 2.32.0 | 1.13.0 | 快速新建笔记；随包「新建论文笔记」配置使用上述模板，需配合 Templater。Pinakes 自带导入入口不依赖它 |
| [PDF++](https://github.com/ryotaushio/obsidian-pdf-plus) | 0.40.31 | 1.5.8 | 增强 PDF 阅读、批注和引用；Obsidian 的基本 PDF 阅读与 Pinakes 的导入不依赖它 |
| [Omnisearch](https://github.com/scambier/obsidian-omnisearch) | 1.31.0 | 1.13.3 | 增强全文搜索；可使用 Obsidian 内置搜索替代 |
| [Front Matter Title](https://github.com/snezhig/obsidian-front-matter-title) | 4.2.1 | 1.12.0 | 用 frontmatter 的标题改善文件列表、搜索等位置的显示；Pinakes 自己读取 `title` |
| [Advanced Tables](https://github.com/tgrosinger/advanced-tables-obsidian) | 0.23.2 | 1.0.0 | Markdown 表格编辑与格式整理；方向索引重建不依赖它 |
| [Latex Suite](https://github.com/artisticat1/obsidian-latex-suite) | 1.14.1 | 1.1.0 | 公式输入、片段与自动展开；数学公式渲染由 Obsidian 内置 MathJax 提供 |

因此，**当前完整库建议使用 Obsidian 1.13.3 或以上桌面版**，才能满足所有已启用插件的最低要求。Pinakes 单独安装仍只要求 1.7.0。较旧的 Obsidian 可能无法加载部分配套插件，不能把 Pinakes 的最低版本当作完整库的最低版本。

## 按功能选择

| 功能 | 实际提供者 | 停用配套插件后的情况 |
| --- | --- | --- |
| 论文目录树、关系图、跨方向关联、关系编辑 | Pinakes 自带 | 全部保留，不需要 Dataview 或其他图谱插件 |
| PDF 导入、生成论文笔记、编辑阅读状态与标签 | Pinakes 自带 | 全部保留，不需要 Templater、QuickAdd 或 PDF++ |
| 数学公式显示 | Obsidian 内置 MathJax | 仍能显示 `$...$` 行内公式与 `$$...$$` 独立公式 |
| 公式输入片段、自动展开等编辑辅助 | Latex Suite | 可以手工输入 LaTeX；已有公式的显示不受影响 |
| 笔记图片、Mermaid 流程图 | Obsidian 内置 Markdown / Mermaid | 仍能显示，不需要配套插件；与 Pinakes 的关系图是不同功能 |
| 原生全局图谱、局部图谱 | Obsidian 核心「关系图谱」 | 启用该核心功能即可使用，不需要配套插件 |
| 论文表格、阅读队列等动态看板 | Dataview | 查询块不再生成动态表格，原有笔记与 Pinakes 图谱仍可使用 |
| `_templates/论文笔记.md` 的交互模板 | Templater | 模板脚本不再执行；仍可通过 Pinakes 自带入口导入或创建论文 |
| PDF 基本阅读 / PDF 批注与引用增强 | Obsidian 内置阅读器 / PDF++ | 基本阅读保留，PDF++ 的增强操作不可用 |

公式和图片渲染发生在 Obsidian 笔记编辑器或阅读视图中；Pinakes 的关系图展示笔记节点与关联，不把笔记中的公式或图片绘制为图谱内容。

只用 Pinakes 核心功能时，安装 Pinakes 即可。阅读看板按需启用 Dataview，交互模板按需启用 Templater。其他配套插件按使用习惯选择，随安装包提供不代表必须全部启用。

Breadcrumbs、Extended Graph 和 graph-link-types 已不在当前安装包中，关系图统一由 Pinakes 提供。Sync Graph Settings 也已从项目与安装包移除；Obsidian 原生图谱功能仍可使用。

## QuickAdd：可选的模板快捷入口

日常收录论文，优先使用 **Pinakes 顶栏的「添加论文」**：选中 PDF 后即可复制原文、尝试读取元数据并生成笔记骨架。QuickAdd 保留为辅助插件，适合已经准备好论文信息、希望通过交互模板新建笔记时使用；不使用它也不影响 Pinakes。

当前只预设了一个快捷任务：**新建论文笔记**，使用 `_templates/论文笔记.md`，需同时启用 QuickAdd 和 Templater。

1. 在 Obsidian 中打开命令面板（macOS：`Cmd+P`；Windows / Linux：`Ctrl+P`）。
2. 搜索 QuickAdd，运行其选择入口，选择「新建论文笔记」。该任务已开启命令，也可直接搜索「新建论文笔记」。
3. 按提示选择已有研究方向，输入论文标题、slug、年份、PDF 文件名、标签、摘要与作者等信息。
4. 模板生成 frontmatter 和正文骨架，将笔记放入对应论文目录。PDF 文件需自行放入并核对名称；完成内容后重建方向索引。

QuickAdd 在这里是启动已有模板的快捷入口。它不会像 Pinakes「添加论文」那样选择并复制 PDF、读取 PDF 元数据或自动重建方向索引。主要使用 Pinakes 自带导入流程时，可以停用 QuickAdd。

## 维护随包插件

更新配套插件时，核对 manifest 的版本与最低 Obsidian 要求、插件文件及配套配置，重新生成模板和安装器，并更新本页清单。不要只改启用列表而遗漏插件文件。

`npm run check` 会核对模板中的插件目录、manifest、入口文件和启用列表，同时输出完整库所需的最低 Obsidian 版本。发布前还需在 Obsidian 中验证看板、模板和配套功能，检查插件文件存在不能代替功能验证。
