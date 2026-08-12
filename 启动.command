#!/bin/bash
# 🎵 music-player 一键启动（默认打开 iCloud 歌曲库）
cd "$(dirname "$0")"
LIB="/Users/dax/Library/Mobile Documents/iCloud~dev~clq~Cosmos-Music-Player/Documents"
echo "🎵 启动 music-player..."
echo "   歌曲库: $LIB"
./venv/bin/python backend.py "$LIB"
