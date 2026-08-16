"""夸克网盘扫码登录路由（quark_provider）。"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

import quark_provider

router = APIRouter()


@router.post("/api/quark/login/qrcode")
def api_quark_login_qrcode():
    """生成夸克扫码登录二维码；返回 {qr_image(data uri), qr_id, expires_in}"""
    try:
        return quark_provider.login_qrcode()
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"生成二维码失败: {e}"})


@router.get("/api/quark/login/status")
def api_quark_login_status(qr_id: str = ""):
    """轮询扫码状态；qr_id 来自 /api/quark/login/qrcode"""
    if not qr_id:
        raise HTTPException(400, "缺少 qr_id")
    return quark_provider.login_status(qr_id)


@router.get("/api/quark/login/state")
def api_quark_login_state():
    """当前夸克登录状态：{logged_in, nickname?}"""
    return quark_provider.login_state()


@router.post("/api/quark/login/logout")
def api_quark_login_logout():
    """退出夸克登录：删除本地 Cookie"""
    quark_provider.logout()
    return {"ok": True}
