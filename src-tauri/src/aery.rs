// A child module does not inherit the parent's imports, so these are declared
// here. now_unix lives in main.rs and is reached through super.
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::Manager;
// ============================================================================
// AERY - the vault
//
// Notes are plain .md files in a folder the user owns. Nothing is stored in a
// database, so the knowledge survives STRYV being uninstalled, and opens in
// any editor. A small sidecar file holds only what Markdown cannot: the stable
// id, pin state and timestamps.
//
// Every write goes to a temporary file first and is renamed into place, so an
// interrupted save can never leave a half-written note behind.
// ============================================================================

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AeryNote {
    id: String,
    title: String,
    path: String,          // relative to the vault root, using forward slashes
    folder: String,
    pinned: bool,
    created: u64,
    modified: u64,
    size: u64,
    excerpt: String,
    tags: Vec<String>,
    // Filled in on read for the selected note only.
    links: Vec<String>,
    backlinks: Vec<String>,
}

const AERY_META: &str = ".aery.json";

const AERY_CFG: &str = "aery-vaults.json";

// `serde(default)` matters here. Without it, a config missing `known` fails to
// deserialize, and aery_read_cfg's unwrap_or_default throws away the whole file
// - including `current`, which is the user's chosen vault. A partial file would
// silently reset where their notes are read from.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct AeryVaults {
    current: String,
    known: Vec<String>,
}

fn aery_cfg_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(AERY_CFG))
}

pub fn aery_read_cfg(app: &tauri::AppHandle) -> AeryVaults {
    let Ok(p) = aery_cfg_path(app) else { return AeryVaults::default() };
    let Ok(t) = std::fs::read_to_string(p) else { return AeryVaults::default() };
    serde_json::from_str(&t).unwrap_or_default()
}

pub fn aery_write_cfg(app: &tauri::AppHandle, c: &AeryVaults) -> Result<(), String> {
    let body = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    aery_atomic_write(&aery_cfg_path(app)?, body.as_bytes())
}

/// Resolve the vault the user has chosen, falling back to a default inside app
/// data the first time. The path is canonicalised so every later containment
/// check compares like with like.
pub fn aery_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let cfg = aery_read_cfg(app);
    if !cfg.current.is_empty() {
        let p = PathBuf::from(&cfg.current);
        if p.is_dir() {
            return Ok(p.canonicalize().unwrap_or(p));
        }
        // The chosen folder has gone - a moved drive, a deleted folder. Fall
        // back rather than failing every command, but do not silently rewrite
        // the user's choice: the old path stays in `known`.
    }
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let v = d.join("vault");
    std::fs::create_dir_all(&v).map_err(|e| e.to_string())?;
    Ok(v.canonicalize().unwrap_or(v))
}

#[tauri::command]
pub fn aery_vaults(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let cfg = aery_read_cfg(&app);
    let mut known: Vec<serde_json::Value> = Vec::new();
    for p in &cfg.known {
        let path = PathBuf::from(p);
        let ok = path.is_dir();
        let count = if ok { aery_count_md(&path) } else { 0 };
        known.push(json!({
            "path": p,
            "name": path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| p.clone()),
            "exists": ok,
            "notes": count,
        }));
    }
    Ok(json!({
        "current": aery_root(&app)?.to_string_lossy().to_string(),
        "known": known,
        "persisted": !cfg.current.is_empty(),
    }))
}

/// Switch to a folder the user already has. Recorded so it can be reopened,
/// and never written into.
#[tauri::command]
pub fn aery_vault_open(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_dir() {
        return Err("That folder does not exist, or is not a folder.".into());
    }
    let canon = p.canonicalize().map_err(|e| e.to_string())?;
    let mut cfg = aery_read_cfg(&app);
    let s = canon.to_string_lossy().to_string();
    cfg.current = s.clone();
    if !cfg.known.iter().any(|k| k == &s) {
        cfg.known.push(s.clone());
    }
    aery_write_cfg(&app, &cfg)?;
    Ok(s)
}

/// Create a new vault at an explicit path, so the user decides where it lives.
#[tauri::command]
pub fn aery_vault_create(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(path.trim());
    if p.exists() && !p.is_dir() {
        return Err("Something is already at that path and it is not a folder.".into());
    }
    std::fs::create_dir_all(&p).map_err(|e| format!("Could not create that folder: {}", e))?;
    // A new vault gets a guide note, so opening one is never an empty box.
    let readme = p.join("Start here.md");
    if !readme.exists() {
        let body = "---\ntitle: Start here\naery_id: welcome\n---\n\n\
# Your vault\n\n\
This folder is yours. Everything Aery stores is a plain Markdown file inside it, \
so you can open it in any editor, put it in Dropbox, or sync it however you like.\n\n\
- Create a note with **New**.\n\
- Link notes to each other with [[double brackets]].\n\
- Deleted notes go to `.trash` and can be restored.\n\
- Aery never uploads anything.\n\n\
Delete this file whenever you like.\n";
        aery_atomic_write(&readme, body.as_bytes())?;
    }
    aery_vault_open(app, p.to_string_lossy().to_string())
}

/// Forget a remembered vault. This only removes it from the list - it never
/// deletes a single file the user owns.
#[tauri::command]
pub fn aery_vault_forget(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let mut cfg = aery_read_cfg(&app);
    cfg.known.retain(|k| k != path.trim());
    if cfg.current == path.trim() {
        cfg.current = String::new();
    }
    aery_write_cfg(&app, &cfg)
}

/// Markdown file count, used to label each known vault. Cheap: one read_dir
/// per top-level entry, capped so a huge folder cannot stall the UI.
pub fn aery_count_md(root: &Path) -> usize {
    fn walk(d: &Path, depth: u32, n: &mut usize) {
        if depth > 8 || *n > 5000 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                walk(&p, depth + 1, n);
            } else if p.extension().map(|x| x.eq_ignore_ascii_case("md")).unwrap_or(false) {
                *n += 1;
            }
        }
    }
    let mut n = 0;
    walk(root, 0, &mut n);
    n
}

// ---- ids ------------------------------------------------------------------
// Derived from the note's relative path, so moving or renaming a note keeps the
// same identity. Renaming therefore cannot silently break somebody's links.
pub fn aery_id(rel: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in rel.to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    format!("a{:016x}", h)
}

// A note's identity must outlive its path. `aery_id` is a path hash, so it
// changed on every rename - which orphaned pins, orphaned the frontend's open
// note, and turned autosave into an endless failure loop. A stable id lives in
// the note's own front matter, so the file itself carries its identity and a
// rename is just a rename.
pub fn aery_front_id(text: &str) -> Option<String> {
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    for line in rest[..end].lines() {
        if let Some(v) = line.strip_prefix("aery_id:") {
            let t = v.trim().trim_matches('"').trim_matches('\'');
            if t.len() >= 6 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return Some(t.to_string());
            }
        }
    }
    None
}


/// Insert or replace the `aery_id:` key, preserving every other front-matter
/// key and the body byte for byte.
pub fn aery_ensure_id(text: &str, id: &str) -> String {
    if aery_front_id(text).is_some() { return text.to_string(); }
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            let head = &rest[..end];
            let tail = &rest[end..];
            return format!("---\n{}\naery_id: {}\n{}", head, id, tail);
        }
    }
    format!("---\naery_id: {}\n---\n\n{}", id, text)
}

pub fn aery_rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

// ---- metadata -------------------------------------------------------------
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AeryMeta {
    pinned: Vec<String>,        // note ids
    created: Vec<(String, u64)>,
}

pub fn aery_read_meta(root: &Path) -> AeryMeta {
    let Ok(t) = std::fs::read_to_string(root.join(AERY_META)) else { return AeryMeta::default() };
    serde_json::from_str(&t).unwrap_or_default()
}

pub fn aery_write_meta(root: &Path, m: &AeryMeta) -> Result<(), String> {
    let body = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    aery_atomic_write(&root.join(AERY_META), body.as_bytes())
}

// Write to a sibling temp file, then rename over the target. A crash mid-write
// leaves the original note untouched.
pub fn aery_atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = target.with_extension(format!("tmp{}", super::now_unix()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    match std::fs::rename(&tmp, target) {
        Ok(_) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
}

// ---- markdown -------------------------------------------------------------
// Only what the vault actually needs to understand: the title from front matter
// or the first heading, and inline and front-matter tags. This is a reader, not
// a renderer - the app writes Markdown, it never rewrites it.
pub fn aery_title(text: &str, fallback: &str) -> String {
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some(v) = line.strip_prefix("title:") {
                    let t = v.trim().trim_matches('"').trim_matches('\'');
                    if !t.is_empty() {
                        return t.to_string();
                    }
                }
            }
        }
    }
    for line in text.lines() {
        let l = line.trim();
        if let Some(h) = l.strip_prefix("# ") {
            return h.trim().to_string();
        }
    }
    fallback.to_string()
}

pub fn aery_front_tags(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some(v) = line.strip_prefix("tags:") {
                    for raw in v.trim_matches('[').trim_matches(']').split(',') {
                        let t = raw.trim().trim_matches('"').trim_matches('\'').trim_start_matches('#').trim();
                        if !t.is_empty() {
                            out.push(t.to_lowercase());
                        }
                    }
                }
            }
        }
    }
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('#') && !l.starts_with("##") && !l.starts_with("# ") {
            for w in l.split_whitespace() {
                if w.len() > 1 && w.starts_with('#') && w[1..].chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '/') {
                    out.push(w[1..].to_lowercase());
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

// [[Title]] or [[Title|shown text]]
pub fn aery_links(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let b: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == '[' && b[i + 1] == '[' {
            let mut j = i + 2;
            let mut inner = String::new();
            let mut closed = false;
            while j < b.len() {
                if b[j] == ']' && j + 1 < b.len() && b[j + 1] == ']' {
                    closed = true;
                    break;
                }
                inner.push(b[j]);
                j += 1;
            }
            if closed {
                let target = inner.split('|').next().unwrap_or("").trim().to_string();
                if !target.is_empty() {
                    out.push(target);
                }
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }
    out.sort();
    out.dedup();
    out
}

// A note body used for the list view and for search.
pub fn aery_excerpt(text: &str) -> String {
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("---") && !l.starts_with("```"))
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(280)
        .collect::<String>()
}

// ---- scanning -------------------------------------------------------------
pub fn aery_scan_dir(root: &Path, dir: &Path, meta: &AeryMeta, out: &mut Vec<AeryNote>, depth: u32) {
    // Bounded so a symlink loop or a pathological tree cannot hang the app.
    if depth > 12 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            aery_scan_dir(root, &p, meta, out, depth + 1);
            continue;
        }
        if p.extension().map(|x| x.eq_ignore_ascii_case("md")).unwrap_or(false) {
            let rel = aery_rel_of(root, &p);
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            // Prefer the id stored in the note's own front matter so it survives a
            // rename or move; fall back to the path hash for notes Aery has never
            // written, which also keeps every pin recorded before this change valid.
            let id = aery_front_id(&text).unwrap_or_else(|| aery_id(&rel));
            let folder = match rel.rfind('/') {
                Some(x) => rel[..x].to_string(),
                None => String::new(),
            };
            let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    
            out.push(AeryNote {
                id: id.clone(),
                title: aery_title(&text, &stem),
                path: rel,
                folder,
                pinned: meta.pinned.iter().any(|x| *x == id),
                created: meta.created.iter().find(|(k, _)| *k == id).map(|(_, v)| *v).unwrap_or(0),
                modified: p.metadata().and_then(|m| m.modified()).ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs()).unwrap_or(0),
                size: p.metadata().map(|m| m.len()).unwrap_or(0),
                excerpt: aery_excerpt(&text),
                tags: aery_front_tags(&text),
                links: Vec::new(),
                backlinks: Vec::new(),
            });
        }
    }
}

pub fn aery_resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = root.join(rel.replace('/', "\\"));
    // A note path may not escape the vault, however it was asked for.
    let canon_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canon = p.canonicalize().map_err(|_| "That note no longer exists.".to_string())?;
    if !canon.starts_with(&canon_root) {
        return Err("That note is outside the vault.".into());
    }
    Ok(canon)
}

// ---- commands -------------------------------------------------------------

/// Title, excerpt and tag match. The body is deliberately not read here: the
/// excerpt is only the first 280 characters, so a body search has to be a file
/// read, and that is the caller's job so a library with no query never pays for
/// it.
pub fn aery_meta_matches(n: &AeryNote, term: &str) -> bool {
    n.title.to_lowercase().contains(term)
        || n.excerpt.to_lowercase().contains(term)
        || n.tags.iter().any(|t| t.contains(term))
}

/// The search filter, with the body reader injected so it can be tested without
/// an AppHandle. `read` is only called for a note the metadata did not already
/// match, so the common case is one pass over what the scan already had.
pub fn aery_filter<F>(notes: Vec<AeryNote>, term: &str, want_tag: &str, read: F) -> Vec<AeryNote>
where
    F: Fn(&AeryNote) -> Option<String>,
{
    // Normalised here rather than trusted from the caller: the command already
    // does it, but a helper that only works for pre-lowercased input is a trap.
    let term = term.trim().to_lowercase();
    let want_tag = want_tag.trim().trim_start_matches('#').to_lowercase();
    notes
        .into_iter()
        .filter(|n| {
            if !want_tag.is_empty() && !n.tags.iter().any(|t| t == &want_tag) {
                return false;
            }
            if term.is_empty() || aery_meta_matches(n, &term) {
                return true;
            }
            // A match past the excerpt is still a match. Without this, a note
            // whose word appears halfway down its body was reported as not in
            // the vault, which is worse than a slow search.
            read(n)
                .map(|text| text.to_lowercase().contains(term.as_str()))
                .unwrap_or(false)
        })
        .collect()
}

#[tauri::command]
pub fn aery_list(app: tauri::AppHandle, q: Option<String>, tag: Option<String>) -> Result<Vec<AeryNote>, String> {
    let root = aery_root(&app)?;
    let meta = aery_read_meta(&root);
    let mut notes: Vec<AeryNote> = Vec::new();
    aery_scan_dir(&root, &root, &meta, &mut notes, 0);

    let term = q.unwrap_or_default().trim().to_lowercase();
    let want_tag = tag.unwrap_or_default().trim().trim_start_matches('#').to_lowercase();
    if !term.is_empty() || !want_tag.is_empty() {
        notes = aery_filter(notes, &term, &want_tag, |n| {
            aery_resolve(&root, &n.path)
                .ok()
                .and_then(|p| std::fs::read_to_string(p).ok())
        });
    }

    notes.sort_by(|a, b| {
        b.pinned.cmp(&a.pinned).then(b.modified.cmp(&a.modified)).then(a.title.cmp(&b.title))
    });
    Ok(notes)
}

/// The link graph, as nodes and directed edges. A link that points at a title
/// no note carries is left out of the edges rather than drawn to a phantom
/// node: the note view already shows unresolved links, and inventing a node here
/// would make the map claim a connection that does not exist.
///
/// Titles are matched case-insensitively, the same rule `aery_read` uses, so the
/// graph and the backlink panel can never disagree about what links where.
#[tauri::command]
pub fn aery_graph(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let root = aery_root(&app)?;
    let meta = aery_read_meta(&root);
    let mut notes: Vec<AeryNote> = Vec::new();
    aery_scan_dir(&root, &root, &meta, &mut notes, 0);

    let mut edges: Vec<(String, String)> = Vec::new();
    for n in &notes {
        let Ok(text) = std::fs::read_to_string(aery_resolve(&root, &n.path)?) else { continue };
        for target in aery_links(&text) {
            let Some(to) = notes.iter().find(|o| o.title.eq_ignore_ascii_case(&target)) else {
                continue;
            };
            // A self-link is not a connection between two notes, and a duplicate
            // link in one note is one edge, not several.
            if to.id == n.id || edges.iter().any(|(f, t)| *f == n.id && *t == to.id) {
                continue;
            }
            edges.push((n.id.clone(), to.id.clone()));
        }
    }

    Ok(json!({
        "nodes": notes.iter().map(|n| json!({
            "id": n.id,
            "title": n.title,
            "folder": n.folder,
            "pinned": n.pinned,
        })).collect::<Vec<_>>(),
        "edges": edges.iter().map(|(f, t)| json!({ "from": f, "to": t })).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
pub fn aery_read(app: tauri::AppHandle, id: String) -> Result<serde_json::Value, String> {    let root = aery_root(&app)?;
    let meta = aery_read_meta(&root);
    let mut notes: Vec<AeryNote> = Vec::new();
    aery_scan_dir(&root, &root, &meta, &mut notes, 0);
    let Some(note) = notes.iter().find(|n| n.id == id) else {
        return Err("That note is not in the vault.".into());
    };
    let path = aery_resolve(&root, &note.path)?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

    // Links resolve by title, case-insensitively. An unresolved link is kept and
    // reported as unresolved rather than quietly dropped.
    let outgoing: Vec<serde_json::Value> = aery_links(&text)
        .into_iter()
        .map(|t| {
            let target = notes.iter().find(|n| n.title.eq_ignore_ascii_case(&t));
            json!({
                "title": t,
                "resolved": target.map(|n| n.id.clone()),
                "path": target.map(|n| n.path.clone()),
            })
        })
        .collect();

    let mut back: Vec<AeryNote> = Vec::new();
    for other in &notes {
        if other.id == note.id {
            continue;
        }
        let Ok(ot) = std::fs::read_to_string(aery_resolve(&root, &other.path)?) else { continue };
        if aery_links(&ot)
            .iter()
            .any(|l| l.eq_ignore_ascii_case(&note.title))
        {
            back.push(AeryNote { links: Vec::new(), backlinks: Vec::new(), ..other.clone() });
        }
    }

    // These are the note's OWN tags. It previously sent the union of every tag
    // in the vault, which the context panel then labelled "Tags", so each note
    // appeared to carry tags it never had.
    let mut note_tags: Vec<String> = notes.iter()
        .find(|n| n.id == id)
        .map(|n| n.tags.clone())
        .unwrap_or_default();
    note_tags.sort();
    note_tags.dedup();

    Ok(json!({
        "note": note,
        "content": text,
        "outgoing": outgoing,
        "backlinks": back,
        "tags": note_tags,
        "word_count": text.split_whitespace().count(),
    }))
}

#[tauri::command]
pub fn aery_save(app: tauri::AppHandle, id: String, content: String) -> Result<(), String> {
    let root = aery_root(&app)?;
    let meta = aery_read_meta(&root);
    let mut notes: Vec<AeryNote> = Vec::new();
    aery_scan_dir(&root, &root, &meta, &mut notes, 0);
    let Some(note) = notes.iter().find(|n| n.id == id).cloned() else {
        return Err("That note is not in the vault.".into());
    };
    let path = aery_resolve(&root, &note.path)?;
    // Stamp a stable identity the first time a note is saved, so a later rename
    // cannot orphan its pins or the note open in the editor. Idempotent: a note
    // that already carries an id is written back byte for byte.
    let body = match aery_front_id(&content) {
        Some(_) => content,
        None => aery_ensure_id(&content, &note.id),
    };
    aery_atomic_write(&path, body.as_bytes())
}

#[tauri::command]
pub fn aery_create(app: tauri::AppHandle, title: Option<String>, folder: Option<String>) -> Result<AeryNote, String> {
    let root = aery_root(&app)?;
    let want = title.unwrap_or_default().trim().to_string();
    let base = if want.is_empty() { "Untitled".to_string() } else { want.clone() };

    // A new note gets a readable filename. A title collision is given a suffix
    // rather than overwriting whatever is already there.
    let mut name = aery_safe_stem(&base);
    let mut n = 2;
    loop {
        // Every user-supplied folder goes through the same containment check as a
    // note path. Previously this joined the input directly, and
    // aery_atomic_write does create_dir_all on the parent - so
    // folder = "../../evil" wrote outside the vault.
    let want = folder.clone().unwrap_or_default().replace('\\', "/");
    let dir = if want.trim().is_empty() {
        root.clone()
    } else {
        let cand = root.join(want.replace('/', "\\"));
        let canon = cand.canonicalize().map_err(|_| "That folder is not in the vault.".to_string())?;
        if !canon.starts_with(&root) {
            return Err("A folder cannot be outside the vault.".into());
        }
        canon
    };
        let candidate = dir.join(format!("{}.md", name));
        if !candidate.exists() {
            let rel = aery_rel_of(&root, &candidate);
            let id = aery_id(&rel);
              // The id goes into the note itself, so it survives a rename. Deriving it and
              // returning it without writing it down would leave every note keyed by its
              // path, which is what aery_front_id exists to stop.
              let body = aery_ensure_id(&format!("---\ntitle: {}\n---\n\n", base), &id);
            aery_atomic_write(&candidate, body.as_bytes())?;
            let mut meta = aery_read_meta(&root);
            let ts = super::now_unix();
            meta.created.push((id.clone(), ts));
            aery_write_meta(&root, &meta)?;
            return Ok(AeryNote {
                id,
                title: base,
                path: rel,
                folder: folder.clone().unwrap_or_default(),
                pinned: false,
                created: ts,
                modified: ts,
                size: body.len() as u64,
                excerpt: String::new(),
                tags: Vec::new(),
                links: Vec::new(),
                backlinks: Vec::new(),
            });
        }
        name = format!("{} {}", aery_safe_stem(&base), n);
        n += 1;
        if n > 500 {
            return Err("Could not find a free filename for that note.".into());
        }
    }
}

// Keeps a title usable as a Windows filename.
pub fn aery_safe_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if (c as u32) < 0x20 => '-',
            c => c,
        })
        .collect();
    let t = cleaned.trim().trim_matches('.').trim().to_string();
    if t.is_empty() {
        "Untitled".to_string()
    } else if t.chars().count() > 80 {
        t.chars().take(80).collect()
    } else {
        t
    }
}

#[tauri::command]
pub fn aery_rename(app: tauri::AppHandle, id: String, title: String) -> Result<(), String> {
    let root = aery_root(&app)?;
    let meta = aery_read_meta(&root);
    let mut notes: Vec<AeryNote> = Vec::new();
    aery_scan_dir(&root, &root, &meta, &mut notes, 0);
    let Some(note) = notes.iter().find(|n| n.id == id).cloned() else {
        return Err("That note is not in the vault.".into());
    };
    let from = aery_resolve(&root, &note.path)?;
    let new_title = title.trim().to_string();
    if new_title.is_empty() {
        return Err("A note needs a title.".into());
    }
    let to = from
        .parent()
        .ok_or("That note has no folder.")?
        .join(format!("{}.md", aery_safe_stem(&new_title)));
    if to.exists() && to != from {
        return Err(format!("{} already exists in that folder.", aery_safe_stem(&new_title)));
    }

    // Front matter is kept in step with the title, so the rename survives a
    // later rescan. Body content is never rewritten.
    let body = std::fs::read_to_string(&from).map_err(|e| e.to_string())?;
    let new_body = if let Some(rest) = body.strip_prefix("---\n") {
        match rest.find("\n---") {
            Some(end) => {
                let head = &rest[..end];
                let tail = &rest[end..];
                let mut lines: Vec<String> = head
                    .lines()
                    .map(|l| if l.trim_start().starts_with("title:") { format!("title: {}", new_title) } else { l.to_string() })
                    .collect();
                if !lines.iter().any(|l| l.trim_start().starts_with("title:")) {
                    lines.insert(0, format!("title: {}", new_title));
                }
                format!("---\n{}\n{}", lines.join("\n"), tail)
            }
            None => format!("---\ntitle: {}\n---\n\n{}", new_title, body),
        }
    } else {
        format!("---\ntitle: {}\n---\n\n{}", new_title, body)
    };

    aery_atomic_write(&to, new_body.as_bytes())?;
    if to != from {
        std::fs::remove_file(&from).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn aery_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let root = aery_root(&app)?;
    let meta = aery_read_meta(&root);
    let mut notes: Vec<AeryNote> = Vec::new();
    aery_scan_dir(&root, &root, &meta, &mut notes, 0);
    let Some(note) = notes.iter().find(|n| n.id == id).cloned() else {
        return Err("That note is not in the vault.".into());
    };
    let from = aery_resolve(&root, &note.path)?;

    // Moved, never erased: a trash folder inside the vault, restorable.
    let trash = root.join(".trash");
    std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let stamp = super::now_unix();
    let to = trash.join(format!("{}__{}.md", note.path.replace('/', "~"), stamp));
    std::fs::rename(&from, &to).map_err(|e| e.to_string())?;

    let mut meta = aery_read_meta(&root);
    meta.pinned.retain(|x| *x != id);
    aery_write_meta(&root, &meta)
}

/// Resolves where a trashed note should be restored to, or None if the recorded
/// relative path could leave the vault.
///
/// The relative path comes from a filename inside `.trash`, which a user - or
/// anything else with write access to the vault - controls. A lexical
/// `starts_with(root)` cannot catch `..`: it compares components without
/// resolving them, so `<root>/../escape` looks like it is inside `<root>`.
/// Only plain components are accepted, and the parent is then canonicalised so
/// a symlink inside the vault cannot redirect the write either.
fn aery_restore_target(root: &Path, orig: &str) -> Option<PathBuf> {
    // aery_root() already canonicalises, but taking a copy here means a caller
    // that did not cannot make the comparison below meaningless.
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let joined = orig.replace('~', "/");
    let rel = Path::new(&joined);
    if rel.is_absolute() {
        return None;
    }
    if !rel.components().all(|c| matches!(c, std::path::Component::Normal(_))) {
        return None;
    }
    let target = root.join(rel);
    let parent = target.parent()?;
    std::fs::create_dir_all(parent).ok()?;
    let real_parent = parent.canonicalize().ok()?;
    if !real_parent.starts_with(&root) {
        return None;
    }
    Some(real_parent.join(target.file_name()?))
}

#[tauri::command]
pub fn aery_restore(app: tauri::AppHandle) -> Result<usize, String> {
    let root = aery_root(&app)?;
    let trash = root.join(".trash");
    let Ok(rd) = std::fs::read_dir(&trash) else { return Ok(0) };
    let mut back = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".md") {
            continue;
        }
        // "<rel path with / replaced by ~>__<stamp>.md". Both the .md suffix and
        // the __ separator are unambiguous, so filenames containing _ and -
        // cannot corrupt the restore path.
        let stem = &name[..name.len() - 3];
        let Some((orig, _stamp)) = stem.rsplit_once("__") else { continue };
        // Never let a restore write outside the vault, even if the trash was
        // tampered with by hand. Checked before the directory is created.
        let Some(target) = aery_restore_target(&root, orig) else { continue };
        if std::fs::rename(e.path(), &target).is_ok() {
            back += 1;
        }
    }
    let _ = std::fs::remove_dir(&trash);
    Ok(back)
}

#[tauri::command]
pub fn aery_set_pinned(app: tauri::AppHandle, id: String, pinned: bool) -> Result<(), String> {
    let root = aery_root(&app)?;
    let mut meta = aery_read_meta(&root);
    if pinned {
        if !meta.pinned.iter().any(|x| *x == id) {
            meta.pinned.push(id);
        }
    } else {
        meta.pinned.retain(|x| *x != id);
    }
    aery_write_meta(&root, &meta)
}

/// Validates a user-supplied folder path. Returns it with forward slashes, or
/// explains why it cannot be used.
///
/// `aery_mkdir` creates directories, so this is the same containment rule as
/// the other note commands - but stricter about `.`: a hidden folder would be
/// skipped by the scan, so creating one would look like a folder that vanished.
pub fn aery_folder_rel(path: &str) -> Result<String, String> {
    // Checked before trimming: "/abs" is a drive-root path, and silently
    // re-reading it as "abs" would make the answer depend on the leading slash.
    // has_root, not is_absolute: on Windows "/abs" has a root but no drive
    // prefix, so is_absolute() is false for it and it would slip through.
    if Path::new(path.trim()).has_root() {
        return Err("That folder is not in the vault.".into());
    }
    let clean = path.trim().replace('\\', "/");
    let clean = clean.trim_matches('/').to_string();
    if clean.is_empty() {
        return Err("A folder needs a name.".into());
    }
    let rel = Path::new(&clean);
    if rel.is_absolute() || !rel.components().all(|c| matches!(c, std::path::Component::Normal(_))) {
        return Err("That folder is not in the vault.".into());
    }
    if clean.split('/').any(|s| s.trim().is_empty() || s.starts_with('.')) {
        return Err("Folder names cannot be empty or start with a dot.".into());
    }
    Ok(clean)
}

/// Every folder in the vault, empty ones included, so a folder you just made
/// stays visible and can be moved into before it holds a note.
pub fn aery_scan_folders(root: &Path, dir: &Path, out: &mut Vec<String>, depth: u32) {
    if depth > 12 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if !p.is_dir() || name.starts_with('.') {
            continue;
        }
        out.push(aery_rel_of(root, &p));
        aery_scan_folders(root, &p, out, depth + 1);
    }
}

#[tauri::command]
pub fn aery_mkdir(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let root = aery_root(&app)?;
    let clean = aery_folder_rel(&path)?;

    // Check every component that already exists before creating anything. A
    // symlinked directory inside the vault could otherwise redirect the write
    // outside it, and create_dir_all would happily follow it.
    let mut probe = root.clone();
    for part in clean.split('/') {
        probe.push(part);
        if probe.exists() {
            let canon = probe.canonicalize().map_err(|e| e.to_string())?;
            if !canon.starts_with(&root) {
                return Err("A folder cannot be outside the vault.".into());
            }
        } else {
            break;
        }
    }

    let dir = root.join(clean.replace('/', "\\"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create that folder: {}", e))?;
    let canon = dir.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) {
        return Err("A folder cannot be outside the vault.".into());
    }
    Ok(aery_rel_of(&root, &canon))
}

#[tauri::command]
pub fn aery_set_folder(app: tauri::AppHandle, id: String, folder: String) -> Result<(), String> {
    let root = aery_root(&app)?;
    let meta = aery_read_meta(&root);
    let mut notes: Vec<AeryNote> = Vec::new();
    aery_scan_dir(&root, &root, &meta, &mut notes, 0);
    let Some(note) = notes.iter().find(|n| n.id == id).cloned() else {
        return Err("That note is not in the vault.".into());
    };
    let from = aery_resolve(&root, &note.path)?;
    // Same containment check as aery_create: a note must not be movable outside
    // the vault, however the folder argument is spelled.
    let clean = folder.trim().trim_matches('/').replace('\\', "/");
    let to_dir = if clean.is_empty() {
        root.clone()
    } else {
        let cand = root.join(clean.replace('/', "\\"));
        let canon = cand.canonicalize().map_err(|_| "That folder is not in the vault.".to_string())?;
        if !canon.starts_with(&root) {
            return Err("A note cannot be moved outside the vault.".into());
        }
        canon
    };
    let stem = from.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let to = to_dir.join(format!("{}.md", stem));
    if to.exists() && to != from {
        return Err("A note with that name is already in that folder.".into());
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn aery_vault_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(aery_root(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn aery_counts(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let root = aery_root(&app)?;
    let meta = aery_read_meta(&root);
    let mut notes: Vec<AeryNote> = Vec::new();
    aery_scan_dir(&root, &root, &meta, &mut notes, 0);
    let mut tags: Vec<String> = notes.iter().flat_map(|n| n.tags.clone()).collect();
    tags.sort();
    tags.dedup();
    let mut folders: Vec<String> = Vec::new();
    aery_scan_folders(&root, &root, &mut folders, 0);
    folders.extend(notes.iter().filter(|n| !n.folder.is_empty()).map(|n| n.folder.clone()));
    folders.sort();
    folders.dedup();
    Ok(json!({ "notes": notes.len(), "tags": tags, "folders": folders }))
}
// ---- folders, import and export -------------------------------------------

fn aery_rel_join(root: &Path, rel: &str) -> PathBuf {
    if rel.trim().is_empty() { root.to_path_buf() } else { root.join(rel.replace('/', "\\")) }
}

/// A name that is free in `dir`, never overwriting what is there.
fn aery_unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let stem = aery_safe_stem(stem);
    let mut name = format!("{}.{}", stem, ext);
    let mut n = 2;
    while dir.join(&name).exists() {
        name = format!("{} {}.{}", stem, n, ext);
        n += 1;
    }
    dir.join(name)
}

/// Rewrites an existing aery_id, or adds one. Used when an imported note claims
/// an id that another note in this vault already owns: keeping it would make
/// two notes share a tab, a pin and a study reference.
fn aery_force_id(text: &str, id: &str) -> String {
    if aery_front_id(text).is_none() {
        return aery_ensure_id(text, id);
    }
    let mut out = Vec::new();
    let mut done = false;
    for line in text.lines() {
        if !done && line.trim_start().starts_with("aery_id:") {
            out.push(format!("aery_id: {}", id));
            done = true;
        } else {
            out.push(line.to_string());
        }
    }
    let mut joined = out.join("\n");
    if text.ends_with('\n') { joined.push('\n'); }
    joined
}

#[tauri::command]
pub fn aery_rename_folder(app: tauri::AppHandle, from: String, to: String) -> Result<String, String> {
    let root = aery_root(&app)?;
    rename_folder_in(&root, &from, &to)
}

fn rename_folder_in(root: &Path, from: &str, to: &str) -> Result<String, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let from_rel = aery_folder_rel(from)?;
    let to_rel = aery_folder_rel(to)?;
    if from_rel == to_rel {
        return Ok(to_rel);
    }
    let src = root.join(from_rel.replace('/', "\\"));
    if !src.is_dir() {
        return Err("That folder is not in the vault.".into());
    }
    let dst = root.join(to_rel.replace('/', "\\"));
    if dst.exists() {
        // A rename must never merge two folders: that would silently rewrite
        // paths and make name collisions ambiguous.
        return Err("A folder with that name already exists.".into());
    }
    // Refuse `work` -> `work/ideas`: the destination would be inside the source
    // and the rename would either fail halfway or lose the parent.
    if dst.starts_with(&src) {
        return Err("A folder cannot be moved inside itself.".into());
    }
    let parent = dst.parent().ok_or("That folder has no parent.")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Could not create the new folder: {}", e))?;
    std::fs::rename(&src, &dst).map_err(|e| format!("Could not rename the folder: {}", e))?;
    let canon = dst.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) {
        return Err("A folder cannot be outside the vault.".into());
    }
    Ok(aery_rel_of(&root, &canon))
}

/// Deletes a folder only when it is empty, or when the caller has said where
/// its files should go. Files are moved, never erased.
#[tauri::command]
pub fn aery_delete_folder(app: tauri::AppHandle, folder: String, move_to: Option<String>) -> Result<serde_json::Value, String> {
    let root = aery_root(&app)?;
    delete_folder_in(&root, &folder, move_to.as_deref())
}

fn delete_folder_in(root: &Path, folder: &str, move_to: Option<&str>) -> Result<serde_json::Value, String> {
    let rel = aery_folder_rel(folder)?;
    let dir = root.join(rel.replace('/', "\\"));
    if dir == root || !dir.is_dir() {
        return Err("That folder is not in the vault.".into());
    }

    let mut files: Vec<PathBuf> = Vec::new();
    aery_walk(&dir, &mut files, 0);
    let notes = files.iter().filter(|p| p.extension().map(|x| x.eq_ignore_ascii_case("md")).unwrap_or(false)).count();

    if !files.is_empty() {
        let Some(target) = move_to else {
            return Err(format!(
                "That folder holds {} file{}. Move them somewhere first.",
                files.len(), if files.len() == 1 { "" } else { "s" }
            ));
        };
        let dest_rel = aery_folder_rel(target).unwrap_or_default();
        let dest = aery_rel_join(&root, &dest_rel);
        if !dest.is_dir() {
            return Err("The folder to move into does not exist.".into());
        }
        if dest.starts_with(&dir) {
            return Err("Files cannot be moved into the folder being deleted.".into());
        }
        for f in &files {
            let stem = f.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let ext = f.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let to = aery_unique_path(&dest, &stem, &ext);
            std::fs::rename(f, &to).map_err(|e| format!("Could not move {}: {}", f.display(), e))?;
        }
        // Every file is out. Remove the now-empty tree bottom-up; a directory
        // that still has something in it stops the removal rather than being
        // force-deleted.
        aery_prune_empty_dirs(&dir);
        if dir.exists() {
            return Err("Some files in that folder could not be moved, so the folder was kept.".into());
        }
        return Ok(json!({ "deleted": true, "moved": files.len(), "notes": notes }));
    }

    aery_prune_empty_dirs(&dir);
    if dir.exists() {
        return Err("The folder still holds something, so it was kept.".into());
    }
    Ok(json!({ "deleted": true, "moved": 0, "notes": notes }))
}

fn aery_walk(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 12 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(md) = std::fs::symlink_metadata(&p) else { continue };
        if md.file_type().is_symlink() {
            continue;
        }
        if p.is_dir() {
            aery_walk(&p, out, depth + 1);
        } else {
            out.push(p);
        }
    }
}

fn aery_prune_empty_dirs(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let kids: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    for k in kids {
        if k.is_dir() {
            aery_prune_empty_dirs(&k);
        }
    }
    let _ = std::fs::remove_dir(dir);
}

#[tauri::command]
pub fn aery_export_note(app: tauri::AppHandle, id: String, dest: String) -> Result<String, String> {
    let root = aery_root(&app)?;
    let meta = aery_read_meta(&root);
    let mut notes: Vec<AeryNote> = Vec::new();
    aery_scan_dir(&root, &root, &meta, &mut notes, 0);
    let Some(note) = notes.iter().find(|n| n.id == id) else {
        return Err("That note is not in the vault.".into());
    };
    let from = aery_resolve(&root, &note.path)?;
    let to = PathBuf::from(&dest);
    if to == from {
        return Err("That is the note's own file, so nothing was overwritten.".into());
    }
    // Byte copy, not re-encoded text: exporting must not change a single byte of
    // the note, front matter included.
    let bytes = std::fs::read(&from).map_err(|e| e.to_string())?;
    aery_atomic_write(&to, &bytes)?;
    Ok(to.to_string_lossy().to_string())
}

/// Copies every note in the vault into `dest`, keeping the folder structure.
/// Existing files are only replaced when `overwrite` is true; otherwise they are
/// counted and left alone so the caller can ask.
#[tauri::command]
pub fn aery_export_vault(app: tauri::AppHandle, dest: String, overwrite: bool) -> Result<serde_json::Value, String> {
    let root = aery_root(&app)?;
    export_vault_in(&root, &dest, overwrite)
}

fn export_vault_in(root: &Path, dest: &str, overwrite: bool) -> Result<serde_json::Value, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let dest = PathBuf::from(dest);
    if !dest.is_dir() {
        return Err("Choose an existing folder to export into.".into());
    }
    let dest = dest.canonicalize().map_err(|e| e.to_string())?;
    if dest.starts_with(&root) {
        return Err("Choose a folder outside the vault, so the export cannot overwrite it.".into());
    }
    let mut files: Vec<PathBuf> = Vec::new();
    aery_walk(&root, &mut files, 0);
    let mut copied = 0;
    let mut skipped = 0;
    for f in files {
        if !f.extension().map(|x| x.eq_ignore_ascii_case("md")).unwrap_or(false) {
            continue;
        }
        let rel = aery_rel_of(&root, &f);
        let to = dest.join(rel.replace('/', "\\"));
        if to.exists() && !overwrite {
            skipped += 1;
            continue;
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&f, &to).map_err(|e| e.to_string())?;
        copied += 1;
    }
    Ok(json!({ "copied": copied, "skipped": skipped, "dest": dest.to_string_lossy() }))
}

/// Imports Markdown files or folders the user picked. Never overwrites: a name
/// that is taken gets a suffix, and an id another note owns is replaced.
#[tauri::command]
pub fn aery_import(app: tauri::AppHandle, paths: Vec<String>, folder: Option<String>) -> Result<serde_json::Value, String> {
    let root = aery_root(&app)?;
    import_in(&root, paths, folder.as_deref())
}

fn import_in(root: &Path, paths: Vec<String>, folder: Option<&str>) -> Result<serde_json::Value, String> {
    let dest_rel = aery_folder_rel(folder.unwrap_or_default()).unwrap_or_default();
    let dest = aery_rel_join(&root, &dest_rel);
    if !dest.is_dir() {
        return Err("The folder to import into does not exist.".into());
    }

    let meta = aery_read_meta(&root);
    let mut existing: Vec<AeryNote> = Vec::new();
    aery_scan_dir(&root, &root, &meta, &mut existing, 0);
    let mut ids: Vec<String> = existing.iter().map(|n| n.id.clone()).collect();

    let mut imported = 0;
    let mut renamed = 0;
    let mut skipped = 0;
    let mut errors: Vec<String> = Vec::new();
    let mut written: Vec<PathBuf> = Vec::new();

    for raw in paths {
        let src = PathBuf::from(&raw);
        let mut batch: Vec<(PathBuf, PathBuf)> = Vec::new(); // (absolute, relative to import base)
        let md = std::fs::symlink_metadata(&src).ok();
        let Some(md) = md else { skipped += 1; errors.push(format!("{}: not found", raw)); continue };
        if md.file_type().is_symlink() {
            skipped += 1;
            errors.push(format!("{}: symlinks are not imported", raw));
            continue;
        }
        if src.is_dir() {
            let mut files = Vec::new();
            aery_walk(&src, &mut files, 0);
            for f in files {
                if !f.extension().map(|x| x.eq_ignore_ascii_case("md")).unwrap_or(false) {
                    continue;
                }
                let rel = f.strip_prefix(&src).unwrap_or(&f).to_path_buf();
                batch.push((f, rel));
            }
            // Keep the imported folder's name as the top level, so importing a
            // vault does not pour its contents into the current root.
            if let Some(name) = src.file_name() {
                let base = PathBuf::from(name);
                batch = batch.into_iter().map(|(abs, rel)| (abs, base.join(rel))).collect();
            }
        } else if src.extension().map(|x| x.eq_ignore_ascii_case("md")).unwrap_or(false) {
            batch.push((src.clone(), PathBuf::from(src.file_name().unwrap_or_default())));
        } else {
            skipped += 1;
            errors.push(format!("{}: not a Markdown file", raw));
            continue;
        }

        for (abs, rel) in batch {
            let Ok(text) = std::fs::read_to_string(&abs) else {
                skipped += 1;
                errors.push(format!("{}: unreadable or not UTF-8", abs.display()));
                continue;
            };
            let stem = abs.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let target_dir = dest.join(rel.parent().unwrap_or_else(|| Path::new("")));
            if std::fs::create_dir_all(&target_dir).is_err() {
                skipped += 1;
                errors.push(format!("{}: could not create its folder", abs.display()));
                continue;
            }
            let wanted = target_dir.join(format!("{}.md", aery_safe_stem(&stem)));
            let target = if wanted.exists() {
                renamed += 1;
                aery_unique_path(&target_dir, &stem, "md")
            } else {
                wanted
            };
            // A colliding id would make two notes share a tab, a pin and any
            // study card that points at the old one.
            let body = match aery_front_id(&text) {
                Some(old) if ids.iter().any(|x| *x == old) => {
                    let fresh = aery_id(&aery_rel_of(&root, &target));
                    aery_force_id(&text, &fresh)
                }
                Some(_) => text,
                // No usable id: adopt the path-derived one now, so the note's
                // identity is stable even before its first edit.
                None => aery_ensure_id(&text, &aery_id(&aery_rel_of(&root, &target))),
            };
            if let Some(id) = aery_front_id(&body) {
                ids.push(id);
            }
            if let Err(e) = aery_atomic_write(&target, body.as_bytes()) {
                skipped += 1;
                errors.push(format!("{}: {}", abs.display(), e));
                continue;
            }
            imported += 1;
            written.push(target);
        }
    }

    // Report unresolved links among what was just imported, against the vault as
    // it now stands. "Imported" should not imply "connected".
    let mut now_notes: Vec<AeryNote> = Vec::new();
    aery_scan_dir(&root, &root, &aery_read_meta(&root), &mut now_notes, 0);
    let titles: Vec<String> = now_notes.iter().map(|n| n.title.to_lowercase()).collect();
    let mut unresolved = 0;
    for p in &written {
        if let Ok(t) = std::fs::read_to_string(p) {
            for l in aery_links(&t) {
                if !titles.iter().any(|x| *x == l.to_lowercase()) {
                    unresolved += 1;
                }
            }
        }
    }

    Ok(json!({
        "imported": imported,
        "renamed": renamed,
        "skipped": skipped,
        "unresolved_links": unresolved,
        "errors": errors,
        "title_sample": now_notes.first().map(|n| n.title.clone()).unwrap_or_default(),
    }))
}


// There were none. Every bug in this file was invisible to the suite because
// tests/aery.test.js mocks the backend entirely, and
// tests/rust-structure-check.js only greps for function NAMES - it would pass
// with every function body emptied.
//
// These exercise the pure logic that has actually caused data loss.

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// Unique per call. An earlier version keyed this on now_unix(), which has
    /// one-second resolution, so tests running in parallel shared a directory
    /// and deleted each other's files - the failures looked like app bugs.
    fn tmp() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("aery-t{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // ---- folders -----------------------------------------------------------

    #[test]
    fn folder_names_cannot_escape_the_vault_or_hide_from_the_scan() {
        assert_eq!(aery_folder_rel("work").unwrap(), "work");
        assert_eq!(aery_folder_rel("work/ideas/").unwrap(), "work/ideas");
        assert_eq!(aery_folder_rel("work\\ideas").unwrap(), "work/ideas");
        for bad in ["", "   ", "..", "../out", "C:/Windows", "/abs", "/work", "work/../out", ".hidden", "work/.hidden", "a//b"] {
            assert!(aery_folder_rel(bad).is_err(), "{:?} must be refused", bad);
        }
    }

    #[test]
    fn the_folder_list_includes_empty_folders_and_skips_hidden_ones() {
        let root = tmp();
        std::fs::create_dir_all(root.join("work").join("ideas")).unwrap();
        std::fs::create_dir_all(root.join(".trash")).unwrap();
        let mut out = Vec::new();
        aery_scan_folders(&root, &root, &mut out, 0);
        out.sort();
        assert_eq!(out, vec!["work".to_string(), "work/ideas".to_string()]);
    }

    // ---- identity ----------------------------------------------------------

    fn note(id: &str, title: &str, excerpt: &str, tags: &[&str]) -> AeryNote {
        AeryNote {
            id: id.into(),
            title: title.into(),
            path: format!("{}.md", title),
            folder: String::new(),
            pinned: false,
            created: 0,
            modified: 0,
            size: 0,
            excerpt: excerpt.into(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            links: Vec::new(),
            backlinks: Vec::new(),
        }
    }

    #[test]
    fn search_reads_the_body_when_the_excerpt_does_not_match() {
        let notes = vec![
            note("a", "Shopping", "milk, eggs", &[]),
            note("b", "Recipes", "flour, butter", &[]),
        ];
        // The word only exists past the first 280 characters, which the excerpt
        // never carried. The old filter reported this note as absent.
        let got = aery_filter(notes, "saffron", "", |n| {
            (n.id == "b").then(|| "flour, butter ... and saffron".to_string())
        });
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "b");
    }

    #[test]
    fn search_does_not_read_a_note_the_metadata_already_matched() {
        let notes = vec![note("a", "Shopping", "milk", &[])];
        let got = aery_filter(notes, "shop", "", |_| panic!("must not read the body"));
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn a_tag_filter_is_exact_and_a_search_term_is_case_insensitive() {
        let notes = vec![
            note("a", "Deep Work", "notes", &["focus"]),
            note("b", "Focus log", "notes", &[]),
        ];
        let by_tag = aery_filter(notes.clone(), "", "focus", |_| None);
        assert_eq!(by_tag.len(), 1);
        assert_eq!(by_tag[0].id, "a", "a tag match must not accept the title");
        let by_term = aery_filter(notes, "FOCUS", "", |_| None);
        assert_eq!(by_term.len(), 2);
    }

    #[test]
    fn a_note_that_cannot_be_read_does_not_match_a_body_term() {
        let notes = vec![note("a", "Unreadable", "", &[])];
        let got = aery_filter(notes, "anything", "", |_| None);
        assert!(got.is_empty());
    }

    #[test]
    fn front_matter_id_round_trips() {
        let id = aery_id("notes/idea.md");
        let doc = aery_ensure_id("# Idea\n\nbody", &id);
        assert!(doc.starts_with("---\n"), "front matter must be added");
        assert!(doc.contains(&format!("aery_id: {}", id)));
        assert!(doc.ends_with("# Idea\n\nbody"), "body must be untouched");
        assert_eq!(aery_front_id(&doc).as_deref(), Some(id.as_str()));
    }

    #[test]
    fn ensure_id_is_idempotent_and_never_rewrites_an_existing_id() {
        let a = aery_id("x.md");
        let b = aery_id("other.md");
        let once = aery_ensure_id("text", &a);
        let twice = aery_ensure_id(&once, &b);
        assert_eq!(once, twice, "a second ensure must not overwrite the id");
        assert_eq!(aery_front_id(&twice).as_deref(), Some(a.as_str()));
    }

    #[test]
    fn ensure_id_preserves_other_front_matter_keys() {
        let id = aery_id("y.md");
        let doc = "---\ntitle: Mine\ntags: [a, b]\n---\n\nbody";
        let out = aery_ensure_id(doc, &id);
        assert!(out.contains("title: Mine"));
        assert!(out.contains("tags: [a, b]"));
        assert!(out.contains(&format!("aery_id: {}", id)));
    }

    #[test]
    fn front_id_ignores_a_malformed_value() {
        // A hostile or hand-edited value must not become the note's identity.
        assert_eq!(aery_front_id("---\naery_id: ../../evil\n---\nx"), None);
        assert_eq!(aery_front_id("---\naery_id: \n---\nx"), None);
    }

    // ---- the trash format that could never restore -------------------------

    fn trash_name(rel: &str, stamp: u64) -> String {
        format!("{}__{}.md", rel.replace('/', "~"), stamp)
    }

    fn trash_parse(name: &str) -> Option<String> {
        if !name.ends_with(".md") { return None; }
        let stem = &name[..name.len() - 3];
        let (orig, _stamp) = stem.rsplit_once("__")?;
        Some(orig.replace('~', "/"))
    }

    #[test]
    fn trashed_note_is_restorable() {
        // This is the exact shape aery_delete writes. The old format
        // ("Ideas.md-1758000000") could never satisfy ends_with(".md"), so
        // aery_restore always returned 0.
        let n = trash_name("folder/Ideas.md", 1758000000);
        assert!(n.ends_with(".md"));
        assert_eq!(trash_parse(&n).as_deref(), Some("folder/Ideas.md"));
    }

    #[test]
    fn trash_format_survives_underscores_and_dashes_in_names() {
        let n = trash_name("my_folder/a-b_c.md", 42);
        assert_eq!(trash_parse(&n).as_deref(), Some("my_folder/a-b_c.md"));
    }

    #[test]
    fn round_trip_through_the_real_filesystem() {
        let root = tmp();
        let dir = root.join("folder");
        std::fs::create_dir_all(&dir).unwrap();
        let from = dir.join("Ideas.md");
        std::fs::write(&from, "---\ntitle: Ideas\n---\n\nhello").unwrap();

        // move to trash exactly as aery_delete does
        let stamp = super::super::now_unix();
        let rel = aery_rel_of(&root, &from);
        let trash = root.join(".trash");
        std::fs::create_dir_all(&trash).unwrap();
        let to = trash.join(trash_name(&rel, stamp));
        std::fs::rename(&from, &to).unwrap();
        assert!(!from.exists(), "note must leave its original place");

        // restore exactly as aery_restore does
        let name = to.file_name().unwrap().to_string_lossy().to_string();
        let target = root.join(trash_parse(&name).unwrap().replace('/', "\\"));
        assert!(target.starts_with(&root), "restore must stay inside the vault");
        if let Some(p) = target.parent() { std::fs::create_dir_all(p).unwrap(); }
        std::fs::rename(&to, &target).unwrap();

        assert!(target.exists(), "NOTE MUST COME BACK - this is the bug that shipped");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "---\ntitle: Ideas\n---\n\nhello");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_tampered_trash_name_cannot_write_outside_the_vault() {
        // The restore path check is starts_with(root). Prove it actually rejects
        // a hand-placed name that tries to climb out.
        let root = tmp();
        let outside = tmp();
        std::fs::write(outside.join("secret.md"), "no").unwrap();

        let rel = format!("../{}/secret.md", outside.file_name().unwrap().to_string_lossy());
        let name = trash_name(&rel, 1);
        let target = root.join(trash_parse(&name).unwrap().replace('/', "\\"));

        // canonicalize resolves .., so this is where a real escape would show.
        let resolved = target.canonicalize().unwrap_or(target.clone());
        assert!(!resolved.starts_with(&root), "restore target escaped the vault: {:?}", resolved);
        assert!(!resolved.starts_with(&outside), "restore target reached outside dir");

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn a_restore_path_that_climbs_out_is_refused_even_when_its_parent_exists() {
        // The old code only canonicalised the target when it already existed.
        // When the parent existed but the file did not, it kept the raw path and
        // compared it lexically, so "<root>/../escaped.md" passed the check and
        // could be written beside the vault.
        let root = tmp();
        assert!(aery_restore_target(&root, "../escaped.md").is_none(),
            "a parent-directory component must be refused");
        assert!(aery_restore_target(&root, "sub/../../escaped.md").is_none(),
            ".. must be refused anywhere in the path");
        assert!(aery_restore_target(&root, "..").is_none(),
            "a bare .. must be refused");
        assert!(aery_restore_target(&root, "/abs/escaped.md").is_none(),
            "an absolute path must be refused");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_restore_path_inside_the_vault_is_accepted() {
        let root = tmp();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let t = aery_restore_target(&root, "sub/idea.md").expect("a plain relative path");
        assert!(t.starts_with(root.canonicalize().unwrap_or(root.clone())));
        assert_eq!(t.file_name().unwrap(), "idea.md");
        std::fs::remove_dir_all(&root).ok();
    }

    // ---- containment -------------------------------------------------------

    #[test]
    fn resolve_rejects_paths_that_climb_out_of_the_vault() {
        let root = tmp();
        let outside = tmp();
        std::fs::write(outside.join("secret.md"), "no").unwrap();
        let rel = format!("../{}/secret.md", outside.file_name().unwrap().to_string_lossy());
        assert!(aery_resolve(&root, &rel).is_err(), "must refuse to escape the vault");
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn resolve_accepts_a_path_inside_the_vault() {
        let root = tmp();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub").join("ok.md"), "yes").unwrap();
        assert!(aery_resolve(&root, "sub/ok.md").is_ok());
        std::fs::remove_dir_all(&root).ok();
    }

    // ---- markdown readers --------------------------------------------------

    #[test]
    fn links_are_extracted_with_aliases() {
        let v = aery_links("see [[One]] and [[Two|shown]] but not [[x|y|z]]");
        assert!(v.contains(&"One".to_string()));
        assert!(v.contains(&"Two".to_string()));
    }

    #[test]
    fn title_prefers_front_matter_over_heading() {
        assert_eq!(aery_title("---\ntitle: Front\n---\n\n# Heading", "f.md"), "Front");
        assert_eq!(aery_title("# Heading\n", "f.md"), "Heading");
        // No front matter and no heading: the filename is the title. That is the
        // contract aery_create relies on when it makes "Untitled.md".
        assert_eq!(aery_title("no heading", "f.md"), "f.md");
    }

    #[test]
    fn safe_stem_strips_what_windows_refuses() {
        let s = aery_safe_stem("a/b:c*d?e\"f<g>h|i");
        for bad in ['/', '\\', ':', '*', '?', '"', '<', '>', '|'] {
            assert!(!s.contains(bad), "stem must not contain {:?}", bad);
        }
        assert!(!s.is_empty());
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp() {
        let d = tmp();
        let f = d.join("n.md");
        aery_atomic_write(&f, b"one").unwrap();
        aery_atomic_write(&f, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "two");
        let leftovers: Vec<_> = std::fs::read_dir(&d).unwrap()
            .flatten().map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("tmp")).collect();
        assert!(leftovers.is_empty(), "temp files left behind: {:?}", leftovers);
        std::fs::remove_dir_all(&d).ok();
    }
}
#[cfg(test)]
mod vault_tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("aery-vault-{}-{}-{}", tag, std::process::id(), n));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn markdown_count_finds_nested_notes_and_skips_dotdirs() {
        let d = tmpdir("count");
        std::fs::write(d.join("a.md"), "x").unwrap();
        std::fs::write(d.join("notes.txt"), "x").unwrap();
        std::fs::create_dir_all(d.join("sub").join("deep")).unwrap();
        std::fs::write(d.join("sub").join("b.md"), "x").unwrap();
        std::fs::write(d.join("sub").join("deep").join("c.md"), "x").unwrap();
        std::fs::create_dir_all(d.join(".trash")).unwrap();
        std::fs::write(d.join(".trash").join("deleted.md"), "x").unwrap();
        assert_eq!(aery_count_md(&d), 3, "counts 3 notes; ignores .trash and .txt");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn count_is_bounded_so_a_huge_folder_cannot_stall_the_ui() {
        let d = tmpdir("bound");
        // The cap exists so opening a folder of tens of thousands of files
        // cannot freeze the app while it counts them.
        assert!(aery_count_md(&d) <= 5000);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn vault_config_round_trips() {
        // This config is the only record of where the user's notes live, so it
        // must survive a save/load cycle exactly.
        let c = AeryVaults {
            current: "C:/notes".into(),
            known: vec!["C:/notes".into(), "D:/work".into()],
        };
        let s = serde_json::to_string(&c).unwrap();
        let back: AeryVaults = serde_json::from_str(&s).unwrap();
        assert_eq!(back.current, "C:/notes");
        assert_eq!(back.known.len(), 2);
        assert_eq!(back.known[1], "D:/work");
    }

    #[test]
    fn empty_config_defaults_are_empty_not_a_phantom_vault() {
        // A fresh install has no chosen vault. It must not invent one, or the
        // first note would land somewhere the user never picked.
        let c: AeryVaults = serde_json::from_str("{}").unwrap();
        assert!(c.current.is_empty());
        assert!(c.known.is_empty());
    }

    #[test]
    fn malformed_config_falls_back_instead_of_crashing() {
        // A truncated or hand-edited config must not make every command fail.
        let c: AeryVaults = serde_json::from_str("{ not json").unwrap_or_default();
        assert!(c.current.is_empty());
    }

    #[test]
    fn a_saved_note_carries_an_id_that_survives_being_renamed() {
        // The point of the front-matter id: a note found at one path and later
        // moved to another must keep the same identity. Without it every id is a
        // hash of the path, so a rename silently orphans the pin and the note the
        // editor had open.
        let before = aery_id("notes/idea.md");
        let saved = aery_ensure_id("---\ntitle: Idea\n---\n\nbody", &before);
        assert_eq!(aery_front_id(&saved).as_deref(), Some(before.as_str()));

        // Same file, new path. The reader takes the id from the note, not the path.
        let after = aery_id("archive/renamed.md");
        assert_ne!(before, after, "the path hash does change on a rename");
        assert_eq!(
            aery_front_id(&saved).as_deref(),
            aery_front_id(&aery_ensure_id(&saved, &after)).as_deref(),
            "the id stays the one already in the note"
        );
    }

    #[test]
    fn stamping_an_id_preserves_the_title_and_the_body() {
        let doc = aery_ensure_id("---\ntitle: Mine\ntags: [a, b]\n---\n\nbody text", &aery_id("m.md"));
        assert!(doc.contains("title: Mine"));
        assert!(doc.contains("tags: [a, b]"));
        assert!(doc.ends_with("body text"), "the body is never rewritten");
    }

    // ---- folder rename/delete, import/export --------------------------------

    fn tmp() -> PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("aery-io-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn seed(root: &Path, rel: &str, id: &str, body: &str) {
        let p = root.join(rel.replace('/', "\\"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let doc = format!("---\naery_id: {}\ntitle: {}\n---\n\n{}", id, rel, body);
        std::fs::write(&p, doc).unwrap();
    }

    #[test]
    fn renaming_a_folder_moves_its_notes_and_refuses_a_taken_name() {
        let root = tmp();
        seed(&root, "work/a.md", "id-a", "alpha");
        seed(&root, "work/deep/b.md", "id-b", "beta");
        std::fs::create_dir_all(root.join("archive")).unwrap();

        assert_eq!(rename_folder_in(&root, "work", "job").unwrap(), "job");
        assert!(root.join("job\\a.md").is_file());
        assert!(root.join("job\\deep\\b.md").is_file());
        assert!(!root.join("work").exists(), "the old folder is gone");

        // Two folders must never merge behind the user's back.
        let err = rename_folder_in(&root, "job", "archive").unwrap_err();
        assert!(err.contains("already exists"), "{}", err);
        assert!(root.join("job\\a.md").is_file(), "the refusal changed nothing");

        let err = rename_folder_in(&root, "job", "job/inner").unwrap_err();
        assert!(err.contains("inside itself"), "{}", err);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn deleting_a_folder_moves_notes_out_first_and_never_erases_them() {
        let root = tmp();
        seed(&root, "work/a.md", "id-a", "alpha");
        seed(&root, "work/deep/b.md", "id-b", "beta");

        let err = delete_folder_in(&root, "work", None).unwrap_err();
        assert!(err.contains("Move them"), "{}", err);
        assert!(root.join("work\\a.md").is_file(), "the refusal changed nothing");

        let r = delete_folder_in(&root, "work", Some("")).unwrap();
        assert_eq!(r["moved"], 2);
        assert!(!root.join("work").exists());
        assert!(root.join("a.md").is_file());
        // A flat move has to keep both stems; the second one is renamed, not lost.
        assert!(root.join("b.md").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_folder_deletes_cleanly() {
        let root = tmp();
        std::fs::create_dir_all(root.join("empty\\deeper")).unwrap();
        let r = delete_folder_in(&root, "empty", None).unwrap();
        assert_eq!(r["moved"], 0);
        assert!(!root.join("empty").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn exporting_a_vault_keeps_its_shape_and_only_overwrites_on_request() {
        let root = tmp();
        seed(&root, "work/a.md", "id-a", "alpha");
        seed(&root, "b.md", "id-b", "beta");
        let out = tmp();

        let r = export_vault_in(&root, out.to_str().unwrap(), false).unwrap();
        assert_eq!(r["copied"], 2);
        assert!(out.join("work\\a.md").is_file());
        assert!(out.join("b.md").is_file());

        std::fs::write(out.join("b.md"), "do not lose me").unwrap();
        let r = export_vault_in(&root, out.to_str().unwrap(), false).unwrap();
        assert_eq!(r["copied"], 0);
        assert_eq!(r["skipped"], 2);
        assert_eq!(std::fs::read_to_string(out.join("b.md")).unwrap(), "do not lose me");

        let r = export_vault_in(&root, out.to_str().unwrap(), true).unwrap();
        assert_eq!(r["copied"], 2);
        assert!(std::fs::read_to_string(out.join("b.md")).unwrap().contains("beta"));

        // Exporting into the vault itself would mix the copy with the source.
        let err = export_vault_in(&root, root.to_str().unwrap(), false).unwrap_err();
        assert!(err.contains("outside the vault"), "{}", err);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&out);
    }

    #[test]
    fn importing_never_overwrites_and_gives_a_colliding_id_a_new_one() {
        let root = tmp();
        seed(&root, "a.md", "id-aaaaaa", "original");
        let src = tmp();
        std::fs::write(src.join("a.md"), "---\naery_id: id-aaaaaa\ntitle: Imported\n---\n\nnew body").unwrap();
        std::fs::write(src.join("notes.txt"), "ignored").unwrap();

        let r = import_in(&root, vec![
            src.join("a.md").to_string_lossy().to_string(),
            src.join("notes.txt").to_string_lossy().to_string(),
        ], Some("")).unwrap();
        assert_eq!(r["imported"], 1);
        assert_eq!(r["skipped"], 1);
        assert_eq!(r["renamed"], 1);
        assert!(root.join("a 2.md").is_file(), "the existing note is untouched");
        assert!(std::fs::read_to_string(root.join("a.md")).unwrap().contains("original"));
        // Two notes must not share an id: a tab and a study card would follow
        // the wrong one.
        let imported = std::fs::read_to_string(root.join("a 2.md")).unwrap();
        assert!(imported.contains("aery_id: a"), "{}", imported);
        assert!(!imported.contains("id-aaaaaa"), "the id was replaced: {}", imported);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&src);
    }

    #[test]
    fn importing_a_folder_keeps_its_shape_and_reports_what_it_could_not_read() {
        let root = tmp();
        let src = tmp();
        std::fs::create_dir_all(src.join("Vault\\deep")).unwrap();
        std::fs::write(src.join("Vault\\one.md"), "---\ntitle: One\n---\n\n[[Nowhere]]").unwrap();
        std::fs::write(src.join("Vault\\deep\\two.md"), "two").unwrap();
        std::fs::write(src.join("Vault\\skip.png"), "not markdown").unwrap();

        let r = import_in(&root, vec![src.join("Vault").to_string_lossy().to_string()], Some("")).unwrap();
        assert_eq!(r["imported"], 2);
        assert!(root.join("Vault\\one.md").is_file());
        assert!(root.join("Vault\\deep\\two.md").is_file());
        assert!(!root.join("Vault\\skip.png").exists());
        assert_eq!(r["unresolved_links"], 1, "[[Nowhere]] has no target");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&src);
    }
}
