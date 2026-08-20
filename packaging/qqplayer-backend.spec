# -*- mode: python ; coding: utf-8 -*-
"""QQPlayer 后端 PyInstaller onedir 打包 spec（DMG 分发用）。

产物：packaging/dist/qqplayer-backend/（可执行文件 + _internal/ 依赖目录）

资源定位约定（frozen 模式）：
- 前端构建产物（仓库根 dist/）以 datas 打进包 → 运行时位于 sys._MEIPASS/dist；
  backend/app/state.py 在 frozen 时 ROOT = Path(sys._MEIPASS)，StaticFiles 挂载 _MEIPASS/dist。
- 运行时环境变量覆盖：QQPLAYER_PORT（端口，默认 17627）、QQPLAYER_DATA_DIR（用户数据
  目录）——解析逻辑在 backend/app/state.py，开发模式（非 frozen）行为不变。

用法（从 worktree 根执行；一键脚本见 packaging/build-backend.sh）：
  /Users/dax/codes/qqplayer/backend/venv/bin/python -m PyInstaller \
      --noconfirm --clean --distpath packaging/dist --workpath packaging/build \
      packaging/qqplayer-backend.spec
"""

import os

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# worktree 根（本 spec 位于 packaging/ 下，SPECPATH 即 spec 所在目录）
ROOT = os.path.dirname(os.path.abspath(SPECPATH))

# ---- 数据文件 ----
# 前端构建产物 → _MEIPASS/dist（frozen 时 state.ROOT/_MEIPASS 下挂载）
datas = [(os.path.join(ROOT, "dist"), "dist")]
# yt-dlp：浏览器 UA 指纹等非 py 资源（自带 __pyinstaller hook 之外显式兜底；
# 排除其 __pyinstaller 目录本身，避免把 hook 源文件当数据打进包）
datas += collect_data_files("yt_dlp", excludes=["__pyinstaller"])
# pykakasi：假名/汉字转换字典（data/ 约 9MB，歌词对齐脚本运行时需要）
datas += collect_data_files("pykakasi")

hiddenimports = []

# uvicorn：loops/protocols/logging 动态加载（uvicorn.logging、uvicorn.loops.auto、
# uvicorn.protocols.http.auto / websockets.auto 等；stdhooks hook-uvicorn 之外显式收集）
hiddenimports += collect_submodules("uvicorn")
# watchdog：observers 平台分发（fsevents/inotify/polling），曲库变动监听必需
hiddenimports += collect_submodules("watchdog")
# mutagen：格式注册表动态发现（File() 按扩展名试各格式模块：mp4/flac/id3/oggopus/oggvorbis...）
hiddenimports += collect_submodules("mutagen")
# httpx：传输层子模块（_transports/_urlparse 等）
hiddenimports += collect_submodules("httpx")
# fastapi：routing/middleware/security 等子模块
hiddenimports += collect_submodules("fastapi")
# python-multipart：starlette 表单解析延迟 import（python_multipart 包 + 旧 multipart 别名）
hiddenimports += collect_submodules("python_multipart")
hiddenimports += collect_submodules("multipart")
# qrcode：image factory 动态加载（qrcode.image.pil，依赖 pillow）；排除自带 tests 子包
hiddenimports += collect_submodules(
    "qrcode", filter=lambda name: not name.startswith("qrcode.tests")
)
# send2trash：平台分发（darwin → send2trash.mac，ctypes 调 CoreServices）
hiddenimports += collect_submodules("send2trash")
# pykakasi：子模块 + 数据（kakasi/legacy/scripts）
hiddenimports += collect_submodules("pykakasi")
# yt_dlp：extractor/postprocessor/downloader 全量子模块（~2000 模块，惰性加载）
hiddenimports += collect_submodules("yt_dlp")
# curl_cffi：CFFI 绑定（curl_cffi.curl / curl_cffi.requests / curl_cffi._wrapper abi3 .so）
hiddenimports += collect_submodules("curl_cffi")
# pycryptodome：Crypto.Cipher.AES（netease_provider 用；stdhooks hook-Crypto 自动收
# C 扩展二进制，这里补 Python 子模块；SelfTest 是自带测试套件，import 即跑测试，排除）
hiddenimports += collect_submodules(
    "Crypto", filter=lambda name: not name.startswith("Crypto.SelfTest")
)
# readmdict / python-lzo：词典解析（MDX/MDD 解压 record block 直接用 lzo）
hiddenimports += collect_submodules("readmdict")
hiddenimports += ["lzo"]
# pillow：qrcode.image.pil → PIL.Image；内置 hook-PIL.Image 自动收集 *ImagePlugin 全家桶
hiddenimports += ["PIL.Image"]

a = Analysis(
    [os.path.join(ROOT, "backend", "backend.py")],
    pathex=[os.path.join(ROOT, "backend")],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 排除测试框架及其连带：anyio.pytest_plugin 会把整个 pytest 拖进图
    # （httpx._main 的 CLI 高亮依赖 pygments，一并排除；运行时均不会被 app import）
    excludes=[
        "anyio.pytest_plugin",
        "pytest",
        "_pytest",
        "pluggy",
        "iniconfig",
        "pygments",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="qqplayer-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="qqplayer-backend",
)
