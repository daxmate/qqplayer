param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath
)
# QQPlayer Tauri 壳冒烟测试（Windows CI 用）：
# 启动打包后的壳 → 壳探测 17627 无服务 → spawn 内置后端 → 健康检查 → 服务就绪。
# 轮询 http://localhost:17627/api/settings 返回 200 即通过。
# 退出码: 0 冒烟通过；1 启动失败/接口异常/超时。
$ErrorActionPreference = "Stop"

# 壳失败时直接退出（不弹错误框——runner 上无人点击，弹框会永久阻塞冒烟）
$env:QQPLAYER_NO_DIALOG = "1"

if (-not (Test-Path $ExePath)) {
    Write-Error "壳可执行文件不存在: $ExePath"
    exit 1
}

$relDir = Split-Path $ExePath
$backendDir = Join-Path $relDir "backend"
$logDir = Join-Path $env:LOCALAPPDATA "QQPlayer\logs"
$logPath = Join-Path $logDir "pkg-backend.log"
$launcherLog = Join-Path $logDir "backend-launcher.log"

Write-Output "[smoke] exe: $ExePath"
Write-Output "[smoke] backend dir 存在: $(Test-Path $backendDir)\qqplayer-backend.exe: $(Test-Path (Join-Path $backendDir 'qqplayer-backend.exe'))"
if (Test-Path (Join-Path $backendDir '_internal')) { Write-Output "[smoke] _internal/ 存在" } else { Write-Output "[smoke] ⚠️ _internal/ 缺失" }

$proc = Start-Process -FilePath $ExePath -PassThru
$backendExited = $false
try {
    $deadline = (Get-Date).AddSeconds(45)
    $ok = $false
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            $backendExited = $true
            Write-Output "[smoke] 壳进程已退出 code=$($proc.ExitCode)"
            break
        }
        try {
            # 127.0.0.1 显式 IPv4（Windows 上 localhost 优先 ::1，后端绑定 127.0.0.1）
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:17627/api/settings" -TimeoutSec 2 -UseBasicParsing
            if ($r.StatusCode -eq 200) { $ok = $true; break }
        } catch {
            # 后端未就绪，继续轮询
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ok) {
        Write-Output "[smoke] 超时/失败，壳退出=$backendExited"
        $procs = Get-Process -Name "qqplayer-backend" -ErrorAction SilentlyContinue
        if ($procs) { Write-Output "[smoke] qqplayer-backend 进程在跑: $($procs.Count) 个" } else { Write-Output "[smoke] qqplayer-backend 进程不存在（spawn 失败或秒退）" }
        if (Test-Path $launcherLog) {
            Write-Output "===== backend-launcher.log 尾部 ====="
            Get-Content $launcherLog -Tail 15
        } else {
            Write-Output "[smoke] backend-launcher.log 不存在"
        }
        if (Test-Path $logPath) {
            Write-Output "===== pkg-backend.log 尾部 ====="
            Get-Content $logPath -Tail 20
        } else {
            Write-Output "[smoke] pkg-backend.log 不存在（$logPath）——壳未走到 spawn 内置后端"
        }
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
