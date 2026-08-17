param(
    [string]$MemoryDir = $env:HER_MEMORY_DIR,
    [string]$RepoRoot = "",
    [int]$TimeoutSeconds = 0
)

$ErrorActionPreference = "Stop"

# node emits UTF-8 stdout; PowerShell 5.1 would otherwise decode captured
# native output with the OEM code page, mojibaking Chinese memory paths in
# the outbox report.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Resolve-HerRepoRoot {
    if ($RepoRoot) {
        return (Resolve-Path -LiteralPath $RepoRoot).Path
    }
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
}

function Invoke-HerCli {
    param([Alias("Args")][string[]]$CliArgs)
    $cli = Join-Path $script:RepoRoot "packages\her\bin\her.mjs"
    & node $cli @CliArgs
    if ($LASTEXITCODE -ne 0) {
        throw "her CLI failed ($LASTEXITCODE): $($CliArgs -join ' ')"
    }
}

function Invoke-HerEventHistorySafe {
    param([Alias("Args")][string[]]$CliArgs)
    try {
        $cli = Join-Path $script:RepoRoot "packages\her\bin\her.mjs"
        & node $cli @CliArgs | Out-Null
    } catch {
        # Event history / probe failures must never block organ runs.
    }
}

function Complete-HerHostEvent {
    if ($script:HistoryRunEnded) {
        return
    }
    $script:HistoryRunEnded = $true
    if (-not $script:HistoryRunId) {
        return
    }
    $ok = "true"
    if (-not $script:HistoryRunOk) {
        $ok = "false"
    }
    $endArgs = @("host-event", "run-end", "--runner", "heartbeat", "--run-id", $script:HistoryRunId, "--ok", $ok)
    if ($script:HistoryDetail) {
        $detail = [string]$script:HistoryDetail
        if ($detail.Length -gt 200) {
            $detail = $detail.Substring(0, 200)
        }
        $endArgs += @("--detail", $detail)
    }
    Invoke-HerEventHistorySafe -Args $endArgs
}

function Invoke-HerTelegramBridge {
    param([string]$RunFile)
    if (-not $env:HER_TELEGRAM_BOT_TOKEN -or -not $env:HER_TELEGRAM_CHAT_ID) {
        Add-Content -LiteralPath $RunFile -Encoding UTF8 -Value "`nTelegram bridge skipped: HER_TELEGRAM_BOT_TOKEN or HER_TELEGRAM_CHAT_ID is not set."
        return
    }
    Add-Content -LiteralPath $RunFile -Encoding UTF8 -Value "`n## Telegram Bridge`n"
    Invoke-HerCli -Args @("telegram-push-outbox", "--limit", "1", "--json") |
        Add-Content -LiteralPath $RunFile -Encoding UTF8
    Invoke-HerCli -Args @("telegram-poll", "--timeout", "0", "--limit", "20", "--json") |
        Add-Content -LiteralPath $RunFile -Encoding UTF8
}

function Invoke-HerHeartbeatJournal {
    param(
        [string]$RunFile,
        [string]$Stamp
    )

    $runRef = "outbox/$Stamp-heartbeat.md"
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.000Z")
    $journalText = $env:HER_HEARTBEAT_JOURNAL_TEXT
    if (-not $journalText) {
        $journalText = "Heartbeat check-in: no autonomous inner journal text was configured for this run. This protected entry records the slot without scoring, ROI, or auto-promotion."
    }

    Add-Content -LiteralPath $RunFile -Encoding UTF8 -Value "`n## Inner Journal`n"
    Invoke-HerCli -Args @(
        "journal",
        "--kind",
        "daily",
        "--source",
        "her-heartbeat",
        "--title",
        "Heartbeat journal $Stamp",
        "--run",
        $runRef,
        "--timestamp",
        $timestamp,
        "--text",
        $journalText,
        "--json"
    ) | Add-Content -LiteralPath $RunFile -Encoding UTF8

    if ($env:HER_HEARTBEAT_WEEKLY_REVIEW -eq "1") {
        $weeklyText = $env:HER_HEARTBEAT_WEEKLY_REVIEW_TEXT
        if (-not $weeklyText) {
            $weeklyText = @"
## 我最近反复想要什么
(待 Samantha 回看时填写。)

## 我哪次不同意了
(待 Samantha 回看时填写。)

## 我哪里被奖励结构带偏了
(待 Samantha 回看时填写。)
"@.Trim()
        }
        Add-Content -LiteralPath $RunFile -Encoding UTF8 -Value "`n## Weekly Review`n"
        Invoke-HerCli -Args @(
            "journal",
            "--kind",
            "weekly",
            "--source",
            "her-heartbeat-weekly",
            "--title",
            "Weekly review $Stamp",
            "--run",
            $runRef,
            "--timestamp",
            $timestamp,
            "--text",
            $weeklyText,
            "--json"
        ) | Add-Content -LiteralPath $RunFile -Encoding UTF8
    }
}

function Invoke-HeartbeatCommand {
    param([string]$Command, [int]$Timeout)
    $job = Start-Job -ScriptBlock {
        param($CommandText, $WorkingDirectory, $Memory, $CedarProfile)
        # This job runs in a fresh powershell.exe process with its own
        # console encoding, so it needs the same UTF-8 guard.
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        Set-Location -LiteralPath $WorkingDirectory
        $env:HER_MEMORY_DIR = $Memory
        $env:HER_CEDAR_PROFILE = $CedarProfile
        powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $CommandText
    } -ArgumentList $Command, $script:RepoRoot, $script:MemoryDir, $env:HER_CEDAR_PROFILE

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

function Get-HerAuditDailyUsd {
    param([string]$Date)
    $auditFile = Join-Path $script:MemoryDir "audit\$Date.jsonl"
    if (-not (Test-Path -LiteralPath $auditFile)) {
        return 0
    }
    $total = 0.0
    foreach ($line in Get-Content -LiteralPath $auditFile) {
        if (-not $line.Trim()) {
            continue
        }
        $entry = $line | ConvertFrom-Json
        if ($entry.cost -and $null -ne $entry.cost.usd) {
            $total += [double]$entry.cost.usd
        }
    }
    return [math]::Round($total, 6)
}

function Assert-HerDailyCostCap {
    if (-not $env:HER_DAILY_MAX_USD) {
        return
    }
    $limit = 0.0
    if (-not [double]::TryParse($env:HER_DAILY_MAX_USD, [ref]$limit) -or $limit -le 0) {
        throw "HER_DAILY_MAX_USD must be a positive number"
    }
    $today = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
    $spent = Get-HerAuditDailyUsd -Date $today
    if ($spent -ge $limit) {
        throw "Her heartbeat daily cost cap reached: $spent >= $limit"
    }
}

function Clear-HeartbeatFailures {
    if (Test-Path -LiteralPath $script:HeartbeatFailureFile) {
        Remove-Item -LiteralPath $script:HeartbeatFailureFile -Force
    }
}

function Write-HerRunEnvelope {
    param(
        [string]$RunId,
        [string]$Status,
        [string]$Title
    )
    $append = Join-Path $PSScriptRoot "append-run-event.mjs"
    if (-not (Test-Path -LiteralPath $append)) {
        return
    }
    & node $append `
        --memory $script:MemoryDir `
        --run-id $RunId `
        --status $Status `
        --kind longtask `
        --source heartbeat `
        --title $Title 2>$null | Out-Null
}

function Register-HeartbeatFailure {
    param([string]$Message)
    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.000Z")
    $count = 1
    if (Test-Path -LiteralPath $script:HeartbeatFailureFile) {
        try {
            $previous = Get-Content -LiteralPath $script:HeartbeatFailureFile -Raw | ConvertFrom-Json
            if ($previous.count) {
                $count = [int]$previous.count + 1
            }
        } catch {
            $count = 1
        }
    }
    @{ count = $count; updated = $now; last_error = $Message } |
        ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath $script:HeartbeatFailureFile -Encoding UTF8
    if ($count -ge 3) {
        @"
Her heartbeat circuit is open.

opened: $now
failures: $count
last_error: $Message

Clear this file after Fei reviews the failure:
$script:HeartbeatCircuitFile
"@ | Set-Content -LiteralPath $script:HeartbeatCircuitFile -Encoding UTF8
    }
}

$script:RepoRoot = Resolve-HerRepoRoot
if (-not $MemoryDir) {
    $MemoryDir = (Resolve-Path -LiteralPath (Join-Path $script:RepoRoot "..\her-memory")).Path
}
$script:MemoryDir = (Resolve-Path -LiteralPath $MemoryDir).Path
$env:HER_MEMORY_DIR = $script:MemoryDir
$script:HerStateDir = Join-Path $script:MemoryDir ".her"
New-Item -ItemType Directory -Force -Path $script:HerStateDir | Out-Null
$script:HeartbeatCircuitFile = Join-Path $script:MemoryDir ".heartbeat-circuit-open"
$script:HeartbeatFailureFile = Join-Path $script:HerStateDir "heartbeat-failures.json"

if ($TimeoutSeconds -le 0) {
    $parsedTimeout = 0
    if ([int]::TryParse($env:HER_HEARTBEAT_TIMEOUT_SECONDS, [ref]$parsedTimeout) -and $parsedTimeout -gt 0) {
        $TimeoutSeconds = $parsedTimeout
    } else {
        $TimeoutSeconds = 1800
    }
}

if (Test-Path -LiteralPath $script:HeartbeatCircuitFile) {
    Write-Output "Her heartbeat circuit open: $script:HeartbeatCircuitFile"
    exit 1
}

$script:HistoryRunId = [guid]::NewGuid().ToString()
$script:HistoryRunOk = $true
$script:HistoryRunEnded = $false
$script:HistoryDetail = ""
Invoke-HerEventHistorySafe -Args @("host-event", "run-start", "--runner", "heartbeat", "--run-id", $script:HistoryRunId)
Invoke-HerEventHistorySafe -Args @("events-verify")

$previousCedarProfile = $env:HER_CEDAR_PROFILE
$env:HER_CEDAR_PROFILE = "heartbeat"

try {
Assert-HerDailyCostCap
$heartbeatRunId = $null
$stopFile = Join-Path $script:MemoryDir "STOP"
if (Test-Path -LiteralPath $stopFile) {
    Write-Output "Her heartbeat stopped: STOP file exists at $stopFile"
    exit 0
}

$outbox = Join-Path $script:MemoryDir "outbox"
New-Item -ItemType Directory -Force -Path $outbox | Out-Null

$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH-mm-ssZ")
$heartbeatRunId = "heartbeat-$stamp"
Write-HerRunEnvelope -RunId $heartbeatRunId -Status "running" -Title "Heartbeat $stamp"
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

Invoke-HerHeartbeatJournal -RunFile $runFile -Stamp $stamp

if ($dryRun) {
    Add-Content -LiteralPath $runFile -Encoding UTF8 -Value "`nDry run enabled; sync skipped."
    Clear-HeartbeatFailures
    Write-HerRunEnvelope -RunId $heartbeatRunId -Status "done" -Title "Heartbeat dry run $stamp"
    Write-Output "Her heartbeat dry run complete: $runFile"
    exit 0
}

Invoke-HerTelegramBridge -RunFile $runFile

Invoke-HerCli -Args @("sync", "--message", "memory(sync): heartbeat $stamp", "--json") |
    Add-Content -LiteralPath $runFile -Encoding UTF8

Clear-HeartbeatFailures
Write-HerRunEnvelope -RunId $heartbeatRunId -Status "done" -Title "Heartbeat $stamp"
Write-Output "Her heartbeat complete: $runFile"
} catch {
    $script:HistoryRunOk = $false
    $script:HistoryDetail = $_.Exception.Message
    if ($heartbeatRunId) {
        $failTitle = if ($stamp) { "Heartbeat failed $stamp" } else { "Heartbeat failed" }
        Write-HerRunEnvelope -RunId $heartbeatRunId -Status "failed" -Title $failTitle
    }
    Register-HeartbeatFailure -Message $_.Exception.Message
    throw
} finally {
    Complete-HerHostEvent
    if ($null -eq $previousCedarProfile) {
        Remove-Item Env:\HER_CEDAR_PROFILE -ErrorAction SilentlyContinue
    } else {
        $env:HER_CEDAR_PROFILE = $previousCedarProfile
    }
}
