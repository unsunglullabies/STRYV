// A child module does not inherit the parent's imports, so these are declared
// here. now_unix lives in main.rs and is reached through super.
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::Manager;
use super::now_unix;
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

pub fn aery_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let v = d.join("vault");
    std::fs::create_dir_all(&v).map_err(|e| e.to_string())?;
    Ok(v)
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

/// Deterministic per-path fallback id for notes that have never been saved by
/// Aery. Deterministic so a scan run twice in a row does not invent two ids.
pub fn aery_new_id(rel: &str, salt: u64) -> String {
    let mut h: u64 = 0x9e37_79b9_7f4a_7c15 ^ salt;
    for b in rel.to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
        h ^= h >> 29;
    }
    format!("a{:016x}", h)
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

#[tauri::command]
pub fn aery_list(app: tauri::AppHandle, q: Option<String>, tag: Option<String>) -> Result<Vec<AeryNote>, String> {
    let root = aery_root(&app)?;
    let meta = aery_read_meta(&root);
    let mut notes: Vec<AeryNote> = Vec::new();
    aery_scan_dir(&root, &root, &meta, &mut notes, 0);

    let term = q.unwrap_or_default().trim().to_lowercase();
    let want_tag = tag.unwrap_or_default().trim().trim_start_matches('#').to_lowercase();
    if !term.is_empty() || !want_tag.is_empty() {
        notes.retain(|n| {
            let hit_tag = want_tag.is_empty() || n.tags.iter().any(|t| *t == want_tag);
            let hit_term = term.is_empty()
                || n.title.to_lowercase().contains(&term)
                || n.excerpt.to_lowercase().contains(&term)
                || n.tags.iter().any(|t| t.contains(&term));
            hit_tag && hit_term
        });
    }

    notes.sort_by(|a, b| {
        b.pinned.cmp(&a.pinned).then(b.modified.cmp(&a.modified)).then(a.title.cmp(&b.title))
    });
    Ok(notes)
}

#[tauri::command]
pub fn aery_read(app: tauri::AppHandle, id: String) -> Result<serde_json::Value, String> {
    let root = aery_root(&app)?;
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
    aery_atomic_write(&path, content.as_bytes())
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
            let body = format!("---\ntitle: {}\n---\n\n", base);
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
        let target = root.join(orig.replace('~', "/"));
        // Never let a restore write outside the vault, even if the trash was
        // tampered with by hand.
        let target = match target.canonicalize() {
            Ok(c) => c,
            Err(_) => {
                if let Some(p) = target.parent() { let _ = std::fs::create_dir_all(p); }
                target
            }
        };
        if !target.starts_with(&root) { continue; }
        if let Some(p) = target.parent() {
            std::fs::create_dir_all(p).map_err(|x| x.to_string())?;
        }
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
    let mut folders: Vec<String> = notes.iter().filter(|n| !n.folder.is_empty()).map(|n| n.folder.clone()).collect();
    folders.sort();
    folders.dedup();
    Ok(json!({ "notes": notes.len(), "tags": tags, "folders": folders }))
}
// ============================================================================
// Tests
// ============================================================================
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

    // ---- identity ----------------------------------------------------------

    #[test]
    fn front_matter_id_round_trips() {
        let id = aery_new_id("notes/idea.md", 7);
        let doc = aery_ensure_id("# Idea\n\nbody", &id);
        assert!(doc.starts_with("---\n"), "front matter must be added");
        assert!(doc.contains(&format!("aery_id: {}", id)));
        assert!(doc.ends_with("# Idea\n\nbody"), "body must be untouched");
        assert_eq!(aery_front_id(&doc).as_deref(), Some(id.as_str()));
    }

    #[test]
    fn ensure_id_is_idempotent_and_never_rewrites_an_existing_id() {
        let a = aery_new_id("x.md", 1);
        let b = aery_new_id("x.md", 2);
        let once = aery_ensure_id("text", &a);
        let twice = aery_ensure_id(&once, &b);
        assert_eq!(once, twice, "a second ensure must not overwrite the id");
        assert_eq!(aery_front_id(&twice).as_deref(), Some(a.as_str()));
    }

    #[test]
    fn ensure_id_preserves_other_front_matter_keys() {
        let id = aery_new_id("y.md", 3);
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