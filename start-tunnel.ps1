# 启动编队插件的公网隧道（cpolar），并把公网地址写进 clipboard 和日志
#
# 用法：右键「使用 PowerShell 运行」，或在终端里
#   powershell -ExecutionPolicy Bypass -File start-tunnel.ps1
#
# 隧道起来后，把日志里那条 https://xxxx.r19.vip.cpolar.cn 填到
# 另一台机器「编队 → 手工添加机器」的输入框里即可。

$ErrorActionPreference = 'Stop'

$cpolar = Join-Path $env:USERPROFILE '.dsh\mobile-access\components\cpolar\3.3.18\cpolar.exe'
$config = Join-Path $env:USERPROFILE '.dsh\mobile-access\state\cpolar\cpolar.yml'
$logDir = Join-Path $env:USERPROFILE '.dsh\fleet'
$logFile = Join-Path $logDir 'tunnel.log'

if (-not (Test-Path $cpolar)) {
  Write-Host "找不到 cpolar：$cpolar" -ForegroundColor Red
  Write-Host "它由 dsh-mobile 插件安装。可以先在 DSH 里打开一次「移动访问」再回来。" -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path $config)) {
  Write-Host "找不到 cpolar 配置：$config" -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# 已经在跑就不再重复起（cpolar 同 token 多开会互相顶掉）
$existing = Get-CimInstance Win32_Process -Filter "Name='cpolar.exe'" |
  Where-Object { $_.CommandLine -match '45940' }
if ($existing) {
  Write-Host "隧道已经在跑了（pid $($existing.ProcessId)），地址："
  $last = Get-Content $logFile -ErrorAction SilentlyContinue |
    Select-String 'Tunnel established at (https://[^\s"]+)' |
    Select-Object -Last 1
  if ($last) { Write-Host "  $($last.Matches[0].Groups[1].Value)" -ForegroundColor Green }
  else { Write-Host "  （还没拿到地址，等几秒再看 $logFile）" -ForegroundColor Yellow }
  exit 0
}

Write-Host "正在建立隧道（端口 45940 → cpolar）……" -ForegroundColor Cyan

$proc = Start-Process -FilePath $cpolar `
  -ArgumentList @("http", "-config=$config", "-inspect-addr=false", "-log=stdout", "-log-level=INFO", "45940") `
  -RedirectStandardOutput $logFile `
  -PassThru -WindowStyle Hidden

# 最多等 30 秒拿地址
$url = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  $line = Get-Content $logFile -ErrorAction SilentlyContinue |
    Select-String 'Tunnel established at (https://[^\s"]+)' |
    Select-Object -Last 1
  if ($line) { $url = $line.Matches[0].Groups[1].Value; break }
  if ($proc.HasExited) { break }
}

if ($url) {
  Write-Host ""
  Write-Host "隧道已就绪：" -ForegroundColor Green
  Write-Host "  $url" -ForegroundColor Green
  Write-Host ""
  Write-Host "把这个地址填到另一台机器的「编队 → 手工添加机器」输入框里。" -ForegroundColor Cyan
  Write-Host "（两端共享密钥必须一致，否则会 401）" -ForegroundColor DarkGray
  try { Set-Clipboard -Value $url; Write-Host "地址已复制到剪贴板。" -ForegroundColor DarkGray } catch {}
} else {
  Write-Host "没拿到隧道地址，看一下日志：$logFile" -ForegroundColor Red
  Get-Content $logFile -Tail 15 -ErrorAction SilentlyContinue
  exit 1
}
