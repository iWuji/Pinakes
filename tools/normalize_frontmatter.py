#!/usr/bin/env python3
"""normalize_frontmatter.py — 把 papers/ 下所有论文笔记的 frontmatter 规范成统一字段顺序。

标准顺序（wiki/AGENTS.md §3）:
  importance, reading, direction, title, slug, year, pdf, tags, table_summary,
  authors, organization, arxiv, venue, doc_type, <关系字段 extends/uses/competes/contradicts>,
  <其余未识别字段按字母序垫底>

行为:
  - 字段重排为标准顺序;缺 importance/reading 的补默认值(1 / 未读)。
  - 列表字段**保留原写法**(内联/块列表都合法,Obsidian 属性面板改写出的块列表不动)。
  - 关系字段(词表 4 类)排在元数据之后;未知字段垫底并 stderr 提醒。
  - 正文零改动;YAML round-trip 断言(重排前后 safe_load 结果必须相等)。
  - 默认 dry-run 列出将改动的文件,--apply 才写入。

用法:
  python3 tools/normalize_frontmatter.py --wiki-dir wiki/ [--apply]
"""
import argparse
import re
import sys
from pathlib import Path

import yaml

ORDER = [
    "importance", "reading", "direction", "title", "slug", "year", "pdf",
    "tags", "table_summary", "authors", "organization", "arxiv", "venue", "doc_type",
    "extends", "uses", "competes", "contradicts",
]
DEFAULTS = {"importance": "1", "reading": "未读"}
REL_FIELDS = {"extends", "uses", "competes", "contradicts"}
REP_RE = re.compile(r"【(索引|Deep Research|调研|idea)】")


def split_fm(text: str):
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return None, text
    return m.group(1), text[m.end():]


def parse_entries(fm_text: str):
    """按顶层键切分 frontmatter,保留每个键的原始文本(含块列表续行)。"""
    lines = fm_text.split("\n")
    entries, cur_key, cur_lines = [], None, []
    for ln in lines:
        km = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):", ln)
        if km:
            if cur_key is not None:
                entries.append((cur_key, "\n".join(cur_lines).rstrip()))
            cur_key, cur_lines = km.group(1), [ln]
        elif cur_key is not None:
            cur_lines.append(ln)
    if cur_key is not None:
        entries.append((cur_key, "\n".join(cur_lines).rstrip()))
    return entries


def rank(key: str) -> int:
    if key in ORDER:
        return ORDER.index(key)
    if key in REL_FIELDS:  # 词表更新后新增的关系字段仍排关系区
        return len(ORDER) - REL_FIELDS.__len__() + list(REL_FIELDS).index(key)
    return 999


def normalize(fm_text: str, path: Path, warnings: list):
    entries = parse_entries(fm_text)
    keys = [k for k, _ in entries]
    if not keys:
        return fm_text, False
    data = yaml.safe_load(fm_text) or {}

    # 缺默认补齐
    missing = {k: v for k, v in DEFAULTS.items() if k not in keys}
    if missing:
        for k, v in missing.items():
            entries.insert(0 if k == "importance" else 1, (k, f"{k}: {v}"))
            data[k] = int(v) if v.isdigit() else v
            warnings.append(f"  + 补 {k}: {v}")

    seen, out, unknown = set(), [], []
    for k, raw in sorted(entries, key=lambda kv: (rank(kv[0]), kv[0])):
        if k in seen:
            warnings.append(f"  ! 重复字段 {k}(保留首个,其余丢弃)")
            continue
        seen.add(k)
        if k not in ORDER and k not in REL_FIELDS:
            unknown.append(k)
        out.append(raw)

    if unknown:
        warnings.append(f"  ? 规范外字段垫底: {', '.join(sorted(unknown))}")

    # round-trip 断言:重排(+补默认)后语义必须一致
    new_data = yaml.safe_load("\n".join(out)) or {}
    for k, v in missing.items():
        new_data.pop(k, None)
    if new_data != data:
        raise AssertionError(f"YAML round-trip 不一致: {path}")

    # 文本无实际变化(顺序已标准且无补默认)时不算改动
    if "\n".join(out) == fm_text.rstrip() and not missing:
        return fm_text, False

    return "\n".join(out), True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wiki-dir", required=True)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    changed = skipped = failed = 0
    for p in sorted((Path(args.wiki_dir) / "papers").rglob("*.md")):
        if REP_RE.search(p.name) or p.name.startswith("【索引】"):
            continue
        text = p.read_text()
        fm_text, body = split_fm(text)
        if fm_text is None:
            print(f"[skip] 无 frontmatter: {p}")
            skipped += 1
            continue
        warnings = []
        try:
            new_fm, did = normalize(fm_text, p, warnings)
        except AssertionError as e:
            print(f"[FAIL] {p}\n  {e}")
            failed += 1
            continue
        if not did:
            continue
        changed += 1
        print(f"[norm] {p}")
        for w in warnings:
            print(w)
        if args.apply:
            p.write_text(f"---\n{new_fm}\n---\n{body}")

    mode = "APPLIED" if args.apply else "DRY-RUN"
    print(f"\n{mode}: {changed} to normalize, {skipped} skipped, {failed} failed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
