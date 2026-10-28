# 阅读队列

> 按阅读状态 + 重要度看论文。真源仍是每篇的 frontmatter(`reading` / `importance`,见
> `wiki/AGENTS.md` §3.3)——
> 在 Pinakes 的详情卡里点选、或直接在笔记属性面板改,不用手写 YAML。

## 在读(手上正在啃的)

```dataview
TABLE WITHOUT ID
  link(file.path, title) AS "论文",
  importance AS "重要",
  year AS "年份",
  tags AS "标签",
  table_summary AS "一句话"
FROM "papers"
WHERE year AND slug AND reading = "在读"
SORT importance DESC, year DESC
```

## 已读 / 精读(读过一遍以上)

```dataview
TABLE WITHOUT ID
  link(file.path, title) AS "论文",
  choice(importance, importance, "—") AS "重要",
  reading AS "状态",
  year AS "年份",
  tags AS "标签"
FROM "papers"
WHERE year AND slug AND contains(list("已读", "精读"), reading)
SORT importance DESC, year DESC
```

## 未读 · 按重要度排(挑下一篇挑这里)

```dataview
TABLE WITHOUT ID
  link(file.path, title) AS "论文",
  importance AS "重要",
  year AS "年份",
  tags AS "标签",
  table_summary AS "一句话"
FROM "papers"
WHERE year AND slug AND (!reading OR reading = "未读")
SORT importance DESC, year DESC, title ASC
```

## 各状态计数

```dataview
TABLE WITHOUT ID
  choice(reading, reading, "未读") AS "状态",
  length(rows) AS "篇数"
FROM "papers"
WHERE year AND slug
GROUP BY choice(reading, reading, "未读")
SORT length(rows) DESC
```

## 待标注(缺 reading 或 importance)

```dataview
TABLE WITHOUT ID
  link(file.path, title) AS "论文",
  year AS "年份"
FROM "papers"
WHERE year AND slug AND (!reading OR !importance)
SORT year DESC, title ASC
```
