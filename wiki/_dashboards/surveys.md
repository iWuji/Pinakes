# 综述 / 技术报告(doc_type)

> Dataview 动态表格。`doc_type` 是**与方向正交**的第二个维度:方向答"讲什么",
> 它答"什么体裁"。综述不单独立成方向 —— 学科分类按方法/对象切(arXiv 无子类,
> ACM CCS 没有 surveys 节点),一篇综述永远属于某个主题(见 `wiki/AGENTS.md` §3.6)。
> 真源仍是每篇的 frontmatter。

```dataview
TABLE WITHOUT ID
  link(file.path, title) AS "论文",
  doc_type AS "体裁",
  year AS "年份",
  direction AS "主方向",
  tags AS "标签",
  table_summary AS "一句话"
FROM "papers"
WHERE doc_type
SORT doc_type ASC, year DESC, title ASC
```

## 技术报告一览(工业界的 one-model / 系统论文)

```dataview
TABLE WITHOUT ID
  link(file.path, title) AS "论文", year AS "年份", direction AS "主方向", table_summary AS "一句话"
FROM "papers"
WHERE doc_type = "technical-report"
SORT year DESC, title ASC
```
