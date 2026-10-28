#!/usr/bin/env python3
"""修复指向不存在目标的相对链接:按 basename 在全库找回,改写成正确的相对路径。

笔记在库里搬过位置之后,markdown 相对链接会断(Obsidian 的 [[wikilink]] 不受影响,
它按 basename 解析)。lint 会把这些报成 broken-link;本脚本读 lint 的口径**自己重算**,
不依赖 lint 的 JSON:

  * 收集全库笔记的 basename → 路径映射(basename 唯一,lint 的命名规范保障);
  * 逐个 markdown 链接,拿「目标 basename」在映射里找;找到且当前相对路径解析不到 →
    改写成从所在目录出发的正确相对路径。

只动 `](…)` 形式的链接,不碰正文其它内容;幂等。默认 dry-run,--apply 才写入。
"""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path

# Obsidian 对含空格/【】的路径会写成 ](<path>)。两种写法都要认 ——
# 而且**尖括号里是可以有空格**的(【Deep Research】这类名字空间就在文件名里),
# 早先的 `[^)>\s]+?` 把这类链接整条跳过,于是"改了却什么都不变,静默失效"。
LINK_RE = re.compile(
    r"\]\((?:<(?P<angle>[^>]*?\.md)(?P<a1>#[^>]*)?>|(?P<plain>[^)\s]*?\.md)(?P<a2>#[^)]*)?)\)"
)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--wiki-dir", default="wiki")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    wiki = Path(args.wiki_dir).resolve()

    # basename → 路径
    by_name: dict[str, Path] = {}
    dup = set()
    for md in wiki.rglob("*.md"):
        if ".obsidian" in md.parts:
            continue
        if md.stem in by_name:
            dup.add(md.stem)
        by_name[md.stem] = md
    if dup:
        print(f"[warn] basename 重复(这些不会被动):{', '.join(sorted(dup))}")

    total = 0
    for md in sorted(wiki.rglob("*.md")):
        if ".obsidian" in md.parts:
            continue
        text = orig = md.read_text(encoding="utf-8")
        for m in list(LINK_RE.finditer(orig)):
            angled = m.group("angle")
            target = angled if angled is not None else m.group("plain")
            anchor = (m.group("a1") or m.group("a2") or "") if angled is not None \
                else (m.group("a2") or "")
            if "://" in target:
                continue
            resolved = (md.parent / target).resolve()
            if resolved.exists():
                continue
            stem = Path(target).stem
            if stem not in by_name or stem in dup:
                continue
            new_rel = os.path.relpath(by_name[stem], md.parent).replace(os.sep, "/")
            # 路径里有空格就必须用 ](<...>) 写法(Obsidian 的规则);原来就是尖括号的保持尖括号。
            if angled is not None or " " in new_rel:
                replacement = f"](<{new_rel}{anchor}>)"
            else:
                replacement = f"]({new_rel}{anchor})"
            text = text.replace(m.group(0), replacement)
            total += 1
            print(f"[{md.relative_to(wiki)}]")
            print(f"    {target}  →  {new_rel}")
        if text != orig and args.apply:
            md.write_text(text, encoding="utf-8")

    print(f"\n{total} 条待修。" + ("已写入。" if args.apply else "Dry-run:加 --apply 写入。"))
    if args.apply and total:
        print("接着跑 python3 tools/lint.py --wiki-dir wiki/ 确认 broken-link 归零。")


if __name__ == "__main__":
    main()
