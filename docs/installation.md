# 可选：完整研究库安装器

如果只需要 Pinakes 插件，请使用 [插件安装说明](../README.md#安装)。`installer/` 提供带看板、模板、schema 和配套第三方插件的完整研究库，适合从零建立独立 vault。

## 安装到新目录

1. 安装 [Obsidian](https://obsidian.md)。
2. 在完整库发行包中运行 `install.command`（macOS）或 `install.bat`（Windows）；命令行也可运行 `./install.sh [目标目录]`。
3. 打开创建的 vault，检查随包插件，并在 Obsidian 中确认信任与启用。

请使用新目录，避免把整库配置覆盖到正在使用的 vault。已有库仅更新 Pinakes 时，替换其插件目录的三个标准文件即可，不需要重新运行完整库安装器。

`installer/template/` 是生成的空库模板，包含 Pinakes 的构建产物及其他配套插件。它不含作者的论文笔记、PDF 或调研正文。第三方插件由各自作者维护，不是 Pinakes 的运行依赖。

当前内置 Pinakes 与 8 个配套插件，完整库要求 Obsidian **1.13.3 或以上桌面版**。其中看板依赖 Dataview，论文模板依赖 Templater；各插件的用途、随包版本与来源见 [配套插件清单](plugins.md)。

## 维护者打包

```bash
npm ci
npm run build
python3 tools/make_template.py
python3 tools/make_installer.py
```

输出为 `dist/Pinakes-Installer.zip`。这份 ZIP 是可选完整库附件，不替代 Obsidian 自动安装所需的独立插件附件。版本与发布流程见 [发布规范](releasing.md)。
