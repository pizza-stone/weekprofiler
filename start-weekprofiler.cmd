@echo off
setlocal
set "WEEKPROFILER_NODE="
where node >nul 2>&1
if not errorlevel 1 set "WEEKPROFILER_NODE=node"
if not defined WEEKPROFILER_NODE if defined CODEX_PRIMARY_RUNTIME_NODE if exist "%CODEX_PRIMARY_RUNTIME_NODE%" set "WEEKPROFILER_NODE=%CODEX_PRIMARY_RUNTIME_NODE%"
if not defined WEEKPROFILER_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "WEEKPROFILER_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined WEEKPROFILER_NODE (
  echo Node.js was not found. Install Node.js 22 or newer, then retry.
  pause
  exit /b 1
)
where codex >nul 2>&1
if errorlevel 1 (
  echo Codex CLI is not installed. Ordinary planning is still available.
  echo To enable AI, install the official CLI: npm install -g @openai/codex
  echo Then sign in with ChatGPT: codex login
) else (
  echo AI uses your ChatGPT subscription through Codex CLI.
  echo If not signed in, run login-codex.cmd yourself. This launcher does not sign in.
)
"%WEEKPROFILER_NODE%" "%~dp0local-ai-server.mjs"
if errorlevel 1 (
  echo.
  echo weekprofiler did not start. Read the message above.
  pause
)
endlocal
