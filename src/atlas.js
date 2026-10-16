"use strict";
// ATLAS - the game library: discovery, launching, favourites and sessions.
//
// Discovery is read-only. It reads the files the launcher has already written and
// never writes back to them. What the user adds, hides or favourites lives in
// ATLAS's own store beside the app data.
//
// Cover art is the only outbound request this page makes. Steam library headers
// come from Valve's public CDN, keyed on the numeric app id. A game added by hand
// has no app id, so it gets a plain placeholder rather than a request that cannot
// succeed.
const Atlas = (() => {
  const NO_BACKEND = "The STRYV backend is not connected.";
  const SORTS = ["recent", "lastLaunch", "name", "plays", "size"];

  // --- guarded access to the globals core.js provides ------------------------
  // This file also runs inside a bare vm sandbox in the tests, so nothing here
  // may assume a helper, an element or the backend actually exists.
  const E = (id) => { try { return typeof q === "function" ? q(id) : null; } catch { return null; } };
  const txt = (id, v) => { const e = E(id); if (e) { try { e.textContent = v; } catch { /* detached */ } } };
  const html = (id, v) => { const e = E(id); if (e) { try { e.innerHTML = v; } catch { /* detached */ } } };
  // Use core.js's escaper when the page has provided it, but never fall back to a
// no-op: a launcher manifest is untrusted input, so name, app id, install path
// and cover url all have to be escaped before they reach innerHTML.
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escF = (s) => (typeof esc === "function" ? esc(s) : String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]));
  const T = typeof toast === "function" ? toast : () => {};
  const ST = (typeof store === "object" && store) ? store : { get: (_k, d) => d, set: () => false };
  const A = (typeof Act === "object" && Act) ? Act : { log: () => null, update: () => {} };
  const TG = (typeof Tech === "object" && Tech) ? Tech : { add: () => {} };
  const ASK = typeof confirmBox === "function" ? confirmBox : async () => false;
  const mk = (cls, text) => { if (typeof document === "undefined") return null; const d = document.createElement("div"); d.className = cls; d.textContent = text; return d; };

  function call(cmd, args) {
    try {
      // invoke is a top-level const in app.js, which loads after this file, so
      // it is only ever safe to touch from inside a function.
      if (typeof invoke !== "function") return Promise.reject(new Error(NO_BACKEND));
      return Promise.resolve(invoke(cmd, args));
    } catch (e) { return Promise.reject(e); }
  }
  const hasBackend = () => { try { return typeof invoke === "function"; } catch { return false; } };

  // --- formatting -----------------------------------------------------------
  const bytes = (b) => {
    const n = Number(b) || 0;
    if (n <= 0) return "—";                       // honest: 0 means "not reported"
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + " GB";
    return Math.max(1, Math.round(n / 1048576)) + " MB";
  };
  const dur = (s) => {
    if (s === null || s === undefined) return "not measured";
    const n = Number(s);
    if (!isFinite(n) || n <= 0) return "under a minute";
    if (n < 60) return Math.round(n) + "s";
    const m = Math.floor(n / 60);
    return m < 60 ? m + "m" : Math.floor(m / 60) + "h " + (m % 60) + "m";
  };
  const when = (s) => {
    if (!s) return "Never";
    const d = new Date(Number(s) * 1000);
    if (isNaN(d.getTime()) || d.getFullYear() < 2000) return "Never";
    return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  };
  const stamp = (s) => {
    if (!s) return "unknown time";
    const d = new Date(Number(s) * 1000);
    if (isNaN(d.getTime())) return "unknown time";
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  // Only Steam entries can produce a URL worth fetching, and only a bare decimal
  // app id is ever allowed near the address bar.
  const numeric = (s) => /^\d{1,12}$/.test(String(s || ""));
  const cover = (g) => (g.launcher === "Steam" && numeric(g.app_id)
    ? "https://cdn.cloudflare.steamstatic.com/steam/apps/" + g.app_id + "/header.jpg" : "");
  const playWhy = (g) => {
    if (g.launcher === "Steam") return numeric(g.app_id) ? "" : "Steam has no app id for this entry, so it cannot be launched.";
    if (String(g.exe_path || "").trim()) return "";
    return "No executable is recorded, so it cannot be launched.";
  };
  const canPlay = (g) => !!g && !!(g.id || "").trim() && !playWhy(g);

  // --- state ----------------------------------------------------------------
  let games = [], sessions = [], state = "idle"; // idle | loading | nobackend | failed | ready
  let lastError = "", busy = false, launching = false;

  const term = () => { const e = E("atlasQ"); return e ? String(e.value || "").trim().toLowerCase() : ST.get("atlas.q", ""); };
  const sortKey = () => { const s = ST.get("atlas.sort", "recent"); return SORTS.includes(s) ? s : "recent"; };

  const matches = (g, t) => !t || [g.name, g.launcher, g.install_dir].filter(Boolean).join(" ").toLowerCase().includes(t);
  function view() {
    const t = term(), k = sortKey();
    const list = games.filter((g) => matches(g, t));
    const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));
    const cmp = (a, b) => {
      if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;   // favourites always float
      switch (k) {
        case "name": return byName(a, b) || (b.last_played || 0) - (a.last_played || 0);
        case "plays": return (b.plays || 0) - (a.plays || 0) || byName(a, b);
        case "size": return (b.size_bytes || 0) - (a.size_bytes || 0) || byName(a, b);
        case "lastLaunch": return (b.last_launch || 0) - (a.last_launch || 0) || byName(a, b);
        default: return (b.last_played || 0) - (a.last_played || 0) || byName(a, b);
      }
    };
    return list.sort(cmp);
  }

  // --- cover art ------------------------------------------------------------
  function art(g) {
    const url = cover(g);
    if (!url) return `<div class="at-covf">${g.launcher === "Manual" ? "No cover art" : "Not a Steam entry"}</div>`;
    // alt is empty on purpose: the name is already on the card, so a screen
    // reader must not read the title twice.
    return `<img class="at-cov" src="${escF(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-cover="1">`;
  }
  function degrade(img) {
    // A missing header must never leave a broken-image icon behind.
    const box = mk("at-covf", "No cover art");
    if (box && img.parentNode) img.parentNode.replaceChild(box, img);
    else if (img.parentNode) img.style.display = "none";
  }

  function card(g, i) {
    const why = playWhy(g), ok = canPlay(g);
    const plays = Number(g.plays) || 0;
    return `<article class="at-card">
<div class="at-covw">${art(g)}</div>
<div class="at-cbody">
<div class="at-ch"><h4>${escF(g.name || "Unnamed entry")}</h4><span class="at-badge at-${/steam/i.test(g.launcher) ? "steam" : "manual"}">${escF(g.launcher || "Unknown")}</span></div>
<dl class="at-meta">
${g.app_id ? `<div><dt>App id</dt><dd>${escF(g.app_id)}</dd></div>` : ""}
<div><dt>Size</dt><dd>${bytes(g.size_bytes)}</dd></div>
<div><dt>Last played</dt><dd>${when(g.last_played)}</dd></div>
<div><dt>Launches</dt><dd>${plays ? plays + (plays === 1 ? " launch" : " launches") : "None from ATLAS"}</dd></div>
<div><dt>Last session</dt><dd>${dur(g.last_session_secs === undefined ? null : g.last_session_secs)}</dd></div>
</dl>
${g.install_dir ? `<small class="at-path" title="${escF(g.install_dir)}">${escF(g.install_dir)}</small>` : ""}
<div class="at-cbtns">
<button class="btn" data-play="${i}"${ok ? "" : " disabled"}>Play</button>
<button class="btn ghost at-fav" data-fav="${i}" aria-pressed="${g.favorite ? "true" : "false"}" title="${g.favorite ? "Remove from favourites" : "Add to favourites"}">${g.favorite ? "★" : "☆"}</button>
<button class="lnk at-del" data-del="${i}">Remove</button>
</div>
${ok ? "" : `<small class="at-why">${escF(why)}</small>`}
</div></article>`;
  }

  // --- rendering ------------------------------------------------------------
  function renderGrid(list) {
    const grid = E("atlasGrid");
    if (!grid) return;
    try { grid.innerHTML = list.map(card).join(""); } catch { return; }

    const each = (sel, fn) => { try { grid.querySelectorAll(sel).forEach(fn); } catch { /* detached */ } };
    each("[data-cover]", (img) => { img.onerror = () => degrade(img); });
    each("[data-play]", (b) => { b.onclick = () => { const g = list[+b.dataset.play]; if (g) launch(g, b); }; });
    each("[data-fav]", (b) => { b.onclick = () => { const g = list[+b.dataset.fav]; if (g) favorite(g, b); }; });
    each("[data-del]", (b) => { b.onclick = () => { const g = list[+b.dataset.del]; if (g) remove(g); }; });
  }

  function renderStats(list) {
    const n = list.length;
    const launchers = [...new Set(games.map((g) => g.launcher).filter(Boolean))];
    const t = term();

    txt("atlasN", state === "nobackend" ? "—" : state === "failed" ? "—" : n ? n + (n === 1 ? " game" : " games") : "None found");
    let sum;
    if (state === "nobackend") sum = "ATLAS needs the STRYV backend to read the library.";
    else if (state === "failed") sum = "The library could not be read.";
    else if (state === "loading") sum = "Reading launcher files.";
    else if (!n) sum = "No launcher library files were found on this PC. Add a game by hand if something is missing.";
    else {
      sum = "Found via " + launchers.join(", ") + ".";
      if (t) sum += " " + n + " of " + games.length + " shown for “" + t + "”.";
    }
    txt("atlasSum", sum);

    const total = games.reduce((a, g) => a + (Number(g.size_bytes) || 0), 0);
    const plays = games.reduce((a, g) => a + (Number(g.plays) || 0), 0);
    const secs = games.reduce((a, g) => a + (Number(g.total_secs) || 0), 0);
    txt("atlasSize", state === "ready" || state === "failed" ? bytes(total) : "—");
    txt("atlasPlays", plays ? plays.toLocaleString() : "0");
    txt("atlasTime", secs ? dur(secs) : "Not measured");
  }

  function renderEmpty(list) {
    const e = E("atlasEmpty");
    if (!e) return;
    const t = term();
    let msg = "";
    if (state === "nobackend") msg = "<b>Backend not connected.</b><br>ATLAS reads the library through the STRYV backend. This window has no connection to it, so nothing can be discovered here.";
    else if (state === "failed") msg = "<b>Could not read the library.</b><br>" + escF(lastError);
    else if (state === "loading") msg = "Reading launcher files…";
    else if (state === "ready" && !games.length) msg = "<b>No games found.</b><br>No launcher library files were found on this PC. If a game is installed, add it by hand with Add game.";
    else if (state === "ready" && !list.length) msg = "<b>Nothing matches “" + escF(t) + "”.</b><br>" + games.length + (games.length === 1 ? " game is" : " games are") + " in the library. Clear the search to see " + (games.length === 1 ? "it" : "them") + ".";
    try { e.innerHTML = msg; e.hidden = !msg; } catch { /* detached */ }
  }

  function renderRestore() {
    const b = E("atlasRestore");
    if (!b) return;
    // The backend filters hidden games out of atlas_scan and exposes no "is
    // anything hidden" command, so this is tracked locally from the user's own
    // removals and persisted alongside the rest of ATLAS's UI state.
    const gone = !!ST.get("atlas.removed", false);
    try { b.hidden = !gone; } catch { /* detached */ }
  }

  function renderSessions() {
    const box = E("atlasSess");
    if (!box) return;
    const rows = sessions.slice().sort((a, b) => (Number(b.started) || 0) - (Number(a.started) || 0));
    let out;
    if (state === "nobackend") out = '<p class="empty">Sessions are read from the STRYV backend, which is not connected in this window.</p>';
    else if (!rows.length) out = '<p class="empty">No sessions recorded yet. Sessions appear here after you launch a game from ATLAS.</p>';
    else {
      out = rows.map((s) => {
        const measured = !!s.measured && s.duration_secs !== null && s.duration_secs !== undefined;
        return `<div class="at-srow">
<i class="st ${measured ? "done" : "running"}"></i>
<div><b>${escF(s.name || "Unknown game")}</b><small>${escF(s.launcher || "Unknown")} · ${stamp(s.started)} · ${escF(dur(s.duration_secs))}</small></div>
<small class="at-sx">${measured ? escF(bytes(s.mem_bytes)) + " peak" : "duration not measured"}</small>
</div>`;
      }).join("");
    }
    try { box.innerHTML = out; } catch { /* detached */ }
  }

  function render() {
    const list = state === "ready" ? view() : [];
    renderGrid(list);
    renderStats(list);
    renderEmpty(list);
    renderSessions();
    renderRestore();
  }

  // --- actions --------------------------------------------------------------
  // `manual` is a scan the user asked for, so it reports itself. A refresh that
  // happens in the background (after a launch, a remove, a restore) stays quiet:
  // it must not blank a grid the user is already looking at, and it must not
  // throw away a good library because one background read failed.
  async function scan(manual) {
    if (busy) return;
    const hadData = state === "ready";
    if (!hasBackend()) {
      if (hadData) return;
      state = "nobackend"; games = []; sessions = []; render();
      if (manual) T("ATLAS needs the STRYV backend, which is not connected in this window.");
      return;
    }
    busy = true;
    const btn = E("atlasScan");
    if (btn) { btn.disabled = true; if (manual) btn.textContent = "Rescanning…"; }
    if (!hadData) { state = "loading"; render(); }
    try {
      games = await call("atlas_scan") || [];
      if (!Array.isArray(games)) games = [];
      state = "ready"; lastError = "";
      render();
      // Sessions are read separately and never block the library itself.
      call("atlas_sessions").then((s) => { sessions = Array.isArray(s) ? s : []; renderSessions(); })
        .catch((e) => { TG.add("atlas.sessions", e); if (!sessions.length) { sessions = []; renderSessions(); } });
      if (manual) { T("Library rescanned"); A.log({ text: "ATLAS library rescan", detail: JSON.stringify({ found: games.length }) }); }
    } catch (e) {
      TG.add("atlas.scan", e);
      const m = e && e.message ? e.message : String(e);
      if (hadData) { T("Could not refresh the library: " + m, true); return; }
      state = "failed"; lastError = m;
      games = []; sessions = [];
      render();
      if (manual) T("Could not read the library: " + lastError, true);
    } finally {
      busy = false;
      if (btn) { btn.disabled = false; btn.textContent = "Rescan"; }
    }
  }

  // Sends only the library id. The backend resolves the executable itself from
  // its own store, so a path can never arrive from this window.
  async function launch(g, btn) {
    if (!g || launching) return;
    if (!canPlay(g)) { T(playWhy(g) || "That game cannot be launched.", true); return; }
    launching = true;
    if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }
    const aid = A.log({ text: "Launching from ATLAS: " + (g.name || "a game"), status: "running" });
    try {
      const msg = await call("atlas_launch_id", { id: g.id });
      const m = String(msg == null ? "Launch requested." : msg);
      A.update(aid, { status: "done", detail: m });
      T(m);
      call("atlas_sessions").then((s) => { sessions = Array.isArray(s) ? s : []; renderSessions(); }).catch(() => {});
      scan(false);
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      A.update(aid, { status: "failed", detail: m });
      TG.add("atlas.launch", e);
      T("Could not launch: " + m, true);
    } finally {
      launching = false;
      if (btn) { btn.disabled = false; btn.textContent = "Play"; }
    }
  }

  async function favorite(g, btn) {
    const want = !g.favorite;
    g.favorite = want;                                    // optimistic
    if (btn) { btn.textContent = want ? "★" : "☆"; btn.setAttribute("aria-pressed", want ? "true" : "false"); btn.title = want ? "Remove from favourites" : "Add to favourites"; }
    try {
      await call("atlas_set_favorite", { id: g.id, favorite: want });
    } catch (e) {
      g.favorite = !want;                                  // put it back
      if (btn) { btn.textContent = g.favorite ? "★" : "☆"; btn.setAttribute("aria-pressed", g.favorite ? "true" : "false"); }
      TG.add("atlas.favorite", e);
      T("Could not save the favourite: " + (e && e.message ? e.message : String(e)), true);
    }
    render();
  }

  async function remove(g) {
    const name = g.name || "That game";
    const body = g.launcher === "Manual"
      ? name + " will be taken out of your ATLAS library. You can restore it with Restore removed games."
      : name + " will be hidden from your ATLAS library. Nothing in the Steam install is deleted, and you can bring it back with Restore removed games.";
    if (!(await ASK({ title: "Remove from ATLAS?", body, yes: "Remove", danger: true }))) return;
    try {
      // forget stays false: removal must be reversible while the entry is only
      // hidden. atlas_restore clears the hidden list.
      await call("atlas_remove", { id: g.id, forget: false });
      ST.set("atlas.removed", true);
      A.log({ text: "Removed from ATLAS: " + name });
      T("Removed " + name);
      await scan(false);
    } catch (e) {
      TG.add("atlas.remove", e);
      T("Could not remove it: " + (e && e.message ? e.message : String(e)), true);
    }
  }

  async function restore() {
    if (!(await ASK({ title: "Restore removed games?", body: "Every game hidden from ATLAS comes back into the library. Nothing is reinstalled or re-downloaded.", yes: "Restore" }))) return;
    try {
      await call("atlas_restore");
      ST.set("atlas.removed", false);
      A.log({ text: "Restored removed ATLAS games" });
      T("Removed games restored");
      await scan(false);
    } catch (e) {
      TG.add("atlas.restore", e);
      T("Could not restore: " + (e && e.message ? e.message : String(e)), true);
    }
  }

  async function clearSessions() {
    if (!sessions.length) { T("There are no sessions to clear."); return; }
    if (!(await ASK({ title: "Clear session history?", body: "The " + sessions.length + " recorded session" + (sessions.length === 1 ? "" : "s") + " are deleted. Games stay in your library; only the measured play time is lost.", yes: "Clear", danger: true }))) return;
    try {
      await call("atlas_clear_sessions");
      sessions = [];
      A.log({ text: "Cleared ATLAS session history" });
      T("Sessions cleared");
      render();
    } catch (e) {
      TG.add("atlas.clear_sessions", e);
      T("Could not clear sessions: " + (e && e.message ? e.message : String(e)), true);
    }
  }

  async function addManual() {
    const exeEl = E("atlasExe"), nameEl = E("atlasName");
    const exe = exeEl ? String(exeEl.value || "").trim() : "";
    const name = nameEl ? String(nameEl.value || "").trim() : "";
    if (!exe) { T("Choose the game's .exe file first.", true); if (exeEl) exeEl.focus(); return; }
    const btn = E("atlasAddGo");
    if (btn) btn.disabled = true;
    const aid = A.log({ text: "Adding a game to ATLAS", status: "running" });
    try {
      // name may be null: the backend then falls back to the file's own name.
      const g = await call("atlas_add_manual", { name: name || null, exe_path: exe });
      A.update(aid, { status: "done", detail: (g && g.name) || exe });
      T("Added " + ((g && g.name) || name || "game"));
      if (exeEl) exeEl.value = "";
      if (nameEl) nameEl.value = "";
      closeAdd();
      await scan(false);
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      A.update(aid, { status: "failed", detail: m });
      TG.add("atlas.add_manual", e);
      T(m, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function openAdd() {
    const box = E("atlasAddBox");
    if (!box) return;
    try { box.hidden = false; } catch { /* detached */ }
    const exe = E("atlasExe");
    if (exe && typeof exe.focus === "function") exe.focus();
  }
  function closeAdd() {
    const box = E("atlasAddBox");
    if (box) { try { box.hidden = true; } catch { /* detached */ } }
  }

  // --- wiring ---------------------------------------------------------------
  const on = (id, ev, fn) => { const e = E(id); if (e) { try { e.addEventListener(ev, fn); } catch { e["on" + ev] = fn; } } };
  const onClick = (id, fn) => { const e = E(id); if (e) e.onclick = fn; };

  onClick("atlasScan", () => scan(true));
  onClick("atlasRestore", restore);
  onClick("atlasSessClr", clearSessions);
  onClick("atlasAdd", openAdd);
  onClick("atlasAddNo", closeAdd);
  onClick("atlasAddGo", addManual);

  on("atlasQ", "input", () => { ST.set("atlas.q", E("atlasQ") ? E("atlasQ").value : ""); render(); });
  on("atlasSort", "change", () => { const s = E("atlasSort"); ST.set("atlas.sort", s ? s.value : "recent"); render(); });
  // Enter submits from either field.
  ["atlasExe", "atlasName"].forEach((id) => on(id, "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addManual(); } }));

  // Restore the persisted search and sort into the controls.
  (function init() {
    const qi = E("atlasQ");
    if (qi) { const saved = String(ST.get("atlas.q", "") || ""); if (saved) qi.value = saved; }
    const so = E("atlasSort");
    if (so) { const k = sortKey(); try { so.value = k; } catch { /* detached */ } }
    renderRestore();
  })();

  return { scan, launch };
})();