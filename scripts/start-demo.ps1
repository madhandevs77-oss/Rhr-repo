# Starts the RHR app in production mode on http://localhost:3001 (Windows PowerShell).
# Usage:  .\scripts\start-demo.ps1
# Edit the three values below once, then run this file whenever you want the app up.
$DbPassword = "pick-a-db-password"      # the password you gave the 'rhr' database user
$Port       = "3001"
$Public     = $true                      # $true when sharing through the Cloudflare tunnel (https)

Set-Location (Split-Path -Parent $PSScriptRoot)
$env:DATABASE_URL = "postgres://rhr:$DbPassword@127.0.0.1:5432/rhr"
$env:NODE_ENV     = "production"
$env:PORT         = $Port
if ($Public) { $env:TRUST_PROXY = "true"; $env:COOKIE_SECURE = "true" } else { $env:COOKIE_SECURE = "false" }

if (-not (Test-Path "dist\index.html")) { Write-Host "Building the app first..."; npm run build }
Write-Host "Starting RHR on http://localhost:$Port  (Ctrl+C to stop)"
node server/index.js
