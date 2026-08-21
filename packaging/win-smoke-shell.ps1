param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath
)
# QQPlayer Tauri shell smoke test (Windows CI):
# 1. Launch the packaged shell -> it probes 17627 (no service) -> spawns the embedded
#    backend -> health check until ready.
# 2. Main window loads the backend page (External URL) -> the frontend selftest reports
#    through the qqlog channel into webview-console.log.
#    Phase 1: poll http://127.0.0.1:17627/api/settings for HTTP 200 (backend ready);
#    Phase 2: poll <logs>/webview-console.log for
#          `[info] frontend-selftest ok origin=http://127.0.0.1:17627` (passed)
#          or `[error] frontend-selftest FAIL ...` (fail immediately).
# Total polling budget 90s (shell boot + backend ready + WebView page load + selftest).
# Exit code: 0 = smoke passed; 1 = startup failure / API error / selftest failure / timeout.
$ErrorActionPreference = "Stop"

# Exit directly on backend failure (no dialog box -- CI runners have nobody to click it,
# a modal dialog would block the smoke test forever)
$env:QQPLAYER_NO_DIALOG = "1"

if (-not (Test-Path $ExePath)) {
    Write-Error "Shell executable not found: $ExePath"
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
Write-Output "[smoke] backend dir exists: $(Test-Path $backendDir)\qqplayer-backend.exe: $(Test-Path (Join-Path $backendDir 'qqplayer-backend.exe'))"
if (Test-Path (Join-Path $backendDir '_internal')) { Write-Output "[smoke] _internal/ exists" } else { Write-Output "[smoke] WARNING _internal/ missing" }

# Failure diagnostics: print tails of webview-console.log / backend-launcher.log / pkg-backend.log
function Print-SmokeLogs {
    if (Test-Path $webviewLog) {
        Write-Output "===== webview-console.log tail ====="
        Get-Content $webviewLog -Tail 30
    } else {
        Write-Output "[smoke] webview-console.log not found ($webviewLog) -- frontend never reported via qqlog or page never loaded"
    }
    $procs = Get-Process -Name "qqplayer-backend" -ErrorAction SilentlyContinue
    if ($procs) { Write-Output "[smoke] qqplayer-backend running: $($procs.Count) process(es)" } else { Write-Output "[smoke] qqplayer-backend process not found (spawn failed or exited immediately)" }
    if (Test-Path $launcherLog) {
        Write-Output "===== backend-launcher.log tail ====="
        Get-Content $launcherLog -Tail 15
    } else {
        Write-Output "[smoke] backend-launcher.log not found"
    }
    if (Test-Path $logPath) {
        Write-Output "===== pkg-backend.log tail ====="
        Get-Content $logPath -Tail 20
    } else {
        Write-Output "[smoke] pkg-backend.log not found ($logPath) -- shell never reached embedded backend spawn"
    }
}

$proc = Start-Process -FilePath $ExePath -PassThru
$backendExited = $false
try {
    $deadline = (Get-Date).AddSeconds(90)
    $backendOk = $false

    # ---- Phase 1: embedded backend ready (/api/settings returns 200) ----
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            $backendExited = $true
            Write-Output "[smoke] shell process exited code=$($proc.ExitCode)"
            break
        }
        try {
            # explicit 127.0.0.1 IPv4 (Windows resolves localhost to ::1 first, backend binds 127.0.0.1)
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:17627/api/settings" -TimeoutSec 2 -UseBasicParsing
            if ($r.StatusCode -eq 200) { $backendOk = $true; break }
        } catch {
            # backend not ready yet, keep polling
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $backendOk) {
        Write-Output "[smoke] Phase 1 failed (backend not ready), shell exited=$backendExited"
        Print-SmokeLogs
        Write-Error "Backend not ready within 90s (no HTTP 200 from 17627 /api/settings)"
        exit 1
    }
    Write-Output "[smoke] backend ready: /api/settings 200, waiting for frontend selftest..."

    # ---- Phase 2: frontend selftest marker (tail 200 lines of webview-console.log) ----
    $selftestFailed = $false
    $selftestPassed = $false
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            $backendExited = $true
            Write-Output "[smoke] shell process exited code=$($proc.ExitCode) (backend ready but selftest never completed)"
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
        Write-Output "[smoke] frontend selftest reported FAIL, shell exited=$backendExited"
        Print-SmokeLogs
        Write-Error "Frontend selftest FAIL (see webview-console.log above)"
        exit 1
    }
    if (-not $selftestPassed) {
        Write-Output "[smoke] Phase 2 timeout (selftest marker never appeared), shell exited=$backendExited"
        Print-SmokeLogs
        Write-Error "Frontend selftest marker not found within 90s (no 'frontend-selftest ok' in webview-console.log)"
        exit 1
    }
    Write-Output "SMOKE OK: shell boot + embedded backend + frontend selftest passed (origin=http://127.0.0.1:17627)"
} finally {
    # kill the process tree (shell + backend it spawned), avoid runner residue
    if (-not $proc.HasExited) {
        & taskkill /PID $proc.Id /T /F 2>$null | Out-Null
    }
}
