"""ASR 转写服务（占位）。

本轮不实现，方案未定 —— 引擎候选：omlx/Qwen3-ASR 管线 或 faster-whisper 本地跑
（M 芯片可离线转写），等大象方案完整再接入。转写结果缓存
（~/.cache/qqplayer/subtitle/，按视频路径隔离，对齐歌词缓存结构）届时一并实现。
"""


async def transcribe(media_path: str, language: str | None = None) -> list[dict]:
    """转写本地媒体（视频/音频）音轨为带时间戳字幕。

    输入：
        media_path: 本地媒体文件绝对路径（ASR 管线用 ffmpeg 抽音轨 → wav/mp3）
        language:   可选语言提示（如 "zh"、"ja"）；None = 自动检测
    输出：
        [{start: float, end: float, text: str, translation: str | None}, ...]
        按 start 升序；translation 仅在字幕来源明确含翻译时填充，否则 None。

    本轮不实现（方案未定：omlx/Qwen3-ASR vs faster-whisper，拍板后接入）。
    """
    pass  # 本轮不实现，方案未定
