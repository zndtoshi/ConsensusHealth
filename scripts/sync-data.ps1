$ErrorActionPreference = "Stop"

$src = "C:\Users\zndtoshi\Projects\btc-influencer-ranker\out"
$dst = Join-Path $PSScriptRoot "..\public\data"

New-Item -ItemType Directory -Force -Path $dst | Out-Null

# IMPORTANT: adjust these filenames if your snapshot date changes
Copy-Item (Join-Path $src "top1000_bitcoiners_2026-03-04.csv") (Join-Path $dst "top1000_bitcoiners.csv") -Force
Copy-Item (Join-Path $src "mentions_bip110_2026-03-04.csv") (Join-Path $dst "mentions_bip110.csv") -Force

Write-Host "Synced CSVs into public\data"

