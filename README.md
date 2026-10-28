<div align="center">

**简体中文 · [English](README.en.md)**

<img src="docs/pinakes-cover.svg" alt="Pinakes — Where thought grows together. 人与 AI 在同一页上共同思考的概念插画" width="100%">

# Pinakes

### 让思想，在你与 AI 之间生长。

人读得懂，AI 接得上。<br>
一起读论文、改笔记、连接想法，让个人知识库承接你们每一次思考。

[![Obsidian Desktop](https://img.shields.io/badge/Obsidian-Desktop-705A92?style=flat-square&logo=obsidian&logoColor=white)](https://obsidian.md)
[![Release](https://img.shields.io/github/v/release/iWuji/Pinakes?style=flat-square&color=577662)](https://github.com/iWuji/Pinakes/releases)
[![Markdown](https://img.shields.io/badge/Storage-Markdown-B28763?style=flat-square)](#数据与网络)

**[开始使用](#开始使用) · [下载安装](#安装) · [使用指南](docs/guide.md) · [项目文档](docs/README.md)**

</div>

<br>

**Pinakes 是面向论文研究的 Obsidian 桌面插件，也是人与 AI 共用的个人研究知识库。** 论文原文、研究笔记、论文关系和你的想法，保存在本地文件中：你在 Obsidian 里阅读和编辑，AI agent 按相同的规范整理和维护。

**论文 Wiki 的组织形式参考 Andrej Karpathy 的 [LLM Wiki](docs/llm-wiki.md)**（[上游原文](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)）。Pinakes 延续其由原始资料持续积累相互链接笔记的思路，并为论文研究补上可视化浏览、直接编辑和明确的协作约定。参考原文完整收录在本仓库。

## 实际界面

![Pinakes 连续操作演示：整库浏览、论文聚焦、关系探索与跨方向导航](docs/pinakes-demo.gif)

从整库进入一篇论文，沿着关系继续探索，再回到研究方向。动图由实际使用的本地研究库录屏剪辑而成；示例论文与研究内容不随安装包分发。

**[观看清晰视频](docs/pinakes-demo.mp4) · [演示说明](docs/demo.md)**

## 把 AI 整理的知识，变成你能继续思考的地方

AI 可以很快整理一篇论文。更值得留下的，是你读完之后划下的重点、提出的疑问，以及它与你正在研究的问题之间的联系。

在 Pinakes 中，你可以沿着方向树找到论文，在关系图里看清它借用了谁、改进了什么；打开笔记，核对原文、改写解释、加入自己的判断。下一次让 AI 继续工作时，这些修改与想法也留在同一份知识库里，成为它需要阅读的上下文。

| 你来理解与判断 | AI 来整理与连接 | 知识留在你手中 |
| --- | --- | --- |
| 阅读原文、修正解释、写下疑问和新想法 | 按规范查重、写笔记、补充有依据的关系、维护索引 | Markdown 笔记与本地 PDF，可直接编辑，也便于备份和迁移 |

**图谱让你看见联系，笔记让你读懂联系，编辑让这些联系融入自己的思考。**

## 从论文，到你的想法

- **收进来**：用「添加论文」导入 PDF，尝试提取元数据并生成笔记骨架；原文件保留，也可以先建笔记再补 PDF。
- **读明白**：把原文与笔记放在一起阅读，记录关键机制、公式、实验与局限。公式、图片与 Mermaid 流程图由 Obsidian 原生显示。
- **连起来**：按研究方向浏览目录树，在图上查看和编辑论文之间的改进、复用、竞争与结论分歧。
- **留下判断**：直接修改正文、阅读状态、重要度和标签，把自己的批注延伸为专题调研、研究想法与实验计划。
- **接着研究**：让 AI 阅读已有笔记与自己的想法，在保留原文依据和人工判断的前提下继续整理。

你和 AI 读写的是同一份笔记。正文可以直接修改，属性与关系也能在界面中编辑，修改会保存回 Markdown。

## 开始使用

1. [安装 Pinakes](#安装)，在 Obsidian 中打开一个新的知识库（vault）并启用插件。
2. 在命令面板搜索「打开关系图谱」，点击顶栏 **「添加论文」**，选择一份 PDF。
3. 核对提取的信息并保存。论文默认进入「待归档」，确定研究方向后，将树中的论文拖入相应方向。
4. 打开笔记阅读、修改和写下想法；需要 AI 帮忙时，使用下方的协作入口。

空库首次打开图谱时会创建研究总览、论文库入口与待归档分区。已有笔记的库请先看 [使用指南](docs/guide.md)，按约定配置结构；插件不会自动重组你的已有笔记。

### 给 AI 一句话

在本项目的源码工作区中，让有文件读写与 PDF 阅读能力的 agent 读取 `AGENTS.md`，之后可以直接说：

```text
ingest /path/to/paper.pdf
```

也可以提供论文标题或 arXiv 链接。按 [录入约定](docs/wiki-conventions.md#7-录入流程)，agent 应先查重、读取全文，再补全笔记、元数据与有依据的关系，最后重建索引并校验。如果论文已通过 Pinakes 导入，就补全已有笔记，保留你的修改与想法。

你还可以继续交代自己的研究重点：

> 重点看它的训练目标能否用到我的方案里，把依据、限制和我的想法分开写。

`ingest` 是给外部 agent 的任务约定，论文阅读与写作由你使用的 AI 工具完成。Pinakes 提供浏览与编辑界面、知识库规范和校验工具。首次配置及外部 vault 的用法见 [AI 协作说明](docs/guide.md#与-ai-协作)。

## 安装

支持 **macOS、Windows、Linux 的 Obsidian 桌面版**，当前未上架社区插件市场。

### 已有 Obsidian 知识库：安装插件

1. 从 [Releases](https://github.com/iWuji/Pinakes/releases) 下载同一版本的 **`main.js`、`manifest.json`、`styles.css`**。
2. 在知识库中创建 `.obsidian/plugins/pinakes-explorer/`，将三个文件放进去。
3. 重启 Obsidian，在「设置 → 第三方插件」中启用 **Pinakes**。

Pinakes 本身需要 Obsidian **1.7.0 或以上**，不依赖其他第三方插件、Python 或 AI 工具。源码试用见 [开发指南](docs/development.md)。

更新时关闭插件，替换这三个文件，再重新启用；保留 `data.json` 中的个人设置。卸载插件后，论文笔记和 PDF 仍然保留。

### 从零开始：安装完整研究库

从 Releases 下载 **`Pinakes-Installer.zip`**，解压后运行 `install.command`（macOS）或 `install.bat`（Windows）；Linux 使用 `install.sh`。用 Obsidian 打开安装后的目录，按提示确认信任并启用插件。

完整库包含空库骨架、看板、笔记模板，以及 **Pinakes + 8 个配套插件**，需要 Obsidian **1.13.3 或以上**。请安装到新目录，具体步骤见 [完整库安装说明](docs/installation.md)。

日常导入优先使用 Pinakes **「添加论文」**。QuickAdd 保留为辅助模板入口；PDF++ 增强批注与引用；Dataview 提供阅读看板。它们各有用途，按需启用即可。公式、图片和 Mermaid 的显示由 Obsidian 内置支持，完整说明见 [配套插件与依赖](docs/plugins.md)。

## 数据与网络

论文笔记、关系和阅读属性保存在知识库的 Markdown 文件中，插件设置保存在 `.obsidian/plugins/pinakes-explorer/data.json`。Pinakes 会按你的操作复制 PDF、移动论文目录、修改属性与正文链接，建议定期备份知识库。

提取 PDF 元数据时会先读取本地内容；识别到 arXiv 标识时，可能请求 arXiv API 补充元数据。外部资源通过系统默认应用打开，SSH 入口复制连接命令。Pinakes 没有遥测功能，不会上传论文正文或整个知识库。使用外部 AI 时，资料的处理方式取决于你选择的工具及其设置。

## 文档与交流

| 想了解什么 | 从这里开始 |
| --- | --- |
| 导入、阅读、分类和关系编辑 | [使用指南](docs/guide.md) |
| 安装完整库、选择辅助插件 | [安装说明](docs/installation.md) · [配套插件](docs/plugins.md) |
| 让 AI 按统一约定读论文、写笔记 | [知识库约定](docs/wiki-conventions.md) · [工具手册](docs/tools.md) |
| 构建、开发和发布 | [开发指南](docs/development.md) · [发布规范](docs/releasing.md) |
| 全部说明与参考原文 | [项目文档](docs/README.md) |

欢迎通过 [Issue](https://github.com/iWuji/Pinakes/issues) 分享问题或建议。报告问题时，请附上 Obsidian / Pinakes 版本、操作系统和复现步骤；示例中请去掉个人信息。

本仓库公开插件、工具、模板与规范，个人论文 PDF、研究笔记、专题调研和想法正文不纳入版本管理。

---

<p align="center"><sub>Pinakes · 让每一次共读，都成为下一次思考的起点。</sub></p>
