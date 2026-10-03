@echo off
title Telegram Bot - Production Mode
cd /d "%~dp0"
call npm run build
call npm run start
pause
