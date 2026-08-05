# 1. Remove the 168MB file from git tracking — but KEEP it on disk (--cached)
git rm --cached react-app/public/data/surgical-protocols.json

# 2. Also untrack any other big copies that may be staged
git rm --cached --ignore-unmatch assistant/data/surgical-protocols.json
git rm --cached --ignore-unmatch "assistant/data/surgical-protocols.GOOD-18283.json"
git rm --cached --ignore-unmatch "react-app/public/data/surgical-protocols.GOOD-18283.json"

# 3. Ensure gitignore blocks them going forward
Add-Content .gitignore "`nreact-app/public/data/surgical-protocols.json`nsurgical-protocols*.json`n*GOOD*.json`n*backup*.json"

# 4. Commit the removal
git add .gitignore
git commit -m "Untrack 168MB corpus from git; keep local as ingest input"

Write-Host "`n=== Confirming no >100MB files are tracked ===" -ForegroundColor Cyan
git ls-files | ForEach-Object { if (Test-Path $_) { $f=Get-Item $_; if ($f.Length -gt 100MB) { Write-Host ("STILL TRACKED: {0} MB  {1}" -f [math]::Round($f.Length/1MB,1), $_) -ForegroundColor Red } } }
Write-Host "If nothing red above, safe to push." -ForegroundColor Green