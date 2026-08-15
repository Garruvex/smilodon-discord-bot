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
Write-Host "Native runtime setup complete. Run: npm.cmd run local:start"
