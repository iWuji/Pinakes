@echo off
rem Pinakes 图形化安装(Windows 双击版)
rem 支持:仓库根目录(template\)或 Releases 包解压后的目录(payload\template)。
rem 没装 Obsidian?先去 https://obsidian.md 下载(免费)。
setlocal enabledelayedexpansion

cd /d "%~dp0"
if exist payload\template (
  set "SRC=payload\template"
) else if exist template (
  set "SRC=template"
) else (
  echo ❌ 没找到库模板 ^(payload\template 或 template^)。
  echo    请完整解压 Pinakes-Installer.zip 后再双击本文件。
  pause
  exit /b 1
)

set "DEFAULT_DEST=%USERPROFILE%\Pinakes"
echo ==================================================
echo   Pinakes 安装器 - 论文知识库 ^(Obsidian + AI^)
echo ==================================================
echo.
set "DEST="
set /p DEST=装到哪里? [%DEFAULT_DEST%]
if "%DEST%"=="" set "DEST=%DEFAULT_DEST%"

if exist "%DEST%" (
  echo.
  echo ⚠️  %DEST% 已经存在。
  set /p ans=   覆盖安装(o^)/取消(q^)? [o/q]
  if /i not "%ans%"=="o" (
    echo 已取消。
    pause
    exit /b 0
  )
  rmdir /s /q "%DEST%"
)

echo.
echo ① 复制库文件…
mkdir "%DEST%" 2>nul
xcopy /e /i /q "%SRC%" "%DEST%" >nul
echo    ✓ %DEST%

echo ② 唤起 Obsidian…
start "" "obsidian://open?path=%DEST:\=/%"

echo.
echo ==================================================
echo ✅ 完成!在 Obsidian 弹出的对话框里点「Trust author and enable plugins」。
echo    首次启动会出现欢迎页;点「新建第一篇论文」开始。
echo    可选:装 Python 工具链 → pip install pyyaml
echo ==================================================
pause
