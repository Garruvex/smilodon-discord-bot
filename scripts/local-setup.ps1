$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$toolsDirectory = Join-Path $projectRoot "tools\local"
$downloadsDirectory = Join-Path $toolsDirectory "downloads"
$javaDirectory = Join-Path $toolsDirectory "java"
$javaArchive = Join-Path $downloadsDirectory "temurin-jre.zip"
$lavalinkJar = Join-Path $toolsDirectory "Lavalink.jar"
$pluginsDirectory = Join-Path $projectRoot "lavalink\plugins"

New-Item -ItemType Directory -Force -Path $downloadsDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $pluginsDirectory | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $javaDirectory "bin\java.exe"))) {
  Write-Host "Downloading a portable Eclipse Temurin Java 21 runtime..."
  curl.exe -fL --retry 3 --output $javaArchive "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse"

  $extractDirectory = Join-Path $downloadsDirectory "java-extracted"
  if (Test-Path -LiteralPath $extractDirectory) {
    Remove-Item -LiteralPath $extractDirectory -Recurse -Force
  }
  Expand-Archive -LiteralPath $javaArchive -DestinationPath $extractDirectory -Force
  $javaExecutable = Get-ChildItem -LiteralPath $extractDirectory -Recurse -Filter java.exe |
    Where-Object { $_.FullName -like "*\bin\java.exe" } |
    Select-Object -First 1
  if (-not $javaExecutable) {
    throw "The downloaded Java archive did not contain bin\java.exe."
  }
  $extractedJavaHome = Split-Path -Parent (Split-Path -Parent $javaExecutable.FullName)
  Move-Item -LiteralPath $extractedJavaHome -Destination $javaDirectory
}

if (-not (Test-Path -LiteralPath $lavalinkJar)) {
  Write-Host "Downloading Lavalink 4.2.2..."
  curl.exe -fL --retry 3 --output $lavalinkJar "https://github.com/lavalink-devs/Lavalink/releases/download/4.2.2/Lavalink.jar"
}

$youtubePlugin = Join-Path $pluginsDirectory "youtube-plugin-1.18.2.jar"
if (-not (Test-Path -LiteralPath $youtubePlugin)) {
  Write-Host "Downloading YouTube source plugin 1.18.2..."
  curl.exe -fL --retry 3 --output $youtubePlugin "https://github.com/lavalink-devs/youtube-source/releases/download/1.18.2/youtube-plugin-1.18.2.jar"
}

$lavaSrcPlugin = Join-Path $pluginsDirectory "lavasrc-plugin-4.8.1.jar"
if (-not (Test-Path -LiteralPath $lavaSrcPlugin)) {
  Write-Host "Downloading LavaSrc plugin 4.8.1..."
  curl.exe -fL --retry 3 --output $lavaSrcPlugin "https://github.com/topi314/LavaSrc/releases/download/4.8.1/lavasrc-plugin-4.8.1.jar"
}

$previousErrorPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$javaVersion = & (Join-Path $javaDirectory "bin\java.exe") -version 2>&1
$javaExitCode = $LASTEXITCODE
$ErrorActionPreference = $previousErrorPreference
if ($javaExitCode -ne 0) {
  throw "The downloaded Java runtime failed its version check."
}
Write-Host $javaVersion

# Portable PostgreSQL, for local dev/testing of the Postgres persistence
# backend without Docker. Optional — skip this block by deleting it if you
# only ever use PERSISTENCE_DRIVER=file locally.
$postgresVersion = "16.4-1"
$postgresDirectory = Join-Path $toolsDirectory "postgres"
$postgresArchive = Join-Path $downloadsDirectory "postgres.zip"
$pgDataDirectory = Join-Path $toolsDirectory "pgdata"

if (-not (Test-Path -LiteralPath (Join-Path $postgresDirectory "bin\postgres.exe"))) {
  Write-Host "Downloading portable PostgreSQL $postgresVersion..."
  curl.exe -fL --retry 3 --output $postgresArchive "https://get.enterprisedb.com/postgresql/postgresql-$postgresVersion-windows-x64-binaries.zip"

  $postgresExtractDirectory = Join-Path $downloadsDirectory "postgres-extracted"
  if (Test-Path -LiteralPath $postgresExtractDirectory) {
    Remove-Item -LiteralPath $postgresExtractDirectory -Recurse -Force
  }
  Expand-Archive -LiteralPath $postgresArchive -DestinationPath $postgresExtractDirectory -Force
  $pgsqlHome = Join-Path $postgresExtractDirectory "pgsql"
  if (-not (Test-Path -LiteralPath (Join-Path $pgsqlHome "bin\postgres.exe"))) {
    throw "The downloaded PostgreSQL archive did not contain bin\postgres.exe. The pinned version ($postgresVersion) may no longer be available at that URL — check https://www.enterprisedb.com/download-postgresql-binaries for a current build and update this script."
  }
  Move-Item -LiteralPath $pgsqlHome -Destination $postgresDirectory
}

# Reads POSTGRES_USER/POSTGRES_DB from .env so the local superuser and
# default database match what config/instances/*.env already expects in its
# DATABASE_URL template (see .env.example).
$rootEnvironmentFile = Join-Path $projectRoot ".env"
$postgresUser = "postgres"
$postgresDb = "postgres"
if (Test-Path -LiteralPath $rootEnvironmentFile) {
  foreach ($line in Get-Content -LiteralPath $rootEnvironmentFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) {
      continue
    }
    $parts = $trimmed.Split("=", 2)
    $key = $parts[0].Trim()
    $value = $parts[1].Trim()
    if ($key -eq "POSTGRES_USER" -and $value) { $postgresUser = $value }
    if ($key -eq "POSTGRES_DB" -and $value) { $postgresDb = $value }
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $pgDataDirectory "PG_VERSION"))) {
  Write-Host "Initializing a local PostgreSQL data directory for user '$postgresUser'..."
  # --auth=trust: local dev only, bound to 127.0.0.1 by local-postgres.ps1's
  # -p flag (no external listen_addresses change) — no password needed, so
  # DATABASE_URL's password field is ignored rather than having to keep an
  # initdb-time password in sync with it.
  & (Join-Path $postgresDirectory "bin\initdb.exe") -D $pgDataDirectory -U $postgresUser --auth=trust -E UTF8 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "initdb failed."
  }

  if ($postgresDb -ne "postgres") {
    $setupLog = Join-Path $toolsDirectory "pgdata-setup.log"
    & (Join-Path $postgresDirectory "bin\pg_ctl.exe") -D $pgDataDirectory -l $setupLog -w start | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "PostgreSQL failed to start for initial database creation. See $setupLog."
    }
    try {
      & (Join-Path $postgresDirectory "bin\createdb.exe") -U $postgresUser $postgresDb
      if ($LASTEXITCODE -ne 0) {
        throw "createdb failed for database '$postgresDb'."
      }
    } finally {
      & (Join-Path $postgresDirectory "bin\pg_ctl.exe") -D $pgDataDirectory -w stop | Out-Null
    }
  }
}

Write-Host "Native runtime setup complete. Run: npm.cmd run local:start"
