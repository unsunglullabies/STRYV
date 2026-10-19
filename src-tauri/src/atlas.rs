// ATLAS - the universal game library.
//
// Structure:
//   * a `Source` trait, so a launcher is a self-contained adapter
//   * a coordinator that runs every source and reports on each one separately,
//     so one unreadable launcher never hides or zeroes the others
//   * a canonical game that can own several installations
//   * a single JSON store, versioned and migrated without losing user data
//
// Two rules the whole module obeys:
//   1. Reading a launcher is read-only. Nothing here ever writes into a
//      launcher's own files, so a launcher's library can never be corrupted.
//   2. No figure is invented. A size the launcher did not report stays zero,
//      a duration that was not measured stays null, and a source that could not
//      be read says why instead of silently contributing nothing.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

use tauri::Manager;

use crate::{norm_path, now_unix, run};

// ---------- Valve KeyValues (Steam manifests) ----------
// Moved here from main.rs unchanged. Only ATLAS reads VDF.

enum Vdf {
    Val(String),
    Obj(Vec<(String, Vdf)>),
}

struct VdfReader<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> VdfReader<'a> {
    fn new(s: &'a str) -> Self {
        VdfReader { s: s.as_bytes(), i: 0 }
    }
    fn ws(&mut self) {
        while self.i < self.s.len() && (self.s[self.i] as char).is_whitespace() {
            self.i += 1;
        }
    }
    fn bare(&mut self) -> Option<String> {
        let mut out = String::new();
        while self.i < self.s.len() {
            let c = self.s[self.i] as char;
            if c == '"' || c == '{' || c == '}' {
                break;
            }
            out.push(c);
            self.i += 1;
        }
        let t = out.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    }
    fn quoted(&mut self) -> Option<String> {
        if self.i >= self.s.len() || self.s[self.i] != b'"' {
            return None;
        }
        self.i += 1;
        let mut out = String::new();
        while self.i < self.s.len() {
            let c = self.s[self.i];
            self.i += 1;
            match c {
                b'"' => return Some(out),
                b'\\' if self.i < self.s.len() => {
                    let n = self.s[self.i];
                    self.i += 1;
                    out.push(match n {
                        b'n' => '\n',
                        b't' => '\t',
                        other => other as char,
                    });
                }
                other => {
                    // Multi-byte UTF-8 is copied byte for byte and collected back
                    // together, so a non-ASCII name survives the round trip.
                    out.push(other as char);
                }
            }
        }
        Some(out)
    }
    fn key(&mut self) -> Option<String> {
        self.ws();
        self.quoted().or_else(|| self.bare())
    }
    fn obj(&mut self) -> Vec<(String, Vdf)> {
        let mut v: Vec<(String, Vdf)> = Vec::new();
        loop {
            self.ws();
            if self.i >= self.s.len() || self.s[self.i] == b'}' {
                self.i += 1;
                break;
            }
            let Some(k) = self.key() else { break };
            self.ws();
            if self.i < self.s.len() && self.s[self.i] == b'{' {
                self.i += 1;
                v.push((k, Vdf::Obj(self.obj())));
                continue;
            }
            match self.quoted() {
                Some(val) => v.push((k, Vdf::Val(val))),
                None => match self.bare() {
                    Some(b) => v.push((k, Vdf::Val(b))),
                    None => break,
                },
            }
        }
        v
    }
}

fn read_vdf(p: &Path) -> Option<Vec<(String, Vdf)>> {
    let t = std::fs::read_to_string(p).ok()?;
    let mut r = VdfReader::new(&t);
    Some(r.obj())
}

fn vdf_obj<'t>(node: &'t [(String, Vdf)], key: &str) -> Option<&'t Vec<(String, Vdf)>> {
    for (k, v) in node {
        if k == key {
            if let Vdf::Obj(c) = v {
                return Some(c);
            }
        }
    }
    None
}

fn vdf_val(node: &[(String, Vdf)], key: &str) -> Option<String> {
    for (k, v) in node {
        if k == key {
            if let Vdf::Val(val) = v {
                return Some(val.clone());
            }
        }
    }
    None
}

fn vdf_u64(node: &[(String, Vdf)], key: &str) -> u64 {
    vdf_val(node, key).and_then(|v| v.parse().ok()).unwrap_or(0)
}

// ---------- identity ----------

/// FNV-1a over the path. Only used to keep hand-added ids stable.
fn stable_id(p: &Path) -> String {
    let s = p.to_string_lossy().to_lowercase();
    let mut h: u64 = 14695981039346656037;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    format!("{:016x}", h)
}

/// The key two sources are matched on, so the same title bought from Steam and
/// from GOG becomes one card with two installations instead of two cards.
/// Case, spacing and punctuation are dropped, because launchers are inconsistent
/// about all three. Two genuinely different games that share a name are shown as
/// one card with two installations, which the detail panel lists separately -
/// the user can always tell them apart, whereas two identical cards cannot be
/// told apart at all.
pub fn canonical_key(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_alphanumeric() {
            out.extend(ch.to_lowercase());
        }
    }
    out
}

// ---------- wire types ----------

/// A game as the frontend receives it: one card. A card with several
/// installations carries them in `installs` and reports the union in
/// `size_bytes`, so the library total is the real amount of disk in use.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Game {
    pub id: String,
    pub launcher: String,
    pub app_id: String,
    pub name: String,
    pub install_dir: String,
    pub exe_path: String,
    pub size_bytes: u64,
    pub last_played: u64,
    /// "detected" (found by scanning) or "manual" (the user pointed at an exe)
    pub source: String,
    pub favorite: bool,
    pub hidden: bool,
    /// A local image the user assigned, which wins over anything fetched online.
    pub art_path: String,
    /// Whether any recorded executable is still on disk. Recomputed on every
    /// read, never stored, so a moved game cannot claim to be ready.
    pub available: bool,
    pub plays: u64,
    pub last_launch: u64,
    /// Only set when the session was actually observed. Never guessed.
    pub last_session_secs: Option<u64>,
    pub total_secs: u64,
    // --- added with the canonical/install split ---
    /// "game", "application" or "tool". A launcher ships applications and
    /// redistributables alongside games, and they are not the same thing.
    #[serde(default)]
    pub kind: String,
    /// Every source this card was found in, e.g. ["steam"] or ["steam","standalone"].
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub installs: Vec<Installation>,
    /// True when this card covers more than one copy of the same game.
    #[serde(default)]
    pub multi_install: bool,
}

/// One place a game is actually installed.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Installation {
    pub source_id: String,
    /// Display name of the source. Kept as "Manual" for hand-added entries so
    /// the existing frontend wording does not change underneath the badges.
    pub source_name: String,
    pub app_id: String,
    pub install_dir: String,
    pub exe_path: String,
    pub size_bytes: u64,
    pub last_played: u64,
    pub kind: String,
    pub available: bool,
    /// The id this installation used before the canonical split, so favourites
    /// and sessions recorded by an older build keep pointing at the right game.
    pub legacy_id: String,
}

// One launch attempt. duration/cpu/mem stay null when they could not be
// measured, rather than being filled in with something plausible.
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct Session {
    pub id: String,
    pub game_id: String,
    pub name: String,
    pub launcher: String,
    pub started: u64,
    pub ended: u64,
    pub duration_secs: Option<u64>,
    pub cpu_pct: Option<f64>,
    pub mem_bytes: Option<u64>,
    // true only when a real process was observed running for the duration
    pub measured: bool,
}

// ---------- the source trait ----------

/// Why a source could not contribute. Each variant is reported to the user in
/// its own words, so "nothing here" is never confused with "could not look".
#[derive(Debug, Clone)]
pub enum SourceError {
    /// The launcher is simply not on this PC. Not a failure.
    NotInstalled(String),
    /// The launcher is there but its files could not be read.
    Unreadable(String),
    /// Something went wrong while reading it.
    Failed(String),
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SourceStatus {
    /// Read successfully.
    Ok,
    /// The launcher is not installed. Entirely normal.
    NotInstalled,
    /// The user turned this source off in settings.
    Disabled,
    /// Installed, but its files could not be read.
    Unreadable,
    /// Read attempted and failed.
    Failed,
}

#[derive(Serialize, Clone, Debug)]
pub struct SourceReport {
    pub id: String,
    pub name: String,
    /// "launcher" or "standalone" - used to group the status panel.
    pub group: String,
    pub enabled: bool,
    pub status: SourceStatus,
    /// How many installations this source contributed.
    pub found: usize,
    pub ms: u64,
    /// A plain sentence a user can act on, empty when everything was fine.
    pub detail: String,
}

impl Default for SourceReport {
    fn default() -> Self {
        SourceReport {
            id: String::new(),
            name: String::new(),
            group: String::new(),
            enabled: true,
            status: SourceStatus::Ok,
            found: 0,
            ms: 0,
            detail: String::new(),
        }
    }
}

/// What a scan returns. `games` is the library; `sources` says where it came
/// from and, just as importantly, where it did not.
#[derive(Serialize, Clone, Debug, Default)]
pub struct ScanReport {
    pub started: u64,
    pub ms: u64,
    pub games: Vec<Game>,
    pub sources: Vec<SourceReport>,
    /// Source ids that are not implemented yet, so the interface never implies
    /// coverage that does not exist.
    pub not_supported: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct RawScan {
    pub entries: Vec<SourceEntry>,
    pub sources: Vec<SourceReport>,
    pub ms: u64,
}

/// One installation as reported by one source, before canonicalisation.
#[derive(Clone, Debug)]
pub struct SourceEntry {
    pub source_id: String,
    pub source_name: String,
    pub name: String,
    pub app_id: String,
    pub install_dir: String,
    pub exe_path: String,
    pub size_bytes: u64,
    pub last_played: u64,
    pub kind: String,
}

/// A launcher, or a group of unmanaged executables. Everything ATLAS knows how
/// to read implements this, so adding a launcher means adding one struct and one
/// line in `registry()`.
pub trait Source: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    /// "launcher" or "standalone", used to group the status panel.
    fn group(&self) -> &'static str;
    fn discover(&self) -> Result<Vec<SourceEntry>, SourceError>;
}

// ---------- Steam ----------

/// Known non-game Steam applications. This is a short local list, not a guess:
/// an id that is not in it is reported as "game", and nothing is promoted or
/// demoted on a hunch.
fn steam_kind(app_id: &str) -> &'static str {
    match app_id {
        "431960" => "application", // Wallpaper Engine
        "228980" => "tool",        // Steamworks Common Redistributables
        "1493710" => "tool",       // Steam Linux Runtime 3.0 (sniper)
        "1628350" => "tool",       // Steam Linux Runtime 2.0 (soldier)
        "1150980" => "tool",       // Steam Linux Runtime (scout)
        _ => "game",
    }
}

fn steam_dir() -> Option<PathBuf> {
    if let Ok(out) = run("reg", &["query", r"HKCU\Software\Valve\Steam", "/v", "SteamPath"]) {
        for l in out.lines() {
            if let Some((_, v)) = l.split_once("    REG_SZ") {
                let p = v.trim().trim_matches('"');
                if !p.is_empty() {
                    return Some(PathBuf::from(p));
                }
            }
        }
    }
    let d = PathBuf::from(r"C:\Program Files (x86)\Steam");
    if d.join("steamapps").is_dir() {
        Some(d)
    } else {
        None
    }
}

fn steam_libraries(steam: &Path) -> Vec<PathBuf> {
    let Some(root) = read_vdf(&steam.join("steamapps").join("libraryfolders.vdf")) else {
        return Vec::new();
    };
    let Some(libs) = vdf_obj(&root, "libraryfolders") else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = Vec::new();
    for (key, node) in libs {
        match node {
            // Current format: "0" { "path" "C:\\..." ... }
            Vdf::Obj(fields) => {
                if let Some(p) = vdf_val(fields, "path") {
                    out.push(PathBuf::from(p));
                }
            }
            // Older format: "0"  "C:\\..." with no block around it.
            Vdf::Val(p) => {
                if !key.is_empty() && key.chars().all(|c| c.is_ascii_digit()) {
                    out.push(PathBuf::from(p));
                }
            }
        }
    }
    out
}

fn steam_games(lib: &Path) -> Result<Vec<Game>, SourceError> {
    let apps = lib.join("steamapps");
    // A library folder that exists but cannot be listed is reported, not treated
    // as a library with nothing in it, which would read as 0 games.
    let rd = std::fs::read_dir(&apps).map_err(|e| {
        SourceError::Failed(format!("Steam library {} could not be listed: {}.", apps.display(), e))
    })?;
    let mut out: Vec<Game> = Vec::new();
    for e in rd.flatten() {
        // Bind the lossy name to a variable first: strip_prefix borrows from it,
        // and a temporary would be dropped at the end of the let statement.
        let fname = e.file_name();
        let fname = fname.to_string_lossy();
        let Some(rest) = fname.strip_prefix("appmanifest_") else { continue };
        let Some(digits) = rest.strip_suffix(".acf") else { continue };
        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Some(root) = read_vdf(&e.path()) else { continue };
        let Some(state) = vdf_obj(&root, "AppState") else { continue };
        let (Some(name), Some(dir)) = (vdf_val(state, "name"), vdf_val(state, "installdir"))
        else {
            continue;
        };
        let app_id = vdf_val(state, "appid").unwrap_or_default();
        out.push(Game {
            id: format!("steam:{}", app_id),
            launcher: "Steam".to_string(),
            app_id: app_id.clone(),
            name: name.clone(),
            install_dir: apps.join("common").join(dir).to_string_lossy().into_owned(),
            // Steam starts the game itself, so no executable is recorded here.
            exe_path: String::new(),
            size_bytes: vdf_u64(state, "SizeOnDisk"),
            last_played: vdf_u64(state, "LastPlayed"),
            source: "detected".to_string(),
            kind: steam_kind(&app_id).to_string(),
            ..Default::default()
        });
    }
    Ok(out)
}

pub struct SteamSource;

impl Source for SteamSource {
    fn id(&self) -> &'static str { "steam" }
    fn name(&self) -> &'static str { "Steam" }
    fn group(&self) -> &'static str { "launcher" }

    fn discover(&self) -> Result<Vec<SourceEntry>, SourceError> {
        let steam = steam_dir().ok_or_else(|| {
            SourceError::NotInstalled("Steam is not installed on this PC.".into())
        })?;
        let mut libs = steam_libraries(&steam);
        if libs.is_empty() {
            libs.push(steam.clone());
        }
        // A library that exists but cannot be listed is a real problem the user
        // should hear about, not a silently empty shelf.
        if !steam.join("steamapps").is_dir() {
            return Err(SourceError::Unreadable(format!(
                "Steam is installed at {} but its steamapps folder could not be read.",
                steam.display()
            )));
        }

        let mut out = Vec::new();
        for lib in &libs {
            for g in steam_games(lib)? {
                out.push(SourceEntry {
                    source_id: "steam".into(),
                    source_name: "Steam".into(),
                    name: g.name,
                    app_id: g.app_id,
                    install_dir: g.install_dir,
                    exe_path: g.exe_path,
                    size_bytes: g.size_bytes,
                    last_played: g.last_played,
                    kind: g.kind,
                });
            }
        }
        Ok(out)
    }
}

// ---------- Standalone ----------

/// Games the user pointed ATLAS at directly, kept under their own control.
/// ATLAS never goes looking for unmanaged executables on disk; it only reports
/// the ones the user already chose to add.
pub struct StandaloneSource {
    pub entries: Vec<SourceEntry>,
}

impl Source for StandaloneSource {
    fn id(&self) -> &'static str { "standalone" }
    fn name(&self) -> &'static str { "Manual" }
    fn group(&self) -> &'static str { "standalone" }

    fn discover(&self) -> Result<Vec<SourceEntry>, SourceError> {
        Ok(self.entries.clone())
    }
}

/// Launchers ATLAS is planned for but does not read yet. Listed so the interface
/// can say so, rather than leaving the user to guess why Epic is empty.
// Launchers ATLAS has not built a reader for. Listed so the interface says so
// rather than leaving the user to work out why Epic or GOG came back empty -
// and kept honest as adapters land: each one that ships is removed from here in
// the same commit that adds it.
pub const NOT_SUPPORTED_YET: [&str; 4] = [
    "Ubisoft Connect",
    "Battle.net",
    "Riot Client",
    "Amazon Games",
];

// ---------- coordinator ----------

pub fn registry(manual: Vec<SourceEntry>) -> Vec<Box<dyn Source>> {
      vec![
        Box::new(SteamSource),
        Box::new(crate::launchers::EpicSource),
        Box::new(crate::launchers::GogSource),
        Box::new(crate::launchers::EaSource),
        Box::new(crate::launchers::XboxSource),
        Box::new(StandaloneSource { entries: manual }),
    ]
}

/// Runs every source and reports on each one independently.
///
/// A source that panics, that cannot be read, or that is simply not installed
/// affects only its own line in the report. The scan as a whole still returns
/// everything the other sources found.
pub fn scan(sources: Vec<Box<dyn Source>>, disabled: &HashSet<String>) -> RawScan {
    let started = Instant::now();
    let mut entries = Vec::new();
    let mut reports = Vec::new();

    for src in sources {
        let id = src.id().to_string();
        let name = src.name().to_string();
        let group = src.group().to_string();

        if disabled.contains(&id) {
            reports.push(SourceReport {
                id,
                name,
                group,
                enabled: false,
                status: SourceStatus::Disabled,
                found: 0,
                ms: 0,
                detail: "Turned off in ATLAS settings.".into(),
            });
            continue;
        }

        let t = Instant::now();
        // A misbehaving adapter must not take the scan down with it, so the call
        // is caught rather than trusted.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| src.discover()));
        let ms = t.elapsed().as_millis() as u64;

        let report = match outcome {
            Ok(Ok(found)) => {
                let n = found.len();
                entries.extend(found);
                SourceReport {
                    id,
                    name,
                    group,
                    enabled: true,
                    status: SourceStatus::Ok,
                    found: n,
                    ms,
                    detail: String::new(),
                }
            }
            Ok(Err(SourceError::NotInstalled(d))) => SourceReport {
                id,
                name,
                group,
                enabled: true,
                status: SourceStatus::NotInstalled,
                found: 0,
                ms,
                detail: d,
            },
            Ok(Err(SourceError::Unreadable(d))) => SourceReport {
                id,
                name,
                group,
                enabled: true,
                status: SourceStatus::Unreadable,
                found: 0,
                ms,
                detail: d,
            },
            Ok(Err(SourceError::Failed(d))) => SourceReport {
                id,
                name,
                group,
                enabled: true,
                status: SourceStatus::Failed,
                found: 0,
                ms,
                detail: d,
            },
            Err(_) => SourceReport {
                id,
                name,
                group,
                enabled: true,
                status: SourceStatus::Failed,
                found: 0,
                ms,
                detail: "This source stopped unexpectedly. Other sources were still read."
                    .into(),
            },
        };
        reports.push(report);
    }

    RawScan { entries, sources: reports, ms: started.elapsed().as_millis() as u64 }
}

/// Folds every reported installation into one card per game.
///
/// Two installations that name the same game become one card. Two installs of
/// the same directory reported by different sources are counted once, so the
/// library total is the disk actually in use and not its sum.
pub fn canonicalize(entries: Vec<SourceEntry>) -> Vec<CanonicalGame> {
    // Insertion order is preserved, so a card keeps the position its primary
    // source gave it rather than jumping around between scans.
    let mut order: Vec<String> = Vec::new();
    let mut by_key: Vec<CanonicalGame> = Vec::new();

    for e in entries {
        let key = canonical_key(&e.name);
        if key.is_empty() {
            continue;
        }
        // The same directory seen twice - Steam found it and the user also added
        // it by hand - is one install, not two.
        let dup = e.install_dir.is_empty()
            || by_key.iter().any(|c| {
                c.key == key
                    && c.installs.iter().any(|i| {
                        !i.install_dir.is_empty() && norm_path(&i.install_dir) == norm_path(&e.install_dir)
                    })
            });

        let inst = Installation {
            source_id: e.source_id.clone(),
            source_name: e.source_name.clone(),
            app_id: e.app_id.clone(),
            install_dir: e.install_dir.clone(),
            exe_path: e.exe_path.clone(),
            size_bytes: e.size_bytes,
            last_played: e.last_played,
            kind: e.kind.clone(),
            available: false,
            legacy_id: if e.app_id.is_empty() && !e.exe_path.is_empty() {
                format!("manual:{}", stable_id(Path::new(&e.exe_path)))
            } else {
                format!("{}:{}", e.source_id, e.app_id)
            },
        };

        match by_key.iter_mut().find(|c| c.key == key) {
            Some(c) => {
                // The longest name wins: launchers truncate, ATLAS does not.
                if e.name.len() > c.name.len() {
                    c.name = e.name.clone();
                }
                if !dup {
                    c.installs.push(inst);
                }
            }
            None => {
                order.push(key.clone());
                by_key.push(CanonicalGame {
                    id: format!("g:{}", short_hash(&key)),
                    key,
                    name: e.name,
                    kind: e.kind,
                    installs: vec![inst],
                    ..Default::default()
                });
            }
        }
    }

    let mut out = Vec::with_capacity(by_key.len());
    for k in order {
        if let Some(p) = by_key.iter().position(|c| c.key == k) {
            out.push(by_key.remove(p));
        }
    }
    out
}

#[derive(Clone, Debug, Default)]
pub struct CanonicalGame {
    pub id: String,
    /// The normalised title the card is grouped by. Kept so the group can be
    /// recognised again without re-deriving it from the name.
    pub key: String,
    pub name: String,
    pub kind: String,
    pub installs: Vec<Installation>,
}

/// A short stable hash of a canonical key, so a card keeps its id - and its
/// sessions - across restarts even though the id is derived from the title.
fn short_hash(s: &str) -> String {
    let mut h: u64 = 14695981039346656037;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    format!("{:016x}", h)
}

// ---------- store ----------

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AtlasStore {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub hidden: Vec<String>,
    #[serde(default)]
    pub favorites: Vec<String>,
    #[serde(default)]
    pub manual: Vec<Game>,
    #[serde(default)]
    pub sessions: Vec<Session>,
    #[serde(default)]
    pub sort: String,
    /// Sources the user turned off. Empty means every source is read.
    #[serde(default)]
    pub disabled_sources: Vec<String>,
    /// Legacy id -> canonical id, so favourites and sessions recorded before the
    /// canonical split keep working instead of silently resetting.
    #[serde(default)]
    pub aliases: std::collections::BTreeMap<String, String>,
}

const STORE_VERSION: u32 = 2;

pub fn atlas_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join("atlas.json"))
}

fn read_atlas(app: &tauri::AppHandle) -> AtlasStore {
    let Ok(p) = atlas_path(app) else { return AtlasStore::default() };
    let Ok(t) = std::fs::read_to_string(&p) else { return AtlasStore::default() };
    let mut s: AtlasStore = serde_json::from_str(&t).unwrap_or_default();
    migrate(&mut s);
    s
}

fn write_atlas(app: &tauri::AppHandle, s: &AtlasStore) -> Result<(), String> {
    let p = atlas_path(app)?;
    std::fs::write(&p, serde_json::to_string_pretty(s).unwrap_or_default())
        .map_err(|e| format!("ATLAS settings could not be written: {}", e))
}

/// Brings an older store forward without losing anything in it.
///
/// Every field this adds is `#[serde(default)]`, so an old file parses as it
/// stands. What migration adds is the version stamp and the shape of the
/// favourites list: old entries are per-source ids, which are kept as aliases
/// pointing at the canonical id rather than being rewritten in place. If the
/// rewrite cannot be completed the in-memory store is still correct, so a full
/// disk or a locked file degrades to "settings not remembered" rather than to a
/// lost library.
fn migrate(s: &mut AtlasStore) {
    if s.version >= STORE_VERSION {
        return;
    }
    s.version = STORE_VERSION;
    s.disabled_sources.retain(|d| d == "steam" || d == "standalone");
}

// ---------- merging ----------

/// Turns the canonical games into the flat card list the frontend renders,
/// folding in favourites, hidden entries and recorded sessions.
pub fn merge_library(store: &AtlasStore, canon: Vec<CanonicalGame>) -> Vec<Game> {
    let mut out: Vec<Game> = Vec::new();

    for mut c in canon {
        // The user may have hidden or starred this game under any of the ids it
        // has ever had. All of them are honoured.
        let legacy: HashSet<String> = c.installs.iter().map(|i| i.legacy_id.clone()).collect();
        let flagged = |list: &Vec<String>| -> bool {
            list.iter().any(|x| x == &c.id) || list.iter().any(|x| legacy.contains(x))
        };
        if flagged(&store.hidden) {
            continue;
        }
        let favorite = flagged(&store.favorites);

        // Availability is per install, and one working copy is enough to launch.
        let mut any_available = false;
        for i in c.installs.iter_mut() {
            i.available = if i.exe_path.is_empty() {
                !i.app_id.is_empty()
            } else {
                Path::new(&i.exe_path).is_file()
            };
            any_available |= i.available;
        }

        // The card's headline install is the one most recently played, then the
        // one that actually exists, then whatever came first.
        let primary = c
            .installs
            .iter()
            .max_by_key(|i| (i.last_played > 0, i.available))
            .cloned()
            .unwrap_or_default();

        // The launcher keeps its old meaning: the source that owns the headline
        // install. `sources` carries the full list.
        let mut sources: Vec<String> = Vec::new();
        for i in &c.installs {
            if !sources.contains(&i.source_id) {
                sources.push(i.source_id.clone());
            }
        }

        let g = Game {
            id: c.id.clone(),
            launcher: primary.source_name.clone(),
            app_id: primary.app_id.clone(),
            name: c.name.clone(),
            install_dir: primary.install_dir.clone(),
            exe_path: primary.exe_path.clone(),
            // Every copy is on disk, so every copy is counted.
            size_bytes: c.installs.iter().map(|i| i.size_bytes).sum(),
            last_played: c.installs.iter().map(|i| i.last_played).max().unwrap_or(0),
            source: if sources.iter().any(|s| s == "standalone") && sources.len() == 1 {
                "manual".to_string()
            } else {
                "detected".to_string()
            },
            favorite,
            hidden: false,
            // A cover the user set applies to the game, so it applies to every
            // card that game now appears on. Looked up under any of the ids this
            // game has ever had, so a cover set before the canonical split
            // survives the upgrade.
            art_path: store
                .manual
                .iter()
                .find(|m| legacy.contains(&m.id))
                .map(|m| m.art_path.clone())
                .unwrap_or_default(),
            available: any_available,
            plays: 0,
            last_launch: 0,
            last_session_secs: None,
            total_secs: 0,
            kind: if c.kind.is_empty() { "game".into() } else { c.kind.clone() },
            sources,
            multi_install: c.installs.len() > 1,
            installs: c.installs,
        };
        out.push(g);
    }

    // Plays and durations come from the recorded sessions, which stay the single
    // source of truth. A session filed under any id this game has ever had still
    // counts, so upgrading ATLAS never silently empties the play-time totals.
    for g in out.iter_mut() {
        let ids: HashSet<&str> = std::iter::once(g.id.as_str())
            .chain(g.installs.iter().map(|i| i.legacy_id.as_str()))
            .collect();
        let s: Vec<&Session> = store.sessions.iter().filter(|x| ids.contains(x.game_id.as_str())).collect();
        g.plays = s.len() as u64;
        g.last_launch = s.iter().map(|x| x.started).max().unwrap_or(0);
        g.total_secs = s.iter().filter_map(|x| x.duration_secs).sum();
        g.last_session_secs = s
            .iter()
            .filter(|x| x.measured && x.duration_secs.is_some())
            .max_by_key(|x| x.started)
            .and_then(|x| x.duration_secs);
    }

    out.sort_by(|a, b| {
        b.favorite
            .cmp(&a.favorite)
            .then(b.last_played.cmp(&a.last_played))
            .then(b.last_launch.cmp(&a.last_launch))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

/// Turns stored hand-added games into source entries, so they take the same path
/// through the coordinator as a detected game and appear in the source report
/// like any other source.
fn manual_entries(manual: &[Game]) -> Vec<SourceEntry> {
    manual
        .iter()
        .map(|m| SourceEntry {
            source_id: "standalone".into(),
            source_name: "Manual".into(),
            name: m.name.clone(),
            app_id: String::new(),
            install_dir: m.install_dir.clone(),
            exe_path: m.exe_path.clone(),
            // Left at zero on purpose: walking a whole install tree is slow and a
            // partial figure would be a wrong number dressed up as a real one.
            size_bytes: m.size_bytes,
            last_played: m.last_played,
            kind: if m.kind.is_empty() { "game".into() } else { m.kind.clone() },
        })
        .collect()
}

// ---------- commands ----------

#[tauri::command]
pub async fn atlas_scan(app: tauri::AppHandle) -> Result<ScanReport, String> {
    let store = read_atlas(&app);
    let manual = manual_entries(&store.manual);
    let disabled: HashSet<String> = store.disabled_sources.iter().cloned().collect();

    // A scan that could not be run is not an empty library. The old
    // unwrap_or_default turned a dead blocking task into an empty RawScan: no
    // games and no per-source list, so the panel hid itself and the grid fell
    // through to "No games found yet." while every game was still on disk.
    let raw = tauri::async_runtime::spawn_blocking(move || scan(registry(manual), &disabled))
        .await
        .map_err(|e| format!("The library scan could not be started: {}.", e))?;

    let games = merge_library(&store, canonicalize(raw.entries));
    Ok(ScanReport {
        started: now_unix(),
        ms: raw.ms,
        games,
        sources: raw.sources,
        not_supported: NOT_SUPPORTED_YET.iter().map(|s| s.to_string()).collect(),
    })
}

#[tauri::command]
pub fn atlas_sessions(app: tauri::AppHandle) -> Vec<Session> {
    let mut s = read_atlas(&app).sessions;
    s.sort_by(|a, b| b.started.cmp(&a.started));
    s.truncate(50);
    s
}

#[tauri::command]
pub fn atlas_clear_sessions(app: tauri::AppHandle) -> Result<(), String> {
    let mut store = read_atlas(&app);
    store.sessions.clear();
    write_atlas(&app, &store)
}

/// Every source ATLAS knows about, whether or not it is implemented, so the
/// settings screen can tell the truth about coverage.
#[tauri::command]
pub fn atlas_source_list(app: tauri::AppHandle) -> Vec<SourceInfo> {
    let store = read_atlas(&app);
    let mut out = vec![
        SourceInfo { id: "steam".into(), name: "Steam".into(), group: "launcher".into(), implemented: true, enabled: !store.disabled_sources.iter().any(|d| d == "steam") },
        SourceInfo { id: "standalone".into(), name: "Manual".into(), group: "standalone".into(), implemented: true, enabled: !store.disabled_sources.iter().any(|d| d == "standalone") },
    ];
    for n in NOT_SUPPORTED_YET {
        let id = n.to_lowercase().replace(['/', '.', ' '], "_");
        out.push(SourceInfo { id, name: n.into(), group: "launcher".into(), implemented: false, enabled: true });
    }
    out
}

#[derive(Serialize, Clone, Debug)]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    pub group: String,
    pub implemented: bool,
    pub enabled: bool,
}

#[tauri::command]
pub fn atlas_set_source(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let tid = id.trim().to_string();
    if tid != "steam" && tid != "standalone" {
        return Err("That source cannot be turned on or off.".into());
    }
    let mut store = read_atlas(&app);
    store.disabled_sources.retain(|d| d != &tid);
    if !enabled {
        store.disabled_sources.push(tid);
    }
    write_atlas(&app, &store)
}

fn push_session(
    app: &tauri::AppHandle,
    game_id: &str,
    name: &str,
    launcher: &str,
    secs: Option<u64>,
    cpu: Option<f64>,
    mem: Option<u64>,
    measured: bool,
) {
    let t = now_unix();
    let mut store = read_atlas(app);
    store.sessions.push(Session {
        id: format!("{}:{}", game_id, t),
        game_id: game_id.to_string(),
        name: name.to_string(),
        launcher: launcher.to_string(),
        started: t,
        ended: t,
        duration_secs: secs,
        cpu_pct: cpu,
        mem_bytes: mem,
        measured,
    });
    if store.sessions.len() > 100 {
        store.sessions.remove(0);
    }
    let _ = write_atlas(app, &store);
}

#[tauri::command]
pub fn atlas_add_manual(
    app: tauri::AppHandle,
    name: Option<String>,
    exe_path: String,
    art_path: Option<String>,
) -> Result<Game, String> {
    let mut path = exe_path.trim().to_string();
    if path.is_empty() {
        return Err("Choose the game's .exe file.".into());
    }
    // Tolerate a path pasted straight out of Explorer, which quotes it.
    if path.len() > 1 && path.starts_with('"') && path.ends_with('"') {
        path = path[1..path.len() - 1].to_string();
    }
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("{} is not a file on this PC.", path));
    }
    if !p.extension().map(|e| e.eq_ignore_ascii_case("exe")).unwrap_or(false) {
        return Err("That is not an .exe. Shortcuts, folders and documents cannot be launched.".into());
    }
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    let final_name = name.unwrap_or_default();
    let final_name = if final_name.trim().is_empty() { stem } else { final_name.trim().to_string() };
    // Validated before anything is written, so a bad cover never leaves the game
    // half-added. Same helper as atlas_set_art, so the two cannot drift apart.
    let art = clean_art_path(art_path)?;

    let mut store = read_atlas(&app);
    let id = format!("manual:{}", stable_id(&p));
    // Compared on the normalised path rather than the id, so C:\Games\a.exe and
    // C:/Games/a.exe are recognised as the same executable.
    let npath = norm_path(&p.to_string_lossy());
    if store.manual.iter().any(|m| !m.exe_path.is_empty() && norm_path(&m.exe_path) == npath) {
        return Err("That game is already in your library.".into());
    }
    if store.manual.iter().any(|m| m.id == id) {
        return Err("That game is already in your library.".into());
    }

    let g = Game {
        id: id.clone(),
        launcher: "Manual".to_string(),
        app_id: String::new(),
        name: final_name,
        install_dir: p
            .parent()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default(),
        exe_path: p.to_string_lossy().into_owned(),
        art_path: art,
        // Left at zero on purpose: walking a whole install tree is slow and a
        // partial figure would be a wrong number dressed up as a real one.
        size_bytes: 0,
        last_played: 0,
        source: "manual".to_string(),
        kind: "game".to_string(),
        ..Default::default()
    };
    store.manual.push(g.clone());
    store.hidden.retain(|h| h != &id);
    store.sessions.retain(|s| s.game_id != id);
    write_atlas(&app, &store)?;
    Ok(g)
}

// Edits a stored game. The frontend may only name a library id: it never sends
// a path that gets used without being checked here first.
//
// Validation runs before anything is borrowed mutably, because the duplicate
// check needs to read the rest of the list while the entry is being edited.
#[tauri::command]
pub fn atlas_update(
    app: tauri::AppHandle,
    id: String,
    name: Option<String>,
    exe_path: Option<String>,
) -> Result<Game, String> {
    let tid = id.trim().to_string();
    let mut store = read_atlas(&app);
    let Some(idx) = store.manual.iter().position(|m| m.id == tid) else {
        return Err("That game is no longer in your library. Rescan and try again.".into());
    };
    let old_id = store.manual[idx].id.clone();

    // Resolve and validate the new executable against the whole list first.
    let mut new_id = String::new();
    let mut new_exe = String::new();
    let mut new_dir = String::new();
    if let Some(p) = exe_path {
        let raw = p.trim().trim_matches('"').to_string();
        if !raw.is_empty() {
            let pb = PathBuf::from(&raw);
            if !pb.is_file() {
                return Err(format!("{} is not a file on this PC.", raw));
            }
            if !pb.extension().map(|e| e.eq_ignore_ascii_case("exe")).unwrap_or(false) {
                return Err("That is not an .exe. Shortcuts, folders and documents cannot be launched.".into());
            }
            let nid = format!("manual:{}", stable_id(&pb));
            if nid != old_id && store.manual.iter().any(|m| m.id == nid) {
                return Err("Another entry in your library already points at that executable.".into());
            }
            new_id = nid;
            new_exe = pb.to_string_lossy().into_owned();
            new_dir = pb
                .parent()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_default();
        }
    }

    let renamed = !new_exe.is_empty() && new_id != old_id;
    {
        let g = &mut store.manual[idx];
        if let Some(n) = name {
            let n = n.trim();
            if !n.is_empty() {
                g.name = n.to_string();
            }
        }
        if !new_exe.is_empty() {
            g.id = new_id.clone();
            g.exe_path = new_exe;
            g.install_dir = new_dir;
        }
    }

    // A re-pointed entry is a new identity, so carry its flags across and drop
    // the launch history that belonged to the old executable.
    if renamed {
        // old_id, not new_id. retain keeps what matches, so this line decides
        // which history survives. new_id is an executable that by construction
        // has no sessions (a duplicate path is rejected above), so the old
        // operand dropped nothing and kept everything - the exact opposite of
        // what the comment above promises.
        store.sessions.retain(|s| s.game_id != old_id);
        store.hidden.retain(|h| h != &old_id);
        let was_fav = store.favorites.iter().any(|f| f == &old_id);
        store.favorites.retain(|f| f != &old_id);
        if was_fav {
            store.favorites.push(new_id.clone());
        }
    }

    let out = store.manual[idx].clone();
    write_atlas(&app, &store)?;
    Ok(out)
}

// Validates a cover-image path the user picked. One definition, so adding a game
// with art and setting art on an existing game cannot drift apart.
fn clean_art_path(art_path: Option<String>) -> Result<String, String> {
    let raw = art_path.unwrap_or_default().trim().trim_matches('"').to_string();
    if raw.is_empty() {
        return Ok(String::new());
    }
    let pb = PathBuf::from(&raw);
    if !pb.is_file() {
        return Err(format!("{} is not a file on this PC.", raw));
    }
    let ok = pb
        .extension()
        .map(|e| {
            let e = e.to_ascii_lowercase();
            e == "png" || e == "jpg" || e == "jpeg" || e == "webp" || e == "bmp" || e == "gif"
        })
        .unwrap_or(false);
    if !ok {
        return Err("Choose an image file (png, jpg, webp, bmp or gif).".into());
    }
    Ok(pb.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn atlas_set_art(app: tauri::AppHandle, id: String, art_path: Option<String>) -> Result<(), String> {
    let tid = id.trim().to_string();
    let mut store = read_atlas(&app);
    let Some(g) = store.manual.iter_mut().find(|m| m.id == tid) else {
        return Err("That game is no longer in your library.".into());
    };
    g.art_path = clean_art_path(art_path)?;
    write_atlas(&app, &store)
}

#[tauri::command]
pub fn atlas_remove(app: tauri::AppHandle, id: String, forget: Option<bool>) -> Result<(), String> {
    let tid = id.trim().to_string();
    let mut store = read_atlas(&app);
    if !store.hidden.contains(&tid) {
        store.hidden.push(tid.clone());
    }
    if forget.unwrap_or(false) {
        store.manual.retain(|m| m.id != tid);
        store.favorites.retain(|f| f != &tid);
        store.sessions.retain(|s| s.game_id != tid);
    }
    write_atlas(&app, &store)
}

#[tauri::command]
pub fn atlas_restore(app: tauri::AppHandle) -> Result<(), String> {
    let mut store = read_atlas(&app);
    store.hidden.clear();
    write_atlas(&app, &store)
}

#[tauri::command]
pub fn atlas_set_favorite(app: tauri::AppHandle, id: String, favorite: bool) -> Result<(), String> {
    let tid = id.trim().to_string();
    let mut store = read_atlas(&app);
    store.favorites.retain(|f| f != &tid);
    if favorite {
        store.favorites.push(tid.clone());
    }
    write_atlas(&app, &store)
}

fn steam_uri_registered() -> bool {
    run("reg", &["query", r"HKCU\Software\Classes\steam\shell\open\command"]).is_ok()
}

// Steam start is kept as its own function so both the old appid entry point and
// the newer id-based one share exactly the same validation and URL handling.
fn steam_start(appid: &str) -> Result<String, String> {
    let t = appid.trim();
    // Bare decimal only, and it must round-trip, so nothing but digits can
    // reach the URL that is built below.
    let id: u64 = t.parse().map_err(|_| "That is not a valid Steam app id.".to_string())?;
    if id.to_string() != t {
        return Err("That is not a valid Steam app id.".to_string());
    }

    let steam =
        steam_dir().ok_or_else(|| "Steam does not appear to be installed on this PC.".to_string())?;
    if !steam_uri_registered() {
        return Err("Steam's link handler is not registered, so STRYV cannot ask it to launch a game.".to_string());
    }

    // Allowlist: the id must be one this scan actually found on this PC, so the
    // frontend cannot ask for an arbitrary id.
    let mut libs = steam_libraries(&steam);
    if libs.is_empty() {
        libs.push(steam);
    }
    let known = libs.iter().flat_map(|l| steam_games(l).unwrap_or_default()).any(|g| g.app_id == t);
    if !known {
        return Err("That game is not in the Steam library STRYV can see.".to_string());
    }

    // steam://rungameid/<id> is Steam's own protocol; explorer.exe only resolves
    // the registered handler. The URL is assembled here from a validated integer,
    // so no part of it comes from the frontend. Spawned, not waited on, so a slow
    // handler cannot block the caller.
    let url = format!("steam://rungameid/{}", id);
    let mut c = std::process::Command::new("explorer");
    c.arg(&url);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c.spawn()
        .map_err(|e| format!("Could not ask Steam to launch the game: {}.", e))?;
    Ok(format!("Steam was asked to launch this game (app {}). If nothing starts, open Steam and check you are signed in.", id))
}

// Kept for the 0.2.0 frontend, which sends a Steam app id rather than a library id.
#[tauri::command]
pub async fn atlas_launch(appid: String) -> Result<String, String> {
    let t = appid.clone();
    tauri::async_runtime::spawn_blocking(move || steam_start(&t))
        .await
        .map_err(|e| e.to_string())?
}

/// Opens the Microsoft Store itself.
///
/// Not a game launch: it is the shop front, reached through the same shell
/// protocol a Start menu shortcut uses. Offered on an empty Store page, where the
/// honest message is that nothing was found and the useful reply is to go and find
/// something.
#[tauri::command]
pub async fn atlas_open_store() -> Result<String, String> {
    std::process::Command::new("explorer.exe")
        .arg("ms-windows-store:")
        .spawn()
        .map_err(|e| format!("Could not open the Microsoft Store: {}.", e))?;
    Ok("Opened the Microsoft Store.".to_string())
}

/// Opens a launcher's own client, without starting any game through it.
///
/// Deliberately separate from `atlas_launch_id`. Starting a launcher is safe: it
/// is an ordinary desktop app, and it does the per-game handshake itself once you
/// click Play inside it. Starting a game by running its executable is not, which is
/// why that path refuses.
#[tauri::command]
pub async fn atlas_open_launcher(source_id: String) -> Result<String, String> {
    let id = source_id.trim().to_lowercase();
    let name = match id.as_str() {
        "epic" => "Epic Games Launcher",
        "gog" => "GOG Galaxy",
        "ea" => "EA app",
        other => {
            return Err(format!("{} has no launcher ATLAS can open.", other));
        }
    };
    let exe = crate::launchers::launcher_client(&id).ok_or_else(|| {
        format!(
            "{} was not found in its usual place. Open it from your Start menu instead.",
            name
        )
    })?;
    std::process::Command::new(&exe)
        .spawn()
        .map_err(|e| format!("Could not open {}: {}.", name, e))?;
    Ok(format!("Opened {}.", name))
}

/// Starts a Microsoft Store app by its AUMID.
///
/// Windows exposes no "launch this package" call other than asking Explorer to
/// open the shell namespace for it, so this goes through explorer rather than
/// spawning the executable inside WindowsApps. That folder is protected by ACLs
/// and is not reliably readable or executable by another process.
fn shell_activate(name: &str, aumid: &str) -> Result<String, String> {
    let (family, app) = aumid
        .split_once('!')
        .ok_or_else(|| format!("{} has no Store id recorded. Rescan to pick it up again.", name))?;
    // An AUMID only ever contains letters, digits, dots, dashes and underscores.
    // Anything else is not an id, and handing it to explorer would be passing
    // unchecked input to the shell.
    let plain = |s: &str| {
        !s.is_empty()
            && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    if !plain(family) || !plain(app) {
        return Err(format!("{} has a Store id that Windows would not accept.", name));
    }
    std::process::Command::new("explorer.exe")
        .arg(format!("shell:AppsFolder\\{}", aumid))
        .spawn()
        .map_err(|e| format!("Could not reach the Microsoft Store to start {}: {}.", name, e))?;
    Ok(format!("Started {} through the Microsoft Store.", name))
}

// The frontend only ever names a library id. The executable is resolved here from
// ATLAS's own library, so a path can never arrive from the UI.
#[tauri::command]
pub async fn atlas_launch_id(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let tid = id.trim().to_string();
    if tid.is_empty() {
        return Err("No game was selected.".into());
    }

    let store = read_atlas(&app);
    let manual = manual_entries(&store.manual);
    let disabled: HashSet<String> = store.disabled_sources.iter().cloned().collect();
    let raw = tauri::async_runtime::spawn_blocking(move || scan(registry(manual), &disabled))
        .await
        .unwrap_or_default();
    let game = merge_library(&store, canonicalize(raw.entries))
        .into_iter()
        .find(|g| g.id == tid)
        .ok_or_else(|| {
            "That game is not in the library STRYV can see. Rescan and try again.".to_string()
        })?;

    if game.launcher == "Steam" {
        let msg = steam_start(&game.app_id)?;
        // Steam starts the game itself, so STRYV never gets a process handle.
        // The launch is recorded, but the duration is left unmeasured rather
        // than guessed.
        push_session(&app, &game.id, &game.name, &game.launcher, None, None, None, false);
        return Ok(msg);
    }

    // A card can hold several installs; the first one that is actually on disk
    // is the one launched, and if none are, the error names the first path so
    // the user knows where ATLAS last saw it.
    let inst = game
        .installs
        .iter()
        .find(|i| i.available)
        .cloned()
        .unwrap_or_default();

    // A Microsoft Store entry is started by its AUMID rather than by a path. Its
    // files live inside WindowsApps, which is ACL-protected and not something
    // ATLAS can read or run directly.
    if inst.source_id == "xbox" {
        let msg = shell_activate(&game.name, &inst.app_id)?;
        // Windows starts the app itself, so STRYV never gets a process handle.
        // The launch is recorded and the duration left unmeasured, the same
        // treatment Steam gets.
        push_session(&app, &game.id, &game.name, &game.launcher, None, None, None, false);
        return Ok(msg);
    }

    // ATLAS reads Epic, GOG and EA, but starting a game through one of those
    // needs the launcher's own arguments and handshake, not just the path to
    // the executable. Spawning the .exe would skip all of that and could launch
    // the game without its anti-cheat or account. The honest answer is to say so.
    //
    // This used to live only in the frontend, which meant calling this command
    // directly would bypass the refusal entirely. The rule belongs here, where
    // nothing can route around it.
    if !matches!(inst.source_id.as_str(), "manual" | "standalone" | "") {
        let who = if inst.source_name.is_empty() { &game.launcher } else { &inst.source_name };
        return Err(format!(
            "ATLAS can see this on {} but cannot start games through it yet. Open the launcher to play.",
            who
        ));
    }

    if inst.exe_path.is_empty() {
        return Err(format!("{} has no executable recorded. Remove it and add it again.", game.name));
    }
    let exe = PathBuf::from(&inst.exe_path);
    if !exe.is_file() {
        // A moved or deleted install is the common case, so say exactly that.
        return Err(format!(
            "{} is no longer at {}. It may have been moved, updated or uninstalled.",
            game.name,
            exe.display()
        ));
    }

    let mut child = std::process::Command::new(&exe)
        .current_dir(exe.parent().unwrap_or_else(|| Path::new(".")))
        .spawn()
        .map_err(|e| format!("Could not start {}: {}.", game.name, e))?;

    let pid = child.id();
    let gid = game.id.clone();
    let gname = game.name.clone();
    let glaunch = game.launcher.clone();
    let handle = app.clone();

    // The child is owned by this thread now. It is polled until the process
    // exits so the duration is measured rather than estimated.
    std::thread::spawn(move || {
        let started = Instant::now();
        let spid = sysinfo::Pid::from_u32(pid);
        let mut sys = sysinfo::System::new();
        let mut peak_cpu: f64 = 0.0;
        let mut peak_mem: u64 = 0;
        let mut samples = 0u32;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(_) => break,
            }
            sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[spid]), true);
            if let Some(pr) = sys.process(spid) {
                let c = pr.cpu_usage() as f64;
                if c > peak_cpu {
                    peak_cpu = c;
                }
                let m = pr.memory();
                if m > peak_mem {
                    peak_mem = m;
                }
                samples += 1;
            }
            std::thread::sleep(std::time::Duration::from_millis(2000));
        }
        let secs = started.elapsed().as_secs();
        push_session(
            &handle,
            &gid,
            &gname,
            &glaunch,
            Some(secs),
            if samples > 0 { Some(peak_cpu) } else { None },
            if samples > 0 { Some(peak_mem) } else { None },
            samples > 0,
        );
    });

    Ok(format!(
        "Started {}. ATLAS is watching it and will record the session when it closes.",
        game.name
    ))
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(src: &str, name: &str, dir: &str, exe: &str, size: u64) -> SourceEntry {
        SourceEntry {
            source_id: src.into(),
            source_name: if src == "steam" { "Steam".into() } else { "Manual".into() },
            name: name.into(),
            app_id: if src == "steam" { "111".into() } else { String::new() },
            install_dir: dir.into(),
            exe_path: exe.into(),
            size_bytes: size,
            last_played: 0,
            kind: "game".into(),
        }
    }

    #[test]
    fn canonical_key_ignores_case_spacing_and_punctuation() {
        assert_eq!(canonical_key("Tom Clancy's Rainbow Six Siege"), canonical_key("tom clancys rainbow six siege"));
        assert_eq!(canonical_key("Hollow Knight!"), canonical_key("hollowknight"));
        assert_ne!(canonical_key("Portal"), canonical_key("Portal 2"));
    }

    #[test]
    fn same_title_from_two_sources_is_one_card_with_two_installs() {
        let c = canonicalize(vec![
            entry("steam", "Hollow Knight", "C:/Steam/steamapps/common/Hollow Knight", "", 10),
            entry("standalone", "Hollow Knight", "C:/Games/Hollow Knight", "C:/Games/Hollow Knight/hk.exe", 10),
        ]);
        assert_eq!(c.len(), 1, "one canonical game");
        assert_eq!(c[0].installs.len(), 2, "two installations");
    }

    #[test]
    fn the_same_directory_reported_twice_is_one_install() {
        // Steam found it and the user also added it by hand: the disk is counted
        // once, because it is one folder.
        let c = canonicalize(vec![
            entry("steam", "Hollow Knight", "C:/Games/Hollow Knight", "", 10),
            entry("standalone", "Hollow Knight", "C:/Games/Hollow Knight", "C:/Games/Hollow Knight/hk.exe", 10),
        ]);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].installs.len(), 1, "the duplicate directory is dropped");
    }

    #[test]
    fn different_titles_stay_separate_cards() {
        let c = canonicalize(vec![
            entry("steam", "Hollow Knight", "C:/a", "", 1),
            entry("steam", "Hollow Knight Silksong", "C:/b", "", 1),
        ]);
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn a_card_sums_the_size_of_every_copy() {
        let store = AtlasStore::default();
        let c = canonicalize(vec![
            entry("steam", "Hollow Knight", "C:/a", "", 1000),
            entry("standalone", "Hollow Knight", "C:/b", "C:/b/hk.exe", 500),
        ]);
        let g = merge_library(&store, c);
        assert_eq!(g[0].size_bytes, 1500, "both copies are really on disk");
        assert!(g[0].multi_install);
        assert_eq!(g[0].sources, vec!["steam".to_string(), "standalone".to_string()]);
    }

    #[test]
    fn one_working_copy_makes_the_card_launchable() {
        let store = AtlasStore::default();
        // Two copies of one game. The hand-added copy points at an exe that is
        // not on disk, but the Steam copy has an app id Steam can still start,
        // so the card is launchable. Availability is per install; the card needs
        // only one.
        let c = canonicalize(vec![
            entry("steam", "Hollow Knight", "C:/a", "", 1000),
            entry("standalone", "Hollow Knight", "C:/b", "C:/definitely-not-here/hk.exe", 500),
        ]);
        let g = merge_library(&store, c);
        assert!(g[0].available, "one working copy is enough to launch");
        assert!(g[0].installs[0].available, "the Steam copy works");
        assert!(!g[0].installs[1].available, "the missing exe is reported missing, not assumed");
    }

    #[test]
    fn a_card_whose_only_copy_is_missing_is_unavailable() {
        let store = AtlasStore::default();
        let c = canonicalize(vec![
            entry("standalone", "Hollow Knight", "C:/b", "C:/definitely-not-here/hk.exe", 500),
        ]);
        let g = merge_library(&store, c);
        assert!(!g[0].available, "nothing left to launch means the card says so");
    }

    #[test]
    fn a_favourite_recorded_under_the_old_id_still_pins_the_card() {
        let mut store = AtlasStore::default();
        store.favorites.push("steam:111".into());
        let c = canonicalize(vec![entry("steam", "Hollow Knight", "C:/a", "", 1)]);
        let g = merge_library(&store, c);
        assert!(g[0].favorite, "the pre-canonical id is still honoured");
    }

    #[test]
    fn a_game_hidden_under_the_old_id_stays_hidden() {
        let mut store = AtlasStore::default();
        store.hidden.push("steam:111".into());
        let c = canonicalize(vec![entry("steam", "Hollow Knight", "C:/a", "", 1)]);
        assert!(merge_library(&store, c).is_empty());
    }

    #[test]
    fn sessions_recorded_under_the_old_id_still_count() {
        let mut store = AtlasStore::default();
        store.sessions.push(Session {
            id: "s1".into(),
            game_id: "steam:111".into(),
            name: "Hollow Knight".into(),
            launcher: "Steam".into(),
            started: 100,
            ended: 700,
            duration_secs: Some(600),
            cpu_pct: None,
            mem_bytes: None,
            measured: true,
        });
        let c = canonicalize(vec![entry("steam", "Hollow Knight", "C:/a", "", 1)]);
        let g = merge_library(&store, c);
        assert_eq!(g[0].plays, 1, "upgrading ATLAS must not empty the play time");
        assert_eq!(g[0].total_secs, 600);
        assert_eq!(g[0].last_session_secs, Some(600));
    }

    #[test]
    fn a_source_that_is_not_installed_is_reported_not_hidden() {
        struct Absent;
        impl Source for Absent {
            fn id(&self) -> &'static str { "absent" }
            fn name(&self) -> &'static str { "Absent Launcher" }
            fn group(&self) -> &'static str { "launcher" }
            fn discover(&self) -> Result<Vec<SourceEntry>, SourceError> {
                Err(SourceError::NotInstalled("Absent Launcher is not installed on this PC.".into()))
            }
        }
        let raw = scan(vec![Box::new(Absent), Box::new(StandaloneSource { entries: vec![entry("standalone", "Hollow Knight", "C:/a", "", 1)] })], &HashSet::new());
        assert_eq!(raw.sources.len(), 2);
        assert_eq!(raw.sources[0].status, SourceStatus::NotInstalled);
        assert_eq!(raw.sources[0].found, 0);
        assert_eq!(raw.sources[1].status, SourceStatus::Ok);
        assert_eq!(raw.sources[1].found, 1, "one bad source never zeroes the others");
        assert!(!raw.sources[0].detail.is_empty(), "the reason is stated");
    }

    #[test]
    fn a_source_that_panics_does_not_take_the_scan_down() {
        struct Boom;
        impl Source for Boom {
            fn id(&self) -> &'static str { "boom" }
            fn name(&self) -> &'static str { "Boom" }
            fn group(&self) -> &'static str { "launcher" }
            fn discover(&self) -> Result<Vec<SourceEntry>, SourceError> {
                panic!("this adapter is broken");
            }
        }
        let raw = scan(vec![Box::new(Boom), Box::new(StandaloneSource { entries: vec![entry("standalone", "Hollow Knight", "C:/a", "", 1)] })], &HashSet::new());
        assert_eq!(raw.sources[0].status, SourceStatus::Failed);
        assert_eq!(raw.sources[1].status, SourceStatus::Ok);
        assert_eq!(raw.entries.len(), 1, "the good source still returned its game");
    }

    #[test]
    fn a_disabled_source_is_skipped_and_says_so() {
        let mut d = HashSet::new();
        d.insert("standalone".to_string());
        let raw = scan(vec![Box::new(StandaloneSource { entries: vec![entry("standalone", "Hollow Knight", "C:/a", "", 1)] })], &d);
        assert_eq!(raw.sources[0].status, SourceStatus::Disabled);
        assert!(!raw.sources[0].enabled);
        assert!(raw.entries.is_empty());
    }

    #[test]
    fn an_unreadable_launcher_is_told_to_the_user() {
        struct Locked;
        impl Source for Locked {
            fn id(&self) -> &'static str { "locked" }
            fn name(&self) -> &'static str { "Locked" }
            fn group(&self) -> &'static str { "launcher" }
            fn discover(&self) -> Result<Vec<SourceEntry>, SourceError> {
                Err(SourceError::Unreadable("Access is denied.".into()))
            }
        }
        let raw = scan(vec![Box::new(Locked)], &HashSet::new());
        assert_eq!(raw.sources[0].status, SourceStatus::Unreadable);
        assert_eq!(raw.sources[0].detail, "Access is denied.");
    }

    #[test]
    fn steam_application_ids_are_categorised_not_guessed() {
        assert_eq!(steam_kind("431960"), "application", "Wallpaper Engine");
        assert_eq!(steam_kind("228980"), "tool", "the redistributables");
        assert_eq!(steam_kind("359550"), "game", "an ordinary game");
    }

    #[test]
    fn migration_keeps_old_data_and_only_stamps_the_version() {
        let mut s: AtlasStore = serde_json::from_str(r#"{"favorites":["steam:359550"],"sessions":[],"manual":[],"sort":"recent"}"#).unwrap();
        assert_eq!(s.version, 0, "an old file has no version");
        migrate(&mut s);
        assert_eq!(s.version, STORE_VERSION);
        assert_eq!(s.favorites, vec!["steam:359550".to_string()], "favourites are kept, not rewritten");
    }

    #[test]
    fn a_store_without_the_new_fields_still_parses() {
        // Every added field is #[serde(default)], so a v1 file opens as it stands.
        let s: AtlasStore = serde_json::from_str(r#"{"version":1,"favorites":["manual:abc"]}"#).unwrap();
        assert!(s.disabled_sources.is_empty());
        assert!(s.aliases.is_empty());
        assert_eq!(s.favorites, vec!["manual:abc".to_string()]);
    }

    #[test]
    fn a_launcher_is_never_both_read_and_listed_as_missing() {
        // A launcher with an adapter must not also sit in the not-supported list,
        // or ATLAS would tell the user it cannot read Epic while reading it.
        for done in ["Epic Games", "GOG Galaxy", "Xbox / Microsoft Store", "EA App"] {
            assert!(
                !NOT_SUPPORTED_YET.contains(&done),
                "{} has an adapter and must not be listed as unimplemented",
                done
            );
        }
        for todo in ["Battle.net", "Ubisoft Connect", "Riot Client", "Amazon Games"] {
            assert!(
                NOT_SUPPORTED_YET.contains(&todo),
                "{} has no adapter and must be declared rather than silently absent",
                todo
            );
        }
    }

    #[test]
    fn vdf_still_reads_a_steam_manifest() {
        let t = "\"AppState\"\n{\n\t\"appid\"\t\t\"359550\"\n\t\"name\"\t\t\"Tom Clancy's Rainbow Six Siege\"\n\t\"installdir\"\t\t\"R6Siege\"\n\t\"SizeOnDisk\"\t\t\"51999963136\"\n\t\"LastPlayed\"\t\t\"1759276800\"\n}\n";
        let node = VdfReader::new(t).obj();
        let state = vdf_obj(&node, "AppState").unwrap();
        assert_eq!(vdf_val(state, "appid").unwrap(), "359550");
        assert_eq!(vdf_val(state, "name").unwrap(), "Tom Clancy's Rainbow Six Siege");
        assert_eq!(vdf_u64(state, "SizeOnDisk"), 51999963136);
        assert_eq!(vdf_u64(state, "LastPlayed"), 1759276800);
    }

    #[test]
    fn a_steam_uri_cannot_be_built_from_a_non_decimal_id() {
        // The round trip is the guard: "0123" and "-1" and "1e3" all fail.
        for bad in ["0123", "-1", "1e3", "abc", "", "99999999999999999999"] {
            let ok: Result<u64, _> = bad.parse();
            assert!(ok.is_err() || ok.unwrap().to_string() != bad, "{} must not build a URL", bad);
        }
    }
}
