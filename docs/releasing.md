# 发布规范

发布形式遵循 Obsidian 的 [官方示例插件](https://github.com/obsidianmd/obsidian-sample-plugin) 与 [插件提交规范](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)。独立插件是主要发行物，完整库安装器是可选附件。

## 版本与附件

- 根目录 `manifest.json` 是插件元数据入口，ID 固定为 `pinakes-explorer`。
- `manifest.json` 与 `package.json` 的版本一致；`versions.json` 追加该版本对应的最低 Obsidian 版本，保留已有记录。
- 当前初始基线版本为 `0.0.0`。Git tag 必须与插件版本完全一致，例如 `0.0.0`，不带 `v`。后续版本从此基线递增。
- 每次发布提供同次构建的 `main.js`、`manifest.json`、`styles.css` 三个独立附件。不能只上传 ZIP，也不能要求用户另装 `adapters.js`。
- 发布附件不包含个人数据、其他第三方插件或本机配置。可选完整库包单独命名为 `Pinakes-Installer.zip`。

## 发布流程

1. 更新 manifest、package 版本与版本映射；兼容要求有变化时同时更新 `minAppVersion` 和 README。
2. 执行 `npm ci`、`npm run build`、`npm run check`、`npm test`，以及知识库 lint。
3. 在 Obsidian 桌面测试库手工验证：首次启用、已有库启用、导入 PDF、移动论文、编辑关系、停用与再次启用。Node 测试不能替代实际界面验证。
4. 提交并推送代码，创建与 manifest 相同的 tag。GitHub Actions 校验后创建包含三个标准插件附件及可选完整库安装包的 **草稿 Release**。
5. 维护者核对版本、附件与变更说明，再发布草稿。不要把未完成的草稿当作已可安装版本。

工作流会从已提交的模板打包完整库安装器，不会向 Obsidian 社区自动提交插件，也不会自动公开发布草稿。修改插件或模板后，提交前先重建模板；手动打包使用 `python3 tools/make_installer.py`。

完整库还需核对 [配套插件清单](plugins.md)：启用的插件必须都有 manifest 与入口文件，版本和最低 Obsidian 要求须与文档一致。`npm run check` 会检查随包完整性；Pinakes 的 `minAppVersion` 只描述其自身兼容性。

## 社区市场状态

当前尚未提交或通过社区市场审核。根目录元数据与标准附件属于发布基础，不代表审核通过。上架前需完成官方开发者政策与插件规范审查、确定仓库许可证，并确认第三方配套包的再分发许可。许可证由作者确定，发布前需明确授权条款。

审核应覆盖生命周期清理、API 使用、桌面限制、文件写入、外部请求和资源打开行为。通过实际验证并发布首个标准插件版本后，再按官方流程向 `obsidianmd/obsidian-releases` 提交登记；市场收录后才可在 README 提供市场安装入口。
