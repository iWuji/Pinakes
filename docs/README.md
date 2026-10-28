# 项目文档

Pinakes 的说明、规范与参考原文统一放在本目录，每份文档只维护一份正文。以下命令示例均从仓库根目录执行。

## 安装与使用

| 文档 | 内容 |
| --- | --- |
| [使用指南](guide.md) | 导入、归档、阅读、属性与关系编辑 |
| [完整库安装](installation.md) | 可选安装器、配套插件与空库模板 |
| [配套插件与依赖](plugins.md) | 随包清单、版本要求、看板与模板的依赖关系 |

独立插件的安装、更新和卸载见 [中文项目首页](../README.md#安装) 或 [English README](../README.en.md#installation)。

## 知识库规范

| 文档 | 内容 |
| --- | --- |
| [知识库约定](wiki-conventions.md) | 目录、frontmatter、标签、关系、论文阅读与写作流程 |
| [实体模型](entity-model.md) | schema、层级、属性与资源边界 |
| [工具手册](tools.md) | 搜索、录入、索引重建、校验与批量维护 |

## 开发与维护

| 文档 | 内容 |
| --- | --- |
| [开发指南](development.md) | 源码结构、构建、测试与本地试用 |
| [维护约定](maintenance.md) | 源码与数据真源、变更边界及检查要求 |
| [发布规范](releasing.md) | 版本、标准附件、Release 与社区审核 |

## 参考原文

[LLM Wiki](llm-wiki.md) 是 Andrej Karpathy 的英文原文副本，[上游来源](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。Pinakes 参考其组织理念，具体执行规则以本目录的知识库约定为准。

## 文档维护

新增说明或规范放在 `docs/`，并更新本页目录。根目录 `README.md`（中文）与 `README.en.md`（英文）负责项目介绍与快速开始，功能、版本要求和安装步骤需同步更新；根目录和 `wiki/` 的 `AGENTS.md` 作为 agent 自动发现入口，仅链接到相关规范。`tools/README.md` 与 `installer/README.md` 仅作目录入口，不复制手册正文。知识库笔记、看板和笔记模板保留在 vault 中。
