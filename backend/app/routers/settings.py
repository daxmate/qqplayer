"""设置路由：/api/settings、/api/ui/settings、/api/desktop-lyric/settings（GET/PUT）。"""

from fastapi import APIRouter

from app.services import settings as settings_service

router = APIRouter()


@router.get("/api/settings")
def api_settings_get():
    """返回统一设置：9 namespace 全量（每 namespace 合并默认值后返回）"""
    return {"settings": settings_service.load_all_settings()}


@router.put("/api/settings")
def api_settings_put(body: dict):
    """部分更新统一设置（namespace→字段两级深合并，只改传入字段），返回合并后全量"""
    return {"settings": settings_service.save_all_settings(body or {})}


@router.get("/api/desktop-lyric/settings")
def api_desktop_lyric_settings_get():
    """返回桌面歌词设置（主播放器与悬浮窗跨引擎共享，存后端）"""
    return {"settings": settings_service.load_desktop_lyric_settings()}


@router.put("/api/desktop-lyric/settings")
def api_desktop_lyric_settings_put(body: dict):
    """保存桌面歌词设置（主播放器修改时调用）"""
    return {"settings": settings_service.save_desktop_lyric_settings(body or {})}


@router.get("/api/ui/settings")
def api_ui_settings_get():
    """返回主题设置（迷你窗轮询读取：主题 + 迷你窗外观）"""
    return {"settings": settings_service.load_ui_settings()}


@router.put("/api/ui/settings")
def api_ui_settings_put(body: dict):
    """保存主题设置（主播放器修改时调用，防抖同步）"""
    return {"settings": settings_service.save_ui_settings(body or {})}
