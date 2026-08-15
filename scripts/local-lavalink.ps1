$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$javaExecutable = Join-Path $projectRoot "tools\local\java\bin\java.exe"
$lavalinkJar = Join-Path $projectRoot "tools\local\Lavalink.jar"
$environmentFile = Join-Path $projectRoot ".env"
$lavalinkDirectory = Join-Path $projectRoot "lavalink"

if (-not (Test-Path -LiteralPath $javaExecutable) -or -not (Test-Path -LiteralPath $lavalinkJar)) {
  throw "Native Java or Lavalink is missing. Run npm.cmd run local:setup first."
}

if (Test-Path -LiteralPath $environmentFile) {
  foreach ($line in Get-Content -LiteralPath $environmentFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) {
      continue
    }
    $parts = $trimmed.Split("=", 2)
    [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
  }
}

Push-Location $lavalinkDirectory
try {
  & $javaExecutable -Xms256m -Xmx768m -jar $lavalinkJar
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
