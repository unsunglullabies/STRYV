// ============================================================================
// DEV-ONLY MOCK BACKEND - never shipped
// ============================================================================
// This file is served ONLY by scripts/dev-server.js, which injects it into the
// page it serves. It is never referenced by src/index.html, so a packaged
// build physically cannot load it: there is no code path from the shipped
// frontend to this file.
//
// WHY IT EXISTS
// This machine has no Rust toolchain and no MSVC, so `tauri dev` cannot run and
// there is no real desktop app to drive. The frontend still needs a backend to
// boot against, or every page renders "Unavailable" and nothing can be judged.
//
// HONESTY RULES
//   - Every number here is SYNTHETIC. A red DEV MOCK badge is fixed to the top
//     of the viewport so a mocked reading can never be mistaken for a real one.
//   - Nothing here writes to disk, touches the registry, or launches anything.
//   - Commands with no mock deliberately return an error rather than a plausible
//     fake, so unimplemented surface is visible instead of silently faked.
// ============================================================================
(function () {
  "use strict";

  // Visibly loud, and unmissable over the app chrome.
  const badge = document.createElement("div");
  badge.textContent = "DEV MOCK - synthetic data, not this PC";
  badge.style.cssText = [
    "position:fixed", "left:50%", "top:0", "transform:translateX(-50%)",
    "z-index:99999", "background:#B91C1C", "color:#fff", "font:600 11px/1 ui-monospace,monospace",
    "letter-spacing:.14em", "padding:6px 14px", "border-radius:0 0 6px 6px",
    "pointer-events:none", "text-transform:uppercase"
  ].join(";");
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(badge));

  // Deterministic wobble so charts animate instead of sitting flat.
  let t = 0;
  const wob = (base, amp, period) =>
    base + Math.sin(t / period) * amp + Math.sin(t / (period * 0.37)) * amp * 0.6;
  const tick = () => { t += 120; };

  const SNAP = () => ({
    cpu: wob(34, 14, 900),
    cpu_freq: wob(3.4, 0.5, 1600),
    mem_used: wob(9.2, 1.1, 2200),
    mem_total: 32,
    mem_pct: wob(29, 6, 2200),
    uptime: 86400 * 3 + 4120,
    gpu_name: "MOCK GPU (synthetic)",
    gpu_pct: wob(21, 10, 1400),
    gpu_temp: wob(58, 5, 3000),
    gpu_mem_used: 2147483648,
    gpu_mem_total: 10737418240,
    disks: [{ name: "C: STRYV (mock)", total: 1000000000000, free: 388000000000 }],
    host: "DEV-MOCK-HOST",
    os: "Windows (mock)",
  });

  const PROCS = () => ([
    { name: "mock-browser.exe", pid: 4001, cpu: wob(18, 7, 700), mem: 412000000 },
    { name: "mock-compiler.exe", pid: 4002, cpu: wob(11, 5, 1100), mem: 268000000 },
    { name: "mock-game.exe", pid: 4003, cpu: wob(44, 16, 500), mem: 3410000000 },
    { name: "mock-shell.exe", pid: 4004, cpu: wob(3, 2, 900), mem: 96000000 },
    { name: "mock-audio.exe", pid: 4005, cpu: wob(6, 3, 1300), mem: 142000000 },
  ]);

  const NET = () => ([
    { name: "Mock Adapter", down: wob(18400000, 7000000, 700), up: wob(2300000, 900000, 1100), speed: 1000000000, up_speed: 1000000000 },
  ]);

  const GAMES = [
    { id: "mock:1", launcher: "Steam", app_id: "70", name: "Mock Title One", exe_path: "", install_dir: "", size_bytes: 41200000000, last_played: 1758000000, source: "detected", available: true, art_path: "", favorite: true, plays: 12, total_secs: 48000, last_session_secs: 4200 },
    { id: "mock:2", launcher: "Steam", app_id: "620", name: "Mock Title Two", exe_path: "", install_dir: "", size_bytes: 91000000000, last_played: 1750000000, source: "detected", available: true, art_path: "", favorite: false, plays: 3, total_secs: 9000, last_session_secs: 1800 },
    { id: "mock:3", launcher: "Manual", app_id: "", name: "Mock Manual Title", exe_path: "C:\\mock\\game.exe", install_dir: "C:\\mock", size_bytes: 0, last_played: 0, source: "manual", available: false, art_path: "", favorite: false, plays: 0, total_secs: 0, last_session_secs: null },
  ];

  const NOTES = {
    "welcome.md": { body: "---\ntitle: Welcome\n---\n# Welcome\n\nA mocked note so the Aery workspace has something to show.\n\nLink to [[Ideas]].", tags: ["mock"], created: 1758000000, updated: 1758100000, pinned: true },
    "ideas.md": { body: "---\ntitle: Ideas\n---\n# Ideas\n\nBacklink from [[Welcome]].\n\n#mock", tags: ["mock"], created: 1757000000, updated: 1757900000, pinned: false },
  };

  const handlers = {
    // --- monitoring -------------------------------------------------------
    get_snapshot: () => (tick(), SNAP()),
    get_system_info: () => ({
      os: "Windows (mock)", os_version: "mock", host: "DEV-MOCK-HOST",
      cpu_brand: "Mock CPU 16C/32T", cpu_cores: 16, mem_total: 32,
    }),
    get_processes: () => (tick(), PROCS()),
    get_network: () => (tick(), NET()),
    run_network_tests: () => Promise.resolve([
      { name: "Mock TCP", ok: true, ms: 24 },
      { name: "Mock DNS", ok: true, ms: 11 },
    ]),
    get_gpu: () => ({ name: "MOCK GPU (synthetic)", pct: wob(21, 10, 1400), temp: wob(58, 5, 3000), mem_used: 2147483648, mem_total: 10737418240 }),
    get_temps: () => [{ name: "Mock CPU Package", temp: wob(58, 6, 2500), kind: "cpu" }],

    // --- ATLAS ------------------------------------------------------------
    atlas_scan: () => GAMES,
    atlas_sessions: () => [{ id: "mock:1:1", game_id: "mock:1", name: "Mock Title One", launcher: "Steam", started: 1758100000, ended: 1758104200, duration_secs: 4200, cpu_pct: 62.5, mem_bytes: 8200000000, measured: true }],
    atlas_add_manual: () => GAMES[2],
    atlas_update: () => GAMES[2],
    atlas_set_favorite: () => null,
    atlas_remove: () => null,
    atlas_restore: () => null,
    atlas_clear_sessions: () => null,
    atlas_launch: () => "Mock launch: nothing was actually started.",
    atlas_launch_id: () => "Mock launch: nothing was actually started.",

    // --- Aery -------------------------------------------------------------
    aery_list: () => Object.entries(NOTES).map(([path, n]) => ({
      path, name: n.body.match(/title: (.+)/) ? n.body.match(/title: (.+)/)[1] : path,
      tags: n.tags, updated: n.updated, created: n.created, pinned: n.pinned,
    })),
    aery_read: (a) => NOTES[a.path] || null,
    aery_vault_path: () => "C:\\mock\\vault (does not exist)",
    aery_counts: () => ({ total: Object.keys(NOTES).length, pinned: 1, trashed: 0 }),
    aery_save: () => null, aery_create: () => null, aery_rename: () => null,
    aery_delete: () => null, aery_restore: () => null,
    aery_set_pinned: () => null, aery_set_folder: () => null,

    // --- explicitly not mocked -------------------------------------------
    // These would touch the real machine, so they report the reason instead of
    // pretending to have worked.
    opt_catalog: () => [],
    opt_snapshots: () => [],
    opt_preview: () => { throw new Error("Not available in DEV MOCK - optimization previews need the real backend."); },
    opt_apply: () => { throw new Error("Not available in DEV MOCK - optimizations are never applied from the mock."); },
    opt_rollback: () => { throw new Error("Not available in DEV MOCK - nothing was ever changed."); },
    opt_startup: () => [],
    opt_startup_set: () => { throw new Error("Not available in DEV MOCK - the Run key is never touched."); },
  };

  window.__TAURI__ = {
    core: {
      async invoke(cmd, args) {
        tick();
        const h = handlers[cmd];
        if (!h) throw new Error("DEV MOCK has no handler for `" + cmd + "`. Add one in scripts/dev/mock-backend.js if you need it.");
        return h(args || {});
      },
    },
    window: {
      getCurrentWindow: () => ({
        // The real app must show a hidden window; in the browser it is already
        // visible, so this is a no-op rather than a stubbed animation.
        show: () => Promise.resolve(), hide: () => Promise.resolve(),
        close: () => Promise.resolve(), setTitle: () => Promise.resolve(),
      }),
      getAll: () => Promise.resolve([]),
    },
    event: { listen: () => Promise.resolve(() => {}) },
    path: { appDataDir: () => Promise.resolve("C:\\mock\\appdata") },
  };

  // boot_mark is diagnostics only; swallow it so the mock is not noisy.
  window.__TAURI__.core.invoke_bootmark = true;
})();
