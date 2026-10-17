# STRYV — development and the test app

Two ways to work on STRYV without waiting for a production build.

---

## 1. The test app (real desktop window, Rust included)

This is the real application: real window, real backend, real readings.

```powershell
npm run dev:app
```

- Window title reads **STRYV Test** so you cannot mistake it for the shipped app.
- Binary: `src-tauri\target\debug\stryv-test.exe`
- Data lives in its own folder, `AppData\Roaming\app.stryv.desktop.test`, so it
  can never touch your real settings, activity history or ATLAS library.
- Bundling and the updater are switched **off** in this config, so a test run can
  never produce or install a release.

To get a standalone test binary without the dev server:

```powershell
npm run test:app
```

### When do you need a rebuild?

| You changed | Rebuild needed? |
|---|---|
| anything in `src/` (JS, CSS, HTML) | **No.** The dev server reloads it. |
| `src-tauri/src/*.rs` | Yes, but incremental — measured **5.7s** on this machine. |
| `Cargo.toml` / dependencies | Yes, and the first build is slow (~1 min) because all ~500 crates compile from scratch. |
| `src-tauri/tauri.conf.json`, icons | Yes. |

`npm run dev:app` handles the rebuild for you: it recompiles only what changed
and reloads the window. **There is no separate build step to remember.**

The honest caveat: Rust changes cannot be applied without recompiling. That is
the language, not this setup. What the setup avoids is recompiling when you did
not touch Rust.

---

## 2. The frontend dev server (no Rust needed)

```powershell
npm run dev:web
```

- <http://localhost:5173>
- Serves the **real** files from `src/` — not a copy, not a bundle.
- Reloads the browser the moment you save a `.css`, and re-runs the whole page
  for a `.js` change. `intro.js` and friends are classic scripts sharing
  globals, so there is no module graph to hot-swap into; a reload is the honest
  equivalent of HMR here, and it is instant.
- Injects a **mock backend** so the UI boots in a plain browser.

### The mock is loud on purpose

A red `DEV MOCK — synthetic data, not this PC` badge is pinned to the top of the
viewport. Every reading it produces is invented, and the badge says so.

The mock **cannot reach a production build**. It is not referenced by
`src/index.html` — the dev server injects it into the page it serves, in memory,
and never writes it to disk. A packaged app loads from `frontendDist` with no
reference to it at all.

Optimizations (`opt_preview`, `opt_apply`, `opt_startup_set`) deliberately
**throw** in the mock instead of faking success, because those would touch the
real machine.

---

## Toolchain

| Tool | Status |
|---|---|
| Rust 1.99.1 | installed (`%USERPROFILE%\.cargo\bin`) |
| MSVC 14.44.35207 | installed |
| Windows SDK 10.0.26100 | installed |

If `cargo` is not found, your `PATH` has not picked up the Rust bin folder yet.
Either restart the terminal or:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path
```

`cargo` is **not** on the machine-wide PATH, so `npm run dev:app` needs that
line in the session, or the terminal restarted after installing Rust.

---

## Screenshots without the hang

```powershell
npm run shot -- --out shot.png --size 1280x800 --no-intro
npm run shot -- --out shot.png --page atlas
npm run shot -- --out shot.png --at 1200
```

`--at` pins a fake clock and advances it, so a frame at an exact moment of the
launch animation can be captured.

**Known limitation, and it matters:** headless Chromium does not reliably paint
canvas content that was drawn during a synchronous `requestAnimationFrame` loop.
Canvas readings from this tool are unreliable — it reported the smoke as empty
when it was demonstrably rendering. Use it for layout and static UI. **For the
launch animation, run the test app and look at the actual window.**

---

## Checks

```powershell
npm test     # 380 assertions: boot, ATLAS, Aery, Rust command structure
npm run check # syntax + the above
```

`npm test` includes a boot test that parses every script the page loads the way
a browser does. It refuses a top-level `return` and catches two scripts claiming
the same top-level name — both of which have caused a black screen at release.

Rust is verified by `cargo check` / `npm run test:app`. There is no Rust test
harness in the suite; `tests/rust-structure-check.js` only checks that commands
are registered and that ATLAS's public surface exists, and says so.
