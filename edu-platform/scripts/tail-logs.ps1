# tail-logs.ps1 — 合并实时查看 3 个服务日志
# 用法: .\scripts\tail-logs.ps1
# 按 Ctrl+C 退出

$LogDir = Join-Path $PSScriptRoot "..\logs"
$files = @(
    @{ path = "$LogDir\nextjs.log";  label = "NEXT" ; color = "Cyan"    }
    @{ path = "$LogDir\worker.log";  label = "WORK" ; color = "Yellow"  }
    @{ path = "$LogDir\rag.log";     label = "RAG " ; color = "Green"   }
)

# 确保文件存在（tail 不阻塞）
foreach ($f in $files) {
    if (-not (Test-Path $f.path)) {
        New-Item -ItemType File -Path $f.path -Force | Out-Null
    }
}

Write-Host "=== 合并日志流 (Ctrl+C 退出) ===" -ForegroundColor White
Write-Host "NEXT=nextjs.log  WORK=worker.log  RAG=rag.log" -ForegroundColor DarkGray
Write-Host ""

# 记录每个文件的当前行数作为起始偏移
$offsets = @{}
foreach ($f in $files) {
    $lines = Get-Content $f.path -ErrorAction SilentlyContinue
    $offsets[$f.path] = if ($lines) { $lines.Count } else { 0 }
}

while ($true) {
    foreach ($f in $files) {
        $content = Get-Content $f.path -ErrorAction SilentlyContinue
        if (-not $content) { continue }
        $total = $content.Count
        $start = $offsets[$f.path]
        if ($total -gt $start) {
            $newLines = $content[$start..($total - 1)]
            foreach ($line in $newLines) {
                $ts = Get-Date -Format "HH:mm:ss"
                Write-Host "[$ts][$($f.label)] " -NoNewline -ForegroundColor $f.color
                Write-Host $line
            }
            $offsets[$f.path] = $total
        }
    }
    Start-Sleep -Milliseconds 300
}
