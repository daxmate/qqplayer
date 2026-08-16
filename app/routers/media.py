"""媒体路由：内嵌封面提取 / 音频流（支持 Range）。"""

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

try:
    from mutagen import File as MutagenFile
    from mutagen.mp4 import MP4, MP4Cover
except ImportError:
    MutagenFile = None
    MP4 = None
    MP4Cover = None

router = APIRouter()


@router.get("/api/cover")
def api_cover(path: str):
    """提取音频内嵌封面；无内嵌封面时返回文件夹 cover.jpg"""
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    # 1) 文件夹封面图片
    for cname in ("cover.jpg", "cover.png", "folder.jpg", "front.jpg"):
        cand = f.parent / cname
        if cand.exists():
            return FileResponse(cand)
    # 2) 内嵌封面
    if MutagenFile is not None:
        try:
            audio = MutagenFile(str(f))
            if audio is not None:
                # MP3: ID3 APIC
                tags = getattr(audio, "tags", None)
                if tags is not None:
                    for key in tags:
                        if key.startswith("APIC"):
                            apic = tags[key]
                            return Response(content=apic.data, media_type=apic.mime)
                # MP4: covr
                if isinstance(audio, MP4) and "covr" in audio:
                    cov = audio["covr"][0]
                    data = bytes(cov)
                    mime = (
                        "image/jpeg"
                        if isinstance(cov, MP4Cover) and cov.imageformat == MP4Cover.FORMAT_JPEG
                        else "image/png"
                    )
                    return Response(content=data, media_type=mime)
        except Exception:
            pass
    raise HTTPException(404, "无封面")


@router.get("/api/audio")
def api_audio(path: str):
    """音频流播放（FileResponse 原生支持 Range/206）"""
    f = Path(path)
    if not f.exists():
        raise HTTPException(404, "文件不存在")
    return FileResponse(str(f), media_type="audio/mpeg")
