#!/usr/bin/env python3
"""打包 Pinakes 图形化安装包 → dist/Pinakes-Installer.zip。

包内布局(解压后任意位置双击 install.command / install.bat 即可):
  install.command / install.bat / install.sh / INSTALL.txt
  payload/template/            ← 空库 + 全部插件(安装器复制的就是它)

安装包**不含** wiki/ tools/ 等项目源(新用户不需要);Release 包里安装器读
payload/template,在仓库 installer/ 里直接双击时退回同级 template/。

用法: python3 tools/make_installer.py [--out dist/]
发布: 把 dist/Pinakes-Installer.zip 传到 GitHub Releases。
"""

from __future__ import annotations

import argparse
import shutil
import zipfile
from pathlib import Path

INSTALLERS = ["install.command", "install.bat", "install.sh"]


def note_text() -> str:
    return """Pinakes 安装说明
================

macOS:双击 install.command(若被拦:右键 → 打开 → 打开)
Windows:双击 install.bat
命令行:./install.sh [目标目录]

安装器会把论文知识库(含全部 Obsidian 插件)复制到你选的位置(默认 ~/Pinakes),
并自动唤起 Obsidian。在弹出的对话框里点「Trust author and enable plugins」,
首次启动会出现欢迎页 —— 点「新建第一篇论文」即可开始。

完整库需要 Obsidian 1.13.3 或以上桌面版(macOS / Windows / Linux)。
没有安装 Obsidian?先去 https://obsidian.md 下载(免费)。

随包提供 Pinakes 与 8 个配套插件:
Dataview、Templater、QuickAdd、PDF++、Omnisearch、Front Matter Title、
Advanced Tables、Latex Suite。
其中看板依赖 Dataview,论文笔记模板依赖 Templater,其余按需启用。
仅安装 Pinakes 插件本身不要求这些配套插件。
完整清单与来源:https://github.com/iWuji/Pinakes/blob/main/docs/plugins.md

可选:命令行工具链需要 Python + `pip install pyyaml`。
"""


def make_installer(repo: Path, out_dir: Path) -> Path:
    template = repo / "installer" / "template"
    if not template.is_dir():
        raise SystemExit("installer/template/ 不存在:先跑 tools/make_template.py")

    stage = out_dir / "_stage"
    if stage.exists():
        shutil.rmtree(stage)
    (stage / "payload").mkdir(parents=True)
    for f in INSTALLERS:
        shutil.copy2(repo / "installer" / f, stage / f)
    shutil.copytree(template, stage / "payload" / "template")
    (stage / "INSTALL.txt").write_text(note_text(), encoding="utf-8")

    # 可执行位进 zip(zipfile 不存权限,macOS/Linux 解压后丢执行位 —— 用 external_attr 补)
    out = out_dir / "Pinakes-Installer.zip"
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(stage.rglob("*")):
            if p.is_dir():
                continue
            rel = p.relative_to(stage)
            zi = zipfile.ZipInfo.from_file(p, str(rel))
            # 0755 for installers, 0644 otherwise
            mode = 0o755 if p.name in INSTALLERS else 0o644
            zi.external_attr = (0o100000 | mode) << 16
            zf.writestr(zi, p.read_bytes())
    shutil.rmtree(stage)

    size_mb = out.stat().st_size / 1024 / 1024
    print(f"[make_installer] {out}({size_mb:.1f} MB)")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=".", help="Pinakes 仓库根")
    ap.add_argument("--out", default="dist", help="输出目录")
    args = ap.parse_args()
    make_installer(Path(args.repo).resolve(), Path(args.out).resolve())


if __name__ == "__main__":
    main()
