@echo off
rem 启动「聚会点共享版」本地服务
cd /d "%~dp0"
echo 正在启动共享版 http://localhost:8788 ...
start "" http://localhost:8788
node "%~dp0server.mjs"
pause
