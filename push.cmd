@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
set "LOCAL_TSX=%ROOT_DIR%\node_modules\.bin\tsx.cmd"
set "COMPILED=%ROOT_DIR%\cli\dist\cli\cli.js"

if not defined PUSH_TUI_ENABLED set "PUSH_TUI_ENABLED=1"

set "USE_COMPILED="
if exist "%COMPILED%" (
  if defined PUSH_SKIP_STALE_CHECK (
    set "USE_COMPILED=1"
  ) else (
    set "NEWER_SRC="
    for /f "usebackq delims=" %%I in (`powershell -NoLogo -NoProfile -Command "$dist = (Get-Item -LiteralPath $env:COMPILED).LastWriteTimeUtc; $roots = @((Join-Path $env:ROOT_DIR 'cli'), (Join-Path $env:ROOT_DIR 'lib')); Get-ChildItem -LiteralPath $roots -Recurse -File -Filter *.ts | Where-Object { $_.FullName -notmatch '\\(dist|node_modules|tests)\\' -and $_.LastWriteTimeUtc -gt $dist } | Select-Object -First 1 -ExpandProperty FullName"`) do (
      set "NEWER_SRC=%%I"
    )
    if defined NEWER_SRC (
      >&2 echo push: warning - !NEWER_SRC! is newer than cli\dist\cli\cli.js.
      >&2 echo push: running from source via tsx. Run "npm run build:cli" to refresh the compiled dist,
      >&2 echo push: or set PUSH_SKIP_STALE_CHECK=1 to silence this warning.
    ) else (
      set "USE_COMPILED=1"
    )
  )
)

if defined USE_COMPILED (
  node "%COMPILED%" %*
  exit /b %ERRORLEVEL%
)

if exist "%LOCAL_TSX%" (
  call "%LOCAL_TSX%" "%ROOT_DIR%\cli\cli.ts" %*
  exit /b %ERRORLEVEL%
)

where tsx >nul 2>nul
if not errorlevel 1 (
  tsx "%ROOT_DIR%\cli\cli.ts" %*
  exit /b %ERRORLEVEL%
)

if exist "%ROOT_DIR%\cli\cli.mjs" (
  node "%ROOT_DIR%\cli\cli.mjs" %*
  exit /b %ERRORLEVEL%
)

>&2 echo push: cannot start - no compiled CLI build and no tsx runtime found.
>&2 echo push: run "npm install" from the repo root, or build the CLI with "npm run build:cli".
exit /b 1
