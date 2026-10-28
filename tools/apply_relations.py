#!/usr/bin/env python3
"""Write reviewed typed relations into paper frontmatter (wiki/AGENTS.md §3.1).

Candidates come from a generative extraction pass, so this validates the whole
batch before touching a single file — a malformed record otherwise corrupts a
note's YAML block, and 131 notes is too many to repair by hand:

  * the note must exist and be a paper note (folder name == file stem)
  * the relation field must be in tools/relation_vocabulary.yml
  * no derived inverse may be authored (`extended-by` / `used-by` / `covered-by`)
  * every target must be an existing paper note, and not the source itself
  * no duplicate targets within one field

Relations go in after the last structural field, in vocabulary order. Existing
relation fields are replaced wholesale, so re-running with a corrected review file
converges instead of accumulating. Any relation field NOT present in the records is
left alone — this is additive per field, never a global wipe.

Input is the approved subset: same shape as the extraction output, but only the
rows that survived review. Dry-run unless --apply.
"""

from __future__ import annotations

import argparse
import glob
import json
import re
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from research_wiki import relation_vocabulary  # noqa: E402  (local helper module)

FRONTMATTER_RE = re.compile(r"^(---\s*\n)(.*?\n)(---\s*\n)", re.DOTALL)
FIELD_RE = re.compile(r"^([\w-]+):", re.MULTILINE)
# insert relations after the metadata block, before nothing else matters
AFTER = {"title", "slug", "year", "pdf", "tags", "table_summary",
         "authors", "organization", "arxiv", "venue", "reading", "importance"}

RELATIONS = relation_vocabulary()
INVERSES = {spec["inverse"] for spec in RELATIONS.values()} - set(RELATIONS)


def load_records(pattern: str) -> list[dict]:
    records: list[dict] = []
    for path in sorted(glob.glob(pattern)):
        records += json.loads(Path(path).read_text(encoding="utf-8"))
    return records


def paper_notes(wiki: Path) -> dict[str, Path]:
    """stem -> note path, for every paper note in the vault."""
    return {folder.name: folder / f"{folder.name}.md"
            for folder in (wiki / "papers").glob("*/*")
            if folder.is_dir() and (folder / f"{folder.name}.md").exists()}


def validate(records: list[dict], notes: dict[str, Path]) -> list[str]:
    problems, seen = [], set()
    for record in records:
        stem = Path(record["file"]).stem
        if stem in seen:
            problems.append(f"{stem}: 在记录里出现了多次")
        seen.add(stem)
        if stem not in notes:
            problems.append(f"{stem}: 不是库里的论文笔记")
        for field, targets in record.items():
            if field in ("file", "evidence"):
                continue
            if field in INVERSES:
                problems.append(f"{stem}: `{field}` 是派生反向边，不能手写")
                continue
            if field not in RELATIONS:
                problems.append(f"{stem}: `{field}` 不在关系词表里")
                continue
            if not isinstance(targets, list):
                problems.append(f"{stem}: `{field}` 不是数组")
                continue
            cleaned = [Path(str(t)).stem for t in targets]
            if len(set(cleaned)) != len(cleaned):
                problems.append(f"{stem}: `{field}` 有重复目标")
            for target in cleaned:
                if target not in notes:
                    problems.append(f"{stem}: `{field}` 指向不存在的 `{target}`")
                elif target == stem:
                    problems.append(f"{stem}: `{field}` 自链")
    return problems


def patch(text: str, fields: dict[str, list[str]]) -> tuple[str, list[str]]:
    """Set the given relation fields in the frontmatter. -> (text, notes)."""
    match = FRONTMATTER_RE.match(text)
    if not match:
        raise ValueError("frontmatter 缺失")
    head, block, tail = match.groups()
    notes: list[str] = []

    # Group each field with its continuation lines: a relation written as a YAML
    # block list would otherwise leave its `- item` lines orphaned under the new
    # inline list, which parses as something else entirely rather than failing.
    groups: list[tuple[str | None, list[str]]] = []
    for line in block.splitlines():
        name = FIELD_RE.match(line)
        if name or not groups:
            groups.append((name.group(1) if name else None, [line]))
        else:
            groups[-1][1].append(line)

    rendered = {field: f"{field}: [" + ", ".join(
        f'"[[{t}]]"' for t in targets) + "]" for field, targets in fields.items()}
    out, written = [], set()
    for name, lines in groups:
        if name in rendered:
            # an emptied field is dropped rather than left as `[]`: §3.1 says a note
            # with no relations writes no relation key at all
            if fields[name]:
                out.append(rendered[name])
                notes.append(f"覆盖 {name}")
            else:
                notes.append(f"删掉 {name}")
            written.add(name)
        else:
            out += lines

    missing = [f for f in RELATIONS if f in rendered and f not in written
               and fields[f]]
    if missing:
        anchor = max((i for i, line in enumerate(out)
                      if (m := FIELD_RE.match(line)) and m.group(1) in AFTER),
                     default=len(out) - 1)
        out[anchor + 1:anchor + 1] = [rendered[f] for f in missing]
        notes.append("新增 " + "+".join(missing))

    return head + "\n".join(out) + "\n" + tail + text[match.end():], notes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wiki-dir", default="wiki")
    parser.add_argument("--records", default="/tmp/relations_approved.json")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    wiki = Path(args.wiki_dir).resolve()
    notes_by_stem = paper_notes(wiki)
    records = load_records(args.records)
    print(f"{len(records)} 条记录，库里 {len(notes_by_stem)} 篇论文笔记。")

    problems = validate(records, notes_by_stem)
    if problems:
        print(f"\n校验失败 {len(problems)} 条，未写入任何文件：")
        for line in problems:
            print(f"  {line}")
        raise SystemExit(1)
    print("校验通过：路径、关系词表、目标存在、无自链、无派生反向边、无重复目标。")

    edits: list[tuple[Path, str]] = []
    tally: dict[str, int] = {}
    total = 0
    for record in records:
        stem = Path(record["file"]).stem
        note = notes_by_stem[stem]
        fields = {f: [Path(str(t)).stem for t in record[f]]
                  for f in RELATIONS if f in record}
        if not fields:
            continue
        text = note.read_text(encoding="utf-8")
        new_text, changes = patch(text, fields)
        # safety net: the patched block must parse, and must say what we meant.
        meta = yaml.safe_load(FRONTMATTER_RE.match(new_text).group(2)) or {}
        for field, targets in fields.items():
            got = meta.get(field)
            want = [f"[[{t}]]" for t in targets] or None
            if got != want:
                raise SystemExit(f"{stem}: 写完后 `{field}` 解析为 {got!r}，预期 {want!r}")
        total += sum(len(v) for v in fields.values())
        for item in changes:
            tally[item] = tally.get(item, 0) + 1
        if new_text != text:
            edits.append((note, new_text))

    print(f"\n{len(edits)} 篇待改，共 {total} 条关系：")
    for item, count in sorted(tally.items(), key=lambda kv: -kv[1]):
        print(f"  {item}: {count} 篇")
    if not args.apply:
        print("\nDry-run：加 --apply 才写入。写入后跑 lint.py 确认 0 error。")
        return
    for note, new_text in edits:
        note.write_text(new_text, encoding="utf-8")
    print(f"\n已写入 {len(edits)} 篇。接着跑 "
          "`python3 tools/lint.py --wiki-dir wiki/` 确认 0 error。")


if __name__ == "__main__":
    main()
