@echo off
rem ============================================================
rem  PC-TV launcher (Windows, Node.js)
rem  Klik dua kali file ini untuk mulai nonton TV di browser.
rem ============================================================
cd /d "%~dp0"

set NODE=
where node >nul 2>&1 && set NODE=node
if not defined NODE (
  if exist "%ProgramFiles%\nodejs\node.exe" set NODE=%ProgramFiles%\nodejs\node.exe
)
if not defined NODE (
  echo Node.js tidak ditemukan. Install dulu: https://nodejs.org/
  echo Butuh Node 18 atau lebih baru.
  pause
  exit /b 1
)

echo ============================================================
echo  PC-TV  -  Nonton TV Indonesia di PC tanpa tuner
echo  Membuka browser... tekan Ctrl+C untuk berhenti.
echo  Bisa diakses HP/laptop lain di LAN lewat IP PC ini.
echo ============================================================
set PCTV_HOST=0.0.0.0
set PCTV_PORT=8765
"%NODE%" "%~dp0nodejs\server.js"
