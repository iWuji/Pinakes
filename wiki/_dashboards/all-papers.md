# 全部论文

> Dataview 动态表格。在 Obsidian 中打开本 vault 并启用 Dataview 插件后自动渲染。
> 真源是每篇论文的 frontmatter（见 `wiki/AGENTS.md` §3）——改那里，这里实时更新。

```dataview
TABLE WITHOUT ID
  link(file.path, title) AS "论文",
  year AS "年份",
  choice(importance, importance, "—") AS "重要",
  choice(reading, reading, "未读") AS "阅读",
  direction AS "主方向",
  sub_directions AS "子方向",
  tags AS "标签",
  table_summary AS "一句话"
FROM "papers"
WHERE year AND slug
SORT importance DESC, year DESC, title ASC
```
