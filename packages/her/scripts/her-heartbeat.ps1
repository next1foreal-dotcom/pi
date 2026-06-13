param(
    [string]$MemoryDir = $env:HER_MEMORY_DIR,
    [string]$RepoRoot = "",
    [int]$TimeoutSeconds = 0
)

$ErrorActionPreference = "Stop"

function Resolve-HerRepoRoot {
    if ($RepoRoot) {
        return (Resolve-Path -LiteralPath $RepoRoot).Path
    }
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
}

function Invoke-HerCli {
    param([string[]]$Args)
    $cli = Join-Path $script:RepoRoot "packages\her\bin\her.mjs"
    & node $cli @Args
    if ($LASTEXITCODE -ne 0) {
        throw "her CLI failed ($LASTEXITCODE): $($Args -join ' ')"
    }
}

function Invoke-HeartbeatCommand {
    param([string]$Command, [int]$Timeout)
    $job = Start-Job -ScriptBlock {
        param($CommandText, $WorkingDirectory, $Memory)
        Set-Location -LiteralPath $WorkingDirectory
        $env:HER_MEMORY_DIR = $Memory
        powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $CommandText
    } -ArgumentList $Command, $script:RepoRoot, $script:MemoryDir

    if (-not (Wait-Job $job -Timeout $Timeout)) {
        Stop-Job $job
        Receive-Job $job | Out-String | Write-Output
        Remove-Job $job
        throw "heartbeat command timed out after $Timeout seconds"
    }

    Receive-Job $job
    $state = $job.State
    Remove-Job $job
    if ($state -ne "Completed") {
        throw "heartbeat command failed with job state $state"
    }
}

$script:RepoRoot = Resolve-HerRepoRoot
if (-not $MemoryDir) {
    $MemoryDir = (Resolve-Path -LiteralPath (Join-Path $script:RepoRoot "..\her-memory")).Path
}
$script:MemoryDir = (Resolve-Path -LiteralPath $MemoryDir).Path
$env:HER_MEMORY_DIR = $script:MemoryDir

if ($TimeoutSeconds -le 0) {
    $parsedTimeout = 0
    if ([int]::TryParse($env:HER_HEARTBEAT_TIMEOUT_SECONDS, [ref]$parsedTimeout) -and $parsedTimeout -gt 0) {
        $TimeoutSeconds = $parsedTimeout
    } else {
        $TimeoutSeconds = 1800
    }
}

$stopFile = Join-Path $script:MemoryDir "STOP"
if (Test-Path -LiteralPath $stopFile) {
    Write-Output "Her heartbeat stopped: STOP file exists at $stopFile"
    exit 0
}

$outbox = Join-Path $script:MemoryDir "outbox"
New-Item -ItemType Directory -Force -Path $outbox | Out-Null

$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH-mm-ssZ")
$runFile = Join-Path $outbox "$stamp-heartbeat.md"
$piCommand = $env:HER_HEARTBEAT_PI_COMMAND
$dryRun = $env:HER_HEARTBEAT_DRY_RUN -eq "1"

if ($piCommand -and (-not $env:HER_HEARTBEAT_MAX_USD -or -not $env:HER_DAILY_MAX_USD)) {
    throw "HER_HEARTBEAT_MAX_USD and HER_DAILY_MAX_USD must be set before unattended Pi heartbeat runs"
}

Set-Content -LiteralPath $runFile -Encoding UTF8 -Value @"
# Her Heartbeat $stamp

- memory: $script:MemoryDir
- repo: $script:RepoRoot
- dry_run: $dryRun
- timeout_seconds: $TimeoutSeconds
- pi_command_configured: $([bool]$piCommand)
"@

Invoke-HerCli -Args @("privacy-audit", "--json") | Add-Content -LiteralPath $runFile -Encoding UTF8

if ($piCommand) {
    Add-Content -LiteralPath $runFile -Encoding UTF8 -Value "`n## Pi Headless Scan`n"
    Invoke-HeartbeatCommand -Command $piCommand -Timeout $TimeoutSeconds | Add-Content -LiteralPath $runFile -Encoding UTF8
} else {
    Add-Content -LiteralPath $runFile -Encoding UTF8 -Value "`nPi headless scan skipped: HER_HEARTBEAT_PI_COMMAND is not set."
}

Invoke-HerCli -Args @(
    "capture",
    "--project",
    "her-heartbeat",
    "--session",
    "heartbeat-$stamp",
    "--timestamp",
    (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.000Z"),
    "--text",
    "Heartbeat ran. Output: outbox/$stamp-heartbeat.md",
    "--json"
) | Add-Content -LiteralPath $runFile -Encoding UTF8

if ($dryRun) {
    Add-Content -LiteralPath $runFile -Encoding UTF8 -Value "`nDry run enabled; sync skipped."
    Write-Output "Her heartbeat dry run complete: $runFile"
    exit 0
}

Invoke-HerCli -Args @("sync", "--message", "memory(sync): heartbeat $stamp", "--json") |
    Add-Content -LiteralPath $runFile -Encoding UTF8

Write-Output "Her heartbeat complete: $runFile"
