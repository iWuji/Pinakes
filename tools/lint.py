#!/usr/bin/env python3
"""Spec checks for the Pinakes vault (rules: wiki/AGENTS.md).

Layout:
  wiki/
    【索引】<名字>.md                   (vault home — a named note, never index.md)
    papers/【索引】<名字>.md             (域总览)
    papers/<direction>/【索引】<direction>.md          (direction index note)
    papers/<direction>/【year】<slug>/【year】<slug>.md   (+ at least one .pdf)
    papers/_unfiled/【year】<slug>/【year】<slug>.md       (backlog stubs)
    deep-research/<topic>/*.md

Every note's filename names the document: paper notes are named after their folder
(so each paper is a distinct node in Obsidian rather than a wall of identical `note`
nodes) and container notes carry the 【索引】 marker. A note called `index.md` or
`README.md` is reported, because several of them make the navigation layers
indistinguishable in the graph.

Two severities, because they fail for different reasons:
  error — breaks tooling or navigation (unparseable frontmatter, broken link,
          folder/frontmatter disagreement, index drifted from frontmatter).
  warn  — content backlog (thin tags, empty sections, non-canonical skeleton).
Exit code is 1 when any error is present, or when --strict and any warn is.
"""

from __future__ import annotations

import argparse
import urllib.parse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import schema as schema_mod  # noqa: E402
from research_wiki import (  # noqa: E402  (local helper module)
    PAPERS_HEADING, PAPERS_HEADING_RE, _index_entry, index_header, index_note,
    relation_vocabulary, tag_vocabulary,
)

# ---------------------------------------------------------------------------
# Schema（wiki/_schema/*.yml → .compiled.json）：kind / field 的**唯一真源**。
# lint() 每次运行时加载；缺失时退化为旧的 KNOWN_FIELDS 行为。
# ---------------------------------------------------------------------------
SCHEMA: dict | None = None
UNKNOWN_FIELD_USES: dict[str, int] = {}
# 这些 kind 的语义稳定、可从路径可靠推断，不强制写 `kind` 字段。
LEGACY_KINDS = {"paper", "direction", "domain", "library",
                "topic_library", "topic", "idea_library", "idea_package", "idea"}


def _load_schema(root: Path) -> dict | None:
    """加载编译产物；与 YAML 不一致时报 schema-stale（在 lint() 里）。"""
    compiled = schema_mod.load_compiled(root)
    if compiled is None:
        compiled, _ = schema_mod.ensure_compiled(root, apply=False)
    return compiled


def _known_fields(compiled: dict | None) -> set[str]:
    if not compiled:
        return KNOWN_FIELDS
    return schema_mod.known_field_ids(compiled) | set(compiled.get("deprecated") or [])

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
LINK_RE = re.compile(r"\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)")
WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
# markdown 链接的目标:](path) 或 ](<path with space>)
MARKDOWN_LINK_RE = re.compile(r"\]\(<?([^)>\n]+?)>?\)")
FOLDER_RE = re.compile(r"^【(\d{4})】(.+)$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)

# wiki/AGENTS.md §6.1 — fixed order, none may be dropped

REQUIRED_FIELDS = ["title", "slug", "year", "pdf", "tags", "table_summary"]
# of the required six, these four are what the tooling reads: without them resync
# mis-names folders, the PDF callout dangles, and the index entry has no label.
# A missing `tags`/`table_summary` only leaves the index entry thin, so it is a
# backlog warning rather than a blocking error.
STRUCTURAL_FIELDS = {"title", "slug", "year", "pdf"}
RECOMMENDED_FIELDS = ["authors"]
# 阅读状态(2026-10 加,见 wiki/AGENTS.md §3.3):**自由标注**——内置 unread/reading/read/deep,
# 用户可在 Explorer 里加自定义状态,所以这里只校验写法(kebab-case),不校验取值。
# 缺失不算欠账,不进 REQUIRED/RECOMMENDED,只在**写了但写错**时报 warn。
# 取值直接用中文(未读/在读/已读/精读),也允许自定义状态,所以只挡坏值不限定取值
READING_BUILTINS = {"未读", "在读", "已读", "精读"}
READING_RE = re.compile(r"^[^\s\[\]|#]{1,12}$")
# 重要性:1–5 整数(数字 → 图谱里节点半径),每篇论文笔记都应有,默认 1
IMPORTANCE_MIN, IMPORTANCE_MAX = 1, 5
# ideas/ 下的进度档(与论文的 reading 分开:论文是"读到哪了",想法是"做到哪了")。
# 依据见 wiki/AGENTS.md §3.5:Stage-Gate 的 go/kill 闸门 → 除推进档还要有出口档。
IDEA_STAGES = {"待做", "在做", "已成稿", "已投稿", "已发表", "废弃"}
# 论文库里唯一的非方向分区(todolist):它和方向互斥 —— 可以当主方向(整体放进去),
# 但绝不能出现在另一篇论文的 `sub_directions` 里。
UNFILED_DIR = "_unfiled"
RELATIONS = relation_vocabulary()
# the inverse of every authored relation is derived (Breadcrumbs computes it); writing
# one by hand doubles the maintenance and lets the two directions disagree
INVERSE_FIELDS = {spec["inverse"] for spec in RELATIONS.values()
                  if not spec.get("symmetric")}
KNOWN_FIELDS = set(REQUIRED_FIELDS + RECOMMENDED_FIELDS) | set(RELATIONS) | {
    "organization", "arxiv", "venue", "reading", "importance", "direction", "sub_directions",
    "stage", "doc_type"}

# 文献类型(与**方向**正交的第二个维度,2026-10-13 加):方向答"讲什么",doc_type 答"什么体裁"。
# 综述不立成方向 —— arXiv 无子类、ACM CCS 没有 surveys 节点,学科分类按方法/对象切;
# 综述永远"属于某个主题",这正是它不能独立成类的理由(见 wiki/AGENTS.md §3.6)。
DOC_TYPES = {"survey", "tutorial", "technical-report", "benchmark", "empirical-study"}


def parse_note(path: Path) -> tuple[dict | None, str]:
    """(frontmatter, body). frontmatter is None when the YAML block is unusable."""
    text = path.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.match(text)
    if not match:
        return None, text
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        return None, text[match.end():]
    return (data if isinstance(data, dict) else {}), text[match.end():]


def _depth_guard(note: Path, root: Path) -> tuple[str | None, str, dict]:
    """返回 (kind, depth, meta)。depth != full 表示这是边界节点：
    只做最小校验（kind 已登记 / title 存在），不校验内部结构。
    这是 ENTITY_MODEL.md §7 的「按 depth 决定校验范围」。"""
    if not SCHEMA:
        return (None, "full", {})
    rel = note.relative_to(root).as_posix()
    kind = schema_mod.kind_of(SCHEMA, rel)
    meta, _ = parse_note(note)
    meta = meta if isinstance(meta, dict) else {}
    return (kind, schema_mod.depth_of(SCHEMA, meta, kind), meta)


def check_paper(note: Path, folder: Path, direction: Path, root: Path,
                canonical: set[str], aliases: dict[str, str],
                stems: set[str]) -> list[dict]:
    """Every per-paper rule from wiki/AGENTS.md §3, §4 and §6."""
    def add(level, category, message):
        issues.append({"level": level, "category": category,
                       "file": str(note.relative_to(root)), "message": message})

    issues: list[dict] = []
    kind, depth, _meta0 = _depth_guard(note, root)
    if depth != "full":
        # 边界节点：内部不纳管，只确认它是被登记过的 kind、且有人看的 title
        if kind and kind not in (SCHEMA or {}).get("kinds", {}):
            issues.append({"level": "warn", "category": "kind-unknown",
                           "file": str(note.relative_to(root)),
                           "message": f"`kind: {kind}` 未在 wiki/_schema/kinds.yml 登记"})
        if not str(_meta0.get("title") or "").strip():
            issues.append({"level": "warn", "category": "missing-field",
                           "file": str(note.relative_to(root)),
                           "message": "边界实体缺 `title`（人和 AI 都靠它认节点）"})
        return issues
    meta, body = parse_note(note)
    if meta is None:
        add("error", "bad-frontmatter",
            "frontmatter 缺失或 YAML 无法解析（双引号标量里的 \\\" 是常见原因）")
        return issues

    # --- §3 fields
    for field in REQUIRED_FIELDS:
        value = meta.get(field)
        if value is None or value == "" or value == []:
            if field in STRUCTURAL_FIELDS:
                add("error", "missing-field", f"必填字段 `{field}` 缺失或为空")
            else:
                add("warn", "missing-field", f"必填字段 `{field}` 缺失或为空（待补）")
    for field in RECOMMENDED_FIELDS:
        value = meta.get(field)
        if value is None or value == "" or value == []:
            add("warn", "missing-recommended", f"建议字段 `{field}` 缺失或为空")
    deprecated = set((SCHEMA or {}).get("deprecated") or [])
    for field in set(meta) - KNOWN_FIELDS:
        if field in deprecated:
            add("warn", "field-deprecated", f"字段 `{field}` 已废弃，可以删掉")
        else:
            # 渐进 schema：未注册字段不逐篇报错，只累计；达到阈值再提示「可晋升」
            UNKNOWN_FIELD_USES[field] = UNKNOWN_FIELD_USES.get(field, 0) + 1

    # kind：可从路径推断的旧 kind 不强制写；新 kind 建议显式声明
    if SCHEMA:
        rel = str(note.relative_to(root))
        inferred = schema_mod.kind_of(SCHEMA, rel)
        declared = str(meta.get("kind") or "").strip()
        if inferred and not declared and inferred not in LEGACY_KINDS:
            add("warn", "kind-missing",
                f"建议显式写 `kind: {inferred}`（AI/工具靠它决定默认纳管深度）")
        if declared and declared not in (SCHEMA.get("kinds") or {}):
            add("warn", "kind-unknown", f"`kind: {declared}` 未在 wiki/_schema/kinds.yml 登记")


    # --- §3 folder/frontmatter agreement (resync depends on these matching)
    fm_match = FOLDER_RE.match(folder.name)
    if not fm_match:
        add("error", "bad-folder-name", f"文件夹名不是 `【年份】slug` 形式：{folder.name}")
    else:
        folder_year, folder_slug = fm_match.groups()
        if str(meta.get("year") or "") != folder_year:
            add("error", "year-mismatch",
                f"frontmatter year={meta.get('year')} != 文件夹年份 {folder_year}")
        if str(meta.get("slug") or "") != folder_slug:
            add("error", "slug-mismatch",
                f"frontmatter slug={meta.get('slug')!r} != 文件夹 slug {folder_slug!r}")
        title = str(meta.get("title") or "")
        title_match = re.match(r"^【(\d{4})】", title)
        if not title_match:
            add("warn", "title-prefix", "title 缺少 `【年份】` 前缀")
        elif title_match.group(1) != folder_year:
            add("error", "year-mismatch",
                f"title 年份 {title_match.group(1)} != 文件夹年份 {folder_year}")

    # --- §3 pdf resolves, both as a field and as the callout wikilink
    # Case has to match exactly: macOS APFS is case-insensitive, so a reference whose
    # case drifted from the file still opens locally and only breaks once the repo is
    # read on a case-sensitive filesystem (Linux, GitHub). `exists()` cannot see that,
    # so compare against the real directory listing instead.
    on_disk = {p.name for p in folder.iterdir()}

    def resolves(name: str) -> bool:
        return name in on_disk

    pdf_name = str(meta.get("pdf") or "")
    if pdf_name and not resolves(pdf_name):
        hint = "（大小写不一致）" if (folder / pdf_name).exists() else ""
        add("error", "pdf-not-found", f"frontmatter pdf `{pdf_name}` 不在文件夹里{hint}")
    if not list(folder.glob("*.pdf")):
        add("warn", "missing-pdf", "文件夹里没有任何 .pdf")
    for target in (w.split("|")[0].strip() for w in WIKILINK_RE.findall(body)):
        if target.lower().endswith(".pdf") and not resolves(target):
            hint = "（大小写不一致）" if (folder / target).exists() else ""
            add("error", "pdf-not-found", f"PDF wikilink `{target}` 指向不存在的文件{hint}")

    # --- §4 tags
    tags = [str(t) for t in (meta.get("tags") or [])]
    for tag in tags:
        if tag in aliases:
            add("warn", "tag-alias",
                f"标签 `{tag}` 是历史中文写法，应改为 `{aliases[tag]}`")
        elif canonical and tag not in canonical:
            add("warn", "tag-unknown",
                f"标签 `{tag}` 不在 tools/tag_vocabulary.yml 词表里")
    if tags and not 2 <= len(tags) <= 4:
        add("warn", "tag-count", f"标签 {len(tags)} 个，规范要求 2–4 个")

    # --- 本地链接不要百分号编码:`%E3%80%90` 就是 `【`,Obsidian 自己能解,
    # 但 lint / GitHub / 任何按字面解析的工具都会把它当成不存在的文件名。
    # 中文、【】 直接写即可;只在含空格时用 `](<...>)` 包起来(与 Obsidian 自己的写法一致)。
    for raw_target in MARKDOWN_LINK_RE.findall(body):
        if "://" in raw_target or not re.search(r"%[0-9A-Fa-f]{2}", raw_target):
            continue
        decoded = urllib.parse.unquote(raw_target)
        if (folder / decoded).exists() or (folder / raw_target).exists():
            add("warn", "link-percent-encoded",
                f"链接 `{raw_target[:60]}` 是百分号编码写法的,改成 `{decoded[:60]}`"
                "(中文路径原样写就认)")

    # --- §3.3 阅读状态(自由标注:内置 unread/reading/read/deep,允许自定义值)
    reading = str(meta.get("reading") or "").strip()
    if not reading:
        add("warn", "reading-missing", "缺 `reading`(未读/在读/已读/精读,见 §3.3)")
    elif not READING_RE.match(reading):
        add("warn", "reading-format",
            f"`reading` 要是简短状态名(如 未读 / 在读 / 已读 / 精读),当前 `{reading}`")
    importance = meta.get("importance")
    if importance in (None, ""):
        add("warn", "importance-missing", "缺 `importance`(1–5 的整数,默认 1)")
    elif not (isinstance(importance, int) and not isinstance(importance, bool)
              and IMPORTANCE_MIN <= importance <= IMPORTANCE_MAX):
        add("warn", "importance-range",
            f"`importance` 要是 {IMPORTANCE_MIN}–{IMPORTANCE_MAX} 的整数,当前 {importance!r}")

    # --- §3.3 主方向(direction):frontmatter 里声明,必须与所在文件夹一致。
    # 说明:文件位置才是物理归属,这个字段是为了"面板里看得见、Dataview 查得到"。
    # 两者不一致 = 搬过文件没改字段(或反过来),会让图和文件对不上 —— 报 error。
    decl = str(meta.get("direction") or "").strip()
    if not decl:
        add("warn", "direction-missing", "缺 `direction`(主方向,写 `[[【索引】<方向>]]`)")
    else:
        target = decl[2:-2].split("|")[0].strip() if decl.startswith("[[") and decl.endswith("]]") else None
        if target is None:
            add("error", "direction-not-wikilink",
                f"`direction` 要写成 `[[【索引】<方向>]]`,当前 `{decl}`")
        elif target != f"【索引】{direction.name}":
            add("error", "direction-folder-mismatch",
                f"`direction` 是 `{target}`,但文件在 `{direction.name}/` 下 —— 搬过文件没改字段?")

    # --- 文献类型(doc_type):可选;取值必须在词表里。与方向正交,不参与分类树。
    dt = meta.get("doc_type")
    if dt not in (None, ""):
        if str(dt).strip() not in DOC_TYPES:
            add("warn", "doc-type-unknown",
                f"`doc_type: {dt}` 不在词表里({'/'.join(sorted(DOC_TYPES))})")

    # --- §3.4 子方向(sub_directions):主方向唯一(文件夹),子方向可以有多个。
    # 值是 wikilink 数组,目标必须是**方向索引笔记** —— 指向别的东西(或指向自己那个方向)
    # 会让 Explorer 画出一条没有意义的边,所以按关系字段同样的严格度报 error。
    sub_dirs = meta.get("sub_directions")
    if sub_dirs not in (None, ""):
        own_index = f"【索引】{direction.name}"
        if direction.name == UNFILED_DIR:
            # 待在待归档里的论文还没有主方向 —— 与方向互斥,先定方向才能谈子方向。
            add("error", "unfiled-has-sub-dir",
                f"`papers/{UNFILED_DIR}/` 里的论文不应有 `sub_directions` —— "
                f"待归档与方向互斥,先把它移到一个方向再加子方向")
        if not isinstance(sub_dirs, list):
            add("error", "sub-dir-not-list",
                f"`sub_directions` 必须是 wikilink 数组,当前是 {type(sub_dirs).__name__}")
        else:
            for item in sub_dirs:
                link = str(item).strip()
                if not link.startswith("[["):
                    add("error", "sub-dir-not-wikilink",
                        f"`sub_directions` 的 `{link}` 不是 wikilink(要写 `[[【索引】<方向>]]`)")
                    continue
                target = link[2:-2].split("|")[0].strip() if link.endswith("]]") else link[2:]
                if target == own_index:
                    add("error", "sub-dir-is-primary",
                        f"`sub_directions` 指向了自己那个方向(`{target}`)—— 主方向不用写进子方向")
                elif target == f"【索引】{UNFILED_DIR}":
                    # 待归档是互斥的 todolist 分区,不是方向 —— 一篇论文要么在方向里,
                    # 要么在待归档里,不能同时挂两边。
                    add("error", "sub-dir-is-unfiled",
                        f"`sub_directions` 不能指向待归档分区(`{target}`)—— "
                        f"它与方向互斥,未定方向的论文应整体放进 papers/{UNFILED_DIR}/")
                elif target not in stems:
                    add("error", "sub-dir-target-missing",
                        f"`sub_directions` 指向的 `{target}` 不是 papers/ 下的方向索引笔记")

    # --- §3.1 typed relations (tools/relation_vocabulary.yml)
    for field in INVERSE_FIELDS & set(meta):
        add("error", "relation-inverse-authored",
            f"`{field}` 是派生的反向边，由 Breadcrumbs 自动补，不要手写")
    for field in set(RELATIONS) & set(meta):
        value = meta[field]
        if not isinstance(value, list):
            add("error", "relation-not-list",
                f"`{field}` 必须是 wikilink 数组，当前是 {type(value).__name__}")
            continue
        for item in value:
            link = str(item).strip()
            target = link[2:-2].split("|")[0].strip() if link.startswith("[[") else link
            if not link.startswith("[["):
                add("error", "relation-not-wikilink",
                    f"`{field}` 的 `{link}` 不是 wikilink（要写成 `[[【年份】slug]]`）")
            # a relation whose target does not exist is worse than no relation: the
            # graph shows a phantom node and Breadcrumbs builds a trail into nothing
            if target not in stems:
                add("error", "relation-target-missing",
                    f"`{field}` 指向的 `{target}` 不是库里的论文笔记")
            elif target == folder.name:
                add("error", "relation-self-link", f"`{field}` 指向了本篇自己")

    # --- §6 正文:自由区(2026-10 起)
    # 正文写什么、要不要分小节、小节叫什么名字,由记录的人自己决定 —— 模板只是起步建议。
    # 只保留一条硬校验:PDF callout 在不在(它是"打开原文"的唯一机器可读入口)。
    if "原文 PDF" not in body:
        add("warn", "missing-pdf-callout", "缺少 `> [!note] 📄 原文 PDF：[[...]]` callout")
    return issues
    return issues


def check_index(direction: Path, root: Path) -> list[dict]:
    """§5: the `## 论文` list is derived, so it must equal what rebuild-index would emit."""
    index = index_note(direction)
    rel = str(index.relative_to(root))
    if SCHEMA and index.exists():
        _kind, depth, _meta = _depth_guard(index, root)
        if depth != "full":
            return []          # 边界容器：不要求它的索引表与 frontmatter 保持一致
    if not index.exists():
        return [{"level": "error", "category": "missing-direction-index", "file": rel,
                 "message": f"方向索引 `{index.name}` 缺失，跑 "
                            "`research_wiki.py scaffold wiki/ --apply` 生成"}]
    text = index.read_text(encoding="utf-8")
    if PAPERS_HEADING not in text:
        return [{"level": "error", "category": "index-no-heading", "file": rel,
                 "message": f"索引里找不到 `{PAPERS_HEADING}` 小节，无法重建"}]

    entries = []
    for folder in sorted((p for p in direction.iterdir() if p.is_dir()),
                         key=lambda p: re.sub(r"^【\d+】", "", p.name)):
        note = folder / f"{folder.name}.md"
        if note.exists():
            meta, _ = parse_note(note)
            entries.append(_index_entry(folder, meta or {}))
    # 标题按行首锚定取(见 research_wiki.PAPERS_HEADING_RE):
    # 简介里被反引号包着的同名串不算标题,否则会切错位置、把两边的期望值都算歪。
    hit = PAPERS_HEADING_RE.search(text)
    cols = ((SCHEMA or {}).get("kinds", {}).get("direction", {}) or {}).get("index_columns") or None
    expected = (text[:hit.end()] if hit else text.split(PAPERS_HEADING, 1)[0] + PAPERS_HEADING) + \
        "\n\n" + index_header(cols) + "\n" + "\n".join(entries) + "\n"
    if expected != text:
        return [{"level": "error", "category": "index-stale", "file": rel,
                 "message": "索引与 frontmatter 不一致，跑 "
                            "`research_wiki.py rebuild-index wiki/ --apply`"}]
    return []


# 伪公式检测(2026-10-13 加):数学写在正文里却没包进 `$...$` —— `v_j = squash(s_j)`、
# `b_{ij} += v_j^T W_{ij} e_i` 这种,Obsidian 只会原样显示(`_` 还可能被吃成斜体)。
# 任何插件都改不了这个,只能把式子改写成真 LaTeX;这条 warn 防止以后再写回去。
# 判据刻意保守:必须同时有「LaTeX 味的上下标或求和号」与「等号」,且不在 $...$ / 行内代码里。
# 上下标/求和号;`v_j`(不带花括号)也算 —— 那是本库最常见的伪公式写法。
PSEUDO_MATH_SUB = re.compile(r"(_\{|\^\{|\^T\b|\^\d|\bΣ|\b∑|\b[A-Za-z]_[A-Za-z0-9]\b)")
PSEUDO_MATH_EQ = re.compile(r"(=|\+=|∝|≈)")


def pseudo_math_lines(body: str) -> list[tuple[int, str]]:
    """返回 (行号, 行内容) —— 疑似伪公式的行。"""
    text = re.sub(r"^---\r?\n[\s\S]*?\r?\n---\r?\n?", "", body)   # frontmatter
    text = re.sub(r"```[\s\S]*?```", "", text)                      # 代码块
    text = re.sub(r"`[^`\n]*`", "", text)                            # 行内代码
    text = re.sub(r"\$\$[\s\S]*?\$\$", "", text)                    # 块公式
    text = re.sub(r"\$[^$\n]+\$", "", text)                          # 行内公式
    text = re.sub(r"\]\([^)]*\)", "]", text)                          # markdown 链接目标(路径里有下划线)
    text = re.sub(r"\[\[[^\]]*\]\]", "", text)                        # wikilink
    out = []
    for i, line in enumerate(text.split("\n"), 1):
        if not line.strip() or line.lstrip().startswith("|"):
            continue                                                  # 空行/表格行(索引表)
        if "$" in line:
            continue                                                  # 还留着未配对 $,另说
        if PSEUDO_MATH_SUB.search(line) and PSEUDO_MATH_EQ.search(line):
            out.append((i, line.strip()))
    return out


def lint(root: Path) -> list[dict]:
    global SCHEMA, KNOWN_FIELDS, UNKNOWN_FIELD_USES
    issues: list[dict] = []
    SCHEMA = _load_schema(root)
    if SCHEMA:
        KNOWN_FIELDS = _known_fields(SCHEMA)
        _, stale = schema_mod.ensure_compiled(root, apply=False)
        if stale:
            issues.append({
                "level": "error", "category": "schema-stale", "file": "_schema",
                "message": "schema 编译产物过期，跑 `python3 tools/pinakes.py schema --apply`"})
    UNKNOWN_FIELD_USES = {}
    # the vault home is a 【索引】 note, not a generic README/index — see wiki/AGENTS.md §1
    home = next(root.glob("【索引】*.md"), None)
    if home is None:
        issues.append({"level": "error", "category": "missing-entry",
                       "file": ".", "message": "找不到首页索引笔记 `【索引】*.md`"})

    papers = root / "papers"
    if not papers.is_dir():
        issues.append({"level": "error", "category": "missing-papers",
                       "file": "papers", "message": "papers/ directory is missing"})
        return issues

    canonical, aliases = tag_vocabulary()
    # 合法链接目标的全集(校验 sub_directions / 关系边用)。
    # 域(大类别)是**索引笔记**而不是文件夹(2026-10-13 定),所以 papers/ 顶层的
    # 【索引】<域>.md 也要收进来 —— 子方向/关系边因此可以跨域指向别的域。
    stems = {p.stem for p in papers.glob("【索引】*.md")}
    stems |= {p.stem for p in papers.glob("*/【索引】*.md")}
    stems |= {folder.name for folder in papers.glob("*/*") if folder.is_dir()
              and (folder / f"{folder.name}.md").exists()}
    for direction in sorted(p for p in papers.iterdir() if p.is_dir()):
        issues += check_index(direction, root)
        for folder in sorted(p for p in direction.iterdir() if p.is_dir()):
            # the note is named after its folder: 【year】<slug>/【year】<slug>.md
            note = folder / f"{folder.name}.md"
            if not note.exists():
                issues.append({"level": "error", "category": "missing-note",
                               "file": str(folder.relative_to(root)),
                               "message": f"论文文件夹里没有 `{folder.name}.md`"})
                continue
            issues += check_paper(note, folder, direction, root, canonical, aliases,
                                  stems)

    # broken local markdown links (wikilinks are left to Obsidian to resolve).
    # Skip underscore support dirs: _templates (Templater placeholders),
    # _dashboards (Dataview queries) — neither holds literal relative links.
    for path in root.rglob("*.md"):
        rel = path.relative_to(root)
        # 进度轴由 schema 的 status_field 驱动(idea→stage / paper→reading):
        # kind 声明了 stage 轴的笔记,进度写 `stage`(不是 reading);缺了或取值不在档位里都提醒
        if SCHEMA and path.stem.startswith("【索引】") is False:
            kind = schema_mod.kind_of(SCHEMA, rel.as_posix())
            axis = (schema_mod.spec_of(SCHEMA, kind) or {}).get("status_field")
            if axis == "stage":
                meta_idea, _ = parse_note(path)
                if isinstance(meta_idea, dict):
                    stage = str(meta_idea.get("stage") or "").strip()
                    if not stage:
                        issues.append({"level": "warn", "category": "stage-missing",
                                       "file": str(rel), "message": "想法笔记缺 `stage`(待做/在做/已成稿/已投稿/已发表/废弃)"})
                    elif stage not in IDEA_STAGES:
                        issues.append({"level": "warn", "category": "stage-unknown",
                                       "file": str(rel), "message": f"`stage` 取值 `{stage}` 不在档位里:{'/'.join(sorted(IDEA_STAGES))}"})
                    if meta_idea.get("reading"):
                        issues.append({"level": "warn", "category": "stage-not-reading",
                                       "file": str(rel), "message": "想法笔记用 `stage` 标进度,不要用 `reading`(那是论文的阅读状态)"})
        if any(part.startswith("_") for part in path.relative_to(root).parts):
            continue
        # 伪公式:数学没写进 `$...$`(渲染不出来,插件也救不了)
        try:
            body = FRONTMATTER_RE.sub("", path.read_text(encoding="utf-8"), count=1)
        except OSError:
            body = ""
        for lineno, line in pseudo_math_lines(body):
            issues.append({"level": "warn", "category": "pseudo-math",
                           "file": str(path.relative_to(root)),
                           "line": lineno,
                           "message": f"疑似伪公式(未写进 `$...$`,渲染不出来):{line[:60]}"})
        # §1: a filename must name its document. AGENTS.md (an agent-facing spec read
        # by convention) and log.md (the changelog) are named for what they are.
        if path.name.lower() in ("index.md", "readme.md", "note.md"):
            issues.append({"level": "error", "category": "generic-filename",
                           "file": str(path.relative_to(root)),
                           "message": "通名文件：容器笔记要用 `【索引】<名字>.md`，"
                                      "论文笔记要用 `【年份】<slug>.md`"})
        text = path.read_text(encoding="utf-8")
        # Drop fenced code blocks: links inside ``` ``` are illustrative examples
        # (e.g. placeholder paths in AGENTS.md), not real navigation.
        text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
        for target in LINK_RE.findall(text):
            # CommonMark allows wrapping a destination with spaces in <...>
            if target.startswith("<") and target.endswith(">"):
                target = target[1:-1]
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            dest = (path.parent / target).resolve()
            # Same case trap as the PDF check: on macOS `exists()` says yes to a link
            # whose case drifted, and the break only shows up on GitHub. Confirm the
            # final component against its parent's real listing.
            ok = dest.exists() and (dest.parent.is_dir()
                                    and dest.name in {p.name for p in dest.parent.iterdir()})
            if not ok:
                why = "大小写不一致" if dest.exists() else "不存在"
                issues.append({"level": "warn", "category": "broken-link",
                               "file": str(path.relative_to(root)),
                               "message": f"链接目标 `{target}` {why}"})

    # 渐进 schema：未注册字段累计到阈值后，按字段给一条聚合提示
    threshold = int(((SCHEMA or {}).get("unknown") or {}).get("promote_hint_after") or 3)
    for field, uses in sorted(UNKNOWN_FIELD_USES.items()):
        if uses >= threshold:
            issues.append({
                "level": "warn", "category": "field-promotable", "file": "_schema",
                "message": f"字段 `{field}` 已在 {uses} 篇里使用但未注册 —— "
                           f"可以晋升为 facet（wiki/_schema/fields.yml）"})

    return issues


def report(issues: list[dict], show_all: bool) -> None:
    """Group by category: the content backlog runs to hundreds of lines otherwise."""
    by_category: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for item in issues:
        by_category[(item["level"], item["category"])].append(item)
    for level in ("error", "warn"):
        groups = {k: v for k, v in by_category.items() if k[0] == level}
        for (_, category), items in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            print(f"\n[{level}] {category} ({len(items)})")
            shown = items if show_all else items[:5]
            for item in shown:
                print(f"    {item['file']}\n      {item['message']}")
            if len(items) > len(shown):
                print(f"    ... 还有 {len(items) - len(shown)} 条（--all 全部列出）")
    errors = sum(1 for i in issues if i["level"] == "error")
    print(f"\n{len(issues)} issue(s)：{errors} error, {len(issues) - errors} warn。")


def main() -> None:
    parser = argparse.ArgumentParser(description="Lint the Pinakes against wiki/AGENTS.md")
    parser.add_argument("--wiki-dir", default="wiki")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--all", action="store_true", help="列出每条问题，不折叠")
    parser.add_argument("--strict", action="store_true", help="warn 也算失败")
    args = parser.parse_args()
    root = Path(args.wiki_dir).resolve()
    issues = lint(root)
    if args.json:
        print(json.dumps(issues, ensure_ascii=False, indent=2))
    elif issues:
        report(issues, args.all)
    else:
        print("No lint issues found.")
    errors = sum(1 for i in issues if i["level"] == "error")
    sys.exit(1 if errors or (args.strict and issues) else 0)


if __name__ == "__main__":
    main()
