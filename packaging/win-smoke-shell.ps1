param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath
)
# QQPlayer Tauri 壳冒烟测试（Windows CI 用）：
# 启动打包后的壳 → 壳探测 17627 无服务 → spawn 内置后端 → 健康检查 → 服务就绪
# → 主窗口 External 加载后端页面 → 前端自检（经 qqlog 通道写 webview-console.log）。
#   阶段1：轮询 http://127.0.0.1:17627/api/settings 返回 200（后端就绪）；
#   阶段2：轮询 <logs>/webview-console.log 出现
#          `[info] frontend-selftest ok origin=http://127.0.0.1:17627`（自检通过）
#          或 `[error] frontend-selftest FAIL ...`（立即失败）。
# 总轮询上限 90s（壳启动 + 后端 ready + WebView 加载页面 + 自检，链路更长）。
# 退出码: 0 冒烟通过；1 启动失败/接口异常/前端自检失败/超时。
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
$webviewLog = Join-Path $logDir "webview-console.log"
$selftestOkMark = "frontend-selftest ok origin=http://127.0.0.1:17627"
$selftestFailMark = "frontend-selftest FAIL"

Write-Output "[smoke] exe: $ExePath"
Write-Output "[smoke] backend dir 存在: $(Test-Path $backendDir)\qqplayer-backend.exe: $(Test-Path (Join-Path $backendDir 'qqplayer-backend.exe'))"
if (Test-Path (Join-Path $backendDir '_internal')) { Write-Output "[smoke] _internal/ 存在" } else { Write-Output "[smoke] ⚠️ _internal/ 缺失" }

# 失败诊断：打印 webview-console.log / backend-launcher.log / pkg-backend.log 尾部
function Print-SmokeLogs {
    if (Test-Path $webviewLog) {
        Write-Output "===== webview-console.log 尾部 ====="
        Get-Content $webviewLog -Tail 30
    } else {
        Write-Output "[smoke] webview-console.log 不存在（$webviewLog）——前端未走 qqlog 通道或页面未加载"
    }
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
}

$proc = Start-Process -FilePath $ExePath -PassThru
$backendExited = $false
try {
    $deadline = (Get-Date).AddSeconds(90)
    $backendOk = $false

    # ---- 阶段1：内置后端就绪（/api/settings 200）----
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            $backendExited = $true
            Write-Output "[smoke] 壳进程已退出 code=$($proc.ExitCode)"
            break
        }
        try {
            # 127.0.0.1 显式 IPv4（Windows 上 localhost 优先 ::1，后端绑定 127.0.0.1）
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:17627/api/settings" -TimeoutSec 2 -UseBasicParsing
            if ($r.StatusCode -eq 200) { $backendOk = $true; break }
        } catch {
            # 后端未就绪，继续轮询
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $backendOk) {
        Write-Output "[smoke] 阶段1失败（后端未就绪），壳退出=$backendExited"
        Print-SmokeLogs
        Write-Error "90s 内后端未就绪（17627 /api/settings 无 200）"
        exit 1
    }
    Write-Output "[smoke] 后端就绪：/api/settings 200，等待前端自检…"

    # ---- 阶段2：前端自检标记（webview-console.log 尾部 200 行）----
    $selftestFailed = $false
    $selftestPassed = $false
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            $backendExited = $true
            Write-Output "[smoke] 壳进程已退出 code=$($proc.ExitCode)（后端就绪但前端未完成自检）"
            break
        }
        if (Test-Path $webviewLog) {
            $tailText = (Get-Content $webviewLog -Tail 200) -join "`n"
            if ($tailText -like "*$selftestFailMark*") {
                $selftestFailed = $true
                break
            }
            if ($tailText -like "*$selftestOkMark*") {
                $selftestPassed = $true
                break
            }
        }
        Start-Sleep -Milliseconds 500
    }
    if ($selftestFailed) {
        Write-Output "[smoke] 前端自检报告 FAIL，壳退出=$backendExited"
        Print-SmokeLogs
        Write-Error "前端自检 FAIL（webview-console.log 见上）"
        exit 1
    }
    if (-not $selftestPassed) {
        Write-Output "[smoke] 阶段2超时（前端自检标记未出现），壳退出=$backendExited"
        Print-SmokeLogs
        Write-Error "90s 内前端自检标记未出现（webview-console.log 无 'frontend-selftest ok'）"
        exit 1
    }
    Write-Output "SMOKE OK: 壳启动 + 内置后端 + 前端自检通过（origin=http://127.0.0.1:17627）"
} finally {
    # 杀进程树（壳 + 它拉起的后端），避免 runner 残留
    if (-not $proc.HasExited) {
        & taskkill /PID $proc.Id /T /F 2>$null | Out-Null
    }
}
