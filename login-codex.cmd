@echo off
setlocal
set "WEEKPROFILER_CODEX="
where codex.exe >nul 2>&1
if not errorlevel 1 set "WEEKPROFILER_CODEX=codex.exe"
if not defined WEEKPROFILER_CODEX (
  where codex.cmd >nul 2>&1
  if not errorlevel 1 set "WEEKPROFILER_CODEX=codex.cmd"
)
if not defined WEEKPROFILER_CODEX (
  echo Install the official Codex CLI first: npm install -g @openai/codex
  pause
  exit /b 1
)
echo Sign in with your ChatGPT account using the official Codex CLI.
echo This explicit login step may open your browser.
set "OPENAI_API_KEY="
set "CODEX_API_KEY="
call "%WEEKPROFILER_CODEX%" -c forced_login_method='chatgpt' login
if errorlevel 1 (
  echo Login did not complete. Retry when ready.
) else (
  echo You can now start weekprofiler with start-weekprofiler.cmd.
)
pause
endlocal
