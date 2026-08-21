param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath
)
# QQPlayer Tauri 壳冒烟测试（Windows CI 用）：
# 启动打包后的壳 → 壳探测 17627 无服务 → spawn 内置后端 → 健康检查 → 服务就绪。
# 轮询 http://localhost:17627/api/settings 返回 200 即通过。
# 退出码: 0 冒烟通过；1 启动失败/接口异常/超时。
$ErrorActionPreference = "Stop"

if (-not (Test-Path $ExePath)) {
    Write-Error "壳可执行文件不存在: $ExePath"
    exit 1
}

$proc = Start-Process -FilePath $ExePath -PassThru
try {
    $deadline = (Get-Date).AddSeconds(45)
    $ok = $false
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            Write-Error "壳进程提前退出，code=$($proc.ExitCode)（内置后端可能启动失败，查日志 %LOCALAPPDATA%\QQPlayer\logs\pkg-backend.log）"
            exit 1
        }
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:17627/api/settings" -TimeoutSec 2 -UseBasicParsing
            if ($r.StatusCode -eq 200) { $ok = $true; break }
        } catch {
            # 后端未就绪，继续轮询
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ok) {
        Write-Error "45s 内后端未就绪（17627 /api/settings 无 200）"
        exit 1
    }
    Write-Output "SMOKE OK: 壳启动 + 内置后端 spawn + /api/settings 200"
} finally {
    # 杀进程树（壳 + 它拉起的后端），避免 runner 残留
    if (-not $proc.HasExited) {
        & taskkill /PID $proc.Id /T /F 2>$null | Out-Null
    }
}
