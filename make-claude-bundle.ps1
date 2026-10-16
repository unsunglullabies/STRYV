# Bundles the files Claude needs into ONE pasteable text file.
# Claude cannot read local paths, so everything has to travel as plain text.
# Run:  powershell -File make-claude-bundle.ps1

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $root "CLAUDE-CONTEXT.txt"

# Frontend files Claude needs to do UI work. main.rs is deliberately excluded:
# 608 lines of backend Rust is dead weight for a design task.
$files = @(
  "README.md",
  "package.json",
  "src/index.html",
  "src/style.css",
  "src/core.js",
  "src/app.js",
  "src/atlas.js",
  "src/intro.js",
  "src/meas.js",
  "src/opt.js",
  "src/sensors.js",
  "src/health.js"
)

$sb = New-Object System.Text.StringBuilder
function Add-Line($s) { [void]$sb.AppendLine($s) }

Add-Line "================================================================"
Add-Line "STRYV - CODE CONTEXT FOR CLAUDE"
Add-Line "Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Add-Line "================================================================"
Add-Line ""
Add-Line "STRYV is a Tauri 2 desktop system monitor for Windows."
Add-Line "Frontend: vanilla JS, NO bundler, NO framework, NO npm runtime deps."
Add-Line "Files in src/ are loaded directly by src/index.html."
Add-Line "Backend: Rust, src-tauri/src/main.rs, commands via generate_handler!."
Add-Line ""
Add-Line "Repo (public): https://github.com/unsunglullabies/STRYV"
Add-Line ""
Add-Line "KEY SHARED HELPERS defined in src/core.js:"
Add-Line "  q(id)                    -> document.getElementById"
Add-Line "  esc(s)                   -> HTML-escape a string"
Add-Line "  toast(msg, bad)         -> transient notification, bad=true is an error"
Add-Line "  confirmBox({title, body, yes, danger}) -> async confirmation dialog"
Add-Line "  store.get(k, fallback) / store.set(k, v)  -> localStorage wrapper"
Add-Line "  Act.log({text, status}) -> returns id; Act.update(id, {status, detail})"
Add-Line "  Tech.add(ctx, err)      -> pushes to the technical error log"
Add-Line "  Cfg.d / Cfg.v           -> default and user settings"
Add-Line "  PAGES                   -> page id list"
Add-Line "  go(page)                -> navigation"
Add-Line ""
Add-Line "NOTE: the signing key is NOT in this repo and must never be shared."
Add-Line ""

foreach ($f in $files) {
  $p = Join-Path $root $f
  if (Test-Path $p) {
    $len = (Get-Item $p).Length
    $lines = (Get-Content $p | Measure-Object -Line).Lines
    Add-Line ""
    Add-Line "================================================================"
    Add-Line "FILE: $f   ($lines lines, $len bytes)"
    Add-Line "================================================================"
    Add-Line ""
    Get-Content $p | ForEach-Object { Add-Line $_ }
  } else {
    Add-Line ""
    Add-Line "!! MISSING: $f"
  }
}

Add-Line ""
Add-Line "================================================================"
Add-Line "END OF CONTEXT"
Add-Line "================================================================"

[System.IO.File]::WriteAllText($out, $sb.ToString())
$kb = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Output "Wrote $out"
Write-Output "  $kb KB - ready to paste"