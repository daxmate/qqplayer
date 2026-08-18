"""测试路径引导：迁移后 backend/ 为后端根目录，tests 依赖顶层模块
（backend.py 薄兼容层 / 各 provider）在任意收集顺序下都可解析。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
