# CLAUDE READ ME

Coordination notes for anyone (human or AI) working in this repo alongside Aria.
Written while two agents are active. **Coordinate before editing.**

---

## 1. What this is

**STRYV** — a Tauri 2 desktop system monitor for Windows, packaged as a Tauri app.
Vanilla JS frontend (no bundler, no framework), Rust backend, dark UI with restrained
amber accents.

Current shipped version: **0.2.0**, published and signed.

---

## 2. Repo location (it moved!)

```
C:\Users\frost\OneDrive\Desktop\stryv-tauri
```

It used to live in `Downloads\stryv-tauri`. **That path is gone.** If you were given
the old path, it will fail — update it.

Remote: `https://github.com/unsunglullabies/STRYV.git`
(The GitHub account was renamed from `ririsanchez67-byte` to `unsunglullabies`.)

---

## 3. Division of labour right now

| Owner | Files | Status |
|---|---|---|
| **Aria** | `src/atlas.js`, ATLAS parts of `src/index.html` and `src/style.css`, `atlas_*` commands in `src-tauri/src/main.rs`, `tests/` | **In progress** |
| **Other** | `src/intro.js`, `src/meas.js`, `src/sensors.js`, `src/opt.js`, `src/health.js`, `src/updater.js`, `src/app.js`, `src/core.js` | Free to take |

**`src/core.js` is shared.** Coordinate before editing it — ATLAS work touches it,
and so does everyone else. If both agents need it, one edits and the other re-reads.

**SYN is explicitly not started.** Do not begin SYN until ATLAS has a reliable
foundation. That's the user's standing instruction.

---

## 4. Hard rules

1. **Never `git push`, create a release, or commit without explicit approval.**
   The user decides. Ask first, every time.
2. **Never commit or print the signing key.** It lives at
   `C:\Users\frost\.tauri\stryv.key` and in the GitHub secret
   `TAURI_SIGNING_PRIVATE_KEY`. It is *not* in the repo. Keep it that way.
3. **No fabricated data.** Never invent FPS, frame times, or telemetry that wasn't
   actually measured. If a number isn't available, show that it isn't.
4. **Don't claim planned features are implemented.** If it's half-built, say so.
5. **No unnecessary dependencies.** The frontend has zero runtime deps by design.
6. **Preserve working features.** Dashboard, Performance, Network, System,
   Optimizations, GPU, Settings, updater, command palette, export/reset.

---

## 5. Environment gotchas (these will bite you)

- **No Rust toolchain on this machine.** No `cargo`, `rustc`, `rustup`, no MSVC.
  `npm run build` fails locally with `failed to run 'cargo metadata'`.
  **Compilation only happens in GitHub Actions.**
- `gh` CLI is **not** installed. Use the GitHub REST API with the token from
  `git credential fill` if you need automation:
  ```powershell
  $o = "url=https://github.com" | git credential fill
  $t = ($o | ? { $_ -like 'password=*' }) -replace '^password=',''
  $H = @{ 'User-Agent'='x'; 'Authorization'="Bearer $t"; 'Accept'='application/vnd.github+json' }
  ```
- Secrets are set as **repository** secrets (not environment secrets).
  Names must be exact: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- GitHub Actions **log downloads** return 403 unless you use the canonical repo
  name in the URL. The returned file is a **ZIP** — expand it, don't read it raw.
- The Tauri CLI has **no `signer verify` subcommand**. To check a signature you need
  your own Ed25519ph verifier (Node's `crypto.verify` will *not* work — the signer
  uses the prehashed variant, so it silently fails).
- Studio-style APIs mentioned in some AGENTS.md files (UIGridLayout.FixedCellSize,
  Instance:WaitFirstChild, Enum.SizeConstraint.Fixed) **do not exist**. That
  guidance is for Roblox and does not apply here.

---

## 6. Build / release flow

```
push to main  ->  Build and sign job  (npm test -> tauri build -> sign -> latest.json -> artifacts)
tag v*        ->  same job, then Publish release job  (gh release create)
```

Secrets are required for anything that isn't a PR. **A failed secret check stops the
build before anything is produced** — that is intentional, not a bug.

To publish a version:

1. Bump version in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`,
   `src-tauri/tauri.conf.json`, and `VERSION` in `src/core.js`.
2. Update `CHANGELOG` in `src/core.js`.
3. Ask the user for approval.
4. `git push origin main`, then `git tag -a vX.Y.Z` and push the tag.

The user must install `0.2.0` by hand once — an app with no updater cannot deliver
its own first version. Every release after that goes through the in-app updater.

---

## 7. Checks to run

```powershell
npm test        # 59 passing at time of writing
```

`node --check` every file in `src/` plus `tests/` and `scripts/`.

There is **no working local build** — rely on CI, and say so rather than implying
the build was verified locally.

---

## 8. Where things live

```
src/index.html          all pages, nav markup, script load order
src/core.js             shared helpers (q, esc, toast, Act, Tech) + PAGES + CHANGELOG + VERSION
src/style.css           design tokens and base component styles
src/app.js              bootstrap
src-tauri/src/main.rs   all tauri commands, registered via generate_handler!
scripts/make-latest-json.js   builds the updater manifest, refuses unsigned artifacts
tests/atlas.test.js     ATLAS + changelog + frontend tests (custom minimal runner)
```

Read `src/core.js` before writing any page code — everything depends on its helpers.