@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo Starting compuser panel...
call npm run build
if errorlevel 1 (
  echo Build failed. Please send this window to the maintainer.
  pause
  exit /b 1
)

if not defined COMPUSER_WINDOWS_MCP_ENDPOINT (
  set "COMPUSER_WINDOWS_MCP_ENDPOINT=http://127.0.0.1:8010/mcp"
)

if not defined COMPUSER_PERMISSION_MODE (
  set "COMPUSER_PERMISSION_MODE=default"
)

if not defined COMPUSER_MODEL_PROVIDER (
  set "COMPUSER_MODEL_PROVIDER=openai-compatible"
)

echo Launching compuser panel...
echo Windows MCP endpoint: %COMPUSER_WINDOWS_MCP_ENDPOINT%
echo Permission mode: %COMPUSER_PERMISSION_MODE%
echo Model provider: %COMPUSER_MODEL_PROVIDER%
echo.
echo Keep this window open while compuser is running.
echo If the task goes off track, press ESC or click the emergency stop button in the panel.
echo.

call npm run web:panel:launcher
if errorlevel 1 (
  echo.
  echo Launch failed. Please send this window to the maintainer.
  pause
  exit /b 1
)

endlocal
