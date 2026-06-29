@echo off
setlocal
set "SCRIPT=%~dp0SISPDriveMapper.ps1"
start "" powershell.exe -NoProfile -STA -File "%SCRIPT%" %*
