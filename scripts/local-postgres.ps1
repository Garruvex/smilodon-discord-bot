$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$postgresExecutable = Join-Path $projectRoot "tools\local\postgres\bin\postgres.exe"
$pgDataDirectory = Join-Path $projectRoot "tools\local\pgdata"

if (-not (Test-Path -LiteralPath $postgresExecutable) -or -not (Test-Path -LiteralPath (Join-Path $pgDataDirectory "PG_VERSION"))) {
  throw "Native PostgreSQL is missing. Run npm.cmd run local:setup first."
}

# Runs in the foreground (unlike `pg_ctl start`, which forks) so `concurrently
# --kill-others` can tie its lifetime to the other local services the same
# way it already does for Lavalink.
& $postgresExecutable -D $pgDataDirectory -p 5432
exit $LASTEXITCODE
