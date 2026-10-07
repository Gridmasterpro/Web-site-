@echo off
echo ========================================================
echo   Starting Grid Master Solar Web Application...
echo ========================================================
echo.
echo Modern React/Vite web applications require a local server.
echo Opening http://localhost:3000 in your browser...
echo.

REM Run this from the repository root:  scripts\run.bat
cd /d "%~dp0\.."

if not exist node_modules (
  echo First run: installing dependencies...
  call npm install
)

if exist dist (
  echo Serving the production build in dist\
  npx serve -s dist -p 3000
) else (
  echo No dist\ folder found — starting the dev server instead.
  npm run dev
)
pause
