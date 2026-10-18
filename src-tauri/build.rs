use std::path::{Path, PathBuf};

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

fn main() {
    // The frontend is embedded into the binary, but nothing was registering
    // ../src as a build dependency. Editing any .js, .css or .html file
    // therefore left cargo with nothing to do: it printed "Finished" in about
    // five seconds, produced a byte-identical binary, and the test app went on
    // serving whatever frontend was frozen into it the first time it was built.
    //
    // That is the worst kind of build failure - it looks like it worked. A
    // frontend fix could be committed, rebuilt, and never appear on screen.
    //
    // Each FILE has to be listed individually. Watching the directory does not
    // work here: on Windows a directory's mtime changes when entries are added
    // or removed, but not when an existing file's contents are edited, so
    // editing intro.js would still not trigger anything.
    let frontend = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src");
    let mut files = Vec::new();
    walk(&frontend, &mut files);
    files.sort();
    for f in &files {
        println!("cargo:rerun-if-changed={}", f.display());
    }
    // Also re-run if the directory listing itself changes (a file added or
    // removed), which the per-file entries above cannot see.
    println!("cargo:rerun-if-changed={}", frontend.display());

    tauri_build::build()
}
