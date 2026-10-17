# Loads cargo into PATH for this session only, then runs whatever was passed.
$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path
& cmd.exe /c ($args -join ' ')
exit $LASTEXITCODE