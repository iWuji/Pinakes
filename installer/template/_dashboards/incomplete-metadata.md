# 待补全元数据

> 编辑工作清单：frontmatter 还没达到 `wiki/AGENTS.md` §3/§4 要求的论文。
> 判定标准：`table_summary` 为空、或 `tags` 不足 2 个。补齐后自动从本表消失。

```dataview
TABLE WITHOUT ID
  link(file.path, title) AS "论文",
  year AS "年份",
  choice(table_summary, "✓", "—") AS "一句话",
  length(tags) AS "标签数"
FROM "papers"
WHERE year AND slug
  AND (!table_summary OR length(tags) < 2)
SORT year DESC, title ASC
```

## 标签超量（> 4 个）

```dataview
TABLE WITHOUT ID
  link(file.path, title) AS "论文",
  tags AS "标签"
FROM "papers"
WHERE length(tags) > 4
SORT title ASC
```
