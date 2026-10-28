#!/usr/bin/env python3
"""从 wiki/ 生成空库模板 installer/template/ —— 新用户一键复刻的起点。

模板 = wiki/ 的**结构与配置**,不带内容(439 篇论文 + PDF 不进去):
  * 骨架笔记:模板专用空库版(根笔记 / papers 入口 / _unfiled / deep-research / ideas),
    不复制 wiki/ 里的真笔记 —— 那里面全是真实域的链接,新库里全是断链
  * .obsidian/:app 配置 + 已启用的全部插件(含 Pinakes)+ snippets + graph.json
  * _schema/:kinds.yml + fields.yml + .compiled.json(实体模型真源)
  * _templates/ + _dashboards/:Templater 模板与 Dataview 看板

用法(wiki 变了重新生成;幂等,清空 installer/template/ 后重建):
  python3 tools/make_template.py [--wiki-dir wiki/]

生成后新用户的安装:
  双击 installer/install.command(macOS)/ install.bat(Windows),或 ./installer/install.sh。
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

# ------------------------------------------------------------------
# 骨架笔记的**模板专用**内容(不是 wiki/ 的真笔记 —— 真笔记链接真实域,模板里全是断链)
# 层级链接与真库同一套:根 `## 大类别` → papers `## 大类别`+`## 待归档` → (空)。
# ------------------------------------------------------------------

ROOT_NOTE = """---
title: "【索引】研究总览"
---

我的研究笔记库。**每篇论文一份 canonical 深度笔记**——它在所属方向下 `【年份】slug/`
文件夹里,文件名与文件夹同名,PDF 与它同处一处;涉及多个方向时只链接到这份笔记、不复制正文。

库按**大类别(域)**组织:域是一张索引笔记,域下平铺各个方向(方向名带域前缀)。

> [!tip] 第一次使用
> 打开左侧栏的 **network 图标**(Pinakes 关系图谱),点顶栏「添加论文」选一个本地 PDF
> ——它会自动拷进库、读出标题/作者/摘要、生成规范笔记。没有 PDF 也能建笔记骨架。
> 命令面板里有「欢迎与功能介绍」;Python 工具链(lint / rebuild-index,依赖只有 PyYAML)
> 在仓库根的 `tools/`,用法见 `AGENTS.md`。
>
> **推荐搭配 AI agent 使用**(Codex / Claude Code 等):给 AI 的规范已写在 `AGENTS.md`
> (工具/命令)与 `wiki/AGENTS.md`(内容/frontmatter)——读 PDF、写笔记、跑 lint 校验
> 都可以交给它。人和 AI 读写的是同一套 frontmatter,两边都方便。

## 大类别

- [【索引】papers](papers/【索引】papers.md):论文库 —— 域(大类别)→ 方向 → 论文。
- [Deep Research](deep-research/【索引】深度调研专题总览.md):跨域的多论文专题调研。
- [Ideas](ideas/【索引】Ideas.md):在研的想法与研究课题(`stage` 标进度)。
"""

PAPERS_NOTE = """---
title: "【索引】papers"
---

> 论文库的入口:**域(大类别)→ 方向 → 论文**。域是索引笔记而不是文件夹:
> 域会随研究方向增删,而「一篇论文一个文件夹」的结构不该跟着抖。
> 各域的方向平铺在 `papers/` 下,名字带域前缀;跨域联系走关系边 / `sub_directions` / 正文链接。

**新开一个域**:写一篇 `papers/【索引】<域>.md`(正文用 `## 方向` 列它的方向),
再在下面的 `## 大类别` 里加一条 `[[【索引】<域>]]`。
**新开一个方向**:Pinakes 左树右键域索引 →「＋ 新建方向索引…」。

## 大类别

- (还没有域。新开一个域后这里会出现它的链接。)

## 待归档

- [[【索引】_unfiled]]
"""

UNFILED_NOTE = """---
title: "【索引】_unfiled"
---

> 待归档分区:已入库但还没定方向的论文先整篇落在这里(`direction` 指向它),
> 读完再拖到正式方向。它是 todolist,不是方向 —— 清空后也仍然存在。

## 论文

- (还没有待归档的论文)
"""

DEEP_RESEARCH_NOTE = """---
title: "【索引】深度调研专题总览"
---

围绕一个具体技术或产品问题开展的多论文深度调研。每个专题一个子目录,
主文档叫 `【Deep Research】<topic>.md`;专题只放自己写的文档,引用的论文一律在
`papers/` 里用相对链接指过去。

## 当前专题

- (还没有专题)
"""

IDEAS_NOTE = """---
title: "【索引】Ideas"
---

研究想法 / 草稿区。每个想法一个子目录(含 `【索引】<名字> 方案包.md` 作入口),
方案稿前缀 `【idea】`;进度写在 frontmatter 的 `stage`(待做/在做/已成稿/已投稿/已发表/废弃)。

## 方案包

- (还没有想法)
"""

SKELETON_NOTES = {
    "【索引】研究总览.md": ROOT_NOTE,
    "papers/【索引】papers.md": PAPERS_NOTE,
    "papers/_unfiled/【索引】_unfiled.md": UNFILED_NOTE,
    "deep-research/【索引】深度调研专题总览.md": DEEP_RESEARCH_NOTE,
    "ideas/【索引】Ideas.md": IDEAS_NOTE,
}

# .obsidian/ 里整体照搬的配置文件(个人易变状态除外)
OBSIDIAN_FILES = [
    "app.json",
    "appearance.json",
    "types.json",
    "core-plugins.json",
    "community-plugins.json",
    "graph.json",
]

COPY_DIRS = ["_templates", "_dashboards"]

PLUGIN_NAMES = [
    "pinakes-explorer",
    "dataview",
    "templater-obsidian",
    "obsidian-front-matter-title-plugin",
    "pdf-plus",
    "quickadd",
    "omnisearch",
    "table-editor-obsidian",
    "obsidian-latex-suite",   # 公式输入加速(渲染是 Obsidian 内置 MathJax,不依赖它)
]

# 可选插件:wiki/ 里还没有时,从 GitHub Release 拉一份(有网才拉,失败不阻塞 —— 插件是可选的)
OPTIONAL_FETCH = [
    {
        "plugin": "obsidian-latex-suite",
        "repo": "artisticat1/obsidian-latex-suite",
        "files": ["main.js", "manifest.json", "styles.css"],
    },
]

PROXY = "http://127.0.0.1:17891"   # 本机沙盒出网走本地代理;无代理环境留空则直连


def fetch_optional_plugins(wiki: Path) -> None:
    """把 OPTIONAL_FETCH 里 wiki/ 还没有的插件拉到 wiki 的插件目录(给 make_template 复制用)。"""
    import urllib.request
    if PROXY:
        urllib.request.install_opener(urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})))
    for spec in OPTIONAL_FETCH:
        dest = wiki / ".obsidian" / "plugins" / spec["plugin"]
        if (dest / "main.js").exists():
            continue
        try:
            api = f"https://api.github.com/repos/{spec['repo']}/releases/latest"
            req = urllib.request.Request(api, headers={"User-Agent": "pinakes-make-template"})
            with urllib.request.urlopen(req, timeout=15) as r:
                release = json.loads(r.read())
            tag = release["tag_name"]
            base = f"https://github.com/{spec['repo']}/releases/download/{tag}"
            dest.mkdir(parents=True, exist_ok=True)
            for f in spec["files"]:
                urllib.request.urlretrieve(f"{base}/{f}", dest / f)
            print(f"[make_template] 已下载可选插件 {spec['plugin']} {tag}")
        except Exception as e:   # 没网/代理不通:跳过,模板少一个可选插件也能用
            print(f"[make_template] 跳过可选插件 {spec['plugin']}({e})")


def pinakes_data_defaults(plugin_dir: Path) -> dict | None:
    """pinakes-explorer 的 data.json:保留 rootNote/轴词表,清掉个人状态。"""
    src = plugin_dir / "pinakes-explorer" / "data.json"
    try:
        data = json.loads(src.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return {
        "rootNote": data.get("rootNote", "【索引】研究总览.md"),
        "readingStates": data.get("readingStates", []),
        "tagColors": data.get("tagColors", {}),
        "nodeColors": {},       # 个人配色不进模板
        "welcomed": False,      # 新用户第一次打开要看到欢迎页
    }


def make_template(wiki: Path, out: Path) -> None:
    # Pinakes is built from repository source, never from a personal vault copy.
    repo = Path(__file__).resolve().parent.parent
    plugin_files = ("main.js", "manifest.json", "styles.css")
    for name in plugin_files:
        if not (repo / name).is_file():
            raise FileNotFoundError(f"Missing {name}: run npm ci && npm run build first")
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    # 0) 可选插件(Latex Suite 等):wiki 里没有且有网就先拉,保证模板一键齐全
    fetch_optional_plugins(wiki)

    # 1) 骨架笔记(模板专用内容,不是 wiki/ 的真笔记)
    for rel, text in SKELETON_NOTES.items():
        target = out / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    # 2) _schema(实体模型真源,连编译产物一起)
    shutil.copytree(wiki / "_schema", out / "_schema")

    # 3) _templates / _dashboards
    for d in COPY_DIRS:
        if (wiki / d).exists():
            shutil.copytree(wiki / d, out / d)

    # 4) .obsidian:配置文件 + snippets + 插件
    obs = wiki / ".obsidian"
    t_obs = out / ".obsidian"
    t_obs.mkdir()
    for f in OBSIDIAN_FILES:
        if (obs / f).exists():
            shutil.copy2(obs / f, t_obs / f)
    if (obs / "snippets").exists():
        shutil.copytree(obs / "snippets", t_obs / "snippets")
    t_plugins = t_obs / "plugins"
    t_plugins.mkdir()
    for p in PLUGIN_NAMES:
        if p == "pinakes-explorer":
            target = t_plugins / p
            target.mkdir()
            for name in plugin_files:
                shutil.copy2(repo / name, target / name)
            continue
        src = obs / "plugins" / p
        if not src.exists():
            print(f"[make_template] 跳过缺失插件 {p}")
            continue
        shutil.copytree(src, t_plugins / p)

    # 发行版只启用明确列入打包清单的插件，不继承个人 vault 的额外启用项。
    (t_obs / "community-plugins.json").write_text(
        json.dumps(PLUGIN_NAMES, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    # pinakes-explorer 的 data.json 重置成新用户态
    defaults = pinakes_data_defaults(obs / "plugins")
    if defaults is not None:
        (t_plugins / "pinakes-explorer" / "data.json").write_text(
            json.dumps(defaults, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    # 6) 重建 _unfiled 的索引段落(lint 的 index-stale 要 0 error)
    import subprocess
    import sys
    script = Path(__file__).resolve().parent / "research_wiki.py"
    subprocess.run([sys.executable, str(script), "rebuild-index", str(out), "--apply"],
                   check=False, capture_output=True)

    n_notes = sum(1 for _ in out.rglob("*.md"))
    n_plugins = len([p for p in t_plugins.iterdir() if p.is_dir()])
    print(f"[make_template] 已生成 {out}(骨架笔记 {n_notes} 篇,插件 {n_plugins} 个)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--wiki-dir", default="wiki")
    ap.add_argument("--out", default="installer/template")
    args = ap.parse_args()
    make_template(Path(args.wiki_dir).resolve(), Path(args.out).resolve())


if __name__ == "__main__":
    main()
