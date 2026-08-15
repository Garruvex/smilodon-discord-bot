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

$deadline = (Get-Date).AddMinutes(3)
Write-Host "Waiting for Lavalink on 127.0.0.1:2333..."
while ((Get-Date) -lt $deadline) {
  if (Test-TcpPort -HostName "127.0.0.1" -Port 2333) {
    Write-Host "Lavalink is accepting connections. Starting the bot..."
    npm.cmd run local:check-token
    if ($LASTEXITCODE -ne 0) {
      throw "Discord token validation failed. Update DISCORD_TOKEN in .env."
    }
    npm.cmd run dev:once
    exit $LASTEXITCODE
  }
  Start-Sleep -Seconds 2
}

throw "Lavalink did not open port 2333 within three minutes."
