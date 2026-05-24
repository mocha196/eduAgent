# set-utf8.ps1 — 在管道前 dot-source 此脚本以修复中文/emoji 乱码
# 用法: . .\scripts\set-utf8.ps1
chcp 65001 | Out-Null
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Console]::InputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONUTF8 = "1"
Write-Host "UTF-8 OK (chcp 65001)" -ForegroundColor Green
