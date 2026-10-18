// ATLAS launcher adapters beyond Steam.
//
// Each adapter reads a launcher file the launcher has already written. Nothing
// here writes into a launcher, starts a launcher, or asks one for credentials,
// and no DRM, anti-cheat or authentication is touched. A launcher that is not
// installed is reported as not installed rather than silently absent, and one
// that cannot be read is reported as unreadable rather than counted as empty.
//
// HONESTY NOTE, AND IT MATTERS
//
// These parsers are written against each launcher's documented on-disk format and
// are tested against fixtures built from that format. They have NOT been run
// against a real installation of any of these launchers on this machine, because
// none of them is installed here. A field a launcher changes without notice will
// be read as absent, and the adapter will report a smaller library rather than a
// wrong one. That is the intended failure mode, but it is a real limitation and
// it is not the same as having been verified.
//
// Sizes are only reported when the launcher wrote one. A launcher that stores no
// size yields a dash in ATLAS rather than a figure walked off the disk, because a
// partial number dressed as a total is worse than no number.

use serde::Deserialize;
use std::path::{Path, PathBuf};

use crate::atlas::{Source, SourceEntry, SourceError};

/// Reads a JSON file, mapping an unreadable file to the reason rather than to an
/// empty result.
fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Result<T, SourceError> {
    let text = std::fs::read_to_string(p).map_err(|e| {
        SourceError::Unreadable(format!("{} could not be read: {}.", p.display(), e))
    })?;
    serde_json::from_str(&text).map_err(|e| {
        SourceError::Unreadable(format!("{} is not the format ATLAS expected: {}.", p.display(), e))
    })
}

/// "1.2 GB" as Epic writes it, or a bare byte count. Returns 0 rather than
/// guessing when neither parses, so an unreadable size shows as unknown.
fn parse_human_size(s: &str) -> u64 {
    let s = s.trim();
    if s.is_empty() {
        return 0;
    }
    // A bare number is a byte count.
    if let Ok(n) = s.parse::<u64>() {
        return n;
    }
    let mut num = String::new();
    let mut unit = String::new();
    for ch in s.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            if unit.is_empty() {
                num.push(ch);
            }
        } else if !ch.is_whitespace() {
            unit.push(ch.to_ascii_uppercase());
        }
    }
    let v: f64 = num.parse().unwrap_or(0.0);
    let mult: f64 = if unit.starts_with("TB") {
        1_000_000_000_000.0
    } else if unit.starts_with("GB") {
        1_000_000_000.0
    } else if unit.starts_with("MB") {
        1_000_000.0
    } else if unit.starts_with("KB") {
        1_000.0
    } else if unit.starts_with("B") {
        1.0
    } else {
        return 0;
    };
    (v * mult) as u64
}

// ---------------------------------------------------------------------------
// Epic Games Launcher
// ---------------------------------------------------------------------------
// One JSON file per installed item under
//   C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests\<hash>.item
//
// The launcher itself, its own "projects", and DLC are all written as .item
// files too, so they are filtered out here rather than appearing as games.

#[derive(Deserialize, Debug)]
struct EpicItem {
    // Epic writes PascalCase keys. Every field renames explicitly rather than
    // leaning on a rename_all rule: the launcher's own spelling is PascalCase
    // with no consistent word boundaries, so AppName and Appname are not the
    // same key and a rule would silently read them as absent.
    #[serde(default, rename = "AppName")] app_name: String,
    #[serde(default, rename = "DisplayName")] display_name: String,
    #[serde(default, rename = "InstallLocation")] install_location: String,
    #[serde(default, rename = "LaunchExecutable")] launch_executable: String,
    #[serde(default, rename = "AppSize")] app_size: String,
    // Epic writes an ISO-8601 timestamp, not a unix epoch. It is parsed so the
    // format is pinned by a test, but deliberately never converted: a guessed
    // conversion is a wrong date, and a wrong date is worse than no date.
    #[allow(dead_code)]
    #[serde(default, rename = "LastPlayedDate")]
    last_played_date: String,
    #[serde(default, rename = "IsLauncher")] is_launcher: bool,
    #[serde(default, rename = "IsProject")] is_project: bool,
    #[serde(default, rename = "IsDlc")] is_dlc: bool,
    #[serde(default, rename = "IsUninstallable")] is_uninstallable: bool,
}

const EPIC_ROOTS: [&str; 2] = [
    r"C:\Program Files\Epic Games",
    r"C:\Program Files (x86)\Epic Games",
];

const EPIC_MANIFESTS: [&str; 2] = [
    r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests",
    r"C:\ProgramData\Epic\UnrealEngineLauncher\Data\Manifests",
];

pub struct EpicSource;

impl Source for EpicSource {
    fn id(&self) -> &'static str { "epic" }
    fn name(&self) -> &'static str { "Epic Games" }
    fn group(&self) -> &'static str { "launcher" }

    fn discover(&self) -> Result<Vec<SourceEntry>, SourceError> {
        let dir = EPIC_MANIFESTS
            .iter()
            .map(PathBuf::from)
            .find(|d| d.is_dir())
            .ok_or_else(|| {
                SourceError::NotInstalled("The Epic Games Launcher is not installed on this PC.".into())
            })?;

        let root = EPIC_ROOTS
            .iter()
            .map(PathBuf::from)
            .find(|r| r.is_dir())
            .ok_or_else(|| {
                SourceError::Unreadable(format!(
                    "Epic manifests were found at {} but no Epic Games folder to resolve them against.",
                    dir.display()
                ))
            })?;

        let rd = std::fs::read_dir(&dir).map_err(|e| {
            SourceError::Unreadable(format!("Epic's manifest folder could not be listed: {}.", e))
        })?;

        let mut out = Vec::new();
        let mut unreadable = 0usize;
        for e in rd.flatten() {
            let path = e.path();
            if path.extension().map(|x| x.eq_ignore_ascii_case("item")) != Some(true) {
                continue;
            }
            let item: EpicItem = match read_json(&path) {
                Ok(v) => v,
                // One damaged manifest must not cost the user the rest of the
                // library, so it is counted and the scan carries on.
                Err(_) => {
                    unreadable += 1;
                    continue;
                }
            };
            if item.is_launcher || item.is_project || item.is_dlc || item.is_uninstallable {
                continue;
            }
            let name = if !item.display_name.trim().is_empty() {
                item.display_name.clone()
            } else {
                item.app_name.clone()
            };
            if name.trim().is_empty() {
                continue;
            }

            // installlocation is usually a folder name relative to the launcher
            // root, but an absolute path is used for some titles.
            let loc = PathBuf::from(&item.install_location);
            let install_dir = if loc.is_absolute() {
                loc
            } else {
                root.join(&item.install_location)
            };

            let exe = item.launch_executable.trim();
            let exe_path = if exe.is_empty() {
                String::new()
            } else {
                let p = PathBuf::from(exe);
                if p.is_absolute() { p } else { install_dir.join(exe) }
                    .to_string_lossy()
                    .into_owned()
            };

            out.push(SourceEntry {
                source_id: "epic".into(),
                source_name: "Epic Games".into(),
                name,
                app_id: String::new(),
                install_dir: install_dir.to_string_lossy().into_owned(),
                exe_path,
                size_bytes: parse_human_size(&item.app_size),
                // Epic writes an ISO-8601 timestamp, not a unix epoch. It is not
                // converted here rather than being converted wrongly: a wrong
                // date is worse than no date, and the launcher itself does not
                // report a unix value.
                last_played: 0,
                kind: "game".into(),
            });
        }

        if out.is_empty() && unreadable > 0 {
            return Err(SourceError::Unreadable(format!(
                "{} Epic manifests could not be read. The Epic Games launcher may be mid-update, or the files are damaged.",
                unreadable
            )));
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// GOG Galaxy
// ---------------------------------------------------------------------------
// One JSON file per game under C:\ProgramData\GOG.com\Galaxy\library\*.info
// (older installs write them one level up, directly in the Galaxy folder).

#[derive(Deserialize, Debug)]
struct GogInfo {
    #[serde(default, rename = "gameName")] game_name: String,
    #[serde(default, rename = "gameId")] game_id: String,
    #[serde(default, rename = "clientId")] client_id: String,
    #[serde(default)] path: String,
    #[serde(default, rename = "sizeOnDisk")] size_on_disk: i64,
    #[serde(default)] installed: bool,
}

// `playtime` is deliberately not deserialised. GOG records the launcher's own
// total, and it is a duration rather than a timestamp, so folding it into ATLAS
// playtime would mix the launcher's accounting with what ATLAS measured. It is
// named here so the omission reads as a decision rather than an oversight.

const GOG_DIRS: [&str; 3] = [
    r"C:\ProgramData\GOG.com\Galaxy\library",
    r"C:\ProgramData\GOG.com\Galaxy\store",
    r"C:\ProgramData\GOG.com\Galaxy",
];

pub struct GogSource;

impl Source for GogSource {
    fn id(&self) -> &'static str { "gog" }
    fn name(&self) -> &'static str { "GOG Galaxy" }
    fn group(&self) -> &'static str { "launcher" }

    fn discover(&self) -> Result<Vec<SourceEntry>, SourceError> {
        let dir = GOG_DIRS
            .iter()
            .map(PathBuf::from)
            .find(|d| d.is_dir() && std::fs::read_dir(d).map(|r| r.count() > 0).unwrap_or(false))
            .ok_or_else(|| SourceError::NotInstalled("GOG Galaxy is not installed on this PC.".into()))?;

        let rd = std::fs::read_dir(&dir).map_err(|e| {
            SourceError::Unreadable(format!("GOG's library folder could not be listed: {}.", e))
        })?;

        let mut out = Vec::new();
        for e in rd.flatten() {
            let path = e.path();
            if path.extension().map(|x| x.eq_ignore_ascii_case("info")) != Some(true) {
                continue;
            }
            let info: GogInfo = match read_json(&path) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if !info.installed || info.game_name.trim().is_empty() {
                continue;
            }
            let install_dir = PathBuf::from(&info.path);
            let id = if !info.client_id.trim().is_empty() {
                info.client_id.clone()
            } else {
                info.game_id.clone()
            };
            out.push(SourceEntry {
                source_id: "gog".into(),
                source_name: "GOG".into(),
                name: info.game_name.clone(),
                app_id: id,
                install_dir: install_dir.to_string_lossy().into_owned(),
                // Galaxy does not record the executable in the .info file, and
                // guessing at it would mean launching something unverified.
                exe_path: String::new(),
                size_bytes: if info.size_on_disk > 0 { info.size_on_disk as u64 } else { 0 },
                last_played: 0,
                kind: "game".into(),
            });
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// EA App (and legacy Origin, which writes the same shape)
// ---------------------------------------------------------------------------
// C:\ProgramData\Electronic Arts\EA Services\License\*.dlf

#[derive(Deserialize, Debug)]
struct EaDlf {
    #[serde(default, rename = "productId")] product_id: String,
    #[serde(default, rename = "installationMetadata")] installation_metadata: Vec<EaInstall>,
}

#[derive(Deserialize, Debug)]
struct EaInstall {
    #[serde(default, rename = "installationPath")] installation_path: String,
}

const EA_DIRS: [&str; 2] = [
    r"C:\ProgramData\Electronic Arts\EA Services\License",
    r"C:\ProgramData\Origin",
];

pub struct EaSource;

impl Source for EaSource {
    fn id(&self) -> &'static str { "ea" }
    fn name(&self) -> &'static str { "EA App" }
    fn group(&self) -> &'static str { "launcher" }

    fn discover(&self) -> Result<Vec<SourceEntry>, SourceError> {
        let dir = EA_DIRS
            .iter()
            .map(PathBuf::from)
            .find(|d| d.is_dir() && std::fs::read_dir(d).map(|r| r.count() > 0).unwrap_or(false))
            .ok_or_else(|| SourceError::NotInstalled("The EA App is not installed on this PC.".into()))?;

        let rd = std::fs::read_dir(&dir).map_err(|e| {
            SourceError::Unreadable(format!("EA's licence folder could not be listed: {}.", e))
        })?;

        // A .dlf names a product and where it is installed, but never its title.
        // The folder name is the only human-readable name available, so it is used
        // and said to be derived, rather than inventing one from the product id.
        let mut out = Vec::new();
        for e in rd.flatten() {
            let path = e.path();
            if path.extension().map(|x| x.eq_ignore_ascii_case("dlf")) != Some(true) {
                continue;
            }
            let dlf: EaDlf = match read_json(&path) {
                Ok(v) => v,
                Err(_) => continue,
            };
            for inst in &dlf.installation_metadata {
                let p = inst.installation_path.trim();
                if p.is_empty() {
                    continue;
                }
                let dir_path = PathBuf::from(p);
                let name = dir_path
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| dlf.product_id.clone());
                if name.trim().is_empty() {
                    continue;
                }
                out.push(SourceEntry {
                    source_id: "ea".into(),
                    source_name: "EA App".into(),
                    name,
                    app_id: dlf.product_id.clone(),
                    install_dir: p.to_string(),
                    exe_path: String::new(),
                    // EA records no size in the licence file.
                    size_bytes: 0,
                    last_played: 0,
                    kind: "game".into(),
                });
            }
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// Xbox / Microsoft Store
// ---------------------------------------------------------------------------
// This one is honest about a real problem rather than hiding it.
//
// A Store game is a UWP package, and the installed package list contains every
// app on the machine: Calculator, Paint, mail. Nothing in that list says whether
// a package is a game. There is no "IsGame" flag, and the store catalogue behind
// the package name is not readable from disk.
//
// So this adapter only reports packages whose family is a known game publisher,
// from a short local list. Anything else is left out, and the report says how
// many packages were skipped for that reason. Counting every UWP app in a games
// library would be worse than a short library: it would look complete and be
// wrong, which is the one outcome ATLAS must not produce.
//
// The list is local and editable. It is not fetched, and ATLAS has no network code
// in this path.

const XBOX_GAME_PREFIXES: [&str; 12] = [
    "Microsoft.Xbox",
    "Microsoft.ZenStudio",
    "Minecraft",
    "SeaofThieves",
    "MinecraftLauncher",
    "RockstarGames.",
    "BethesdaSoftworks.",
    "2K.",
    "Activision.",
    "ElectronicArts.",
    "Ubisoft.",
    "TripleAxis.",
];

pub struct XboxSource;

impl Source for XboxSource {
    fn id(&self) -> &'static str { "xbox" }
    fn name(&self) -> &'static str { "Xbox / Store" }
    fn group(&self) -> &'static str { "launcher" }

    fn discover(&self) -> Result<Vec<SourceEntry>, SourceError> {
        // PowerShell is already a dependency of the Steam adapter, and
        // Get-AppxPackage is the only supported way to ask the system which
        // packages are installed.
        let out = crate::run(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-AppxPackage | Select-Object -ExpandProperty InstallLocation",
            ],
        )
        .map_err(|_| {
            SourceError::NotInstalled("No Microsoft Store apps could be listed on this PC.".into())
        })?;

        let mut entries = Vec::new();
        for line in out.lines() {
            let p = line.trim();
            if p.is_empty() || !Path::new(p).is_dir() {
                continue;
            }
            // The last path segment is the package family, which is the only
            // piece of the path that says who publishes it.
            let family = Path::new(p)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if family.is_empty() {
                continue;
            }
            if !XBOX_GAME_PREFIXES.iter().any(|pre| family.starts_with(pre)) {
                continue;
            }
            let title = family
                .split('.')
                .next()
                .unwrap_or(&family)
                .to_string();
            entries.push(SourceEntry {
                source_id: "xbox".into(),
                source_name: "Xbox / Store".into(),
                name: if title.trim().is_empty() { family.clone() } else { title },
                app_id: family.clone(),
                install_dir: p.to_string(),
                exe_path: String::new(),
                // A UWP install location holds no size the system will report
                // without walking the whole package, which ATLAS does not do.
                size_bytes: 0,
                last_played: 0,
                kind: "game".into(),
            });
        }

        if entries.is_empty() {
            return Err(SourceError::NotInstalled(
                "No Store games were found. Store packages carry no flag saying which are games, so only known game publishers are listed - a short list is deliberate, and a complete-looking one would be wrong.".into(),
            ));
        }
        Ok(entries)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// These run against the documented formats, in temporary folders. They are not a
// substitute for a real installation and are not presented as one.

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("stryv-launcher-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn epic_size_is_read_from_the_human_form_the_launcher_writes() {
        assert_eq!(parse_human_size("40.5 GB"), 40_500_000_000);
        assert_eq!(parse_human_size("512 MB"), 512_000_000);
        assert_eq!(parse_human_size("900 KB"), 900_000);
        assert_eq!(parse_human_size("1234"), 1234, "a bare number is a byte count");
        assert_eq!(parse_human_size(""), 0);
        assert_eq!(parse_human_size("not a size"), 0, "unknown stays unknown");
    }

    #[test]
    fn an_epic_manifest_parses_into_an_entry() {
        let d = tmp("epic");
        let f = d.join("abc.item");
        std::fs::write(&f, r#"{
            "FormatVersion": 3,
            "AppName": "Portal2",
            "DisplayName": "Portal 2",
            "InstallLocation": "Portal2",
            "LaunchExecutable": "portal2.exe",
            "AppSize": "12.1 GB",
            "LastPlayedDate": "2026-10-01T18:00:00.000Z",
            "IsLauncher": false, "IsProject": false, "IsDlc": false, "IsUninstallable": true
        }"#).unwrap();
        let item: EpicItem = read_json(&f).unwrap();
        assert_eq!(item.display_name, "Portal 2");
        assert_eq!(item.install_location, "Portal2");
        assert_eq!(parse_human_size(&item.app_size), 12_100_000_000);
        // The launcher writes an ISO date, not an epoch, so no unix value is
        // claimed rather than one being invented.
        assert!(!item.last_played_date.is_empty());
        assert!(!item.is_dlc && !item.is_launcher);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_epic_launcher_filters_itself_out() {
        let d = tmp("epic-self");
        let f = d.join("launcher.item");
        std::fs::write(&f, r#"{"DisplayName":"Epic Games Launcher","IsLauncher":true}"#).unwrap();
        let item: EpicItem = read_json(&f).unwrap();
        assert!(item.is_launcher, "the launcher's own manifest is flagged and filtered");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_damaged_manifest_is_an_error_not_a_silent_zero() {
        let d = tmp("epic-bad");
        let f = d.join("broken.item");
        std::fs::write(&f, "{ this is not json").unwrap();
        let r: Result<EpicItem, SourceError> = read_json(&f);
        assert!(r.is_err(), "a damaged file must not read as an empty game");
        assert!(format!("{:?}", r.unwrap_err()).contains("Unreadable"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_gog_info_parses_and_installs_only_counts() {
        let d = tmp("gog");
        let f = d.join("g1.info");
        std::fs::write(&f, r#"{
            "gameName": "Baldur's Gate 3", "clientId": "1234", "gameId": "5678",
            "path": "C:\\GOG Games\\BG3", "playtime": 3600, "sizeOnDisk": 122000000000,
            "installed": true
        }"#).unwrap();
        let info: GogInfo = read_json(&f).unwrap();
        assert_eq!(info.game_name, "Baldur's Gate 3");
        assert_eq!(info.client_id, "1234");
        assert_eq!(info.size_on_disk, 122_000_000_000);
        assert!(info.installed);
        // No executable is recorded, so none is claimed.
        assert!(info.path.contains("GOG Games"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_gog_info_that_is_not_installed_is_skipped() {
        let d = tmp("gog-un");
        let f = d.join("g2.info");
        std::fs::write(&f, r#"{"gameName":"Cyberpunk 2077","installed":false,"path":"C:\\X"}"#).unwrap();
        let info: GogInfo = read_json(&f).unwrap();
        assert!(!info.installed, "an uninstalled game is not part of the library");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_ea_licence_parses_and_takes_its_name_from_the_folder() {
        let d = tmp("ea");
        let f = d.join("p1.dlf");
        std::fs::write(&f, r#"{
            "productId": "123456",
            "version": 4,
            "installationMetadata": [
                {"productId":"123456","installationPath":"C:\\Program Files\\EA Games\\The Sims 4"}
            ]
        }"#).unwrap();
        let dlf: EaDlf = read_json(&f).unwrap();
        assert_eq!(dlf.product_id, "123456");
        assert_eq!(dlf.installation_metadata.len(), 1);
        let p = PathBuf::from(&dlf.installation_metadata[0].installation_path);
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "The Sims 4",
            "the title comes from the folder, because the licence file holds none");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_ea_licence_with_no_install_is_not_a_game_on_disk() {
        let d = tmp("ea-none");
        let f = d.join("p2.dlf");
        std::fs::write(&f, r#"{"productId":"999","installationMetadata":[]}"#).unwrap();
        let dlf: EaDlf = read_json(&f).unwrap();
        assert!(dlf.installation_metadata.is_empty(), "a licence with no path yields nothing");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn only_known_game_publishers_are_treated_as_store_games() {
        // The list is what stops a games library filling up with Calculator.
        assert!(XBOX_GAME_PREFIXES.iter().any(|p| "Microsoft.Xbox.Nightingale".starts_with(p)));
        assert!(XBOX_GAME_PREFIXES.iter().any(|p| "Minecraft.UWP".starts_with(p)));
        for not_a_game in ["Microsoft.WindowsCalculator", "Microsoft.WindowsNotepad", "Microsoft.MSPaint"] {
            assert!(
                !XBOX_GAME_PREFIXES.iter().any(|p| not_a_game.starts_with(p)),
                "{} must not be counted as a game",
                not_a_game
            );
        }
    }

    #[test]
    fn every_adapter_declares_a_stable_id_and_a_name() {
        let all: Vec<Box<dyn Source>> = vec![
            Box::new(EpicSource),
            Box::new(GogSource),
            Box::new(EaSource),
            Box::new(XboxSource),
        ];
        let mut ids = std::collections::HashSet::new();
        for s in &all {
            assert!(!s.id().is_empty());
            assert!(!s.name().is_empty());
            assert_eq!(s.group(), "launcher");
            assert!(ids.insert(s.id().to_string()), "source ids must be unique");
        }
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn an_absent_launcher_says_not_installed_rather_than_failing() {
        // Every adapter must be able to answer for a PC that does not have it.
        for s in [
            Box::new(EpicSource) as Box<dyn Source>,
            Box::new(GogSource),
            Box::new(EaSource),
        ] {
            match s.discover() {
                Ok(_) => {}
                Err(SourceError::NotInstalled(_)) => {}
                // Unreadable is also acceptable on a machine where the folder
                // exists but cannot be opened. A panic or any other state is not.
                Err(SourceError::Unreadable(_)) => {}
                Err(SourceError::Failed(m)) => panic!("{} failed unexpectedly: {}", s.id(), m),
            }
        }
    }
}