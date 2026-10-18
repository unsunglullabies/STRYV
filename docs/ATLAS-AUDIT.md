# ATLAS — Source-of-truth feature matrix

Compiled 2026-10-16 by reading `src/atlas.js` (726 lines), `src-tauri/src/main.rs`
ATLAS region (lines 560-1090), the ATLAS markup in `src/index.html` (lines 50-152),
the ATLAS rules in `src/style.css`, and all 281 assertions in `tests/atlas.test.js`,
plus Git history `18ead85` → `c51735f` → `20b2de9` → `a53f9ba` → `a2aa606`.

Status vocabulary: **DONE** shipped and tested · **PARTIAL** works, narrower than spec ·
**NONE** not implemented at all.

---

## 1. Discovery and adapters

| Feature | Expected behaviour | Current status | Implementation | Data source | Missing work | Dependencies | Priority | Acceptance criteria | Tests |
|---|---|---|---|---|---|---|---|---|---|
| Multi-launcher discovery | Scan every supported launcher, not one | **NONE** | `detected_games()` main.rs:678-686 calls `steam_dir()` and nothing else | Steam `libraryfolders.vdf` + `appmanifest_*.acf` | Adapter trait, coordinator, per-source isolation | `Source` trait + `ScanReport` | P0 | ≥2 adapters registered; one failing source does not zero the scan | Rust: coordinator runs all adapters, one panicking adapter still returns others |
| Steam adapter | Full multi-library Steam scan | **DONE** | `steam_games()` main.rs:645-676 | Steam registry + VDF | None for discovery; move into adapter | — | — | 4 games, correct ids, sizes, dates | `cargo test` + JS fixture parity |
| Standalone / manual adapter | Detect unmanaged `.exe` titles, keep under user control | **NONE** | `store.manual` only via explicit "Add game" | User-chosen path | Adapter that surfaces hand-added entries as a source | None | P1 | Manual entries report as a named source in the scan report | Rust: manual entries counted under Standalone |
| Epic / GOG / Xbox / EA / Battle.net / Riot / Ubisoft | Detect each, or say plainly it is unsupported | **NONE** | Zero references in `main.rs` or `atlas.js` | — | Adapters + honest unsupported surface | Per-launcher file formats, permission checks | P2 | Each source reports `NotInstalled` / `Unsupported` — never silently vanishes | Rust: every registered source appears in the report |
| Structured scan report | Per-source status, timing, counts, reasons | **NONE** | `atlas_scan` returns bare `Vec<Game>` | — | `ScanReport` + `SourceReport` | Adapter trait | P0 | UI can say *why* a source contributed nothing | Rust: report shape; JS: renders per-source rows |
| Source enable/disable + persisted settings | Turn a source off without uninstalling | **NONE** | — | — | Store field + command + settings UI | — | P2 | Disabled source is skipped and reported as skipped | Rust + JS |
| Scan progress | User sees work happening | **PARTIAL** | Button label flips to "Scanning…" atlas.js:368 | — | Per-source progress events | Events plumbing | P2 | Each source reports in when it starts/ends | — |

## 2. Data model

| Feature | Expected behaviour | Current status | Implementation | Data source | Missing work | Dependencies | Priority | Acceptance criteria | Tests |
|---|---|---|---|---|---|---|---|---|---|
| Canonical game vs installation | One game, many installs/locations | **NONE** | `Game` struct conflates both; `id` is per-source (`steam:359550`, `manual:<hash>`) | — | `CanonicalGame` + `Installation`, dedup by identity | Store migration | P0 | Same title from two sources = one card, two installs | Rust: merge produces one canonical, two installs |
| Store versioning + migration | Old stores open without data loss | **PARTIAL** | `AtlasStore.version: u32` exists, never checked or migrated | — | Version gate + non-destructive migration | New model | P0 | v1 store with favourites/sessions/manual survives an upgrade read | Rust: migration test from a v1 fixture |
| Install availability | Honest ready/unavailable per installation | **DONE** | Recomputed every merge, main.rs:719 | Filesystem | Per-install instead of per-game | Canonical model | P0 | Moved install shows unavailable with its path | Rust + JS |
| Dedup / merge policy | Hand-added + detected merge without duplicates | **DONE** | `merge_library()` main.rs:691-738, id-keyed | — | Identity-based rather than id-based | Canonical model | P0 | One card per game regardless of source | Existing 281 assertions |

## 3. Sessions and telemetry

| Feature | Expected behaviour | Current status | Implementation | Data source | Missing work | Dependencies | Priority | Acceptance criteria | Tests |
|---|---|---|---|---|---|---|---|---|---|
| Direct-launch sessions | Measured duration for hand-added games | **DONE** | Thread polls child, main.rs:1056-1087 | Real process | — | — | — | Duration + peak CPU/mem recorded | `cargo test`, JS session assertions |
| Launcher-launch sessions | Record honestly that duration is unknown | **DONE** | `push_session(..., measured=false)`, main.rs:1032 | — | — | — | — | Shows "duration not measured" | JS: `an unmeasured session ...` |
| Steam playtime import | Show launcher's own playtime | **NONE** | Never read | — | Read localconfig playtime | Adapter work | P3 | Labelled as launcher-reported, kept separate from ATLAS-measured | — |
| Session cap | Bounded history | **PARTIAL** | Hard cap 100 at write, main.rs:755; UI shows 50 | — | Configurable retention | Settings | P3 | Cap is visible in settings | — |
| Uninstall/crash detection | Terminal state always resolved | **NONE** | Thread polls `try_wait`; app exit kills the thread | — | Flush on shutdown | Shutdown hook | P1 | Closing STRYV mid-session still records elapsed time | — |

## 4. Library UX

| Feature | Expected behaviour | Current status | Implementation | Data source | Missing work | Dependencies | Priority | Acceptance criteria | Tests |
|---|---|---|---|---|---|---|---|---|---|
| Card grid | Cover-led cards | **DONE** | `card()` atlas.js:241-266 | — | Trim the 4-row metadata block (§15.4) | — | P1 | Card shows ≤3 facts; detail panel holds the rest | JS grid assertions |
| Featured hero | Compact banner, not a viewport-swallowing block | **PARTIAL** | `renderFeature()` atlas.js:179-207; `at-feature` | — | Shrink to a single row; drop redundant stats | — | P1 | Hero ≤120px; does not push the grid below the fold | Screenshot |
| Search | Filter by name/launcher/path | **DONE** | `visible()` atlas.js:144-152 | — | — | — | — | Case-insensitive, trimmed | JS search assertions |
| Sort | 5 keys, favourites pinned | **DONE** | `sorted()` atlas.js:154-166 | — | — | — | — | All 5 keys produce distinct orders | JS sort assertions |
| Filters | Favourites / needs-attention / clear | **DONE** | `filters` + chips | — | Add source filter once adapters exist | Scan report | P2 | Source chip filters the grid | — |
| Detail panel | Full metadata, honest nulls | **DONE** | `openDetail()` atlas.js:463-512 | — | Add install list once canonical model lands | Canonical model | P1 | Multiple installs listed separately | — |
| Empty states | Distinct per cause | **DONE** | Four states, atlas.js:283-303 | — | Add "source X failed" state | Scan report | P0 | Each failure cause has its own message | JS empty-state assertions |
| Non-game applications | Distinguish apps (Wallpaper Engine) from games | **NONE** | No `kind` field; screenshot shows it listed as a game | — | `kind: game \| application \| tool`, filtered by default | Canonical model | P1 | Wallpaper Engine shows as an application entry | Rust + JS |
| Collections / tags | User grouping | **NONE** | — | — | Collection model + UI | — | P3 | — | — |
| Source status surface | Show what ATLAS can and cannot see | **NONE** | Page note is static prose | — | Per-source status panel | Scan report | P0 | Panel lists every source and its state | JS |

## 5. Artwork

| Feature | Expected behaviour | Current status | Implementation | Data source | Missing work | Dependencies | Priority | Acceptance criteria | Tests |
|---|---|---|---|---|---|---|---|---|---|
| User-assigned cover | Local image wins, validated | **DONE** | `clean_art_path()` main.rs:907-927; `art()` atlas.js:104 | Local file | — | — | — | Only real image extensions accepted | Rust tests |
| Steam CDN cover | Fast cover without API | **DONE** | `cdn.cloudflare.steamstatic.com`, atlas.js:110-113 | Valve CDN | — | — | — | Only bare-decimal app ids reach the URL | JS: poisoned app id assertions |
| Store API fallback | Cover for titles the legacy path misses | **DONE** | `storeArt()` atlas.js:87-101 | Valve API | — | — | — | One request per id, never retried on miss | JS cover assertions |
| Placeholder | Graceful "no art" | **PARTIAL** | `at-covf` "No cover art" | — | Per-source branded placeholder instead of a striped void (§6.4) | — | P2 | Placeholder varies by source | — |
| Non-Steam artwork | Cover art for other sources | **NONE** | Steam-only paths | — | Per-adapter art resolution | Adapters | P3 | GOG/Epic covers resolve locally | — |

## 6. Launching

| Feature | Expected behaviour | Current status | Implementation | Data source | Missing work | Dependencies | Priority | Acceptance criteria | Tests |
|---|---|---|---|---|---|---|---|---|---|
| Steam launch | `steam://rungameid/<id>`, validated | **DONE** | `steam_start()` main.rs:974-1002 | Registry + allowlist | — | — | — | Non-numeric id rejected; id must be on this PC | Rust + JS |
| Direct launch | Spawn `.exe`, measure the session | **DONE** | `atlas_launch_id` main.rs:1016-1090 | Filesystem | — | — | — | Working dir set to exe parent | Rust |
| Per-source launch | Each launcher launched its own way | **NONE** | `if launcher == "Steam"` main.rs:1027 | — | Launch strategies behind the adapter trait | Adapter trait | P0 | Launch resolved by source, not by string compare | Rust |
| Launch safety | Never bypass DRM/anticheat | **PARTIAL** | Never writes to launchers; launches only | — | Keep source-metadata reads read-only | — | — | No launcher file is ever written | Rust: no write calls outside app data dir |

## 7. Platform and packaging

| Feature | Expected behaviour | Current status | Implementation | Data source | Missing work | Dependencies | Priority | Acceptance criteria | Tests |
|---|---|---|---|---|---|---|---|---|---|
| Windows-only scope | Honest about platform | **DONE** | Windows-only commands | — | — | — | — | — | — |
| Permission errors | Explain, never crash the scan | **PARTIAL** | `run()` swallows errors; `read_dir().ok()?` swallows rest | — | Per-source error capture | Scan report | P0 | Access-denied shows as a source error | Rust |

## Confirmed spec violations found

1. **§2 / §5 — Steam-only.** Zero non-Steam launcher code exists. The hero hardcodes the launcher list from whatever was found, so on a Steam-only machine it reads "4 GAMES · STEAM" and implies completeness.
2. **§6.4 — Wallpaper Engine listed as a game.** No `kind` field exists, so Steam applications, redistributables ("Steamworks Common Redistributables" is in the test fixture) and tools render identically to real games.
3. **§6.4 — No non-Steam artwork path.** Every cover is Steam CDN, store API, or a striped "No cover art" void.
4. **§14.4 — Availability is per-game, not per-installation.** `available` is one bool on `Game`.
5. **§15.1 — Hero is oversized.** `at-feature` renders a full `dl` of three stats plus a cover.
6. **§15.4 — Four metadata rows on every card** (`Size / Played / Launches / Session`) with identical value types repeated.
7. **§15.2 — No per-source status surface.** Nothing tells the user which launchers were checked, skipped, or unreadable.
8. **§12.2 / §13 — Canonical identity absent.** `id` is per-source; the same game from two sources becomes two cards.
9. **`atlas_scan` has no report shape.** The frontend cannot know why a source contributed nothing, so it shows a generic count.

## Stage plan

- **Stage 1 — audit (this document).**
- **Stage 2 — discovery foundation.** Adapter trait, coordinator, `CanonicalGame` +
  `Installation`, structured `ScanReport`, Steam parity, Standalone adapter, store
  migration. *(in progress)*
- **Stage 3 — library UX.** Compact hero, trimmed cards, source status panel,
  `kind` filtering, per-install detail.
- **Stage 4 — source coverage.** Remaining launchers, each with honest
  `NotInstalled`/`Unsupported` states and per-launcher tests.
- **Stage 5 — launch strategies.** Launch resolved through the adapter trait.