$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeBinary = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $nodeBinary -and $env:CODEX_PRIMARY_RUNTIME_NODE -and (Test-Path -LiteralPath $env:CODEX_PRIMARY_RUNTIME_NODE -PathType Leaf)) {
    $nodeBinary = $env:CODEX_PRIMARY_RUNTIME_NODE
}
if (-not $nodeBinary -and $env:USERPROFILE) {
    $runtimeNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $runtimeNode -PathType Leaf) { $nodeBinary = $runtimeNode }
}
if (-not $nodeBinary) {
    Write-Host 'Node.js was not found. Install Node.js 22 or newer, then retry.' -ForegroundColor Yellow
    exit 1
}

$codexCommand = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codexCommand) {
    Write-Host 'Codex CLI is not installed. Ordinary local planning is still available.'
    Write-Host 'To enable AI, install the official CLI: npm install -g @openai/codex'
    Write-Host 'Then sign in with ChatGPT: codex login'
} else {
    Write-Host 'AI uses your ChatGPT subscription through Codex CLI.'
    Write-Host 'If not signed in, run login-codex.cmd yourself. This launcher does not sign in.'
}
try {
    & $nodeBinary (Join-Path $PSScriptRoot 'local-ai-server.mjs')
    exit $LASTEXITCODE
} catch {
    Write-Host 'weekprofiler could not start. Check Node.js and the complete package, then retry.' -ForegroundColor Yellow
    exit 1
}
