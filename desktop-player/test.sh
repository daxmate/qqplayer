#!/bin/bash
# 词典事件 JS 构造的轻量测试（不引入 XCTest）
# 编译 dict_events.swift + 测试 → 运行；全部通过 exit 0
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
swiftc dict_events.swift tests/test_dict_events.swift -o build/test_dict_events
./build/test_dict_events
