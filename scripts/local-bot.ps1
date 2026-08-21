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
$persistenceDriver = if ($env:PERSISTENCE_DRIVER) { $env:PERSISTENCE_DRIVER } else { "file" }
$lavalinkHost = if ($env:LAVALINK_HOST) { $env:LAVALINK_HOST } else { "127.0.0.1" }
$lavalinkPort = if ($env:LAVALINK_PORT) { [int]$env:LAVALINK_PORT } else { 2333 }

$requiredPorts = @{ "Lavalink" = @{ Host = $lavalinkHost; Port = $lavalinkPort } }
if ($persistenceDriver -eq "postgres") {
  if (-not $env:DATABASE_URL) {
    throw "DATABASE_URL is required when PERSISTENCE_DRIVER=postgres."
  }
  $databaseUri = [Uri]$env:DATABASE_URL
  $databasePort = if ($databaseUri.Port -gt 0) { $databaseUri.Port } else { 5432 }
  $requiredPorts["PostgreSQL"] = @{ Host = $databaseUri.Host; Port = $databasePort }
}

$deadline = (Get-Date).AddMinutes(3)
Write-Host ("Waiting for " + (($requiredPorts.Keys | ForEach-Object { "$_ on $($requiredPorts[$_].Host):$($requiredPorts[$_].Port)" }) -join " and ") + "...")
while ((Get-Date) -lt $deadline) {
  $allReady = $true
  foreach ($name in $requiredPorts.Keys) {
    $endpoint = $requiredPorts[$name]
    if (-not (Test-TcpPort -HostName $endpoint.Host -Port $endpoint.Port)) {
      $allReady = $false
    }
  }
  if ($allReady) {
    Write-Host "Required services are accepting connections."
    if ($persistenceDriver -eq "postgres") {
      Write-Host "Applying PostgreSQL migrations..."
      npm.cmd run db:migrate:active
      if ($LASTEXITCODE -ne 0) {
        throw "PostgreSQL migration failed."
      }
    }
    Write-Host "Starting the bot..."
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
