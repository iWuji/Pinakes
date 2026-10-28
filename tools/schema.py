#!/usr/bin/env python3
"""Schema 层：把 `wiki/_schema/{kinds,fields}.yml` 编译成插件可读的 JSON。

设计要点（见 Pinakes/ENTITY_MODEL.md）：
  * `wiki/_schema/*.yml` 是**唯一真源**（人可读、AI 可改）；
  * `wiki/_schema/.compiled.json` 是**派生产物**，插件（JS）只读它，
    这样插件不需要 YAML 解析器，Python 与 JS 也不会各写一套约定；
  * lint 检查编译产物是否过期（`schema-stale`），和索引的 `index-stale` 同一套路。

用法：
  schema = load_schema(wiki_root)          # 读 yml(权威)
  compiled = compile_schema(schema)        # dict → JSON 结构
  write_compiled(wiki_root, compiled)      # 写 .compiled.json
  off = compiled["detect"]                 # 路径 → kind
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import yaml

SCHEMA_DIR = "_schema"
KINDS_FILE = "kinds.yml"
FIELDS_FILE = "fields.yml"
COMPILED_FILE = ".compiled.json"


# --------------------------------------------------------------------------
# 读取
# --------------------------------------------------------------------------

def schema_dir(wiki_root: str | Path) -> Path:
    return Path(wiki_root) / SCHEMA_DIR


def load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def load_schema(wiki_root: str | Path) -> dict:
    """读权威 YAML（缺失时返回空 schema —— 工具退化为旧行为）。"""
    d = schema_dir(wiki_root)
    kinds = load_yaml(d / KINDS_FILE)
    fields = load_yaml(d / FIELDS_FILE)
    return {"kinds_doc": kinds, "fields_doc": fields}


def compile_schema(schema: dict) -> dict:
    """把两份 YAML 合成插件/CLI 用的紧凑结构。"""
    kd = schema.get("kinds_doc") or {}
    fd = schema.get("fields_doc") or {}

    kinds = {}
    for name, spec in (kd.get("kinds") or {}).items():
        spec = spec or {}
        kinds[name] = {
            "id": name,
            "description": spec.get("description", ""),
            "rep": spec.get("rep"),
            "children_section": spec.get("children_section"),
            "children_sections": (spec.get("children_sections")
                                 or ([spec["children_section"]] if spec.get("children_section") else [])),
            "default_depth": str(spec.get("default_depth", "self")),
            "leaf": bool(spec.get("leaf", False)),
            "naming": spec.get("naming"),
            "naming_fields": spec.get("naming_fields") or [],
            "member_kind": spec.get("member_kind"),
            "index_columns": spec.get("index_columns") or [],
            # 行为声明(插件按 kind 驱动 UI,不再写死科研路径):
            #   status_field = 进度轴字段(详情卡/树徽标);root_dir = 实体树所在顶层目录
            "status_field": spec.get("status_field"),
            "root_dir": spec.get("root_dir"),
        }

    fields = []
    for f in (fd.get("fields") or []):
        if not f or not f.get("id"):
            continue
        fields.append({
            "id": f["id"],
            "type": f.get("type", "string"),
            "values": f.get("values"),
            "source": f.get("source"),
            "min": f.get("min"),
            "max": f.get("max"),
            "default": f.get("default"),
            "applies_to": f.get("applies_to") or [],
            "encode": f.get("encode"),
            "role": f.get("role"),
            "required": bool(f.get("required", False)),
            "description": f.get("description", ""),
        })

    return {
        "schema_version": int(kd.get("schema_version") or fd.get("schema_version") or 1),
        "scan": {
            "skip_dirs": (kd.get("scan") or {}).get("skip_dirs") or [],
            "skip_files": (kd.get("scan") or {}).get("skip_files") or [],
            "rep_patterns": (kd.get("scan") or {}).get("rep_patterns") or [],
        },
        "kinds": kinds,
        "detect": kd.get("detect") or [],
        "fields": fields,
        "deprecated": fd.get("deprecated") or [],
        "unknown": fd.get("unknown") or {"policy": "collect", "promote_hint_after": 3},
    }


def write_compiled(wiki_root: str | Path, compiled: dict) -> Path:
    path = schema_dir(wiki_root) / COMPILED_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(compiled, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def load_compiled(wiki_root: str | Path) -> dict | None:
    path = schema_dir(wiki_root) / COMPILED_FILE
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def ensure_compiled(wiki_root: str | Path, apply: bool = False) -> tuple[dict, bool]:
    """返回 (compiled, 是否有变更)。apply=True 时写回。"""
    compiled = compile_schema(load_schema(wiki_root))
    existing = load_compiled(wiki_root)
    changed = existing != compiled
    if changed and apply:
        write_compiled(wiki_root, compiled)
    return compiled, changed


# --------------------------------------------------------------------------
# 查询
# --------------------------------------------------------------------------

def kind_of(compiled: dict, path: str) -> str | None:
    """按 detect 规则推断路径的 kind（第一条命中）。"""
    for rule in compiled.get("detect") or []:
        rx = rule.get("path_regex")
        if rx and re.search(rx, path):
            return rule.get("kind")
    return None


def spec_of(compiled: dict, kind: str | None) -> dict:
    return (compiled.get("kinds") or {}).get(kind or "", {})


def depth_of(compiled: dict, meta: dict | None, kind: str | None) -> str:
    """实例 depth 覆盖 kind 默认值。"""
    meta = meta or {}
    d = meta.get("depth")
    if d is not None and str(d).strip() != "":
        return str(d).strip()
    return str(spec_of(compiled, kind).get("default_depth") or "self")


def children_section(compiled: dict, kind: str | None) -> str | None:
    return spec_of(compiled, kind).get("children_section")


def field_spec(compiled: dict, field_id: str) -> dict | None:
    for f in compiled.get("fields") or []:
        if f.get("id") == field_id:
            return f
    return None


def known_field_ids(compiled: dict) -> set[str]:
    return {f["id"] for f in compiled.get("fields") or []}


def fields_for(compiled: dict, kind: str | None) -> list[dict]:
    out = []
    for f in compiled.get("fields") or []:
        applies = f.get("applies_to") or []
        if not applies or kind in applies:
            out.append(f)
    return out
