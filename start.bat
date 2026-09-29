@echo off
chcp 65001 >nul
title MCP Scale-to-Zero Gateway
echo [MCP Gateway] 正在启动网关服务 (端口: 3300)...
cd /d "%~dp0"
node gateway.js
pause
