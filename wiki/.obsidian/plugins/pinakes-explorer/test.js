"use strict";
/* Pinakes 数据层测试(node 跑,vault 只读)。
 * 用法: node test.js <vault绝对路径>
 */
const fs = require("fs");
const path = require("path");
const data = require("./main.js");

const VAULT = process.argv[2];
if (!VAULT || !fs.existsSync(VAULT)) { console.error("用法: node test.js <vault路径>"); process.exit(2); }

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log("  ✓ " + name);
  else { failed++; console.log("  ✗ " + name + (detail ? "  → " + detail : "")); }
}

// ---- 读 vault(与 Obsidian 的 getMarkdownFiles 同口径:全部 md,数据层自己过滤) ----
const records = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const rel = path.relative(VAULT, p).split(path.sep).join("/");
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (!name.startsWith(".")) walk(p); continue; }
    if (name.endsWith(".md")) records.push({ path: rel, basename: name.replace(/\.md$/, ""), content: fs.readFileSync(p, "utf8") });
  }
})(VAULT);
console.log(`vault md 数(含 dashboard/模板/log/AGENTS): ${records.length}`);

// 真实 vault 的索引用**编译后的 schema**构建（与插件同一份真源）。
let realSchema = null;
try {
  realSchema = JSON.parse(fs.readFileSync(path.join(VAULT, "_schema", ".compiled.json"), "utf8"));
} catch (e) { realSchema = null; }

const index = data.buildWikiIndex(records, { schema: realSchema || undefined });
console.log("\n== Schema：kind 推断与容器小节（单一真源）==");
{
  const sc = realSchema || data.DEFAULT_SCHEMA;
  check("编译产物存在且含 kinds / detect",
    !!realSchema && Object.keys(sc.kinds || {}).length >= 9 && (sc.detect || []).length >= 9,
    realSchema ? Object.keys(sc.kinds).join(",") : "缺少 _schema/.compiled.json");

  const cases = [
    ["papers/【索引】papers.md", "library"],
    ["papers/【索引】llm4rec.md", "domain"],
    ["papers/llm4rec-02-模型与架构/【索引】llm4rec-02-模型与架构.md", "direction"],
    ["papers/_unfiled/【索引】_unfiled.md", "partition"],
    ["papers/llm4rec-02-模型与架构/【2026】oneranker/【2026】oneranker.md", "paper"],
    ["deep-research/【索引】深度调研专题总览.md", "topic_library"],
    ["deep-research/gr-taxonomy/【Deep Research】生成式推荐分类体系调研.md", "topic"],
    ["ideas/【索引】Ideas.md", "idea_library"],
    ["ideas/anchorgr/【索引】AnchorGR 方案包.md", "idea_package"],
    ["ideas/anchorgr/【idea】AnchorGR.md", "idea"],
  ];
  const wrong = cases.filter(([p, k]) => data.kindOfPath(sc, p) !== k);
  check("按路径推断 kind（10 个真实路径）", wrong.length === 0, JSON.stringify(wrong));

  check("容器小节按 kind 声明（library 有两节：大类别 + 待归档）",
    JSON.stringify(data.sectionsForKind(sc, "library")) === JSON.stringify(["## 大类别", "## 待归档"]) &&
    JSON.stringify(data.sectionsForKind(sc, "domain")) === JSON.stringify(["## 方向"]) &&
    JSON.stringify(data.sectionsForKind(sc, "direction")) === JSON.stringify(["## 论文"]));

  check("paper 是叶子 kind（没有子节点小节）",
    data.sectionsForKind(sc, "paper").length === 0 && sc.kinds.paper.default_depth === "full");
}

console.log("\n== 索引结构 ==");
// 内容级断言只在**完整库**(作者本人的 wiki,论文数多)下跑;新 clone / 骨架库
// 只有结构性文件,只跑纯函数与 schema 断言(下面的 FULL_VAULT 分支全部跳过)。
const FULL_VAULT = records.filter((r) => r.path.startsWith("papers/") &&
  r.path.split("/").length >= 3).length >= 50;
if (FULL_VAULT) console.log("  (完整库模式:内容断言全开)");
else console.log("  (骨架库模式:跳过内容断言 —— 这是公开仓库的正常形态)");
check("根笔记被识别", !!index.root, JSON.stringify(index.root && index.root.path));
check("根 = 研究总览", index.root && index.root.path === "【索引】研究总览.md");
check("根的一级子节点 = 3(papers / DR总览 / Ideas)",
  index.root && index.root.children.length === 3,
  index.root && JSON.stringify(index.root.children.map((c) => index.nodes.get(c).basename)));
const papersNode = index.byBasename.get("【索引】papers");
check("papers 容器节点存在(FULL_VAULT 时 children = 5:4 个域 + 待归档)",
  !!papersNode && (!FULL_VAULT || (papersNode.children.length === 5 &&
    papersNode.children.every((c) => ["【索引】llm4rec", "【索引】deeprec", "【索引】genmodel", "【索引】llm", "【索引】_unfiled"].includes(index.nodes.get(c).basename)))),
  papersNode && JSON.stringify(papersNode.children.map((c) => index.nodes.get(c).basename)));
if (FULL_VAULT) check("三个域的 parent 都是 papers 容器",
  ["【索引】llm4rec", "【索引】deeprec", "【索引】genmodel"].every((b) => index.byBasename.get(b).parent === "papers/【索引】papers.md"));

// genmodel 是非推荐域:通用生成模型方法(扩散/流匹配/能量模型/分布蒸馏)。
const genmodel = index.byBasename.get("【索引】genmodel");
if (FULL_VAULT) check("genmodel 域存在且列出 3 个方向",
  !!genmodel && genmodel.children.length === 3,
  genmodel && JSON.stringify(genmodel.children.map((c) => index.nodes.get(c).basename)));
check("无 basename 碰撞", index.basenameCollisions === 0, String(index.basenameCollisions));
check("无断链 wikilink", index.dangling.length === 0, index.dangling.slice(0, 5).join("; "));

// 域(大类别)是**索引笔记**而不是文件夹(2026-10-13 定):`papers/【索引】<域>.md`,
// 它的 `## 方向` 小节列出本域方向 —— 这层层级靠 sectionNoteLinks 重挂,目录树给不出。
const domain = index.byBasename.get("【索引】llm4rec");
if (FULL_VAULT) {
  check("llm4rec 域索引笔记存在(且是 papers/ 顶层的一篇笔记)",
    !!domain && domain.path === "papers/【索引】llm4rec.md", domain && domain.path);
  check("域总览 children = 8(只有方向;待归档不是方向,挂在 papers 容器下)—— 由 `## 方向` 链接驱动",
    domain && domain.children.length === 8,
    domain && JSON.stringify(domain.children.map((c) => index.nodes.get(c).basename)));
  check("域的子节点 parent 都指向域笔记(链接重挂生效)",
    domain && domain.children.every((c) => index.nodes.get(c).parent === domain.path));
}

// `_unfiled` 是论文库里唯一的非方向分区(todolist),由 papers 容器的 `## 待归档` 挂载。
const unfiled = index.byBasename.get("【索引】_unfiled");
check("待归档是独立分区:parent 指向 papers 容器,不在任何域下",
  !!unfiled && unfiled.parent === "papers/【索引】papers.md",
  unfiled && unfiled.parent);
if (domain) check("待归档没有挂在 llm4rec 域下",
  !!domain && !domain.children.includes(unfiled && unfiled.path));
else check("待归档没有挂在 llm4rec 域下(骨架库:没有域,天然成立)", true);

const dDeeprec = index.byBasename.get("【索引】deeprec-01-多兴趣检索");
if (FULL_VAULT) {
  check("deeprec 域方向存在", !!dDeeprec);
  check("deeprec 方向 children = 20 篇(判别式经典)",
    dDeeprec && dDeeprec.children.length === 20,
    dDeeprec && String(dDeeprec.children.length));
  check("deeprec 方向挂在 deeprec 域下", dDeeprec && dDeeprec.parent === "papers/【索引】deeprec.md",
    dDeeprec && dDeeprec.parent);
}

// 七分类的方向都在,且每个方向都挂在它的域下
const DIRECTIONS = [
  "llm4rec-01-表示与Tokenization", "llm4rec-02-模型与架构", "llm4rec-03-训练目标与偏好对齐",
  "llm4rec-04-用户理解与行为建模", "llm4rec-05-Reasoning推理", "llm4rec-06-Agentic智能体",
  "llm4rec-07-数据部署与评测",
];
if (FULL_VAULT) {
  check("七分类方向齐全", DIRECTIONS.every((d) => index.byBasename.has("【索引】" + d)),
    DIRECTIONS.filter((d) => !index.byBasename.has("【索引】" + d)).join(", "));
  check("七个方向的 parent 都是 llm4rec 域",
    DIRECTIONS.every((d) => index.byBasename.get("【索引】" + d).parent === "papers/【索引】llm4rec.md"));
}

// 全部论文笔记都应挂在某个方向索引下
let paperCount = 0;
for (const n of index.nodes.values()) {
  if (n.path.startsWith("papers/") && n.direction && n.direction !== "papers" &&
      !data.REP_RE.test(n.basename)) paperCount++;
}
if (FULL_VAULT) check("papers/ 论文笔记总数 = 459", paperCount === 459, String(paperCount));

console.log("\n== 关系边 ==");
const relCounts = {};
for (const e of index.edges) relCounts[e.type] = (relCounts[e.type] || 0) + 1;
console.log("  按类型:", JSON.stringify(relCounts));
// 4 类词表口径(2026-10-12 恢复 uses 后;2026-10-20 genmodel 批次后):extends 29 / uses 12 / competes 99 / contradicts 4。
// 与用 YAML 库直接数 frontmatter 的结果一致(covers 仍为删除状态)。
// 注意其中若干字段是 Obsidian 属性面板改写出的**块列表**形式,解析器必须两种都认。
const relEdges = index.edges.filter((e) => data.REL_KEYS.includes(e.type));
const plainEdges = index.edges.filter((e) => e.type === "plain");
if (FULL_VAULT) {
  check("有类型关系边 = 526(4 类口径,含块列表写法)", relEdges.length === 526, String(relEdges.length));
  check("四类各自的条数 = 71/115/333/7(近两周 21 篇批次后的拆分结果)", (() => {
    const c = {};
    for (const e of relEdges) c[e.type] = (c[e.type] || 0) + 1;
    return c.extends === 71 && c.uses === 115 && c.competes === 333 && c.contradicts === 7;
  })(), JSON.stringify((() => { const c = {}; for (const e of relEdges) c[e.type] = (c[e.type] || 0) + 1; return c; })()));
}
check("边只有 4 类关系 + 正文默认链接", index.edges.every(
  (e) => data.REL_KEYS.includes(e.type) || e.type === "plain"),
  JSON.stringify([...new Set(index.edges.map((e) => e.type))]));
if (FULL_VAULT) check("正文默认链接也成了边(灰色虚线)", plainEdges.length > 0, String(plainEdges.length));
check("默认链接不与层级线重复画", plainEdges.every((e) => {
  const dst = index.nodes.get(e.dst);
  return !dst || dst.parent !== e.src;
}));
// 回归:每篇正文「路径」节都写着"返回方向页",不排除的话同一对会画两根线
// (层级线 + 默认链接)重叠在一起,图会糊。
check("父子对不画默认链接(与层级线/归属线重叠)", (() => {
  const dir = index.byBasename.get("【索引】llm4rec-03-训练目标与偏好对齐");
  if (!dir) return true;
  const sub = data.computeSubGraph(index, dir.path, {});
  return sub.edges.every((e) => {
    if (e.type !== "plain") return true;
    const a = index.nodes.get(e.src), b = index.nodes.get(e.dst);
    return !(a && b && (b.parent === a.path || a.parent === b.path));
  });
})());
check("同一对最多一根结构线(层级/归属/默认链接)", (() => {
  const dir = index.byBasename.get("【索引】llm4rec-03-训练目标与偏好对齐");
  if (!dir) return true;
  const sub = data.computeSubGraph(index, dir.path, {});
  const seen = new Set();
  for (const e of sub.edges) {
    if (!["plain", "hier", "attr"].includes(e.type)) continue;
    const k = [e.src, e.dst].sort().join("|");
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
})());
check("默认链接不与关系边重复画", (() => {
  const pairs = new Set();
  for (const e of relEdges) { pairs.add(e.src + "|" + e.dst); pairs.add(e.dst + "|" + e.src); }
  return plainEdges.every((e) => !pairs.has(e.src + "|" + e.dst));
})());
check("对称边两侧都手写的重复数 = 0", (() => {
  const pairSeen = new Set();
  let dup = 0;
  for (const e of relEdges) {
    if (!data.REL_META[e.type].symmetric) continue;
    const key = [e.src, e.dst].sort().join("|") + "|" + e.type;
    if (pairSeen.has(key)) dup++;
    pairSeen.add(key);
  }
  return dup === 0;
})());

console.log("\n== 子图计算 ==");
// 索引节点:subtree 模式(取一个方向:llm4rec-03-训练目标与偏好对齐,35 篇)
const dDir = index.byBasename.get("【索引】llm4rec-03-训练目标与偏好对齐");
if (FULL_VAULT) {
  check("方向索引存在(llm4rec-03-训练目标与偏好对齐)", !!dDir);
  const dDirKids = dDir.children.length;
  const sub03 = data.computeSubGraph(index, dDir.path, {});
  check("方向子图 mode = subtree", sub03.mode === "subtree");
  const sub03InTree = sub03.nodes.filter((n) => !sub03.ghosts.has(n.path)).length;
  check("方向子树内 = 索引 + 它的论文", sub03InTree === dDirKids + 1,
    `${sub03InTree} vs ${dDirKids + 1}`);
  check("子树外的关联也带上来了(幽灵节点)", sub03.ghosts.size > 0, String(sub03.ghosts.size));
  check("幽灵节点只连出边,不参与层级线", sub03.ghosts.size > 0 &&
    !sub03.edges.some((e) => e.type === data.HIER_TYPE &&
      (sub03.ghosts.has(e.src) || sub03.ghosts.has(e.dst))));
  const hierIn03 = sub03.edges.filter((e) => e.type === data.HIER_TYPE).length;
  check("方向子图层级线 = 论文数(每个子节点一根)", hierIn03 === dDirKids, String(hierIn03));

  // 论文节点:ego 模式(用 TIGER,它关系最多)
  const tiger = index.byBasename.get("【2023】tiger-recommender-systems-generative-retrieval");
  check("TIGER 存在", !!tiger);
  const subT = data.computeSubGraph(index, tiger.path, {});
  check("TIGER 子图 mode = ego", subT.mode === "ego");
  check("ego 图含 TIGER 自己", subT.nodes.some((n) => n.path === tiger.path));
  const relEdgesT = subT.edges.filter((e) => e.type !== data.HIER_TYPE && e.type !== data.ATTR_TYPE);
  // ego 是**诱导子图**:中心的朋友圈连完之后,邻居之间已有的边也要画 ——
  // 否则在 ego 视图里给两个邻居连线,边写进了 frontmatter 却立刻从图上消失
  // (用户报的"子图里连不上边",2026-10-19 修)。
  const induced = relEdgesT.filter((e) => e.src !== tiger.path && e.dst !== tiger.path);
  check("ego 图是诱导子图:邻居之间的边也在(不要求都碰中心)",
    relEdgesT.every((e) => subT.nodes.some((n) => n.path === e.src) &&
      subT.nodes.some((n) => n.path === e.dst)),
    `邻居之间的边 ${induced.length} 条`);
  check("ego 图仍包含中心自己的边", relEdgesT.some((e) => e.src === tiger.path || e.dst === tiger.path));
  // 归属线:每个 ego 节点(若有方向索引父节点)都有一条 ATTR 线
  const attrT = subT.edges.filter((e) => e.type === data.ATTR_TYPE);
  console.log("  TIGER ego 图: " + subT.nodes.length + " 节点, " + relEdgesT.length + " 关系边, " + attrT.length + " 归属线");
  check("ego 图有归属线", attrT.length > 0);
} else {
  // 骨架库:用 papers 入口测 subtree 分支的基本行为
  const papersN = index.byBasename.get("【索引】papers");
  check("骨架库 papers 容器存在", !!papersN);
  const subP = data.computeSubGraph(index, papersN.path, {});
  check("骨架库 papers 子图 mode = subtree", subP.mode === "subtree");
}

// 不存在路径
const subX = data.computeSubGraph(index, "no/such/note.md", {});
check("未知路径 → missing", subX.mode === "missing" && subX.nodes.length === 0);

// 前端过滤(SKIP_DIRS/SKIP_FILES)之后 vault 计数
const visible = records.filter((r) =>
  !r.path.split("/").some((seg) => data.SKIP_DIRS.has(seg)) && !data.SKIP_FILES.has(r.basename));
const idx2 = data.buildWikiIndex(visible, {});
check("过滤后入库笔记 = " + visible.length + " 篇, 索引建出 " + idx2.nodes.size + " 节点", idx2.nodes.size === visible.length);
console.log("  可见笔记数:", visible.length);

// 层级覆盖完整性:除根外,所有节点要么有 parent,要么属于被跳过的区域
let orphans = [];
for (const n of idx2.nodes.values()) {
  if (n.path === idx2.root.path) continue;
  if (!n.parent) orphans.push(n.path);
}
check("无孤儿节点(全部挂进树)", orphans.length === 0, orphans.slice(0, 5).join("; "));

console.log("\n== 阅读状态写回(reading)+ 标签 ==");
{
  const base = [
    "---",
    'title: "【2026】X: Test Paper"',
    'slug: "x"',
    "year: 2026",
    "status: active",
    "authors: [\"Alice\", \"Bob\"]",
    "tags: [a, b]",
    'table_summary: "测试"',
    'competes: ["[[【2025】y]]"]',
    "---",
    "正文一行",
    "",
  ].join("\n");

  // 新增字段:插在锚点之后、关系字段之前
  const withReading = data.patchScalarField(base, "reading", "在读");
  check("新增 reading", /^reading: 在读$/m.test(withReading));
  check("新增后仍能解析出关系", data.parseFrontmatter(withReading).competes === '["[[【2025】y]]"]');
  check("正文未被破坏", withReading.trimEnd().endsWith("正文一行"));

  // 四档都能解析(取值就是中文)
  for (const st of ["未读", "在读", "已读", "精读"]) {
    check(`parseFrontmatter 读到 reading=${st}`,
      data.parseFrontmatter(data.patchScalarField(base, "reading", st)).reading === st);
  }
  check("内置四档齐全且是中文",
    data.READING_DEFAULTS.map((s) => s.key).join("/") === "未读/在读/已读/精读",
    JSON.stringify(data.READING_DEFAULTS.map((s) => s.key)));
  check("取值与显示名一致(不再有英文 key ↔ 中文 label 的映射)",
    data.READING_DEFAULTS.every((s) => s.key === s.label));
  check("四档各有一种颜色且互不相同",
    new Set(data.READING_DEFAULTS.map((s) => s.color)).size === 4 &&
    data.READING_DEFAULTS.every((s) => /^#[0-9A-Fa-f]{6}$/.test(s.color)),
    JSON.stringify(data.READING_DEFAULTS.map((s) => s.color)));
  check("每档都有中文标签",
    data.READING_DEFAULTS.every((s) => s.label), JSON.stringify(data.READING_DEFAULTS.map((s) => s.label)));

  // 重要性 → 半径:单调、默认值最小、越界被夹住
  const radii2 = [1, 2, 3, 4, 5].map(data.radiusForImportance);
  check("半径随 importance 单调递增", radii2.every((r, i) => i === 0 || r > radii2[i - 1]),
    JSON.stringify(radii2));
  check("importance=1 是最小球", data.radiusForImportance(1) === radii2[0] &&
    data.radiusForImportance(0) === radii2[0] && data.radiusForImportance(undefined) === radii2[0]);
  check("越界夹到 1–5", data.radiusForImportance(9) === radii2[4] && data.radiusForImportance(-3) === radii2[0]);
  check("importance 解析 + 越界忽略",
    data.parseFrontmatter("---\nimportance: 3\n---\n").importance === 3 &&
    data.parseFrontmatter("---\nimportance: 9\n---\n").importance === undefined &&
    data.parseFrontmatter("---\nimportance: x\n---\n").importance === undefined);

  // 替换已有值
  const replaced = data.patchScalarField(withReading, "reading", "精读");
  check("重复写 = 替换不叠加", (replaced.match(/^reading:/gm) || []).length === 1 &&
    /^reading: 精读$/m.test(replaced));

  // 删除
  const deleted = data.patchScalarField(replaced, "reading", null);
  check("写 null = 删掉整个字段", !/reading:/.test(deleted));
  check("删除后 frontmatter 仍闭合", deleted.startsWith("---\n") &&
    deleted.split("\n---\n").length === 2);

  // 标签增删 + authors 只读解析
  const withTag = data.patchTags(base, { add: "multi-interest" });
  check("加标签", /^tags: \[a, b, multi-interest\]$/m.test(withTag));
  check("readTags 读回", data.readTags(withTag).join(",") === "a,b,multi-interest");
  const noTag = data.patchTags(withTag, { remove: "a" });
  check("删标签", /^tags: \[b, multi-interest\]$/m.test(noTag));
  try { data.patchTags(base, { add: "a" }); check("重复加标签应报错", false); }
  catch (e) { check("重复加标签应报错", true); }

  const whole = data.patchScalarField(base, "reading", "精读");
  const parsed = data.parseFrontmatter(whole);
  check("authors 解析成数组", Array.isArray(parsed.authors), JSON.stringify(parsed.authors));
  check("reading 与标签互不干扰",
    parsed.reading === "精读" && data.readTags(whole).join(",") === "a,b");
}

console.log("\n== 块列表写法(Obsidian 笔记属性面板会改写成这种)==");
{
  // 属性面板里点一下,Obsidian 就把内联数组改写成块列表 —— 只认单行会静默丢边
  const blockStyle = [
    "---",
    'title: "【2026】X: Test Paper"',
    'slug: "x"',
    "year: 2026",
    "status: active",
    "reading: 已读",
    "tags:",
    "  - multi-interest",
    "  - codebook",
    "authors:",
    '  - "Alice"',
    '  - "Bob"',
    "extends:",
    '  - "[[【2025】y]]"',
    '  - "[[【2024】z]]"',
    "competes:",
    '  - "[[【2023】w]]"',
    "---",
    "正文",
    "",
  ].join("\n");

  const fm = data.parseFrontmatter(blockStyle);
  check("块列表 extends 读全(2 个)", fm.extends && data.extractWikilinks(fm.extends).length === 2,
    JSON.stringify(fm.extends));
  check("块列表 competes 读全", fm.competes && data.extractWikilinks(fm.competes).length === 1);
  check("块列表 tags 读全", (fm.tags || []).join(",") === "multi-interest,codebook", JSON.stringify(fm.tags));
  check("块列表 authors 读全", (fm.authors || []).join(",") === "Alice,Bob", JSON.stringify(fm.authors));
  check("块列表 reading 读到", fm.reading === "已读");
  check("readTags 认块列表", data.readTags(blockStyle).join(",") === "multi-interest,codebook");

  // 关键回归:往块列表字段加边,不能把已有的目标吃掉
  const added = data.patchRelation(blockStyle, { add: { field: "extends", target: "【2022】new" } });
  const after = data.parseFrontmatter(added);
  check("加边不丢旧目标", data.extractWikilinks(after.extends).length === 3 &&
    data.extractWikilinks(after.extends).includes("【2025】y"), JSON.stringify(after.extends));
  check("加边后仍是合法 YAML 数组", /^extends: \["\[\[.*\]\]"\]$/m.test(added), added.match(/^extends:.*$/m)[0]);

  // 删边也要认块列表
  const removed = data.patchRelation(blockStyle, { remove: { field: "extends", target: "【2024】z" } });
  check("块列表删边", data.extractWikilinks(data.parseFrontmatter(removed).extends).join(",") === "【2025】y");
}

console.log("\n== 编辑模式的定位契约(修过 bug:NaN 坐标导致菜单飘走)==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  // 回归:openTypeMenu 收「坐标对象」而不是「取坐标的函数」。
  // 传函数时调用方忘了传事件参数,e 是 undefined 直接抛异常 → 连线第二下弹不出菜单。
  check("openTypeMenu 收坐标对象(不是函数)", /openTypeMenu\(point, pick, onCancel, opts = \{\}\)/.test(src));
  check("定位读 point.x / point.y", /Number\.isFinite\(point\.x\)/.test(src));
  check("连线流程传 {x: e.clientX, y: e.clientY}",
    /point = e \? \{ x: e\.clientX, y: e\.clientY \} : null/.test(src));
  check("没有任何调用方再传函数当锚点", !/openTypeMenu\(\s*\(e\) =>/.test(src) &&
    !/openTypeMenu\(\s*\(\) => \(\{ x: 0/.test(src));
  check("详情卡可拖尺寸:右下角手柄 + 外壳/内层分离 + 尺寸落盘",
    /pnx-card-grip/.test(src) && /pnx-card-body/.test(src) &&
    /settings\.cardSize = \{ w/.test(src) && /cardSize: null/.test(src) &&
    /this\.cardBodyEl\.(createEl|createDiv)/.test(src) &&
    /querySelector\("\.pnx-card-grip"\)/.test(src));   // 重绘前先摘旧的,避免手柄叠加
  check("详情卡顶部有拖动条(移动卡片 / 位置记忆 / 双击回默认)",
    /pnx-card-head/.test(src) && /settings\.cardPos = \{ x/.test(src) &&
    /cardPos: null/.test(src) && /head\.addEventListener\("dblclick"/.test(src) &&
    /const maxX = Math\.max\(\(this\.w \|\| 0\)/.test(src));
  check("动作按钮有真按钮样式与主次(打开笔记为主操作)",
    /acts\.createEl\("button"\)/.test(src) && /addClass\("is-primary"\)/.test(src));
  check("卡片里的主方向/子方向双击才进(单击不跳走)", (() => {
    const a = src.indexOf("const dirRow"), b = src.indexOf("const tgRow");
    if (a < 0 || b < 0 || b < a) return false;
    const dirBlock = src.slice(a, b);          // 只看向那一段:主方向 + 子方向芯片
    // 只看**芯片本身**的两处跳转:主方向 + 子方向(✕ 上的 dblclick 是拦截冒泡,不算)
    const chipDbl = (dirBlock.match(/chip\.addEventListener\("dblclick"/g) || []).length;
    const chipClick = (dirBlock.match(/chip\.addEventListener\("click"/g) || []).length;
    return chipDbl === 2 && chipClick === 0;
  })(), (() => { const a = src.indexOf("const dirRow"), b = src.indexOf("const tgRow");
    return a >= 0 && b > a ? (src.slice(a, b).match(/addEventListener\("(dbl)?click"/g) || []).join(" ") : "找不到方向段"; })());
  check("卡片有「进入」与「回到上层」两个动作(进/回成对)",
    /setText\("进入"\)/.test(src) && /setText\("回到上层"\)/.test(src));
  check("「进入」对所有节点都有,提示语按类型区分(索引=下一层+一次连接,叶子=ego 图)",
    /const btnInto = acts\.createEl\("button"\);/.test(src) &&
    /this\.isIndexNode\(node\)\n        \? `进入「/.test(src));
  check("回到上层:基准是画布当前的根(能连点一路往上),且 keepFocus(卡里那篇不跳走)",
    /const canvasRoot = this\.index\.nodes\.get\(this\.selected\) \|\| node;/.test(src) &&
    /this\.selectNode\(up\.path, \{ keepFocus: true \}\)/.test(src));
  check("「回到上层」只在画布根有父节点时出现",
    /const up = canvasRoot\.parent \? this\.index\.nodes\.get\(canvasRoot\.parent\) : null;\n      if \(up\)/.test(src));
  check("不再用「下钻」「进入下层」这两个词(定稿为「进入」/「回到上层」)",
    !/下钻/.test(src) && !/进入下层/.test(src));
  check("结构边(层级/归属)不进编辑通道",
    /this\.editMode && \(e\.type === HIER_TYPE \|\| e\.type === ATTR_TYPE\)\) continue/.test(src) &&
    /层级线由目录推导/.test(src));
}

console.log("\n== 图 ↔ 笔记 双向同步 ==");
{
  const { execFileSync } = require("child_process");
  const fsx = require("fs");
  const osx = require("os");
  const pathx = require("path");
  // 在临时 vault 上跑:改 frontmatter → 重建索引后节点状态必须跟着变(模拟属性面板那次改动)
  const tmp = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "pnx-sync-"));
  const dir = pathx.join(tmp, "papers", "02-x", "【2026】sync-demo");
  fsx.mkdirSync(dir, { recursive: true });
  const note = pathx.join(dir, "【2026】sync-demo.md");
  const base = (reading, importance) => [
    "---", `importance: ${importance}`, `reading: ${reading}`,
    'title: "【2026】Sync: Demo Paper"', 'slug: "sync-demo"', "year: 2026",
    'pdf: "x.pdf"', "tags: [a, b]", 'table_summary: "demo"', "status: active",
    "---", "正文", "",
  ].join("\n");
  fsx.writeFileSync(note, base("未读", 1), "utf-8");

  const records = () => [{
    path: "papers/02-x/【2026】sync-demo/【2026】sync-demo.md",
    basename: "【2026】sync-demo",
    content: fsx.readFileSync(note, "utf-8"),
  }];
  const n1 = data.buildWikiIndex(records(), {}).nodes.values().next().value;
  check("初读:未读 + 重要性 1", n1.reading === "未读" && n1.importance === 1);
  check("半径按重要性", data.radiusForImportance(n1.importance) === data.radiusForImportance(1));

  // 模拟"在笔记属性面板里改成 精读 / 5"
  fsx.writeFileSync(note, base("精读", 5), "utf-8");
  const n2 = data.buildWikiIndex(records(), {}).nodes.values().next().value;
  check("面板改完,重索引就读到新值", n2.reading === "精读" && n2.importance === 5);
  check("球随之变大", data.radiusForImportance(n2.importance) > data.radiusForImportance(1));

  // 反向:模拟"在详情卡里点芯片"写盘 → 文件真的变了,再读还是新值
  const written = data.patchScalarField(fsx.readFileSync(note, "utf-8"), "reading", "在读");
  fsx.writeFileSync(note, written, "utf-8");
  const n3 = data.buildWikiIndex(records(), {}).nodes.values().next().value;
  check("详情卡写盘后重索引也一致", n3.reading === "在读" && n3.importance === 5);

  fsx.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n== 库 ↔ 图 一致性(内建校验:vault 就是唯一真源)==");
{
  const pathx = require("path");
  const papers = fs.readdirSync(pathx.join(VAULT, "papers"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => fs.readdirSync(pathx.join(VAULT, "papers", d.name), { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => pathx.join(VAULT, "papers", d.name, x.name)));

  let pdfOk = 0, pdfBad = [], stateMissing = [], noNote = [];
  for (const dir of papers) {
    const name = pathx.basename(dir);
    const files = fs.readdirSync(dir);
    const noteFile = name + ".md";
    if (!files.includes(noteFile)) { noNote.push(name); continue; }
    // ① PDF 与笔记同名 ② frontmatter 的 pdf 指得到 ③ reading/importance 都在
    if (!files.includes(name + ".pdf")) pdfBad.push(name);
    else pdfOk++;
    const text = fs.readFileSync(pathx.join(dir, noteFile), "utf8");
    const fm = data.parseFrontmatter(text);
    const pdfField = (text.match(/^pdf:[ \t]*(.*)$/m) || [])[1]?.trim().replace(/^"|"$/g, "");
    if (!pdfField || !files.includes(pdfField)) pdfBad.push(name + " (pdf 字段指向 " + pdfField + ")");
    if (!fm.reading || !fm.importance) stateMissing.push(name);
  }
  check(`每个论文文件夹都有同名 PDF(${pdfOk}/${papers.length})`, pdfBad.length === 0,
    pdfBad.slice(0, 3).join("; "));
  check("每个论文文件夹的笔记与文件夹同名", noNote.length === 0, noNote.slice(0, 3).join("; "));
  check("每篇都有 reading + importance(图上才有颜色/大小)", stateMissing.length === 0,
    stateMissing.slice(0, 3).join("; "));
  check("索引覆盖全部论文笔记(图 = 库的快照)", index.nodes.size >= papers.length,
    `索引 ${index.nodes.size} 节点 / ${papers.length} 篇论文`);
}

console.log("\n== 画布只画两件事 + 笔记侧选择题 ==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("画布不再用阅读状态上色(无 stateColor 变量)", !/const stateColor = /.test(src));
  check("子树视图带外部关联(ghosts)", /const ghosts = new Set\(\)/.test(src) &&
    /includeExternal !== false/.test(src));
  check("只有方向分组树(papers/,schema 的 root_dir)下的论文能拖动换方向",
    /if \(!this\.inPaperRoot\(src\.path\)\) return false;/.test(src));
  // UI 定稿(2026-10):默认去饱和、焦点才用纯色;标签画在屏幕坐标并避让
  check("论文球默认是去饱和的类别色,被关心时才纯色",
    /mixHex\(pure, bg, NODE_SOFTEN\)/.test(src) && /active \? pure : mixHex/.test(src));
  check("节点填充 = 调色板原色(去饱和 0、不透明)—— 轻重对比靠压暗非焦点而非整体调淡",
    (() => { const a = src.match(/const NODE_ALPHA = ([\d.]+)/); const s = src.match(/const NODE_SOFTEN = ([\d.]+)/);
      return a && s && +a[1] === 1 && +s[1] === 0; })(),
    (src.match(/const NODE_(ALPHA|SOFTEN) = [\d.]+/g) || []).join(" "));
  check("幽灵节点明显比本体淡(和'属于这块'区分开)",
    (() => { const a = src.match(/const GHOST_ALPHA = ([\d.]+)/); const s = src.match(/const GHOST_SOFTEN = ([\d.]+)/);
      return a && s && +a[1] < 1 && +s[1] > 0; })());
  check("视觉参数是常量且去饱和不过度(0<=NODE_SOFTEN<=0.25)",
    (() => { const m = src.match(/const NODE_SOFTEN = ([\d.]+)/); return m && +m[1] >= 0 && +m[1] <= 0.25; })(),
    (src.match(/const NODE_SOFTEN = [\d.]+/) || [""])[0]);
  check("背景有径向渐晕", /createRadialGradient/.test(src));
  check("标签在屏幕坐标画且按优先级避让",
    /this\.drawLabels\(ctx\)/.test(src) && /labelFits\(box, placed\)/.test(src) &&
    /items\.sort\(\(a, b\) => a\.pri - b\.pri/.test(src));
  check("边的透明度/线宽来自常量表", /EDGE_ALPHA\.rel/.test(src) && /EDGE_WIDTH\.rel/.test(src));
  check("边的权重阶梯:关系 > 默认链接 > 归属(默认链接不能画得比结构线还虚)",
    (() => { const m = src.match(/EDGE_ALPHA = \{([^}]+)\}/); if (!m) return false;
      const get = (k) => { const mm = m[1].match(new RegExp(k + ": ([\\d.]+)")); return mm ? +mm[1] : NaN; };
      return get("rel") > get("plain") && get("plain") > get("attr"); })(),
    (src.match(/EDGE_ALPHA = \{[^}]+\}/) || [""])[0]);
  check("默认链接用长虚线(不是密点)",
    /PLAIN_TYPE \? \[5, 4\]/.test(src));
  check("索引节点画白心圈:描边走 nodeColor(默认灰,用户覆盖色生效)",
    /if \(this\.isIndexNode\(n\.node\)\) \{[\s\S]{0,400}?ctx\.strokeStyle = pure;/.test(src));
  check("外部改动重绘不重置视口(keepView)",
    /if \(!opts\.keepView\) this\.centerOn\(path\)/.test(src) &&
    /keepFocus: true, keepView: true/.test(src));
  check("写出的链接不做百分号编码(Obsidian 能解,别的工具认不了)",
    // 只看链接构造:main.js 里另有 arXiv API 抓取会正当地用 encodeURIComponent。
    !/encodeURIComponent\((rel|dstFile|dstParts)/.test(src) &&
    src.includes('concat(dstFile).join("/")'));
  check("含空格路径用 <> 包起来(和 Obsidian 写 markdown 链接的风格一致)",
    /test\(rel\) \? `<\$\{rel\}>` : rel/.test(src));
  check("命令面板里有两条选择题",
    /id: "set-reading"/.test(src) && /id: "set-importance"/.test(src) &&
    /class PickModal extends SuggestModal/.test(src));
  check("选择题对当前笔记生效(不依赖视图开着)",
    /setNoteField\(file, "reading"/.test(src) && /getActiveFile\(\)/.test(src));
}

console.log("\n== 插件生成的索引段落 == Python 工具生成的(拖动换方向后不能把索引改脏)==");
{
  // 拿真库里每个方向索引的现存内容,和插件纯函数生成的段落逐字节比
  const idxFiles = [];
  for (const d of fs.readdirSync(path.join(VAULT, "papers"), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(VAULT, "papers", d.name);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith("【索引】") && f.endsWith(".md")) idxFiles.push(path.join(dir, f));
    }
  }
  let same = 0, diff = [];
  for (const f of idxFiles) {
    const rel = path.relative(VAULT, f).split(path.sep).join("/");
    const node = index.nodes.get(rel);
    if (!node) { diff.push(rel + " (不在索引里)"); continue; }
    const text = fs.readFileSync(f, "utf8");
    const i = text.search(/^## 论文[ \t]*$/m);
    if (i < 0) { diff.push(rel + " (没有 ## 论文)"); continue; }
    const existing = text.slice(i);
    const generated = data.buildIndexSection(node, index.nodes);
    if (existing.trimEnd() === generated.trimEnd()) same++;
    else {
      diff.push(rel);
      const a = existing.trimEnd().split("\n"), b = generated.trimEnd().split("\n");
      for (let k = 0; k < Math.max(a.length, b.length); k++) {
        if (a[k] !== b[k]) { console.log(`     差异 ${rel}:\n       现: ${(a[k]||"").slice(0,90)}\n       生成: ${(b[k]||"").slice(0,90)}`); break; }
      }
    }
  }
  check(`插件能逐字节复现全部 ${idxFiles.length} 个方向索引`, diff.length === 0, diff.slice(0, 3).join("; "));
}

console.log("\n== 关系配色:词表(权威)与插件(渲染副本)必须一致 ==");
{
  const vocab = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "tools", "relation_vocabulary.yml"), "utf8");
  for (const key of data.REL_KEYS) {
    const m = vocab.match(new RegExp("^\\s+" + key + ":[\\s\\S]*?color: \"#([0-9A-Fa-f]{6})\"", "m"));
    const vocabColor = m ? ("#" + m[1]).toUpperCase() : null;
    check(`词表与插件配色一致:${key}`, !!m && vocabColor === data.REL_META[key].color.toUpperCase(),
      `词表 ${vocabColor} vs 插件 ${data.REL_META[key].color}`);
  }
  check("配色用 Okabe-Ito 色盲安全值(不是自选的高饱和色)",
    Object.values(data.REL_META).every((m) =>
      ["#56B4E9", "#D55E00", "#CC79A7", "#009E73"].includes(m.color.toUpperCase())),
    JSON.stringify(Object.values(data.REL_META).map((m) => m.color)));
}

console.log("\n== UI 纯函数:配色柔化 / 面积比例半径 / 标签避让 ==");
{
  check("mixHex 取端点", data.mixHex("#000000", "#FFFFFF", 0) === "#000000" &&
    data.mixHex("#000000", "#FFFFFF", 1) === "#ffffff");
  check("mixHex 中间值变浅(蓝混白)", data.mixHex("#4C8DFF", "#FFFFFF", 0.32) === "#85b1ff",
    data.mixHex("#4C8DFF", "#FFFFFF", 0.32));
  check("mixHex 认 css 各种写法(主题里的 --background-primary 常常是 rgb())",
    data.mixHex("#4C8DFF", "rgb(255, 255, 255)", 0.32) === data.mixHex("#4C8DFF", "#FFFFFF", 0.32) &&
    data.mixHex("#4C8DFF", "rgba(255,255,255,1)", 0.32) === "#85b1ff" &&
    data.mixHex("#4C8DFF", "#fff", 0.32) === data.mixHex("#4C8DFF", "#FFFFFF", 0.32));
  check("解析不出来的颜色(如 hsl)原样返回,不产生无效色",
    data.mixHex("#4C8DFF", "hsl(200, 50%, 20%)", 0.32) === "#4C8DFF" &&
    data.parseColor("hsl(1,2%,3%)") === null);
  check("parseColor 三种写法", JSON.stringify(data.parseColor("#abc")) === "[170,187,204]" &&
    JSON.stringify(data.parseColor("rgb(1,2,3)")) === "[1,2,3]");
  check("mixHex 在深色主题里变暗", (() => {
    const out = data.mixHex("#4C8DFF", "#1E1E1E", 0.32);
    const lum = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).reduce((a, b) => a + b);
    return lum(out) < lum("#4C8DFF");
  })());

  const rad = [1, 2, 3, 4, 5].map(data.radiusForImportance);
  check("重要性半径单调递增", rad.every((r, i) => i === 0 || r > rad[i - 1]), JSON.stringify(rad));
  check("面积与重要性成比例(不是半径成比例)", (() => {
    const area = rad.map((r) => Math.PI * r * r);
    // 面积 1:3 应该约等于 4 档跨度里的 1:3;允许 20% 误差
    const ratio = area[4] / area[0];
    return ratio > 2.5 && ratio < 4;
  })(), `面积比 ${(rad[4] * rad[4] / rad[0] / rad[0]).toFixed(2)}`);

  const ir = [0, 2, 24, 165].map(data.radiusForIndex);
  check("索引半径随篇数增长但封顶", ir.every((r, i) => i === 0 || r >= ir[i - 1]) && ir[3] <= 14,
    JSON.stringify(ir));
  // 索引节点是锚点,但不必压过 5 分论文(它自己也会随子树变大):只要明显大于默认档论文即可
  check("索引节点比默认档论文大(是锚点)", ir[0] > rad[0], `${ir[0]} vs ${rad[0]}`);

  const placed = [{ x: 0, y: 0, w: 20, h: 12 }];
  check("labelFits 挡住重叠", !data.labelFits({ x: 10, y: 5, w: 20, h: 12 }, placed));
  check("labelFits 放过不重叠的", data.labelFits({ x: 40, y: 0, w: 20, h: 12 }, placed));
  check("labelFits 留了间隙(贴着也算撞)", !data.labelFits({ x: 21, y: 0, w: 20, h: 12 }, placed));
}

console.log("\n== 初始布局(纯函数;曾经因为对象字面量重复键把坐标写成 undefined → 整图消失) ==");
{
  const dir = index.byBasename.get("【索引】llm4rec-03-训练目标与偏好对齐") || index.root;
  const sub = data.computeSubGraph(index, dir.path, {});
  const nodes = data.layoutNodes(sub, {});
  check("每个节点都有有限坐标与正半径",
    nodes.length > 0 && nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && n.r > 0),
    `${nodes.length} 节点,异常 ${nodes.filter((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y) || !(n.r > 0)).length}`);
  check("布局节点数与子图一致", nodes.length === sub.nodes.length,
    `${nodes.length} vs ${sub.nodes.length}`);
  const root = nodes.find((n) => n.id === sub.root);
  check("当前层的根钉在原点(它是这一屏的中心)", !!root && root.x === 0 && root.y === 0 && root.fixed === true);
  check("只有根是固定的(其它节点仍可拖)", nodes.filter((n) => n.fixed).length === 1,
    String(nodes.filter((n) => n.fixed).length));
  check("沿用上一轮坐标(重进入时位置不跳)", (() => {
    const prev = new Map(nodes.map((n) => [n.id, { x: 123, y: 456 }]));
    const again = data.layoutNodes(sub, { prev });
    return again.filter((n) => n.id !== sub.root).every((n) => n.x === 123 && n.y === 456);
  })());
  check("半径:索引节点 > 默认档论文,幽灵最小", (() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const idxNode = nodes.find((n) => n.node.children.length > 0);
    const paper = nodes.find((n) => n.node.children.length === 0 && !(sub.ghosts && sub.ghosts.has(n.id)));
    const ghost = nodes.find((n) => sub.ghosts && sub.ghosts.has(n.id));
    return (!idxNode || !paper || idxNode.r > paper.r) && (!ghost || !paper || ghost.r <= paper.r);
  })());
}

console.log("\n== 进度轴由 schema 的 status_field 驱动(不再按路径区分)==");
{
  check("档位齐全且是中文六档",
    data.IDEA_STAGES.map((s) => s.key).join("/") === "待做/在做/已成稿/已投稿/已发表/废弃",
    data.IDEA_STAGES.map((s) => s.key).join("/"));
  check("每档有颜色且互不相同",
    new Set(data.IDEA_STAGES.map((s) => s.color)).size === data.IDEA_STAGES.length);
  check("有出口档(Stage-Gate 的 kill:废弃)", data.IDEA_STAGES.some((s) => s.key === "废弃"));
  check("status_field 从 schema 读:idea→stage、paper→reading、topic→无",
    data.statusFieldOf(realSchema || data.DEFAULT_SCHEMA, "idea") === "stage" &&
    data.statusFieldOf(realSchema || data.DEFAULT_SCHEMA, "paper") === "reading" &&
    data.statusFieldOf(realSchema || data.DEFAULT_SCHEMA, "topic") === null);
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  // 回归:同一处切换漏了三遍(高亮判定/填色/提示语),所以这里逐个钉住 ——
  // 只要芯片区块里再出现裸的 node.reading,就是又漏了一处
  check("卡片芯片区块不再有裸的 node.reading(高亮、填色都走 axis)",
    (() => {
      const anchor = "for (const s of axis.states) {";
      const a = src.indexOf(anchor);
      const b = src.indexOf("const imRow", a);
      const body = a > 0 ? src.slice(a + anchor.length, b) : "";
      return a > 0 && b > a && !/node\.reading/.test(body) &&
        (body.match(/axis\.value === s\.key/g) || []).length === 2;
    })(),
    (() => { const a = src.indexOf("for (const s of axis.states) {"), b = src.indexOf("const imRow", a);
      return a > 0 ? (src.slice(a + 29, b).match(/node\.reading|axis\.value === s\.key/g) || []).join(" ") : "找不到该区块"; })());
  check("提示语按字段切轴(阶段/阅读/重要性,未知字段回落字段名)",
    /field === STAGE_FIELD \? "阶段"\s*:/.test(src) && /else if \(field === STAGE_FIELD\) node\.stage/.test(src));
  check("卡片与树都按 statusAxis 切换档位",
    /statusAxis\(node\)/.test(src) &&
    /this\.setField\(node, axis\.field, s\.key\)/.test(src) &&
    /axis\.states\.find\(\(x\) => x\.key === axis\.value\)/.test(src));
}

console.log("\n== 画布 = 选中节点的连接子图(点谁谁就是中心,开局 = 整库)==");
function inSetOf(sub) { return new Set(sub.nodes.map((n) => n.path)); }
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("selectNode 以**选中节点**为中心算子图(不再固定整库)",
    /this\.sub = computeSubGraph\(this\.index, path, \{/.test(src));
  check("「进入」与左树点击同一张图(不再有 depth:1 的一跳视图)",
    /btnInto\.addEventListener\("click", \(\) => this\.selectNode\(node\.path\)\)/.test(src) &&
    !/depth: this\.isIndexNode\(node\) \? 1/.test(src));
  check("选中只平移进视口(centerOn),不再重排/缩放",
    /centerOn\(path\)/.test(src));

  // 开局:选中 = 根 → 整库子图
  const whole = data.computeSubGraph(index, index.root.path, { depth: Infinity });
  // 整库 ≠ index.nodes.size:index 里还有几个 parent:null 的基建孤儿(_dashboards/×4、
  // _templates/论文笔记.md、log.md),不被内容树引用,本来就不上画布;而 AGENTS.md 被
  // 总览笔记引用,以幽灵节点身份进来。所以断言"画布外恰好是这批孤儿",不写死数字。
  const inWhole = new Set(whole.nodes.map((n) => n.path));
  const outside = [...index.nodes.values()].filter((n) => !inWhole.has(n.path));
  check("开局覆盖全部内容树(画布外的只是 parent:null 的基建孤儿)",
    outside.length > 0 && outside.every((n) => !n.parent),
    JSON.stringify(outside.map((n) => n.path)));
  check("幽灵都来自 parent:null 的被引用文档(AGENTS.md 这类)",
    [...whole.ghosts].every((g) => { const n = index.nodes.get(g); return n && !n.parent; }));
  const wholeTree = whole.nodes.filter((n) => !whole.ghosts.has(n.path)).length;
  const kinds = {};
  for (const e of whole.edges) kinds[e.type] = (kinds[e.type] || 0) + 1;
  const idxKinds = {};
  for (const e of index.edges) idxKinds[e.type] = (idxKinds[e.type] || 0) + 1;
  check("层级线 = 树内节点数 - 1(整棵树一根不少)",
    kinds.hier === wholeTree - 1, `${kinds.hier} vs ${wholeTree - 1}`);
  check("4 类关系边一条不少(与全库索引逐类相等)",
    data.REL_KEYS.every((t) => (kinds[t] || 0) === (idxKinds[t] || 0)),
    JSON.stringify({ whole: kinds, index: idxKinds }));
  if (FULL_VAULT) check("正文默认链接 = 全库中两端都在画布上的那些",
    kinds.plain === index.edges.filter((e) => e.type === "plain" &&
      inWhole.has(e.src) && inWhole.has(e.dst)).length,
    `${kinds.plain}`);

  // 「进入」语义(2026-10-27 定稿):**与左树点击完全一致** —— 索引 = 整棵子树 + 幽灵,
  // 叶子 = ego 图;同一节点从任何入口进来(树/「进入」/面包屑/画布)子图都一样。
  // 曾经的"一跳视图"(depth:1)因为出图与左树不一致、且单遍拖人有传染 bug 而退场。
  const domain = index.byBasename.get("【索引】llm4rec");
  if (FULL_VAULT) {
  const subD = data.computeSubGraph(index, domain.path, {});
  const inTree = (s) => s.nodes.filter((x) => !s.ghosts.has(x.path)).length;
  check("索引子图 = 整棵子树(不带 depth 参数也是完整展开)",
    inTree(subD) === countDesc(domain) + 1);
  // 精确断言:非层级边全部来自全库;= 全库中两端都在视图内的边 + 层级线
  const d03 = index.byBasename.get("【索引】llm4rec-04-用户理解与行为建模");
  const sub03 = data.computeSubGraph(index, d03.path, {});
  const inSub03 = inSetOf(sub03);
  const allIn = sub03.edges.filter((e) => e.type !== "hier")
    .every((e) => index.edges.some((x) => x.src === e.src && x.dst === e.dst && x.type === e.type));
  const pulled = index.edges.filter((e) => inSub03.has(e.src) && inSub03.has(e.dst));
  const hier03 = sub03.nodes.filter((n) => n.parent && inSub03.has(n.parent)).length;
  check("索引子图边全部来自全库(无合成边),= 全库中两端都在视图内的边 + 层级线",
    allIn && sub03.edges.length === pulled.length + hier03,
    JSON.stringify({ edges: sub03.edges.length, pulled: pulled.length, hier: hier03 }));
  check("视图内不出现子树之外的索引节点(幽灵只带论文)",
    sub03.nodes.every((n) => inSub03.has(n.path) &&
      (n.path === d03.path || n.children.length === 0 ||
       subD.nodes.some((x) => x.path === n.path)) &&
      !(n.children.length > 0 && sub03.ghosts.has(n.path))),
    JSON.stringify(sub03.nodes.filter((n) => n.children.length > 0 && sub03.ghosts.has(n.path)).map((n) => n.basename)));
  check("幽灵都是子树外的连入者(不在子树真成员里)",
    [...sub03.ghosts].every((g) => {
      const n = index.nodes.get(g);
      // 不在 04 的子树里 = 不是 04 自己、parent 链上没有 04
      for (let x = n; x; x = x.parent ? index.nodes.get(x.parent) : null) {
        if (x.path === d03.path) return false;
      }
      return true;
    }),
    JSON.stringify([...sub03.ghosts].slice(0, 4)));
  // 一致性:同一节点,任何入口参数下的子图完全相同(进出树点击 = 进入 = 无参)
  check("同一节点 depth:1 与无参出图一致(一跳视图已删,参数被忽略)",
    JSON.stringify([...inSetOf(data.computeSubGraph(index, domain.path, { depth: 1 }))].sort()) ===
    JSON.stringify([...inSetOf(subD)].sort()));
  } else {
    // 骨架库:papers 入口,depth 参数一致性照验
    const papersN = index.byBasename.get("【索引】papers");
    const s1 = data.computeSubGraph(index, papersN.path, {});
    const s2 = data.computeSubGraph(index, papersN.path, { depth: 1 });
    check("同一节点 depth:1 与无参出图一致(一跳视图已删,参数被忽略)",
      JSON.stringify([...inSetOf(s1)].sort()) === JSON.stringify([...inSetOf(s2)].sort()));
  }

  function countDesc(n) { let c = 0; for (const ch of n.children) { const cn = index.nodes.get(ch); if (cn) c += 1 + countDesc(cn); } return c; }
}

console.log("\n== 主方向(唯一) + 子方向(可多个)==");
{
  const mk = (dir, slug, body) => ({
    path: `papers/${dir}/【2026】${slug}/【2026】${slug}.md`,
    basename: `【2026】${slug}`,
    content: [
      "---", "importance: 1", "reading: 未读",
      `title: "【2026】${slug}"`, `slug: "${slug}"`, "year: 2026",
      'pdf: "x.pdf"', "tags: [a, b]", 'table_summary: "d"', "status: active", "---",
      body, "",
    ].join("\n"),
  });
  const note = (path, body) => ({ path, basename: path.split("/").pop().replace(/\.md$/, ""),
    content: `---\ntitle: "${path.split("/").pop().replace(/\.md$/, "")}"\n---\n${body}\n` });
  const recs = [
    note("【索引】研究总览.md", "## 大类别\n- [[【索引】llm4rec]]"),
    note("papers/【索引】llm4rec.md", "## 方向\n- [[【索引】llm4rec-02-模型与架构]]\n- [[【索引】llm4rec-03-训练目标与偏好对齐]]"),
    note("papers/llm4rec-02-模型与架构/【索引】llm4rec-02-模型与架构.md", "## 论文"),
    note("papers/llm4rec-03-训练目标与偏好对齐/【索引】llm4rec-03-训练目标与偏好对齐.md", "## 论文"),
    mk("llm4rec-02-模型与架构", "paper-a",
      "## 归属\n- 主方向：[生成式建模与架构](../【索引】llm4rec-02-模型与架构.md)\n" +
      "- 子方向：[llm4rec-03-训练目标与偏好对齐](../../llm4rec-03-训练目标与偏好对齐/【索引】llm4rec-03-训练目标与偏好对齐.md)"),
  ];

  const idx2 = data.buildWikiIndex(recs, {});
  const a = idx2.byBasename.get("【2026】paper-a");
  check("主方向 = 文件夹(唯一)", a.parent === "papers/llm4rec-02-模型与架构/【索引】llm4rec-02-模型与架构.md",
    String(a.parent));
  check("子方向 = 正文里指向别的方向索引的链接",
    (a.secondary || []).join(",") === "papers/llm4rec-03-训练目标与偏好对齐/【索引】llm4rec-03-训练目标与偏好对齐.md",
    JSON.stringify(a.secondary));
  check("自己那个方向不会被算成子方向",
    !(a.secondary || []).includes(a.parent));
  check("子方向也成了一条边(图上看得到)", idx2.edges.some(
    (e) => e.src === a.path && e.dst === "papers/llm4rec-03-训练目标与偏好对齐/【索引】llm4rec-03-训练目标与偏好对齐.md" && e.type === "plain"));
  check("索引笔记本身没有子方向", (idx2.byBasename.get("【索引】llm4rec-02-模型与架构").secondary || []).length === 0);

  // 现在子方向的**权威来源是 frontmatter**(属性面板能改、Dataview 能查),正文链接只作兜底
  const fieldRecs = recs.slice(0, 4).concat([{
    path: "papers/llm4rec-02-模型与架构/【2026】paper-f/【2026】paper-f.md",
    basename: "【2026】paper-f",
    content: [
      "---", "importance: 2", "reading: 在读",
      'title: "【2026】paper-f"', 'slug: "paper-f"', "year: 2026", 'pdf: "x.pdf"',
      "tags: [a, b]", 'table_summary: "d"',
      'sub_directions: ["[[【索引】llm4rec-03-训练目标与偏好对齐]]"]', "---",
      "## 归属\n- 主方向：[生成式建模与架构](../【索引】llm4rec-02-模型与架构.md)", "",
    ].join("\n"),
  }]);
  const idx3 = data.buildWikiIndex(fieldRecs, {});
  const f = idx3.byBasename.get("【2026】paper-f");
  check("子方向来自 frontmatter 字段 sub_directions",
    (f.secondary || []).join(",") === "papers/llm4rec-03-训练目标与偏好对齐/【索引】llm4rec-03-训练目标与偏好对齐.md",
    JSON.stringify(f.secondary));
  check("字段里的子方向也成边", idx3.edges.some(
    (e) => e.src === f.path && e.dst === "papers/llm4rec-03-训练目标与偏好对齐/【索引】llm4rec-03-训练目标与偏好对齐.md" && e.type === "plain"));
  check("reading / importance 也照常读出来", f.reading === "在读" && f.importance === 2);

  // 卡片上的 ＋ / ✕ 就是对这个字段增删(复用关系字段的 patch)
  const added = data.patchRelation(fieldRecs[4].content,
    { add: { field: "sub_directions", target: "【索引】llm4rec-01-表示与Tokenization" } });
  check("加子方向 = 往字段数组里加一个 wikilink",
    /^sub_directions: \["\[\[【索引】llm4rec-03-训练目标与偏好对齐\]\]", "\[\[【索引】llm4rec-01-表示与Tokenization\]\]"\]$/m.test(added),
    (added.match(/^sub_directions:.*$/m) || [""])[0]);
  const removed = data.patchRelation(added, { remove: { field: "sub_directions", target: "【索引】llm4rec-03-训练目标与偏好对齐" } });
  check("删子方向后字段只剩另一个",
    /^sub_directions: \["\[\[【索引】llm4rec-01-表示与Tokenization\]\]"\]$/m.test(removed),
    (removed.match(/^sub_directions:.*$/m) || [""])[0]);
  const emptied = data.patchRelation(removed, { remove: { field: "sub_directions", target: "【索引】llm4rec-01-表示与Tokenization" } });
  check("删空 = 整个字段消失(不留空数组)", !/sub_directions:/.test(emptied));
}

console.log("\n== 回归:setText 不返回元素,不能链式调用 ==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  // 曾经写成 acts.createEl("button").setText("…").addEventListener(…) —— 读 undefined 抛异常,
  // 而且它包在操作用的 try 里,于是"写盘成功"被报成"操作失败"(详情卡那两个按钮也一直没生效)
  check("没有 setText(...).addEventListener(...) 链式调用",
    !/setText\([^;\n]*\)\s*\.\s*addEventListener/.test(src));
  check("没有 setText(...).其它方法() 链式",
    !/\.setText\([^;\n]*\)\s*\.\s*[a-zA-Z]+\(/.test(src));
}

console.log("\n== 浮层定位:贴鼠标而不是居中 ==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("没有调用方再居中弹层(menu.center() 已清零)", !/menu\.center\(\)/.test(src));
  check("openPanel 支持鼠标坐标并按 point 定位",
    /openPanel\(point\)/.test(src) && /Number\.isFinite\(pt\.x\)/.test(src));
  check("树行右键走统一节点菜单(带事件坐标)",
    /openNodeMenu\(node, \{ x: e\.clientX, y: e\.clientY \}\)/.test(src));
  check("卡片三个入口(标签/状态/关系)都带坐标",
    /openTagPicker\(node, \{ x: e\.clientX, y: e\.clientY \}\)/.test(src) &&
    /openStateEditor\(\{ x: e\.clientX, y: e\.clientY \}\)/.test(src) &&
    /openRelPicker\(node, \{ x: e\.clientX, y: e\.clientY \}\)/.test(src));
  check("拖放确认层也带坐标",
    /confirmMove\(src, node, \{ x: e\.clientX, y: e\.clientY \}\)/.test(src));
}

console.log("\n== 右键新建:方向索引 / 论文 stub ==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("统一菜单:论文/索引都有右键入口,且菜单含新建方向/新建论文",
    /openNodeMenu\(node, \{ x: e\.clientX, y: e\.clientY \}\)/.test(src) &&
    /新建方向索引/.test(src) && /新建论文笔记/.test(src));
  // 待归档与方向互斥:它不能出现在「加子方向」的候选里,也不接受待归档里的论文加子方向。
  check("子方向选择器排除待归档(互斥分区,不是方向)",
    /const UNFILED_INDEX_BASENAME/.test(src) &&
    /n\.basename !== UNFILED_INDEX_BASENAME/.test(src) &&
    /async addSecondaryDir\(node, dirNode\)[\s\S]{0,500}UNFILED_INDEX_BASENAME/.test(src));
  check("待归档里的论文不能加子方向(先定主方向)",
    /posixDirname\(posixDirname\(node\.path\)\) === this\.unfiledDir\(\)/.test(src));
  check("createDirection 与 scaffold 同构:建文件夹 + 【索引】骨架 + graph.json colorGroups 分色",
    /createFolder\(`\$\{paperRoot\}\/\$\{safe\}`\)/.test(src) &&
    /【索引】\$\{safe\}\.md/.test(src) &&
    /colorGroups/.test(src) && /path:"\$\{safe\}"/.test(src));
  check("分色规则与 research_wiki.py 一致(同一调色板 + 最小色距 80)",
    /COLOR_MIN_DISTANCE = 80/.test(src) && /pickGraphColor\(used\)/.test(src) &&
    (() => {
      // 插件里的 SCAFFOLD_PALETTE 与 tools/research_wiki.py 的 GRAPH_PALETTE 逐项相等
      const py = fs.readFileSync(path.join(__dirname, "../../../../tools/research_wiki.py"), "utf8");
      const m = py.match(/GRAPH_PALETTE = \[([^\]]+)\]/);
      if (!m) return false;
      const pyColors = m[1].match(/0x[0-9A-Fa-f]{6}/g)
        .map((s) => "#" + s.slice(2).toUpperCase());
      const jsColors = data.SCAFFOLD_PALETTE.map((c) => c.toUpperCase());
      return JSON.stringify(pyColors) === JSON.stringify(jsColors);
    })(), JSON.stringify(data.SCAFFOLD_PALETTE));
  check("createPaperStub 与 new 命令同构:标准 frontmatter 字段一个不少",
    /createPaperStub\(dirName, year, clean, summary/.test(src) &&
    /importance: 1/.test(src) && /reading: 未读/.test(src) &&
    /direction: "\[\[【索引】\$\{dirName\}\]\]"/.test(src) &&
    /title: "【\$\{year\}】\$\{slug\}"/.test(src));
  check("PromptModal 回车即提交、空值不提交",
    /class PromptModal extends Modal/.test(src) &&
    /e\.key === "Enter"/.test(src) && /if \(!v\) return;/.test(src));
  check("新论文 stub 的 pdf 字段留空待补(PDF 拖进文件夹后自己填)",
    /pdf: ""/.test(src));

  // 纯函数:分色逻辑
  check("pickGraphColor 跳开已占用的颜色(与首个已用色冲突的候选被跳过)",
    data.pickGraphColor(["#4C8DFF"]) !== "#4C8DFF" &&
    data.pickGraphColor([]) === "#4C8DFF");
  check("色距小于 80 视为同色(#A8639F vs #A86BE0 那次教训)",
    data.colorDistance("#A8639F", "#A86BE0") < data.COLOR_MIN_DISTANCE &&
    data.colorDistance("#4C8DFF", "#2ECC71") >= data.COLOR_MIN_DISTANCE);
  check("parseColor 解析不了的输入不卡分色(返回 Infinity 距离)",
    data.colorDistance("#4C8DFF", "not-a-color") === Infinity);
}

console.log("\n== 添加论文:从 PDF 猜元数据 + 生成模板 ==");
{
  // 1) 文件名推断
  const g1 = data.guessFromPdf("【2026】UniSGR- Unified Framework.pdf");
  check("从文件名猜出年份/标题/slug",
    g1.year === "2026" && g1.slug === "unisgr-unified-framework" && /UniSGR/.test(g1.title),
    JSON.stringify(g1));
  const g2 = data.guessFromPdf("arXiv 2504.03751 A Survey of Generative Recommendation.pdf");
  check("无年份前缀时退化到文件名里的年份与 slug",
    g2.year === "2504" || g2.year.length === 4, JSON.stringify(g2));
  const g3 = data.guessFromPdf("中文论文标题.pdf");
  check("纯中文文件名 slug 退化为 untitled(交给用户改)", g3.slug === "untitled", JSON.stringify(g3));

  // 2) YAML 值安全
  check("yamlValue 去掉反斜杠、双引号换单引号、压掉换行",
    data.yamlValue('a "b" c\\d\ne') === "a 'b' cd e", JSON.stringify(data.yamlValue('a "b" c\\d\ne')));

  // 3) 模板完整性
  const built = data.buildPaperNote({
    dirName: "_unfiled", year: "2026", slug: "my-paper", title: "My Paper: A Study",
    tags: ["semantic-id", "codebook"], summary: "问题 + 方法",
    authors: ["A", "B"], pdfName: "【2026】my-paper.pdf", abstract: "原摘要第一行\n第二行",
  });
  check("模板文件夹名 = 【year】slug", built.folderName === "【2026】my-paper");
  for (const line of [
    'title: "【2026】My Paper: A Study"', 'slug: "my-paper"', "year: 2026",
    'pdf: "【2026】my-paper.pdf"', "direction: \"[[【索引】_unfiled]]\"",
    "tags: [semantic-id, codebook]", 'authors: ["A", "B"]',
  ]) {
    check("模板含 " + line, built.text.includes(line));
  }
  check("模板含 PDF callout 与返回方向页",
    built.text.includes("> [!note] 📄 原文 PDF：[[【2026】my-paper.pdf|在侧栏打开原文]]") &&
    built.text.includes("- [返回方向页](../【索引】_unfiled.md)"));
  check("原摘要放进 [!abstract] 块(不污染 frontmatter)",
    built.text.includes("> [!abstract] 原摘要") && built.text.includes("> 原摘要第一行") &&
    built.text.indexOf("> [!abstract]") > built.text.indexOf("---\n\n"));

  // 4) PDF 字符串解码(UTF-16BE BOM)
  check("decodePdfString 解 UTF-16BE BOM",
    data.decodePdfString("(þÿ\x00C\x00o\x00m\x00i\x00R\x00e\x00c)") === "ComiRec",
    JSON.stringify(data.decodePdfString("(þÿ\x00C\x00o\x00m\x00i\x00R\x00e\x00c)")));

  // 5) 首页文本启发式
  const parsed = data.parsePaperText(
    "arXiv:2504.03751v1 [cs.IR] 1 Apr 2025 A Survey of Generative Recommendation " +
    "Xiaopeng Li, Bo Chen, Tsinghua University Abstract This survey studies generative " +
    "recommendation. 1 Introduction Generative recommendation is ...");
  check("从首页文本里切出标题与摘要",
    /Survey of Generative Recommendation/.test(parsed.title) &&
    /generative recommendation/i.test(parsed.abstract),
    JSON.stringify(parsed).slice(0, 140));

  // 6) UI 接线(源码断言)
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("顶栏有「添加论文」按钮", /mkBtn\(actions, "file-plus", "添加论文/.test(src));
  check("命令面板有「添加论文」命令", /id: "add-paper"/.test(src));
  check("弹窗用 file input 选 PDF、默认方向取列表第一个(_unfiled)", 
    /type: "file"/.test(src) && /dirSelect\.value = this\.directions\[0\]/.test(src));
  check("拷 PDF 走 createBinary(不依赖 Node fs;无 PDF 路径跳过它)",
    /vault\.createBinary\(`\$\{folderPath\}\/\$\{pdfName\}`, buf\)/.test(src) &&
    /if \(file\) \{[\s\S]{0,120}?createBinary/.test(src));
  check("方向列表把 _unfiled 排在最前(默认提交到待归档)",
    /if \(unfiled\) rest\.unshift\(unfiled\)/.test(src));
  check("选完 PDF 自动解析,有 arXiv 编号时查权威元数据",
    /extractPaperInfo\(buf\)/.test(src) && /fetchArxivMeta\(info\.arxivId\)/.test(src));
}

console.log("\n== 回归:ego 子图里给两个邻居连线,边要立刻出现在图上 ==");
{
  // 最小 fixture:A 是中心,B/C 是它的两个邻居;B—C 之间新建一条 competes
  const mk = (name, rels) => ({
    path: `papers/x-01-方向/【2026】${name}/【2026】${name}.md`,
    basename: `【2026】${name}`,
    content: ["---", "importance: 1", "reading: 未读",
      `title: "【2026】${name}"`, `slug: "${name}"`, "year: 2026", 'pdf: "x.pdf"',
      "tags: [a, b]", 'table_summary: "d"', ...rels, "---", ""].join("\n"),
  });
  const recs = [
    { path: "【索引】研究总览.md", basename: "【索引】研究总览", content: '---\ntitle: "【索引】研究总览"\n---\n## 大类别\n- [[【索引】papers]]\n' },
    { path: "papers/【索引】papers.md", basename: "【索引】papers", content: '---\ntitle: "【索引】papers"\n---\n## 大类别\n- [[【索引】x-01-方向]]\n' },
    { path: "papers/x-01-方向/【索引】x-01-方向.md", basename: "【索引】x-01-方向",
      content: '---\ntitle: "【索引】01-方向"\n---\n## 论文\n' },
    mk("a", ['competes: ["[[【2026】b]]", "[[【2026】c]]"]']),
    mk("b", ['competes: ["[[【2026】a]]"]']),
    mk("c", ['competes: ["[[【2026】a]]"]']),
  ];
  const idx = data.buildWikiIndex(recs, {});
  const a = idx.byBasename.get("【2026】a");
  const bPath = idx.byBasename.get("【2026】b").path;
  const cPath = idx.byBasename.get("【2026】c").path;
  const before = data.computeSubGraph(idx, a.path, {});
  check("连线前:B、C 都在 a 的 ego 图里", before.nodes.some((n) => n.path === bPath) &&
    before.nodes.some((n) => n.path === cPath));
  check("连线前没有 B—C 的边", !before.edges.some(
    (e) => (e.src === bPath && e.dst === cPath) || (e.src === cPath && e.dst === bPath)));

  // 模拟 writeEdge:写进索引边集合后 refreshSubGraph 重算
  idx.edges.push({ src: bPath, dst: cPath, type: "competes" });
  const after = data.computeSubGraph(idx, a.path, {});
  check("连线后 B—C 的边立刻出现在 ego 图里(不再静默消失)", after.edges.some(
    (e) => (e.src === bPath && e.dst === cPath) || (e.src === cPath && e.dst === bPath)));
  check("诱导子图不会把邻居的邻居拖进来", after.nodes.length === before.nodes.length,
    `${after.nodes.length} vs ${before.nodes.length}`);
}

console.log("\n== depth 剪枝：self / 1 / full ==");
{
  const rec = (path, fm, body = "") => ({
    path, basename: path.split("/").pop().replace(/\.md$/, ""),
    content: `---\n${fm}\n---\n${body}\n`,
  });
  const idx = data.buildWikiIndex([
    rec("【索引】研究总览.md", 'title: "【索引】研究总览"'),
    rec("units/【索引】units.md", 'title: "【索引】Units"', "## 成员\n- [[【索引】a]]"),
    rec("units/a/【索引】a.md", 'kind: unit\ntitle: "A"\ndepth: "1"', "## 成员\n- [[【索引】b]]"),
    rec("units/a/b/【索引】b.md", 'kind: unit\ntitle: "B"', "## 成员\n- [[【索引】c]]"),
    rec("units/a/b/c/【索引】c.md", 'kind: unit\ntitle: "C"'),
    rec("units/leaf.md", 'kind: unit\ntitle: "Leaf"\ndepth: self'),
  ], { schema: realSchema || undefined });

  const a = idx.byBasename.get("【索引】a");
  const b = idx.byBasename.get("【索引】b");
  const c = idx.byBasename.get("【索引】c");
  const leaf = idx.byBasename.get("leaf");
  check("depth:1 → 只留直接下一层",
    a && a.children.length === 1 && a.children[0] === b.path,
    a && JSON.stringify(a.children));
  check("depth:1 的孙层被剪掉（b 没有 c）",
    b && b.children.length === 0, b && JSON.stringify(b.children));
  check("depth:self → 没有子节点（内部自由管理）",
    leaf && leaf.children.length === 0 && leaf.boundary === true);
  check("剪枝后 parent 链正确", a.parent === "units/【索引】units.md" && b.parent === a.path);
}

console.log("\n== Locator adapters：解析 / stat / 打开 ==");
{
  const A = require("./adapters.js");
  const p1 = A.parseLocator("file:///Users/me/proj");
  check("file:// 解析成本地路径", p1.scheme === "file" && p1.path === "/Users/me/proj", JSON.stringify(p1));
  const p2 = A.parseLocator("git@github.com:org/repo.git");
  check("git@ 解析并转成 https", p2.scheme === "git" && p2.url === "https://github.com/org/repo", JSON.stringify(p2));
  const p3 = A.parseLocator("https://github.com/org/repo.git");
  check("https .git 识别为 git 仓库", p3.scheme === "git" && p3.url === "https://github.com/org/repo", JSON.stringify(p3));
  const p4 = A.parseLocator("ssh://me@host:/data/proj");
  check("ssh:// 解析 host + path", p4.scheme === "ssh" && p4.host === "me@host" && p4.path === "/data/proj", JSON.stringify(p4));
  const p5 = A.parseLocator("https://example.com/paper");
  check("普通 https 识别为网页", p5.scheme === "web", JSON.stringify(p5));
  check("空 locator = vault 内笔记", A.parseLocator("").scheme === "note");

  const st = A.statLocal(__dirname);
  check("statLocal 读本地目录：ok + 文件数 + 目录数",
    st.ok && st.isDir && st.files > 0, JSON.stringify(st));
  check("statLocal 不存在的路径返回 ok:false", A.statLocal("/definitely/not/here").ok === false);

  const remote = A.statResource("git@github.com:org/repo.git");
  check("远程 git 不探测网络，返回 remote 标记", remote.ok && remote.remote && remote.files === null);
  check("describeStat 给出人读摘要",
    /内部自由管理 · \d+ 文件 \/ \d+ 目录/.test(A.describeStat(st)) &&
    /远程 git 仓库/.test(A.describeStat(remote)));

  // 打开动作：注入假实现，测试时不真的打开任何东西
  const calls = [];
  const deps = {
    openPath: (p) => { calls.push(["path", p]); return ""; },
    openExternal: (u) => { calls.push(["url", u]); },
    clipboard: { writeText: (t) => calls.push(["clip", t]) },
  };
  A.openResource("file:///tmp", deps);
  A.openResource("git@github.com:org/repo.git", deps);
  A.openResource("ssh://me@host:/data", deps);
  check("打开本地目录走 openPath", calls.some((c) => c[0] === "path" && c[1] === "/tmp"));
  check("打开 git 仓库走浏览器", calls.some((c) => c[0] === "url" && c[1] === "https://github.com/org/repo"));
  check("ssh 打开 = 复制 ssh 命令（不弹终端）", calls.some((c) => c[0] === "clip" && /^ssh me@host$/.test(c[1])));

  // 边界节点：显式 kind(depth: self) vs paper(depth: full)——kind 是 frontmatter
  // 显式声明的（schema 没登记 unit 也能测：机制不依赖具体 kind）
  const rec = (path, fm) => ({ path, basename: path.split("/").pop().replace(/\.md$/, ""),
    content: `---\n${fm}\n---\n` });
  const idx = data.buildWikiIndex([
    rec("【索引】研究总览.md", 'title: "【索引】研究总览"'),
    rec("units/ok.md", 'kind: unit\ntitle: "OK"\nlocator: "file:///tmp"'),
    rec("units/other.md", 'kind: unit\ntitle: "Other"'),
    rec("papers/x-01-方向/【索引】x-01-方向.md", 'title: "【索引】01-方向"'),
    rec("papers/x-01-方向/【2026】p/【2026】p.md", 'title: "【2026】p"'),
  ], { schema: realSchema || undefined });

  const proj = idx.byBasename.get("ok");
  const other = idx.byBasename.get("other");
  const paper = idx.byBasename.get("【2026】p");
  check("默认 depth=self → 边界节点",
    other && other.kind === "unit" && other.effectiveDepth === "self" && other.boundary === true,
    JSON.stringify(other && { k: other.kind, d: other.effectiveDepth, b: other.boundary }));
  check("paper 默认 depth=full → 不是边界节点", paper && paper.boundary === false);
  check("显式 locator 被保留", proj && proj.locator === "file:///tmp", proj && proj.locator);
  check("locator 字段在 schema 里登记",
    (realSchema || data.DEFAULT_SCHEMA).fields.some((f) => f.id === "locator"));
}

console.log("\n== 资源可达性：不可达标记与待确认 ==");
{
  const rec = (path, fm) => ({ path, basename: path.split("/").pop().replace(/\.md$/, ""),
    content: `---\n${fm}\n---\n` });
  const idx = data.buildWikiIndex([
    rec("units/ok.md", 'kind: unit\ntitle: "OK"\nlocator: "file:///tmp"'),
    rec("units/bad.md", 'kind: unit\ntitle: "Bad"\nlocator: "file:///definitely/not/here"'),
    rec("units/remote.md", 'kind: unit\ntitle: "Remote"\nlocator: "git@github.com:org/repo.git"'),
  ], { schema: realSchema || undefined });
  const ok = idx.byBasename.get("ok"), bad = idx.byBasename.get("bad"), remote = idx.byBasename.get("remote");
  check("本地 locator 存在 → resourceOk=true", ok && ok.resourceOk === true);
  check("本地 locator 不存在 → resourceOk=false + 原因",
    bad && bad.resourceOk === false && !!bad.resourceError, JSON.stringify(bad && bad.resourceError));
  check("远程 locator 不做探测 → resourceOk=null", remote && remote.resourceOk === null);

  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("插件有「检查资源可达性」命令", /id: "check-resources"/.test(src));
  check("describeJSON 输出 unreachable 列表", /unreachable/.test(src));
  check("不可达节点在树/画布上有标记",
    /pnx-badge-error/.test(src) && /resourceOk === false/.test(src));
}

console.log("\n== describe：CLI 与插件同构 ==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("插件提供「描述库结构」命令", /id: "describe-schema"/.test(src));
  check("describeJSON 输出 kinds/fields/instances/boundaries/operations",
    ["kinds:", "fields:", "instances", "boundaries", "operations"].every((k) => src.includes(k)));
  check("节点保留 depth / locator，供边界判断与 describe 使用",
    /depth: fm\.depth != null/.test(src) && /locator: fm\.locator \|\| null/.test(src));
  // CLI 侧：pinakes.py describe 的顶层键必须一致
  const py = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "tools", "pinakes.py"), "utf8");
  check("CLI 与插件输出的顶层键一致",
    ["schema_version", "kinds", "fields", "unknown", "instances", "boundaries", "operations"]
      .every((k) => py.includes(k) && src.includes(k)));
}

console.log("\n== 索引表一致性:插件里改内容后方向索引必须同步 ==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("paperDirectionDir 只认 papers/<方向>/<论文>/<笔记>.md",
    /paperDirectionDir\(path\) \{/.test(src) && /parts\.length !== 4/.test(src));
  // 四列全来自 frontmatter:标题/年份/标签/简介 —— 改任何一列都要重建索引表
  check("新建论文后重建方向索引", /regenerateIndexFor\(dirPath\);\s*\/\/ 新论文要立刻出现/.test(src));
  check("删除论文后重建方向索引", /regenerateIndexFor\(dirPath\);\s*\/\/ 被删的论文要从表里消失/.test(src));
  check("改显示名(title)后重建方向索引", /\/\/ 索引表第一列就是 title/.test(src));
  check("改标签(tags)后重建方向索引", /\/\/ 「关键词」列来自 tags/.test(src));
  check("删除时把笔记路径一起传下去(知道属于哪个方向)", /trashPath\(target, node\.path\)/.test(src));
}

console.log("\n== 专题页(topic kind):没有 status_field,所以没有状态行 ==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("statusFieldOf 对 topic 返回 null(专题页没有进度轴)",
    data.statusFieldOf(realSchema || data.DEFAULT_SCHEMA, "topic") === null &&
    data.statusFieldOf(realSchema || data.DEFAULT_SCHEMA, "topic_library") === null);
  // 详情卡与树徽标都走 statusAxis:null 轴 = 不画那一行/只画重要性
  check("详情卡状态行由 axis 驱动(null 轴就跳过)",
    /const axis = this\.statusAxis\(node\);/.test(src) &&
    /if \(axis\) \{\s*\n\s*const rdRow/.test(src));
  check("树徽标:无轴的叶子只画重要性",
    /const axis = this\.statusAxis\(node\);\s*\n\s*if \(axis\) \{/.test(src) &&
    !/isIdeaPath|isDrPage/.test(src));
}

console.log("\n== 树节点右键菜单:打开/重命名/删除/复制 ==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const rows = [
    "打开笔记", "在新标签页打开", "重命名显示名", "重命名文件夹与 slug",
    "重命名方向", "重命名索引文件", "删除论文", "删除笔记",
    "复制 wikilink", "复制库内路径", "在文件列表中显示", "移动到其他方向",
    "新建论文笔记", "新建方向索引",
  ];
  check("菜单包含全部节点操作(打开/重命名/删除/复制/移动/新建)",
    rows.every((r) => src.includes(r)),
    rows.filter((r) => !src.includes(r)).join(", "));

  // 重命名 slug:笔记、PDF、文件夹三样都要改,frontmatter 的 slug/pdf 要跟上
  check("论文 slug 重命名同时改 笔记 / PDF / 文件夹",
    /renamePaperSlug/.test(src) &&
    /renameFile\(note, `\$\{folderPath\}\/\$\{newFolder\}\.md`\)/.test(src) &&
    /renameFile\(oldPdf,/.test(src) &&
    /renameFile\(folder, newFolderPath\)/.test(src));
  check("slug 重命名后回写 frontmatter 的 slug 与 pdf",
    /patchScalarField\(t, "slug", `"\$\{slug\}"`\)/.test(src) &&
    /patchScalarField\(out, "pdf", `"\$\{pdfName\}"`\)/.test(src));
  check("方向重命名会改文件夹 + 索引 + 每篇论文的 direction 字段",
    /renameDirection/.test(src) &&
    /renameFile\(folder, newDirPath\)/.test(src) &&
    /direction: "\[\[【索引】\$\{newName\}\]\]"/.test(src));
  check("显示名重命名只改 frontmatter 的 title(不动文件名)",
    /renameDisplay/.test(src) && /patchScalarField\(t, "title"/.test(src));
  check("删除走 Obsidian 回收站(trashFile,旧版回退 vault.trash)",
    /fileManager\.trashFile\(f\)/.test(src) && /vault\.trash\(f, true\)/.test(src));
  check("删除论文时删整个文件夹(笔记 + PDF),不是只删笔记",
    /const target = isPaper \? posixDirname\(node\.path\) : node\.path;/.test(src));
  check("复制 wikilink / 路径走剪贴板",
    /navigator\.clipboard\.writeText/.test(src) && /复制库内路径/.test(src));
}

console.log("\n== 图例与边菜单用英文字段名 ==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  // 四种关系的显示名 = 字段名本身(与 frontmatter 里写的、词表里的完全一致)
  check("REL_META 的 label 就是字段名",
    data.REL_KEYS.every((k) => data.REL_META[k].label === k),
    JSON.stringify(data.REL_KEYS.map((k) => data.REL_META[k].label)));
  check("图例里不再有中文关系名",
    !/承接线|零件线|对抗线|冲突线/.test(src),
    (src.match(/承接线|零件线|对抗线|冲突线/g) || []).join(","));
  check("结构线图例也是英文(hierarchy / plain link / attribution)",
    /"hierarchy" : t === PLAIN_TYPE \? "plain link" : "attribution"/.test(src));
  // 词表(权威)与插件(渲染副本)的 label 必须一致
  const vocab = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "tools", "relation_vocabulary.yml"), "utf8");
  check("词表 label 与插件一致(权威副本同步)",
    data.REL_KEYS.every((k) => {
      const m = vocab.match(new RegExp("^  " + k + ":[\\s\\S]*?label: ([^\\s#]+)", "m"));
      return m && m[1] === data.REL_META[k].label;
    }));
}

console.log("\n== 根笔记设置自愈 ==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("根笔记改名后自动收编 vault 根部的【索引】*.md,并写回设置",
    /candidate = records\.find\(/.test(src) && /\^【索引】.*\.md\$/.test(src) &&
    /this\.plugin\.settings\.rootNote = candidate\.path;/.test(src));
  check("默认根笔记已是【索引】研究总览.md",
    /rootNote: "【索引】研究总览\.md"/.test(src));
}

console.log("\n== 节点颜色:右键改色,子树继承 ==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("设置里有 nodeColors(路径 → hex)默认空",
    /nodeColors: \{\}/.test(src));
  check("nodeColor 沿 parent 链向上找最近的覆盖(父配色 → 子继承)",
    /for \(let n = node; n; n = n\.parent \? this\.index\.nodes\.get\(n\.parent\) : null\) \{\s*\n\s*const custom/.test(src));
  check("nodeColorSource 区分自己配的还是继承的",
    /nodeColorSource\(node\) \{[\s\S]{0,300}?own: n\.path === node\.path/.test(src));
  check("画布索引圈描边 = nodeColor(覆盖色与树点/图例同源)",
    /ctx\.strokeStyle = pure;/.test(src));
  check("右键菜单有「节点颜色…」入口(已配色显示「换个颜色」,根节点不给改)",
    /节点颜色…/.test(src) && /换个颜色…/.test(src) &&
    /if \(kind !== "root"\) \{\s*\n\s*const src = this\.nodeColorSource/.test(src));
  check("颜色菜单:色板 + 自定义取色器 + 恢复继承/默认,继承时写明来源",
    /openNodeColorMenu\(node, point\)/.test(src) &&
    /type: "color"/.test(src) && /恢复继承\/默认颜色/.test(src) &&
    /当前继承自/.test(src));
  check("setNodeColor:有值写入、null 删除,保存后树/卡/画布都刷新",
    /if \(hex\) colors\[node\.path\] = hex;\s*\n\s*else delete colors\[node\.path\];/.test(src) &&
    /renderTree\(\);\s*\n\s*this\.renderCard/.test(src));
  check("重命名/移动/删除都同步颜色 key(rekeyNodeColors)",
    /rekeyNodeColors\(node\.path, newPath\)/.test(src) &&
    /rekeyNodeColors\(dirPath, newDirPath\)/.test(src) &&
    /rekeyNodeColors\(folderPath, newFolderPath\)/.test(src) &&
    /rekeyNodeColors\(srcFolderPath, `\$\{dstDir\}\/\$\{folderName\}`\)/.test(src) &&
    /rekeyNodeColors\(path, null\)/.test(src));
}

console.log("\n== 欢迎页与首次运行(从0复刻的引导)==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("设置有 welcomed(首次运行检测)", /welcomed: false/.test(src));
  check("首次运行 onLayoutReady 自动弹(1.2s 等索引),空库走「开始搭建」口径",
    /onLayoutReady/.test(src) && /getMarkdownFiles\(\)\.length <= 5/.test(src) &&
    /isFresh/.test(src));
  check("WelcomeModal:功能四条 + 三步上手 + 主按钮进添加论文",
    /class WelcomeModal extends Modal/.test(src) &&
    ["关系图谱", "添加论文", "动态看板", "搭配 AI 使用"].every((t) => src.includes(t)) &&
    /AGENTS\.md/.test(src) && /AI agent/.test(src) &&
    /三步上手/.test(src) && /新建第一篇论文/.test(src));
  check("欢迎页主按钮 = openAddPaper({ allowNoPdf: true })(增强版添加论文)",
    /openAddPaper\(\{ allowNoPdf: true \}\)/.test(src));
  check("关闭后落盘 welcomed=true(不再自动弹);命令面板与设置有手动入口",
    /this\.settings\.welcomed = true/.test(src) &&
    /id: "open-welcome"/.test(src) && /显示欢迎页/.test(src));
}

console.log("\n== 空库自举与无 PDF 建笔记(从0复刻)==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("reindex 对空 vault 自动建骨架(根笔记 + papers 入口 + _unfiled 分区)",
    /records\.length === 0/.test(src) && /bootstrapSkeleton\(\)/.test(src) &&
    /async bootstrapSkeleton\(\)[\s\S]{0,800}?【索引】研究总览\.md/.test(src) &&
    /async bootstrapSkeleton\(\)[\s\S]{0,3500}?【索引】\$\{UNFILED_DIR\}\.md/.test(src));
  check("AddPaperModal 支持无 PDF(allowNoPdf:跳过链接 + 提交校验放行)",
    /先不选 PDF,只建骨架/.test(src) &&
    /if \(!this\.file && !this\.allowNoPdf\) \{ err\.setText\("请先选一个 PDF"\); return; \}/.test(src));
  check("addPaperFromPdf 无 PDF 时跳过 createBinary,pdfName 空(走 buildPaperNote 的待补 callout)",
    /const pdfName = file \? `\【\$\{year\}\】\$\{slug\}\.pdf` : "";/.test(src));
  check("无 PDF 路径:不拷 PDF + 完成提示带补 PDF 指引",
    /if \(file\) \{\s*\n\s*\/\/ 1\) 拷 PDF/.test(src) &&
    /没有 PDF,拖进文件夹后把文件名填进 pdf 字段/.test(src));
  check("空库没有方向时 openAddPaper 先自动补 _unfiled 分区(ensureUnfiled)",
    /async openAddPaper\(opts = \{\}\)/.test(src) && /ensureUnfiled\(\)/.test(src) &&
    /async ensureUnfiled\(\)/.test(src));
  // 函数级验证:bootstrapSkeleton 产出的三篇笔记能被 buildWikiIndex 认出树
  check("骨架笔记喂给 buildWikiIndex:root→papers→_unfiled 树成立",
    (() => {
      // 从 main.js 源码里抠出 skeleton 数组的 path 列表与 text 模板并模拟创建
      const recs = [
        { path: "【索引】研究总览.md", basename: "【索引】研究总览",
          content: '---\ntitle: "【索引】研究总览"\n---\n## 大类别\n- [【索引】papers](papers/【索引】papers.md):论文库 —— 域(大类别)→ 方向 → 论文。\n' },
        { path: "papers/【索引】papers.md", basename: "【索引】papers",
          content: '---\ntitle: "【索引】papers"\n---\n## 大类别\n\n- (还没有域。)\n\n## 待归档\n\n- [[【索引】_unfiled]]\n' },
        { path: "papers/_unfiled/【索引】_unfiled.md", basename: "【索引】_unfiled",
          content: '---\ntitle: "【索引】_unfiled"\n---\n## 论文\n\n- (还没有待归档的论文)\n' },
      ];
      const idx = data.buildWikiIndex(recs, { rootNote: "【索引】研究总览.md", schema: realSchema || undefined });
      const papers = idx.byBasename.get("【索引】papers");
      const ok = idx.root && idx.root.path === "【索引】研究总览.md" &&
        papers && papers.kind === "library" &&
        papers.children.length === 1 && papers.children[0] === "papers/_unfiled/【索引】_unfiled.md";
      return !!ok;
    })());
}

console.log("\n== 提示条自动熄灭 ==");
{
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  check("setStatus 3 秒后自动淡出(不常驻)",
    /statusTimer = window\.setTimeout\(/.test(src) && /}, 3000\)/.test(src));
  check("新提示重置计时器,清空调用立即熄灭",
    /if \(this\.statusTimer\) \{ window\.clearTimeout\(this\.statusTimer\);/.test(src));
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);