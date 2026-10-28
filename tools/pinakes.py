#!/usr/bin/env python3
"""Pinakes CLI：schema 编译与机器可读契约。

命令：
  python3 tools/pinakes.py schema [--apply] [--json]
      把 wiki/_schema/{kinds,fields}.yml 编译成 wiki/_schema/.compiled.json。
      默认 dry-run；--json 打印编译结果。

  python3 tools/pinakes.py describe [--json]
      AI 的契约入口：输出 kinds / fields / instances / boundaries / operations。
      插件里的「描述库结构」命令输出同一份内容（读同一份 .compiled.json）。

设计见 Pinakes/ENTITY_MODEL.md §9。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import schema as S  # noqa: E402


def frontmatter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    try:
        return yaml.safe_load(text[3:end]) or {}
    except yaml.YAMLError:
        return {}


def walk_notes(wiki: Path, compiled: dict) -> list[Path]:
    skip_dirs = (compiled.get("scan") or {}).get("skip_dirs") or []
    out = []
    for p in sorted(wiki.rglob("*.md")):
        rel = p.relative_to(wiki).as_posix()
        if any(seg in skip_dirs for seg in rel.split("/")[:-1]):
            continue
        out.append(p)
    return out


def describe(wiki: Path) -> dict:
    compiled = S.load_compiled(str(wiki))
    if compiled is None:
        compiled, _ = S.ensure_compiled(str(wiki), apply=False)
    instances = []
    boundaries = []
    unreachable = []
    for p in walk_notes(wiki, compiled):
        rel = p.relative_to(wiki).as_posix()
        kind = S.kind_of(compiled, rel)
        if not kind:
            continue
        meta = frontmatter(p)
        depth = S.depth_of(compiled, meta, kind)
        inst = {
            "path": rel,
            "kind": kind,
            "depth": depth,
            "title": meta.get("title") or p.stem,
        }
        if meta.get("locator"):
            inst["locator"] = meta["locator"]
            # 与插件 describeJSON 一致:只探测本地 file://,远程保持未探测
            if inst["locator"].startswith("file://"):
                target = inst["locator"][len("file://"):]
                if not target.lstrip("/").startswith("/") and not os.path.exists(target):
                    inst["resource_ok"] = False
                    inst["resource_error"] = "path not found"
                    unreachable.append(
                        {"path": rel, "locator": inst["locator"], "error": "path not found"})
        instances.append(inst)
        if depth != "full":
            boundaries.append(rel)
    return {
        "schema_version": compiled.get("schema_version", 1),
        "kinds": list((compiled.get("kinds") or {}).values()),
        "fields": compiled.get("fields") or [],
        "unknown": compiled.get("unknown") or {},
        "instances": instances,
        "boundaries": boundaries,
        "unreachable": unreachable,
        "operations": ["create", "update", "move", "link", "archive"],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--wiki-dir", default="wiki")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_schema = sub.add_parser("schema", help="编译 schema")
    p_schema.add_argument("--apply", action="store_true")
    p_schema.add_argument("--json", action="store_true")

    p_desc = sub.add_parser("describe", help="输出机器可读契约")
    p_desc.add_argument("--json", action="store_true")

    args = ap.parse_args()
    wiki = Path(args.wiki_dir).resolve()

    if args.cmd == "schema":
        compiled, changed = S.ensure_compiled(str(wiki), apply=args.apply)
        if args.json:
            print(json.dumps(compiled, ensure_ascii=False, indent=2))
        else:
            if changed:
                print("schema 有变更" + ("（已写入 .compiled.json）" if args.apply else "（dry-run，加 --apply 写入）"))
            else:
                print("schema 已是最新")
            print(f"  kinds: {len(compiled['kinds'])}  fields: {len(compiled['fields'])}")
        return

    if args.cmd == "describe":
        data = describe(wiki)
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return


if __name__ == "__main__":
    main()
