#!/usr/bin/env bash
# Pinakes 图形化安装(macOS 双击版)—— 双击我,按提示走三步:
#   1) 选安装位置(默认 ~/Pinakes,可直接回车)
#   2) 把库(含全部插件与配置)复制过去
#   3) 自动唤起 Obsidian 打开 —— 点一次「Trust author and enable plugins」就能用
#
# 支持两种来源:本目录(用 template/),或 GitHub Releases 下载的
# Pinakes-Installer.zip 解压后的目录(用 payload/,脚本自带)。
# 没装 Obsidian?先去 https://obsidian.md 下载(免费)。
# Windows 用户请双击 install.bat;命令行可用 install.sh。

set -euo pipefail
cd "$(dirname "$0")"

# 库模板:优先 payload/(Release 包自带),退回 template/(仓库根)
if [ -d payload/template ]; then SRC="payload/template";
elif [ -d template ]; then SRC="template";
else
  echo "❌ 没找到库模板(payload/template 或 template)。"
  echo "   请完整解压 Pinakes-Installer.zip 后再双击本文件。"
  exit 1
fi

DEFAULT_DEST="$HOME/Pinakes"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Pinakes 安装器 — 论文知识库 (Obsidian + AI)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "装到哪里?[$DEFAULT_DEST]"
read -r DEST
DEST="${DEST:-$DEFAULT_DEST}"
DEST="${DEST/#\~/$HOME}"

if [ -e "$DEST" ]; then
  echo ""
  echo "⚠️  $DEST 已经存在。"
  printf   "   覆盖安装(o)/取消(q)? [o/q] "
  read -r ans
  case "$ans" in
    q|Q) echo "已取消。"; exit 0 ;;
  esac
  rm -rf "$DEST"
fi

echo ""
echo "① 复制库文件…"
mkdir -p "$DEST"
cp -R "$SRC/" "$DEST/"
echo "   ✓ $DEST"

echo "② 唤起 Obsidian…"
open "obsidian://open?path=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$DEST")"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 完成!在 Obsidian 弹出的对话框里点「Trust author and enable plugins」。"
echo "   首次启动会出现欢迎页;点「新建第一篇论文」开始。"
echo "   可选:装 Python 工具链 → python3 -m pip install pyyaml"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
