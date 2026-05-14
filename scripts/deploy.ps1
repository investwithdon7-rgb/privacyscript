# PrivacyScript deployment script (PowerShell).
#
# Prerequisite: authenticate Cloudflare once, either:
#   $env:CLOUDFLARE_API_TOKEN = "..."        # in this shell
# or:
#   npx wrangler login                       # interactive browser flow
#
# Then run from repo root:
#   .\scripts\deploy.ps1               # builds and deploys Pages + Worker
#   .\scripts\deploy.ps1 -PagesOnly    # skip the Worker
#   .\scripts\deploy.ps1 -WorkerOnly   # skip the Pages deploy
param(
    [switch]$PagesOnly,
    [switch]$WorkerOnly,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

if (-not $SkipBuild -and -not $WorkerOnly) {
    Write-Host "==> Building static export..." -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed." }
}

if (-not $WorkerOnly) {
    Write-Host "==> Deploying to Cloudflare Pages..." -ForegroundColor Cyan
    npx wrangler pages deploy out --project-name=privacyscript --commit-dirty=true
    if ($LASTEXITCODE -ne 0) { throw "Pages deploy failed." }
}

if (-not $PagesOnly) {
    Write-Host "==> Deploying Cloudflare Worker (tekdruid.com router)..." -ForegroundColor Cyan
    Push-Location cloudflare\worker
    try {
        npx wrangler deploy
        if ($LASTEXITCODE -ne 0) { throw "Worker deploy failed." }
    } finally {
        Pop-Location
    }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Pages preview: https://privacyscript.pages.dev/  (assets 404 — only the router URL renders)"
Write-Host "  Public URL:    https://tekdruid.com/privacyscript/"
