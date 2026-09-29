@echo off
chcp 65001 >nul
echo [MCP Gateway] 正在停止网关及关联子进程...
powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort 3300 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
echo [MCP Gateway] 网关已安全停止。
timeout /t 2 >nul
