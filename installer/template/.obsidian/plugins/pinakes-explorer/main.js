"use strict";
/*
 * Pinakes —— 逐层进入的关系图谱(左树右图;卡片里「进入」看下一层、「回到上层」返回)
 *
 * 左边一棵可点开的层级树(总览 → 域 → 方向 → 论文),右边画选中节点的子图:
 *  - 索引节点:整棵子树 + 树内的有类型关系边(子树模式)
 *  - 论文节点:ego 图 —— 它自己 + 与它有关系的论文(可跨方向)+ 到各自方向索引的归属线
 * 画布是手写的力导向布局(canvas 2D),不依赖任何外部库;层级从目录树推导,
 * 关系边从各篇 frontmatter 的 5 类字段解析,方向配色运行时读 .obsidian/graph.json。
 *
 * 纯数据层(buildWikiIndex / computeSubGraph)不依赖 obsidian,可以在 node 里单独测试:
 *   node -e "const m=require('./main.js'); …"   (没有 obsidian 时 module.exports 是测试面)
 */

let obsidian = null;
try { obsidian = require("obsidian"); } catch (e) { /* node 测试环境,没有 obsidian */ }

// locator adapters（不依赖 Obsidian；node 可单测）
let adapters = null;
try { adapters = require("./adapters.js"); } catch (e) { adapters = null; }

/* ======================= 常量 ======================= */

// 4 类关系。语义定义与判据在 wiki/AGENTS.md §3.1;机器可读真源是 tools/relation_vocabulary.yml,
// 这里是渲染副本(颜色/标签),改动必须同步 —— test.js 有断言盯着两者一致。
const REL_KEYS = ["extends", "uses", "competes", "contradicts"];

// 颜色/中文名与 tools/relation_vocabulary.yml 保持一致(词表是权威,这里只是渲染副本)
// 颜色取 Okabe-Ito 色盲安全调色板(Okabe & Ito, Color Universal Design;Wong, Nature Methods 2011):
// 关系线的红/紫在色觉障碍(以及小尺寸/低饱和打印)下最容易混,这三个值是最经得起检验的一组。
// 与 tools/relation_vocabulary.yml 的 color 保持一致 —— 改一处必改另一处。
const REL_META = {
  extends:     { label: "extends", color: "#56B4E9", symmetric: false },   // sky blue
  uses:        { label: "uses", color: "#009E73", symmetric: false },   // bluish green
  competes:    { label: "competes", color: "#D55E00", symmetric: true  },   // vermillion
  contradicts: { label: "contradicts", color: "#CC79A7", symmetric: true  },   // reddish purple
};
// 编辑模式工具栏里的第一项:无类型的普通链接(灰色,不进 frontmatter 关系字段)

// 阅读状态(未读/在读/精读)。用户可在详情卡里加自定义状态,存进插件 data.json;
// alpha 决定节点填充透明度,color 决定状态环的颜色。
// 取值直接用中文:笔记属性面板里显示、选择、搜索都是它,不再有英文 key ↔ 中文 label 的映射
const READING_DEFAULTS = [
  { key: "未读", label: "未读", color: "#8B949E" },   // 灰:还没碰
  { key: "在读", label: "在读", color: "#D29922" },   // 橙:手上正在啃
  { key: "已读", label: "已读", color: "#4C8DFF" },   // 蓝:翻过一遍
  { key: "精读", label: "精读", color: "#3FB950" },   // 绿:吃透了
];
const READING_UNREAD = "未读";
// 重要性 1–5:数字 → 节点半径(1 = 默认最小,5 = 最大)
const IMPORTANCE_MIN = 1;
const IMPORTANCE_MAX = 5;
/**
 * 正文里的笔记间链接(basename 列表)。用于把「默认链接」也画成图上的边:
 * 只认指向 .md 的 markdown 链接与 [[wikilink]],跳过 PDF 与自链。
 */
function bodyNoteLinks(text, selfBasename) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const out = [];
  // 目标可以是 `path.md` 或 `<path with space.md>` —— 【Deep Research】这类名字里就有空格,
  // 只认前者会静默漏掉一整批「专题页 → 论文」的边。
  for (const m of body.matchAll(/\]\((?:<([^>]*?\.md)(?:[#?][^>]*)?>|([^)\s]*?\.md)(?:[#?][^)]*)?)\)/g)) {
    const raw = m[1] !== undefined ? m[1] : m[2];
    const base = raw.split("/").pop().replace(/\.md$/, "");
    if (base && base !== selfBasename) out.push(base);
  }
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const base = m[1].trim();
    if (!base || base === selfBasename || /\.pdf$/i.test(base)) continue;
    out.push(base);
  }
  return [...new Set(out)];
}

/**
 * 某个二级小节里的 wikilink(返回 basename 列表)。
 *
 * 用途:**域(大类别)是索引笔记而不是文件夹**(2026-10-13 定),`papers/【索引】llm4rec.md`
 * 与 `papers/llm4rec-01-…/` 在目录树上毫无父子关系 —— 这层层级只能从笔记正文里读:
 * 域索引笔记的 `## 方向` 列出它的方向,根笔记的 `## 大类别` 列出各个域。
 */
function sectionNoteLinks(text, headings) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  // 一篇笔记可以有多个层级小节(如 papers 容器:## 大类别 + ## 待归档),
  // 每个都要读 —— 只取第一个会让后面的分区从树上消失。
  const out = [];
  for (const h of headings) {
    const re = new RegExp("^" + h + "[ \\t]*$", "m");
    const m = re.exec(body);
    if (!m) continue;
    const rest = body.slice(m.index + m[0].length);
    const next = rest.search(/^##[ \t]/m);
    for (const link of extractWikilinks(next < 0 ? rest : rest.slice(0, next))) {
      if (!out.includes(link)) out.push(link);
    }
  }
  return out;
}

// 方向索引里的论文列表 = 一张表(2026-10-13 起):论文 / 年份 / 关键词 / 简介。
// 与 tools/research_wiki.py 的 INDEX_COLUMNS / index_header() 必须逐字节一致(见下面的测试)。
const INDEX_COLUMNS = ["论文", "年份", "关键词", "简介"];
function tableCell(value) {
  return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}
function indexTableHeader(columns) {
  const cols = (columns && columns.length ? columns : INDEX_COLUMNS);
  return "| " + cols.join(" | ") + " |\n" +
    "| " + cols.map(() => "---").join(" | ") + " |";
}

/**
 * 生成方向索引的 `## 论文` 段落(与 research_wiki.py rebuild-index 同格式,
 * 见 wiki/AGENTS.md §5:一张四列表 —— 论文(链接)/ 年份 / 关键词 / 简介,按文件夹名字母序)。
 * 拖动换方向后插件用它就地重建索引,免得留一堆 index-stale;
 * test.js 里拿真库逐字节比对过,格式漂了会立刻红。
 */
function buildIndexSection(indexNode, nodes, columns) {
  // 排序键 = 文件夹名去掉 【年份】 前缀,与 rebuild-index 的
  // key=lambda p: re.sub(r"^【\\d+】", "", p.name) 一致(按整个文件名排会先按年份分组,顺序就错了)
  const sortKey = (b) => b.replace(/^【\d+】/, "");
  const kids = indexNode.children.map((p) => nodes.get(p))
    .filter((n) => n && n.children.length === 0)
    .sort((a, b) => {
      const ka = sortKey(a.basename), kb = sortKey(b.basename);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  const entries = kids.map((k) => {
    const title = tableCell(k.title || k.basename);
    const year = tableCell(k.year);
    const tags = (k.tags || []).map((t) => "`#" + t + "`").join(" ");
    return `| [${title}](${k.basename}/${k.basename}.md) | ${year} | ${tags} | ${tableCell(k.summary)} |`;
  });
  return "## 论文\n\n" + indexTableHeader(columns) + "\n" + entries.join("\n") + "\n";
}

/**
 * 颜色解析:`#rgb` / `#rrggbb` / `rgb(r,g,b)` / `rgba(r,g,b,a)` 都认。
 * Obsidian 的 CSS 变量(如 --background-primary)在不同主题里写法不一,只认 #rrggbb
 * 会算出 NaN → 无效颜色。解析不出来返回 null,由调用方兜底。
 */
function parseColor(s) {
  const v = String(s || "").trim();
  if (v.startsWith("#")) {
    if (v.length === 4) return [1, 2, 3].map((i) => parseInt(v[i] + v[i], 16));
    if (v.length >= 7) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
    return null;
  }
  const m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (m) return [1, 2, 3].map((i) => Math.round(Number(m[i])));
  return null;
}

/** 两个颜色按 t 混合(t=0 取 a,1 取 b)。把类别色往背景方向"退一步"用。
 *  任一端解析不出来就原样返回 a —— 宁可颜色不柔化,也不能画出无效色。 */
function mixHex(a, b, t) {
  const pa = parseColor(a), pb = parseColor(b);
  if (!pa || !pb || !pa.every(Number.isFinite) || !pb.every(Number.isFinite)) return a;
  const mix = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return "#" + mix.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}

/**
 * 初始布局(纯函数,可测):BFS 分层 → 同方向聚簇 → 按深度摆到环上。
 * 当前层的根固定在原点(它是这一屏的中心,局部图谱的通行做法);其余节点若上一轮有坐标就沿用
 * (重进入时不跳)。**注意别在这返回的字面量里写重复键** —— 曾经 x/y/fixed 各写两遍,
 * 后者覆盖前者,坐标变 undefined → 位置全 NaN → 整张图消失。
 */
function layoutNodes(sub, opts = {}) {
  const prev = opts.prev || new Map();
  const adj = new Map();
  for (const e of sub.edges) {
    if (!adj.has(e.src)) adj.set(e.src, []);
    if (!adj.has(e.dst)) adj.set(e.dst, []);
    adj.get(e.src).push(e.dst);
    adj.get(e.dst).push(e.src);
  }
  const depth = new Map([[sub.root, 0]]);
  let frontier = [sub.root];
  while (frontier.length) {
    const next = [];
    for (const p of frontier) {
      for (const q of adj.get(p) || []) {
        if (!depth.has(q)) { depth.set(q, depth.get(p) + 1); next.push(q); }
      }
    }
    frontier = next;
  }
  const byDepth = new Map();
  for (const n of sub.nodes) {
    const d = depth.get(n.path) ?? 3;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(n);
  }
  const out = [];
  for (const [d, group] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    // 同方向的排在一起,受力后自然聚簇
    const clusters = new Map();
    for (const n of group) {
      const key = n.direction || "_";
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key).push(n);
    }
    const flat = [...clusters.values()].flat();
    const R = d === 0 ? 0 : 130 * d + 40;
    flat.forEach((n, i) => {
      const p = prev.get(n.path);
      const ang = (i / Math.max(flat.length, 1)) * Math.PI * 2;
      const isRoot = n.path === sub.root;
      const isGhost = sub.ghosts && sub.ghosts.has(n.path);
      out.push({
        id: n.path,
        node: n,
        x: isRoot ? 0 : (p ? p.x : Math.cos(ang) * R + (Math.random() - 0.5) * 12),
        y: isRoot ? 0 : (p ? p.y : Math.sin(ang) * R + (Math.random() - 0.5) * 12),
        vx: 0,
        vy: 0,
        fixed: isRoot,
        r: isGhost ? 4.5
          : n.children.length > 0 ? radiusForIndex(n.descCount)
          : radiusForImportance(n.importance),
      });
    });
  }
  return out;
}

/** 标签框是否和已放置的不相撞(留 gap 间隙)—— 贪心避让,保证文字不叠 */
function labelFits(box, placed, gap = 2) {
  return !placed.some((b) =>
    box.x < b.x + b.w + gap && box.x + box.w + gap > b.x &&
    box.y < b.y + b.h + gap && box.y + box.h + gap > b.y);
}

function radiusForImportance(importance) {
  const n = Math.min(Math.max(importance || IMPORTANCE_MIN, IMPORTANCE_MIN), IMPORTANCE_MAX);
  // 面积 ∝ 重要性:半径走 sqrt,1→5.5 … 5→10(线性的半径会让高分球显得过大)
  return 5.5 + 4.5 * Math.sqrt((n - IMPORTANCE_MIN) / (IMPORTANCE_MAX - IMPORTANCE_MIN));
}

/** 索引/容器节点的半径:按后代篇数开方,并夹在 [8,14] —— 它是锚点,但不能压过论文 */
function radiusForIndex(descCount) {
  return Math.min(8 + 2.2 * Math.sqrt(Math.min(descCount || 0, 60) / 10), 14);
}
const UNREAD = READING_DEFAULTS[0];  // 默认档
// 新标签/新状态的默认配色(取完了就循环用)
const CHIP_PALETTE = ["#4C8DFF", "#E5534B", "#3FB950", "#A371F7", "#D29922",
  "#00BCD4", "#FF8CE2", "#8BC14A", "#A863AE", "#E91EB3"];

// 派生反向边的叫法(只用于详情卡里的入边标签;画布上不画重复的反向线)
const INVERSE_LABEL = {
  extends: "extended-by", uses: "used-by",
  competes: "competes", contradicts: "contradicts",
};

const HIER_TYPE = "hier";   // 索引 → 论文 的目录层级线
const ATTR_TYPE = "attr";   // ego 图里 论文 → 所属方向索引 的归属线
const HIER_COLOR = "#6E7681";
// Ideas 的进度档。**与论文的 `reading` 分开**:论文是"读到哪了",想法是"做到哪了"。
// 依据:Stage-Gate(Cooper) 的核心是阶段之间有 go/kill 闸门 —— 所以除推进档,还要有"废弃/搁置"
// 这类出口;TRL 的教训是档位别太多(9 级在个人知识库里没法用)。投稿流水线决定中间三档。
const IDEA_STAGES = [
  { key: "待做",   label: "待做",   color: "#8B949E" },   // 灰:记下来了,还没动
  { key: "在做",   label: "在做",   color: "#E69F00" },   // 橙:正在推进
  { key: "已成稿", label: "已成稿", color: "#56B4E9" },   // 天蓝:实验/写作完成,待投
  { key: "已投稿", label: "已投稿", color: "#0072B2" },   // 深蓝:under review
  { key: "已发表", label: "已发表", color: "#009E73" },   // 绿:accepted / published
  { key: "废弃",   label: "废弃",   color: "#D55E00" },   // 朱红:决定不做(留档不删)
];
const STAGE_FIELD = "stage";

// 子方向(frontmatter 字段,替代原先写在正文里的链接):wikilink 数组,指向别的方向索引
const SUB_DIRS_FIELD = "sub_directions";
// ── 画布视觉参数(集中一处,调手感只改这里)──────────────────────────
// 节点填充去饱和:与背景混合的比例。0 = 满饱和,1 = 完全融进背景。
// 之前给到 0.32 太淡 —— 节点一淡,饱和的关系线反而显得最重,整体失去平衡。
// 节点就是**你配的类别色,满不透明**(见 .obsidian/graph.json 的 colorGroups)——
// 这是最经得起看的默认:颜色是用户自己选的,不该被工具悄悄冲淡。
// "轻重对比"不靠整体调淡,而靠**压暗非焦点 + 焦点发光**(hover/focus/邻居才是亮的那一圈)。
// 想手动调:把 NODE_ALPHA 降到 0.9 左右会轻一点,升到 1 就是现在这样。
const NODE_SOFTEN = 0;         // 不去饱和(0 = 就用调色板原色)
const NODE_ALPHA = 1;          // 填充不透明
const GHOST_SOFTEN = 0.45;     // 子树外"幽灵"节点:明显更淡,和"属于这块"的区分开
const GHOST_ALPHA = 0.5;
// 边的视觉权重阶梯(从重到轻):关系 > 默认链接 > 归属 > 层级。
// 「默认链接」是正文里实打实写的关联,不能画得比结构线还虚;虚线的"虚"靠**长虚线**表达,
// 不靠把透明度压到看不见。
const EDGE_ALPHA = { rel: 0.45, relHover: 0.6, plain: 0.42, attr: 0.3 };
const EDGE_WIDTH = { rel: 1.35, relHover: 1.9, other: 1 };
const EDGE_ALPHA_HIER = 0.16;   // 层级线:极淡 —— 它是结构底噪,不该撑成"蜘蛛网"(树里已经表达了归属)
const EDGE_WIDTH_HIER = 0.8;
// 力导向参数:层级弹簧短(论文贴着索引)、关系弹簧略短(相关的聚一起)、斥力收敛、向心略强
const REST_LEN = { hier: 60, attr: 90, rel: 130 };
const REPULSION = 2100;
const CENTER_PULL = 0.008;
// 无类型链接(正文里的普通笔记间链接)在图上画成中性灰虚线
const PLAIN_TYPE = "plain";
const PLAIN_COLOR = "#B0B6BD";
// 索引/容器节点统一灰色(不再像论文那样染方向色)
const INDEX_COLOR = "#9AA0A6";
const ATTR_COLOR = "#8B949E";

// 这些目录/文件不是知识内容,不进树(SKIP_FILES 按 basename 比较,不含扩展名)
const SKIP_DIRS = new Set([".obsidian", "_dashboards", "_templates"]);
const SKIP_FILES = new Set(["AGENTS", "log"]);
// 文件夹的代表笔记:索引笔记或专题报告
const REP_RE = /^(【索引】|【Deep Research】)/;

/**
 * Schema 兜底：正常情况下由 `wiki/_schema/.compiled.json` 提供（tools/pinakes.py 编译）。
 * 这里只保留**与旧行为等价**的最小定义，保证 schema 文件缺失时插件照常工作。
 */
const DEFAULT_SCHEMA = {
  scan: {
    skip_dirs: [...SKIP_DIRS],
    skip_files: [...SKIP_FILES],
    rep_patterns: ["^【索引】", "^【Deep Research】"],
  },
  kinds: {
    root: { children_sections: ["## 大类别"], default_depth: "full" },
    library: { children_sections: ["## 大类别", "## 待归档"], default_depth: "full" },
    domain: { children_section: "## 方向", default_depth: "full" },
    direction: { children_section: "## 论文", default_depth: "full" },
    partition: { children_section: "## 论文", default_depth: "full" },
    paper: { default_depth: "full", leaf: true },
    topic_library: { children_section: null, default_depth: "full" },
    topic: { default_depth: "self", leaf: true },
    idea_library: { children_section: null, default_depth: "full" },
    idea_package: { children_section: null, default_depth: "full" },
    idea: { default_depth: "self", leaf: true },
  },
  detect: [
    { kind: "root", path_regex: "^【索引】[^/]+\\.md$" },
    { kind: "library", path_regex: "^papers/【索引】papers\\.md$" },
    { kind: "domain", path_regex: "^papers/【索引】[^/]+\\.md$" },
    { kind: "partition", path_regex: "^papers/_unfiled/【索引】[^/]+\\.md$" },
    { kind: "direction", path_regex: "^papers/[^/]+/【索引】[^/]+\\.md$" },
    { kind: "paper", path_regex: "^papers/[^/]+/【\\d{4}】[^/]+/【\\d{4}】[^/]+\\.md$" },
    { kind: "topic_library", path_regex: "^deep-research/【索引】[^/]+\\.md$" },
    { kind: "topic", path_regex: "^deep-research/.+/【Deep Research】[^/]+\\.md$" },
    { kind: "idea_library", path_regex: "^ideas/【索引】[^/]+\\.md$" },
    { kind: "idea_package", path_regex: "^ideas/[^/]+/【索引】[^/]+\\.md$" },
    { kind: "idea", path_regex: "^ideas/.+/【idea】[^/]+\\.md$" },
  ],
  fields: [],
  deprecated: [],
  unknown: { policy: "collect", promote_hint_after: 3 },
};

/** 从 schema 的 detect 规则推断路径 kind（无 schema 时返回 null）。 */
function kindOfPath(schema, path) {
  for (const rule of (schema && schema.detect) || []) {
    if (!rule.path_regex) continue;
    try {
      if (new RegExp(rule.path_regex).test(path)) return rule.kind;
    } catch (e) { /* 忽略坏正则 */ }
  }
  return null;
}

/** 某个 kind 用哪几节列子节点（一个容器可以有多节，如 `## 大类别` + `## 待归档`）。 */
function sectionsForKind(schema, kind) {
  const spec = schema && schema.kinds && schema.kinds[kind];
  if (!spec) return [];
  if (Array.isArray(spec.children_sections)) return spec.children_sections.filter(Boolean);
  return spec.children_section ? [spec.children_section] : [];
}

/** kind 的行为声明（ENTITY_MODEL.md §3.1）：schema 说什么,插件呈现什么。
 *  status_field = 进度轴字段(详情卡/树徽标那一行);root_dir = 实体树所在的顶层目录。
 *  没登记的 kind 两个都返回 null —— UI 上就是「没有状态行/不参与方向类操作」。 */
function statusFieldOf(schema, kind) {
  const spec = schema && schema.kinds && schema.kinds[kind];
  return (spec && spec.status_field) || null;
}
function rootDirOf(schema, kind) {
  const spec = schema && schema.kinds && schema.kinds[kind];
  return (spec && spec.root_dir) || null;
}
/** schema 里登记过的全部顶层目录(去重、按首次出现序)。 */
function rootDirsOf(schema) {
  const out = [];
  for (const spec of Object.values((schema && schema.kinds) || {})) {
    if (spec && spec.root_dir && !out.includes(spec.root_dir)) out.push(spec.root_dir);
  }
  return out;
}
// 待归档分区(`papers/_unfiled/`):论文库里唯一的非方向分区,与方向**互斥**。
// 它可以是论文的主方向(整篇放进去等待定方向),但绝不能被选成子方向。
const UNFILED_DIR = "_unfiled";
const UNFILED_INDEX_BASENAME = "【索引】" + UNFILED_DIR;

// 「列子节点」的小节名:域索引笔记用 `## 方向` 列方向,根笔记用 `## 大类别` 列域,
// 论文库入口用 `## 待归档` 挂那个唯一的非方向分区(它只是 todolist,不是知识方向)。
// 层级不只看目录树——域是笔记不是文件夹,这层父子关系只能从这几节里读(见 wiki/AGENTS.md §1)。
const HIERARCHY_HEADINGS = ["## 方向", "## 大类别", "## 待归档"];

// graph.json 丢失时的兜底配色(scaffold 分的 7 组颜色)
const FALLBACK_PALETTE = {
  "01-表示与Tokenization": "#4C8DFF",
  "02-生成式建模与架构":   "#2ECC71",
  "03-兴趣意图关系":       "#FF8CE2",
  "04-训练与偏好对齐":     "#A863AE",
  "05-系统Agent评估":      "#00BCD4",
  "_unfiled":              "#9AA0A6",   // 待归档分区:中性灰,不是方向
  "deep-research":         "#E91EB3",
};

// 新方向分色用的调色板与"两色至少差这么远才算不同色"的阈值
// —— 与 tools/research_wiki.py 的 GRAPH_PALETTE / COLOR_MIN_DISTANCE 保持一致,
// 两边给同一个新方向分出的颜色才不会漂。
const SCAFFOLD_PALETTE = [
  "#4C8DFF", "#2ECC71", "#FF8C42", "#A8639F", "#E0556C", "#9AA0A6",
  "#00BCD4", "#FFC107", "#8BC34A", "#E91E63", "#795548", "#3F51B5",
  "#FF7043", "#00897B", "#F4F47D", "#7DF4F4", "#8E28F4",
  "#0000F0", "#00F000", "#F00000", "#60F000", "#000090", "#009000",
  "#B08000", "#7000A0",
];
const COLOR_MIN_DISTANCE = 80;

/* ======================= 纯数据层(node 可测) ======================= */

function posixDirname(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function baseName(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
function rgbIntToHex(rgb) {
  return "#" + (rgb & 0xffffff).toString(16).padStart(6, "0");
}
/** 路径 → 配色/聚簇用的「方向」名：papers/<方向>/ 取方向名；其余取第一段目录
 *  （deep-research/xxx → "deep-research"）。rootDirs 是 schema 里登记的顶层目录,
 *  只在这些目录里按上面规则取;不在的返回 null(节点走灰色/不聚簇)。 */
function dirOf(path, rootDirs) {
  const dirs = rootDirs && rootDirs.length ? rootDirs : ["papers"];
  const m = path.match(/^([^/]+)\/([^/]+)\//);
  if (m && dirs.includes(m[1]) && !m[2].startsWith("【索引】")) return m[2];
  const top = path.split("/")[0];
  if (path.includes("/") && dirs.includes(top)) return top;
  return null;
}
function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/* ==================== 从 PDF 里读元数据(不装 OCR、不引依赖) ==================== */
// 三层,逐层兜底:
//   1. PDF 自带的 Info/XMP 元数据(`/Title` `/Author`、`dc:title` / `dc:creator`)—— 零成本
//   2. 文本型 PDF:用 zlib 解压内容流,抓 `(..)Tj` / `[..]TJ`,再从首页文本里猜标题/作者/摘要
//   3. arXiv 编号(1/2 里读到的 `arXiv:2504.03751`)→ 调 arXiv API 拿权威标题/作者/摘要
// 扫描版(纯图片)PDF 这三层都读不到字 —— 那时才需要 OCR,本插件不内置。

let _zlib = null;
try { _zlib = require("zlib"); } catch (e) { /* 非桌面环境 */ }

/** PDF 字面量字符串解码:`(...)` 的转义与 `<FEFF..>` 十六进制形式。 */
function decodePdfString(raw) {
  if (!raw) return "";
  let s = String(raw);
  if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1);
  // 字面量里的 UTF-16BE(以 FE FF 开头,读成 latin1 就是 "þÿ")
  if (s.startsWith("þÿ")) {
    let out = "";
    for (let i = 2; i + 1 < s.length; i += 2) {
      out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    }
    return out.replace(/\u0000/g, "");
  }
  const hex = s.match(/^<([0-9A-Fa-f\s]+)>$/);
  if (hex) {
    const bytes = hex[1].replace(/\s+/g, "");
    let out = "";
    for (let i = 0; i + 4 <= bytes.length; i += 4) {
      out += String.fromCharCode(parseInt(bytes.slice(i, i + 4), 16));
    }
    return out.replace(/^﻿/, "");
  }
  return s
    .replace(/\\([nrtbf()\\])/g, (m, c) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[c]))
    .replace(/\\([0-7]{1,3})/g, (m, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/** 从 PDF 原始字节里读 Info 字典与 XMP(不需要解压)。
 *  **只扫首尾有限字节**,且用 indexOf 线性扫 —— 正则回溯在大 PDF 上会把主线程卡住。 */
function readPdfMetaStrings(buf) {
  const bytes = new Uint8Array(buf);
  const toLatin = (u8) => {
    let out = "";
    for (let i = 0; i < u8.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 0x8000, u8.length)));
    }
    return out;
  };
  const headStr = toLatin(bytes.subarray(0, Math.min(bytes.length, 2 * 1024 * 1024)));
  const tailStr = bytes.length > 2 * 1024 * 1024
    ? toLatin(bytes.subarray(Math.max(0, bytes.length - 512 * 1024)))
    : "";
  const sources = tailStr ? [headStr, tailStr] : [headStr];

  /** 从 pos 处解析一个 PDF 值(受限长度):(literal) 或 <hex> */
  const valueAt = (hay, pos) => {
    let i = pos;
    while (i < hay.length && /\s/.test(hay[i])) i++;
    if (hay[i] === "(") {
      let out = "", depth = 1, j = i + 1;
      const limit = Math.min(hay.length, j + 4000);
      for (; j < limit; j++) {
        const c = hay[j];
        if (c === "\\") { out += hay[j + 1] || ""; j++; continue; }
        if (c === "(") { depth++; out += c; continue; }
        if (c === ")") { depth--; if (!depth) break; out += c; continue; }
        out += c;
      }
      return decodePdfString("(" + out + ")");
    }
    if (hay[i] === "<") {
      const j = hay.indexOf(">", i + 1);
      if (j > i && j - i < 4000) return decodePdfString(hay.slice(i, j + 1));
    }
    return "";
  };

  const grabInfo = (key) => {
    for (const hay of sources) {
      let i = hay.indexOf("/" + key);
      while (i >= 0) {
        const v = valueAt(hay, i + key.length + 1);
        if (v.trim()) return v.trim();       // 第一个非空的即可(文档级 Info 通常在最前/最后)
        i = hay.indexOf("/" + key, i + 1);
      }
    }
    return "";
  };

  const meta = { title: grabInfo("Title"), author: grabInfo("Author"), arxivId: "" };

  // XMP(线扫,不用跨段正则)
  if (!meta.title || !meta.author) {
    for (const hay of sources) {
      const tag = hay.indexOf("<dc:title>");
      if (!meta.title && tag >= 0) {
        const li = hay.indexOf("<rdf:li", tag);
        const gt = li >= 0 ? hay.indexOf(">", li) : -1;
        const close = gt >= 0 ? hay.indexOf("</rdf:li>", gt) : -1;
        if (gt > 0 && close > gt) meta.title = decodePdfString(hay.slice(gt + 1, Math.min(close, gt + 2000))).trim();
      }
      if (!meta.author) {
        const ctag = hay.indexOf("<dc:creator>");
        if (ctag >= 0) {
          const names = [];
          let cur = ctag;
          for (let k = 0; k < 8; k++) {
            const li = hay.indexOf("<rdf:li", cur);
            if (li < 0) break;
            const gt = hay.indexOf(">", li);
            const close = gt >= 0 ? hay.indexOf("</rdf:li>", gt) : -1;
            if (gt < 0 || close < 0 || close > gt + 500) break;
            const v = decodePdfString(hay.slice(gt + 1, close)).trim();
            if (v) names.push(v);
            cur = close + 8;
          }
          if (names.length) meta.author = names.slice(0, 6).join(", ");
        }
      }
    }
  }

  for (const hay of sources) {
    const arx = hay.match(/arXiv[:\s]*(\d{4}\.\d{4,5})(?:v\d+)?/i);
    if (arx) { meta.arxivId = arx[1]; break; }
  }
  return meta;
}

/** 解压 PDF 内容流并抽出文本。**手工扫描,不用回溯正则** ——
 *  某些 PDF 的内容流会让复杂正则卡死主线程(实测)。只解前 6MB、最多 20 个流、150ms 预算。 */
function extractPdfText(buf) {
  if (!_zlib) return "";
  const full = Buffer.from(buf);
  const slice = full.length > 6 * 1024 * 1024 ? full.subarray(0, 6 * 1024 * 1024) : full;
  const latin = slice.toString("latin1");
  const pieces = [];
  const deadline = Date.now() + 150;
  let pos = 0, taken = 0;

  while (taken < 20 && Date.now() < deadline) {
    const m = latin.indexOf("stream", pos);
    if (m < 0) break;
    // 必须紧跟换行才是数据开始
    let start = m + 6;
    if (latin[start] === "\r") start++;
    if (latin[start] === "\n") start++;
    const end = latin.indexOf("endstream", start);
    if (end < 0) break;
    pos = end + 9;
    const dict = latin.slice(Math.max(0, m - 600), m);
    if (dict.indexOf("/Image") >= 0 || dict.indexOf("/DCTDecode") >= 0 ||
        dict.indexOf("/JPXDecode") >= 0 || dict.indexOf("/FontFile") >= 0) continue;
    const chunk = slice.subarray(start, end);
    if (chunk.length > 512 * 1024) continue;
    let data = null;
    try { data = _zlib.inflateSync(chunk); } catch (e) {
      try { data = _zlib.inflateRawSync(chunk); } catch (e2) { data = null; }
    }
    if (!data) continue;
    taken++;
    const content = data.toString("latin1");
    // 扫所有 (...) 字符串:不判断操作符也能拿到正文(图片流已跳过)
    let i = 0;
    while (i < content.length && pieces.length < 4000) {
      const open = content.indexOf("(", i);
      if (open < 0) break;
      let out = "", depth = 1, j = open + 1;
      const limit = Math.min(content.length, j + 2000);
      for (; j < limit; j++) {
        const c = content[j];
        if (c === "\\") { out += content[j + 1] || ""; j++; continue; }
        if (c === "(") { depth++; out += c; continue; }
        if (c === ")") { depth--; if (!depth) break; out += c; continue; }
        out += c;
      }
      if (out.trim()) pieces.push(out);
      i = j + 1;
    }
    if (pieces.join("").length > 20000) break;
  }
  return pieces.join(" ").replace(/[ \t]+/g, " ").trim();
}

/** 从首页文本里猜标题/作者/摘要。论文 PDF 排版高度一致,这几条启发式够用。 */
function parsePaperText(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const res = { title: "", authors: "", abstract: "" };
  const abs = clean.search(/\babstract\b/i);
  const headRaw = abs > 0 ? clean.slice(0, abs) : clean.slice(0, 900);
  const head = headRaw
    .replace(/arXiv:\S+/gi, " ")
    .replace(/\b\d{1,2}\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*\d{4}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const authorRe = /(@|university|institute|laborator|inc\.|ltd\.|corp\.|research|school of|college|academy|department|dept\.|google|meta |microsoft|amazon|tencent|baidu|alibaba)/i;
  const sentences = head.split(/(?<=[.!?])\s+/).filter(Boolean);
  const titleParts = [];
  for (const s of sentences) {
    if (authorRe.test(s)) break;
    if (/\b(?:we|this paper|in this work)\b/i.test(s) && titleParts.length) break;
    titleParts.push(s);
    if (titleParts.join(" ").length > 240) break;
  }
  res.title = (titleParts.join(" ") || head.slice(0, 180)).replace(/[.,;:]\s*$/, "").trim();
  if (res.title && head.startsWith(res.title)) {
    res.authors = head.slice(res.title.length).replace(/^[\s,;:]+/, "").slice(0, 220).trim();
  }
  if (abs > 0) {
    const tail = clean.slice(abs).replace(/^abstract\b[\s:.–-]*/i, "");
    const intro = tail.search(/\b(?:1\s+)?introduction\b/i);
    res.abstract = (intro > 0 ? tail.slice(0, intro) : tail.slice(0, 1200)).trim();
  }
  return res;
}

/** 完整流程:原始字节 → { title, authors, abstract, arxivId, text } */
function extractPaperInfo(arrayBuffer) {
  const meta = readPdfMetaStrings(arrayBuffer);
  const text = extractPdfText(arrayBuffer);
  const parsed = parsePaperText(text);
  const arxivId = meta.arxivId || (text.match(/arXiv[:\s]*((?:\d{4}\.\d{4,5})(?:v\d+)?)/i) || [])[1] || "";
  return {
    title: meta.title || parsed.title,
    authors: meta.author || parsed.authors,
    abstract: parsed.abstract,
    arxivId,
    text,
  };
}

/* ==================== 添加论文:从 PDF 猜元数据 + 生成规范笔记 ==================== */
// 纯函数,node 里可测(见 test.js)。UI 侧只负责收集输入与落盘。

/** 从 PDF 文件名猜年份 / slug / 标题。
 *  例:`【2026】UniSGR- Unified Framework.pdf` → year 2026, slug "unisgr-unified-framework",
 *  title "UniSGR- Unified Framework"。猜不准的部分留给用户在弹窗里改。 */
function guessFromPdf(filename) {
  const base = String(filename || "").replace(/\.pdf$/i, "").trim();
  const yearMatch = base.match(/(?:^|[^0-9])((?:19|20)\d{2})(?:[^0-9]|$)/);
  const year = yearMatch ? yearMatch[1] : String(new Date().getFullYear());
  const title = base
    .replace(/^【\d{4}】/, "")
    .replace(/\b(?:arxiv|abs)[:\s-]*\d{4}\.\d{4,5}(v\d+)?/gi, "")
    .replace(/[【】\[\]()（）]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || base;
  const slug = base
    .toLowerCase()
    .replace(/^【\d{4}】/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90)
    .replace(/-+$/, "");
  return { year, title, slug: slug || "untitled" };
}

/** YAML 双引号标量:按本库约定(wiki/AGENTS.md §3)——去掉反斜杠、双引号换单引号、压掉换行。
 *  不写 `\"`:那是「反斜杠 + 结束引号」,整块 frontmatter 会解析失败。 */
function yamlValue(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "")
    .replace(/"/g, "'")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** 生成一篇论文笔记的完整模板(与 tools/research_wiki.py new 同构)。 */
function buildPaperNote({ dirName, year, slug, title, tags, summary, authors, pdfName, abstract }) {
  const folderName = `【${year}】${slug}`;
  const tagList = (tags || []).map((t) => String(t).trim()).filter(Boolean);
  const authorList = (authors || []).map((a) => String(a).trim()).filter(Boolean);
  const fm = [
    "---",
    "importance: 1",
    "reading: 未读",
    `direction: "[[【索引】${dirName}]]"`,
    `title: "【${year}】${yamlValue(title || slug)}"`,
    `slug: "${slug}"`,
    `year: ${year}`,
    `pdf: "${pdfName || ""}"`,
    `tags: [${tagList.join(", ")}]`,
    `table_summary: "${yamlValue(summary)}"`,
    `authors: [${authorList.map((a) => `"${yamlValue(a)}"`).join(", ")}]`,
    "---",
    "",
  ];
  const body = [
    pdfName
      ? `> [!note] 📄 原文 PDF：[[${pdfName}|在侧栏打开原文]]`
      : "> [!note] 📄 原文 PDF：(还没有 PDF,拖进本文件夹后补上 pdf 字段)",
    "",
    ...(abstract ? ["> [!abstract] 原摘要", ...abstract.split(/\n+/).map((l) => "> " + l), ""] : []),
    "## 整体综述",
    "",
    "（自由记录：这篇在解什么问题、关键机制、值不值得深读。下面几节只是起步建议，随意增删改名。）",
    "",
    "## 论文信息",
    `- 标题：${title || slug}`,
    `- 年份：${year}`,
    pdfName ? `- 原文：[${pdfName}](${pdfName})` : "- 原文：待补",
    "",
    "## 路径",
    `- [返回方向页](../【索引】${dirName}.md)`,
    "",
  ];
  return { folderName, text: fm.join("\n") + body.join("\n") };
}

/** 两个颜色的欧氏距离(RGB 通道)—— 新方向分色时保证与已用颜色拉得够开 */
function colorDistance(a, b) {
  const pa = parseColor(a), pb = parseColor(b);
  if (!pa || !pb) return Infinity;      // 解析不出来就当"足够远",别卡住建方向
  return Math.sqrt(pa.reduce((acc, v, i) => acc + (v - pb[i]) ** 2, 0));
}

/** 从调色板里挑一个与 used 全部拉开的颜色;挑不出就返回 null(调用方提示手配) */
function pickGraphColor(used) {
  return SCAFFOLD_PALETTE.find((c) =>
    used.every((u) => colorDistance(c, u) >= COLOR_MIN_DISTANCE)) || null;
}

/**
 * 取一个 frontmatter 字段的值,**含续行**(块列表 `- item` 也算)。
 * 续行用逗号拼起来,于是 wikilink / 标签 / 作者的解析逻辑对两种写法一视同仁:
 * Obsidian 的「笔记属性」面板会把列表改写成块列表形式,只认单行内联数组会静默丢边。
 */
function grabField(fm, key) {
  const lines = fm.split("\n");
  const re = new RegExp("^" + key + ":[ \\t]*(.*)$");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const parts = [m[1].trim()];
    for (let j = i + 1; j < lines.length; j++) {
      if (!/^[ \t-]/.test(lines[j])) break;
      parts.push(lines[j].replace(/^[ \t]*-[ \t]*/, "").trim());
    }
    return parts.filter(Boolean).join(", ");
  }
  return "";
}

/** 只抠 vault 里实际用到的 frontmatter 字段(标量 + 单层列表,不值得拉 YAML 库) */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  const fm = m[1];
  const grab = (key) => grabField(fm, key);
  const unquote = (s) => {
    if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
      // 单引号标量里 '' 是转义的单个 ' —— 不还原的话
      // 'A Practitioner''s Handbook' 会被读成带两个引号的标题
      return s.slice(1, -1).replace(/''/g, "'");
    }
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
    return s;
  };
  const t = grab("title");
  if (t) out.title = unquote(t);
  const ts = grab("table_summary");
  if (ts) out.summary = unquote(ts);
  const rd = grab("reading");
  if (rd) out.reading = unquote(rd);
  const yr = grab("year");
  if (yr) out.year = unquote(yr);
  const im = grab("importance");
  if (im) {
    const n = parseInt(unquote(im), 10);
    if (Number.isFinite(n) && n >= IMPORTANCE_MIN && n <= IMPORTANCE_MAX) out.importance = n;
  }
  const au = grab("authors");
  if (au) out.authors = parseInlineList(au);
  const tg = grab("tags");
  if (tg) {
    const inner = tg.startsWith("[") && tg.endsWith("]") ? tg.slice(1, -1) : tg;
    out.tags = inner.split(",").map((s) => unquote(s.trim())).filter(Boolean);
  }
  for (const key of REL_KEYS) {
    const v = grab(key);
    if (v) out[key] = v;
  }
  const stg = grab(STAGE_FIELD);
  if (stg) out[STAGE_FIELD] = unquote(stg);
  const sd = grab(SUB_DIRS_FIELD);
  if (sd) out[SUB_DIRS_FIELD] = sd;
  const dn = grab("direction");
  if (dn) out.direction = unquote(dn);
  // 实体模型（ENTITY_MODEL.md）：kind / depth / locator
  const kd = grab("kind");
  if (kd) out.kind = unquote(kd);
  const dp = grab("depth");
  if (dp) out.depth = unquote(dp);
  const lc = grab("locator");
  if (lc) out.locator = unquote(lc);
  return out;
}

/** 从一段值里抠出所有 wikilink 的 basename(不带 #锚 / |别名) */
function extractWikilinks(value) {
  const out = [];
  const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(value))) out.push(m[1].trim());
  return out;
}

/* ---------- frontmatter 关系字段的字符串级 patch(纯函数,node 可测) ----------
 * 策略与 tools/apply_relations.py 的 patch() 一致:关系字段是单行内联数组,
 * 按字段分组解析续行(块列表 `- item` 也整组拿住,防止替换后孤儿续行),
 * 数组写空 = 删掉整个字段(§3.1:没有关系就不写键)。
 */

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FIELD_RE = /^([\w-]+):/;
// 新字段插在最后一个结构字段之后(与 apply_relations.py 的 AFTER 集合一致)
const ANCHOR_FIELDS = ["title", "slug", "year", "pdf", "tags", "table_summary", "status",
  "authors", "paper_title", "organization", "arxiv", "venue"];

function splitFrontmatter(text) {
  const m = text.match(FM_RE);
  if (!m) return null;
  return { head: text.slice(0, m.index), block: m[1], tail: text.slice(m.index + m[0].length) };
}

/** 把一个 frontmatter 块按「字段 + 续行」分组(字段行 = ^name:) */
function groupFields(block) {
  const groups = [];
  for (const line of block.split("\n")) {
    const name = FIELD_RE.exec(line);
    if (name || !groups.length) groups.push({ name: name ? name[1] : null, lines: [line] });
    else groups[groups.length - 1].lines.push(line);
  }
  return groups;
}

function renderRelField(field, targets) {
  return field + ": [" + targets.map((t) => `"[[${t}]]"`).join(", ") + "]";
}

/**
 * 对整篇笔记文本做一次关系字段操作,返回新文本。
 * op: { source(源笔记 basename), add: {field, target}
 *      | remove: {field, target}
 *      | retarget: {field, from, to} }
 * 抛错的情况:frontmatter 缺失 / 字段里找不到 from。
 * add 时字段不存在 → 在最后一个锚点字段后插入新行。
 */
function patchRelation(text, op) {
  const parts = splitFrontmatter(text);
  if (!parts) throw new Error("frontmatter 缺失");
  const field = (op.add && op.add.field) || (op.remove && op.remove.field) || (op.retarget && op.retarget.field);
  const groups = groupFields(parts.block);
  const gi = groups.findIndex((g) => g.name === field);
  // 两种写法都要读全:内联 `a: ["[[x]]"]` 与块列表 `a:\n  - "[[x]]"`
  const targetsOf = (g) =>
    extractWikilinks(g.lines.map((l) => l.replace(/^[ \t]*-[ \t]*/, "")).join(","));
  const quoteBasename = (b) => b.replace(/"/g, "");

  if (op.add) {
    const target = quoteBasename(op.add.target);
    if (gi >= 0) {
      const targets = targetsOf(groups[gi]);
      if (targets.includes(target)) throw new Error(`已有 ${field} → ${target}`);
      const g = groups[gi];
      // 单行内联数组:直接在行内插;块列表:整组换成内联数组
      g.lines = [renderRelField(field, [...targets, target])];
    } else {
      const anchor = groups.reduce(
        (acc, g, i) => (ANCHOR_FIELDS.includes(g.name) ? i : acc), -1);
      groups.splice(anchor + 1, 0, { name: field, lines: [renderRelField(field, [target])] });
    }
  } else if (op.remove) {
    if (gi < 0) throw new Error(`没有 ${field} 字段`);
    const target = quoteBasename(op.remove.target);
    const targets = targetsOf(groups[gi]);
    if (!targets.includes(target)) throw new Error(`${field} 里没有 ${target}`);
    const rest = targets.filter((t) => t !== target);
    if (rest.length) groups[gi].lines = [renderRelField(field, rest)];
    else groups.splice(gi, 1); // 空了就删整个字段
  } else if (op.retarget) {
    if (gi < 0) throw new Error(`没有 ${field} 字段`);
    const from = quoteBasename(op.retarget.from);
    const to = quoteBasename(op.retarget.to);
    const targets = targetsOf(groups[gi]);
    const i = targets.indexOf(from);
    if (i < 0) throw new Error(`${field} 里没有 ${from}`);
    if (targets.includes(to)) throw new Error(`${field} 已有 ${to}`);
    targets[i] = to;
    groups[gi].lines = [renderRelField(field, targets)];
  } else {
    throw new Error("op 必须是 add / remove / retarget 之一");
  }

  return parts.head + "---\n" + groups.map((g) => g.lines.join("\n")).join("\n") + "\n---\n" + parts.tail;
}

/** 读出 source 笔记的某个关系字段的全部目标(编辑前的 UI 校验用) */
function readRelation(text, field) {
  const parts = splitFrontmatter(text);
  if (!parts) return [];
  for (const g of groupFields(parts.block)) {
    if (g.name === field) return extractWikilinks(g.lines[0].slice(g.lines[0].indexOf(":") + 1).trim())
      .concat(g.lines.slice(1).flatMap((l) => extractWikilinks(l.replace(/^-\s*/, ""))));
  }
  return [];
}

/**
 * 写单个标量字段(reading 这类)。
 * value 为 null/"" → 删除该字段(没有就不写键,和关系字段同一约定);
 * 已有 → 整行替换(顺带清掉块列表续行);没有 → 插在最后一个锚点字段之后。
 */
function patchScalarField(text, field, value) {
  const parts = splitFrontmatter(text);
  if (!parts) throw new Error("frontmatter 缺失");
  const groups = groupFields(parts.block);
  const gi = groups.findIndex((g) => g.name === field);
  const isEmpty = value === null || value === undefined || value === "";
  if (isEmpty) {
    if (gi >= 0) groups.splice(gi, 1);
  } else {
    const line = field + ": " + value;
    if (gi >= 0) groups[gi].lines = [line];
    else {
      const anchor = groups.reduce((acc, g, i) => (ANCHOR_FIELDS.includes(g.name) ? i : acc), -1);
      groups.splice(anchor + 1, 0, { name: field, lines: [line] });
    }
  }
  return parts.head + "---\n" + groups.map((g) => g.lines.join("\n")).join("\n") + "\n---\n" + parts.tail;
}

/** 从字段分组里读标签(内联数组或块列表都行) */
function tagsOfGroup(g) {
  const text = g.lines.map((l) => l.replace(/^[ \t]*-[ \t]*/, "")).join(",");
  return parseInlineList(text.slice(text.indexOf(":") + 1));
}

/** 解析内联数组(不引 YAML 库:标签都是裸词,没有引号里的逗号) */
function parseInlineList(value) {
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/**
 * 增删一个标签(frontmatter 的 `tags` 内联数组)。
 * 删到空就留 `tags: []`——tags 是必填字段,不能整行删掉(lint 会报缺必填)。
 */
function patchTags(text, op) {
  const parts = splitFrontmatter(text);
  if (!parts) throw new Error("frontmatter 缺失");
  const groups = groupFields(parts.block);
  const gi = groups.findIndex((g) => g.name === "tags");
  let tags = gi >= 0 ? tagsOfGroup(groups[gi]) : [];
  if (op.add) {
    if (tags.includes(op.add)) throw new Error("已经有标签 " + op.add);
    tags.push(op.add);
  } else if (op.remove) {
    if (!tags.includes(op.remove)) throw new Error("没有标签 " + op.remove);
    tags = tags.filter((t) => t !== op.remove);
  } else {
    throw new Error("op 必须是 add / remove");
  }
  const line = "tags: [" + tags.join(", ") + "]";
  if (gi >= 0) groups[gi].lines = [line];
  else {
    const anchor = groups.reduce((acc, g, i) => (ANCHOR_FIELDS.includes(g.name) ? i : acc), -1);
    groups.splice(anchor + 1, 0, { name: "tags", lines: [line] });
  }
  return parts.head + "---\n" + groups.map((g) => g.lines.join("\n")).join("\n") + "\n---\n" + parts.tail;
}

function readTags(text) {
  const parts = splitFrontmatter(text);
  if (!parts) return [];
  const g = groupFields(parts.block).find((x) => x.name === "tags");
  return g ? tagsOfGroup(g) : [];
}

/**
 * 由全库 md 记录建立索引。
 * records: [{ path, basename, content }](path 为 vault 内 POSIX 相对路径)
 * 返回 { root, nodes: Map<path,node>, byBasename, edges, dangling, basenameCollisions }
 * node: { path, basename, title, tags, summary, rels, direction, children, parent, descCount }
 * edges: 有类型关系边 [{src, dst, type}](dst 按 basename 解析;解析不到的进 dangling)
 */
function buildWikiIndex(records, opts = {}) {
  const rootNote = opts.rootNote || "【索引】研究总览.md";
  const schema = opts.schema || DEFAULT_SCHEMA;
  const scan = schema.scan || DEFAULT_SCHEMA.scan;
  const skipDirs = new Set(scan.skip_dirs || []);
  const skipFiles = new Set(scan.skip_files || []);
  const repRe = (() => {
    const pats = (scan.rep_patterns || []).filter(Boolean);
    if (!pats.length) return REP_RE;
    try { return new RegExp(pats.map((p) => "(" + p + ")").join("|")); }
    catch (e) { return REP_RE; }
  })();
  const nodes = new Map();
  const byBasename = new Map();
  let basenameCollisions = 0;

  for (const rec of records) {
    const fm = parseFrontmatter(rec.content);
    const node = {
      path: rec.path,
      basename: rec.basename,
      title: fm.title || rec.basename,
      tags: fm.tags || [],
      summary: fm.summary || "",
      rels: {},
      subDirLinks: fm[SUB_DIRS_FIELD] ? extractWikilinks(fm[SUB_DIRS_FIELD]) : [],
      mainDir: fm.direction ? extractWikilinks(fm.direction)[0] || "" : "",
      bodyLinks: bodyNoteLinks(rec.content, rec.basename),
      // 实体类型（schema.detect 推断；显式 frontmatter kind 优先）
      kind: fm.kind || kindOfPath(schema, rec.path) || null,
      depth: fm.depth != null && String(fm.depth).trim() !== "" ? String(fm.depth).trim() : null,
      locator: fm.locator || null,
      // 有效纳管深度与「边界」标记（depth != full：内部不纳管，画布画虚线外圈）
      effectiveDepth: null,
      boundary: false,
      // locator 可达性：只有本地 file:// 能在渲染期同步判断；远程保持 unknown(null)
      resourceOk: null,
      resourceError: null,
      // 容器在它 kind 登记的 children_section 里列子节点（目录树给不出这层层级）
      hierarchyLinks: (() => {
        const sections = sectionsForKind(schema, fm.kind || kindOfPath(schema, rec.path));
        if (!sections.length) return [];
        return sectionNoteLinks(rec.content, sections);
      })(),
      reading: fm.reading || READING_UNREAD,
      importance: fm.importance || IMPORTANCE_MIN,
      authors: fm.authors || [],
      year: fm.year || "",
      stage: fm[STAGE_FIELD] || "",
      direction: dirOf(rec.path, rootDirsOf(schema)),
      // kind 行为声明（schema）：进度轴字段 + 实体树顶层目录。渲染层只看这两个字段,
      // 不再写死 papers/ ideas/ deep-research/ —— 换 workspace 只改 schema。
      statusField: statusFieldOf(schema, fm.kind || kindOfPath(schema, rec.path)),
      rootDir: rootDirOf(schema, fm.kind || kindOfPath(schema, rec.path)),
      children: [],
      parent: null,
      descCount: 0,
    };
    const kindSpec = (schema.kinds && schema.kinds[node.kind]) || {};
    node.effectiveDepth = node.depth || kindSpec.default_depth || "self";
    node.boundary = !!node.kind && node.effectiveDepth !== "full";
    if (adapters && node.locator) {
      const scheme = adapters.parseLocator(node.locator).scheme;
      if (scheme === "file") {
        const st = adapters.statResource(node.locator);
        node.resourceOk = st.ok;
        node.resourceError = st.error || null;
      }
    }
    for (const key of REL_KEYS) {
      const targets = fm[key] ? extractWikilinks(fm[key]) : [];
      if (targets.length) node.rels[key] = targets;
    }
    nodes.set(node.path, node);
    if (byBasename.has(node.basename)) basenameCollisions++;
    else byBasename.set(node.basename, node);
  }

  // 有类型关系边(按 basename 解析;全库 basename 唯一,lint 保障)
  const edges = [];
  const dangling = [];
  for (const node of nodes.values()) {
    for (const key of REL_KEYS) {
      for (const target of node.rels[key] || []) {
        const dst = byBasename.get(target);
        if (!dst) { dangling.push(node.path + " --" + key + "--> " + target); continue; }
        if (dst.path === node.path) continue; // 自链不画
        edges.push({ src: node.path, dst: dst.path, type: key });
      }
    }
  }

  // 目录树:有代表笔记(【索引】/【Deep Research】)的文件夹以它为节点,
  // 没有的文件夹(如 【年份】slug/)不建节点,里面的 md 上提到父层
  const dirFiles = new Map();
  const dirSubs = new Map();
  for (const path of nodes.keys()) {
    const dir = posixDirname(path);
    if (!dirFiles.has(dir)) dirFiles.set(dir, []);
    dirFiles.get(dir).push(path);
    // 直接父子目录对(含 vault 根 "" → 顶层目录;"" 自己不登记,否则自环)
    if (dir !== "") {
      for (let d = dir; ; ) {
        const parent = posixDirname(d);
        if (!dirSubs.has(parent)) dirSubs.set(parent, new Set());
        dirSubs.get(parent).add(d);
        if (!d.includes("/")) break;
        d = parent;
      }
    }
  }
  // 一个文件夹的代表笔记。**多个** `【索引】` 笔记时不给代表 —— 那是「域索引笔记与方向
  // 平铺在同一个文件夹」的情形(papers/ 下:【索引】llm4rec.md + 【索引】deeprec.md + 各方向),
  // 整层上提,再由下面的 hierarchyLinks 重新分组。
  const repOf = (dir) => {
    const reps = (dirFiles.get(dir) || []).filter((f) => repRe.test(baseName(f)));
    return reps.length === 1 ? reps[0] : null;
  };
  const isSkippedPath = (p) => p.split("/").some((seg) => skipDirs.has(seg));

  function buildDir(dir) {
    const rep = repOf(dir);
    const children = [];
    const subs = [...(dirSubs.get(dir) || [])].filter((s) => !isSkippedPath(s)).sort();
    for (const sub of subs) {
      const r = buildDir(sub);
      if (r.rep) children.push(r.rep);
      else children.push(...r.files); // 无代表笔记:整层上提
    }
    const own = (dirFiles.get(dir) || [])
      .filter((f) => f !== rep && !skipFiles.has(baseName(f).replace(/\.md$/, "")))
      .sort((a, b) => (baseName(a) < baseName(b) ? -1 : 1));
    if (rep) {
      nodes.get(rep).children.push(...children, ...own);
      return { rep, files: own };
    }
    return { rep: null, files: [...children, ...own] };
  }

  const root = nodes.get(rootNote) || null;
  if (root) {
    const rootDir = posixDirname(root.path);
    const subs = [...(dirSubs.get(rootDir) || [])].filter((s) => !isSkippedPath(s)).sort();
    for (const sub of subs) {
      const r = buildDir(sub);
      if (r.rep) root.children.push(r.rep);
      else root.children.push(...r.files);
    }
    (function assign(p) {
      const n = nodes.get(p);
      let count = 0;
      for (const c of n.children) {
        const cn = nodes.get(c);
        if (!cn) continue;
        cn.parent = p;
        count += 1 + assign(c);
      }
      n.descCount = count;
      return count;
    })(root.path);

    // 域/根索引笔记在正文小节里「列子节点」(`## 方向` / `## 大类别`)—— 域是笔记不是文件夹,
    // 这层父子关系目录树给不出,只能按链接重挂一次。
    const explicit = new Map();          // 父路径 → 子路径数组(按笔记里写的顺序)
    for (const node of nodes.values()) {
      const links = node.hierarchyLinks || [];
      if (!links.length) continue;
      const kids = [];
      for (const base of links) {
        const t = byBasename.get(base);
        if (t && t.path !== node.path && !kids.includes(t.path)) kids.push(t.path);
      }
      if (kids.length) explicit.set(node.path, kids);
    }
    if (explicit.size) {
      const owned = new Set();
      for (const kids of explicit.values()) for (const k of kids) owned.add(k);
      for (const node of nodes.values()) {
        node.children = node.children.filter((c) => !owned.has(c));
      }
      for (const [parent, kids] of explicit) {
        const pn = nodes.get(parent);
        // 加性:显式声明的子节点在前,原有的(没被别处认领的)留在后面 ——
        // 免得某天有个节点谁都没链接,直接从树上消失。
        pn.children = [...kids, ...pn.children.filter((c) => !kids.includes(c))];
      }
      (function assign(p) {
        const n = nodes.get(p);
        let count = 0;
        for (const c of n.children) {
          const cn = nodes.get(c);
          if (!cn) continue;
          cn.parent = p;
          count += 1 + assign(c);
        }
        n.descCount = count;
        return count;
      })(root.path);
    }

    // ── depth 剪枝（ENTITY_MODEL.md §4）──────────────────────────────────
    // self = 0 层、1/2/… = 只留 N 层、full = 不限。每个节点各管各的下界：
    // 父节点 self 时，子节点再 full 也不会显示（内部自由管理）。
    (function applyDepth(p, inheritedCap) {
      const n = nodes.get(p);
      if (!n) return;
      const own = n.kind ? n.effectiveDepth : "full";
      let cap = inheritedCap;
      if (own !== "full") {
        const k = own === "self" ? 0 : parseInt(own, 10);
        cap = Math.min(cap, Number.isFinite(k) ? k : 0);
      }
      if (cap <= 0) { n.children = []; return; }
      for (const c of [...n.children]) applyDepth(c, cap - 1);
    })(root.path, Infinity);

    (function assign(p) {
      const n = nodes.get(p);
      let count = 0;
      for (const c of n.children) {
        const cn = nodes.get(c);
        if (!cn) continue;
        cn.parent = p;
        count += 1 + assign(c);
      }
      n.descCount = count;
      return count;
    })(root.path);
  }

  // 无类型链接 → plain 边(正文里指向别的笔记的普通链接,图上画灰色虚线)。
  // **所有笔记都可以当源**,包括专题/索引笔记 —— 专题页指向它引用的论文正是要看的连接。
  // 只有两种情况跳过,免得同一条关系画两根线:
  //   · 层级边已经画了(source 就是 target 的父节点,如方向索引 → 它自己的论文);
  //   · 这一对已经有 frontmatter 关系边了。
  const relPairs = new Set();
  for (const e of edges) {
    relPairs.add(e.src + "|" + e.dst);
    relPairs.add(e.dst + "|" + e.src);
  }
  for (const node of nodes.values()) {
    for (const base of node.bodyLinks || []) {
      const dst = byBasename.get(base);
      if (!dst || dst.path === node.path) continue;
      // 父子这一对不画默认链接:层级线(子树视图)与归属线(ego 视图)已经覆盖了,
      // 而每篇正文「路径」节都写着"返回方向页" —— 不排除就会和层级线重叠成双线。
      if (dst.parent === node.path || node.parent === dst.path) continue;
      const key = node.path + "|" + dst.path;
      if (relPairs.has(key)) continue;
      edges.push({ src: node.path, dst: dst.path, type: PLAIN_TYPE });
      relPairs.add(key);
      relPairs.add(dst.path + "|" + node.path);
    }
  }

  // 主方向 = 文件夹(唯一);子方向 = 正文里指向**别的方向索引**的链接。
  // 一篇论文可以同时属于多个类目 —— 但 canonical 副本只有一个,所以子方向只记"链接",
  // 不搬文件(见 wiki/AGENTS.md §2)。目标必须是方向分组树(papers/)下的索引笔记,
  // 顶层目录从 schema 的 root_dir 读,不写死。
  const paperRoot = (function findPaperRoot() {
    for (const spec of Object.values((schema.kinds) || {})) {
      if (spec.member_kind === "paper" && spec.root_dir) return spec.root_dir;
    }
    return "papers";
  })();
  const inPaperRoot = (p) => p.startsWith(paperRoot + "/");
  for (const node of nodes.values()) {
    node.secondary = [];
    if (node.children.length > 0) continue;              // 只有论文有子方向
    // 来源一:frontmatter 的 sub_directions(权威,属性面板里能改、Dataview 能查)
    for (const base of node.subDirLinks || []) {
      const dst = byBasename.get(base);
      if (!dst || dst.path === node.parent) continue;
      if (!inPaperRoot(dst.path) || !REP_RE.test(dst.basename)) continue;
      if (!node.secondary.includes(dst.path)) node.secondary.push(dst.path);
    }
    // 来源二:正文里指向方向索引的链接(兼容早期写法;与字段重复时自动去重)
    for (const base of node.bodyLinks || []) {
      const dst = byBasename.get(base);
      if (!dst || dst.path === node.parent) continue;       // 跳过自己那个方向
      if (!inPaperRoot(dst.path)) continue;                  // 只有方向树下的方向算类目
      if (!REP_RE.test(dst.basename)) continue;              // 目标得是索引笔记
      // 注意用"是不是索引笔记"判断,不用"有没有子节点" —— 空方向没有子节点,
      // 按子节点判会把新建的空方向漏掉
      if (!node.secondary.includes(dst.path)) node.secondary.push(dst.path);
    }
  }

  // 子方向也画成一条边(指向那个方向索引的灰线)。**必须放在算完 secondary 之后** ——
  // 之前放在前面,那时 secondary 还是空的,边一条也生不出来。
  for (const node of nodes.values()) {
    for (const dirPath of node.secondary || []) {
      const key = node.path + "|" + dirPath;
      if (relPairs.has(key)) continue;
      edges.push({ src: node.path, dst: dirPath, type: PLAIN_TYPE });
      relPairs.add(key);
      relPairs.add(dirPath + "|" + node.path);
    }
  }

  return { root, nodes, byBasename, edges, dangling, basenameCollisions };
}

/**
 * 以 rootPath 为根算子图。
 *  - 索引节点(有子节点或就是根):整棵子树 + 树内关系边 + 层级线 + 子树外的幽灵
 *  - 论文/笔记节点:ego 图 —— 自身 + 一跳关系邻居(可跨方向)+ 归属线(各自 → 方向索引)
 * 同一个节点从任何入口进来(左树点选 / 卡片「进入」/ 面包屑 / 画布)子图都一样 ——
 * 差别只在谁是中心(2026-10-27 定稿,不再有"一跳视图")。
 * 返回 { nodes:[node], edges:[{src,dst,type}], root, mode: "subtree"|"ego"|"missing" }
 */
function computeSubGraph(index, rootPath, opts = {}) {
  const includeHier = opts.includeHierarchy !== false;
  const includeAttr = opts.includeAttribution !== false;
  const rootNode = index.nodes.get(rootPath);
  if (!rootNode) return { nodes: [], edges: [], root: null, mode: "missing" };

  const isIndex = rootNode.children.length > 0 || rootNode.path === index.root.path;
  const set = new Map();
  const edges = [];
  const ghosts = new Set();      // 子树之外的关联节点(画成暗色小点)

  if (isIndex) {
    // 整棵子树:画布 = 选中节点的完整连接子图(与左树点击同一张图)。
    // 曾有「进入 = 一次连接」的一跳模式(depth:1),但它与左树点击(整棵子树)
    // 出的图不一致;且一跳拖人是单遍扫描,新进来的节点会继续拖人(传染),
    // 一个 Ideas 方向能拖出 344 个幽灵 —— 已整体退场(2026-10-27 用户定稿:
    // 「所有层,点击进入之后和左侧直接点击要保持一致的图的结构显示」)。
    (function add(n) {
      set.set(n.path, n);
      for (const c of n.children) {
        const cn = index.nodes.get(c);
        if (cn) add(cn);
      }
    })(rootNode);
    if (includeHier) {
      for (const p of set.values()) {
        if (p.parent && set.has(p.parent)) edges.push({ src: p.parent, dst: p.path, type: HIER_TYPE });
      }
    }
    for (const e of index.edges) {
      if (set.has(e.src) && set.has(e.dst)) edges.push({ src: e.src, dst: e.dst, type: e.type });
    }
    // 跨出子树的边:另一头也画出来,但标成"幽灵节点"(暗、小)。
    // 一篇论文可能被多个专题引用、和别的方向有竞争关系 —— 只画子树内部的话这些关系全丢了,
    // 看起来就像"一切都是一棵树"。归属只有一处,关系是网状的,两层都要能看见。
    if (opts.includeExternal !== false) {
      const outsideCount = new Map();
      for (const e of index.edges) {
        const inSrc = set.has(e.src), inDst = set.has(e.dst);
        if (inSrc === inDst) continue;                     // 都在里面(已画)或都在外面
        const out = index.nodes.get(inSrc ? e.dst : e.src);
        if (!out || out.children.length > 0) continue;      // 只带论文进来,不把别的索引拖进来
        outsideCount.set(out.path, (outsideCount.get(out.path) || 0) + 1);
      }
      const picked = [...outsideCount.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 80)                                       // 封顶,免得整库被拖进来
        .map(([pp]) => index.nodes.get(pp));
      for (const n of picked) { set.set(n.path, n); ghosts.add(n.path); }
      for (const e of index.edges) {
        if (set.has(e.src) && set.has(e.dst)) {
          if (edges.some((x) => x.src === e.src && x.dst === e.dst && x.type === e.type)) continue;
          edges.push({ src: e.src, dst: e.dst, type: e.type });
        }
      }
    }
  } else {
    set.set(rootNode.path, rootNode);
    for (const e of index.edges) {
      const isSrc = e.src === rootPath;
      const isDst = e.dst === rootPath;
      if (!isSrc && !isDst) continue;
      set.set(isSrc ? e.dst : e.src, index.nodes.get(isSrc ? e.dst : e.src));
    }
    // 诱导子图:中心的朋友圈连完之后,**邻居之间已有的边也画出来**。
    // 之前只收「碰到中心」的边 —— 在 ego 视图里给两个邻居连线,关系写进了
    // frontmatter 却立刻从图上消失,看起来就是"子图里连不上边"(2026-10-19 修)。
    for (const e of index.edges) {
      if (set.has(e.src) && set.has(e.dst)) edges.push({ src: e.src, dst: e.dst, type: e.type });
    }
    if (includeAttr) {
      for (const n of [...set.values()]) {
        const p = n.parent;
        if (!p) continue;
        const pn = index.nodes.get(p);
        if (!pn || pn.children.length === 0) continue; // 只挂到索引节点
        if (!set.has(p)) set.set(p, pn);
        edges.push({ src: p, dst: n.path, type: ATTR_TYPE });
      }
    }
  }

  // 去重:对称关系按端点对归一(两侧都手写的 competes 只画一根),其余按三元组
  const seen = new Set();
  const dedup = [];
  for (const e of edges) {
    const pair = REL_META[e.type] && REL_META[e.type].symmetric
      ? [e.src, e.dst].sort().join("|")
      : e.src + "|" + e.dst;
    const k = pair + "|" + e.type;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(e);
  }
  const ghostNodes = new Set([...ghosts].filter((pp) => dedup.some((e) => e.src === pp || e.dst === pp)));
  return {
    nodes: [...set.values()], edges: dedup, root: rootPath,
    mode: isIndex ? "subtree" : "ego", ghosts: ghostNodes,
  };
}

/* ======================= 插件(依赖 obsidian) ======================= */

const VIEW_TYPE = "pinakes-explorer-view";

function createPlugin(obsidian) {
  const { ItemView, Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, SuggestModal, Modal, setIcon, debounce, requestUrl } = obsidian;

  const DEFAULT_SETTINGS = {
    rootNote: "【索引】研究总览.md",
    // 只存用户自己加的阅读状态(内置的未读/在读/精读不落盘,改了默认值能跟着走)
    readingStates: [],
    // 标签 → 颜色;没记的按 CHIP_PALETTE 轮着分
    tagColors: {},
    // 节点显示色覆盖:笔记路径 → hex。索引/容器节点默认统一灰,想给某个索引
    // 单独配色的在这里登记(右键菜单「节点颜色…」写进来);删掉条目即回到默认。
    nodeColors: {},
    // 欢迎页:首次运行(或空库)自动弹一次;之后从命令面板/设置里再打开
    welcomed: false,
    // 详情卡被拖出来的尺寸(右下角手柄)与位置(顶部拖动条);null = 用默认
    cardSize: null,
    cardPos: null,
  };

  function mkBtn(parent, icon, title, onClick) {
    // 用 Obsidian 原生 clickable-icon 样式(和核心工具栏按钮一致),svg 尺寸交给主题管
    const b = parent.createEl("div", { cls: "clickable-icon pnx-btn", attr: { "aria-label": title } });
    setIcon(b, icon);
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }

  class ExplorerView extends ItemView {
    constructor(leaf, plugin) {
      super(leaf);
      this.plugin = plugin;
      this.index = null;
      this.selected = null;   // 当前子图的根
      this.focused = null;    // 详情卡显示的节点
      this.statusTimer = null; // 提示条的自动熄灭计时器
      this.expanded = new Set();
      this.hiddenTypes = new Set();
      this.showHier = true;
      this.showAttr = true;
      this.searchQ = "";
      this.sub = null;
      this.simNodes = [];
      this.simEdges = [];
      this.simById = new Map();
      this.posCache = new Map();
      this.alpha = 0;
      this.k = 1;
      this.tx = 0;
      this.ty = 0;
      this.hoverSim = null;
      this.dragSim = null;
      this.panStart = null;
      this.rafId = 0;
      this.reindexing = false;
      // 编辑模式状态
      this.editMode = false;
      this.linkSource = null;    // 已点选的连线源(sim node)
      this.mouseX = 0;           // 连线预览端点(canvas 坐标)
      this.mouseY = 0;
      this.selEdge = null;       // 选中的边(sim edge)
      this.menuEl = null;        // 鼠标旁的类型工具栏
      this.dragPath = null;      // 树里正在被拖动的论文(path)
      this.menuCleanup = null;   // 当前菜单挂在 document 上的监听清理函数
    }

    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return "Pinakes 关系图谱"; }
    getIcon() { return "network"; }

    async onOpen() {
      this.expanded = new Set();

      const root = this.contentEl;
      root.empty();
      root.addClass("pnx");

      // ---- 顶栏 ----
      const top = root.createDiv({ cls: "pnx-top" });
      this.crumbsEl = top.createDiv({ cls: "pnx-crumbs" });
      const actions = top.createDiv({ cls: "pnx-actions" });
      this.btnEdit = mkBtn(actions, "pencil", "编辑模式:点两个节点连线,点边改/删", () => {
        this.setEditMode(!this.editMode);
      });
      this.btnEdit.toggleClass("is-on", false);
      mkBtn(actions, "file-plus", "添加论文:选一个本地 PDF,自动拷进库并生成笔记模板", () => this.openAddPaper());
      mkBtn(actions, "maximize", "适配视图", () => this.fitView());
      mkBtn(actions, "refresh-cw", "重建索引", () => this.reindexAndRender());

      // ---- 左树 ----
      const body = root.createDiv({ cls: "pnx-body" });
      const side = body.createDiv({ cls: "pnx-side" });
      this.searchEl = side.createEl("input", { cls: "pnx-search", type: "search", placeholder: "搜索标题 / slug…(回车跳转)" });
      // 回车跳转:每次回车按树序跳到下一个匹配(到尾回环);Esc 清空。
      // 匹配口径与 renderTree 的 matches() 一致(title / slug / tags)。
      this.searchHits = [];
      this.searchCursor = -1;
      const collectHits = () => {
        const q = this.searchQ.trim().toLowerCase();
        this.searchHits = [];
        this.searchCursor = -1;
        if (!q || !this.index || !this.index.root) return;
        const hit = (n) => n.basename.toLowerCase().includes(q) || n.title.toLowerCase().includes(q) ||
          (n.tags || []).some((t) => t.toLowerCase().includes(q));
        (function walk(n) {
          if (hit(n)) this.searchHits.push(n.path);
          for (const c of n.children) {
            const cn = this.index.nodes.get(c);
            if (cn) walk.call(this, cn);
          }
        }).call(this, this.index.root);
      };
      this.searchEl.addEventListener("input", () => {
        this.searchQ = this.searchEl.value;
        collectHits();               // 词一变,游标重置;回车从头开始
        this.renderTree();
      });
      this.searchEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (!this.searchHits.length) return;
          this.searchCursor = (this.searchCursor + 1) % this.searchHits.length;
          this.selectNode(this.searchHits[this.searchCursor]);   // 展开祖先 + 平移进视口
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.searchEl.value = "";
          this.searchQ = "";
          collectHits();
          this.renderTree();
          this.searchEl.blur();
        }
      });
      this.treeEl = side.createDiv({ cls: "pnx-tree" });

      // ---- 拖宽 ----
      const grip = body.createDiv({ cls: "pnx-grip" });
      grip.addEventListener("pointerdown", (e) => {
        grip.addClass("is-dragging");
        grip.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const w = Math.min(Math.max(ev.clientX - body.getBoundingClientRect().left, 170), body.getBoundingClientRect().width * 0.6);
          side.style.width = w + "px";
          this.resizeCanvas();
        };
        const up = (ev) => {
          grip.removeClass("is-dragging");
          grip.releasePointerCapture(ev.pointerId);
          grip.removeEventListener("pointermove", move);
          grip.removeEventListener("pointerup", up);
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up);
      });

      // ---- 画布 ----
      const stage = body.createDiv({ cls: "pnx-stage" });
      this.stageEl = stage;
      this.canvas = stage.createEl("canvas");
      this.ctx = this.canvas.getContext("2d");
      this.legendEl = stage.createDiv({ cls: "pnx-legend" });
      this.cardEl = stage.createDiv({ cls: "pnx-card" });
      // 顶部拖动条:卡片默认锚在右下角,拖这条就能把它挪到任意位置(像窗口标题栏)
      this.cardHeadEl = this.cardEl.createDiv({ cls: "pnx-card-head", attr: { "aria-label": "拖动移动卡片(双击回到默认位置)" } });
      this.cardHeadEl.createSpan({ cls: "pnx-card-grip-dots" }).setText("⠿");
      this.cardHeadEl.createSpan({ cls: "pnx-card-head-hint" }).setText("拖动移动");
      this.cardBodyEl = this.cardEl.createDiv({ cls: "pnx-card-body" });
      this.wireCardMove();
      // 记住上次拖出来的尺寸
      const cs = this.plugin.settings.cardSize;
      if (cs && cs.w) this.cardEl.style.width = cs.w + "px";
      if (cs && cs.h) this.cardEl.style.maxHeight = cs.h + "px";
      this.tipEl = stage.createDiv({ cls: "pnx-tip" });
      this.statusEl = stage.createDiv({ cls: "pnx-status" });
      this.emptyEl = stage.createDiv({ cls: "pnx-empty" });
      this.emptyEl.setText("左侧选择一个节点生成子图");
      this.emptyEl.hide();
      this.legendEl.hide();
      this.cardEl.removeClass("is-shown");

      this.ro = new ResizeObserver(() => this.resizeCanvas());
      this.ro.observe(stage);
      this.wireCanvas();
      this.readThemeColors();

      await this.reindex();
      if (this.index && this.index.root) {
        await this.adoptUnknownReadings();
        this.renderTree();
        this.renderCrumbs();
        this.selectNode(this.selected);
      }

      // vault 变化 → 防抖重建(视图自己的 registerEvent,关闭时自动清)
      const dirty = debounce(() => this.reindexAndRender(), 350, true);
      for (const ev of ["create", "delete", "modify", "rename"]) {
        this.registerEvent(this.app.vault.on(ev, () => dirty()));
      }
      // 跟随:打开/切到某篇笔记 → 图谱跳到它。
      // 只听 file-open 不够(切到已开着的标签页不触发),所以还听 active-leaf-change;
      // 但**必须判断焦点落在哪种视图上**——点一下图谱画布也会触发 leaf-change,
      // 那时 getActiveFile() 给的是"上一个笔记",照它跳会让图莫名其妙重路由
      // (而且正在连线时会把连线源清掉)。所以只有 markdown 视图才跟随。
      this.registerEvent(this.app.workspace.on("file-open", (file) => this.onFileOpen(file)));
      this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
        const view = leaf && leaf.view;
        if (!view || view.getViewType() !== "markdown") return;
        if (view.file) this.onFileOpen(view.file);
      }));
    }

    async onClose() {
      cancelAnimationFrame(this.rafId);
      if (this.ro) this.ro.disconnect();
      this.contentEl.empty();
    }

    /* ---------- 数据 ---------- */

    async reindex() {
      if (this.reindexing) return;
      this.reindexing = true;
      try {
        const files = this.app.vault.getMarkdownFiles().filter(
          (f) => !f.path.split("/").some((seg) => SKIP_DIRS.has(seg)) && !SKIP_FILES.has(f.basename)
        );
        const records = await Promise.all(
          files.map(async (f) => ({ path: f.path, basename: f.basename, content: await this.app.vault.cachedRead(f) }))
        );
        // schema 是 kind/field 的唯一真源（由 tools/pinakes.py 从 wiki/_schema/*.yml 编译）。
        // 读不到时退回 DEFAULT_SCHEMA，行为与旧版一致。
        try {
          const raw = await this.app.vault.adapter.read("_schema/.compiled.json");
          this.schema = JSON.parse(raw);
        } catch (e) {
          this.schema = DEFAULT_SCHEMA;
        }
        // 空库自举:整个 vault 连一篇实体笔记都没有时,自动建最小骨架
        // (根笔记 + papers 入口 + _unfiled 分区),让新用户从 0 也能直接用 ——
        // 之后弹出欢迎页引导建第一篇论文。已有内容的库不受影响。
        if (records.length === 0) {
          const created = await this.bootstrapSkeleton();
          if (created) {
            new Notice("Pinakes:已初始化库骨架(根笔记 + 论文库入口 + 待归档分区)");
          }
        }
        this.index = buildWikiIndex(records, {
          rootNote: this.plugin.settings.rootNote,
          schema: this.schema,
        });
        // 设置里存的名字可能已经不存在(根笔记改过名,而 data.json 里是旧值)。
        // 别只报错——vault 根部的 `【索引】*.md` 就是候选,自动收编并写回设置。
        if (!this.index.root) {
          const candidate = records.find(
            (r) => !r.path.includes("/") && /^【索引】.*\.md$/.test(r.path)
          );
          if (candidate) {
            this.plugin.settings.rootNote = candidate.path;
            await this.plugin.saveData(this.plugin.settings);
            this.index = buildWikiIndex(records, {
              rootNote: candidate.path,
              schema: this.schema,
            });
            new Notice(`根笔记已换成「${candidate.path}」(原设置里那个不存在了)`);
          }
        }
        await this.readPaletteAsync();
        if (!this.index.root) {
          new Notice("Pinakes:找不到根笔记「" + this.plugin.settings.rootNote + "」");
          return;
        }
        if (this.selected && this.index.nodes.has(this.selected)) {
          // 保留当前选择
        } else {
          this.selected = this.index.root.path;
          this.focused = this.selected;
          this.expanded = new Set([this.selected]);
        }
        if (this.focused && !this.index.nodes.has(this.focused)) this.focused = this.selected;
      } finally {
        this.reindexing = false;
      }
    }

    async reindexAndRender() {
      await this.reindex();
      if (!this.index || !this.index.root) return;
      this.renderTree();
      this.selectNode(this.selected, { keepFocus: true, keepView: true });
    }

    async readPaletteAsync() {
      this.palette = Object.assign({}, FALLBACK_PALETTE);
      try {
        const raw = await this.app.vault.adapter.read(this.app.vault.configDir + "/graph.json");
        const g = JSON.parse(raw);
        for (const cg of g.colorGroups || []) {
          const m = (cg.query || "").match(/path:"([^"]+)"/);
          if (m && cg.color && typeof cg.color.rgb === "number") this.palette[m[1]] = rgbIntToHex(cg.color.rgb);
        }
      } catch (e) { /* graph.json 不在或坏了:用兜底色 */ }
    }

    /** 重命名方向/索引后,把 graph.json 里对应的配色 query 一起改名,否则那个方向掉回灰色。 */
    async renameGraphColorQuery(oldQueryPart, newQueryPart) {
      try {
        const gp = this.app.vault.configDir + "/graph.json";
        const raw = await this.app.vault.adapter.read(gp);
        const graph = JSON.parse(raw);
        let hit = 0;
        for (const g of graph.colorGroups || []) {
          const q = g.query || "";
          if (q.includes(`path:"${oldQueryPart}"`)) {
            g.query = q.replace(`path:"${oldQueryPart}"`, `path:"${newQueryPart}"`);
            hit++;
          }
        }
        if (hit) await this.app.vault.adapter.write(gp, JSON.stringify(graph, null, 2) + "\n");
        return hit;
      } catch (e) {
        return 0;
      }
    }

    /** 节点颜色跟着路径走(重命名/移动后改 key,不然颜色会丢;删除传 null = 清掉)。
     *  精确匹配节点本身,前缀匹配整个子树(文件夹搬走时,里面的 key 一起改)。 */
    async rekeyNodeColors(oldPath, newPath) {
      const colors = this.plugin.settings.nodeColors || {};
      let hit = 0;
      for (const k of Object.keys(colors)) {
        let nk = null;
        if (k === oldPath) nk = newPath;
        else if (k.startsWith(oldPath + "/")) nk = newPath === null ? null : newPath + k.slice(oldPath.length);
        if (nk === null) { delete colors[k]; hit++; }
        else if (nk !== k) { colors[nk] = colors[k]; delete colors[k]; hit++; }
      }
      if (hit) await this.plugin.saveData(this.plugin.settings);
      return hit;
    }

    readThemeColors() {
      const cs = getComputedStyle(document.body);
      this.theme = {
        bg: cs.getPropertyValue("--background-primary").trim() || "#ffffff",
        text: cs.getPropertyValue("--text-normal").trim() || "#333",
        faint: cs.getPropertyValue("--text-faint").trim() || "#999",
        accent: cs.getPropertyValue("--interactive-accent").trim() || "#7c3aed",
      };
    }

    nodeColor(node) {
      if (node.path === (this.index && this.index.root && this.index.root.path)) return this.theme.accent;
      // 用户给节点(或它的某个祖先)单独配的色,优先于一切默认 ——
      // 沿 parent 链向上找**最近**的一个覆盖:给方向索引配色,它下面的论文全跟着变;
      // 再给某篇论文单独配色,则那篇按自己的(就近覆盖远祖)。
      for (let n = node; n; n = n.parent ? this.index.nodes.get(n.parent) : null) {
        const custom = (this.plugin.settings.nodeColors || {})[n.path];
        if (custom) return custom;
      }
      if (node.direction && this.palette[node.direction]) return this.palette[node.direction];
      return node.children.length ? "#7D8590" : "#9AA0A6";
    }

    /** 这个节点的显示色是继承来的还是自己配的(颜色菜单的提示语用)。 */
    nodeColorSource(node) {
      for (let n = node; n; n = n.parent ? this.index.nodes.get(n.parent) : null) {
        const custom = (this.plugin.settings.nodeColors || {})[n.path];
        if (custom) return { hex: custom, own: n.path === node.path,
          from: n.path === node.path ? null : n };
      }
      return null;
    }
    isIndexNode(node) { return node.children.length > 0; }

    /** 节点的进度轴(schema 的 status_field 驱动,不再看路径):
     *  - reading → 论文的阅读状态(readStates + 自定义),字段 reading
     *  - stage   → 想法的进度档(IDEA_STAGES),字段 stage
     *  - 其他/未登记 kind → null(没有状态行,如专题页) */
    statusAxis(node) {
      const f = node && node.statusField;
      if (f === STAGE_FIELD) {
        return { field: STAGE_FIELD, label: "阶段", states: IDEA_STAGES,
          value: node.stage, dim: "待做" };
      }
      if (f === "reading") {
        return { field: "reading", label: "阅读", states: this.readingStates(),
          value: node.reading, dim: READING_UNREAD };
      }
      return null;
    }

    /** 「方向分组树」的顶层目录(papers/)。来源:schema 里 member_kind = paper 的
     *  容器 kind 的 root_dir —— 论文库、待归档分区都长在它下面。
     *  拖动换方向、移动菜单、新建方向/论文 stub 只对这棵树开放。 */
    paperRoot() {
      const sc = this.schema || DEFAULT_SCHEMA;
      for (const spec of Object.values(sc.kinds || {})) {
        if (spec.member_kind === "paper" && spec.root_dir) return spec.root_dir;
      }
      return "papers";
    }

    /** 节点是否长在方向分组树里(papers/…)。 */
    inPaperRoot(path) {
      const r = this.paperRoot();
      return typeof path === "string" && path.startsWith(r + "/");
    }

    /** 待归档分区目录(papers/_unfiled/):唯一一个非方向分区,与方向互斥。 */
    unfiledDir() {
      return `${this.paperRoot()}/${UNFILED_DIR}`;
    }

    /* ---------- 阅读状态 / 标签:词表 + 配色(存在插件 data.json) ---------- */

    /** 内置三个 + 用户自定义(自定义可覆盖内置的 label/color) */
    readingStates() {
      const merged = READING_DEFAULTS.map((s) => ({ ...s }));
      for (const s of this.plugin.settings.readingStates || []) {
        if (!s || !s.key) continue;
        const i = merged.findIndex((m) => m.key === s.key);
        if (i >= 0) merged[i] = { ...merged[i], ...s };
        else merged.push({ color: CHIP_PALETTE[merged.length % CHIP_PALETTE.length], alpha: 1, ...s });
      }
      return merged;
    }
    readingMeta(key) {
      return this.readingStates().find((s) => s.key === key) || UNREAD;
    }
    /** 库里出现过但没登记过的 reading 值:自动收编,免得标了却看不见 */
    async adoptUnknownReadings() {
      if (!this.index) return;
      if (!Array.isArray(this.plugin.settings.readingStates)) this.plugin.settings.readingStates = [];
      const known = new Set(this.readingStates().map((s) => s.key));
      const found = new Set();
      for (const n of this.index.nodes.values()) {
        if (n.reading && !known.has(n.reading)) found.add(n.reading);
      }
      if (!found.size) return;
      for (const key of found) {
        this.plugin.settings.readingStates.push({
          key, label: key,
          color: CHIP_PALETTE[this.plugin.settings.readingStates.length % CHIP_PALETTE.length],
        });
      }
      await this.plugin.saveData(this.plugin.settings);
    }

    /** 库里实际用到的标签(详情卡的标签选择器用它当候选) */
    allTags() {
      const counts = new Map();
      for (const n of this.index.nodes.values()) {
        for (const t of n.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    }
    tagColor(tag) {
      const saved = (this.plugin.settings.tagColors || {})[tag];
      if (saved) return saved;
      const i = this.allTags().findIndex(([t]) => t === tag);
      return CHIP_PALETTE[(i < 0 ? tag.length : i) % CHIP_PALETTE.length];
    }

    /* ---------- 选择与子图 ---------- */

    selectNode(path, opts = {}) {   // opts.keepView / opts.keepFocus(见下)
      if (!this.index || !this.index.root) return;
      const node = this.index.nodes.get(path);
      if (!node) return;
      this.selected = path;
      if (!opts.keepFocus || !this.focused || !this.index.nodes.has(this.focused)) this.focused = path;
      this.expanded.add(path);
      // 展开选中节点的全部祖先,树里能看到它在哪
      let p = node.parent;
      while (p) { this.expanded.add(p); p = this.index.nodes.get(p) ? this.index.nodes.get(p).parent : null; }
      // 画布 = **选中节点的连接子图**:点谁,谁就是中心;索引 = 整棵子树,论文 = ego 图。
      // 同一个节点从任何入口进来(左树/「进入」/面包屑/画布双击/编辑器跟随)子图一致 ——
      // 「进入」不再是"一跳视图"(那与左树点击出图不一致,且单遍拖人有传染 bug,2026-10-27 退场)。
      // 与选中没有任何连接(层级/关系/归属/正文链接)的节点不上画布。
      // 共享节点沿用 posCache 旧坐标,切视图不整体重排;开局选中根,所以整库都在。
      this.sub = computeSubGraph(this.index, path, {
        includeHierarchy: this.showHier,
        includeAttribution: this.showAttr,
      });
      this.savePosCache();
      this.initSim();
      if (!opts.keepView) this.centerOn(path);   // 视口里看不到就平移过去(不改缩放)
      this.renderTree();
      this.renderCrumbs();
      this.renderLegend();
      this.renderCard(this.index.nodes.get(this.focused));
      this.emptyEl.hide();
      this.requestDraw();
    }

    savePosCache() {
      if (!this.simNodes) return;
      for (const n of this.simNodes) this.posCache.set(n.id, { x: n.x, y: n.y });
    }

    /**
     * 跟随当前笔记:图谱自动跳到这篇的子图。**没有开关,一直生效**(2026-10 用户确认:
     * "默认进局部图完全没问题")。三种情况不跟随:不是库内笔记、已经在看它、
     * 或者用户正在连线/选边——那时重路由会把连线源清掉,手感直接坏掉。
     */
    onFileOpen(file) {
      if (!file || !(file instanceof TFile) || file.extension !== "md") return;
      if (!this.index || !this.index.root) return;
      if (!this.index.nodes.has(file.path)) return;   // 看板/模板/AGENTS 这类不进树的文件,跳过
      if (file.path === this.selected) return;
      if (this.linkSource || this.selEdge || this.dragSim) return;   // 编辑中:别打断
      this.selectNode(file.path);
    }

    /* ---------- 树 ---------- */

    renderTree() {
      this.treeEl.empty();
      if (!this.index || !this.index.root) return;
      const q = this.searchQ.trim().toLowerCase();
      const self = this;

      function matches(node) {
        if (!q) return true;
        return node.basename.toLowerCase().includes(q) || node.title.toLowerCase().includes(q) ||
          (node.tags || []).some((t) => t.toLowerCase().includes(q));
      }
      function subtreeMatches(node) {
        if (matches(node)) return true;
        return node.children.some((c) => {
          const cn = self.index.nodes.get(c);
          return cn ? subtreeMatches(cn) : false;
        });
      }

      const render = (node, depth, container) => {
        const hasKids = node.children.length > 0;
        const row = container.createDiv({ cls: "pnx-row" });
        row.setAttr("data-path", node.path);
        const open = q ? subtreeMatches(node) : this.expanded.has(node.path);
        if (node.path === this.selected) row.addClass("is-selected");
        if (node.path === this.focused && node.path !== this.selected) row.addClass("is-active");
        if (q && !subtreeMatches(node)) row.addClass("is-dim");

        const tw = row.createDiv({ cls: "pnx-twisty" + (hasKids ? "" : " is-leaf") + (open && hasKids ? " is-open" : "") });
        if (hasKids) setIcon(tw, "chevron-right");

        const dot = row.createDiv({ cls: "pnx-dot" + (this.isIndexNode(node) ? " is-group" : "") });
        dot.style.backgroundColor = this.nodeColor(node);

        // 显示 title(人看的名字,【年份】+ 英文原题),不是 slug;整条放进去让 CSS 省略号截断
        const label = row.createDiv({ cls: "pnx-label" });
        label.setText(node.title || node.basename);
        label.title = node.title ? `${node.title}\n${node.basename}` : node.basename;
        if (this.isIndexNode(node)) {
          row.createDiv({ cls: "pnx-count" }).setText(String(node.descCount));
        } else {
          // 叶子行右侧:状态徽标(有进度轴的 kind 才画)+ 重要性(1–5,图上球的大小)。
          // 轴由 schema 的 status_field 决定(reading=论文阅读 / stage=想法阶段;专题页没有)。
          const axis = this.statusAxis(node);
          if (axis) {
            const st = axis.states.find((x) => x.key === axis.value)
              || { key: axis.dim, label: axis.dim, color: "#8B949E" };
            const readTag = row.createDiv({ cls: "pnx-badge" + (st.key === axis.dim ? " is-dim" : "") });
            readTag.setText(st.label);
            readTag.style.color = st.color;
            readTag.title = `${axis.label}:${st.label}(详情卡或笔记属性里改)`;
          }
          const impTag = row.createDiv({ cls: "pnx-badge pnx-badge-imp" });
          impTag.setText(String(node.importance || IMPORTANCE_MIN));
          impTag.title = `重要性:${node.importance || IMPORTANCE_MIN}/5(图谱里球越大越重要)`;
        }
        if (node.boundary) {
          const b = row.createDiv({ cls: "pnx-badge pnx-boundary-badge" });
          b.setText("◌");
          b.title = `边界节点：内部自由管理（depth: ${node.effectiveDepth}）`;
        }
        if (node.resourceOk === false) {
          const bad = row.createDiv({ cls: "pnx-badge pnx-badge-error" });
          bad.setText("!");
          bad.title = `资源不可达：${node.resourceError || "未知错误"}（${node.locator}）`;
        }

        // ── 拖动换方向:论文行可拖,方向/专题行可接收 ──────────────────────
        if (!this.isIndexNode(node)) {
          row.setAttr("draggable", "true");
          row.addEventListener("dragstart", (e) => {
            this.dragPath = node.path;
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", node.path);
          });
          row.addEventListener("dragend", () => { this.dragPath = null; });
        }
        if (this.isIndexNode(node)) {
          row.addEventListener("dragover", (e) => {
            if (!this.dragPath || !this.canMoveTo(node)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            row.addClass("is-drop");
          });
          row.addEventListener("dragleave", () => row.removeClass("is-drop"));
          row.addEventListener("drop", (e) => {
            row.removeClass("is-drop");
            if (!this.dragPath || !this.canMoveTo(node)) return;
            e.preventDefault();
            const src = this.dragPath;
            this.dragPath = null;
            // 延到 drag 流程结束(下个 tick)再开确认层 —— 在 dragstart/drop 期间
            // 重建 DOM 会踩到浏览器拖动状态机,容易报奇怪的 DOM 错
            setTimeout(() => this.confirmMove(src, node, { x: e.clientX, y: e.clientY }), 0);
          });
        }

        if (!this.isIndexNode(node)) {
          row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.openNodeMenu(node, { x: e.clientX, y: e.clientY });
          });
        } else {
          // 索引节点右键:同一套节点菜单(新建方向/新建论文也收在里面)
          row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.openNodeMenu(node, { x: e.clientX, y: e.clientY });
          });
        }
        row.addEventListener("click", (e) => {
          if (e.target === tw || tw.contains(e.target)) {
            // 点箭头只折叠/展开
            if (this.expanded.has(node.path)) this.expanded.delete(node.path);
            else this.expanded.add(node.path);
            this.renderTree();
            return;
          }
          // 再点一次已选中的行 = 打开笔记;首点 = 选中出子图
          if (node.path === this.selected && !this.isIndexNode(node)) {
            this.openNote(node);
            return;
          }
          this.selectNode(node.path);
        });

        if (hasKids && open) {
          const kids = row.parentElement ? container.createDiv({ cls: "pnx-kids" }) : container.createDiv({ cls: "pnx-kids" });
          kids.style.marginLeft = "14px";
          for (const c of node.children) {
            const cn = this.index.nodes.get(c);
            if (cn) render(cn, depth + 1, kids);
          }
        }
      };
      render(this.index.root, 0, this.treeEl);
    }

    renderCrumbs() {
      this.crumbsEl.empty();
      if (!this.index || !this.selected) return;
      const chain = [];
      let cur = this.index.nodes.get(this.selected);
      while (cur) { chain.unshift(cur); cur = cur.parent ? this.index.nodes.get(cur.parent) : null; }
      chain.forEach((n, i) => {
        if (i > 0) this.crumbsEl.createDiv({ cls: "pnx-sep" }).setText("›");
        const c = this.crumbsEl.createDiv({ cls: "pnx-crumb" + (i === chain.length - 1 ? " is-current" : "") });
        // 面包屑跟树保持一致,显示 title(方向索引的 title 去掉了域前缀,比文件夹名短)
        c.setText(n.title || n.basename);
        c.title = n.basename;
        if (i < chain.length - 1) c.addEventListener("click", () => this.selectNode(n.path));
      });
    }

    /* ---------- 图例 / 详情卡 ---------- */

    renderLegend() {
      this.legendEl.empty();
      if (!this.sub || !this.sub.edges.length) { this.legendEl.hide(); return; }
      const counts = new Map();
      for (const e of this.sub.edges) counts.set(e.type, (counts.get(e.type) || 0) + 1);
      const structTypes = [HIER_TYPE, PLAIN_TYPE, ATTR_TYPE].filter((t) => counts.has(t));
      const relTypes = REL_KEYS.filter((t) => counts.has(t));
      if (!structTypes.length && !relTypes.length) { this.legendEl.hide(); return; }

      const addRow = (type, label, color) => {
        const row = this.legendEl.createDiv({ cls: "pnx-legend-row" + (this.hiddenTypes.has(type) ? " is-off" : "") });
        const sw = row.createDiv({ cls: "pnx-swatch" });
        sw.style.backgroundColor = color;
        row.createDiv({ cls: "pnx-legend-name" }).setText(label);
        row.createDiv({ cls: "pnx-legend-num" }).setText(String(counts.get(type)));
        row.addEventListener("click", () => {
          if (this.hiddenTypes.has(type)) this.hiddenTypes.delete(type);
          else this.hiddenTypes.add(type);
          this.renderLegend();
          this.requestDraw();
        });
      };
      structTypes.forEach((t, i) => {
        if (i > 0) this.legendEl.createDiv({ cls: "pnx-legend-sep" });
        addRow(t, t === HIER_TYPE ? "hierarchy" : t === PLAIN_TYPE ? "plain link" : "attribution",
          t === HIER_TYPE ? HIER_COLOR : t === PLAIN_TYPE ? PLAIN_COLOR : ATTR_COLOR);
      });
      if (structTypes.length && relTypes.length) this.legendEl.createDiv({ cls: "pnx-legend-sep" });
      relTypes.forEach((t) => addRow(t, REL_META[t].label, REL_META[t].color));
      this.legendEl.show();
    }

    renderCard(node) {
      const savedPos = this.plugin.settings.cardPos;
      if (savedPos && this.cardEl.style.right !== "auto") {
        // 位置一应用就把锚点切到 left/top,之后不会被再次覆盖
        const maxX = Math.max((this.w || 0) - 260, 4), maxY = Math.max((this.h || 0) - 180, 4);
        this.cardEl.style.left = Math.max(4, Math.min(savedPos.x, maxX)) + "px";
        this.cardEl.style.top = Math.max(4, Math.min(savedPos.y, maxY)) + "px";
        this.cardEl.style.right = "auto";
        this.cardEl.style.bottom = "auto";
      }
      this.cardBodyEl.empty();
      this.cardEl.removeClass("is-shown");
      if (!node || !this.sub) return;
      this.cardBodyEl.createEl("h4").setText(node.title);
      if (node.summary) this.cardBodyEl.createDiv({ cls: "pnx-card-sum" }).setText(node.summary);
      // 作者:原文事实,只读展示(自由文本,不是可选词表)
      // 年份 + 作者同一行(像引用格式);年份从 basename 的 【YYYY】 兜底,避免字段缺失时显示空
      const year = node.year || (node.basename.match(/^【(\d{4})】/) || [])[1] || "";
      const infoLine = [year, ...(node.authors || [])].filter(Boolean).join(" · ");
      if (infoLine) this.cardBodyEl.createDiv({ cls: "pnx-card-authors" }).setText(infoLine);
      // 进度轴 + 重要性 + 标签:点一下直接写 frontmatter。
      // 只给叶子笔记(索引/容器笔记是导航节点,不参与进度);
      // 轴由 schema 的 status_field 决定(reading=阅读 / stage=阶段;专题页等未声明的 kind 没有状态行)。
      if (!this.isIndexNode(node)) {
        const meta = this.cardBodyEl.createDiv({ cls: "pnx-card-meta" });
        const axis = this.statusAxis(node);
        // 字段为空时不给任何芯片点亮,并把它们画成虚线框 —— 一眼看出"这里可以填"
        const readingEmpty = axis ? !axis.value : false;
        const impEmpty = !node.importance;

        if (axis) {
          const rdRow = meta.createDiv({ cls: "pnx-card-row" });
          rdRow.createSpan({ cls: "pnx-card-key" }).setText(axis.label);
          // 芯片放进**可换行**容器:直接挂在这一行里时 flex 会先压缩它们
          // (窄卡片/不同缩放下的"阅读变两行、芯片变大方块"就是这么来的)
          const rdWrap = rdRow.createDiv({ cls: "pnx-card-tagwrap" });
          for (const s of axis.states) {
            const chip = rdWrap.createSpan({
              cls: "pnx-chip" + (axis.value === s.key ? " is-on" : readingEmpty ? " is-todo" : ""),
            });
            chip.setText(s.label);
            if (s.color) chip.style.borderColor = s.color;
            if (axis.value === s.key) chip.style.backgroundColor = s.color;   // 同样按轴切换
            chip.addEventListener("click", () => this.setField(node, axis.field, s.key));
          }
          if (axis.field === "reading") {   // 自定义状态只开给阅读轴(想法的档位是固定词表)
            const addState = rdWrap.createSpan({ cls: "pnx-chip pnx-chip-add", attr: { "aria-label": "加一个自定义阅读状态" } });
            addState.setText("＋");
            addState.addEventListener("click", (e) => this.openStateEditor({ x: e.clientX, y: e.clientY }));
          }
        }


        const imRow = meta.createDiv({ cls: "pnx-card-row" });
        imRow.createSpan({ cls: "pnx-card-key" }).setText("重要");
        const imWrap = imRow.createDiv({ cls: "pnx-card-tagwrap" });
        for (let i = IMPORTANCE_MIN; i <= IMPORTANCE_MAX; i++) {
          const chip = imWrap.createSpan({
            cls: "pnx-chip" + (node.importance === i ? " is-on" : impEmpty ? " is-todo" : ""),
          });
          chip.setText(String(i));
          chip.title = "数字越大球越大(1–5)";
          chip.addEventListener("click", () => this.setField(node, "importance", i));
        }

        // 主方向(唯一,跟着文件夹走) + 子方向(可加多个,写在正文的链接)
        const dirRow = meta.createDiv({ cls: "pnx-card-row" });
        dirRow.createSpan({ cls: "pnx-card-key" }).setText("方向");
        const dirWrap = dirRow.createDiv({ cls: "pnx-card-tagwrap" });
        const primary = node.parent ? this.index.nodes.get(node.parent) : null;
        if (primary) {
          const chip = dirWrap.createSpan({ cls: "pnx-card-tag" });
          chip.style.borderColor = this.nodeColor(primary);
          chip.createSpan().setText(truncate(primary.title || primary.basename, 18));
          chip.title = `主方向:${primary.title || primary.basename}(双击进入)`;
          // 双击才进:单击就跳走太容易误触,尤其在看卡片的时候
          chip.addEventListener("dblclick", () => this.selectNode(primary.path));
        }
        for (const dirPath of node.secondary || []) {
          const dirNode = this.index.nodes.get(dirPath);
          if (!dirNode) continue;
          const chip = dirWrap.createSpan({ cls: "pnx-card-tag pnx-card-sub" });
          chip.style.borderColor = this.nodeColor(dirNode);
          chip.createSpan().setText(truncate(dirNode.title || dirNode.basename, 16));
          chip.title = `子方向:${dirNode.title || dirNode.basename}(双击进入)`;
          chip.addEventListener("dblclick", () => this.selectNode(dirNode.path));
          const x = chip.createSpan({ cls: "pnx-card-del" });
          x.setText("✕");
          x.title = "取消这个子方向(从正文里删掉那条链接)";
          x.addEventListener("click", (e) => {
            e.stopPropagation();
            this.removeSecondaryDir(node, dirNode);
          });
          x.addEventListener("dblclick", (e) => e.stopPropagation());   // 连点两下删除时别顺带跳走
        }
        const addDir = dirWrap.createSpan({ cls: "pnx-card-tag pnx-chip-add" });
        addDir.setText("＋");
        addDir.title = "关联到另一个方向(子方向)";
        addDir.addEventListener("click", (e) => {
          e.stopPropagation();
          this.openDirPicker(node, { x: e.clientX, y: e.clientY });
        });

        const tgRow = meta.createDiv({ cls: "pnx-card-row" });
        tgRow.createSpan({ cls: "pnx-card-key" }).setText("标签");
        const wrap = tgRow.createDiv({ cls: "pnx-card-tagwrap" });
        for (const t of node.tags || []) {
          const chip = wrap.createSpan({ cls: "pnx-card-tag" });
          chip.style.borderColor = this.tagColor(t);
          chip.createSpan().setText(t);
          const x = chip.createSpan({ cls: "pnx-card-del" });
          x.setText("✕");
          x.addEventListener("click", () => this.setTag(node, t, false));
        }
        const addTag = wrap.createSpan({ cls: "pnx-card-tag pnx-chip-add" });
        addTag.setText("＋");
        addTag.addEventListener("click", (e) => this.openTagPicker(node, { x: e.clientX, y: e.clientY }));
      }
      // 关系:出边按本名,入边按派生反向名;只列当前子图里画出来的。
      // 编辑模式:每条出边带 ✕(删)和类型下拉(改)
      const relEdges = this.sub.edges.filter(
        (e) => e.type !== HIER_TYPE && e.type !== ATTR_TYPE && (e.src === node.path || e.dst === node.path)
      );
      for (const t of REL_KEYS) {
        const out = relEdges.filter((e) => e.type === t && e.src === node.path);
        const inn = relEdges.filter((e) => e.type === t && e.dst === node.path);
        if (!out.length && !inn.length) continue;
        const meta = REL_META[t];
        const rel = this.cardBodyEl.createDiv({ cls: "pnx-card-rel" });
        if (out.length) {
          rel.createEl("b").setText(meta.label + " → ");
          this.appendRelTargets(rel, out.map((e) => e.dst), node, t);
          if (inn.length) rel.createSpan().setText("　");
        }
        if (inn.length) {
          rel.createEl("b").setText((INVERSE_LABEL[t] || t) + " ← ");
          this.appendRelTargets(rel, inn.map((e) => e.src), node, t);
        }
      }
      if (node.boundary) {
        const row = this.cardBodyEl.createDiv({ cls: "pnx-card-row" });
        row.createSpan({ cls: "pnx-card-key" }).setText("内部");
        const wrap = row.createDiv({ cls: "pnx-card-tagwrap" });
        const stat = adapters ? adapters.statResource(node.locator || "") : null;
        const note = wrap.createSpan({ cls: "pnx-boundary-note" });
        note.setText(node.locator && stat ? adapters.describeStat(stat)
          : `内部自由管理（depth: ${node.effectiveDepth}，未声明 locator）`);
        if (node.resourceOk === false) note.addClass("is-error");
        if (node.locator) {
          const btn = wrap.createEl("button", { cls: "pnx-card-mini" });
          btn.setText("打开所在位置");
          btn.addEventListener("click", () => this.openNodeResource(node));
        }
      }
      const acts = this.cardBodyEl.createDiv({ cls: "pnx-card-acts" });
      const btnOpen = acts.createEl("button");
      btnOpen.addClass("is-primary");     // 主操作:按钮样式与上面的芯片区分开
      btnOpen.setText("打开笔记");
      btnOpen.addEventListener("click", () => this.openNote(node));
      // 「进入」= 把这个节点选为画布中心,子图与左树点击完全一致(2026-10-27 定稿:
      // 索引 = 整棵子树 + 幽灵,叶子 = ego 图)。与「回到上层」成一对:进 / 回。
      const btnInto = acts.createEl("button");
      btnInto.setText("进入");
      btnInto.title = this.isIndexNode(node)
        ? `进入「${truncate(node.title || node.basename, 24)}」:整个子树 + 它们的连接`
        : `进入「${truncate(node.title || node.basename, 24)}」:以它为中心看关系图`;
      btnInto.addEventListener("click", () => this.selectNode(node.path));
      // 回到上层 = 退到**当前画布的根**的父节点(论文 → 所属方向;方向 → 论文库;…→ 总览)。
      // 两个要点:
      //  · 基准取 this.selected(画布当前根)而不是卡里这篇 —— 否则连点两下会卡在同一层;
      //  · keepFocus:换根之后**卡里那篇仍是焦点**(它就画在父层里,还带着焦点环),
      //    不会自动跳成上层索引的卡片。
      const canvasRoot = this.index.nodes.get(this.selected) || node;
      const up = canvasRoot.parent ? this.index.nodes.get(canvasRoot.parent) : null;
      if (up) {
        const btnUp = acts.createEl("button");
        btnUp.setText("回到上层");
        btnUp.title = `回到「${truncate(up.title || up.basename, 24)}」`;
        btnUp.addEventListener("click", () => this.selectNode(up.path, { keepFocus: true }));
      }
      this.wireCardResize();          // 每次重绘保证有且只有一个手柄
      if (this.editMode) {
        const btnRel = acts.createEl("button");
        btnRel.setText("+ 关系");
        btnRel.addEventListener("click", (e) => this.openRelPicker(node, { x: e.clientX, y: e.clientY }));
      }
      this.cardEl.addClass("is-shown");
    }

    /** 编辑模式:关系目标后面的 ✕;写回 = 删源笔记 frontmatter 里这条 */
    appendRelTargets(container, paths, srcNode, fieldType) {
      paths.forEach((p, i) => {
        if (i > 0) container.createSpan().setText("、");
        const n = this.index.nodes.get(p);
        if (!n) return;
        if (this.sub.nodes.some((x) => x.path === p)) {
          const a = container.createEl("a");
          a.setText(n.basename);
          a.addEventListener("click", () => this.focusNode(n.path));
        } else {
          container.createSpan().setText(n.basename);
        }
        if (this.editMode && srcNode && fieldType) {
          // 只在「这是源侧出边」时给 ✕(入边归属另一篇,去那篇删)
          const isOutEdge = this.index.edges.some(
            (e) => e.src === srcNode.path && e.dst === p && e.type === fieldType);
          if (isOutEdge) {
            const x = container.createSpan({ cls: "pnx-card-del", attr: { "aria-label": "删除这条关系" } });
            x.setText("✕");
            x.addEventListener("click", () => this.removeEdge({ a: { node: srcNode }, b: { node: n }, type: fieldType }));
          }
        }
      });
    }

    focusNode(path) {
      const node = this.index.nodes.get(path);
      if (!node) return;
      this.focused = path;
      this.renderCard(node);
      this.renderTree();
    }

    /** 写标量字段(reading):点一下就落盘,不用进编辑模式 */
    async setField(node, field, value) {
      const file = this.app.vault.getAbstractFileByPath(node.path);
      if (!(file instanceof TFile)) return;
      try {
        await this.app.vault.process(file, (text) => patchScalarField(text, field, value));
        if (field === "reading") node.reading = value || READING_UNREAD;
        else if (field === STAGE_FIELD) node.stage = value || IDEA_STAGES[0].key;
        else if (field === "importance") node.importance = value || IMPORTANCE_MIN;
        // 半径/透明度可能变了:用 posCache 重算子图,节点位置不跳
        this.refreshSubGraph();
        // 通知要说对轴:按 schema 的 status_field 给字段起轴名(未知字段回落到字段名本身)
        const axisName = field === "importance" ? "重要性"
          : field === STAGE_FIELD ? "阶段"
          : field === "reading" ? "阅读" : field;
        const shown = field === "importance" ? node.importance + " 分"
          : field === STAGE_FIELD ? node.stage
          : field === "reading" ? this.readingMeta(node.reading).label : value;
        new Notice(`${node.basename}:${axisName} = ${shown}`);
      } catch (err) {
        new Notice("写入失败:" + err.message);
      }
    }

    /** 详情卡里改一个标签(增/删),顺带给新标签记个颜色 */
    async setTag(node, tag, on) {
      const file = this.app.vault.getAbstractFileByPath(node.path);
      if (!(file instanceof TFile)) return;
      try {
        await this.app.vault.process(file, (text) =>
          patchTags(text, on ? { add: tag } : { remove: tag }));
        node.tags = on ? [...(node.tags || []), tag] : (node.tags || []).filter((t) => t !== tag);
        if (on && !this.plugin.settings.tagColors[tag]) {
          this.plugin.settings.tagColors[tag] = this.tagColor(tag);
          await this.plugin.saveData(this.plugin.settings);
        }
        const dirPath = this.paperDirectionDir(node.path);
        if (dirPath) await this.regenerateIndexFor(dirPath);   // 「关键词」列来自 tags
        this.renderCard(node);
        this.renderTree();
      } catch (err) {
        new Notice("标签写入失败:" + err.message);
      }
    }

    /**
     * 通用浮层(点外部/Esc 关闭)。
     * point: 鼠标位置(client 坐标)——**传了就贴着鼠标放**,不传才居中。
     * 之前所有浮层都居中,右键点在左栏时会弹到画布正中,离鼠标很远。
     */
    openPanel(point) {
      this.closeMenu();
      const menu = this.stageEl.createDiv({ cls: "pnx-menu" });
      this.menuEl = menu;
      const outside = (ev) => { if (!menu.contains(ev.target)) this.closeMenu(); };
      const onKey = (ev) => { if (ev.key === "Escape") this.closeMenu(); };
      this.menuCleanup = () => {
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", onKey, true);
      };
      setTimeout(() => {
        if (!this.menuEl) return;      // 期间已被关掉
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("keydown", onKey, true);
      }, 0);
      // 贴着鼠标(或以鼠标为锚点居中):clamp 到 stage 内,别跑出可视区
      menu.at = (pt) => {
        const sr = this.stageEl.getBoundingClientRect();
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        let x, y;
        if (pt && Number.isFinite(pt.x)) {
          x = pt.x - sr.left + 12;
          y = pt.y - sr.top + 12;
        } else {
          x = (sr.width - mw) / 2;
          y = (sr.height - mh) / 2;
        }
        menu.style.left = Math.max(4, Math.min(x, Math.max(sr.width - mw - 4, 4))) + "px";
        menu.style.top = Math.max(4, Math.min(y, Math.max(sr.height - mh - 4, 4))) + "px";
      };
      menu.center = () => menu.at(null);
      return menu;
    }

    /** 标签选择器:库里在用的标签点一下增删,输入新名字可新建(并选颜色) */
    openTagPicker(node, point) {
      const menu = this.openPanel(point);
      menu.createDiv({ cls: "pnx-menu-title" }).setText(`「${truncate(node.basename, 22)}」的标签`);
      const input = menu.createEl("input", { cls: "pnx-menu-input", type: "search", placeholder: "搜标签 / 输入新标签…" });
      const colorRow = menu.createDiv({ cls: "pnx-menu-row pnx-menu-newcolor" });
      colorRow.createSpan().setText("新标签颜色");
      const colorInput = colorRow.createEl("input", { type: "color" });
      colorInput.value = CHIP_PALETTE[(node.tags || []).length % CHIP_PALETTE.length];
      const list = menu.createDiv({ cls: "pnx-menu-list" });
      const renderList = (q) => {
        list.empty();
        const own = new Set(node.tags || []);
        const all = this.allTags().filter(([t]) => !q || t.includes(q));
        for (const [t, count] of all.slice(0, 40)) {
          const row = list.createDiv({ cls: "pnx-menu-row" });
          const dot = row.createDiv({ cls: "pnx-menu-dot" });
          dot.style.backgroundColor = this.tagColor(t);
          row.createSpan().setText(t);
          const tail = row.createSpan({ cls: "pnx-menu-tail" });
          tail.setText(own.has(t) ? "✓ 已加" : count + " 篇");
          if (own.has(t)) row.addClass("is-on");
          row.addEventListener("click", () => { this.closeMenu(); this.setTag(node, t, !own.has(t)); });
        }
        const exact = all.some(([t]) => t === q);
        if (q && !exact) {
          const row = list.createDiv({ cls: "pnx-menu-row pnx-menu-new" });
          const dot = row.createDiv({ cls: "pnx-menu-dot" });
          dot.style.backgroundColor = colorInput.value;
          row.createSpan().setText(`新建标签「${q}」`);
          row.title = "会写进 frontmatter;记得把新标签登记进 tools/tag_vocabulary.yml,否则 lint 告警";
          row.addEventListener("click", async () => {
            this.closeMenu();
            await this.setTag(node, q, true);
            this.plugin.settings.tagColors[q] = colorInput.value;
            await this.plugin.saveData(this.plugin.settings);
            new Notice(`已加标签 ${q};记得登记 tools/tag_vocabulary.yml`);
          });
        }
        const hint = list.createDiv({ cls: "pnx-menu-hint" });
        hint.setText("新标签要登记进 tools/tag_vocabulary.yml,否则 lint 会告警");
      };
      renderList("");
      input.addEventListener("input", () => renderList(input.value.trim()));
      setTimeout(() => input.focus(), 0);
      menu.at(point);
    }

    /** 自定义阅读状态:输入名字(英文 kebab-case)+ 选颜色 */
    openStateEditor(point) {
      const menu = this.openPanel(point);
      menu.createDiv({ cls: "pnx-menu-title" }).setText("新增阅读状态");
      const input = menu.createEl("input", { cls: "pnx-menu-input", type: "text", placeholder: "状态名,如 待复核 / 只读摘要" });
      const colorRow = menu.createDiv({ cls: "pnx-menu-row pnx-menu-newcolor" });
      colorRow.createSpan().setText("颜色");
      const colorInput = colorRow.createEl("input", { type: "color" });
      colorInput.value = CHIP_PALETTE[this.readingStates().length % CHIP_PALETTE.length];
      const acts = menu.createDiv({ cls: "pnx-card-acts" });
      const ok = acts.createEl("button");
      ok.setText("添加");
      ok.addEventListener("click", async () => {
        const key = input.value.trim();
        if (!key || key.length > 12) { new Notice("状态名 1–12 个字"); return; }
        if (this.readingStates().some((s) => s.key === key)) { new Notice("已经有这个状态了"); return; }
        this.plugin.settings.readingStates.push({ key, label: key, color: colorInput.value, alpha: 1 });
        await this.plugin.saveData(this.plugin.settings);
        this.closeMenu();
        this.renderCard(this.index.nodes.get(this.focused));
        this.requestDraw();
        new Notice(`已加阅读状态 ${key}`);
      });
      setTimeout(() => input.focus(), 0);
      menu.at(point);
    }

    /** 节点颜色:给单个节点(主要是索引/容器,默认统一灰)覆盖一个显示色。
     *  存进插件 data.json 的 nodeColors[path];树点 / 画布描边 / 菜单圆点全部
     *  走 nodeColor(),一处改处处生效。候选 = SCAFFOLD_PALETTE(与图谱分色同一套,
     *  颜色拉得开)+ 自定义取色器;删掉条目即回到默认。 */
    async setNodeColor(node, hex) {
      const colors = this.plugin.settings.nodeColors || (this.plugin.settings.nodeColors = {});
      if (hex) colors[node.path] = hex;
      else delete colors[node.path];
      await this.plugin.saveData(this.plugin.settings);
      this.renderTree();
      this.renderCard(this.index.nodes.get(this.focused));
      this.requestDraw();
    }

    openNodeColorMenu(node, point) {
      const cur = (this.plugin.settings.nodeColors || {})[node.path] || null;
      const src = this.nodeColorSource(node);
      const menu = this.openPanel(point);
      menu.createDiv({ cls: "pnx-menu-title" })
        .setText(`「${truncate(node.title || node.basename, 22)}」的颜色`);
      // 有继承来源时先说清楚:现在显示的是谁的颜色(改了会连带哪些)
      if (src && !src.own) {
        menu.createDiv({ cls: "pnx-menu-hint" })
          .setText(`当前继承自「${truncate(src.from.title || src.from.basename, 18)}」。` +
            (this.isIndexNode(node) && node.children.length
              ? `给这个节点配色会覆盖继承,它下面的 ${node.children.length} 个子节点也跟着变。`
              : "给这个节点配色会覆盖继承。"));
      } else if (src && this.isIndexNode(node) && node.children.length) {
        menu.createDiv({ cls: "pnx-menu-hint" })
          .setText(`它下面的 ${node.children.length} 个子节点(没有单独配色时)会一起用这个颜色。`);
      }
      // 候选色板:当前色描圈
      const grid = menu.createDiv({ cls: "pnx-color-grid" });
      const candidates = [...SCAFFOLD_PALETTE];
      const shown = src ? src.hex : null;
      if (shown && !candidates.includes(shown)) candidates.push(shown);
      for (const hex of candidates) {
        const sw = grid.createDiv({ cls: "pnx-color-swatch" + (hex === shown ? " is-current" : "") });
        sw.style.backgroundColor = hex;
        sw.title = hex;
        sw.addEventListener("click", () => {
          this.closeMenu();
          this.setNodeColor(node, hex);
          new Notice(`「${truncate(node.title || node.basename, 18)}」已换成 ${hex}`);
        });
      }
      // 自定义取色器 + 恢复默认(恢复 = 删掉自己的覆盖,退回继承/默认)
      const row = menu.createDiv({ cls: "pnx-menu-row pnx-menu-newcolor" });
      row.createSpan().setText("自定义");
      const pick = row.createEl("input", { type: "color" });
      pick.value = shown || "#9AA0A6";
      pick.addEventListener("change", () => {
        this.closeMenu();
        this.setNodeColor(node, pick.value);
        new Notice(`「${truncate(node.title || node.basename, 18)}」已换成 ${pick.value}`);
      });
      if (cur) {
        this.menuRow(menu, "rotate-ccw", "恢复继承/默认颜色", () => {
          this.closeMenu();
          this.setNodeColor(node, null);
          new Notice("已清除这个节点的颜色覆盖");
        });
      }
      menu.at(point);
    }

    /** 顶部拖动条:移动卡片。位置存进设置,下次沿用;双击回到默认角落 */
    wireCardMove() {
      const head = this.cardHeadEl;
      const anchorTo = (x, y) => {
        const sr = this.stageEl.getBoundingClientRect();
        const cr = this.cardEl.getBoundingClientRect();
        this.cardEl.style.left = Math.max(4, Math.min(x, Math.max(sr.width - cr.width - 4, 4))) + "px";
        this.cardEl.style.top = Math.max(4, Math.min(y, Math.max(sr.height - Math.min(cr.height, sr.height) - 4, 4))) + "px";
        this.cardEl.style.right = "auto";
        this.cardEl.style.bottom = "auto";
      };
      head.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const sr = this.stageEl.getBoundingClientRect();
        const cr = this.cardEl.getBoundingClientRect();
        const x0 = cr.left - sr.left, y0 = cr.top - sr.top;
        anchorTo(x0, y0);
        head.setPointerCapture(e.pointerId);
        head.addClass("is-dragging");
        const move = (ev) => anchorTo(x0 + (ev.clientX - e.clientX), y0 + (ev.clientY - e.clientY));
        const up = (ev) => {
          head.releasePointerCapture(ev.pointerId);
          head.removeClass("is-dragging");
          head.removeEventListener("pointermove", move);
          head.removeEventListener("pointerup", up);
          const r = this.cardEl.getBoundingClientRect();
          this.plugin.settings.cardPos = { x: Math.round(r.left - sr.left), y: Math.round(r.top - sr.top) };
          this.plugin.saveData(this.plugin.settings);
        };
        head.addEventListener("pointermove", move);
        head.addEventListener("pointerup", up);
      });
      head.addEventListener("dblclick", () => {
        this.cardEl.style.left = "auto";
        this.cardEl.style.top = "auto";
        this.cardEl.style.right = "10px";
        this.cardEl.style.bottom = "10px";
        this.plugin.settings.cardPos = null;
        this.plugin.saveData(this.plugin.settings);
        this.setStatus("详情卡已回到默认位置", "muted");
      });
    }

    /** 右下角手柄:拖动改卡片宽高(指针左/上移 = 变大,因为卡片锚在右下角) */
    wireCardResize() {
      // 手柄挂在外壳(不随内容滚动),所以 renderCard 清内层时不会顺手把它删掉 ——
      // 每次重绘前先摘掉旧的,否则会叠加出一堆手柄、拖拽事件也会重复触发。
      const old = this.cardEl.querySelector(".pnx-card-grip");
      if (old) old.remove();
      const grip = this.cardEl.createDiv({ cls: "pnx-card-grip", attr: { "aria-label": "拖动调整卡片大小" } });
      grip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sr = this.stageEl.getBoundingClientRect();
        const cr = this.cardEl.getBoundingClientRect();
        // 先换成 left/top 定位再拖:卡片原本锚在右下角,不换锚点被拖的角不会跟手
        this.cardEl.style.left = (cr.left - sr.left) + "px";
        this.cardEl.style.top = (cr.top - sr.top) + "px";
        this.cardEl.style.right = "auto";
        this.cardEl.style.bottom = "auto";
        this.cardEl.style.width = cr.width + "px";
        this.cardEl.style.maxHeight = cr.height + "px";
        grip.setPointerCapture(e.pointerId);
        let w = cr.width, h = cr.height;
        const move = (ev) => {
          w = Math.max(240, Math.min(cr.width + (ev.clientX - e.clientX), sr.width - 24));
          h = Math.max(160, Math.min(cr.height + (ev.clientY - e.clientY), sr.height - 28));
          this.cardEl.style.width = Math.round(w) + "px";
          this.cardEl.style.maxHeight = Math.round(h) + "px";
        };
        const up = (ev) => {
          grip.releasePointerCapture(ev.pointerId);
          grip.removeEventListener("pointermove", move);
          grip.removeEventListener("pointerup", up);
          this.plugin.settings.cardSize = { w: Math.round(w), h: Math.round(h) };
          this.plugin.saveData(this.plugin.settings);
          this.setStatus(`详情卡尺寸 ${Math.round(w)}×${Math.round(h)}`, "muted");
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up);
      });
    }

    async openNote(node) {
      const f = this.app.vault.getAbstractFileByPath(node.path);
      if (!(f instanceof TFile)) return;
      // 复用最近打开过这篇笔记的 tab;没有就开新 tab,不每次都切分屏
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      const existing = leaves.find((l) => l.getViewState().state && l.getViewState().state.file === node.path);
      const leaf = existing || this.app.workspace.getLeaf("tab");
      await leaf.openFile(f);
      this.app.workspace.revealLeaf(leaf);
    }

    /** 画布左下角的状态行:记录上一次操作的结果(连线/改边/移动),
     *  失败原因常驻,不用去翻一闪而过的 Notice */
    setStatus(text, kind) {
      if (!this.statusEl) return;
      this.statusEl.setText(text || "");
      this.statusEl.toggleClass("is-error", kind === "error");
      this.statusEl.toggleClass("is-ok", kind === "ok");
      this.statusEl.toggleClass("is-muted", kind === "muted");   // 灰色:非关键确认(尺寸记忆等),别抢眼
      this.statusEl.toggleClass("is-shown", !!text);
      // 提示条不常驻:3 秒后自动淡出(错误也一样 —— 反正下次操作会重新亮)。
      // 新的提示会重置计时器;清空文本的调用立即熄灭。
      if (this.statusTimer) { window.clearTimeout(this.statusTimer); this.statusTimer = null; }
      if (text) {
        this.statusTimer = window.setTimeout(() => {
          this.statusEl.removeClass("is-shown");
          this.statusTimer = null;
        }, 3000);
      }
    }

    /* ---------- 拖动换方向(树里拖论文行到别的方向) ---------- */

    /** 能不能把当前拖着的论文放到这个容器下:得是容器,且不在同一个方向里 */
    canMoveTo(targetNode) {
      if (!this.dragPath || !this.isIndexNode(targetNode)) return false;
      const src = this.index.nodes.get(this.dragPath);
      if (!src || this.isIndexNode(src)) return false;
      // 只有方向分组树(papers/)下的论文能换方向。专题文档(现在文件夹里只有它自己,
      // 没有子节点)会被 isIndexNode 判成叶子,不加这条会被误拖进方向里。
      if (!this.inPaperRoot(src.path)) return false;
      const srcDir = posixDirname(posixDirname(this.dragPath));   // papers/<方向>
      const dstDir = posixDirname(targetNode.path);               // 目标索引所在目录
      return srcDir !== dstDir && this.inPaperRoot(dstDir);
    }

    /** 加一个子方向:写进 frontmatter 的 `sub_directions`(wikilink 数组,同 §3.1 关系字段) */
    async addSecondaryDir(node, dirNode) {
      // 待归档与方向互斥:它只能当主方向(把整篇放进去),不能当子方向。
      // 选择器已经过滤掉了,这里是兜底(别的入口也调这个方法时同样拦住)。
      if (dirNode.basename === UNFILED_INDEX_BASENAME) {
        new Notice("「待归档」是互斥的分区,不能作为子方向 —— 要归档请直接移动整篇论文。");
        return;
      }
      // 反过来也不行:待在待归档里的论文还没有主方向,先定方向再说子方向。
      if (posixDirname(posixDirname(node.path)) === this.unfiledDir()) {
        new Notice("这篇还在「待归档」里,先把它移到一个方向,再加子方向。");
        return;
      }
      const file = this.app.vault.getAbstractFileByPath(node.path);
      if (!(file instanceof TFile)) { new Notice(`路径解析不到:${node.path}`); return; }
      try {
        await this.app.vault.process(file, (text) =>
          patchRelation(text, { add: { field: SUB_DIRS_FIELD, target: dirNode.basename } }));
      } catch (err) {
        new Notice("加子方向失败:" + err.message);
        this.setStatus(`加子方向失败 — ${err.message}`, "error");
        return;
      }
      await this.reindexAndRender();
      new Notice(`已把「${truncate(node.basename, 20)}」关联到子方向 ${dirNode.basename}`);
      this.setStatus(`子方向 +${dirNode.basename} ✓`, "ok");
    }

    /** 去掉一个子方向(从 frontmatter 字段里删那条;正文里若也写了,一并删掉) */
    async removeSecondaryDir(node, dirNode) {
      const file = this.app.vault.getAbstractFileByPath(node.path);
      if (!(file instanceof TFile)) return;
      try {
        await this.app.vault.process(file, (text) => {
          let out = text;
          try {
            out = patchRelation(out, { remove: { field: SUB_DIRS_FIELD, target: dirNode.basename } });
          } catch (e) { /* 字段里没有 → 可能只写在正文里 */ }
          // 正文里的那种写法也清掉,免得"删了还在"
          const kept = out.split("\n").filter((line) => {
            if (!line.includes("](")) return true;
            return !bodyNoteLinks(line, node.basename).includes(dirNode.basename);
          });
          return kept.join("\n");
        });
      } catch (err) {
        new Notice("删子方向失败:" + err.message);
        return;
      }
      await this.reindexAndRender();
      this.setStatus(`子方向 −${dirNode.basename} ✓`, "ok");
    }

    /** 选一个方向当子方向:列出除主方向外的所有方向 */
    openDirPicker(node, point) {
      // 待在待归档里的论文还没有主方向 —— 子方向与方向互斥,先定方向。
      if (posixDirname(posixDirname(node.path)) === this.unfiledDir()) {
        new Notice("这篇还在「待归档」里,先把它移到一个方向,再加子方向。");
        return;
      }
      const dirs = [...this.index.nodes.values()]
        .filter((n) => this.isIndexNode(n) && this.inPaperRoot(n.path) && n.path !== node.parent)
        // 待归档是互斥的 todolist 分区,不是方向 —— 不能挂成子方向。
        .filter((n) => n.basename !== UNFILED_INDEX_BASENAME)
        .filter((n) => !(node.secondary || []).includes(n.path))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      const menu = this.openPanel(point);
      menu.createDiv({ cls: "pnx-menu-title" })
        .setText(`把「${truncate(node.title || node.basename, 24)}」关联到(子方向):`);
      for (const d of dirs) {
        const row = menu.createDiv({ cls: "pnx-menu-row" });
        const dot = row.createDiv({ cls: "pnx-menu-dot" });
        dot.style.backgroundColor = this.nodeColor(d);
        row.createSpan().setText(d.title || d.basename);
        row.addEventListener("click", () => {
          this.closeMenu();
          this.addSecondaryDir(node, d);
        });
      }
      menu.at(point);
    }

    /* ---------- 树节点右键:统一菜单(打开/重命名/删除/复制/移动/新建) ---------- */

    /** 菜单里的一行:图标 + 文字 + 可选右侧提示;danger 用红字 */
    menuRow(menu, icon, label, onClick, opts = {}) {
      const row = menu.createDiv({ cls: "pnx-menu-row" + (opts.danger ? " is-danger" : "") });
      if (icon) setIcon(row.createDiv({ cls: "pnx-menu-icon" }), icon);
      row.createSpan().setText(label);
      if (opts.tail) row.createDiv({ cls: "pnx-menu-tail" }).setText(opts.tail);
      row.addEventListener("click", onClick);
      return row;
    }

    menuSep(menu) { return menu.createDiv({ cls: "pnx-menu-sep" }); }

    /** 节点种类:论文 / 方向索引 / 域索引 / 论文库容器 / 根 / 其它(专题页、想法等)。
     *  「方向分组树」的顶层目录从 schema 的 root_dir 读,不写死 papers/。 */
    nodeKind(node) {
      if (this.index && this.index.root && node.path === this.index.root.path) return "root";
      const dir = posixDirname(node.path);
      if (!this.isIndexNode(node)) {
        return this.inPaperRoot(node.path) ? "paper" : "note";
      }
      if (dir === this.paperRoot() && REP_RE.test(node.basename)) return "container-or-domain";
      if (dir === this.paperRoot()) return "container-or-domain";
      if (posixDirname(dir) === this.paperRoot() && REP_RE.test(node.basename)) return "direction";
      // deep-research / ideas 的索引笔记:也能改文件名,只是没有「新建方向」这类专属项
      return REP_RE.test(node.basename) ? "index" : "note";
    }

    openNodeMenu(node, point) {
      const kind = this.nodeKind(node);
      const menu = this.openPanel(point);
      menu.createDiv({ cls: "pnx-menu-title" }).setText(truncate(node.title || node.basename, 34));

      // 打开
      this.menuRow(menu, "file-text", "打开笔记", () => { this.closeMenu(); this.openNote(node); });
      if (node.path.endsWith(".md")) {
        this.menuRow(menu, "file-plus", "在新标签页打开", async () => {
          this.closeMenu();
          const f = this.app.vault.getAbstractFileByPath(node.path);
          if (f instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(f);
        });
      }

      this.menuSep(menu);
      // 重命名
      this.menuRow(menu, "pencil", "重命名显示名…", () => { this.closeMenu(); this.renameDisplay(node); },
        { tail: "title" });
      if (kind === "paper") {
        this.menuRow(menu, "folder-pen", "重命名文件夹与 slug…", () => { this.closeMenu(); this.renamePaperSlug(node); },
          { tail: "笔记/PDF 一起改" });
      } else if (kind === "direction") {
        this.menuRow(menu, "folder-pen", "重命名方向…", () => { this.closeMenu(); this.renameDirection(node); },
          { tail: "文件夹 + 索引 + 论文归属" });
      } else if (kind === "container-or-domain" || kind === "index") {
        this.menuRow(menu, "file-pen", "重命名索引文件…", () => { this.closeMenu(); this.renameIndexFile(node); });
      }

      // 节点颜色(根节点用主题色,不给改):改索引的色会连带它整个子树
      if (kind !== "root") {
        const src = this.nodeColorSource(node);
        const label = src && src.own ? "换个颜色…" : "节点颜色…";
        this.menuRow(menu, "palette", label, () => {
          this.closeMenu();
          this.openNodeColorMenu(node, point);
        }, { tail: src && src.own ? src.hex : undefined });
      }

      // 删除
      this.menuSep(menu);
      if (kind === "paper") {
        this.menuRow(menu, "trash-2", "删除论文(笔记 + PDF)…", () => this.confirmDelete(node, point),
          { danger: true, tail: "移到回收站" });
      } else if (kind !== "root") {
        this.menuRow(menu, "trash-2", "删除笔记…", () => this.confirmDelete(node, point), { danger: true });
      }

      // 复制 / 定位
      this.menuSep(menu);
      this.menuRow(menu, "link", "复制 wikilink", () => {
        this.closeMenu();
        this.copyText(`[[${node.basename}]]`, `已复制 [[${truncate(node.basename, 30)}]]`);
      });
      this.menuRow(menu, "clipboard", "复制库内路径", () => {
        this.closeMenu();
        this.copyText(node.path, "已复制路径");
      });
      this.menuRow(menu, "folder-open", "在文件列表中显示", () => {
        this.closeMenu();
        if (typeof this.app.showInFolder === "function") this.app.showInFolder(node.path);
        else new Notice("这个 Obsidian 版本没有 showInFolder");
      });
      if (node.locator) {
        this.menuRow(menu, "external-link", "打开资源所在位置", () => {
          this.closeMenu();
          this.openNodeResource(node);
        }, { tail: node.locator.slice(0, 24) });
      }

      // 论文专属:换方向
      if (kind === "paper") {
        this.menuSep(menu);
        this.menuRow(menu, "move-right", "移动到其他方向…", () => {
          this.closeMenu();
          this.openMoveMenu(node, point);
        });
      }

      // 索引专属:新建
      if (kind === "direction") {
        this.menuSep(menu);
        this.menuRow(menu, "plus", "新建论文笔记…", () => {
          this.closeMenu();
          this.openNewPaperDialog(baseName(posixDirname(node.path)));
        });
      } else if (kind === "container-or-domain") {
        this.menuSep(menu);
        this.menuRow(menu, "plus", "新建方向索引…", () => {
          this.closeMenu();
          new PromptModal(this.app, "新方向的文件夹名(如 06-长序列建模)",
            "06-长序列建模", "", (name) => this.createDirection(name)).open();
        });
      }

      menu.at(point);
    }

    copyText(text, okMsg) {
      navigator.clipboard.writeText(text).then(
        () => new Notice(okMsg),
        () => new Notice("复制失败:浏览器拒绝了剪贴板权限"));
    }

    /** 改显示名 = 只改 frontmatter 的 title(不动文件名,树/图谱立刻更新) */
    renameDisplay(node) {
      new PromptModal(this.app, "显示名(title)", node.title || node.basename, node.title || node.basename,
        async (value) => {
          const v = value.trim();
          if (!v || v === node.title) return;
          const file = this.app.vault.getAbstractFileByPath(node.path);
          if (!(file instanceof TFile)) return;
          try {
            await this.app.vault.process(file, (t) =>
              patchScalarField(t, "title", `"${v.replace(/"/g, "「")}"`));
            const dirPath = this.paperDirectionDir(node.path);
            await this.reindex();
            if (dirPath) await this.regenerateIndexFor(dirPath);   // 索引表第一列就是 title
            await this.reindexAndRender();
            if (this.index.nodes.has(node.path)) this.selectNode(node.path, { keepFocus: true, keepView: true });
            new Notice(`显示名已改为「${truncate(v, 30)}」`);
          } catch (err) {
            new Notice(`重命名失败:${err.message}`);
          }
        }).open();
    }

    /**
     * 论文重命名:slug 是文件夹/笔记/PDF 的共同名字。
     * 顺序很关键:先改文件名(让 Obsidian 改写指向它的链接),再改文件夹,最后补 frontmatter。
     */
    async renamePaperSlug(node) {
      const folderPath = posixDirname(node.path);
      const folderName = baseName(folderPath);
      const m = folderName.match(/^【(\d{4})】(.*)$/);
      if (!m) { new Notice("这个文件夹不是 【年份】slug 格式,不能改 slug"); return; }
      const year = m[1], oldSlug = m[2];
      new PromptModal(this.app, "新的 slug(英文机器 id,kebab-case)", oldSlug, oldSlug, async (raw) => {
        const slug = raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[\\/:*?"<>|#^[\]]/g, "-");
        if (!slug || slug === oldSlug) return;
        const dirPath = posixDirname(folderPath);
        const newFolder = `【${year}】${slug}`;
        const newFolderPath = `${dirPath}/${newFolder}`;
        if (this.app.vault.getAbstractFileByPath(newFolderPath)) {
          new Notice(`目标已存在:${newFolder}`); return;
        }
        try {
          const fm = this.app.fileManager;
          const note = this.app.vault.getAbstractFileByPath(node.path);
          if (!(note instanceof TFile)) throw new Error("找不到笔记");
          // 1) 笔记文件改名(Obsidian 会自动改写指向它的 wikilink/相对链接)
          await fm.renameFile(note, `${folderPath}/${newFolder}.md`);
          // 2) PDF 一起改名(callout 里的 [[...pdf]] 也会被 Obsidian 改写)
          const oldPdf = this.app.vault.getAbstractFileByPath(`${folderPath}/${folderName}.pdf`);
          let pdfName = "";
          if (oldPdf instanceof TFile) {
            pdfName = `${newFolder}.pdf`;
            await fm.renameFile(oldPdf, `${folderPath}/${pdfName}`);
          }
          // 3) 文件夹改名
          const folder = this.app.vault.getAbstractFileByPath(folderPath);
          if (!(folder instanceof TFolder)) throw new Error("找不到论文文件夹");
          await fm.renameFile(folder, newFolderPath);
          // 4) frontmatter:slug + pdf 指向新名字
          const moved = this.app.vault.getAbstractFileByPath(`${newFolderPath}/${newFolder}.md`);
          if (moved instanceof TFile) {
            await this.app.vault.process(moved, (t) => {
              let out = patchScalarField(t, "slug", `"${slug}"`);
              if (pdfName) out = patchScalarField(out, "pdf", `"${pdfName}"`);
              return out;
            });
          }
          // 自定义颜色跟着路径走(笔记与整个文件夹下的 key 一起改)
          await this.rekeyNodeColors(folderPath, newFolderPath);
          await this.reindex();
          await this.regenerateIndexFor(dirPath);
          await this.reindexAndRender();
          const newPath = `${newFolderPath}/${newFolder}.md`;
          if (this.index.nodes.has(newPath)) this.selectNode(newPath);
          new Notice(`已改名为 ${newFolder}`);
        } catch (err) {
          new Notice(`重命名失败:${err.message} @ ${(err.stack || "").split("\n")[1] || "?"}`);
        }
      }).open();
    }

    /** 方向重命名:文件夹 + 索引笔记 + 所有论文的 direction 字段一起改 */
    async renameDirection(node) {
      const dirPath = posixDirname(node.path);
      const oldName = baseName(dirPath);
      if (oldName === "_unfiled") {
        new Notice("`_unfiled` 是约定好的待归档区,不能改名");
        return;
      }
      const dm = oldName.match(/^([^-]+)-(.+)$/);
      const domain = dm ? dm[1] : "";
      const display = dm ? dm[2] : oldName;
      new PromptModal(this.app, "新的方向名(不含域前缀)", display, display, async (raw) => {
        const suffix = raw.trim().replace(/^【索引】/, "").replace(/[\\/:*?"<>|#^[\]]/g, "-");
        if (!suffix) return;
        const newName = domain ? `${domain}-${suffix}` : suffix;
        if (newName === oldName) return;
        const parent = posixDirname(dirPath);
        const newDirPath = `${parent}/${newName}`;
        if (this.app.vault.getAbstractFileByPath(newDirPath)) {
          new Notice(`目标已存在:${newName}`); return;
        }
        try {
          const fm = this.app.fileManager;
          // 1) 索引笔记改名(Obsidian 会改写全库指向旧 basename 的 wikilink)
          const idx = this.app.vault.getAbstractFileByPath(node.path);
          if (!(idx instanceof TFile)) throw new Error("找不到索引笔记");
          await fm.renameFile(idx, `${dirPath}/【索引】${newName}.md`);
          // 2) 文件夹改名
          const folder = this.app.vault.getAbstractFileByPath(dirPath);
          if (!(folder instanceof TFolder)) throw new Error("找不到方向文件夹");
          await fm.renameFile(folder, newDirPath);
          // 3) 索引 title 跟上(显示名不带域前缀)
          const idxPath = `${newDirPath}/【索引】${newName}.md`;
          const idxFile = this.app.vault.getAbstractFileByPath(idxPath);
          if (idxFile instanceof TFile) {
            await this.app.vault.process(idxFile, (t) =>
              patchScalarField(t, "title", `"【索引】${suffix}"`));
          }
          // 4) 每篇论文的 direction 字段指向新索引
          const folderObj = this.app.vault.getAbstractFileByPath(newDirPath);
          if (folderObj instanceof TFolder) {
            for (const child of folderObj.children) {
              if (!(child instanceof TFolder)) continue;
              const note = this.app.vault.getAbstractFileByPath(`${newDirPath}/${child.name}/${child.name}.md`);
              if (!(note instanceof TFile)) continue;
              await this.app.vault.process(note, (t) =>
                t.replace(/^direction: .*$/m, `direction: "[[【索引】${newName}]]"`));
            }
          }
          await this.renameGraphColorQuery(oldName, newName);   // 配色跟着方向走
          await this.rekeyNodeColors(dirPath, newDirPath);      // 自定义颜色也跟着走
          await this.reindex();
          await this.reindexAndRender();
          if (this.index.byBasename.has(`【索引】${newName}`)) {
            this.selectNode(this.index.byBasename.get(`【索引】${newName}`).path);
          }
          new Notice(`方向已改名为 ${suffix}`);
        } catch (err) {
          new Notice(`重命名失败:${err.message}`);
        }
      }).open();
    }

    /** 索引笔记重命名(只改文件名与 title;跨域链接由 Obsidian 自动改写) */
    async renameIndexFile(node) {
      const oldBase = node.basename;
      const display = oldBase.replace(/^【索引】/, "");
      new PromptModal(this.app, "新的索引名(不含【索引】前缀)", display, display, async (raw) => {
        const name = raw.trim().replace(/^【索引】/, "").replace(/[\\/:*?"<>|#^[\]]/g, "-");
        if (!name) return;
        const newBase = `【索引】${name}`;
        if (newBase === oldBase) return;
        const dir = posixDirname(node.path);
        const newPath = `${dir}/${newBase}.md`;
        if (this.app.vault.getAbstractFileByPath(newPath)) { new Notice("目标已存在"); return; }
        try {
          const f = this.app.vault.getAbstractFileByPath(node.path);
          if (!(f instanceof TFile)) throw new Error("找不到索引笔记");
          await this.app.fileManager.renameFile(f, newPath);
          await this.app.vault.process(
            this.app.vault.getAbstractFileByPath(newPath),
            (t) => patchScalarField(t, "title", `"${newBase}"`));
          await this.renameGraphColorQuery(`${oldBase}.md`, `${newBase}.md`);
          await this.rekeyNodeColors(node.path, newPath);     // 自定义颜色也跟着走
          await this.reindex();
          await this.reindexAndRender();
          if (this.index.nodes.has(newPath)) this.selectNode(newPath);
          new Notice(`索引已改名为 ${newBase}`);
        } catch (err) {
          new Notice(`重命名失败:${err.message}`);
        }
      }).open();
    }

    /** 删除:论文 = 整个文件夹(笔记 + PDF);索引/笔记 = 单个文件。都进回收站,可恢复 */
    confirmDelete(node, point) {
      const kind = this.nodeKind(node);
      const isPaper = kind === "paper";
      const menu = this.openPanel(point);
      menu.createDiv({ cls: "pnx-menu-title" })
        .setText(`删除「${truncate(node.title || node.basename, 28)}」?`);
      if (isPaper) {
        menu.createDiv({ cls: "pnx-menu-hint" })
          .setText("整个论文文件夹(笔记 + PDF)一起移到回收站。指向它的链接会断,lint 会报 broken-link。");
      } else if (this.isIndexNode(node) && node.children.length) {
        menu.createDiv({ cls: "pnx-menu-hint" })
          .setText(`这个索引下有 ${node.children.length} 个子节点。删掉索引后它们会失去归属(跑 rebuild-index 也补不回来)。`);
      }
      this.menuRow(menu, "trash-2", isPaper ? "删除整个论文文件夹" : "删除这个笔记", async () => {
        this.closeMenu();
        const target = isPaper ? posixDirname(node.path) : node.path;
        await this.trashPath(target, node.path);
      }, { danger: true, tail: "移到回收站" });
      this.menuRow(menu, "x", "取消", () => this.closeMenu());
      menu.at(point);
    }

    async trashPath(path, notePath) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!f) { new Notice(`找不到:${path}`); return; }
      const dirPath = this.paperDirectionDir(notePath || path);
      try {
        if (this.app.fileManager && typeof this.app.fileManager.trashFile === "function") {
          await this.app.fileManager.trashFile(f);
        } else {
          await this.app.vault.trash(f, true);
        }
        await this.rekeyNodeColors(path, null);   // 删掉的节点不需要颜色了
        await this.reindex();
        if (dirPath) await this.regenerateIndexFor(dirPath);   // 被删的论文要从表里消失
        await this.reindexAndRender();
        new Notice(`已移到回收站:${baseName(path)}`);
      } catch (err) {
        new Notice(`删除失败:${err.message}`);
      }
    }


    /** 右键论文行:列出所有方向,点哪搬哪(拖放之外的可靠入口,也方便定位问题) */
    openMoveMenu(srcNode, point) {
      const dirs = [...this.index.nodes.values()]
        .filter((n) => this.isIndexNode(n) && this.inPaperRoot(n.path))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      const here = posixDirname(posixDirname(srcNode.path));
      const menu = this.openPanel(point);
      menu.createDiv({ cls: "pnx-menu-title" })
        .setText(`把「${truncate(srcNode.title || srcNode.basename, 28)}」移到:`);
      for (const d of dirs) {
        const dirPath = posixDirname(d.path);
        if (dirPath === here) continue;
        const row = menu.createDiv({ cls: "pnx-menu-row" });
        const dot = row.createDiv({ cls: "pnx-menu-dot" });
        dot.style.backgroundColor = this.nodeColor(d);
        row.createSpan().setText(d.title || d.basename);
        row.addEventListener("click", () => {
          this.closeMenu();
          this.moveNote(srcNode.path, d);
        });
      }
      menu.at(point);
    }

    confirmMove(srcPath, targetNode, point) {
      const src = this.index.nodes.get(srcPath);
      const srcDir = posixDirname(posixDirname(srcPath)).replace(this.paperRoot() + "/", "");
      const dstDir = posixDirname(targetNode.path).replace(this.paperRoot() + "/", "");
      const menu = this.openPanel(point);
      menu.createDiv({ cls: "pnx-menu-title" })
        .setText(`把「${truncate(src.title || src.basename, 30)}」从 ${srcDir} 移到 ${dstDir}?`);
      const row = menu.createDiv({ cls: "pnx-menu-row" });
      row.createSpan().setText(`移到「${dstDir}」(笔记 + PDF 一起走,指向它的链接自动改)`);
      row.addEventListener("click", async () => {
        this.closeMenu();
        await this.moveNote(srcPath, targetNode);
      });
      const cancel = menu.createDiv({ cls: "pnx-menu-row" });
      cancel.createSpan().setText("取消");
      cancel.addEventListener("click", () => this.closeMenu());
      menu.at(point);
    }

    /* ---------- 右键新建:方向索引 / 论文 stub(与 research_wiki.py new/scaffold 同格式) ---------- */

    /** 索引节点上的右键菜单。域总览(papers/ 直属层)→ 新建方向;方向索引 → 新建论文 stub */
    openIndexMenu(node, point) {
      const parentDir = posixDirname(node.path);            // papers/ 或 papers/<方向>
      const menu = this.openPanel(point);
      menu.createDiv({ cls: "pnx-menu-title" }).setText(truncate(node.title || node.basename, 30));
      if (parentDir === this.paperRoot()) {
        // papers/ 的域总览:建新方向(文件夹 + 索引骨架 + 图谱配色)
        const row = menu.createDiv({ cls: "pnx-menu-row" });
        row.createSpan().setText("＋ 新建方向索引…");
        row.addEventListener("click", () => {
          this.closeMenu();
          new PromptModal(this.app, "新方向的文件夹名(如 06-长序列建模)",
            "06-长序列建模", "", (name) => this.createDirection(name)).open();
        });
      } else if (posixDirname(parentDir) === this.paperRoot() || parentDir === this.unfiledDir()) {
        // 方向索引:建论文 stub(frontmatter + 起步正文,与 new 命令一致)
        const dirName = baseName(parentDir);
        const row = menu.createDiv({ cls: "pnx-menu-row" });
        row.createSpan().setText("＋ 新建论文笔记…");
        row.addEventListener("click", () => {
          this.closeMenu();
          this.openNewPaperDialog(dirName);
        });
      }
      const cancel = menu.createDiv({ cls: "pnx-menu-row" });
      cancel.createSpan().setText("取消");
      cancel.addEventListener("click", () => this.closeMenu());
      menu.at(point);
    }

    /**
     * 新建方向:等价于 `research_wiki.py scaffold --apply` 对一个新文件夹做的事 ——
     * 建 papers/<name>/、写【索引】骨架(frontmatter + 简介占位 + `## 论文`)、
     * 在 graph.json 的 colorGroups 里分一个没被占用的颜色(新方向在图谱里自成一簇)。
     */
    async createDirection(name) {
      const safe = name.trim().replace(/[\\/:#^[\]|]/g, "-");
      if (!safe) return;
      const paperRoot = this.paperRoot();
      const papersFolder = this.app.vault.getAbstractFileByPath(paperRoot);
      if (!(papersFolder instanceof TFolder)) { new Notice(`找不到 ${paperRoot}/ 文件夹`); return; }
      if (papersFolder.children.some((c) => c.name === safe)) {
        new Notice(`${paperRoot}/${safe} 已存在`); return;
      }
      try {
        await this.app.vault.createFolder(`${paperRoot}/${safe}`);
        const skeleton = [
          "---",
          `title: "【索引】${safe}"`,
          "---",
          "",
          `> 这个方向在研究什么——一句话定位(手写;\`## 论文\` 以上的内容工具永不改动)`,
          "",
          "## 论文",
          "",
        ].join("\n");
        await this.app.vault.create(`${paperRoot}/${safe}/【索引】${safe}.md`, skeleton);
      } catch (err) {
        new Notice(`创建失败:${err.message}`);
        return;
      }
      // 图谱配色:graph.json 的 colorGroups 追加一项(已占用 query 跳过;颜色从调色板里挑拉得开的)
      try {
        const gp = this.app.vault.configDir + "/graph.json";
        const raw = await this.app.vault.adapter.read(gp);
        const graph = JSON.parse(raw);
        const groups = graph.colorGroups || (graph.colorGroups = []);
        const query = `path:"${safe}"`;
        if (!groups.some((g) => g.query === query)) {
          const used = groups.map((g) => g.color && g.color.rgb).filter((c) => typeof c === "number").map(rgbIntToHex);
          const hex = pickGraphColor(used);
          if (hex) {
            const r = parseInt(hex.slice(1, 3), 16), g2 = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
            groups.push({ query, color: { a: 1, rgb: (r << 16) + (g2 << 8) + b } });
            await this.app.vault.adapter.write(gp, JSON.stringify(graph, null, 2) + "\n");
          } else {
            new Notice("调色板里没有拉得开的颜色了,图谱配色请在 graph.json 手动补一项");
          }
        }
      } catch (err) {
        new Notice(`方向已建好,但图谱配色没写上:${err.message}(可跑 scaffold --apply 补)`);
      }
      await this.reindexAndRender();
      // 把新方向挂进域索引笔记的 `## 方向` —— 域是笔记不是文件夹,不挂这一条链接,
      // 新方向在左树里就没有父节点(会悬在根上)。
      const domPath = `${paperRoot}/【索引】` + (this.domainOf(this.selected) || "llm4rec") + ".md";
      const domFile = this.app.vault.getAbstractFileByPath(domPath);
      if (domFile instanceof TFile) {
        await this.app.vault.process(domFile, (text) =>
          text.replace(/\s*$/, "") + `\n- [[【索引】${safe}]]\n`);
        await this.reindexAndRender();
      } else {
        new Notice(`提醒:把 \`- [[【索引】${safe}]]\` 加进域索引笔记的 ## 方向 里,它才会挂在域下`);
      }
      // 选中并展开新方向,树里立刻能看到它
      const idxPath = `${paperRoot}/${safe}/【索引】${safe}.md`;
      if (this.index.nodes.has(idxPath)) this.selectNode(idxPath);
      new Notice(`方向「${safe}」已创建(索引骨架 + 图谱配色 + 已挂进域)`);
    }

    /** 某个节点属于哪个域:沿树的 parent 链往上找第一张「papers/ 顶层的域索引笔记」 */
    domainOf(path) {
      if (!path || !this.index) return null;
      let cur = this.index.nodes.get(path);
      while (cur) {
        const p = cur.parent ? this.index.nodes.get(cur.parent) : null;
        if (p && posixDirname(p.path) === this.paperRoot() && REP_RE.test(p.basename)) {
          return p.basename.replace(/^【索引】/, "");
        }
        cur = p;
      }
      return null;
    }

    /** 新建论文 stub 的三问弹窗(年份/slug/一句话),然后按 new 命令的格式落盘 */
    openNewPaperDialog(dirName) {
      new PromptModal(this.app, `在「${dirName}」新建论文 — 年份(如 2026)`, "2026",
        String(new Date().getFullYear()), (year) => {
          if (!/^\d{4}$/.test(year)) { new Notice("年份要是 4 位数字,如 2026"); return; }
          new PromptModal(this.app, "slug(英文机器 id,决定文件夹名,kebab-case)",
            "my-new-paper", "", (slug) => {
              const clean = slug.trim().toLowerCase().replace(/\s+/g, "-");
              if (!clean) return;
              new PromptModal(this.app, "一句话摘要:这篇在解什么问题 + 用什么关键机制解(可留空后补)",
                "问题 + 关键方法", "", (summary) =>
                this.createPaperStub(dirName, year, clean, summary.trim())).open();
            }).open();
        }).open();
    }

    /**
     * 新建论文 stub:等价于 `research_wiki.py new`(不带 PDF —— PDF 请拖进文件夹后
     * 把文件名填进 frontmatter 的 pdf 字段)。写完重建方向索引,条目立刻出现。
     */
    /** 打开实体的 locator：本地目录 → Finder，git/web → 浏览器，ssh → 复制命令。 */
    openNodeResource(node) {
      if (!node || !node.locator) { new Notice("这个实体没有 locator"); return; }
      if (!adapters) { new Notice("adapters 不可用（仅桌面端支持外部资源）"); return; }
      const r = adapters.openResource(node.locator, { clipboard: navigator.clipboard });
      if (r.ok) {
        new Notice(r.how === "clipboard" ? `已复制:${r.command}` : "已打开资源所在位置");
      } else {
        new Notice(`打开失败:${r.error || "未知错误"}`);
      }
    }

    /** 与 `tools/pinakes.py describe --json` 同构的机器可读契约。
     *  插件只读同一份 _schema/.compiled.json，不另写一套规则。 */
    describeJSON() {
      const sc = this.schema || DEFAULT_SCHEMA;
      const instances = [];
      const boundaries = [];
      const unreachable = [];
      for (const n of this.index.nodes.values()) {
        if (!n.kind) continue;
        const kindSpec = (sc.kinds || {})[n.kind] || {};
        const depth = n.depth || kindSpec.default_depth || "self";
        const inst = { path: n.path, kind: n.kind, depth, title: n.title || n.basename };
        if (n.locator) inst.locator = n.locator;
        if (n.resourceOk === false) {
          inst.resource_ok = false;
          inst.resource_error = n.resourceError || "unknown";
          unreachable.push({ path: n.path, locator: n.locator, error: n.resourceError || "unknown" });
        }
        instances.push(inst);
        if (depth !== "full") boundaries.push(n.path);
      }
      return {
        schema_version: sc.schema_version || 1,
        kinds: Object.values(sc.kinds || {}),
        fields: sc.fields || [],
        unknown: sc.unknown || {},
        instances,
        boundaries,
        unreachable,
        operations: ["create", "update", "move", "link", "archive"],
      };
    }

    /** 列出所有 locator 不可达（或远程未探测）的实体，供人工确认。 */
    showUnreachable() {
      const bad = [...this.index.nodes.values()].filter((n) => n.resourceOk === false);
      const remote = [...this.index.nodes.values()].filter((n) => n.locator && n.resourceOk === null);
      const modal = new Modal(this.app);
      modal.titleEl.setText("Pinakes:资源可达性");
      modal.contentEl.createEl("p", { text:
        `不可达 ${bad.length} 个；远程未探测 ${remote.length} 个（远程不做网络探测）。` });
      const list = modal.contentEl.createEl("div", { cls: "pnx-resource-list" });
      for (const n of bad) {
        const row = list.createDiv({ cls: "pnx-resource-row is-error" });
        row.createSpan({ text: n.title || n.basename });
        row.createSpan({ cls: "pnx-resource-why", text: `${n.resourceError || "unknown"} · ${n.locator}` });
      }
      for (const n of remote) {
        const row = list.createDiv({ cls: "pnx-resource-row" });
        row.createSpan({ text: n.title || n.basename });
        row.createSpan({ cls: "pnx-resource-why", text: `远程 · ${n.locator}` });
      }
      const close = modal.contentEl.createEl("button", { cls: "mod-cta" });
      close.setText("关闭");
      close.addEventListener("click", () => modal.close());
      modal.open();
    }

    showDescribe() {
      const json = JSON.stringify(this.describeJSON(), null, 2);
      const modal = new Modal(this.app);
      modal.titleEl.setText("Pinakes:库结构（describe --json）");
      const pre = modal.contentEl.createEl("pre", { cls: "pnx-describe" });
      pre.setText(json);
      const row = modal.contentEl.createDiv({ cls: "pnx-form-actions" });
      const copy = row.createEl("button", { cls: "mod-cta" });
      copy.setText("复制 JSON");
      copy.addEventListener("click", () => navigator.clipboard.writeText(json).then(
        () => new Notice("已复制 describe JSON"),
        () => new Notice("复制失败")));
      const close = row.createEl("button");
      close.setText("关闭");
      close.addEventListener("click", () => modal.close());
      modal.open();
    }

    /** 可选方向列表:第一个固定是 `_unfiled`(默认),其余按域/方向名排序。
     *  只收 papers/ 下真正的方向索引(排除域索引与 papers 容器)。 */
    directionOptions() {
      const dirs = [...this.index.nodes.values()]
        .filter((n) => posixDirname(posixDirname(n.path)) === this.paperRoot() && REP_RE.test(n.basename))
        .map((n) => ({ name: baseName(posixDirname(n.path)), label: n.title || n.basename }));
      const unfiled = dirs.find((d) => d.name === "_unfiled");
      const rest = dirs.filter((d) => d.name !== "_unfiled")
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      if (unfiled) rest.unshift(unfiled);
      return rest;
    }

    async openAddPaper(opts = {}) {
      if (!this.index || !this.index.root) { new Notice("索引还没建好,稍等一下再试"); return; }
      const dirs = this.directionOptions();
      if (!dirs.length) {
        // 空库/没有待归档分区:先自动补 _unfiled(欢迎页「新建第一篇论文」的必经路径)
        await this.ensureUnfiled();
        const retry = this.directionOptions();
        if (!retry.length) { new Notice(`${this.paperRoot()}/ 下没有方向索引,先新建一个方向`); return; }
        new AddPaperModal(this.app, retry, (payload) => this.addPaperFromPdf(payload), opts).open();
        return;
      }
      new AddPaperModal(this.app, dirs, (payload) => this.addPaperFromPdf(payload), opts).open();
    }

    /** 待归档分区不存在时补一个(空库自举的第二段;有就不动)。 */
    async ensureUnfiled() {
      const root = this.paperRoot();
      const dir = `${root}/${UNFILED_DIR}`;
      if (this.app.vault.getAbstractFileByPath(`${dir}/【索引】${UNFILED_DIR}.md`)) return;
      try {
        await this.app.vault.createFolder(dir);
        await this.app.vault.create(`${dir}/【索引】${UNFILED_DIR}.md`, [
          "---",
          `title: "【索引】${UNFILED_DIR}"`,
          "---",
          "",
          "> 待归档分区:已入库但还没定方向的论文先整篇落在这里(`direction` 指向它),",
          "> 读完再拖到正式方向。它是 todolist,不是方向 —— 清空后也仍然存在。",
          "",
          "## 论文",
          "",
          "- (还没有待归档的论文)",
          "",
        ].join("\n"));
        await this.reindex();
      } catch (err) {
        new Notice(`建待归档分区失败:${err.message}`);
      }
    }

    /** 落盘:建文件夹 → 拷 PDF(可选)→ 写规范笔记 → 重建索引。
     *  有 PDF:File.arrayBuffer + vault.createBinary(跨平台,不碰 Node fs);
     *  没有 PDF(欢迎页的新手路径):只写笔记,PDF callout 提示拖进来后补 pdf 字段。 */
    async addPaperFromPdf({ file, dirName, year, slug, title, tags, authors, summary, abstract }) {
      const dirPath = `${this.paperRoot()}/${dirName}`;
      if (!this.index.nodes.get(`${dirPath}/【索引】${dirName}.md`)) {
        new Notice(`方向索引不存在:${dirPath}`); return;
      }
      const pdfName = file ? `【${year}】${slug}.pdf` : "";
      const { folderName, text } = buildPaperNote({
        dirName, year, slug, title, tags, summary, authors, abstract,
        pdfName,
      });
      const folderPath = `${dirPath}/${folderName}`;
      if (this.app.vault.getAbstractFileByPath(folderPath)) {
        new Notice(`${folderPath} 已存在,换个 slug 或年份`); return;
      }
      try {
        await this.app.vault.createFolder(folderPath);
        if (file) {
          // 1) 拷 PDF:读成 ArrayBuffer 再 createBinary(跨平台,不碰 Node fs)
          const buf = await file.arrayBuffer();
          await this.app.vault.createBinary(`${folderPath}/${pdfName}`, buf);
        }
        // 2) 写笔记(与 research_wiki.py new 同格式)
        await this.app.vault.create(`${folderPath}/${folderName}.md`, text);
      } catch (err) {
        new Notice(`创建失败:${err.message}`);
        return;
      }
      await this.reindex();
      await this.regenerateIndexFor(dirPath);     // 立刻出现在方向索引表里
      await this.reindexAndRender();
      const notePath = `${folderPath}/${folderName}.md`;
      if (this.index.nodes.has(notePath)) this.selectNode(notePath);
      const tail = dirName === UNFILED_DIR ? "(在「待归档」里,读完可拖到方向)" : "";
      new Notice(`已添加:${folderName}${tail}${file ? "" : " · 没有 PDF,拖进文件夹后把文件名填进 pdf 字段"}`);
    }

    async createPaperStub(dirName, year, slug, summary) {
      const folderName = `【${year}】${slug}`;
      const dirPath = `${this.paperRoot()}/${dirName}`;
      if (!this.index.nodes.get(`${dirPath}/【索引】${dirName}.md`)) {
        new Notice(`方向索引不存在:${dirPath}`); return;
      }
      if (this.app.vault.getAbstractFileByPath(`${dirPath}/${folderName}`)) {
        new Notice(`${dirPath}/${folderName} 已存在`); return;
      }
      const pdfName = `${folderName}.pdf`;   // 按规范预留同名 PDF 位;没有 PDF 时字段留空待补
      const note = [
        "---",
        "importance: 1",
        "reading: 未读",
        `direction: "[[【索引】${dirName}]]"`,
        `title: "【${year}】${slug}"`,
        `slug: "${slug}"`,
        `year: ${year}`,
        `pdf: ""`,
        `tags: []`,
        summary ? `table_summary: "${summary.replace(/"/g, "「").replace(/\\/g, "")}"` : "table_summary: \"\"",
        "authors: []",
        "---",
        "",
        pdfName && "> [!note] 📄 原文 PDF：把 PDF 拖进本文件夹并命名为「" + pdfName + "」,然后打开这条链接 →[[" + pdfName + "|在侧栏打开原文]]",
        "",
        "## 整体综述",
        "",
        "(自由记录:这篇在解什么问题、关键机制、值不值得深读。下面几节只是起步建议,随意增删改名。)",
        "",
        "## 论文信息",
        `- 标题:${slug}`,
        `- 年份:${year}`,
        "",
        "## 路径",
        `- [返回方向页](../【索引】${dirName}.md)`,
        "",
      ].filter((l) => l !== null).join("\n");
      try {
        await this.app.vault.createFolder(`${dirPath}/${folderName}`);
        await this.app.vault.create(`${dirPath}/${folderName}/${folderName}.md`, note);
      } catch (err) {
        new Notice(`创建失败:${err.message}`); return;
      }
      await this.reindex();
      await this.regenerateIndexFor(dirPath);   // 新论文要立刻出现在方向索引表里
      await this.reindexAndRender();
      const notePath = `${dirPath}/${folderName}/${folderName}.md`;
      if (this.index.nodes.has(notePath)) this.selectNode(notePath);
      new Notice(`论文 stub 已创建:${folderName}(tags/pdf 待补,补完跑 lint)`);
    }

    /**
     * 真移动:整文件夹(note + PDF)一起搬,然后重建**两个**方向索引的 `## 论文`。
     * 用 vault 的 fileManager.renameFile —— Obsidian 会顺手改写全库指向它的相对链接
     * (alwaysUpdateLinks),比我们自己扫链接可靠。索引段落的重建与
     * `research_wiki.py rebuild-index` 同格式,所以不会把索引改脏(lint 的 index-stale 会兜底)。
     */
    async moveNote(srcPath, targetNode) {
      const srcDir = posixDirname(posixDirname(srcPath));      // papers/<旧方向>
      const dstDir = posixDirname(targetNode.path);            // papers/<新方向>
      const folderName = baseName(posixDirname(srcPath));      // 【year】slug
      const srcFolderPath = posixDirname(srcPath);
      const srcFolder = this.app.vault.getAbstractFileByPath(srcFolderPath);
      if (!srcFolder) { new Notice(`找不到源文件夹:${srcFolderPath}`); return; }

      // 阶段一:搬文件夹(笔记 + PDF 一起走)。Obsidian 会顺手改写全库相对链接。
      let moved = false;
      try {
        await this.app.fileManager.renameFile(srcFolder, `${dstDir}/${folderName}`);
        moved = true;
      } catch (err) {
        new Notice(`移动失败:${err.message} @ ${(err.stack || "").split("\n")[1] || "?"}`);
        return;
      }
      // 主方向字段跟着一起改 —— 文件位置与字段不一致会被 lint 报 error
      const movedNote = this.app.vault.getAbstractFileByPath(`${dstDir}/${folderName}/${folderName}.md`);
      if (movedNote instanceof TFile) {
        await this.app.vault.process(movedNote, (text) => patchScalarField(
          text, "direction", `"[[【索引】${baseName(dstDir)}]]"`));
      }
      new Notice(`已移到 ${dstDir.replace(this.paperRoot() + "/", "")}(主方向字段已同步,索引重建中…)`);

      // 自定义颜色跟着路径走(搬走的是整文件夹:里面的 key 前缀一起改)
      await this.rekeyNodeColors(srcFolderPath, `${dstDir}/${folderName}`);

      // 阶段二:重建两个方向的索引 + 刷新视图。这一段失败不该说成"移动失败"——
      // 文件已经搬过去了,只是索引没跟上(lint 会报 index-stale,重跑 rebuild-index 即可)。
      try {
        await this.reindex();
        await this.regenerateIndexFor(srcDir);
        await this.regenerateIndexFor(dstDir);
        await this.reindexAndRender();
        new Notice(`已移到 ${dstDir.replace(this.paperRoot() + "/", "")}(索引已重建)`);
      } catch (err) {
        new Notice(`文件已移动,但索引重建失败:${err.message} @ ${(err.stack || "").split("\n")[1] || "?"}`);
        console.error("Pinakes: 索引重建失败", err);
      }
    }

    /** 空库自举:建最小骨架(根笔记 + papers 入口 + _unfiled 分区)。
     *  新用户"只装插件、从空白 vault 开始"的路径 —— 建完 reindex 会重新扫描,
     *  树/图立刻有东西可看。与 tools/make_template.py 生成的 template/ 同一套内容。 */
    async bootstrapSkeleton() {
      const paperRoot = this.paperRoot();
      const skeleton = [
        {
          path: "【索引】研究总览.md",
          text: [
            "---",
            'title: "【索引】研究总览"',
            "---",
            "",
            "我的研究笔记库。**每篇论文一份 canonical 深度笔记**——它在所属方向下 `【年份】slug/`",
            "文件夹里,文件名与文件夹同名,PDF 与它同处一处;涉及多个方向时只链接到这份笔记、不复制正文。",
            "",
            "库按**大类别(域)**组织:域是一张索引笔记,域下平铺各个方向(方向名带域前缀)。",
            "",
            "> [!tip] 第一次使用",
            "> 点顶栏「添加论文」选一个本地 PDF——它会自动拷进库、读出标题/作者/摘要、生成规范笔记。",
            "> 没有 PDF 也能建笔记骨架。命令面板里有「欢迎与功能介绍」。",
            "",
            "## 大类别",
            "",
            `- [【索引】papers](${paperRoot}/【索引】papers.md):论文库 —— 域(大类别)→ 方向 → 论文。`,
            "",
          ].join("\n"),
        },
        {
          path: `${paperRoot}/【索引】papers.md`,
          text: [
            "---",
            'title: "【索引】papers"',
            "---",
            "",
            "> 论文库的入口:**域(大类别)→ 方向 → 论文**。域是索引笔记而不是文件夹:",
            "> 域会随研究方向增删,而「一篇论文一个文件夹」的结构不该跟着抖。",
            "",
            "**新开一个域**:写一篇 `【索引】<域>.md`(正文用 `## 方向` 列它的方向),",
            "再在下面的 `## 大类别` 里加一条 `[[【索引】<域>]]`。",
            "**新开一个方向**:Pinakes 左树右键域索引 →「＋ 新建方向索引…」。",
            "",
            "## 大类别",
            "",
            "- (还没有域。新开一个域后这里会出现它的链接。)",
            "",
            "## 待归档",
            "",
            "- [[【索引】_unfiled]]",
            "",
          ].join("\n"),
        },
        {
          path: `${paperRoot}/${UNFILED_DIR}/【索引】${UNFILED_DIR}.md`,
          text: [
            "---",
            'title: "【索引】_unfiled"',
            "---",
            "",
            "> 待归档分区:已入库但还没定方向的论文先整篇落在这里(`direction` 指向它),",
            "> 读完再拖到正式方向。它是 todolist,不是方向 —— 清空后也仍然存在。",
            "",
            "## 论文",
            "",
            "- (还没有待归档的论文)",
            "",
          ].join("\n"),
        },
      ];
      try {
        for (const { path, text } of skeleton) {
          if (this.app.vault.getAbstractFileByPath(path)) continue;
          await this.app.vault.create(path, text);
        }
        return true;
      } catch (err) {
        console.error("Pinakes: 初始化骨架失败", err);
        return false;
      }
    }

    /** 重建某个方向索引的 `## 论文` 段落(生成逻辑见纯函数 buildIndexSection) */
    async regenerateIndexFor(dirPath) {
      const idxNode = [...this.index.nodes.values()].find(
        (n) => posixDirname(n.path) === dirPath && this.isIndexNode(n));
      if (!idxNode) return;
      const cols = this.schema && this.schema.kinds && this.schema.kinds.direction
        ? this.schema.kinds.direction.index_columns : null;
      const section = buildIndexSection(idxNode, this.index.nodes, cols);
      const file = this.app.vault.getAbstractFileByPath(idxNode.path);
      if (!(file instanceof TFile)) return;
      await this.app.vault.process(file, (text) => {
        const i = text.search(/^## 论文[ \t]*$/m);
        const head = i >= 0 ? text.slice(0, i) : text.replace(/\s*$/, "") + "\n\n";
        return head + section;
      });
    }

    /** 论文路径 → 它所在的方向目录(papers/<方向>);不是论文返回 null。
     *  索引表的四列都来自 frontmatter(标题/年份/标签/简介),所以**任何改这些字段的操作**
     *  之后都要调 regenerateIndexFor,否则 lint 会报 index-stale。 */
    paperDirectionDir(path) {
      const root = this.paperRoot();
      const parts = String(path || "").split("/");
      if (parts[0] !== root || parts.length !== 4) return null;
      return `${parts[0]}/${parts[1]}`;
    }

    /* ---------- 编辑模式:点两个节点连线,点边改/删,写回 frontmatter ---------- */

    setEditMode(on) {
      this.editMode = on;
      this.btnEdit.toggleClass("is-on", on);
      this.stageEl.toggleClass("is-editing", on);
      this.cancelLink();
      this.selectEdge(null);
      this.renderCard(this.index && this.index.nodes.get(this.focused));
      this.requestDraw();
    }

    cancelLink() {
      this.linkSource = null;
      this.closeMenu();
      this.requestDraw();
    }

    /** 编辑模式下点击节点:没有连线源 → 设为源;有 → 弹出类型工具栏 */
    editTapNode(sim, e) {
      // 第一下:把它设为连线源;第二下:弹出类型工具栏(锚在第二个节点旁边)
      if (!this.linkSource) {
        this.linkSource = sim;
        this.setStatus(`连线源:${truncate(sim.node.title || sim.node.basename, 30)} — 再点一个节点选关系类型`);
        this.requestDraw();
        return;
      }
      if (sim === this.linkSource) { this.cancelLink(); return; }
      const src = this.linkSource;               // 闭包里抓住,免得中途被 cancel 清掉
      const point = e ? { x: e.clientX, y: e.clientY } : null;
      this.openTypeMenu(point,
        (type) => this.writeEdge(src.node, sim.node, type),
        () => this.cancelLink());
    }

    /** 编辑模式下点击边:弹出 改类型 / 翻转 / 删除 工具栏 */
    editTapEdge(simEdge, e) {
      if (simEdge.type === HIER_TYPE || simEdge.type === ATTR_TYPE) {
        new Notice(simEdge.type === HIER_TYPE
          ? "层级线由目录推导,不能编辑(它跟着文件夹走)"
          : "归属线由所属方向推导,不能编辑");
        return;
      }
      this.selectEdge(simEdge);
      const anchor = { x: e.clientX, y: e.clientY };
      const meta = simEdge.type === PLAIN_TYPE ? null : REL_META[simEdge.type];
      const symmetric = meta ? meta.symmetric : true; // 普通链接/对称边:翻转无意义
      this.openTypeMenu(
        anchor,
        (type) => this.changeEdgeType(simEdge, type),
        () => this.selectEdge(null),
        {
          title: meta ? `${meta.label}:${simEdge.a.node.basename} → ${simEdge.b.node.basename}` : "普通链接",
          extra: [
            symmetric ? null : {
              label: "⇄ 翻转方向",
              run: () => this.flipEdge(simEdge),
            },
            {
              label: "✕ 删除这条边",
              danger: true,
              run: () => this.removeEdge(simEdge),
            },
          ],
        }
      );
    }

    selectEdge(se) {
      this.selEdge = se;
      this.requestDraw();
    }

    closeMenu() {
      if (this.menuEl) { this.menuEl.remove(); this.menuEl = null; }
      // 关键:document 上的监听必须跟着一起摘。只 remove 元素的话,旧监听还活着,
      // 下一次 pointerdown(哪怕就落在新菜单的类型行上)会被它判成"点了外部",
      // 于是新菜单在你点中之前就被关掉 —— 表现就是"有工具栏,点了没反应"。
      if (this.menuCleanup) { this.menuCleanup(); this.menuCleanup = null; }
    }

    /**
     * 鼠标位置旁的类型工具栏。
     * point: 锚点(client 坐标 {x, y};传 null 则居中)。**传坐标对象而不是取坐标的函数** ——
     *   之前传函数时调用方漏传事件参数,`e` 是 undefined 直接抛异常,工具栏弹不出来。
     * pick(type): 选中类型回调;onCancel: 点外部/Esc;opts.extra: 额外动作行;opts.title: 顶部说明。
     */
    openTypeMenu(point, pick, onCancel, opts = {}) {
      this.closeMenu();
      const menu = this.stageEl.createDiv({ cls: "pnx-menu" });
      this.menuEl = menu;
      if (opts.title) menu.createDiv({ cls: "pnx-menu-title" }).setText(truncate(opts.title, 46));

      // 「默认链接」写在正文里(无类型的笔记间链接),图上画成灰色虚线;
      // 其余三种是 frontmatter 的有类型关系
      for (const t of [PLAIN_TYPE, ...REL_KEYS]) {
        const meta = t === PLAIN_TYPE
          ? { label: "plain link(写正文)", color: PLAIN_COLOR } : REL_META[t];
        const row = menu.createDiv({ cls: "pnx-menu-row" });
        const sw = row.createDiv({ cls: "pnx-menu-swatch" });
        sw.style.backgroundColor = meta.color;
        row.createSpan().setText(meta.label);
        row.addEventListener("click", () => { this.closeMenu(); pick(t); });
      }
      for (const x of opts.extra || []) {
        if (!x) continue;
        const row = menu.createDiv({ cls: "pnx-menu-row" + (x.danger ? " is-danger" : "") });
        row.createSpan().setText(x.label);
        row.addEventListener("click", () => { this.closeMenu(); x.run(); });
      }
      if (!opts.extra) {
        const hint = menu.createDiv({ cls: "pnx-menu-hint" });
        hint.setText("新增类型:改 tools/relation_vocabulary.yml 后跑 sync-relations");
      }

      // 定位(转 stage 本地坐标,防溢出)
      const sr = this.stageEl.getBoundingClientRect();
      menu.style.left = "0px"; menu.style.top = "0px"; // 先量尺寸
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      let x, y;
      if (point && Number.isFinite(point.x)) {
        x = point.x - sr.left + 12;
        y = point.y - sr.top + 12;
      } else {
        x = (sr.width - mw) / 2;
        y = (sr.height - mh) / 2;
      }
      x = Math.max(4, Math.min(x, Math.max(sr.width - mw - 4, 4)));
      y = Math.max(4, Math.min(y, Math.max(sr.height - mh - 4, 4)));
      menu.style.left = x + "px";
      menu.style.top = y + "px";

      // 点外部 / Esc 关闭(监听统一由 closeMenu 摘除,避免泄漏后误关下一个菜单)
      const outside = (ev) => {
        if (menu.contains(ev.target)) return;
        this.closeMenu();
        if (onCancel) onCancel();
      };
      const onKey = (ev) => {
        if (ev.key !== "Escape") return;
        this.closeMenu();
        if (onCancel) onCancel();
      };
      this.menuCleanup = () => {
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("keydown", onKey, true);
      };
      setTimeout(() => {
        if (!this.menuEl) return;
        document.addEventListener("pointerdown", outside, true);
        document.addEventListener("keydown", onKey, true);
      }, 0);
    }

    /** 把 {srcNode, dstNode, type} 写进源笔记的 frontmatter;plain 类型写正文 wiki 链接前先确认 */
    async writeEdge(srcNode, dstNode, type) {
      if (type === PLAIN_TYPE) {
        await this.appendBodyLink(srcNode, dstNode);
        await this.reindexAndRender();
        const ok = `plain link:${truncate(srcNode.basename, 22)} → ${truncate(dstNode.basename, 22)} 已写正文 ✓`;
        new Notice(ok);
        this.setStatus(ok, "ok");
        this.cancelLink();
        return;
      }
      const file = this.app.vault.getAbstractFileByPath(srcNode.path);
      if (!(file instanceof TFile)) {
        // 以前这里是静默 return —— 点了类型什么都不发生,也看不到原因。现在说清楚。
        const msg = `源笔记路径解析不到:${srcNode.path}`;
        new Notice("写入失败:" + msg);
        this.setStatus("写入失败 — " + msg, "error");
        this.cancelLink();
        return;
      }
      try {
        await this.app.vault.process(file, (text) =>
          patchRelation(text, { add: { field: type, target: dstNode.basename } }));
        // 自检:回读文件确认这条关系真的写进去了(写盘与解析不同步时能立刻发现)
        const after = await this.app.vault.cachedRead(file);
        if (!readRelation(after, type).includes(dstNode.basename)) {
          this.setStatus(`写入后回读没找到 ${type} → ${dstNode.basename}`, "error");
          new Notice("写入似乎没生效:回读文件没找到新关系");
        }
        // 增量更新本地索引,不整库重读
        if (!srcNode.rels[type]) srcNode.rels[type] = [];
        srcNode.rels[type].push(dstNode.basename);
        this.index.edges.push({ src: srcNode.path, dst: dstNode.path, type });
        this.refreshSubGraph();
        const ok = `${REL_META[type].label}:${truncate(srcNode.basename, 22)} → ${truncate(dstNode.basename, 22)} 已写入 ✓`;
        new Notice(ok);
        this.setStatus(ok, "ok");
      } catch (err) {
        new Notice("写入失败:" + err.message);
        this.setStatus(`写入失败 — ${err.message} @ ${(err.stack || "").split("\n")[1] || "?"}`, "error");
      }
      this.cancelLink();
    }

    /**
     * 「默认链接」= 在源笔记正文的 `## 路径` 节追加一条普通链接(不碰 frontmatter 的
     * 关系字段)。它同样会进图谱 —— 重索引时正文链接会变成 plain 边。
     */
    async appendBodyLink(srcNode, dstNode) {
      const file = this.app.vault.getAbstractFileByPath(srcNode.path);
      if (!(file instanceof TFile)) {
        new Notice(`源笔记路径解析不到:${srcNode.path}`);
        this.setStatus(`写入失败 — 源笔记路径解析不到 ${srcNode.path}`, "error");
        return;
      }
      await this.app.vault.process(file, (text) => {
        const rel = this.relPathBetween(srcNode.path, dstNode.path);
        const line = `- [${dstNode.title || dstNode.basename}](${rel})`;
        const m = text.match(/^(## 路径\s*\n)([\s\S]*?)(?=\n## |\s*$)/m);
        if (m) {
          const end = m.index + m[1].length + (m[2] || "").replace(/\s*$/, "").length;
          return text.slice(0, end).replace(/\s*$/, "") + "\n" + line + "\n" + text.slice(end);
        }
        return text.replace(/\s*$/, "") + "\n\n## 路径\n\n" + line + "\n";
      });
    }

    /** 相对链接路径。**不做百分号编码**(中文原样写;含空格用 <>) */
    relPathBetween(srcPath, dstPath) {
      const srcDir = posixDirname(srcPath).split("/");
      const dstParts = dstPath.split("/");
      const dstFile = dstParts.pop();
      let common = 0;
      while (common < srcDir.length && common < dstParts.length && srcDir[common] === dstParts[common]) common++;
      const up = "../".repeat(srcDir.length - common);
      const rel = up + dstParts.slice(common).concat(dstFile).join("/");
      return /\s/.test(rel) ? `<${rel}>` : rel;
    }

    /** 从源笔记正文里删掉指向目标的普通链接(「默认链接」边只能这样删) */
    async removeBodyLink(srcNode, dstNode) {
      const file = this.app.vault.getAbstractFileByPath(srcNode.path);
      if (!(file instanceof TFile)) {
        new Notice(`源笔记路径解析不到:${srcNode.path}`);
        return;
      }
      await this.app.vault.process(file, (text) => {
        const before = bodyNoteLinks(text, srcNode.basename).length;
        const lines = text.split("\n").filter((line) => {
          if (!line.includes("](")) return true;
          const hit = bodyNoteLinks(line, srcNode.basename).includes(dstNode.basename);
          return !hit;
        });
        return lines.join("\n");
      });
    }

    /** 改一条边的类型:同一字段先 remove 旧目标,再加到新字段 */
    async changeEdgeType(simEdge, newType) {
      const { a, b, type: oldType } = simEdge;
      if (newType === oldType) { this.selectEdge(null); return; }
      if (oldType === PLAIN_TYPE || newType === PLAIN_TYPE) {
        new Notice("「默认链接」写在正文里,不在 frontmatter;要换类型请删掉它再连一条关系");
        this.setStatus("plain link 不能直接改类型:删掉它,再连一条 extends / uses / competes / contradicts", "error");
        this.selectEdge(null);
        return;
      }
      const file = this.app.vault.getAbstractFileByPath(a.node.path);
      if (!(file instanceof TFile)) {
        const msg = `源笔记路径解析不到:${a.node.path}`;
        new Notice("改类型失败:" + msg);
        this.setStatus("改类型失败 — " + msg, "error");
        this.selectEdge(null);
        return;
      }
      let done = false;
      try {
        await this.app.vault.process(file, (text) => {
          // 目标在新类型下已经存在时,只删旧字段即可 —— 否则 add 会抛"已有 X → Y",
          // 整块 process 回滚,表现出来就是"改类型失败",但其实想要的合并已经达成
          const already = readRelation(text, newType).includes(b.node.basename);
          let t = patchRelation(text, { remove: { field: oldType, target: b.node.basename } });
          if (!already) t = patchRelation(t, { add: { field: newType, target: b.node.basename } });
          return t;
        });
        const after = await this.app.vault.cachedRead(file);
        if (!readRelation(after, newType).includes(b.node.basename)) {
          this.setStatus("改类型后回读没找到新关系", "error");
          new Notice("改类型似乎没生效:回读文件没找到");
        }
        // 本地索引
        a.node.rels[oldType] = (a.node.rels[oldType] || []).filter((t) => t !== b.node.basename);
        if (!a.node.rels[newType]) a.node.rels[newType] = [];
        a.node.rels[newType].push(b.node.basename);
        const e = this.index.edges.find((x) => x.src === a.node.path && x.dst === b.node.path && x.type === oldType);
        if (e) e.type = newType;
        const ok = `已改为 ${REL_META[newType].label}:${truncate(a.node.basename, 22)} → ${truncate(b.node.basename, 22)} ✓`;
        new Notice(ok);
        this.setStatus(ok, "ok");
        done = true;
      } catch (err) {
        new Notice("改类型失败:" + err.message);
        this.setStatus(`改类型失败 — ${err.message} @ ${(err.stack || "").split("\n")[1] || "?"}`, "error");
      }
      this.selectEdge(null);
      // 界面刷新放在 try 之外:写盘已经成功,渲染出问题不该被报成"操作失败"
      if (done) this.refreshSubGraph();
    }

    async flipEdge(simEdge) {
      const { a, b, type } = simEdge;
      const srcFile = this.app.vault.getAbstractFileByPath(a.node.path);
      const dstFile = this.app.vault.getAbstractFileByPath(b.node.path);
      if (!(srcFile instanceof TFile) || !(dstFile instanceof TFile)) {
        new Notice("翻转失败:路径解析不到");
        this.selectEdge(null);
        return;
      }
      try {
        await this.app.vault.process(srcFile, (t) => patchRelation(t, { remove: { field: type, target: b.node.basename } }));
        await this.app.vault.process(dstFile, (t) => patchRelation(t, { add: { field: type, target: a.node.basename } }));
        // 本地索引:src 失去这条,b 获得
        a.node.rels[type] = (a.node.rels[type] || []).filter((t) => t !== b.node.basename);
        if (!b.node.rels[type]) b.node.rels[type] = [];
        b.node.rels[type].push(a.node.basename);
        const e = this.index.edges.find((x) => x.src === a.node.path && x.dst === b.node.path && x.type === type);
        if (e) { e.src = b.node.path; e.dst = a.node.path; }
        this.refreshSubGraph();
        new Notice(`已翻转:${b.node.basename} → ${a.node.basename}`);
      } catch (err) {
        new Notice("翻转失败:" + err.message);
      }
      this.selectEdge(null);
    }

    async removeEdge(simEdge) {
      const { a, b, type } = simEdge;
      if (type === PLAIN_TYPE) {
        await this.removeBodyLink(a.node, b.node);
        this.index.edges = this.index.edges.filter(
          (x) => !(x.src === a.node.path && x.dst === b.node.path && x.type === PLAIN_TYPE));
        this.selectEdge(null);
        this.refreshSubGraph();
        new Notice("已删除正文里的默认链接");
        this.setStatus("已删除默认链接 ✓", "ok");
        return;
      }
      const file = this.app.vault.getAbstractFileByPath(a.node.path);
      if (!(file instanceof TFile)) {
        new Notice(`删除失败:源笔记路径解析不到 ${a.node.path}`);
        this.selectEdge(null);
        return;
      }
      try {
        await this.app.vault.process(file, (t) => patchRelation(t, { remove: { field: type, target: b.node.basename } }));
        a.node.rels[type] = (a.node.rels[type] || []).filter((t) => t !== b.node.basename);
        this.index.edges = this.index.edges.filter(
          (x) => !(x.src === a.node.path && x.dst === b.node.path && x.type === type));
        this.refreshSubGraph();
        new Notice(`已删除 ${REL_META[type].label} 边`);
      } catch (err) {
        new Notice("删除失败:" + err.message);
      }
      this.selectEdge(null);
    }

    /** 编辑写盘后的局部重算:按当前选中与展开深度重算,保留节点位置 */
    refreshSubGraph() {
      if (!this.selected) return;
      this.sub = computeSubGraph(this.index, this.selected, {
        includeHierarchy: this.showHier,
        includeAttribution: this.showAttr,
      });
      this.savePosCache();
      this.initSim();           // initSim 优先用 posCache,位置不跳
      this.alpha = Math.max(this.alpha, 0.25);
      this.renderLegend();
      this.renderCard(this.index.nodes.get(this.focused));
      this.startLoop();
    }

    /** 详情卡「+ 添加关系」:搜索目标笔记 */
    openRelPicker(node, point) {
      this.openTypeMenu(
        point,                      // 贴着鼠标;没有坐标才居中
        () => {},
        null,
        { title: "选择目标笔记(支持输入过滤)" }
      );
      // 把菜单换成搜索 + 列表
      const menu = this.menuEl;
      if (!menu) return;
      menu.empty();
      menu.createDiv({ cls: "pnx-menu-title" }).setText(`给「${truncate(node.basename, 24)}」添加关系到:`);
      const input = menu.createEl("input", { cls: "pnx-menu-input", type: "search", placeholder: "搜笔记名…" });
      const list = menu.createDiv({ cls: "pnx-menu-list" });
      const renderList = (q) => {
        list.empty();
        const all = [...this.index.nodes.values()]
          .filter((n) => n.path !== node.path)
          .filter((n) => !q || n.basename.toLowerCase().includes(q) || n.title.toLowerCase().includes(q))
          .slice(0, 12);
        if (!all.length) list.createDiv({ cls: "pnx-menu-hint" }).setText("没有匹配的笔记");
        for (const n of all) {
          const row = list.createDiv({ cls: "pnx-menu-row" });
          const dot = row.createDiv({ cls: "pnx-menu-dot" });
          dot.style.backgroundColor = this.nodeColor(n);
          row.createSpan().setText(truncate(n.basename, 34));
          row.addEventListener("click", () => {
            // 选了目标 → 第二级:选类型
            const dst = n;
            this.openTypeMenu(
              null,
              (type) => this.writeEdge(node, dst, type),
              () => this.closeMenu()
            );
            const m2 = this.menuEl;
            if (m2) {
              m2.empty();
              m2.createDiv({ cls: "pnx-menu-title" }).setText(`${truncate(node.basename, 18)} → ${truncate(dst.basename, 18)}`);
              for (const t of [PLAIN_TYPE, ...REL_KEYS]) {
                const meta = t === PLAIN_TYPE
                  ? { label: "默认链接(正文)", color: PLAIN_COLOR } : REL_META[t];
                const row2 = m2.createDiv({ cls: "pnx-menu-row" });
                const sw = row2.createDiv({ cls: "pnx-menu-swatch" });
                sw.style.backgroundColor = meta.color;
                row2.createSpan().setText(meta.label);
                row2.addEventListener("click", () => { this.closeMenu(); this.writeEdge(node, dst, t); });
              }
              const hint = m2.createDiv({ cls: "pnx-menu-hint" });
              hint.setText("新增类型:改 tools/relation_vocabulary.yml 后跑 sync-relations");
              const sr = this.stageEl.getBoundingClientRect();
              const mw2 = m2.offsetWidth, mh2 = m2.offsetHeight;
              const x2 = point && Number.isFinite(point.x) ? point.x - sr.left + 12 : (sr.width - mw2) / 2;
              const y2 = point && Number.isFinite(point.y) ? point.y - sr.top + 12 : (sr.height - mh2) / 2;
              m2.style.left = Math.max(4, Math.min(x2, Math.max(sr.width - mw2 - 4, 4))) + "px";
              m2.style.top = Math.max(4, Math.min(y2, Math.max(sr.height - mh2 - 4, 4))) + "px";
            }
          });
        }
      };
      renderList("");
      input.addEventListener("input", () => renderList(input.value.trim().toLowerCase()));
      setTimeout(() => input.focus(), 0);
      // 贴鼠标(没有坐标才居中) + 点外部关闭
      if (typeof menu.at === "function") menu.at(point);
      const outside = (ev) => {
        if (menu.contains(ev.target)) return;
        document.removeEventListener("pointerdown", outside, true);
        this.closeMenu();
      };
      setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
    }

    /* ---------- 力导向画布 ---------- */

    initSim() {
      this.savePosCache();
      this.simNodes = layoutNodes(this.sub, { prev: this.posCache });
      this.simById = new Map(this.simNodes.map((n) => [n.id, n]));
      this.simEdges = [];
      for (const e of this.sub.edges) {
        const a = this.simById.get(e.src);
        const b = this.simById.get(e.dst);
        if (a && b) this.simEdges.push({ src: e.src, dst: e.dst, type: e.type, a, b });
      }
      this.alpha = 1;
      this.startLoop();
    }

    restLength(type) {
      return type === HIER_TYPE ? REST_LEN.hier
        : type === ATTR_TYPE ? REST_LEN.attr : REST_LEN.rel;
    }

    step() {
      const a = this.alpha;
      const N = this.simNodes;
      // 斥力(O(n²),子图 ≤ 150 节点,没问题)
      for (let i = 0; i < N.length; i++) {
        for (let j = i + 1; j < N.length; j++) {
          const p = N[i], q = N[j];
          let dx = p.x - q.x, dy = p.y - q.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const d = Math.sqrt(d2);
          const f = Math.min(REPULSION * a / d2, 4);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          p.vx += fx; p.vy += fy;
          q.vx -= fx; q.vy -= fy;
        }
      }
      // 弹簧
      for (const e of this.simEdges) {
        const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const f = (d - this.restLength(e.type)) * 0.015 * a;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        e.a.vx += fx; e.a.vy += fy;
        e.b.vx -= fx; e.b.vy -= fy;
      }
      // 向心 + 阻尼
      for (const n of N) {
        if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
        n.vx += -n.x * CENTER_PULL * a;
        n.vy += -n.y * CENTER_PULL * a;
        n.vx *= 0.8; n.vy *= 0.8;
        n.x += Math.max(-14, Math.min(14, n.vx));
        n.y += Math.max(-14, Math.min(14, n.vy));
      }
      this.alpha *= 0.986;
    }

    startLoop() {
      cancelAnimationFrame(this.rafId);
      const loop = () => {
        const active = this.alpha > 0.02 || this.dragSim || this.panStart;
        if (active) this.step();
        this.draw();
        if (active) this.rafId = requestAnimationFrame(loop);
        else this.rafId = 0;
      };
      this.rafId = requestAnimationFrame(loop);
    }

    requestDraw() {
      if (!this.rafId) {
        this.draw();
      }
    }

    resizeCanvas() {
      if (!this.stageEl) return;
      const rect = this.stageEl.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(rect.width * dpr);
      this.canvas.height = Math.round(rect.height * dpr);
      this.canvas.style.width = rect.width + "px";
      this.canvas.style.height = rect.height + "px";
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = rect.width;
      this.h = rect.height;
      if (this.simNodes.length) { this.fitView(); this.requestDraw(); }
    }

    /** 把某个节点平移到视口中央(只在它跑到视口外时才动;不改变缩放)。
     *  画布固定整库之后,"选中"要靠这个把视线带过去,否则点了树里一行看不出变化。 */
    centerOn(path) {
      if (!this.w || !this.h) return;
      const sn = this.simById && this.simById.get(path);
      if (!sn) return;
      const sx = sn.x * this.k + this.tx, sy = sn.y * this.k + this.ty;
      const pad = 60;
      if (sx > pad && sx < this.w - pad && sy > pad && sy < this.h - pad) return;  // 已经在视口里
      this.tx = this.w / 2 - sn.x * this.k;
      this.ty = this.h / 2 - sn.y * this.k;
      this.requestDraw();
    }

    fitView() {
      if (!this.simNodes.length || !this.w) return;
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const n of this.simNodes) {
        minx = Math.min(minx, n.x); maxx = Math.max(maxx, n.x);
        miny = Math.min(miny, n.y); maxy = Math.max(maxy, n.y);
      }
      const pad = 70;
      const bw = Math.max(maxx - minx, 1) + pad * 2;
      const bh = Math.max(maxy - miny, 1) + pad * 2;
      this.k = Math.min(Math.max(Math.min(this.w / bw, this.h / bh), 0.15), 1.8);
      this.tx = (this.w - bw * this.k) / 2 - minx * this.k + pad * this.k;
      this.ty = (this.h - bh * this.k) / 2 - miny * this.k + pad * this.k;
      this.requestDraw();
    }

    wireCanvas() {
      const cv = this.canvas;
      const toWorld = (cx, cy) => {
        const r = cv.getBoundingClientRect();
        return { x: (cx - r.left - this.tx) / this.k, y: (cy - r.top - this.ty) / this.k };
      };
      const pick = (cx, cy) => {
        const w = toWorld(cx, cy);
        for (let i = this.simNodes.length - 1; i >= 0; i--) {
          const n = this.simNodes[i];
          const dx = w.x - n.x, dy = w.y - n.y;
          const r = n.r + 5 / this.k;
          if (dx * dx + dy * dy <= r * r) return n;
        }
        return null;
      };
      // 边拾取:点到线段距离(屏幕像素)
      const pickEdge = (cx, cy) => {
        const r = cv.getBoundingClientRect();
        const mx = cx - r.left, my = cy - r.top;
        let best = null, bestD = 7;
        for (const e of this.simEdges) {
          if (this.hiddenTypes.has(e.type)) continue;
          // 结构边(层级/归属)不参与编辑,也不该抢节点的点击
          if (!this.editMode && e.type !== HIER_TYPE && e.type !== ATTR_TYPE) continue;
          if (this.editMode && (e.type === HIER_TYPE || e.type === ATTR_TYPE)) continue;
          const ax = e.a.x * this.k + this.tx, ay = e.a.y * this.k + this.ty;
          const bx = e.b.x * this.k + this.tx, by = e.b.y * this.k + this.ty;
          const dx = bx - ax, dy = by - ay;
          const len2 = dx * dx + dy * dy;
          let t = len2 ? ((mx - ax) * dx + (my - ay) * dy) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          const px = ax + dx * t, py = ay + dy * t;
          const d = Math.hypot(mx - px, my - py);
          if (d < bestD) { bestD = d; best = e; }
        }
        return best;
      };

      cv.addEventListener("pointerdown", (e) => {
        const hit = pick(e.clientX, e.clientY);
        cv.setPointerCapture(e.pointerId);
        this.downClient = { x: e.clientX, y: e.clientY };
        this.moved = false;
        if (hit) {
          this.dragSim = hit;
          hit.fixed = true;
        } else {
          this.panStart = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
        }
        this.startLoop();
      });

      cv.addEventListener("pointermove", (e) => {
        // 连线预览:记住鼠标位置画虚线
        if (this.linkSource) {
          const w = toWorld(e.clientX, e.clientY);
          this.mouseX = w.x; this.mouseY = w.y;
        }
        if (this.dragSim) {
          const w = toWorld(e.clientX, e.clientY);
          this.dragSim.x = w.x;
          this.dragSim.y = w.y;
          if (Math.abs(e.clientX - this.downClient.x) + Math.abs(e.clientY - this.downClient.y) > 3) this.moved = true;
          this.requestDraw();
          return;
        }
        if (this.panStart) {
          this.tx = this.panStart.tx + (e.clientX - this.panStart.x);
          this.ty = this.panStart.ty + (e.clientY - this.panStart.y);
          this.requestDraw();
          return;
        }
        // 悬停:高亮邻居 + 提示(编辑模式下边也可悬停变粗)
        const hit = pick(e.clientX, e.clientY);
        this.hoverEdge = hit ? null : (this.editMode ? pickEdge(e.clientX, e.clientY) : null);
        if (hit !== this.hoverSim) {
          this.hoverSim = hit;
          this.requestDraw();
        } else if (this.hoverEdge) {
          this.requestDraw();
        }
        if (hit) {
          const r = cv.getBoundingClientRect();
          this.tipEl.setText(hit.node.title);
          this.tipEl.addClass("is-shown");
          const tw = this.tipEl.offsetWidth;
          this.tipEl.style.left = Math.min(Math.max(e.clientX - r.left + 14, 4), Math.max(this.w - tw - 4, 4)) + "px";
          this.tipEl.style.top = (e.clientY - r.top + 16) + "px";
          cv.style.cursor = "pointer";
        } else {
          if (this.hoverEdge) cv.style.cursor = "pointer";
          else cv.style.cursor = this.linkSource ? "crosshair" : "";
          this.tipEl.removeClass("is-shown");
        }
      });

      cv.addEventListener("pointerup", (e) => {
        if (this.dragSim) {
          const hit = this.dragSim;
          hit.fixed = false;
          this.dragSim = null;
          this.alpha = Math.max(this.alpha, 0.35);
          if (!this.moved) {
            if (this.editMode) {
              // 编辑模式:点节点 = 连线流程(源 → 目标 → 类型工具栏)
              this.editTapNode(hit, e);
            } else if (hit.node.path === this.focused) {
              this.openNote(hit.node);   // 第一击:聚焦出详情卡;再点:直接打开笔记
            } else {
              this.focusNode(hit.node.path);
            }
          }
          this.startLoop();
        } else if (this.panStart && !this.moved && this.editMode) {
          // 编辑模式点空白:点到了边?→ 边菜单;点到了真空 → 取消连线
          const edge = pickEdge(e.clientX, e.clientY);
          if (edge) this.editTapEdge(edge, e);
          else if (this.linkSource) this.cancelLink();
        }
        this.panStart = null;
      });

      cv.addEventListener("pointerleave", () => {
        if (!this.dragSim && !this.panStart) {
          this.hoverSim = null;
          this.hoverEdge = null;
          this.tipEl.removeClass("is-shown");
          this.requestDraw();
        }
      });

      cv.addEventListener("dblclick", (e) => {
        const hit = pick(e.clientX, e.clientY);
        if (!hit) return;
        // 论文/笔记节点双击 = 打开笔记;索引节点双击 = 进入它的子树
        if (this.isIndexNode(hit.node)) this.selectNode(hit.node.path);
        else this.openNote(hit.node);
      });

      cv.addEventListener("wheel", (e) => {
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const f = Math.exp(-e.deltaY * 0.0016);
        const k2 = Math.min(Math.max(this.k * f, 0.12), 4);
        this.tx = mx - ((mx - this.tx) * k2) / this.k;
        this.ty = my - ((my - this.ty) * k2) / this.k;
        this.k = k2;
        this.requestDraw();
      }, { passive: false });
    }

    neighborsOf(id) {
      const s = new Set([id]);
      for (const e of this.simEdges) {
        if (this.hiddenTypes.has(e.type)) continue;
        if (e.src === id) s.add(e.dst);
        else if (e.dst === id) s.add(e.src);
      }
      return s;
    }

    draw() {
      const ctx = this.ctx;
      if (!ctx) return;
      const W = this.w || 0, H = this.h || 0;
      ctx.clearRect(0, 0, W, H);

      // 背景:极淡的径向渐晕。画布本身是"底",层次拉开后浅色球才不显脏
      // (图绘制研究里也强调"紧凑"——同样的信息占更小面积才看得清)。
      const gradKey = `${W}x${H}:${this.theme.bg}`;
      if (!this.bgGrad || this.bgGradKey !== gradKey) {
        const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.15, W / 2, H / 2, Math.max(W, H) * 0.75);
        g.addColorStop(0, this.theme.bg);
        g.addColorStop(1, mixHex(this.theme.bg, this.theme.text, 0.07));
        this.bgGrad = g;
        this.bgGradKey = gradKey;
      }
      ctx.fillStyle = this.bgGrad;
      ctx.fillRect(0, 0, W, H);

      if (!this.simNodes.length) return;
      ctx.save();
      ctx.translate(this.tx, this.ty);
      ctx.scale(this.k, this.k);

      const hoverId = this.hoverSim ? this.hoverSim.id : null;
      const nb = hoverId ? this.neighborsOf(hoverId) : null;
      const focusId = this.focused;
      const bg = this.theme.bg;

      // ── 边:分两遍画 —— 结构底层(层级/归属/默认链接)先铺,关系边压在上面。
      // 混在一起画时,31 根层级辐条会把关系网切得读不出来。
      const drawEdgePass = (structural) => {
      for (const e of this.simEdges) {
        const isStruct = e.type === HIER_TYPE || e.type === ATTR_TYPE || e.type === PLAIN_TYPE;
        if (isStruct !== structural) continue;
        if (this.hiddenTypes.has(e.type)) continue;
        const meta = REL_META[e.type] || null;      // 只有真关系类型带箭头
        const isRel = !!meta;
        const color = meta ? meta.color
          : e.type === HIER_TYPE ? HIER_COLOR
          : e.type === PLAIN_TYPE ? PLAIN_COLOR : ATTR_COLOR;
        const hot = !hoverId || e.src === hoverId || e.dst === hoverId;
        const isSel = this.selEdge === e;
        const isHot = this.hoverEdge === e;
        // 悬停时:相关边提亮加粗,其余压到几乎看不见(视线的引导全靠这个)
        const baseAlpha = isRel
          ? (hoverId && hot ? EDGE_ALPHA.relHover : EDGE_ALPHA.rel)
          : e.type === HIER_TYPE ? EDGE_ALPHA_HIER
          : e.type === PLAIN_TYPE ? EDGE_ALPHA.plain : EDGE_ALPHA.attr;
        ctx.globalAlpha = isSel ? 0.95 : hot ? baseAlpha : 0.05;
        ctx.strokeStyle = color;
        ctx.lineWidth = isSel ? 3 : isHot ? 2.2
          : isRel ? (hoverId && hot ? EDGE_WIDTH.relHover : EDGE_WIDTH.rel)
          : e.type === HIER_TYPE ? EDGE_WIDTH_HIER
          : e.type === PLAIN_TYPE ? 1.15 : EDGE_WIDTH.other;
        // 默认链接用**长虚线**(5 实 4 空):一眼区别于实线,但不会虚到像噪点
        ctx.setLineDash(e.type === ATTR_TYPE ? [3, 4] : e.type === PLAIN_TYPE ? [5, 4] : []);
        // 端点落在**圆的边缘**而不是圆心:枢纽(索引节点)周围几十根辐条不再于圆心叠成一团,
        // 这是"减少枢纽杂乱"最省事也最有效的一招(Holten & van Wijk 的边捆绑也是为这件事)。
        const edx = e.b.x - e.a.x, edy = e.b.y - e.a.y;
        const ed = Math.max(Math.sqrt(edx * edx + edy * edy), 1);
        const eux = edx / ed, euy = edy / ed;
        const x1 = e.a.x + eux * (e.a.r + 1), y1 = e.a.y + euy * (e.a.r + 1);
        const x2 = e.b.x - eux * (e.b.r + 1), y2 = e.b.y - euy * (e.b.r + 1);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        // 箭头:只给有方向的边、只在线够长画得下时画(太短的边画箭头只会糊在一起)
        if (meta && !meta.symmetric && this.k > 0.5 && ed * this.k > 26) {
          ctx.setLineDash([]);
          ctx.globalAlpha = ctx.globalAlpha * 0.85;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - eux * 4.5 - euy * 2, y2 - euy * 4.5 + eux * 2);
          ctx.lineTo(x2 - eux * 4.5 + euy * 2, y2 - euy * 4.5 - eux * 2);
          ctx.closePath();
          ctx.fill();
        }
      }
      };
      drawEdgePass(true);    // 结构层(淡)
      drawEdgePass(false);   // 关系层(压在上面)
      ctx.setLineDash([]);

      // 编辑模式:连线源高亮 + 到鼠标的预览虚线
      if (this.linkSource) {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(this.linkSource.x, this.linkSource.y, this.linkSource.r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = this.theme.accent;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.8;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(this.linkSource.x, this.linkSource.y);
        ctx.lineTo(this.mouseX, this.mouseY);
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── 节点:填充是**去饱和**的类别色,饱和度只留给"当前关心的那几个" ────
      for (const n of this.simNodes) {
        const isGhost = this.sub && this.sub.ghosts && this.sub.ghosts.has(n.id);
        const isFocus = n.id === focusId, isHover = n.id === hoverId;
        const nearHover = !!nb && nb.has(n.id);
        const lit = !hoverId || nearHover;
        const active = isFocus || isHover || nearHover;     // 提亮的那批
        const unreachable = n.node.resourceOk === false;
        const base = (lit ? 1 : 0.16) * (unreachable ? 0.4 : 1);
        const pure = this.nodeColor(n.node);
        const r = n.r * (isHover ? 1.12 : 1);               // 悬停微微放大:手感反馈
        const ringW = (px, cap = 0.35) => Math.min(px / this.k, n.r * cap);
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        if (this.isIndexNode(n.node)) {
          // 索引/容器节点:描边的"白心"圈(心填底色,连到它的边才不会被看见穿过)。
          // 描边默认统一灰;用户单独配过色的(nodeColors)用那个颜色 —— 树点/图例同源。
          ctx.globalAlpha = base;
          ctx.fillStyle = bg;
          ctx.fill();
          ctx.strokeStyle = pure;
          ctx.lineWidth = ringW(isFocus || isHover ? 6 : 5);
          ctx.stroke();
        } else {
          // 论文节点:默认 = 类别色混背景(柔和);被关心时 = 纯色 + 一圈同色柔光
          ctx.globalAlpha = base * (isGhost ? GHOST_ALPHA : active ? 1 : NODE_ALPHA);
          ctx.fillStyle = isGhost ? mixHex(pure, bg, GHOST_SOFTEN)
            : active ? pure : mixHex(pure, bg, NODE_SOFTEN);
          if (active) { ctx.shadowColor = pure; ctx.shadowBlur = 7; }
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.globalAlpha = base;          // 描边用不透明底色:球边始终清晰,不被半透明带糊
          ctx.strokeStyle = bg;
          ctx.lineWidth = ringW(1.4, 0.18);
          ctx.stroke();
        }
        // 边界节点：内部不纳管，用虚线外圈标记（ENTITY_MODEL §4.2）
        if (n.node.boundary) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 4 / this.k, 0, Math.PI * 2);
          ctx.setLineDash([3 / this.k, 3 / this.k]);
          ctx.strokeStyle = this.theme.faint;
          ctx.globalAlpha = base * 0.8;
          ctx.lineWidth = 1.2 / this.k;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        if (isFocus) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 5, 0, Math.PI * 2);
          ctx.strokeStyle = this.theme.accent;
          ctx.globalAlpha = base * 0.9;
          ctx.lineWidth = Math.min(1.8 / this.k, n.r * 0.22);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      // ── 标签:画在**屏幕坐标**里(缩放时字号不变),按重要性排序后贪心避让 ──
      this.drawLabels(ctx);
    }

    /**
     * 标签层。三条规矩(都是为了让文字不糊在一起):
     *  1. 在屏幕坐标系里画 —— free 画随 zoom 变大变小,读起来很难受;
     *  2. 按优先级排:悬停 > 选中 > 索引节点 > 其它,谁重要谁先占位置;
     *  3. 用 AABB 贪心避让,放不下就不画(那条悬停时再看)—— 这是"遮挡"的正解;
     *  4. 描边用背景色,任何球上都能读清。
     */
    drawLabels(ctx) {
      if (!this.simNodes.length || !this.k) return;
      const hoverId = this.hoverSim ? this.hoverSim.id : null;
      const nb = hoverId ? this.neighborsOf(hoverId) : null;
      const focusId = this.focused;
      const showAll = this.k > 0.72;   // 进到一个方向里就该看得见论文名,门槛别太高
      const items = [];
      for (const n of this.simNodes) {
        const isGhost = this.sub && this.sub.ghosts && this.sub.ghosts.has(n.id);
        const isHover = n.id === hoverId, isFocus = n.id === focusId;
        const nearHover = !!nb && nb.has(n.id);
        if (hoverId && !nearHover) continue;                 // 悬停时只标它这一圈
        if (isGhost && !isHover && !isFocus) continue;        // 幽灵点默认不标
        const isIndex = this.isIndexNode(n.node);
        if (!isHover && !isFocus && !isIndex && !showAll) continue;
        const pri = isHover ? 0 : isFocus ? 1 : isIndex ? 2 : 3;
        items.push({ n, isHover, isFocus, isIndex, pri });
      }
      items.sort((a, b) => a.pri - b.pri || b.n.r - a.n.r);
      const placed = [];
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      let drawn = 0;
      for (const it of items) {
        if (drawn >= 42) break;                               // 上限:再多就必然互相盖(避让会兜住)
        const { n, isHover, isFocus, isIndex } = it;
        const label = truncate(n.node.title || n.node.basename, isIndex ? 28 : 24);
        const font = (isIndex || isHover || isFocus ? "600 " : "") + "11px -apple-system, 'PingFang SC', sans-serif";
        ctx.font = font;
        const wpx = ctx.measureText(label).width;
        const sx = n.x * this.k + this.tx;
        const sy = n.y * this.k + this.ty + (n.r * (isHover ? 1.12 : 1)) * this.k + 6;
        const box = { x: sx - wpx / 2 - 3, y: sy - 2, w: wpx + 6, h: 15 };
        if (!labelFits(box, placed)) continue;
        placed.push(box);
        drawn++;
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = this.theme.bg;
        ctx.globalAlpha = 0.95;
        ctx.strokeText(label, sx, sy);
        ctx.fillStyle = (isHover || isFocus) ? this.theme.text : this.theme.faint;
        ctx.fillText(label, sx, sy);
      }
      ctx.globalAlpha = 1;
      ctx.textBaseline = "alphabetic";
    }
  }

  /** 选择题弹窗:列出候选,回车/点击即选中(Obsidian 的原生属性面板没有下拉类型,用它补) */
  class PickModal extends SuggestModal {
    constructor(app, placeholder, items, onPick) {
      super(app);
      this.items = items;
      this.onPick = onPick;
      this.setPlaceholder(placeholder);
    }
    getSuggestions(query) {
      const q = (query || "").trim().toLowerCase();
      if (!q) return this.items;
      return this.items.filter((i) => i.label.toLowerCase().includes(q));
    }
    renderSuggestion(item, el) { el.setText(item.label); }
    onChooseSuggestion(item) { this.onPick(item.value); }
  }

  /** 查 arXiv API 拿权威元数据(标题/作者/摘要)。失败静默返回 null —— 本地解析兜底。 */
  async function fetchArxivMeta(id) {
    try {
      const res = await requestUrl({
        url: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`,
      });
      if (res.status !== 200) return null;
      const xml = res.text || "";
      const entry = (xml.match(/<entry>([\s\S]*?)<\/entry>/) || [])[1] || "";
      const pick = (tag) => {
        const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`));
        return m ? m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
      };
      const title = pick("title");
      const abstract = pick("summary");
      const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim()).join(", ");
      if (!title && !abstract) return null;
      return { title, authors, abstract };
    } catch (e) {
      return null;
    }
  }

  /** 添加论文:选一个本地 PDF,自动猜年份/slug/标题,填完元数据一键建笔记 + 拷 PDF。
   *  方向默认 `_unfiled`(待归档)—— 先入库,读完再决定挂到哪个方向。
   *  allowNoPdf(欢迎页的新手路径):可以不选 PDF,只建笔记骨架 —— PDF 之后拖进
   *  文件夹再补 frontmatter 的 pdf 字段。 */
  class AddPaperModal extends Modal {
    /** @param directions [{name,label}] —— 已按域分组排好序,第一个是 _unfiled */
    constructor(app, directions, onSubmit, opts = {}) {
      super(app);
      this.directions = directions;
      this.onSubmit = onSubmit;
      this.allowNoPdf = !!opts.allowNoPdf;
      this.file = null;
      this.guess = null;
    }

    onOpen() {
      const { contentEl } = this;
      contentEl.addClass("pnx-add-paper");
      contentEl.createEl("h3").setText("添加论文");
      if (this.allowNoPdf) {
        contentEl.createDiv({ cls: "pnx-form-hint" })
          .setText("第一次建:没有 PDF 也行 —— 先建笔记骨架,PDF 之后拖进论文文件夹再补。");
      }

      // ---- 1. 选 PDF ----
      const pickRow = contentEl.createDiv({ cls: "pnx-form-row" });
      pickRow.createSpan({ cls: "pnx-form-key" }).setText("PDF");
      const fileInput = pickRow.createEl("input", { type: "file", attr: { accept: ".pdf,application/pdf" } });
      fileInput.addClass("pnx-form-file");
      const fileInfo = pickRow.createDiv({ cls: "pnx-form-hint" }).setText("选一个本地 PDF,会自动拷进论文文件夹");
      if (this.allowNoPdf) {
        const skip = pickRow.createEl("a", { cls: "pnx-form-skip" });
        skip.setText("先不选 PDF,只建骨架");
        skip.addEventListener("click", (e) => {
          e.preventDefault();
          this.file = null;
          fileInput.value = "";
          fileInfo.setText("已选择:无 PDF(创建后把 PDF 拖进文件夹,文件名填进 pdf 字段)");
        });
      }

      // ---- 2. 元数据 ----
      const fields = {};
      const addField = (key, label, placeholder) => {
        const row = contentEl.createDiv({ cls: "pnx-form-row" });
        row.createSpan({ cls: "pnx-form-key" }).setText(label);
        const input = row.createEl("input", { type: "text", cls: "pnx-form-input" });
        input.placeholder = placeholder;
        fields[key] = input;
        return input;
      };

      const dirRow = contentEl.createDiv({ cls: "pnx-form-row" });
      dirRow.createSpan({ cls: "pnx-form-key" }).setText("方向");
      const dirSelect = dirRow.createEl("select", { cls: "pnx-form-input" });
      for (const d of this.directions) {
        const opt = dirSelect.createEl("option", { attr: { value: d.name } });
        opt.setText(d.label);
      }
      dirSelect.value = this.directions[0] ? this.directions[0].name : "_unfiled";

      addField("year", "年份", String(new Date().getFullYear()));
      addField("slug", "slug", "英文机器 id(kebab-case),决定文件夹名");
      addField("title", "标题", "英文原题");
      addField("tags", "标签", "逗号分隔,如 semantic-id, codebook");
      addField("authors", "作者", "逗号分隔(可选)");
      const summaryEl = contentEl.createEl("textarea", { cls: "pnx-form-input pnx-form-textarea" });
      summaryEl.placeholder = "一句话:这篇在解什么问题 + 用什么关键机制(可后补)";
      const summaryRow = contentEl.createDiv({ cls: "pnx-form-row" });
      summaryRow.createSpan({ cls: "pnx-form-key" }).setText("简介");
      summaryRow.appendChild(summaryEl);
      fields.summary = summaryEl;

      // ---- 3. 选文件后自动填 ----
      fileInput.addEventListener("change", async () => {
        this.file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        if (!this.file) return;
        this.guess = guessFromPdf(this.file.name);
        const size = `${(this.file.size / 1024 / 1024).toFixed(1)} MB`;
        fileInfo.setText(`${this.file.name} · ${size} · 读取中…`);
        fields.year.value = this.guess.year;           // 文件名里的年份最可信
        fields.slug.value = this.guess.slug;
        if (!fields.title.value.trim()) fields.title.value = this.guess.title;

        // 解析 PDF:先读自带元数据 / 正文,有 arXiv 编号再查权威元数据
        try {
          const buf = await this.file.arrayBuffer();
          this.buf = buf;
          const info = extractPaperInfo(buf);
          this.info = info;
          if (info.title && info.title.length > 6) fields.title.value = info.title;
          if (info.authors) fields.authors.value = info.authors;
          if (info.abstract) fields.summary.value = info.abstract.slice(0, 300);
          const got = [info.title && "标题", info.authors && "作者", info.abstract && "摘要"].filter(Boolean);
          fileInfo.setText(`${this.file.name} · ${size} · 已读到:${got.join(" / ") || "无(可能是扫描版)"}`);
          if (info.arxivId) {
            fileInfo.setText(fileInfo.textContent + ` · arXiv:${info.arxivId} 查询中…`);
            const ax = await fetchArxivMeta(info.arxivId);
            if (ax) {
              if (ax.title) fields.title.value = ax.title;
              if (ax.authors) fields.authors.value = ax.authors;
              if (ax.abstract) fields.summary.value = ax.abstract.slice(0, 400);
              this.info = Object.assign({}, info, ax);
              fileInfo.setText(`${this.file.name} · ${size} · arXiv:${info.arxivId} 已取到权威元数据`);
            } else {
              fileInfo.setText(`${this.file.name} · ${size} · arXiv 查询失败,用本地解析结果`);
            }
          }
        } catch (err) {
          fileInfo.setText(`${this.file.name} · ${size} · 解析失败:${err.message}(可手动填)`);
        }
      });

      // ---- 4. 提交 ----
      const err = contentEl.createDiv({ cls: "pnx-form-error" });
      const row = contentEl.createDiv({ cls: "pnx-form-actions" });
      const ok = row.createEl("button", { cls: "mod-cta" });
      ok.setText("创建");
      ok.addEventListener("click", () => {
        const slug = fields.slug.value.trim().toLowerCase()
          .replace(/\s+/g, "-").replace(/[\\/:*?"<>|#^[\]]/g, "-");
        const year = fields.year.value.trim();
        if (!/^\d{4}$/.test(year)) { err.setText("年份要 4 位数字,如 2026"); return; }
        if (!slug) { err.setText("slug 不能为空"); return; }
        if (!this.file && !this.allowNoPdf) { err.setText("请先选一个 PDF"); return; }
        this.close();
        this.onSubmit({
          file: this.file,
          dirName: dirSelect.value,
          year,
          slug,
          title: fields.title.value.trim() || slug,
          tags: fields.tags.value.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean),
          authors: fields.authors.value.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean),
          summary: fields.summary.value.trim(),
          abstract: this.info && this.info.abstract ? this.info.abstract : "",
        });
      });
      const cancel = row.createEl("button");
      cancel.setText("取消");
      cancel.addEventListener("click", () => this.close());

      window.setTimeout(() => fileInput.focus(), 50);
    }

    onClose() { this.contentEl.empty(); }
  }

  /** 单行文本输入弹窗(新建方向、新建论文都要一个名字)。回车 = 确认。 */
  class PromptModal extends Modal {
    constructor(app, title, placeholder, initial, onSubmit) {
      super(app);
      this.title = title;
      this.placeholder = placeholder;
      this.initial = initial || "";
      this.onSubmit = onSubmit;
    }
    onOpen() {
      this.contentEl.createEl("h3").setText(this.title);
      const input = this.contentEl.createEl("input", { type: "text", cls: "pnx-prompt-input" });
      input.placeholder = this.placeholder;
      input.value = this.initial;
      const submit = () => {
        const v = input.value.trim();
        if (!v) return;
        this.close();
        this.onSubmit(v);
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
      const row = this.contentEl.createDiv({ cls: "pnx-prompt-row" });
      const ok = row.createEl("button", { cls: "mod-cta" });
      ok.setText("创建");
      ok.addEventListener("click", submit);
      const cancel = row.createEl("button");
      cancel.setText("取消");
      cancel.addEventListener("click", () => this.close());
      window.setTimeout(() => { input.focus(); input.select(); }, 50);
    }
    onClose() { this.contentEl.empty(); }
  }

  class ExplorerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
      super(app, plugin);
      this.plugin = plugin;
    }
    display() {
      const { containerEl } = this;
      containerEl.empty();
      containerEl.createEl("h3").setText("Pinakes");
      new Setting(containerEl)
        .setName("根笔记")
        .setDesc("层级树的起点(vault 内相对路径)")
        .addText((t) => t.setValue(this.plugin.settings.rootNote).onChange(async (v) => {
          this.plugin.settings.rootNote = v.trim() || DEFAULT_SETTINGS.rootNote;
          await this.plugin.saveData(this.plugin.settings);
        }));
    new Setting(containerEl)
        .setName("欢迎与功能介绍")
        .setDesc("功能总览 + 三步上手 + 新建第一篇论文")
        .addButton((b) => {
          b.setText("显示欢迎页");
          b.onClick(() => this.plugin.showWelcome());
        });
    }
  }

  class ExplorerPlugin extends Plugin {
    async onload() {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
      this.addSettingTab(new ExplorerSettingTab(this.app, this));
      this.registerView(VIEW_TYPE, (leaf) => new ExplorerView(leaf, this));
      this.addRibbonIcon("network", "Pinakes 关系图谱", () => this.activateView());
      // 欢迎页:还没看过欢迎(新装/新库)时,等索引建好自动弹一次。
      // 1.2s 让 onOpen → reindex 走完;空库自举若建了骨架,欢迎语会是「开始搭建」口径。
      if (!this.settings.welcomed) {
        this.app.workspace.onLayoutReady(() => {
          window.setTimeout(() => {
            if (this.settings.welcomed) return;      // 弹窗前用户自己开过就不打扰
            const fresh = this.app.vault.getMarkdownFiles().length <= 5;
            this.showWelcome({ isFresh: fresh });
          }, 1200);
        });
      }
      this.addCommand({ id: "open-explorer", name: "打开关系图谱资源管理器", callback: () => this.activateView() });
      this.addCommand({
        id: "check-resources",
        name: "检查资源可达性（locator）",
        callback: async () => {
          await this.activateView();
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
          const view = leaves.length ? leaves[0].view : null;
          if (view && view.showUnreachable) view.showUnreachable();
        },
      });
      this.addCommand({
        id: "describe-schema",
        name: "描述库结构（describe --json）",
        callback: async () => {
          await this.activateView();
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
          const view = leaves.length ? leaves[0].view : null;
          if (view && view.showDescribe) view.showDescribe();
        },
      });
      this.addCommand({
        id: "add-paper",
        name: "添加论文(选 PDF 并生成笔记模板)",
        callback: async () => {
          await this.activateView();
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
          const view = leaves.length ? leaves[0].view : null;
          if (view && view.openAddPaper) view.openAddPaper();
        },
      });
      // 欢迎与功能介绍:首次运行自动弹,之后从这里手动打开
      this.addCommand({
        id: "open-welcome",
        name: "欢迎与功能介绍",
        callback: () => this.showWelcome(),
      });
      // 笔记侧的"选择题":属性面板只能打字,这里给真正的候选列表(对当前打开的笔记生效)。
      // 轴按 schema 的 status_field 自动切换:论文出「阅读状态」,想法出「阶段」——
      // 命令名保持通用,弹窗标题跟着轴走。
      this.addCommand({
        id: "set-reading",
        name: "设置当前笔记的状态(阅读/阶段,按 kind 自动切换)",
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== "md") return false;
          if (!checking) {
            const kind = kindOfPath(this.schema || DEFAULT_SCHEMA, file.path);
            const axisField = statusFieldOf(this.schema || DEFAULT_SCHEMA, kind);
            if (axisField === STAGE_FIELD) {
              new PickModal(this.app, "阶段…",
                IDEA_STAGES.map((s) => ({ label: s.label, value: s.key })),
                (value) => this.setNoteField(file, STAGE_FIELD, value)).open();
            } else {
              new PickModal(this.app, "阅读状态…",
                this.readingOptions(), (value) => this.setNoteField(file, "reading", value)).open();
            }
          }
          return true;
        },
      });
      this.addCommand({
        id: "set-importance",
        name: "设置当前笔记的重要性(1–5)",
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== "md") return false;
          if (!checking) {
            const items = [];
            for (let i = IMPORTANCE_MIN; i <= IMPORTANCE_MAX; i++) items.push({ label: `${i} — ${"●".repeat(i)}`, value: i });
            new PickModal(this.app, "重要性…", items, (value) => this.setNoteField(file, "importance", value)).open();
          }
          return true;
        },
      });
    }

    /** 阅读状态候选:内置四档 + 用户自定义 */
    readingOptions() {
      const items = READING_DEFAULTS.map((s) => ({ label: s.label, value: s.key }));
      for (const s of this.settings.readingStates || []) {
        if (s && s.key && !items.some((i) => i.value === s.key)) items.push({ label: s.label || s.key, value: s.key });
      }
      return items;
    }

    /** 写当前笔记的状态字段(视图没开也能用;视图那边靠 vault 事件自动同步) */
    async setNoteField(file, field, value) {
      try {
        await this.app.vault.process(file, (text) => patchScalarField(text, field, value));
        new Notice(`${file.basename}:${field === "importance" ? "重要性 = " + value : "阅读状态 = " + value}`);
        // 视图开着的话,为了让按钮态/图例立刻正确,主动触发一次同步
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
          const view = leaf.view;
          if (view && typeof view.reindexAndRender === "function") view.reindexAndRender();
        }
      } catch (err) {
        new Notice("写入失败:" + err.message);
      }
    }

    async activateView() {
      const { workspace } = this.app;
      const existing = workspace.getLeavesOfType(VIEW_TYPE);
      if (existing.length) {
        workspace.revealLeaf(existing[0]);
        return;
      }
      const leaf = workspace.getLeaf("split");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      workspace.revealLeaf(leaf);
    }

    /** 欢迎与功能介绍:首次运行(或库还是空的)自动弹一次;命令面板/设置里可再打开。
     *  主按钮直接进「新建第一篇论文」流程 —— 类 notion 的 onboarding:
     *  欢迎 → 建第一篇 → 图谱里看到它,一个闭环。 */
    showWelcome(opts = {}) {
      const modal = new WelcomeModal(this.app, {
        // 首次关闭后落 welcomed=true;手动打开不重复弹
        onDone: () => {
          if (!this.settings.welcomed) {
            this.settings.welcomed = true;
            this.saveData(this.settings);
          }
        },
        onFirstPaper: () => {
          this.activateView().then(() => {
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
            const view = leaves.length ? leaves[0].view : null;
            if (view && view.openAddPaper) view.openAddPaper({ allowNoPdf: true });
          });
        },
        isFresh: opts.isFresh,
      });
      modal.open();
    }
  }

  /** 欢迎页(纯 DOM,风格与详情卡/菜单同一套变量)。功能介绍 + 三步上手 + 主行动按钮。 */
  class WelcomeModal extends Modal {
    constructor(app, { onDone, onFirstPaper, isFresh }) {
      super(app);
      this.onDone = onDone;
      this.onFirstPaper = onFirstPaper;
      this.isFresh = !!isFresh;   // 空库/刚自举:标题说「开始搭建你的库」而不是「欢迎回来」
    }
    onOpen() {
      const { contentEl } = this;
      contentEl.addClass("pnx-welcome");
      contentEl.createEl("h2").setText(this.isFresh ? "欢迎使用 Pinakes" : "Pinakes");

      // setText 不渲染 markdown:** 会原样显示 —— 粗体用 DOM 元素实现
      const lead = contentEl.createDiv({ cls: "pnx-welcome-lead" });
      lead.appendText("一个");
      lead.createEl("b").setText("人读得懂、AI 也管得动");
      lead.appendText(
        "的论文知识库:笔记是唯一入口,每篇论文一个文件夹" +
        "(笔记 + PDF 同处一处),层级与关系全部写在 frontmatter 里 —— 图谱、看板、索引都从它派生。");

      const feats = contentEl.createDiv({ cls: "pnx-welcome-feats" });
      const feat = (icon, title, desc) => {
        const row = feats.createDiv({ cls: "pnx-welcome-feat" });
        setIcon(row.createDiv({ cls: "pnx-welcome-icon" }), icon);
        const body = row.createDiv();
        body.createEl("b").setText(title);
        body.createDiv({ cls: "pnx-welcome-desc" }).setText(desc);
      };
      feat("network", "关系图谱",
        "左树右图:点谁谁是中心;编辑模式在图上直接连线(extends / uses / competes / contradicts),写回 frontmatter。");
      feat("file-plus", "添加论文",
        "选一个本地 PDF,自动拷进库并读出标题 / 作者 / 摘要(PDF 元数据 → 正文 → arXiv 三层兜底);没有 PDF 也能先建骨架。");
      feat("layout-list", "动态看板",
        "全部论文 / 阅读队列 / 待补元数据(Dataview 渲染,改 frontmatter 实时更新)。");
      feat("terminal", "搭配 AI 使用(推荐)",
        "Codex / Claude Code 等 agent 读 AGENTS.md 规范 + describe --json 契约,即可按 SOP 建笔记、填字段、跑校验 —— 人和 AI 读写同一套 frontmatter,两边都方便。");

      const steps = contentEl.createDiv({ cls: "pnx-welcome-steps" });
      steps.createEl("b").setText("三步上手");
      const ol = steps.createEl("ol");
      ol.createEl("li").setText("点下面的「新建第一篇论文」(选 PDF 或先跳过)—— 新论文会落在「待归档」分区");
      ol.createEl("li").setText("在详情卡里点选阅读状态、重要度、标签,点「进入」在图里看它");
      ol.createEl("li").setText("想分类时,把树里的论文行拖到某个方向索引上(或右键新建方向)");
      steps.createDiv({ cls: "pnx-welcome-hint" }).setText(
        "提示:这个库最好搭配 Codex / Claude Code 等 AI agent 使用 —— 规范已写在 AGENTS.md,读 PDF、写笔记、跑校验都可以交给它。");

      const acts = contentEl.createDiv({ cls: "pnx-welcome-acts" });
      const primary = acts.createEl("button", { cls: "mod-cta" });
      primary.setText("新建第一篇论文");
      primary.addEventListener("click", () => {
        this.close();
        if (this.onFirstPaper) this.onFirstPaper();
      });
      const later = acts.createEl("button");
      later.setText("以后再说");
      later.addEventListener("click", () => this.close());
    }
    onClose() {
      this.contentEl.empty();
      if (this.onDone) this.onDone();
    }
  }

  return ExplorerPlugin;
}

/* ======================= 导出 ======================= */

// Obsidian 环境导出插件类;node 测试环境导出纯数据层
if (obsidian) {
  module.exports = createPlugin(obsidian);
} else if (typeof module !== "undefined") {
  module.exports = {
    REL_KEYS, REL_META, INVERSE_LABEL, HIER_TYPE, ATTR_TYPE, HIER_COLOR, ATTR_COLOR,
    SKIP_DIRS, SKIP_FILES, REP_RE, FALLBACK_PALETTE, SCAFFOLD_PALETTE, COLOR_MIN_DISTANCE,
    READING_DEFAULTS, IDEA_STAGES, STAGE_FIELD, CHIP_PALETTE, IMPORTANCE_MIN, IMPORTANCE_MAX,
    radiusForImportance, radiusForIndex, mixHex, parseColor, labelFits, layoutNodes,
    colorDistance, pickGraphColor, guessFromPdf, yamlValue, buildPaperNote,
    decodePdfString, parsePaperText, readPdfMetaStrings, extractPaperInfo,
    patchTags, readTags, parseInlineList,
    parseFrontmatter, extractWikilinks, patchRelation, readRelation, patchScalarField, bodyNoteLinks,
    buildWikiIndex, computeSubGraph, buildIndexSection, sectionNoteLinks,
    DEFAULT_SCHEMA, kindOfPath, sectionsForKind, statusFieldOf, rootDirOf, rootDirsOf, adapters,
    splitFrontmatter, groupFields,
    posixDirname, baseName, dirOf, rgbIntToHex, truncate,
  };
}
