# Serve the app locally. Phones on the same Wi-Fi can open the "Phone" address.
param([int] $Port = 8081)
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.PrefixOrigin -in 'Dhcp', 'Manual' -and $_.IPAddress -notlike '169.*' } |
  Select-Object -First 1).IPAddress
Write-Host "PC:    http://localhost:$Port/src/"
if ($ip) { Write-Host "Phone: http://${ip}:$Port/src/   (same Wi-Fi; allow Node through the firewall if asked)" }
Write-Host "Place hotspots: add ?edit=1"
$env:PORT = $Port
node (Join-Path $PSScriptRoot 'server.mjs')
