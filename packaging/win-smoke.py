#!/usr/bin/env python3
"""Windows 打包产物冒烟测试：启动打包后的可执行文件，轮询 /api/settings 验证服务可用。

用法（打包完成后）:
    python packaging/win-smoke.py

平台判定:
    - win32: packaging/dist/qqplayer-backend/qqplayer-backend.exe
    - 其他 (macOS 本地验证): packaging/dist/qqplayer-backend/qqplayer-backend

隔离:
    - 注入 QQPLAYER_PORT=17629（避开默认端口，防止与本机实例冲突）
    - 注入 QQPLAYER_DATA_DIR=临时目录（不污染真实用户数据）

退出码: 0 冒烟通过；1 启动失败/接口异常/超时（打印子进程 stdout/stderr 尾部）。
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

SMOKE_PORT = 17629
SMOKE_URL = f"http://127.0.0.1:{SMOKE_PORT}/api/settings"
POLL_TIMEOUT_SECONDS = 20
POLL_INTERVAL_SECONDS = 0.5
TAIL_LINES = 15


def exe_name() -> str:
    """按平台返回打包产物可执行文件名（不硬编码路径分隔符）"""
    return "qqplayer-backend.exe" if sys.platform == "win32" else "qqplayer-backend"


def _tail(text: str, lines: int = TAIL_LINES) -> str:
    return "\n".join(text.splitlines()[-lines:])


def _print_tail(prefix: str, data: bytes | None) -> None:
    if data:
        print(f"--- {prefix} 尾部 ---", file=sys.stderr)
        print(_tail(data.decode(errors="replace")), file=sys.stderr)


def main() -> int:
    exe = Path(__file__).resolve().parent / "dist" / "qqplayer-backend" / exe_name()
    if not exe.is_file():
        print(f"✗ 未找到打包产物: {exe}", file=sys.stderr)
        return 1

    env = dict(os.environ)
    env["QQPLAYER_PORT"] = str(SMOKE_PORT)
    env["QQPLAYER_DATA_DIR"] = tempfile.mkdtemp(prefix="qqp-smoke-")

    proc = subprocess.Popen(
        [str(exe)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + POLL_TIMEOUT_SECONDS
        last_error = None
        while time.monotonic() < deadline:
            # 进程提前退出 → 打包产物启动失败
            if proc.poll() is not None:
                try:
                    out, err = proc.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    out, err = proc.communicate()
                print(f"✗ 进程提前退出（exit={proc.returncode}）", file=sys.stderr)
                _print_tail("stdout", out)
                _print_tail("stderr", err)
                return 1
            try:
                with urllib.request.urlopen(SMOKE_URL, timeout=2) as resp:
                    if resp.status != 200:
                        last_error = f"HTTP {resp.status}"
                        continue
                    body = resp.read()
                    try:
                        json.loads(body)
                    except ValueError as e:
                        # 200 但非 JSON：端点已起但响应异常，直接失败
                        print(f"✗ {SMOKE_URL} 返回 200 但非 JSON: {e}", file=sys.stderr)
                        return 1
                    print(f"✅ 冒烟通过: {SMOKE_URL} → HTTP {resp.status}")
                    return 0
            except urllib.error.URLError as e:
                last_error = e  # 服务未就绪（连接拒绝等），继续轮询
            except (TimeoutError, ConnectionError) as e:
                last_error = e
            time.sleep(POLL_INTERVAL_SECONDS)

        print(
            f"✗ 冒烟超时（{POLL_TIMEOUT_SECONDS}s），最后错误: {last_error!r}",
            file=sys.stderr,
        )
        proc.terminate()
        try:
            out, err = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, err = proc.communicate()
        _print_tail("stdout", out)
        _print_tail("stderr", err)
        return 1
    finally:
        # 兜底清理：无论成功/失败都确保子进程终止（kill 兜底）
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            if sys.platform == "win32":
                # PyInstaller onedir 顶层 exe 是 bootloader，实际服务在子进程；
                # TerminateProcess 只杀父进程，taskkill /T 递归清理整棵进程树
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                    capture_output=True,
                    check=False,  # 进程已死时 taskkill 报错无害，忽略
                )


if __name__ == "__main__":
    sys.exit(main())
