@echo off
REM ===========================================================================
REM  STRYV Test - double-click this
REM ===========================================================================
REM  No installer. No download. No GitHub Actions wait. No signing.
REM
REM  This rebuilds only what changed (a frontend edit is instant, a Rust edit
REM  is a few seconds) and launches the test app. If nothing changed it just
REM  starts.
REM
REM  The test app is a separate program from the installed STRYV:
REM    - its own data folder, so your real notes and settings are untouched
REM    - no bundling, no updater, so it can never install a release
REM ===========================================================================

setlocal
cd /d "%~dp0"

REM cargo is not on the machine-wide PATH; rustup was installed with
REM --no-modify-path. Load it for this session only.
if not exist "%USERPROFILE%\.cargo\bin" (
  echo.
  echo   Rust is not installed. Run scripts\setup-rust.ps1 once, then try again.
  echo.
  pause
  exit /b 1
)
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

echo Building STRYV Test...
call npm run test:app
if errorlevel 1 (
  echo.
  echo   Build failed. Scroll up for the error.
  pause
  exit /b 1
)

echo.
echo Starting STRYV Test...
start "" "src-tauri\target\debug\stryv-test.exe"
exit /b 0
