# The loop from the scripting README section, line for line, with an exit-code check
# after each command. e2e.js runs it in PowerShell 7 on Windows and reads the
# results\try-N.md files it leaves behind.
param(
  [Parameter(Mandatory)] [string] $Project,
  [Parameter(Mandatory)] [string] $Dir,
  [int] $Tries = 2
)
$ErrorActionPreference = 'Stop'
Set-Location $Dir
New-Item -ItemType Directory -Force results | Out-Null

function Check([string] $what) {
  if ($LASTEXITCODE -ne 0) {
    Write-Error "terminator $what exited $LASTEXITCODE"
    exit 1
  }
}

1..$Tries | % {
  $id = terminator new claude --project $Project --name "try-$_"; Check new
  terminator send $id "List the files in this folder and say which one is largest"; Check send
  terminator wait $id idle error --timeout 10m; Check wait
  terminator reply $id > "results\try-$_.md"; Check reply
  terminator stop $id; Check stop
  terminator remove $id; Check remove
  Write-Output "try-$_ $id"
}
