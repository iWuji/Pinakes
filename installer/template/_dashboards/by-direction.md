# 按方向浏览

> 按一级方向分组统计。`_unfiled` 不是方向,是待归档分区(todolist);它单独一张表列在下面,
> 不和方向混在一起排序。

```dataview
TABLE WITHOUT ID
  length(rows) AS "论文数",
  map(rows, (r) => link(r.file.path, r.title)) AS "论文"
FROM "papers"
WHERE year AND slug AND !contains(file.folder, "papers/_unfiled")
GROUP BY split(regexreplace(file.folder, "^papers/", ""), "/")[0] AS "方向"
SORT length(rows) DESC
```

## 待归档

> 已入库但还没定方向的 stub。清空后这张表为空,分区本身仍然存在。

```dataview
TABLE WITHOUT ID
  link(file.path, title) AS "论文",
  year AS "年份",
  table_summary AS "简介"
FROM "papers/_unfiled"
WHERE year AND slug
SORT year DESC
```
