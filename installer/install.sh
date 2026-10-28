#!/usr/bin/env bash
# Pinakes 安装器(命令行版;图形化请双击 install.command / install.bat)
# 用法: ./install.sh [目标目录]   (默认 ~/Pinakes)
set -euo pipefail
cd "$(dirname "$0")"

if [ -d payload/template ]; then SRC="payload/template";
elif [ -d template ]; then SRC="template";
else
  echo "❌ 没找到库模板(payload/template 或 template)。请完整解压安装包。" >&2; exit 1
fi

DEST="${1:-$HOME/Pinakes}"
DEST="${DEST/#\~/$HOME}"

if [ -e "$DEST" ]; then
  echo "⚠️  $DEST 已存在;要覆盖请先删除,或传别的目录。" >&2; exit 1
fi

mkdir -p "$DEST"
cp -R "$SRC/" "$DEST/"
echo "✓ 已安装到 $DEST"

# 有图形环境就顺手唤起 Obsidian(macOS / Linux xdg-open)
if command -v open >/dev/null 2>&1; then
  open "obsidian://open?path=$DEST"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "obsidian://open?path=$DEST" || true
fi
echo "✅ 用 Obsidian 打开后,点「Trust author and enable plugins」即可。可选:python3 -m pip install pyyaml"
