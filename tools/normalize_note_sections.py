#!/usr/bin/env python3
"""Preview/apply lossless three-part paper-note organization. Never generates prose."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import shutil

OVERVIEW = {"整体综述", "整体概括", "论文概览", "overview"}
PERSONAL = {"阅读随记", "个人理解", "个人笔记", "我的笔记", "阅读笔记"}
DETAILS = {"论文细节", "论文详解"}
LEGACY = {"notes", "note", "笔记"}


def heading_name(title: str) -> str:
    return re.sub(r"^(?:\d+[.、．)]|[一二三四五六七八九十]+[、.．])\s*", "", title.replace("**", "").replace("__", "")).strip().lower()


def headings(text: str) -> list[dict]:
    result = []
    fence = None
    offset = 0
    for line in text.splitlines(keepends=True):
        value = line.rstrip("\r\n")
        if fence:
            close = re.match(r"^ {0,3}(`{3,}|~{3,})[ \t]*$", value)
            if close and close[1][0] == fence[0] and len(close[1]) >= len(fence):
                fence = None
        else:
            opening = re.match(r"^ {0,3}(`{3,}|~{3,})", value)
            if opening:
                fence = opening[1]
            else:
                match = re.match(r"^( {0,3})(#{1,6})[ \t]+(.+?)[ \t]*$", value)
                if match:
                    title = re.sub(r"\s+#+\s*$", "", match[3])
                    result.append({"start": offset, "content_start": offset + len(line), "level": len(match[2]),
                                   "title": title, "name": heading_name(title), "indent": match[1], "line": line})
        offset += len(line)
    return result


def is_personal(name: str) -> bool:
    return name in PERSONAL or name.startswith("我的") or name.startswith("个人") or name.startswith("保留的研究")


def shift(text: str, delta: int) -> str:
    for heading in reversed(headings(text)):
        level = heading["level"] + delta
        if level > 6 or level < 1:
            raise ValueError("标题层级无法无损调整")
        old = heading["line"]
        line = heading["indent"] + "#" * level + old[len(heading["indent"]) + heading["level"]:]
        text = text[:heading["start"]] + line + text[heading["start"] + len(old):]
    return text


def prose_lines(text: str) -> Counter:
    heading_offsets = {h["start"] for h in headings(text)}
    lines = Counter()
    offset = 0
    for line in text.splitlines(keepends=True):
        if offset not in heading_offsets and line.strip():
            lines[line.rstrip("\r\n")] += 1
        offset += len(line)
    return lines


def normalize(text: str) -> str:
    fm = re.match(r"^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)", text)
    if not fm:
        raise ValueError("frontmatter 缺失，不自动改写")
    head, body = text[:fm.end()], text[fm.end():]
    eol = "\r\n" if "\r\n" in text else "\n"
    top = [h for h in headings(body) if h["level"] == 2]
    if [h["title"] for h in top] == ["整体综述", "论文细节", "阅读随记", "路径"]:
        return text
    if any(h["level"] == 1 for h in headings(body)):
        raise ValueError("正文存在一级标题，需要人工确认")
    preamble = body[:top[0]["start"]] if top else body
    buckets: dict[str, list[str]] = {"overview": [], "details": [], "personal": [], "navigation": []}

    def add_section(bucket: str, heading: dict, content: str, keep_title: bool = False) -> None:
        if keep_title:
            content = "### " + heading["title"] + eol + shift(content, 1 if heading["level"] == 2 else 0)
        buckets[bucket].append(content.strip("\r\n"))

    for index, h in enumerate(top):
        end = top[index + 1]["start"] if index + 1 < len(top) else len(body)
        content = body[h["content_start"]:end]
        name = h["name"]
        if name in OVERVIEW:
            add_section("overview", h, content)
        elif name == "路径":
            add_section("navigation", h, content)
        elif is_personal(name):
            add_section("personal", h, content, name not in PERSONAL)
        elif name in DETAILS or name in LEGACY:
            subheadings = [sub for sub in headings(content) if sub["level"] == 3]
            personal = [sub for sub in subheadings if is_personal(sub["name"])]
            if name in LEGACY and not subheadings:
                # Ambiguous undivided old Notes: retain as detail; don't invent personal authorship.
                add_section("details", h, content, True)
                continue
            remaining = content
            for sub in reversed(personal):
                next_sub = next((item for item in subheadings if item["start"] > sub["start"]), None)
                sub_end = next_sub["start"] if next_sub else len(content)
                fragment = content[sub["start"]:sub_end]
                remaining = remaining[:sub["start"]] + remaining[sub_end:]
            for sub in personal:
                next_sub = next((item for item in subheadings if item["start"] > sub["start"]), None)
                sub_end = next_sub["start"] if next_sub else len(content)
                buckets["personal"].append(content[sub["start"]:sub_end].strip("\r\n"))
            buckets["details"].append(remaining.strip("\r\n"))
        else:
            # Retain every original section title and its lower headings in the details block.
            add_section("details", h, content, True)
    sections = []
    for key, title in [("overview", "整体综述"), ("details", "论文细节"), ("personal", "阅读随记"), ("navigation", "路径")]:
        content = (eol + eol).join(item for item in buckets[key] if item.strip())
        sections.append("## " + title + eol + eol + content)
    output = head + preamble.rstrip("\r\n") + eol + eol + (eol + eol).join(sections) + eol
    if prose_lines(body) != prose_lines(output[len(head):]):
        raise ValueError("正文完整性校验未通过，不写入")
    if output[:len(head)] != head:
        raise ValueError("属性区发生变化，不写入")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wiki-dir", default="wiki")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup-dir")
    args = parser.parse_args()
    root = Path(args.wiki_dir).resolve()
    planned, skipped = [], []
    for file in sorted((root / "papers").rglob("*.md")):
        if file.parent.name != file.stem or not re.match(r"^【\d{4}】", file.stem):
            continue
        before = file.read_bytes()
        try:
            after = normalize(before.decode("utf-8")).encode("utf-8")
        except ValueError as error:
            skipped.append({"path": str(file.relative_to(root)), "reason": str(error)})
            continue
        if before != after:
            planned.append((file, before, after))
    print(json.dumps({"mode": "apply" if args.apply else "preview", "changes": len(planned), "skipped": skipped}, ensure_ascii=False, indent=2))
    if not args.apply or not planned:
        return
    backup = Path(args.backup_dir).expanduser().resolve() if args.backup_dir else Path.home() / ".joycode/backups/pinakes" / (datetime.now().strftime("%Y%m%d-%H%M%S-%f") + "-note-format")
    backup.mkdir(parents=True, exist_ok=False)
    manifest = []
    # Back up and recheck every file before any write.
    for file, before, after in planned:
        target = backup / file.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, target)
        if target.read_bytes() != before or file.read_bytes() != before:
            raise RuntimeError(f"文件在计划期间变化，停止：{file}")
        manifest.append({"path": str(file.relative_to(root)), "before": hashlib.sha256(before).hexdigest(), "after": hashlib.sha256(after).hexdigest()})
    (backup / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    for file, before, after in planned:
        if file.read_bytes() != before:
            raise RuntimeError(f"文件在写入前变化，停止：{file}；原文在 {backup}")
        file.write_bytes(after)
        if file.read_bytes() != after:
            raise RuntimeError(f"写入验证失败：{file}；原文在 {backup}")
    print(f"已更新 {len(planned)} 篇；备份：{backup}")


if __name__ == "__main__":
    main()
