$ErrorActionPreference = "Stop"

function Test-TcpPort {
  param(
    [Parameter(Mandatory = $true)]
    [string]$HostName,
    [Parameter(Mandatory = $true)]
    [int]$Port,
    [int]$TimeoutMilliseconds = 500
  )

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connection = $client.ConnectAsync($HostName, $Port)
    return $connection.Wait($TimeoutMilliseconds) -and $client.Connected
  }
  catch {
    return $false
  }
  finally {
    $client.Dispose()
  }
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentFile = Join-Path $projectRoot ".env"
$persistenceDriver = "file"
if (Test-Path -LiteralPath $environmentFile) {
  foreach ($line in Get-Content -LiteralPath $environmentFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) {
      continue
    }
    $parts = $trimmed.Split("=", 2)
    if ($parts[0].Trim() -eq "PERSISTENCE_DRIVER" -and $parts[1].Trim()) {
      $persistenceDriver = $parts[1].Trim()
    }
  }
}

$requiredPorts = @{ "Lavalink" = 2333 }
if ($persistenceDriver -eq "postgres") {
  $requiredPorts["PostgreSQL"] = 5432
}

$deadline = (Get-Date).AddMinutes(3)
Write-Host ("Waiting for " + (($requiredPorts.Keys | ForEach-Object { "$_ on 127.0.0.1:$($requiredPorts[$_])" }) -join " and ") + "...")
while ((Get-Date) -lt $deadline) {
  $allReady = $true
  foreach ($name in $requiredPorts.Keys) {
    if (-not (Test-TcpPort -HostName "127.0.0.1" -Port $requiredPorts[$name])) {
      $allReady = $false
    }
  }
  if ($allReady) {
    Write-Host "Required services are accepting connections. Starting the bot..."
    npm.cmd run local:check-token
    if ($LASTEXITCODE -ne 0) {
      throw "Discord token validation failed. Update DISCORD_TOKEN in .env."
    }
    npm.cmd run dev:once
    exit $LASTEXITCODE
  }
  Start-Sleep -Seconds 2
}

throw "Required local services did not open their ports within three minutes."
