param(
    [ValidateRange(1, 216)][int]$Limit = 216,
    [string]$Url = 'http://127.0.0.1:8000',
    [switch]$InventoryOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    # A fresh directory preserves every previous baseline and experiment.
    $runDirectory = Join-Path 'data/evaluations' ('laya-variants-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    $summaries = @()
    foreach ($format in @('json', 'dialogue')) {
        foreach ($choices in @('detailed', 'short')) {
            foreach ($questions in @('together', 'separate')) {
                $name = "$format-$choices-$questions"
                $output = Join-Path $runDirectory "$name.json"
                $runnerArgs = @('node_modules/tsx/dist/cli.mjs', 'src/scripts/replay-laya-decisions.ts',
                    '--format', $format, '--choices', $choices, '--questions', $questions,
                    '--limit', "$Limit", '--url', $Url, '--output', $output)
                if (-not $InventoryOnly) { $runnerArgs += @('--live', '--require-cuda') }
                Write-Host "Evaluating $name"
                & node @runnerArgs
                if ($LASTEXITCODE -ne 0) { throw "Variant $name failed or was incomplete; inspect $output before continuing." }
                $summary = (Get-Content -LiteralPath $output -Raw | ConvertFrom-Json).summary
                $summaries += [pscustomobject]@{
                    Variant = $name
                    Cases = $summary.cases
                    Correct = $summary.correctRelationships
                    Accuracy = $summary.relationshipAccuracyAllCases
                    UnwantedReplies = $summary.replyProposalsOnDisallowedCases
                    ReplyProposals = $summary.replyProposals
                    P95ms = $summary.p95Ms
                    GpuVerified = $summary.gpuVerified
                    Revision = $summary.health.revisions.multilingual
                }
            }
        }
    }
    $summaries | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runDirectory 'comparison.json') -Encoding UTF8
    $summaries | Format-Table Variant, Cases, Correct, Accuracy, UnwantedReplies, ReplyProposals, P95ms -AutoSize
    Write-Host "Reports: $runDirectory"
    Write-Host 'These are prompt variants on one synthetic dataset, not a production acceptance test.'
} finally {
    Pop-Location
}
