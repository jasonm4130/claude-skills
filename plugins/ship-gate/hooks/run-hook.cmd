: << 'CMDBLOCK'
@echo off
REM Cross-platform launcher for this plugin's Node hook scripts.
REM
REM Polyglot: cmd.exe treats the first line as a label and reads this batch block;
REM POSIX shells swallow it as a heredoc and fall through to the sh section below.
REM
REM Why it exists: Claude Code picks the hook shell per platform - sh on
REM macOS/Linux, Git Bash on Windows, but PowerShell on native Windows when Git
REM Bash is absent. A POSIX probe written inline in hooks.json ("command -v node
REM || exit 0") is not valid PowerShell, so it would error before node ever ran
REM and break the hook on a supported configuration.
REM
REM Usage: run-hook.cmd <script-basename>   -> runs ../scripts/<basename>.mjs

setlocal
set "HOOK_DIR=%~dp0"
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    REM node is an external prerequisite: Claude Code ships a self-contained
    REM native binary and its system requirements do not include Node. Skip
    REM silently rather than fail the hook on every matching event.
    echo ship-gate: node not found on PATH - hook skipped 1>&2
    exit /b 0
)
node "%HOOK_DIR%..\scripts\%~1.mjs" %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%
CMDBLOCK

# Unix: same contract. exec so node's exit code reaches Claude Code unchanged -
# a wrapping shell would otherwise be free to mask a blocking exit 2.
command -v node >/dev/null 2>&1 || { echo "ship-gate: node not found on PATH - hook skipped" >&2; exit 0; }
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_NAME="$1"
shift
exec node "${HOOK_DIR}/../scripts/${SCRIPT_NAME}.mjs" "$@"
