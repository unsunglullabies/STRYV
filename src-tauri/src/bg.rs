// Background mode for STRYV.
//
// Everything here runs in Rust on purpose: a hidden window's page is throttled by the
// browser engine, so only native threads can watch the PC reliably. Alerts state only what
// was measured (a reading, the limit, the biggest user), never a guess about the cause.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Components, Disks, Pid, ProcessesToUpdate, System};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

const CFG_FILE: &str = "alerts.json";
const TRAY_ID: &str = "stryv-tray";

// ---------------------------------------------------------------- settings

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct AlertCfg {
    /// Closing the window keeps STRYV running in the tray instead of quitting.
    pub background: bool,
    /// Master switch for notifications.
    pub enabled: bool,
    pub cpu: bool,
    pub cpu_pct: f32,
    pub cpu_secs: u64,
    pub mem: bool,
    pub mem_pct: f32,
    pub mem_secs: u64,
    pub disk: bool,
    pub disk_free_pct: f32,
    pub temp: bool,
    pub temp_c: f32,
    pub cooldown_mins: u64,
}

impl Default for AlertCfg {
    fn default() -> Self {
        AlertCfg {
            background: true,
            enabled: true,
            cpu: true,
            cpu_pct: 90.0,
            cpu_secs: 60,
            mem: true,
            mem_pct: 92.0,
            mem_secs: 60,
            disk: true,
            disk_free_pct: 8.0,
            temp: true,
            temp_c: 90.0,
            cooldown_mins: 15,
        }
    }
}

impl AlertCfg {
    fn clamped(mut self) -> Self {
        self.cpu_pct = self.cpu_pct.clamp(50.0, 100.0);
        self.cpu_secs = self.cpu_secs.clamp(10, 600);
        self.mem_pct = self.mem_pct.clamp(50.0, 100.0);
        self.mem_secs = self.mem_secs.clamp(10, 600);
        self.disk_free_pct = self.disk_free_pct.clamp(1.0, 50.0);
        self.temp_c = self.temp_c.clamp(60.0, 110.0);
        self.cooldown_mins = self.cooldown_mins.clamp(1, 240);
        self
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct AlertEvent {
    pub at: u64,
    pub kind: String,
    pub title: String,
    pub body: String,
}

pub struct Bg {
    cfg: Mutex<AlertCfg>,
    history: Mutex<VecDeque<AlertEvent>>,
    tasks: Mutex<System>,
    paused: AtomicBool,
    hinted: AtomicBool,
}

fn cfg_path(app: &AppHandle) -> Option<PathBuf> {
    let d = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&d).ok()?;
    Some(d.join(CFG_FILE))
}

fn load_cfg(app: &AppHandle) -> AlertCfg {
    cfg_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<AlertCfg>(&s).ok())
        .unwrap_or_default()
        .clamped()
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---------------------------------------------------------------- task manager

#[derive(Serialize)]
pub struct TaskRow {
    pub pid: u32,
    pub name: String,
    pub cpu: f32,
    pub mem: u64,
    pub exe: String,
    pub started: u64,
    pub parent: u32,
    pub protected: bool,
    pub caution: bool,
}

// Ending these would crash Windows or disable its protection, so STRYV refuses.
const PROTECTED: &[&str] = &[
    "system", "system idle process", "registry", "memory compression", "secure system", "smss.exe",
    "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe", "svchost.exe", "dwm.exe",
    "fontdrvhost.exe", "sihost.exe", "taskhostw.exe", "ctfmon.exe", "audiodg.exe", "msmpeng.exe",
    "nissrv.exe", "securityhealthservice.exe", "wudfhost.exe", "spoolsv.exe", "stryv.exe",
];
const CAUTION: &[&str] = &["explorer.exe"];

fn is_protected(pid: u32, name: &str) -> bool {
    pid == 0 || pid == 4 || pid == std::process::id() || PROTECTED.contains(&name.to_lowercase().as_str())
}

#[tauri::command(async)]
pub fn task_list(bg: State<Bg>) -> Vec<TaskRow> {
    let mut s = bg.tasks.lock().unwrap();
    s.refresh_processes(ProcessesToUpdate::All, true);
    // sysinfo reports a process's CPU as a share of one core; Task Manager shows a share of all of them.
    let cores = s.cpus().len().max(1) as f32;
    s.processes()
        .values()
        .map(|p| {
            let name = p.name().to_string_lossy().into_owned();
            let pid = p.pid().as_u32();
            TaskRow {
                pid,
                protected: is_protected(pid, &name),
                caution: CAUTION.contains(&name.to_lowercase().as_str()),
                cpu: p.cpu_usage() / cores,
                mem: p.memory(),
                exe: p.exe().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default(),
                started: p.start_time(),
                parent: p.parent().map(|x| x.as_u32()).unwrap_or(0),
                name,
            }
        })
        .collect()
}

#[derive(Deserialize)]
pub struct TaskRef {
    pub pid: u32,
    pub name: String,
}

/// The caller passes the name it saw, so a recycled process id can never end an unrelated program.
fn end_one(s: &System, pid: u32, name: &str) -> Result<(), String> {
    let p = s.process(Pid::from_u32(pid)).ok_or_else(|| "That program has already closed.".to_string())?;
    let actual = p.name().to_string_lossy().into_owned();
    if actual != name {
        return Err("That number now belongs to a different program. Refresh the list and try again.".into());
    }
    if is_protected(pid, &actual) {
        return Err(format!("{} is part of Windows or STRYV, so STRYV will not end it.", actual));
    }
    if p.kill() {
        Ok(())
    } else {
        Err("Windows refused to end it. It may need administrator rights.".into())
    }
}

#[tauri::command(async)]
pub fn task_end(bg: State<Bg>, pid: u32, name: String) -> Result<String, String> {
    let mut s = bg.tasks.lock().unwrap();
    s.refresh_processes(ProcessesToUpdate::All, true);
    end_one(&s, pid, &name)?;
    Ok(format!("Ended {}.", name))
}

/// Ends several processes under one process-list refresh (used for a program with many processes).
#[tauri::command(async)]
pub fn task_end_many(bg: State<Bg>, items: Vec<TaskRef>) -> Result<String, String> {
    let mut s = bg.tasks.lock().unwrap();
    s.refresh_processes(ProcessesToUpdate::All, true);
    let mut ended = 0usize;
    let mut first_err: Option<String> = None;
    for it in &items {
        match end_one(&s, it.pid, &it.name) {
            Ok(()) => ended += 1,
            Err(e) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
    }
    if ended == 0 {
        return Err(first_err.unwrap_or_else(|| "There was nothing to end.".into()));
    }
    let name = items.first().map(|i| i.name.clone()).unwrap_or_default();
    Ok(if ended == items.len() {
        if ended == 1 { format!("Ended {}.", name) } else { format!("Ended {} ({} processes).", name, ended) }
    } else {
        format!("Ended {} of {} {} processes.", ended, items.len(), name)
    })
}

// ---------------------------------------------------------------- alert commands

#[tauri::command]
pub fn alerts_get(bg: State<Bg>) -> AlertCfg {
    bg.cfg.lock().unwrap().clone()
}

#[tauri::command]
pub fn alerts_set(app: AppHandle, bg: State<Bg>, cfg: AlertCfg) -> Result<(), String> {
    let cfg = cfg.clamped();
    if let Some(p) = cfg_path(&app) {
        let json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
        std::fs::write(p, json).map_err(|e| e.to_string())?;
    }
    *bg.cfg.lock().unwrap() = cfg;
    Ok(())
}

#[tauri::command]
pub fn alerts_recent(bg: State<Bg>) -> Vec<AlertEvent> {
    bg.history.lock().unwrap().iter().rev().cloned().collect()
}

#[tauri::command]
pub fn alerts_clear(bg: State<Bg>) {
    bg.history.lock().unwrap().clear();
}

#[tauri::command]
pub fn alerts_test(app: AppHandle, bg: State<Bg>) -> Result<(), String> {
    raise(&app, &bg, "test", "STRYV test notification".into(), "If you can read this, alerts will reach you even when the window is closed.".into(), true)
}

// ---------------------------------------------------------------- raising an alert

fn raise(app: &AppHandle, bg: &Bg, kind: &str, title: String, body: String, force: bool) -> Result<(), String> {
    let ev = AlertEvent { at: now_secs(), kind: kind.to_string(), title: title.clone(), body: body.clone() };
    {
        let mut h = bg.history.lock().unwrap();
        h.push_back(ev.clone());
        while h.len() > 50 {
            h.pop_front();
        }
    }
    let _ = app.emit("stryv-alert", &ev);
    if force || !bg.paused.load(Ordering::Relaxed) {
        app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------- the monitor

/// "Bad for long enough" detector: fires once the condition has held for `hold`, then stays
/// quiet for `cooldown` even if the condition continues, and re-arms when it clears.
#[derive(Default)]
struct Rule {
    since: Option<Instant>,
    fired: Option<Instant>,
}

impl Rule {
    fn check(&mut self, bad: bool, hold: Duration, cooldown: Duration, now: Instant) -> bool {
        if !bad {
            self.since = None;
            return false;
        }
        let since = *self.since.get_or_insert(now);
        let held = now.duration_since(since) >= hold;
        let cooled = self.fired.map_or(true, |t| now.duration_since(t) >= cooldown);
        if held && cooled {
            self.fired = Some(now);
            return true;
        }
        false
    }
}

fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1_073_741_824.0)
}

/// The program using the most CPU or memory right now, as a short phrase, measured at alert time.
fn biggest_user(by_mem: bool) -> String {
    let mut s = System::new();
    s.refresh_processes(ProcessesToUpdate::All, true);
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(Duration::from_millis(300)));
    s.refresh_processes(ProcessesToUpdate::All, true);
    let cores = s.cpus().len().max(1) as f32;
    let best = if by_mem {
        s.processes().values().max_by_key(|p| p.memory())
    } else {
        s.processes().values().max_by(|a, b| a.cpu_usage().partial_cmp(&b.cpu_usage()).unwrap_or(std::cmp::Ordering::Equal))
    };
    match best {
        Some(p) if by_mem => format!(" Biggest user: {} ({}).", p.name().to_string_lossy(), gb(p.memory())),
        Some(p) => format!(" Biggest user: {} ({:.0}%).", p.name().to_string_lossy(), p.cpu_usage() / cores),
        None => String::new(),
    }
}

/// Highest temperature STRYV can read, with the sensor's name.
fn hottest(gpu_ok: &mut bool) -> Option<(String, f32)> {
    let mut best: Option<(String, f32)> = None;
    for c in Components::new_with_refreshed_list().iter() {
        let t = c.temperature();
        if t.is_finite() && t > 0.0 && best.as_ref().map_or(true, |b| t > b.1) {
            best = Some((c.label().to_string(), t));
        }
    }
    if *gpu_ok {
        match crate::run("nvidia-smi", &["--query-gpu=temperature.gpu,name", "--format=csv,noheader,nounits"]) {
            Ok(out) => {
                if let Some(line) = out.lines().next() {
                    let mut it = line.splitn(2, ',');
                    if let (Some(t), Some(n)) = (it.next(), it.next()) {
                        if let Ok(t) = t.trim().parse::<f32>() {
                            if best.as_ref().map_or(true, |b| t > b.1) {
                                best = Some((n.trim().to_string(), t));
                            }
                        }
                    }
                }
            }
            Err(_) => *gpu_ok = false, // no NVIDIA tool on this PC: stop trying
        }
    }
    best
}

fn monitor(app: AppHandle) {
    let mut sys = System::new();
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    std::thread::sleep(Duration::from_secs(5));

    let (mut cpu_r, mut mem_r, mut temp_r) = (Rule::default(), Rule::default(), Rule::default());
    let mut disk_r: HashMap<String, Rule> = HashMap::new();
    let mut gpu_ok = true;
    let mut last_temp_check = Instant::now() - Duration::from_secs(60);
    let mut temp_now: Option<(String, f32)> = None;

    loop {
        let bg = app.state::<Bg>();
        let cfg = bg.cfg.lock().unwrap().clone();
        let now = Instant::now();
        let cooldown = Duration::from_secs(cfg.cooldown_mins * 60);

        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let cpu = sys.global_cpu_usage();
        let (used, total) = (sys.used_memory(), sys.total_memory().max(1));
        let mem_pct = used as f32 / total as f32 * 100.0;

        if cfg.temp && now.duration_since(last_temp_check) >= Duration::from_secs(20) {
            temp_now = hottest(&mut gpu_ok);
            last_temp_check = now;
        }

        // Live tooltip: hover the tray icon to see the PC's state without opening anything.
        if let Some(t) = app.tray_by_id(TRAY_ID) {
            let mut tip = format!("STRYV  CPU {:.0}%  Memory {:.0}%", cpu, mem_pct);
            if let Some((_, c)) = &temp_now {
                tip.push_str(&format!("  {:.0} C", c));
            }
            if bg.paused.load(Ordering::Relaxed) {
                tip.push_str("  (alerts paused)");
            }
            let _ = t.set_tooltip(Some(tip));
        }

        if cfg.enabled {
            if cfg.cpu && cpu_r.check(cpu > cfg.cpu_pct, Duration::from_secs(cfg.cpu_secs), cooldown, now) {
                let who = biggest_user(false);
                let _ = raise(&app, &bg, "cpu", format!("CPU has been above {:.0}% for {}", cfg.cpu_pct, span(cfg.cpu_secs)),
                    format!("CPU is at {:.0}%.{}", cpu, who), false);
            }
            if cfg.mem && mem_r.check(mem_pct > cfg.mem_pct, Duration::from_secs(cfg.mem_secs), cooldown, now) {
                let who = biggest_user(true);
                let _ = raise(&app, &bg, "memory", format!("Memory has been above {:.0}% for {}", cfg.mem_pct, span(cfg.mem_secs)),
                    format!("Memory is at {:.0}% ({} of {}).{}", mem_pct, gb(used), gb(total), who), false);
            }
            if cfg.disk {
                let disks = Disks::new_with_refreshed_list();
                for d in disks.list() {
                    let (tot, free) = (d.total_space(), d.available_space());
                    if tot < 8 * 1_073_741_824 || d.is_removable() {
                        continue; // ignore tiny partitions and USB sticks
                    }
                    let pct = free as f32 / tot as f32 * 100.0;
                    let key = d.mount_point().to_string_lossy().into_owned();
                    let rule = disk_r.entry(key.clone()).or_default();
                    if rule.check(pct < cfg.disk_free_pct, Duration::ZERO, cooldown, now) {
                        let _ = raise(&app, &bg, "disk", format!("{} is almost full", key),
                            format!("{} has {:.0}% free ({} of {}).", key, pct, gb(free), gb(tot)), false);
                    }
                }
            }
            if cfg.temp {
                let hot = temp_now.as_ref().map_or(false, |(_, c)| *c >= cfg.temp_c);
                if temp_r.check(hot, Duration::from_secs(40), cooldown, now) {
                    if let Some((label, c)) = &temp_now {
                        let _ = raise(&app, &bg, "temperature", format!("{} is running hot", label),
                            format!("{} is at {:.0} C (your limit is {:.0} C).", label, c, cfg.temp_c), false);
                    }
                }
            }
        }
        drop(bg);
        std::thread::sleep(Duration::from_secs(5));
    }
}

fn span(secs: u64) -> String {
    if secs % 60 == 0 {
        let m = secs / 60;
        format!("{} minute{}", m, if m == 1 { "" } else { "s" })
    } else {
        format!("{} seconds", secs)
    }
}

// ---------------------------------------------------------------- tray and window

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", "Open STRYV", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause alerts", true, false, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit STRYV", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pause, &sep, &quit])?;

    let mut b = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("STRYV is watching your PC")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "pause" => {
                let bg = app.state::<Bg>();
                let now = !bg.paused.load(Ordering::Relaxed);
                bg.paused.store(now, Ordering::Relaxed);
                let _ = pause.set_checked(now);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

/// Closing the window hides it to the tray (when background mode is on) so monitoring continues.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() != "main" {
            return;
        }
        let app = window.app_handle();
        if let Some(bg) = app.try_state::<Bg>() {
            if bg.cfg.lock().map(|c| c.background).unwrap_or(false) {
                api.prevent_close();
                let _ = window.hide();
                if !bg.hinted.swap(true, Ordering::Relaxed) {
                    let _ = app
                        .notification()
                        .builder()
                        .title("STRYV is still running")
                        .body("It keeps watching your PC from the tray. Right-click the tray icon to quit.")
                        .show();
                }
            }
        }
    }
}

pub fn init(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let cfg = load_cfg(&handle);
    app.manage(Bg {
        cfg: Mutex::new(cfg),
        history: Mutex::new(VecDeque::new()),
        tasks: Mutex::new(System::new()),
        paused: AtomicBool::new(false),
        hinted: AtomicBool::new(false),
    });
    build_tray(&handle)?;
    std::thread::Builder::new().name("stryv-monitor".into()).spawn(move || monitor(handle))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_waits_for_the_hold_time() {
        let t0 = Instant::now();
        let mut r = Rule::default();
        let (hold, cool) = (Duration::from_secs(60), Duration::from_secs(900));
        assert!(!r.check(true, hold, cool, t0));
        assert!(!r.check(true, hold, cool, t0 + Duration::from_secs(59)));
        assert!(r.check(true, hold, cool, t0 + Duration::from_secs(60)));
    }

    #[test]
    fn rule_stays_quiet_during_the_cooldown_then_reminds() {
        let t0 = Instant::now();
        let mut r = Rule::default();
        let (hold, cool) = (Duration::from_secs(10), Duration::from_secs(900));
        r.check(true, hold, cool, t0);
        assert!(r.check(true, hold, cool, t0 + Duration::from_secs(10)));
        assert!(!r.check(true, hold, cool, t0 + Duration::from_secs(300)));
        assert!(r.check(true, hold, cool, t0 + Duration::from_secs(10 + 900)));
    }

    #[test]
    fn rule_resets_when_the_problem_clears() {
        let t0 = Instant::now();
        let mut r = Rule::default();
        let (hold, cool) = (Duration::from_secs(60), Duration::from_secs(1));
        r.check(true, hold, cool, t0);
        assert!(!r.check(false, hold, cool, t0 + Duration::from_secs(50)));
        // the clock starts over: 10 s after it came back is not 60 s of trouble
        assert!(!r.check(true, hold, cool, t0 + Duration::from_secs(60)));
        assert!(!r.check(true, hold, cool, t0 + Duration::from_secs(119)));
        assert!(r.check(true, hold, cool, t0 + Duration::from_secs(120)));
    }

    #[test]
    fn disk_rules_fire_immediately_with_zero_hold() {
        let mut r = Rule::default();
        assert!(r.check(true, Duration::ZERO, Duration::from_secs(900), Instant::now()));
    }

    #[test]
    fn protected_programs_cannot_be_ended() {
        assert!(is_protected(1234, "CSRSS.EXE"));
        assert!(is_protected(1234, "svchost.exe"));
        assert!(is_protected(4, "anything"));
        assert!(is_protected(std::process::id(), "whatever"));
        assert!(!is_protected(1234, "notepad.exe"));
        assert!(!is_protected(1234, "chrome.exe"));
    }

    #[test]
    fn settings_are_clamped_to_sane_ranges() {
        let c = AlertCfg { cpu_pct: 10.0, cpu_secs: 1, disk_free_pct: 90.0, cooldown_mins: 0, ..Default::default() }.clamped();
        assert_eq!((c.cpu_pct, c.cpu_secs, c.disk_free_pct, c.cooldown_mins), (50.0, 10, 50.0, 1));
    }

    #[test]
    fn durations_read_naturally() {
        assert_eq!(span(30), "30 seconds");
        assert_eq!(span(60), "1 minute");
        assert_eq!(span(120), "2 minutes");
    }
}
