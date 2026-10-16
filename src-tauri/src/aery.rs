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
            let id = aery_id(&rel);
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
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

    let mut all_tags: Vec<String> = notes.iter().flat_map(|n| n.tags.clone()).collect();
    all_tags.sort();
    all_tags.dedup();

    Ok(json!({
        "note": note,
        "content": text,
        "outgoing": outgoing,
        "backlinks": back,
        "tags": all_tags,
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
        let dir = root.join(folder.clone().unwrap_or_default().replace('/', "\\"));
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
    let to = trash.join(format!("{}-{}", note.path.replace('/', "_"), stamp));
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
        // The trash name is "<original rel path with / replaced>_<stamp>".
        let Some((orig, _stamp)) = name.rsplit_once('_') else { continue };
        let target = root.join(orig.replace('_', "/"));
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
    let clean = folder.trim().trim_matches('/').replace('\\', "/");
    let to_dir = if clean.is_empty() { root.clone() } else { root.join(clean.replace('/', "\\")) };
    std::fs::create_dir_all(&to_dir).map_err(|e| e.to_string())?;
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