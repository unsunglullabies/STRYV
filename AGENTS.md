# STRYV — AGENT NOTES

Notes for anyone working in this repo. Written for the case where a person and an
agent are both in here. **Coordinate before editing shared files.**

Current version: **0.2.9**. Latest published release: **v0.2.8** (0.2.9 is built
locally and tagged, not yet published).

---

## 1. What this is

**STRYV** — a Tauri 2 desktop system monitor for Windows with a notes app (Aery),
a hardware-assistant page (SYN), a game library (ATLAS), a task manager, and
background monitoring that keeps running when the window is closed.

Vanilla JS frontend, no bundler, no framework. Rust backend. Dark UI, amber accent.

---

## 2. Where it lives

```
C:\Users\frost\OneDrive\Desktop\stryv-tauri
```

It used to be in `Downloads\stryv-tauri`. That path is gone.

Remote: `https://github.com/unsunglullabies/STRYV.git`
(the GitHub account was renamed from `ririsanchez67-byte`)

---

## 3. Layout

```
src/core.js              shared helpers, PAGES, CHANGELOG, VERSION
src/index.html           every page, the sidebar markup, script load order
src/app.js               bootstrap and routing (go())
src/atlas.js             game library: scan, cards, detail, Store page
src/aery.js              notes
src/syn.js               hardware assistant
src/tasks.js             task manager (self-registering page)
src/bgui.js              background-mode and alerts UI
src/style.css            design tokens and component styles
src/glass.css            frosted glass layer, sidebar

src-tauri/src/main.rs    all Tauri commands, registered in generate_handler!
src-tauri/src/atlas.rs   ATLAS coordinator, canonicalisation, store, launching
src-tauri/src/launchers.rs  Epic / GOG / EA / Xbox adapters
src-tauri/src/aery.rs    notes vault
src-tauri/src/bg.rs      background threads, alerts, tray

scripts/release-notes.js     changelog -> GitHub Release body + manifest notes
scripts/make-latest-json.js  builds the updater manifest, refuses unsigned
```

### Pages register themselves

`tasks.js` and the ATLAS Store page both create their own `<section>`, push their
name onto `PAGES`, and add their own sidebar button. Follow that pattern rather
than editing `index.html` for a new page — it keeps a feature from needing
changes in three files.

**`src/core.js` is shared.** It holds `VERSION` and `CHANGELOG`, which every page
depends on. Re-read it before editing.

---

## 4. Hard rules

1. **Never `git push`, tag, or release without explicit approval.** The user
   decides, every time.
2. **Never commit or print the signing key.** It lives at
   `C:\Users\frost\.tauri\stryv.key` and in the `TAURI_SIGNING_PRIVATE_KEY`
   secret. Keep it that way.
3. **No fabricated data.** Never invent FPS, frame times or telemetry that was not
   measured. If a number is unavailable, say so.
4. **Don't claim half-built things work.** ATLAS reads Epic, GOG and EA but
   cannot start games through them — it opens the launcher and lets you click Play
   yourself. That is a deliberate limit, not a bug to quietly remove.
5. **No runtime dependencies in the frontend.** Zero, by design.
6. **Preserve working features.** Dashboard, Performance, Network, System,
   Optimizations, GPU, Settings, updater, command palette, export/reset, and the
   background work on the `background-tasks` line.

---

## 5. Environment

- **Rust is installed** at `C:\Users\frost\.cargo\bin`. It is not on `PATH` by
  default in a fresh shell — prepend it:
  ```powershell
  $env:PATH = "C:\Users\frost\.cargo\bin;$env:PATH"
  ```
  Earlier notes in this file said there was no toolchain and that compilation only
  happened in CI. That was true once and is not now.
- **`gh` is not installed.** Use the GitHub REST API with a token from
  `git credential fill`:
  ```powershell
  $o = "url=https://github.com" | git credential fill
  $t = ($o | ? { $_ -like 'password=*' }) -replace '^password=',''
  $H = @{ 'User-Agent'='x'; 'Authorization'="Bearer $t"; 'Accept'='application/vnd.github+json' }
  ```
- Actions log downloads return 403 unless you use the canonical repo name, and
  come back as a ZIP.
- The Tauri CLI has **no `signer verify` subcommand.** Checking a signature needs
  your own Ed25519ph verifier — Node's `crypto.verify` will silently fail,
  because the signer uses the prehashed variant.
- `C:\Users\frost\package.json` is malformed and breaks `node` for any script run
  from outside the repo. Always run Node scripts from inside the repo directory.
- Several source files carry **mixed line endings**. A stray CRLF among LF lines
  will make `includes("\r\n")` pick the wrong one and every string match fail.
  Count both endings, or edit line by line.

---

## 6. Build and test

```powershell
npm test        # 455 frontend assertions + Rust structure check
npm run test:app   # builds stryv-test.exe and runs it -- the real app, debug
```

```powershell
cargo test --manifest-path src-tauri\Cargo.toml    # 63 tests
```

`cargo test` needs the cargo path from §5.

`npm run test:app` produces `src-tauri\target\debug\stryv-test.exe`. Plain
`cargo build` produces `stryv.exe`, which is a different binary — do not look for
the test one after a plain build.

`node --check` every file in `src/`, `tests/` and `scripts/`.

---

## 7. Releasing

```
push to main  ->  build, test, compile check
tag v*        ->  build, sign, make-latest-json.js, upload artifacts
              ->  release-notes.js, then gh release create
```

1. Bump the version in `package.json`, `package-lock.json`,
   `src-tauri/Cargo.toml`, `src-tauri/tauri.lock`, `src-tauri/tauri.conf.json`,
   `src-tauri/tauri.test.conf.json`, `src-tauri/tauri.dev.conf.json` and
   `src/core.js`.
2. Add a `CHANGELOG` entry in `src/core.js`. `scripts/release-notes.js` reads it
   to produce both the GitHub Release body and the updater manifest's notes, so
   the release page and the app cannot disagree. **Every group name is a
   paragraph heading in the release body** — see the existing entry.
3. Ask the user.
4. `git push origin main`, then tag and push the tag.

`make-latest-json.js` refuses to write a manifest unless every artifact has a
matching `.sig`, and now refuses to write one with empty notes. Both refusals are
intentional.

### History has been rewritten

The local history was rewritten to remove Claude attribution from commit
messages, and that rewrite **has not been pushed**. `origin/main` is at the
published `v0.2.8`, and the local `v0.2.8` tag points at a different commit.
Pushing therefore needs `--force-with-lease`, and moving the tag rewrites a
published, signed release's commit. Confirm with the user before doing either.

Backup branches exist from the rewrite: `backup-before-removing-claude`,
`backup-before-github-sync`, `backup-before-filter`, `rewrite-published-history`.

There are currently **no `Co-Authored-By` trailers** in `main`. Keep it that way —
the user was not happy about Claude showing as a co-author on their GitHub page.

---

## 8. Things that will bite you

- **`fn detected_games`** is gone, refactored into `scan` / `canonicalize` /
  `merge_library` long ago. A stale test expectation for it was removed in 0.2.9.
- **Store packages carry no "is a game" flag.** The Xbox adapter matches a list of
  publishers and denies a list of known non-games. Both are slices. The Game Bar's
  package is `Microsoft.XboxGamingOverlay`, **not** `XboxGameBar` — the Start menu
  calls it "Game Bar", which is how the wrong name got in.
- **A Store package family is publisher plus codename**, so never derive a title
  from it by splitting on a dot. The display name lives with the start app.
- **Mixed line endings** in several files — see §5.
- Several Rust helpers are **module-level, not indented**. Anchoring an edit on
  the wrong indentation silently misses.

---

## 9. Prior work worth knowing about

- ATLAS 0.2.7 introduced the `Source` adapter trait, per-source scanning,
  canonical dedup and the versioned store. `docs/ATLAS-AUDIT.md` is the plan and
  the source of truth for what each source does and does not support.
- 0.2.8 added Epic, GOG, EA and Xbox adapters, a compact card grid, and per-patch
  update-log entries with main titles.
- 0.2.9 fixed the Store title bug, added Store launching and the Store page,
  moved the launch policy into the backend, and did a quality-of-life pass.
- The background work (Task manager, background alerts, glass controls) came from
  the user's own machine and was committed on `background-tasks` (`a6b2f83`)
  before being merged. It carries `*.before-background` originals kept so the
  change can be undone without a revert.