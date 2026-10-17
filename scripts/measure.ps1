# ============================================================================
# STRYV memory measurement harness
# ============================================================================
# WHY THIS IS CAREFUL
#
# The naive method - sum the working sets of everything under the app - is
# wrong twice over on this machine:
#
#   1. Windows Search (SearchHost.exe) runs 15 msedgewebview2 processes of its
#      own, totalling ~444 MB. A system-wide "webview2 total" is mostly noise.
#   2. WebView2 shares memory between processes. Summing private bytes across a
#      tree can double-count a page that is mapped into two processes.
#
# So this measures three separate things and labels them, rather than collapsing
# them into one number:
#
#   privateBytes  (PrivateMemorySize64)  committed, not shared, what you must
#                                       give back to the OS. Least double-count
#                                       risk.
#   workingSet    (WorkingSet64)         resident pages, including shared ones
#                                       mapped in. Can overlap between procs.
#   privateWS     (Working Set - Private counter) what Task Manager's "Memory"
#                                       column shows.
#
# ATTRIBUTION
# A process counts toward STRYV only if its parent chain terminates at the
# STRYV root PID, AND it did not exist in the baseline snapshot taken before
# launch. Both conditions. A pre-existing process that happens to be a child of
# nothing relevant is never counted.
#
# USAGE
#   powershell -File scripts/measure.ps1 -Exe <path> -Label "stryv" -Seconds 20
#   powershell -File scripts/measure.ps1 -Exe <path> -Label x -Settle 5 -Samples 5
# ============================================================================
param(
  [Parameter(Mandatory=$true)][string]$Exe,
  [string]$Label = "app",
  [int]$Settle = 8,
  [int]$Samples = 1,
  [int]$SampleGapSec = 10,
  [switch]$NoLaunch
)

$ErrorActionPreference = "SilentlyContinue"

function Get-All {
  # One WMI snapshot. PrivateWorkingSet comes from the perf counter set.
  $priv = @{}
  try {
    $cnt = Get-Counter "\Process(*)\Working Set - Private" -ErrorAction Stop
    foreach ($s in $cnt.CounterSamples) {
      $inst = $s.InstanceName
      $i = $inst.LastIndexOf("#")
      if ($i -gt 0) { $inst = $inst.Substring(0, $i) }
      $priv[$inst] = [math]::Round($s.CookedValue / 1MB, 2)
    }
  } catch {}

  $rows = @()
  foreach ($p in Get-CimInstance Win32_Process) {
    $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if (-not $gp) { continue }
    $pws = 0
    if ($priv.ContainsKey($gp.ProcessName)) { $pws = $priv[$gp.ProcessName] }
    $rows += [pscustomobject]@{
      Pid      = $p.ProcessId
      Name     = $p.Name
      PPid     = $p.ParentProcessId
      PrivBytes= [math]::Round($gp.PrivateMemorySize64 / 1MB, 1)
      WS       = [math]::Round($gp.WorkingSet64 / 1MB, 1)
      PrivWS   = $pws
      Cmd      = $p.CommandLine
    }
  }
  return $rows
}

function Get-Tree($all, $rootPid) {
  $byPid = @{}
  foreach ($r in $all) { $byPid[$r.Pid] = $r }
  $out  = @()
  $seen = @{}
  $stack = New-Object System.Collections.Stack
  $stack.Push($rootPid)
  while ($stack.Count -gt 0) {
    $cur = $stack.Pop()
    foreach ($c in $all | Where-Object { $_.PPid -eq $cur }) {
      if ($seen.ContainsKey($c.Pid)) { continue }
      $seen[$c.Pid] = $true
      $out += $c
      $stack.Push($c.Pid)
    }
  }
  return $out
}

function Measure-Snapshot($name) {
  $all = Get-All
  $root = $all | Where-Object { $_.Pid -eq $script:rootPid } | Select-Object -First 1
  if (-not $root) { Write-Output "  [$name] root process is gone"; return $null }

  $tree = Get-Tree $all $script:rootPid
  # Only processes that are NEW since the baseline snapshot count as ours.
  $mine = @($tree | Where-Object { -not $script:baselinePids.ContainsKey($_.Pid) })
  $pre  = @($tree | Where-Object {     $script:baselinePids.ContainsKey($_.Pid) })

  $sum = @{
    PrivBytes = ($mine | Measure-Object PrivBytes -Sum).Sum
    WS        = ($mine | Measure-Object WS -Sum).Sum
    PrivWS    = ($mine | Measure-Object PrivWS -Sum).Sum
  }
  if ($root.Pid -eq $script:baselinePids.Values -contains $root.Pid) { }

  [pscustomobject]@{
    Name      = $name
    RootName  = $root.Name
    RootPriv  = $root.PrivBytes
    RootWS    = $root.WS
    RootPrivWS= $root.PrivWS
    Kids      = $mine
    PreExist  = $pre
    TotPriv   = [math]::Round($sum.PrivBytes, 1)
    TotWS     = [math]::Round($sum.WS, 1)
    TotPrivWS = [math]::Round($sum.PrivWS, 1)
  }
}

function Show-Snapshot($s) {
  Write-Output ""
  Write-Output ("  [{0}]  {1}" -f $s.Name, $s.RootName)
  Write-Output ("    {0,-30} {1,9} {2,9} {3,9}" -f "process", "privB", "WS", "privWS")
  Write-Output ("    {0,-30} {1,9:N1} {2,9:N1} {3,9:N1}" -f $s.RootName, $s.RootPriv, $s.RootWS, $s.RootPrivWS)
  foreach ($k in $s.Kids) {
    $short = $k.Name -replace '^msedgewebview2\.exe$', 'webview2'
    $role  = ""
    if ($k.Cmd -match '--type=([a-z-]+)') { $role = $Matches[1] }
    Write-Output ("    {0,-30} {1,9:N1} {2,9:N1} {3,9:N1}  {4}" -f $short, $k.PrivBytes, $k.WS, $k.PrivWS, $role)
  }
  if ($s.PreExist.Count) {
    Write-Output ("    (excluded, pre-existed: {0} proc(s))" -f $s.PreExist.Count)
  }
  Write-Output ("    {0,-30} {1,9:N1} {2,9:N1} {3,9:N1}" -f "TOTAL (new only)", ($s.RootPriv + $s.TotPriv), ($s.RootWS + $s.TotWS), ($s.RootPrivWS + $s.TotPrivWS))
}

# ---- baseline ---------------------------------------------------------------
Write-Output "=== BASELINE (app not running) ==="
$script:baseline = Get-All
$script:baselinePids = @{}
foreach ($r in $script:baseline) { $script:baselinePids[$r.Pid] = $r.Name }
$wv0 = @($script:baseline | Where-Object { $_.Name -like "msedgewebview2*" })
Write-Output ("  msedgewebview2 on the system: {0} proc, {1:N1} MB private bytes" -f $wv0.Count, (($wv0 | Measure-Object PrivBytes -Sum).Sum))
Write-Output "  (these belong to other apps and are never counted below)"

# ---- launch -----------------------------------------------------------------
if (-not $NoLaunch) {
  Write-Output ""
  Write-Output ("=== LAUNCH $Label ===")
  $proc = Start-Process -FilePath $Exe -PassThru
  $script:rootPid = $proc.Id
  Write-Output ("  root pid " + $proc.Id)
  Start-Sleep -Seconds $Settle
}

$results = @()

$s = Measure-Snapshot "settled (${Settle}s after launch)"
if ($s) { Show-Snapshot $s; $results += $s }

for ($i = 1; $i -le $Samples; $i++) {
  Start-Sleep -Seconds $SampleGapSec
  $s = Measure-Snapshot ("idle +$($i*$SampleGapSec)s")
  if ($s) { Show-Snapshot $s; $results += $s }
}

Write-Output ""
Write-Output "=== SUMMARY: $Label ==="
Write-Output ("  {0,-22} {1,10} {2,10} {3,10}" -f "condition", "privB", "WS", "privWS")
foreach ($r in $results) {
  Write-Output ("  {0,-22} {1,10:N1} {2,10:N1} {3,10:N1}" -f $r.Name, ($r.RootPriv + $r.TotPriv), ($r.RootWS + $r.TotWS), ($r.RootPrivWS + $r.TotPrivWS))
}

if (-not $NoLaunch) {
  Write-Output ""
  Write-Output "  stopping..."
  # Kill the whole tree: stopping only the root orphans every WebView2 child, which
}
