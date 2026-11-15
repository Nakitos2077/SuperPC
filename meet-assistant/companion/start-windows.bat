@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing... first run takes a minute
  call npm install
)
call npm start
