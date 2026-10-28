#!/usr/bin/env python3
"""Maintenance helpers for the per-paper-folder Pinakes layout.

Papers live at wiki/papers/<direction>/【year】<slug>/【year】<slug>.md.
Each paper's frontmatter is the single source of truth: `rebuild-index` derives the
direction indexes' paper lists from it, and `resync` re-derives the folder/file
names from its `year`+`slug`, so a single frontmatter edit propagates with one
command. Content rules live in wiki/AGENTS.md.
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

import yaml

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)
TOOLS_DIR = Path(__file__).resolve().parent


def frontmatter(path: Path) -> dict:
    """Parse a note's YAML frontmatter. Invalid YAML yields {} (lint reports it)."""
    match = FRONTMATTER_RE.match(path.read_text(encoding="utf-8"))
    if not match:
        return {}
    try:
        return yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError:
        return {}


def tag_vocabulary() -> tuple[set[str], dict[str, str]]:
    """Canonical tag set + historical-alias map from tools/tag_vocabulary.yml."""
    path = TOOLS_DIR / "tag_vocabulary.yml"
    if not path.exists():
        return set(), {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    canonical = {t for group in (data.get("axes") or {}).values() for t in group}
    return canonical, data.get("aliases") or {}


def relation_vocabulary() -> dict[str, dict]:
    """Typed-relation spec from tools/relation_vocabulary.yml, keyed by field name."""
    path = TOOLS_DIR / "relation_vocabulary.yml"
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return data.get("relations") or {}


def direction_dirs(root: Path) -> list[Path]:
    """Every direction folder: papers/<方向>/(含 _unfiled 这类暂存区)。

    域(大类别)是**索引笔记**而不是文件夹 —— `papers/【索引】<域>.md`(2026-10-13 定),
    所以这里只走一层。方向名带域前缀(如 `llm4rec-01-表示与Tokenization`)保证全库唯一。
    """
    papers = root / "papers"
    if not papers.is_dir():
        return []
    return sorted(p for p in papers.iterdir() if p.is_dir())


def note_files(root: Path) -> list[Path]:
    """Every paper note: papers/<方向>/<folder>/<folder>.md."""
    notes = []
    for direction in direction_dirs(root):
        for folder in sorted(direction.iterdir()):
            if folder.is_dir():
                note = folder / f"{folder.name}.md"
                if note.exists():
                    notes.append(note)
    return notes


def append_log(wiki_root: str, message: str) -> None:
    path = Path(wiki_root) / "log.md"
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with path.open("a", encoding="utf-8") as handle:
        handle.write(f"## [{stamp}] {message}\n")


def search(wiki_root: str, query: str) -> None:
    terms = [
        term for term in re.findall(r"[a-z0-9]+|[一-鿿]{2,}", query.lower())
        if len(term) > 1
    ]
    results = []
    for path in note_files(Path(wiki_root)):
        haystack = path.read_text(encoding="utf-8").lower()
        score = sum(haystack.count(term) for term in terms)
        if score:
            meta = frontmatter(path)
            results.append({
                "score": score,
                "title": meta.get("title", path.parent.name),
                "path": str(path.relative_to(wiki_root)),
            })
    results.sort(key=lambda item: (-item["score"], item["path"]))
    print(json.dumps(results[:20], ensure_ascii=False, indent=2))


def stats(wiki_root: str) -> None:
    root = Path(wiki_root)
    counts: dict[str, int] = {}
    for path in note_files(root):
        # 方向 = 论文文件夹的上一级目录名(域前缀已带在名字里,如 llm4rec-01-…)
        direction = path.parent.parent.name
        counts[direction] = counts.get(direction, 0) + 1
    directions = [{"direction": d, "papers": counts[d]}
                  for d in sorted(counts) if d != UNFILED_DIR]
    # `_unfiled` 不是方向,是论文库里唯一的 todolist 分区 —— 单列,不混进方向统计。
    print(json.dumps(
        {"directions": directions,
         "unfiled": counts.get(UNFILED_DIR, 0),
         "papers": sum(counts.values())},
        ensure_ascii=False, indent=2,
    ))


def resync(wiki_root: str, apply: bool) -> None:
    """Re-derive each paper's folder/file name from its frontmatter year+slug.

    The desired name is 【year】<slug>. When the current folder differs, the old
    name token (which is unique and appears in the folder name, note filename,
    and every link to the paper) is string-replaced across all
    markdown, then the folder and note file are renamed on disk. Dry-run unless
    --apply is given.
    """
    root = Path(wiki_root).resolve()
    renames: list[tuple[Path, str, str]] = []  # (folder, old_token, new_token)
    skips: list[tuple[str, str]] = []
    for note in note_files(root):
        folder = note.parent
        meta = frontmatter(note)
        year = str(meta.get("year") or "").strip()
        slug = str(meta.get("slug") or "").strip()
        if not year or not slug:
            skips.append((folder.name, "frontmatter year/slug 为空"))
            continue
        desired = f"【{year}】{slug}"
        if folder.name == desired:
            continue
        target = folder.parent / desired
        # On a case-insensitive filesystem (macOS APFS by default) a slug that only
        # changed case makes `target.exists()` true because the target IS the source.
        # That is a rename to perform, not a collision — detect it by identity.
        if target.exists() and not target.samefile(folder):
            skips.append((folder.name, f"目标 `{desired}` 已存在，跳过"))
            continue
        renames.append((folder, folder.name, desired))

    for folder, old, new in renames:
        print(f"[rename] {old}  ->  {new}")
    for name, why in skips:
        print(f"[skip]   {name}  ({why})")
    if not renames:
        print("无需重命名。" if not skips else "没有可执行的重命名。")
        return
    if not apply:
        print(f"\nDry-run：{len(renames)} 项待重命名。加 --apply 执行。")
        return

    md_files = list(root.rglob("*.md"))
    for folder, old, new in renames:
        for md in md_files:
            s = md.read_text(encoding="utf-8")
            if old in s:
                md.write_text(s.replace(old, new), encoding="utf-8")
        note = folder / f"{old}.md"
        if note.exists():
            _rename(note, folder / f"{new}.md")
        # PDFs and other assets are usually named after the paper too. The link
        # rewrite above already repointed every reference at the new token, so the
        # files have to follow or the links break on a case-sensitive filesystem
        # (they would still resolve on macOS, which is how such a break goes unseen).
        for asset in folder.iterdir():
            if asset.suffix != ".md" and old in asset.name:
                _rename(asset, folder / asset.name.replace(old, new))
        _rename(folder, folder.parent / new)
        _rename(folder, folder.parent / new)
    print(f"\n已重命名 {len(renames)} 项并同步所有链接。")


def _rename(src: Path, dst: Path) -> None:
    """Rename src -> dst, including a case-only change on a case-insensitive FS.

    `Path.rename` to a name differing only in case is a no-op on APFS, so route it
    through a temporary name that cannot collide.
    """
    if src == dst:
        return
    if src.name.lower() == dst.name.lower():
        tmp = src.with_name(src.name + ".case-rename-tmp")
        src.rename(tmp)
        tmp.rename(dst)
    else:
        src.rename(dst)


def _split_list(raw: str) -> list[str]:
    return [x.strip() for x in re.split(r"[,，;；]", raw or "") if x.strip()]


PAPERS_HEADING = "## 论文"
INDEX_PREFIX = "【索引】"
# 论文库里唯一的非方向分区:已入库但还没定方向的 stub,是个 todolist 而不是知识方向。
# 它不参与方向统计,在树上挂在 `papers/【索引】papers.md` 的 `## 待归档` 小节下。
UNFILED_DIR = "_unfiled"
# 待归档分区固定用中性灰(#9AA0A6),与方向调色板里的任何颜色都不同 ——
# 它在图上是"待办"，不是"第 8 个方向"。
UNFILED_COLOR = 0x9AA0A6
# 标题必须**行首锚定**:简介里常写「（手写；`## 论文` 以上的内容工具永不改动）」,
# 用 text.split("## 论文", 1) 会切在那一处,把简介截断、真标题吃掉(2026-10-13 修)。
PAPERS_HEADING_RE = re.compile(r"^## 论文[ \t]*$", re.M)


def index_note(direction: Path) -> Path:
    """A direction's index note: papers/<方向>/【索引】<方向>.md

    The 【索引】 marker is what distinguishes a container note from a paper note at a
    glance — in the file explorer, and (because the front-matter-title plugin labels
    nodes by `title`, which carries the same prefix) in the graph. Defined once here
    so lint, rebuild-index and new all agree on where an index lives.
    """
    return direction / f"{INDEX_PREFIX}{direction.name}.md"


# Distinct, readable hues for graph color groups. A new direction takes the first
# one that is not merely unused but visually separated from every claimed color, so
# colors stay stable as directions are added and never silently collide.
GRAPH_PALETTE = [
    0x4C8DFF, 0x2ECC71, 0xFF8C42, 0xA8639F, 0xE0556C, 0x9AA0A6,
    0x00BCD4, 0xFFC107, 0x8BC34A, 0xE91E63, 0x795548, 0x3F51B5,
    # 2026-10-19: the first twelve were all claimed once deeprec-02 existed.
    # Both additions keep >=80 distance from every colour in use.
    0xFF7043, 0x00897B,
    # 2026-10-20: genmodel's three directions exhausted those again.
    # Picked by grid search for >=95 distance from every colour then in use.
    0xF4F47D, 0x7DF4F4, 0x8E28F4,
    # 2026-10-26: the new `llm` domain opened eight directions at once and used up
    # the rest. Picked by grid search for >=95 distance from every colour then set.
    0x0000F0, 0x00F000, 0xF00000, 0x60F000, 0x000090, 0x009000,
    0xB08000, 0x7000A0,
]
# Two colors this close are the same color to the eye. Testing only for equality
# is not enough: the hand-set directions already hold #A86BE0, and the palette's
# #A8639F is 65 apart — a different hue on paper, still two purples in the graph.
COLOR_MIN_DISTANCE = 80


def _far_enough(rgb: int, used: set[int]) -> bool:
    """True when rgb is visually distinguishable from every already-claimed color."""
    def channels(value: int) -> tuple[int, int, int]:
        return (value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF

    r, g, b = channels(rgb)
    return all(
        ((r - ur) ** 2 + (g - ug) ** 2 + (b - ub) ** 2) ** 0.5 >= COLOR_MIN_DISTANCE
        for ur, ug, ub in (channels(c) for c in used if isinstance(c, int))
    )


def _index_skeleton(name: str) -> str:
    """The hand-written half of a direction index; rebuild-index fills the rest."""
    return (f'---\ntitle: "{INDEX_PREFIX}{name}"\n---\n\n'
            f"> 这个方向在研究什么——一句话定位（手写；「{PAPERS_HEADING}」以上的内容"
            f"工具永不改动）\n\n{PAPERS_HEADING}\n")


def scaffold(wiki_root: str, apply: bool) -> None:
    """Make every papers/ subfolder a first-class direction: index note + graph color.

    Drop a new folder into papers/ and this gives it the index skeleton (frontmatter
    + 【索引】 title + the `## 论文` heading rebuild-index writes under) and its own
    color group in .obsidian/graph.json, so its papers show up as a new cluster in
    the graph instead of inheriting a neighbour's color. Idempotent; dry-run unless
    --apply. rebuild-index calls this first, so the everyday command covers it.
    """
    root = Path(wiki_root).resolve()
    created, colored = [], []

    for direction in direction_dirs(root):
        index = index_note(direction)
        if not index.exists():
            created.append(index)
            if apply:
                index.write_text(_index_skeleton(direction.name), encoding="utf-8")

    graph_path = root / ".obsidian" / "graph.json"
    if graph_path.exists():
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
        groups = graph.setdefault("colorGroups", [])
        queries = {g.get("query", "") for g in groups}
        used = {g.get("color", {}).get("rgb") for g in groups}
        names = [p.name for p in direction_dirs(root)]
        for name in names + ["deep-research"]:
            query = f'path:"{name}"'
            if query in queries:
                continue
            if name == UNFILED_DIR:
                # 待归档不是方向 —— 固定中性灰,不从方向调色板里取色,
                # 这样它不会看起来像"第 8 个方向"。
                free = UNFILED_COLOR
            else:
                free = next((c for c in GRAPH_PALETTE if _far_enough(c, used)), None)
            if free is None:
                print(f"[warn] 调色板里没有与现有配色足够区分的颜色，{name} 未分配图谱颜色")
                continue
            used.add(free)
            groups.append({"query": query, "color": {"a": 1, "rgb": free}})
            colored.append((name, free))
        if colored and apply:
            graph_path.write_text(
                json.dumps(graph, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8")

    for index in created:
        print(f"[scaffold] 新建方向索引 {index.relative_to(root)}")
    for name, rgb in colored:
        print(f"[scaffold] 图谱配色 {name} -> #{rgb:06X}")
    if not created and not colored:
        print("[ok]     所有方向都已有索引笔记与图谱配色。")
    elif not apply:
        print("[scaffold] Dry-run：加 --apply 才写入。")


def sync_relations(wiki_root: str, apply: bool) -> None:
    """Push tools/relation_vocabulary.yml into both relation-aware plugins.

    Each plugin keeps its own copy of the edge-type list, so the vocabulary and the
    plugin can silently disagree — a relation the notes use but the plugin does not
    know about simply draws nothing, with no error anywhere. Both halves run
    independently: one plugin being absent or already current must not skip the other.
    """
    root = Path(wiki_root).resolve()
    relations = relation_vocabulary()
    if not relations:
        print("[warn] tools/relation_vocabulary.yml 读不到关系定义，跳过。")
        return
    _sync_breadcrumbs(root, relations, apply)
    _sync_extended_graph(root, relations, apply)


def _sync_breadcrumbs(root: Path, relations: dict[str, dict], apply: bool) -> None:
    """Edge fields, field groups and implied inverse edges for Breadcrumbs.

    Owns those three relation-derived keys and leaves every other setting (view
    layout, sort, debug level — what the user tweaks in the UI) alone.

    `implied_relations.transitive` is how Breadcrumbs derives inverse edges: one hop
    along `extends`, closed by a reversed `extended-by`, gives the target that edge
    back without anyone authoring it. Symmetric relations close with themselves.

    Replacing the field groups orphans Breadcrumbs' stock view config, which points
    at the built-in `ups`/`downs` groups — a view aimed at a group that no longer
    exists just renders empty, with nothing to explain why. So any view reference to
    an unknown group is repointed at the defaults below; references the user has
    since set to real groups are left as they are.
    """
    data_path = root / ".obsidian" / "plugins" / "breadcrumbs" / "data.json"
    if not data_path.parent.is_dir():
        print("[warn] Breadcrumbs 插件未安装，跳过。")
        return

    authored = list(relations)
    derived = sorted({spec["inverse"] for spec in relations.values()} - set(relations))
    # `contains` is not a claim about a paper, it is the vault's own containment tree:
    # the folder_note source (BC-folder-note-field in an 【索引】 note's frontmatter)
    # makes that note the parent of every note in its folder, so the 方向 → 论文
    # hierarchy becomes typed edges with nothing authored per paper. It stays *out* of
    # relation_vocabulary.yml on purpose — that vocabulary is for edges a human asserts
    # from a paper's text, and putting `contains` in it would both mint a pointless
    # "只看 contains" relation state and make the field a legal hand-written key that
    # lint stops warning about. Breadcrumbs rejects any field missing from
    # `edge_fields` (invalid_edge_field, thrown per index note), so declare it here.
    structural = ["contains", "indexed-by"]
    fields = authored + derived + structural
    desired = {
        "edge_fields": [{"label": f} for f in fields],
        # one group per field (so a view can be narrowed to a single edge type), plus
        # the bulk groups a matrix or a hierarchy view wants
        "edge_field_groups": [{"label": f, "fields": [f]} for f in fields] + [
            {"label": "authored", "fields": authored},
            {"label": "derived", "fields": derived},
            {"label": "structure", "fields": structural}],
        "implied_relations": {"transitive": [
            {"name": "", "rounds": 1, "chain": [{"field": field}],
             "close_field": spec["inverse"], "close_reversed": True}
            for field, spec in relations.items()] + [
            # same trick for the containment tree: authoring `contains` downward gives
            # every paper an `indexed-by` back to its 方向 without touching 131 notes
            {"name": "", "rounds": 1, "chain": [{"field": "contains"}],
             "close_field": "indexed-by", "close_reversed": True}]},
    }
    known = {g["label"] for g in desired["edge_field_groups"]}
    # dotted path inside data.json -> groups to use when the current value is stale.
    # 承接线 is the only relation with a direction worth walking, so it carries the
    # trail and the tree; the matrix shows every type at once.
    view_defaults = {
        "views.page.trail.field_group_labels": ["extends"],
        "views.side.matrix.field_group_labels": fields,
        "views.side.tree.field_group_labels": ["extends", "extended-by"],
        "views.side.tree.find_root_field_group_labels": ["extends"],
        "views.page.prev_next.field_group_labels.prev": [],
        "views.page.prev_next.field_group_labels.next": [],
    }

    current = json.loads(data_path.read_text(encoding="utf-8")) \
        if data_path.exists() else {}
    stale = {k: v for k, v in desired.items() if current.get(k) != v}
    # Breadcrumbs deep-merges saved settings over its defaults, so a view key absent
    # from data.json still resolves — to the stock `ups`/`downs` groups this function
    # just deleted. Absent therefore counts as stale exactly like a dangling value.
    repointed = []
    for path, default in view_defaults.items():
        keys = path.split(".")
        node = current
        for key in keys[:-1]:
            node = node.get(key) if isinstance(node, dict) else None
            if node is None:
                break
        value = node.get(keys[-1]) if isinstance(node, dict) else None
        if not isinstance(value, list) or set(value) - known:
            repointed.append((path, value, default))

    if not stale and not repointed:
        print("[ok]     Breadcrumbs 的边类型已与词表一致。")
        return
    for key in stale:
        print(f"[sync]   Breadcrumbs {key} 与词表不一致，重写")
    for path, was, now in repointed:
        why = "缺省" if was is None else f"指向了不存在的分组 {was}"
        print(f"[sync]   视图 {path} {why} -> {now}")
    print(f"[sync]   边类型：{', '.join(authored)}"
          f"（+ 派生 {', '.join(derived)}）"
          f"（+ 层级 {', '.join(structural)}，由 BC-folder-note-field 派生）")
    if not apply:
        print("[sync]   Dry-run：加 --apply 才写入。")
        return
    for path, _, default in repointed:
        *parents, leaf = path.split(".")
        holder = current
        for key in parents:
            holder = holder.setdefault(key, {})
        holder[leaf] = default
    # is_dirty makes Breadcrumbs rebuild its graph on next load instead of trusting
    # a cache built from the old field list
    data_path.write_text(
        json.dumps({**current, **desired, "is_dirty": True},
                   ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[sync]   已写入 {data_path.relative_to(root)}（重启 Obsidian 生效）")


# states this function owns; anything else in `states` is the user's and is left alone
EG_STATE_PREFIX = "pinakes-"
# the plugin's own id for the always-present fallback state
EG_DEFAULT_STATE = "default-vault"


def _sync_extended_graph(root: Path, relations: dict[str, dict], apply: bool) -> None:
    """Push the vocabulary into Extended Graph: per-relation colors + one state each.

    Extended Graph derives a link's *type* from the frontmatter property it was
    written under (`frontmatterLinks` keyed by `key.split(".")[0]`), which is exactly
    this vault's data model — so the 5 relation fields become 5 filterable, separately
    colored edge types in the core graph with no extra authoring. Unlike Graph Link
    Types it reads a configured color (`interactiveSettings.link.colors`), so the
    vocabulary's `color` is authoritative here.

    A "state" is a named snapshot of the graph's toggles that the user switches from a
    dropdown in the graph toolbar. `toggleTypes` lists the types whose state *differs*
    from `enableByDefault`, so with that default true, listing a type turns it OFF —
    one state per relation therefore means "show only this relation". Each such state
    also hides `none` (the untyped body links, which are the hairball this whole
    exercise exists to escape) and sets `showOrphans: false`, because once only one
    relation is drawn most papers have no edge at all and would sit around the rim as
    dots.

    Two defaults would make the plugin look broken rather than report a problem:
    `maxNodes: 20` makes it **disable itself** with a notice on any larger graph (this
    vault is ~160 nodes), and `enableFeatures.graph.links` is off, so link types are
    simply absent. Both are set here. Only the relation-derived keys and the
    `pinakes-` states are owned; every other setting is the user's.
    """
    data_path = root / ".obsidian" / "plugins" / "extended-graph" / "data.json"
    if not data_path.parent.is_dir():
        print("[warn] Extended Graph 插件未安装，跳过。")
        return
    current = json.loads(data_path.read_text(encoding="utf-8")) \
        if data_path.exists() else {}

    graph_path = root / ".obsidian" / "graph.json"
    core = json.loads(graph_path.read_text(encoding="utf-8")) \
        if graph_path.exists() else {}
    # a state carries a full copy of the core graph's options, so inherit the direction
    # color groups — otherwise switching to a relation state drops them to gray
    def engine_options(**overrides) -> dict:
        opts = {
            "colorGroups": core.get("colorGroups", []), "search": "",
            "hideUnresolved": False, "showAttachments": False, "showOrphans": True,
            "showTags": False, "localBacklinks": True, "localForelinks": True,
            "localInterlinks": False, "localJumps": 1, "lineSizeMultiplier": 1,
            "nodeSizeMultiplier": 1, "showArrow": True, "textFadeMultiplier": 0,
            "centerStrength": 0.518713248970312, "linkDistance": 250,
            "linkStrength": 1, "repelStrength": 10,
        }
        return {**opts, **overrides}

    def state(suffix: str, name: str, hidden: list[str],
              folders: list[str] | None = None, **overrides) -> dict:
        return {
            "id": EG_STATE_PREFIX + suffix, "name": name,
            "enableLayers": False, "currentLayerLevel": 0,
            # listed == differs from enableByDefault == hidden for tag/link (default
            # true), but *shown* for folder (default false) — so `folders` is the
            # allow-list of folders that get a labeled box in this state
            "toggleTypes": {"tag": [], "link": hidden, "folder": folders or []},
            "logicTypes": {"tag": "OR", "link": "OR", "folder": "OR"},
            "pinNodes": {}, "hiddenLegendRows": [], "collapsedLegendRows": [],
            "engineOptions": engine_options(**overrides),
        }

    fields = list(relations)
    # the containment field (see _sync_breadcrumbs): hand-authored on the two root
    # index notes, so Extended Graph sees it as a real typed edge. It belongs in the
    # "全部" and 类目 views — it is the skeleton — but a single-relation state is meant
    # to show exactly one line of argument, so it gets hidden there.
    structural = ["contains"]
    # "none" is Extended Graph's bucket for links with no relation field — i.e. every
    # ordinary wikilink in the prose. Hiding it is what leaves only the typed edges.
    owned = [state("all", "关系：全部（隐藏正文链接）", ["none"])]
    owned += [
        state(field, f"{spec.get('label', field)}：只看 {field}",
              [f for f in fields if f != field] + structural + ["none"],
              showOrphans=False)
        for field, spec in relations.items()
    ]
    owned.append(state("no-competes", "关系：除竞品以外",
                       ["competes", *structural, "none"], showOrphans=False))

    # --- 标签视图 -----------------------------------------------------------
    # The third axis, and the only one that cuts across both others: tags are the
    # vault's one fine-grained retrieval dimension (wiki/AGENTS.md §4), so a #tag node
    # gathers papers no relation edge connects — different 方向, different years. Links
    # stay shown: a note-to-tag connection is an untyped link, so hiding "none" here
    # would hide the only edges this state exists to draw. Orphans off — the handful of
    # notes with no tags at all (看板 / 模板 / log) are not part of the question.
    owned.append(state("tags", "标签：按标签聚类（显示 #tag 节点）", [],
                       showTags=True, showOrphans=False))

    # --- 类目视图：一个方向一个状态 -----------------------------------------
    # The second axis of the graph. A relation state answers "which kind of edge",
    # a category state answers "which corner of the vault" — and the core graph's own
    # search box does the filtering, so `path:` + the state dropdown gives per-方向
    # browsing with no new plugin feature. Untyped links stay *on* here: inside one
    # direction the 【索引】 note's 131 body links are the hierarchy, not noise, so the
    # index shows up as the hub with its papers around it.
    categories = [(p.name, f"papers/{p.name}") for p in direction_dirs(root)]
    categories.append(("deep-research", "deep-research"))
    owned += [
        state(f"dir-{name}", f"类目：{name}", [],
              search=f'path:"{path}"', showOrphans=True)
        for name, path in categories
    ]
    # Folder boxes are a complement, not a filter: the plugin draws a labeled rounded
    # rect around each enabled folder's nodes, so this one state shows the whole vault
    # *with the direction partitions visible* — which clusters are dense in relations
    # and which papers sit far from their own 方向 both read off it directly.
    owned.append(state("folders", "层级：方向分区框（全库）", ["none"],
                       folders=[path for _, path in categories]))

    kept = [s for s in (current.get("states") or [])
            if not str(s.get("id", "")).startswith(EG_STATE_PREFIX)]
    # Writing `states` replaces the plugin's default array, and its settings migration
    # does `states.find(id === "default-vault").name` unguarded — so dropping that
    # entry throws on load. Keep the user's copy if they have one, else recreate it.
    if not any(s.get("id") == EG_DEFAULT_STATE for s in kept):
        kept.insert(0, {**state("", "Default state", []),
                        "id": EG_DEFAULT_STATE,
                        "engineOptions": engine_options(showOrphans=True)})
    # Both the plugin's own default and an earlier version of the line above left this
    # state with showTags on, making it the single view where ~90 #tag nodes crowd in
    # among the 160 notes — and the only state out of 17 that disagrees with the core
    # graph. Tags now have a state of their own, so the default tracks graph.json.
    for kept_state in kept:
        if kept_state.get("id") == EG_DEFAULT_STATE \
                and isinstance(kept_state.get("engineOptions"), dict):
            kept_state["engineOptions"]["showTags"] = False

    notes = len(note_files(root))
    desired = {
        "interactiveSettings": {
            **(current.get("interactiveSettings") or {}),
            "link": {
                **((current.get("interactiveSettings") or {}).get("link") or {}),
                "colormap": "rainbow",
                "colors": [{"type": field, "color": spec["color"], "recursive": False}
                           for field, spec in relations.items()]
                # muted gray on purpose: the containment skeleton should recede behind
                # the relation edges, which are the argument
                + [{"type": "contains", "color": "#6E7681", "recursive": False}],
                "unselected": [], "excludeRegex": {"regex": "", "flags": ""},
                "noneType": "none", "showOnGraph": True, "enableByDefault": True,
            },
            "folder": {
                **((current.get("interactiveSettings") or {}).get("folder") or {}),
                # every paper lives in its own 【年份】slug folder, and 131 one-note
                # boxes in the legend would bury the handful of folders worth drawing
                "excludeRegex": {"regex": "【\\d{4}】", "flags": ""},
                "showOnGraph": True, "enableByDefault": False,
            },
        },
        "enableFeatures": {
            **(current.get("enableFeatures") or {}),
            **{view: {**((current.get("enableFeatures") or {}).get(view) or {}),
                      "auto-enabled": True, "links": True, "folders": True,
                      # without this the label is Obsidian's node id — the full path
                      # *plus* `.md`, which under 「一篇一文件夹」 prints 【year】slug
                      # twice in one label (folder, then file)
                      "names": True}
               for view in ("graph", "localgraph")},
        },
        # the names feature, configured: show the `title` the whole vault is keyed on
        # — 【year】 + the paper's English original title (wiki/AGENTS.md §3). The two
        # fallbacks below only kick in for the handful of notes with no `title`
        # (看板 / 模板 / log) — basename, no extension.
        "usePropertiesForName": ["title"],
        "showOnlyFileName": True, "noExtension": True,
        # a real paper title runs 90 chars and the longest in the vault is 173; printed
        # in full, a dozen nodes' labels overlap into an unreadable mat. 48 keeps the
        # 【year】 prefix and the acronym — which is what identifies the paper at a
        # glance — and drops the subtitle, which hovering the node gives back.
        "numberOfCharacters": 48, "ellipsis": "…",
        # box labels are the folder's own name; the full path is unreadable at
        # graph scale (`papers/01-表示与Tokenization` on a rect that holds 19 dots)
        "folderShowFullPath": False,
        "displayLinkTypeLabel": True, "colorLinkTypeLabel": True,
        # the plugin disables itself above this; keep headroom for new papers
        "maxNodes": max(int(current.get("maxNodes") or 0), notes * 2 + 100),
        "states": kept + owned,
    }

    stale = {k: v for k, v in desired.items() if current.get(k) != v}
    if not stale:
        print("[ok]     Extended Graph 的关系配色与状态已与词表一致。")
        return
    for key in stale:
        print(f"[sync]   Extended Graph {key} 与词表不一致，重写")
    print(f"[sync]   状态：{len(owned)} 个（{'、'.join(s['name'] for s in owned)}）")
    print(f"[sync]   节点上限 {desired['maxNodes']}（当前 {notes} 篇论文；"
          "超限插件会自我禁用）")
    if not apply:
        print("[sync]   Dry-run：加 --apply 才写入。")
        return
    data_path.write_text(json.dumps({**current, **desired},
                                    ensure_ascii=False, indent=2) + "\n",
                         encoding="utf-8")
    print(f"[sync]   已写入 {data_path.relative_to(root)}（重启 Obsidian 生效）")


# 方向索引里的论文列表 = 一张表(2026-10-13 起):论文 / 年份 / 关键词 / 简介。
# 一列一件事比"标题 + 标签 + 引用块三段"更好扫;Advanced Tables 插件在本库里,排序/对齐都现成。
INDEX_COLUMNS = ("论文", "年份", "关键词", "简介")


def _cell(value: object) -> str:
    """表格单元格:去掉换行、转义竖线(否则整行表格会错位)。"""
    return str(value or "").replace("|", "\\|").replace("\n", " ").strip()


def index_header(columns=None) -> str:
    """表头 + 分隔行。空方向也写它 —— 让 rebuild 的 diff 稳定。
    columns 由 schema 提供（wiki/_schema/kinds.yml 的 direction.index_columns）。"""
    cols_list = list(columns or INDEX_COLUMNS)
    cols = " | ".join(cols_list)
    sep = " | ".join("---" for _ in cols_list)
    return f"| {cols} |\n| {sep} |"


def _index_entry(folder: Path, meta: dict) -> str:
    """One direction-index table row, derived entirely from the note's frontmatter."""
    title = _cell(meta.get("title") or folder.name)
    year = _cell(meta.get("year") or "")
    # one tag per backtick span: a span holding several `#a #b` renders as a single
    # inline-code blob in Obsidian instead of separate tag chips.
    tags = " ".join(f"`#{t}`" for t in (meta.get("tags") or []))
    summary = _cell(meta.get("table_summary") or "")
    return f"| [{title}]({folder.name}/{folder.name}.md) | {year} | {tags} | {summary} |"


def rebuild_index(wiki_root: str, apply: bool, only: str | None = None) -> None:
    """Regenerate each direction index's `## 论文` list from the paper frontmatter.

    Everything above the `## 论文` heading (frontmatter, intro blurb) is hand-written
    and preserved verbatim; the list below it is derived, so the index can never
    drift from the notes' `title` / `tags` / `table_summary` again. Papers are
    ordered by folder name's slug, matching the existing hand-curated order.
    A direction folder with no index note yet gets one scaffolded first, so adding
    a folder and running this once is all it takes. Dry-run unless --apply.
    """
    root = Path(wiki_root).resolve()
    scaffold(wiki_root, apply)
    changed, untouched = [], []
    try:
        import schema as schema_mod
        compiled = schema_mod.load_compiled(root) or schema_mod.compile_schema(schema_mod.load_schema(root))
        cols = (compiled.get("kinds", {}).get("direction", {}) or {}).get("index_columns") or None
    except Exception:
        cols = None

    for direction in direction_dirs(root):
        if only and direction.name != only:
            continue
        index = index_note(direction)
        if not index.exists():
            print(f"[skip]   {direction.name}（无方向索引 {index.name}）")
            continue
        text = index.read_text(encoding="utf-8")
        m = PAPERS_HEADING_RE.search(text)
        if not m:
            print(f"[skip]   {direction.name}（索引里找不到 `{PAPERS_HEADING}` 小节）")
            continue

        head = text[:m.end()]

        entries = []
        for folder in sorted((p for p in direction.iterdir() if p.is_dir()),
                             key=lambda p: re.sub(r"^【\d+】", "", p.name)):
            note = folder / f"{folder.name}.md"
            if note.exists():
                entries.append(_index_entry(folder, frontmatter(note)))

        rebuilt = head + "\n\n" + index_header(cols) + "\n" + "\n".join(entries) + "\n"
        if rebuilt == text:
            untouched.append(direction.name)
        else:
            changed.append((index, text, rebuilt, len(entries)))

    for name in untouched:
        print(f"[ok]     {name}（已是最新）")
    for index, old, new, count in changed:
        print(f"\n[rebuild] {index.parent.name}: {count} 条条目")
        diff = list(difflib.unified_diff(
            old.splitlines(), new.splitlines(), lineterm="", n=0))
        for line in diff[2:]:  # drop the ---/+++ header
            if line.startswith("@@"):
                continue
            print(f"    {line[:160]}")

    if not changed:
        print("\n所有方向索引均已与 frontmatter 一致。")
        return
    if not apply:
        print(f"\nDry-run：{len(changed)} 个方向索引待重建。加 --apply 执行。")
        return
    for index, _old, new, _count in changed:
        index.write_text(new, encoding="utf-8")
    print(f"\n已重建 {len(changed)} 个方向索引。")


def _yaml_str(value: str) -> str:
    """Quote a scalar so it survives YAML round-tripping.

    json.dumps gives us the double-quoted form with `"` and `\\` escaped, which
    is exactly YAML's double-quoted style — this is what stops a title holding a
    quote character from terminating the scalar and killing the whole block.
    """
    return json.dumps(value, ensure_ascii=False)


def new_note(
    wiki_root: str, direction: str, year: str, slug: str, *,
    pdf: str | None, title: str, paper_title: str, authors: str,
    org: str, tags: str, summary: str,
) -> None:
    """Scaffold a spec-conforming stub note for one new paper.

    Creates papers/<direction>/【year】<slug>/【year】<slug>.md with the required
    frontmatter (title 自动带 【year】 前缀) + the base section skeleton from
    wiki/AGENTS.md §6 (a free-form body; §6 is only a starter template), and copies the PDF beside it. The direction index is NOT
    touched here — it is derived, so run `rebuild-index --apply` afterwards.
    Fill in the body by hand or with an AI agent.
    """
    root = Path(wiki_root)
    dir_name = direction.strip().strip("/")
    direction_dir = root / "papers" / dir_name
    if not direction_dir.is_dir():
        raise SystemExit(f"方向不存在: papers/{dir_name}")
    if not index_note(direction_dir).exists():
        raise SystemExit(
            f"方向索引缺失: {direction_dir / (INDEX_PREFIX + dir_name)}.md"
            f"（跑 `research_wiki.py scaffold {wiki_root} --apply` 生成）")

    slug = slug.strip().lower().replace(" ", "-")
    folder_name = f"【{year}】{slug}"
    folder = direction_dir / folder_name
    note = folder / f"{folder_name}.md"
    if folder.exists():
        raise SystemExit(f"已存在，不覆盖: {folder.relative_to(root)}")

    # `title` is the paper's English original title (wiki/AGENTS.md §3), so
    # --paper-title alone is enough — pass --title only to prefix the acronym the
    # paper's own title often omits ("TIGER: Recommender Systems with Generative…").
    display = (title or paper_title or slug).strip()
    tags_list = _split_list(tags)
    canonical, aliases = tag_vocabulary()
    tags_list = [aliases.get(t, t) for t in tags_list]
    if canonical:
        for t in tags_list:
            if t not in canonical:
                print(f"[warn] 标签 `{t}` 不在 tools/tag_vocabulary.yml 词表里，"
                      "请先把它加进对应 axis，或换一个已有角度。")
    if not 2 <= len(tags_list) <= 4:
        print(f"[warn] --tags 给了 {len(tags_list)} 个，规范要求 2–4 个核心方法角度。")
    if not summary.strip():
        print("[warn] 未提供 --summary：table_summary 是必填字段，方向索引的摘要行靠它生成。")

    pdf_name = ""
    if pdf:
        src = Path(pdf)
        if not src.exists():
            raise SystemExit(f"PDF 不存在: {src}")
        # PDF 与笔记同名(【year】slug.pdf):名字统一,目录里一眼知道谁是谁的
        pdf_name = f"【{year}】{slug}.pdf"

    folder.mkdir(parents=True)
    if pdf:
        shutil.copy2(src, folder / pdf_name)  # copy: raw/ 等源目录保持只读

    # 两个"我读到哪了/值不值得深挖"的字段放最前:笔记属性面板里一眼能看到。
    # 之后是 required → recommended → optional,顺序对齐 AGENTS.md §3
    fm = ["---",
          "importance: 1",
          "reading: 未读",                       # 取值就是中文(见 wiki/AGENTS.md §3.3)
          f"direction: {_yaml_str(f'[[【索引】{dir_name}]]')}",
          f"title: {_yaml_str(f'【{year}】{display}')}",
          f"slug: {_yaml_str(slug)}",
          f"year: {year}",
          f"pdf: {_yaml_str(pdf_name)}",
          f"tags: [{', '.join(tags_list)}]",
          f"table_summary: {_yaml_str(summary.strip())}",
          f"authors: [{', '.join(_yaml_str(a) for a in _split_list(authors))}]"]
    # 不再写 paper_title:title 里已经含英文原题全文,两个字段是同一件事(2026-10 去重)
    if org:
        fm.append(f"organization: {_yaml_str(org)}")
    fm.append("---")

    # 正文是自由区(2026-10 起):这里只给一个起步模板 —— 写什么、分不分小节都由记录的人决定。
    # 机器可读的状态全在 frontmatter(属性面板里能改的那个),正文不会被任何工具解析。
    body = f"""
> [!note] 📄 原文 PDF：[[{pdf_name}|在侧栏打开原文]]

## 整体综述

（自由记录：这篇在解什么问题、关键机制、值不值得深读。下面几节只是起步建议，随意增删改名。）

## 论文信息
- 标题：{paper_title or display}
- 年份：{year}
- 原文：[{pdf_name}]({pdf_name})

## 路径
- [返回方向页](../{INDEX_PREFIX}{dir_name}.md)
"""
    note.write_text("\n".join(fm) + "\n" + body, encoding="utf-8")

    print(f"[new] 已创建 {note.relative_to(root)}")
    if not pdf:
        print("[warn] 未提供 --pdf：pdf 字段为空，lint 会报错，补一个 PDF 进该文件夹后再校验。")
    print("\n下一步：")
    print("  1. 填正文（自由区，见 wiki/AGENTS.md §6：起步模板已生成，写什么随意）")
    print(f"  2. python3 tools/research_wiki.py rebuild-index {wiki_root} --apply  # 生成索引条目")
    print(f"  3. python3 tools/lint.py --wiki-dir {wiki_root}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Pinakes helpers")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("stats").add_argument("wiki_root")
    log = sub.add_parser("log")
    log.add_argument("wiki_root")
    log.add_argument("message")
    search_cmd = sub.add_parser("search")
    search_cmd.add_argument("wiki_root")
    search_cmd.add_argument("query")
    resync_cmd = sub.add_parser(
        "resync", help="re-derive folder/file names from frontmatter year+slug")
    resync_cmd.add_argument("wiki_root")
    resync_cmd.add_argument("--apply", action="store_true",
                            help="execute renames (default is dry-run)")
    rebuild_cmd = sub.add_parser(
        "rebuild-index", help="regenerate direction indexes from paper frontmatter")
    rebuild_cmd.add_argument("wiki_root")
    rebuild_cmd.add_argument("--apply", action="store_true",
                             help="write the indexes (default is dry-run)")
    rebuild_cmd.add_argument("--direction", default=None,
                             help="只重建这一个方向")
    scaffold_cmd = sub.add_parser(
        "scaffold", help="为新方向文件夹补索引笔记 + 图谱配色（rebuild-index 会自动带上）")
    scaffold_cmd.add_argument("wiki_root")
    scaffold_cmd.add_argument("--apply", action="store_true",
                              help="写入（default is dry-run）")
    rel_cmd = sub.add_parser(
        "sync-relations", help="把 tools/relation_vocabulary.yml 推进 Breadcrumbs 配置")
    rel_cmd.add_argument("wiki_root")
    rel_cmd.add_argument("--apply", action="store_true",
                         help="写入（default is dry-run）")
    new_cmd = sub.add_parser("new", help="scaffold a规范 stub note for one new paper")
    new_cmd.add_argument("wiki_root")
    new_cmd.add_argument("--direction", required=True, help="如 02-生成式建模与架构")
    new_cmd.add_argument("--year", required=True)
    new_cmd.add_argument("--slug", required=True, help="kebab-case 英文 id")
    new_cmd.add_argument("--pdf", help="源 PDF 路径（拷贝进笔记文件夹，源文件不动）")
    new_cmd.add_argument("--title", default="",
                         help="显示名（英文原题，可前置缩写 `TIGER: …`；"
                              "自动加 【year】 前缀；省略则用 --paper-title）")
    new_cmd.add_argument("--paper-title", default="", dest="paper_title",
                         help="英文原题（title 的来源）")
    new_cmd.add_argument("--authors", default="",
                         help="逗号分隔的完整姓名，如 \"Bowen Zheng, Wayne Xin Zhao\"")
    new_cmd.add_argument("--org", default="", help="机构")
    new_cmd.add_argument("--tags", required=True,
                         help="逗号分隔的 2-4 个核心角度（取自 tools/tag_vocabulary.yml）")
    new_cmd.add_argument("--summary", required=True,
                         help="一句话 table_summary：问题 + 关键方法")
    args = parser.parse_args()
    if args.command == "log":
        append_log(args.wiki_root, args.message)
    elif args.command == "search":
        search(args.wiki_root, args.query)
    elif args.command == "resync":
        resync(args.wiki_root, args.apply)
    elif args.command == "rebuild-index":
        rebuild_index(args.wiki_root, args.apply, args.direction)
    elif args.command == "sync-relations":
        sync_relations(args.wiki_root, args.apply)
    elif args.command == "scaffold":
        scaffold(args.wiki_root, args.apply)
    elif args.command == "new":
        new_note(
            args.wiki_root, args.direction, args.year, args.slug,
            pdf=args.pdf, title=args.title, paper_title=args.paper_title,
            authors=args.authors, org=args.org, tags=args.tags,
            summary=args.summary,
        )
    else:
        stats(args.wiki_root)


if __name__ == "__main__":
    main()
