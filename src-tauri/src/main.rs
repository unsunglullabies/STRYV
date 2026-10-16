#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};
use sysinfo::{Components, Disks, Networks, ProcessesToUpdate, System};

struct Monitor(Mutex<System>);
struct Net(Mutex<(Networks, Instant)>);

#[derive(Serialize)]
struct Adapter { name: String, mac: String, rx_bps: f64, tx_bps: f64 }

#[derive(Serialize)]
struct LatencyResult { target: String, sent: u32, lost: u32, min_ms: Option<f64>, avg_ms: Option<f64>, max_ms: Option<f64> }

#[derive(Serialize)]
struct DnsResult { host: String, ms: Option<f64>, error: Option<String> }

#[derive(Serialize)]
struct TestReport { latency: Vec<LatencyResult>, dns: Vec<DnsResult> }

#[tauri::command]
fn get_network(n: tauri::State<Net>) -> Vec<Adapter> {
    let mut g = n.0.lock().unwrap();
    g.0.refresh();
    let secs = g.1.elapsed().as_secs_f64().max(0.001);
    g.1 = Instant::now();
    g.0.iter()
        .map(|(name, d)| Adapter {
            name: name.clone(),
            mac: d.mac_address().to_string(),
            rx_bps: d.received() as f64 * 8.0 / secs,
            tx_bps: d.transmitted() as f64 * 8.0 / secs,
        })
        .collect()
}

fn tcp_latency(target: &str) -> LatencyResult {
    let (mut lost, mut v) = (0u32, Vec::new());
    let addr = target.to_socket_addrs().ok().and_then(|mut a| a.next());
    for _ in 0..5 {
        let t = Instant::now();
        match addr.and_then(|a| TcpStream::connect_timeout(&a, Duration::from_secs(2)).ok()) {
            Some(_) => v.push(t.elapsed().as_secs_f64() * 1000.0),
            None => lost += 1,
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    let f = |x: f64| if v.is_empty() { None } else { Some(x) };
    LatencyResult {
        target: target.to_string(), sent: 5, lost,
        min_ms: f(v.iter().cloned().fold(f64::MAX, f64::min)),
        avg_ms: f(v.iter().sum::<f64>() / v.len().max(1) as f64),
        max_ms: f(v.iter().cloned().fold(0.0, f64::max)),
    }
}

fn dns_time(host: &str) -> DnsResult {
    let t = Instant::now();
    match (host, 443).to_socket_addrs() {
        Ok(_) => DnsResult { host: host.into(), ms: Some(t.elapsed().as_secs_f64() * 1000.0), error: None },
        Err(e) => DnsResult { host: host.into(), ms: None, error: Some(e.to_string()) },
    }
}

#[tauri::command]
async fn run_network_tests() -> Result<TestReport, String> {
    tauri::async_runtime::spawn_blocking(|| TestReport {
        latency: ["1.1.1.1:443", "8.8.8.8:443"].iter().map(|t| tcp_latency(t)).collect(),
        dns: ["www.microsoft.com", "www.cloudflare.com"].iter().map(|h| dns_time(h)).collect(),
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct DiskInfo { name: String, total: u64, available: u64 }

#[derive(Serialize)]
struct Snapshot {
    cpu_usage: f32,
    mem_used: u64,
    mem_total: u64,
    uptime_secs: u64,
    process_count: usize,
    disks: Vec<DiskInfo>,
}

#[derive(Serialize)]
struct SystemInfo {
    os: String,
    os_version: String,
    host: String,
    cpu_brand: String,
    cpu_cores: usize,
    mem_total: u64,
}

#[tauri::command]
fn get_snapshot(m: tauri::State<Monitor>) -> Snapshot {
    let mut s = m.0.lock().unwrap();
    s.refresh_cpu_usage();
    s.refresh_memory();
    let disks = Disks::new_with_refreshed_list()
        .iter()
        .map(|d| DiskInfo {
            name: d.mount_point().to_string_lossy().into_owned(),
            total: d.total_space(),
            available: d.available_space(),
        })
        .collect();
    Snapshot {
        cpu_usage: s.global_cpu_usage(),
        mem_used: s.used_memory(),
        mem_total: s.total_memory(),
        uptime_secs: System::uptime(),
        process_count: s.processes().len(),
        disks,
    }
}

#[derive(Serialize)]
struct Proc { name: String, cpu: f32, mem: u64 }

#[tauri::command]
fn get_processes(m: tauri::State<Monitor>) -> Vec<Proc> {
    let mut s = m.0.lock().unwrap();
    s.refresh_processes(ProcessesToUpdate::All, true);
    let cores = s.cpus().len().max(1) as f32;
    let mut v: Vec<Proc> = s.processes().values()
        .map(|p| Proc { name: p.name().to_string_lossy().into_owned(), cpu: p.cpu_usage() / cores, mem: p.memory() })
        .collect();
    v.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
    v.truncate(8);
    v
}

#[tauri::command]
fn get_system_info(m: tauri::State<Monitor>) -> SystemInfo {
    let s = m.0.lock().unwrap();
    SystemInfo {
        os: System::name().unwrap_or_default(),
        os_version: System::long_os_version().unwrap_or_default(),
        host: System::host_name().unwrap_or_default(),
        cpu_brand: s.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default(),
        cpu_cores: s.physical_core_count().unwrap_or(0),
        mem_total: s.total_memory(),
    }
}


// ---------- Optimization framework: fixed, validated actions only ----------
#[derive(Serialize)]
struct Opt { id: &'static str, title: &'static str, what: &'static str, why: &'static str, tradeoffs: &'static str, restart: bool, admin: bool, reversible: bool, available: bool, reason: Option<&'static str> }
#[derive(Serialize)]
struct Choice { value: String, label: String }
#[derive(Serialize)]
struct Preview { summary: String, choices: Vec<Choice>, current: Option<String> }
#[derive(Serialize)]
struct Applied { message: String }
#[derive(Serialize)]
struct StartupItem { name: String, command: String, enabled: bool }

fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let mut c = std::process::Command::new(cmd);
    c.args(args);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; c.creation_flags(0x08000000); }
    let o = c.output().map_err(|e| e.to_string())?;
    if o.status.success() { Ok(String::from_utf8_lossy(&o.stdout).to_string()) } else { Err(String::from_utf8_lossy(&o.stderr).trim().to_string()) }
}

fn snap_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join("snapshots.json"))
}
fn read_snaps(app: &tauri::AppHandle) -> Value {
    snap_path(app).ok().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}))
}
fn write_snaps(app: &tauri::AppHandle, v: &Value) -> Result<(), String> {
    std::fs::write(snap_path(app)?, serde_json::to_string_pretty(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

// (guid, name, active)
fn plans() -> Result<Vec<(String, String, bool)>, String> {
    let out = run("powercfg", &["/list"])?;
    let mut v = Vec::new();
    for l in out.lines() {
        if let Some(i) = l.find(": ") {
            let rest = l[i + 2..].trim();
            let guid = rest.split_whitespace().next().unwrap_or("").to_string();
            if guid.len() != 36 { continue; }
            let name = match (rest.find('('), rest.rfind(')')) { (Some(a), Some(b)) if b > a => rest[a + 1..b].to_string(), _ => guid.clone() };
            v.push((guid, name, rest.ends_with('*')));
        }
    }
    if v.is_empty() { Err("Could not read the list of power plans.".into()) } else { Ok(v) }
}

#[derive(Default)]
struct Stats { files: u64, bytes: u64, failed: u64 }
fn sweep(dir: &Path, del: bool, s: &mut Stats, cutoff: SystemTime) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(md) = e.metadata() else { continue };
        if md.file_type().is_symlink() { continue; }
        if md.is_dir() {
            sweep(&p, del, s, cutoff);
            if del { let _ = std::fs::remove_dir(&p); } // only succeeds when empty
        } else if md.modified().map(|m| m < cutoff).unwrap_or(false) {
            if del {
                if std::fs::remove_file(&p).is_ok() { s.files += 1; s.bytes += md.len(); } else { s.failed += 1; }
            } else { s.files += 1; s.bytes += md.len(); }
        }
    }
}
fn temp_root() -> Result<PathBuf, String> {
    let t = std::env::temp_dir();
    if t.components().count() < 3 { return Err("Refusing to clean an unexpectedly short temp path.".into()); }
    Ok(t)
}
fn cutoff() -> SystemTime { SystemTime::now() - Duration::from_secs(24 * 3600) }
fn mb(b: u64) -> String { format!("{:.1} MB", b as f64 / 1048576.0) }

#[tauri::command]
fn opt_catalog() -> Vec<Opt> {
    let ok = cfg!(windows);
    let why = if ok { None } else { Some("Available on Windows only.") };
    vec![
        Opt { id: "power_plan", title: "Switch power plan", what: "Changes the active Windows power plan.", why: "A performance-oriented plan can keep the CPU responsive. The effect depends on the PC and workload; STRYV does not measure it yet.", tradeoffs: "Higher power use, more heat and shorter battery life on laptops. Windows requires Administrator rights to switch plans, so start STRYV with Run as administrator for this action.", restart: false, admin: true, reversible: true, available: ok, reason: why },
        Opt { id: "temp_cleanup", title: "Clean old temporary files", what: "Deletes files older than 24 hours from your user temp folder.", why: "Frees disk space. It does not by itself make the PC faster.", tradeoffs: "Deleted files cannot be restored. Files in use are skipped.", restart: false, admin: false, reversible: false, available: ok, reason: why },
    ]
}

#[tauri::command]
fn opt_snapshots(app: tauri::AppHandle) -> Value { read_snaps(&app) }

#[tauri::command]
async fn opt_preview(id: String) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_, String> { match id.as_str() {
        "power_plan" => {
            let p = plans()?;
            let cur = p.iter().find(|x| x.2).map(|x| x.1.clone());
            Ok(Preview {
                summary: format!("Current plan: {}. Choose the plan to switch to.", cur.clone().unwrap_or_else(|| "unknown".into())),
                choices: p.iter().filter(|x| !x.2).map(|x| Choice { value: x.0.clone(), label: x.1.clone() }).collect(),
                current: cur,
            })
        }
        "temp_cleanup" => {
            let mut s = Stats::default();
            sweep(&temp_root()?, false, &mut s, cutoff());
            Ok(Preview { summary: format!("{} files ({}) older than 24 hours would be deleted.", s.files, mb(s.bytes)), choices: vec![], current: None })
        }
        _ => Err("Unknown optimization.".into()),
    } }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn opt_apply(app: tauri::AppHandle, id: String, value: Option<String>) -> Result<Applied, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<_, String> { match id.as_str() {
        "power_plan" => {
            let target = value.ok_or("No plan selected.")?;
            let p = plans()?; // allowlist: only plans Windows reports
            let (_, name, _) = p.iter().find(|x| x.0 == target).ok_or("That plan is not available.")?.clone();
            let (prev, _, _) = p.iter().find(|x| x.2).ok_or("Could not determine the current plan.")?.clone();
            if prev == target { return Err("That plan is already active.".into()); }
            // Save rollback state before touching the system, so we never change the
            // plan without a way back. If powercfg then fails, discard the snapshot
            // again, so no phantom "Roll back" button is left for a change that never
            // happened.
            let mut s = read_snaps(&app);
            s["power_plan"] = json!({ "previous": prev, "time": SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) });
            write_snaps(&app, &s)?;
            if let Err(e) = run("powercfg", &["/setactive", &target]) {
                s.as_object_mut().map(|o| o.remove("power_plan"));
                let _ = write_snaps(&app, &s); // best effort; report the original failure
                return Err(format!("{} Switching the active power plan needs Administrator rights: start STRYV with Run as administrator and try again.", e));
            }
            Ok(Applied { message: format!("Power plan switched to {}.", name) })
        }
        "temp_cleanup" => {
            let mut s = Stats::default();
            sweep(&temp_root()?, true, &mut s, cutoff());
            Ok(Applied { message: format!("Deleted {} files ({}). {} could not be removed.", s.files, mb(s.bytes), s.failed) })
        }
        _ => Err("Unknown optimization.".into()),
    } }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn opt_rollback(app: tauri::AppHandle, id: String) -> Result<Applied, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Applied, String> {
        if id != "power_plan" { return Err("This optimization cannot be rolled back.".to_string()); }
        let mut s = read_snaps(&app);
        let prev = s["power_plan"]["previous"].as_str().ok_or("No saved state to restore.")?.to_string();
        if !plans()?.iter().any(|x| x.0 == prev) { return Err("The previous power plan no longer exists.".into()); }
        run("powercfg", &["/setactive", &prev])?;
        s.as_object_mut().map(|o| o.remove("power_plan"));
        write_snaps(&app, &s)?;
        Ok(Applied { message: "Previous power plan restored.".into() })
    }).await.map_err(|e| e.to_string())?
}

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

fn startup_items() -> Result<Vec<StartupItem>, String> {
    let out = run("reg", &["query", RUN_KEY])?;
    // StartupApproved holds Windows' own enabled/disabled flag; a missing value means enabled.
    let approved = run("reg", &["query", APPROVED_KEY]).unwrap_or_default();
    let disabled: Vec<String> = approved.lines().filter_map(|l| {
        let (name, data) = l.trim().split_once("    REG_BINARY")?;
        let first = u8::from_str_radix(data.trim().get(0..2)?, 16).ok()?;
        if first & 1 == 1 { Some(name.trim().to_string()) } else { None }
    }).collect();
    Ok(out.lines().filter_map(|l| {
        let (name, rest) = l.trim().split_once("    REG_")?;
        let command = rest.splitn(2, "    ").nth(1).unwrap_or("").trim().to_string();
        let name = name.trim().to_string();
        let enabled = !disabled.contains(&name);
        Some(StartupItem { name, command, enabled })
    }).collect())
}

#[tauri::command]
async fn opt_startup() -> Result<Vec<StartupItem>, String> {
    tauri::async_runtime::spawn_blocking(|| startup_items()).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn opt_startup_set(name: String, enabled: bool) -> Result<Applied, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Applied, String> {
        // Allowlist: only entries that actually exist in the user's Run key.
        if !startup_items()?.iter().any(|i| i.name == name) { return Err("That startup entry no longer exists.".into()); }
        let data = if enabled { "020000000000000000000000" } else { "030000000000000000000000" };
        run("reg", &["add", APPROVED_KEY, "/v", &name, "/t", "REG_BINARY", "/d", data, "/f"])?;
        Ok(Applied { message: format!("{} will {} at next sign-in.", name, if enabled { "start" } else { "no longer start" }) })
    }).await.map_err(|e| e.to_string())?
}

// ---------- Sensors: report only what the system actually returns ----------
#[derive(Serialize)]
struct Gpu { name: String, util: Option<f64>, mem_used: Option<f64>, mem_total: Option<f64>, temp: Option<f64>, clock: Option<f64> }
#[derive(Serialize)]
struct Temp { label: String, celsius: f32 }
#[derive(Serialize)]
struct Link { name: String, speed: String }

#[tauri::command]
async fn get_gpu() -> Result<Vec<Gpu>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<Gpu>, String> {
        // NVIDIA only (nvidia-smi ships with the NVIDIA driver). Other vendors are not read yet.
        let out = run("nvidia-smi", &["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,clocks.sm", "--format=csv,noheader,nounits"])
            .map_err(|_| "No NVIDIA GPU tool was found. AMD and Intel GPU readings are not supported yet.".to_string())?;
        let n = |s: Option<&str>| s.and_then(|x| x.trim().parse::<f64>().ok());
        Ok(out.lines().filter(|l| !l.trim().is_empty()).map(|l| {
            let mut p = l.split(',');
            Gpu { name: p.next().unwrap_or("GPU").trim().to_string(), util: n(p.next()), mem_used: n(p.next()), mem_total: n(p.next()), temp: n(p.next()), clock: n(p.next()) }
        }).collect())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_temps() -> Vec<Temp> {
    tauri::async_runtime::spawn_blocking(|| {
        Components::new_with_refreshed_list().iter()
            .map(|c| Temp { label: c.label().to_string(), celsius: c.temperature() })
            .filter(|t| t.celsius.is_finite() && t.celsius > 0.0)
            .collect()
    }).await.unwrap_or_default()
}

#[tauri::command]
async fn get_link_speeds() -> Result<Vec<Link>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<Link>, String> {
        let out = run("powershell", &["-NoProfile", "-NonInteractive", "-Command", "Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object Name,LinkSpeed | ConvertTo-Json -Compress"])?;
        let v: Value = serde_json::from_str(out.trim()).map_err(|e| e.to_string())?;
        let items = match v { Value::Array(a) => a, o @ Value::Object(_) => vec![o], _ => vec![] };
        Ok(items.iter().filter_map(|i| Some(Link { name: i["Name"].as_str()?.to_string(), speed: i["LinkSpeed"].as_str()?.to_string() })).collect())
    }).await.map_err(|e| e.to_string())?
}

// ---------- ATLAS: game discovery ----------
// Reads the files the launchers have already written. Nothing is launched,
// changed or written back; this only looks.

#[derive(Serialize)]
struct Game { launcher: &'static str, app_id: String, name: String, install_dir: String, size_bytes: u64, last_played: u64 }

// Valve KeyValues text, as Steam writes it. Only what discovery needs: quoted
// keys, quoted or bare values, nested blocks, and // comments.
enum Vdf { Val(String), Obj(Vec<(String, Vdf)>) }

struct VdfReader<'a> { s: &'a [u8], i: usize }

impl<'a> VdfReader<'a> {
    fn new(s: &'a str) -> Self { VdfReader { s: s.as_bytes(), i: 0 } }

    fn ws(&mut self) {
        loop {
            while self.i < self.s.len() && self.s[self.i] <= b' ' { self.i += 1; }
            if self.i + 1 < self.s.len() && self.s[self.i] == b'/' && self.s[self.i + 1] == b'/' {
                while self.i < self.s.len() && self.s[self.i] != b'\n' { self.i += 1; }
                continue;
            }
            return;
        }
    }

    fn quoted(&mut self) -> Option<String> {
        self.ws();
        if self.i >= self.s.len() || self.s[self.i] != b'"' { return None; }
        self.i += 1;
        let mut out: Vec<u8> = Vec::new();
        while self.i < self.s.len() {
            let c = self.s[self.i];
            self.i += 1;
            if c == b'"' { return Some(String::from_utf8_lossy(&out).into_owned()); }
            // \" and \\ are escaped in KeyValues; keep the second byte literally.
            if c == b'\\' && self.i < self.s.len() { out.push(self.s[self.i]); self.i += 1; } else { out.push(c); }
        }
        None
    }

    fn bare(&mut self) -> Option<String> {
        let start = self.i;
        while self.i < self.s.len() && self.s[self.i] > b' ' && self.s[self.i] != b'}' { self.i += 1; }
        if self.i > start { Some(String::from_utf8_lossy(&self.s[start..self.i]).into_owned()) } else { None }
    }

    fn obj(&mut self) -> Vec<(String, Vdf)> {
        let mut v: Vec<(String, Vdf)> = Vec::new();
        loop {
            self.ws();
            if self.i >= self.s.len() { return v; }
            if self.s[self.i] == b'}' { self.i += 1; return v; }
            let Some(k) = self.quoted() else { return v; };
            self.ws();
            if self.i < self.s.len() && self.s[self.i] == b'{' {
                self.i += 1;
                v.push((k, Vdf::Obj(self.obj())));
            } else {
                match self.quoted() {
                    Some(val) => v.push((k, Vdf::Val(val))),
                    None => match self.bare() { Some(b) => v.push((k, Vdf::Val(b))), None => return v },
                }
            }
        }
    }
}

fn read_vdf(p: &Path) -> Option<Vec<(String, Vdf)>> {
    let t = std::fs::read_to_string(p).ok()?;
    let mut r = VdfReader::new(&t);
    Some(r.obj())
}
fn vdf_obj<'t>(node: &'t [(String, Vdf)], key: &str) -> Option<&'t Vec<(String, Vdf)>> {
    for (k, v) in node { if k == key { if let Vdf::Obj(c) = v { return Some(c); } } }
    None
}
fn vdf_val(node: &[(String, Vdf)], key: &str) -> Option<String> {
    for (k, v) in node { if k == key { if let Vdf::Val(val) = v { return Some(val.clone()); } } }
    None
}
fn vdf_u64(node: &[(String, Vdf)], key: &str) -> u64 {
    vdf_val(node, key).and_then(|v| v.parse().ok()).unwrap_or(0)
}

fn steam_dir() -> Option<PathBuf> {
    if let Ok(out) = run("reg", &["query", r"HKCU\Software\Valve\Steam", "/v", "SteamPath"]) {
        for l in out.lines() {
            if let Some((_, v)) = l.split_once("    REG_SZ") {
                let p = v.trim().trim_matches('"');
                if !p.is_empty() { return Some(PathBuf::from(p)); }
            }
        }
    }
    let d = PathBuf::from(r"C:\Program Files (x86)\Steam");
    if d.join("steamapps").is_dir() { Some(d) } else { None }
}

fn steam_libraries(steam: &Path) -> Vec<PathBuf> {
    let Some(root) = read_vdf(&steam.join("steamapps").join("libraryfolders.vdf")) else { return Vec::new(); };
    let Some(libs) = vdf_obj(&root, "libraryfolders") else { return Vec::new(); };
    let mut out: Vec<PathBuf> = Vec::new();
    for (key, node) in libs {
        match node {
            // Current format: "0" { "path" "C:\\..." ... }
            Vdf::Obj(fields) => { if let Some(p) = vdf_val(fields, "path") { out.push(PathBuf::from(p)); } }
            // Older format: "0"  "C:\\..." with no block around it.
            Vdf::Val(p) => { if !key.is_empty() && key.chars().all(|c| c.is_ascii_digit()) { out.push(PathBuf::from(p)); } }
        }
    }
    out
}

fn steam_games(lib: &Path) -> Vec<Game> {
    let apps = lib.join("steamapps");
    let Ok(rd) = std::fs::read_dir(&apps) else { return Vec::new(); };
    let mut out: Vec<Game> = Vec::new();
    for e in rd.flatten() {
        // Bind the lossy name to a variable first: strip_prefix borrows from it,
        // and a temporary would be dropped at the end of the let statement.
        let fname = e.file_name();
        let fname = fname.to_string_lossy();
        let Some(rest) = fname.strip_prefix("appmanifest_") else { continue; };
        let Some(digits) = rest.strip_suffix(".acf") else { continue; };
        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) { continue; }
        let Some(root) = read_vdf(&e.path()) else { continue; };
        let Some(state) = vdf_obj(&root, "AppState") else { continue; };
        let (Some(name), Some(dir)) = (vdf_val(state, "name"), vdf_val(state, "installdir")) else { continue; };
        out.push(Game {
            launcher: "Steam",
            app_id: vdf_val(state, "appid").unwrap_or_default(),
            name,
            install_dir: apps.join("common").join(dir).to_string_lossy().into_owned(),
            size_bytes: vdf_u64(state, "SizeOnDisk"),
            last_played: vdf_u64(state, "LastPlayed"),
        });
    }
    out
}

#[tauri::command]
async fn atlas_scan() -> Vec<Game> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut games: Vec<Game> = Vec::new();
        if let Some(steam) = steam_dir() {
            let mut libs = steam_libraries(&steam);
            if libs.is_empty() { libs.push(steam); }
            for lib in libs { games.extend(steam_games(&lib)); }
        }
        games.sort_by(|a, b| b.last_played.cmp(&a.last_played).then(a.name.cmp(&b.name)));
        games
    }).await.unwrap_or_default()
}

fn steam_uri_registered() -> bool {
    run("reg", &["query", r"HKCU\Software\Classes\steam\shell\open\command"]).is_ok()
}

// Launching is a separate, explicit action from scanning. The frontend may only
// name an app: it never supplies a path or a command line.
#[tauri::command]
async fn atlas_launch(appid: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let t = appid.trim();
        // Bare decimal only, and it must round-trip, so nothing but digits can
        // reach the URL that is built below.
        let id: u64 = t.parse().map_err(|_| "That is not a valid Steam app id.".to_string())?;
        if id.to_string() != t { return Err("That is not a valid Steam app id.".to_string()); }

        let steam = steam_dir().ok_or_else(|| "Steam does not appear to be installed on this PC.".to_string())?;
        if !steam_uri_registered() { return Err("Steam's link handler is not registered, so STRYV cannot ask it to launch a game.".to_string()); }

        // Allowlist: the id must be one this scan actually found on this PC, so the
        // frontend cannot ask for an arbitrary id.
        let mut libs = steam_libraries(&steam);
        if libs.is_empty() { libs.push(steam); }
        let known = libs.iter().flat_map(|l| steam_games(l)).any(|g| g.app_id == t);
        if !known { return Err("That game is not in the Steam library STRYV can see.".to_string()); }

        // steam://rungameid/<id> is Steam's own protocol; explorer.exe only resolves
        // the registered handler. The URL is assembled here from a validated integer,
        // so no part of it comes from the frontend. Spawned, not waited on, so a slow
        // handler cannot block the caller.
        let url = format!("steam://rungameid/{}", id);
        let mut c = std::process::Command::new("explorer");
        c.arg(&url);
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; c.creation_flags(0x08000000); }
        c.spawn().map_err(|e| format!("Could not ask Steam to launch the game: {}.", e))?;
        Ok(format!("Steam was asked to launch this game (app {}). If nothing starts, open Steam and check you are signed in.", id))
    }).await.map_err(|e| e.to_string())?
}

fn main() {
    let mut sys = System::new();
    sys.refresh_cpu_usage();
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Signed self-update. The public key lives in tauri.conf.json; Tauri
            // refuses any artifact whose signature does not match it.
            app.handle().plugin(tauri_plugin_updater::Builder::new().build());
            // Safety net: the frontend shows the window once the intro has painted.
            if let Some(w) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    let _ = w.show();
                });
            }
            Ok(())
        })
        .manage(Monitor(Mutex::new(sys)))
        .manage(Net(Mutex::new((Networks::new_with_refreshed_list(), Instant::now()))))
        .invoke_handler(tauri::generate_handler![get_snapshot, get_system_info, get_processes, get_network, run_network_tests, opt_catalog, opt_snapshots, opt_preview, opt_apply, opt_rollback, opt_startup, opt_startup_set, get_gpu, get_temps, get_link_speeds, atlas_scan, atlas_launch])
        .run(tauri::generate_context!())
        .expect("error while running STRYV");
}
