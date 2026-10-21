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

  // Field names must match src-tauri/src/main.rs exactly. When they did not,
  // app.js read s.cpu_usage as undefined, tick() returned false, and the whole
  // dev server reported "Could not read live system data" - so anything judged
  // through npm run dev:web was judging a fiction.
  const GB = 1073741824;
  const SNAP = () => ({
    cpu_usage: Math.max(0, Math.min(100, wob(34, 14, 900))),
    mem_used: Math.round(wob(9.2, 1.1, 2200) * GB),
    mem_total: 32 * GB,
    uptime_secs: 86400 * 3 + 4120,
    process_count: 5,
    disks: [{ name: "C: STRYV (mock)", total: 1000 * GB, available: 388 * GB }],
  });

  const PROCS = () => ([
    { name: "mock-browser.exe", pid: 4001, cpu: wob(18, 7, 700), mem: 412000000 },
    { name: "mock-compiler.exe", pid: 4002, cpu: wob(11, 5, 1100), mem: 268000000 },
    { name: "mock-game.exe", pid: 4003, cpu: wob(44, 16, 500), mem: 3410000000 },
    { name: "mock-shell.exe", pid: 4004, cpu: wob(3, 2, 900), mem: 96000000 },
    { name: "mock-audio.exe", pid: 4005, cpu: wob(6, 3, 1300), mem: 142000000 },
  ]);

  const NET = () => ([
    { name: "Mock Adapter", mac: "00:11:22:33:44:55", rx_bps: wob(18400000, 7000000, 700), tx_bps: wob(2300000, 900000, 1100), link_bps: 1000000000 },
  ]);

  const GAMES = [
    { id: "mock:1", launcher: "Steam", app_id: "70", name: "Mock Title One", exe_path: "", install_dir: "", size_bytes: 41200000000, last_played: 1758000000, source: "detected", available: true, art_path: "", favorite: true, plays: 12, total_secs: 48000, last_session_secs: 4200 },
    { id: "mock:2", launcher: "Steam", app_id: "620", name: "Mock Title Two", exe_path: "", install_dir: "", size_bytes: 91000000000, last_played: 1750000000, source: "detected", available: true, art_path: "", favorite: false, plays: 3, total_secs: 9000, last_session_secs: 1800 },
    { id: "mock:3", launcher: "Manual", app_id: "", name: "Mock Manual Title", exe_path: "C:\\mock\\game.exe", install_dir: "C:\\mock", size_bytes: 0, last_played: 0, source: "manual", available: false, art_path: "", favorite: false, plays: 0, total_secs: 0, last_session_secs: null },
  ];
  // Mirrors what the backend returns after the canonical/install split. A mock
  // that omits these cannot exercise the facet bar, the kind badge or the
  // install list, so the browser preview would quietly stop matching the app.
  const SRC_NAMES = { Steam: 'Steam', Manual: 'Manual' };
  const shaped = GAMES.map((g) => {
    const source = /steam/i.test(g.launcher) ? 'steam' : 'standalone';
    const kind = g.app_id === '431960' ? 'application' : g.app_id === '228980' ? 'tool' : 'game';
    return Object.assign({}, g, {
      kind,
      sources: [source],
      multi_install: false,
      installs: [{
        source_id: source,
        source_name: SRC_NAMES[g.launcher] || g.launcher,
        app_id: g.app_id || '',
        install_dir: g.install_dir || '',
        exe_path: g.exe_path || '',
        size_bytes: g.size_bytes || 0,
        last_played: g.last_played || 0,
        kind,
        available: g.available !== false,
        legacy_id: g.id,
      }],
    });
  });
  // One game really is installed twice, so the install list and the multi-install
  // badge are visible in the preview rather than only in the tests.
  const dupe = shaped.find((g) => g.sources[0] === 'standalone');
  if (dupe) {
    dupe.multi_install = true;
    dupe.installs = dupe.installs.concat([{
      source_id: 'steam', source_name: 'Steam', app_id: '367520',
      install_dir: 'C:\\Steam\\steamapps\\common\\' + dupe.name,
      exe_path: '', size_bytes: dupe.size_bytes, last_played: dupe.last_played,
      kind: 'game', available: true, legacy_id: 'steam:367520',
    }]);
  }
  // One game per launcher that is not Steam, so the preview shows the facet bar,
  // the per-source badges and the honest "cannot start through it yet" state.
  for (const [launcher, source, name, dir] of [
    ['Epic Games', 'epic', 'Fortnite', 'C:\\Program Files\\Epic Games\\Fortnite'],
    ["GOG", "gog", "Baldur's Gate 3", "C:\\GOG Games\\Baldur's Gate 3"],
    ['EA App', 'ea', 'The Sims 4', 'C:\\Program Files\\EA Games\\The Sims 4'],
    ['Xbox / Store', 'xbox', 'Minecraft', 'C:\\XboxGames\\Minecraft'],
  ]) {
    shaped.push({
      id: source + ':demo', launcher, app_id: '', name,
      install_dir: dir, exe_path: "", size_bytes: 0, last_played: 0,
      source: "detected", favorite: false, hidden: false, available: true,
      plays: 0, last_launch: 0, last_session_secs: null, total_secs: 0,
      kind: 'game', sources: [source], multi_install: false,
      installs: [{
        source_id: source, source_name: launcher, app_id: '',
        install_dir: dir, exe_path: '', size_bytes: 0, last_played: 0,
        kind: 'game', available: true, legacy_id: source + ':demo',
      }],
    });
  }
  const GAMES_SHAPED = shaped;

  const NOTES = {
    "welcome.md": { body: "---\ntitle: Welcome\n---\n# Welcome\n\nA mocked note so the Aery workspace has something to show.\n\nLink to [[Ideas]].", tags: ["mock"], created: 1758000000, updated: 1758100000, pinned: true },
    "ideas.md": { body: "---\ntitle: Ideas\n---\n# Ideas\n\nBacklink from [[Welcome]].\n\n#mock", tags: ["mock"], created: 1757000000, updated: 1757900000, pinned: false },
  };
  // The same id scheme the list emits, so a read reaches the note the list named.
  const nid = (p) => "mock:" + btoa(p).replace(/=+$/, "");
  const ntitle = (p, n) => (n.body.match(/title: (.+)/) || [null, p])[1];
  const nlinks = (body) => [...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
    .map((m) => m[1].trim());

  // --- mock study data ------------------------------------------------------
  const NOW = Math.floor(Date.now() / 1000);
  let SID = 20;
  const card = (id, deck, question, answer, src, due, last) => ({
    id, deck_id: deck, question, answer, source_note_id: src || "",
    created: NOW - 86400 * 6, updated: NOW - 86400, ease: 2.5,
    interval_days: last ? 2 : 0, reps: last ? 2 : 0, lapses: 0,
    due: due || 0, last_review: last || 0,
  });
  const STUDY = {
    version: 1,
    decks: [
      { id: "d1", name: "Biology", subject: "Cells", created: NOW - 86400 * 6, updated: NOW - 3600 },
      { id: "d2", name: "Systems", subject: "", created: NOW - 86400 * 4, updated: NOW - 7200 },
    ],
    cards: [
      card("c1", "d1", "What does the mitochondria do?", "Produces ATP through respiration.", nid("welcome.md"), 0, 0),
      card("c2", "d1", "What is the function of the cell membrane?", "Controls what moves in and out of the cell.", "", 0, 0),
      card("c3", "d1", "What is osmosis?", "Water moving across a membrane toward higher solute concentration.", "", 0, 0),
      card("c4", "d2", "What is a feedback loop?", "A system where the output changes the input.", "", NOW - 500, NOW - 86400),
    ],
    reviews: [
      { t: NOW - 86400 * 2, card_id: "c4", grade: "good", remembered: true },
      { t: NOW - 86400 * 2 + 300, card_id: "c3", grade: "again", remembered: false },
      { t: NOW - 86400, card_id: "c4", grade: "good", remembered: true },
      { t: NOW - 3600, card_id: "c1", grade: "good", remembered: true },
    ],
    quizzes: [{ id: "q1", deck_id: "d1", title: "Biology quiz", t: NOW - 86400, total: 4, correct: 3, wrong: [] }],
    sessions: [{ id: "s1", deck_id: "d1", started: NOW - 86400, ended: NOW - 86400 + 240, cards: 3, remembered: 2, quiz_total: 0, quiz_correct: 0 }],
  };

  const handlers = {
    // Lets the update panel be seen in a dev shot. Without this the panel could
    // only be reviewed after shipping, which is how it reached users as one
    // unreadable wall of Markdown.
    //
    // The body is injected by the dev server from scripts/release-notes.js
    // --short, i.e. the exact text that goes into latest.json.
    "plugin:updater|check": () => {
      const notes = String(window.__DEV_UPDATE_NOTES__ || "");
      const cur = String(window.__DEV_UPDATE_VERSION__ || "0.0.1");
      // The current version, with its own notes. Offering a different number
      // alongside these notes made the panel read "0.2.8 is available" above
      // notes for 0.2.9, which is nonsense to anyone reviewing it.
      return {
        version: cur,
        body: notes,
        current_version: cur,
        date: new Date().toISOString(),
      };
    },
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
    // A real scan answers with a report, not a bare list, so the mock has to
    // match that shape or the source panel would never be exercised in dev.
    atlas_scan: () => ({
      started: 1758100000,
      ms: 47,
      games: GAMES_SHAPED,
      sources: [
        { id: "steam", name: "Steam", group: "launcher", enabled: true, status: "ok", found: GAMES.filter((g) => g.launcher === "Steam").length, ms: 41, detail: "" },
        { id: "standalone", name: "Manual", group: "standalone", enabled: true, status: "ok", found: GAMES.filter((g) => g.launcher !== "Steam").length, ms: 1, detail: "" },
      ],
        not_supported: ["Ubisoft Connect", "Battle.net", "Riot Client", "Amazon Games"],
    }),
    atlas_source_list: () => [],
    atlas_set_source: () => null,
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
      id: nid(path),
      title: ntitle(path, n),
      path, folder: path.includes("/") ? path.split("/")[0] : "",
      pinned: !!n.pinned, created: n.created, modified: n.updated, size: n.body.length,
      excerpt: n.body.slice(0, 280), tags: n.tags, links: [], backlinks: [],
    })),
    aery_read: (a) => {
      for (const [path, n] of Object.entries(NOTES)) {
        // Must accept the same id aery_list just produced. It used to match only
        // the bare base64 or the raw path, and aery_list emits neither - so every
        // read failed and the page raised an error toast on load.
        const want = String((a && a.id) || "");
        if (nid(path) === want || path === want) {
          const title = ntitle(path, n);
          const byTitle = new Map(Object.entries(NOTES).map(([p, o]) => [ntitle(p, o).toLowerCase(), p]));
          const note = {
            id: a.id, title, path, folder: path.includes("/") ? path.split("/")[0] : "",
            pinned: !!n.pinned, modified: n.updated, created: n.created,
            size: n.body.length, tags: n.tags, links: [], backlinks: [],
          };
          // The real command returns this shape, and the context panel reads it.
          // A mock that omits it hid an empty title bar and empty link panels.
          const outgoing = nlinks(n.body).map((t) => {
            const target = byTitle.get(t.toLowerCase());
            return { title: t, resolved: target ? nid(target) : null, path: target || null };
          });
          const backlinks = Object.entries(NOTES)
            .filter(([p2, o]) => p2 !== path && nlinks(o.body).some((t) => t.toLowerCase() === title.toLowerCase()))
            .map(([p2, o]) => ({
              id: nid(p2), title: ntitle(p2, o), path: p2,
              folder: p2.includes("/") ? p2.split("/")[0] : "",
            }));
          return {
            note, content: n.body, tags: n.tags, outgoing, backlinks,
            word_count: n.body.split(/\s+/).length,
          };
        }
      }
      throw new Error("That note is not in the vault.");
    },
    aery_vault_path: () => "C:\\mock\\vault (does not exist)",
    aery_counts: () => ({ notes: Object.keys(NOTES).length, tags: ["mock"], folders: ["work", "archive/2025"] }),
    aery_save: () => null, aery_create: () => null, aery_rename: () => null,
    aery_delete: () => null, aery_restore: () => null,
    aery_set_pinned: () => null, aery_set_folder: () => null, aery_mkdir: (a) => String((a && a.path) || ""),
    aery_rename_folder: (a) => String((a && a.to) || ""),
    aery_delete_folder: () => ({ deleted: true, moved: 0, notes: 0 }),
    aery_export_note: () => null,
    aery_export_vault: () => ({ copied: 0, skipped: 0, dest: "C:\\mock\\export" }),
    aery_import: () => ({ imported: 0, renamed: 0, skipped: 0, unresolved_links: 0, errors: [] }),

    // --- Study ------------------------------------------------------------
    study_load: () => STUDY,
    study_deck_save: (a) => {
      const deck = (a && a.deck) || {};
      const hit = STUDY.decks.find((d) => d.id === deck.id);
      if (hit) { hit.name = deck.name; hit.subject = deck.subject || ""; hit.updated = NOW; }
      else if (deck.name) STUDY.decks.push({ id: "d" + (++SID), name: deck.name, subject: deck.subject || "", created: NOW, updated: NOW });
      return STUDY;
    },
    study_deck_delete: (a) => {
      const id = (a && a.id) || "";
      STUDY.decks = STUDY.decks.filter((d) => d.id !== id);
      STUDY.cards = STUDY.cards.filter((c) => c.deck_id !== id);
      return STUDY;
    },
    study_card_save: (a) => {
      const card = (a && a.card) || {};
      const hit = STUDY.cards.find((c) => c.id === card.id);
      if (hit) { hit.question = card.question; hit.answer = card.answer; hit.source_note_id = card.source_note_id || ""; }
      else if (card.question && card.answer) {
        STUDY.cards.push({
          id: "c" + (++SID), deck_id: card.deck_id, question: card.question, answer: card.answer,
          source_note_id: card.source_note_id || "", created: NOW, updated: NOW,
          ease: 2.5, interval_days: 0, reps: 0, lapses: 0, due: NOW - 60, last_review: 0,
        });
      }
      return STUDY;
    },
    study_card_delete: (a) => {
      STUDY.cards = STUDY.cards.filter((c) => c.id !== ((a && a.id) || ""));
      return STUDY;
    },
    study_review: (a) => {
      const card = STUDY.cards.find((c) => c.id === ((a && a.id) || ""));
      if (card) {
        const remembered = String((a && a.grade) || "") !== "again";
        card.last_review = NOW;
        card.reps = remembered ? card.reps + 1 : 0;
        card.interval_days = remembered ? (card.interval_days || 1) * 2 : 0;
        card.due = NOW + card.interval_days * 86400;
        STUDY.reviews.push({ t: NOW, card_id: card.id, grade: (a && a.grade) || "good", remembered });
      }
      const sess = STUDY.sessions.find((s) => s.ended === 0);
      if (sess) sess.cards++;
      return STUDY;
    },
    study_quiz_save: (a) => {
      const q = (a && a.quiz) || {};
      STUDY.quizzes.push({ ...q, id: "q" + (++SID), t: NOW });
      const sess = STUDY.sessions.find((s) => s.ended === 0);
      if (sess) { sess.quiz_total = q.total || 0; sess.quiz_correct = q.correct || 0; sess.ended = NOW; }
      return STUDY;
    },
    study_session_start: (a) => {
      for (const s of STUDY.sessions) if (!s.ended) s.ended = NOW;
      STUDY.sessions.push({ id: "s" + (++SID), deck_id: (a && a.deck) || "", started: NOW, ended: 0, cards: 0, remembered: 0, quiz_total: 0, quiz_correct: 0 });
      return STUDY;
    },
    study_session_end: (a) => {
      const s = STUDY.sessions.find((x) => x.id === ((a && a.id) || ""));
      if (s) s.ended = NOW;
      return STUDY;
    },
    aery_graph: () => {
      const nodes = Object.entries(NOTES).map(([path, n]) => ({
        id: nid(path), title: ntitle(path, n),
        folder: path.includes("/") ? path.split("/")[0] : "", pinned: !!n.pinned,
      }));
      const byTitle = new Map(nodes.map((n) => [n.title.toLowerCase(), n.id]));
      const edges = [];
      for (const [path, n] of Object.entries(NOTES)) {
        for (const t of nlinks(n.body)) {
          const to = byTitle.get(t.toLowerCase());
          if (to && to !== nid(path)) edges.push({ from: nid(path), to });
        }
      }
      return { nodes, edges };
    },

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

  // If a real Tauri runtime is already here, stand down. `withGlobalTauri`
  // installs window.__TAURI__ before page scripts run, so when `npm run dev:app`
  // loads the page from the dev server this is the real object and must not be
  // overwritten - otherwise the dev test app silently stops exercising real IPC
  // and reports mock data as if it were hardware.
  if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function") {
    window.__STRYV_MOCK_STOOD_DOWN__ = true;
    window.addEventListener("DOMContentLoaded", () => {
      const b = document.createElement("div");
      b.textContent = "REAL TAURI - not mocked";
      b.style.cssText = "position:fixed;left:50%;top:0;transform:translateX(-50%);z-index:99999;" +
        "background:#166534;color:#fff;font:600 11px/1 ui-monospace,monospace;letter-spacing:.14em;" +
        "padding:6px 14px;border-radius:0 0 6px 6px;pointer-events:none";
      document.body.appendChild(b);
    });
    return;
  }

  // If a real Tauri runtime is already here, stand down. `withGlobalTauri`
  // installs window.__TAURI__ before page scripts run, so when `npm run dev:app`
  // loads the page from the dev server this is the real object and must not be
  // overwritten - otherwise the dev test app silently stops exercising real IPC
  // and reports mock data as if it were hardware.
  if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function") {
    window.__STRYV_MOCK_STOOD_DOWN__ = true;
    window.addEventListener("DOMContentLoaded", () => {
      const b = document.createElement("div");
      b.textContent = "REAL TAURI - not mocked";
      b.style.cssText = "position:fixed;left:50%;top:0;transform:translateX(-50%);z-index:99999;" +
        "background:#166534;color:#fff;font:600 11px/1 ui-monospace,monospace;letter-spacing:.14em;" +
        "padding:6px 14px;border-radius:0 0 6px 6px;pointer-events:none";
      document.body.appendChild(b);
    });
    return;
  }

  // If a real Tauri runtime is already here, stand down. `withGlobalTauri`
  // installs window.__TAURI__ before page scripts run, so when `npm run dev:app`
  // loads the page from the dev server this is the real object and must not be
  // overwritten - otherwise the dev test app silently stops exercising real IPC
  // and reports mock data as if it were hardware.
  if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function") {
    window.__STRYV_MOCK_STOOD_DOWN__ = true;
    window.addEventListener("DOMContentLoaded", () => {
      const b = document.createElement("div");
      b.textContent = "REAL TAURI - not mocked";
      b.style.cssText = "position:fixed;left:50%;top:0;transform:translateX(-50%);z-index:99999;" +
        "background:#166534;color:#fff;font:600 11px/1 ui-monospace,monospace;letter-spacing:.14em;" +
        "padding:6px 14px;border-radius:0 0 6px 6px;pointer-events:none";
      document.body.appendChild(b);
    });
    return;
  }

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
