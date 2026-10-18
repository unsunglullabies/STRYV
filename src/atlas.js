"use strict";
// ATLAS - the game library.
//
// Discovery is read-only: it reads the files the launchers have already written
// and never writes back to them. Launching is a separate, explicit action.
// Nothing here invents a figure. A duration that was never measured is rendered
// as "not measured", and an install size the launcher did not report is a dash.
const Atlas = (() => {
  // ---- shared helpers, all guarded so this runs even with no page around it ----
  const E = (id) => { try { return typeof q === "function" ? q(id) : null; } catch { return null; } };
  const txt = (id, v) => { const e = E(id); if (e) { try { e.textContent = v; } catch { /* detached */ } } };
  const html = (id, v) => { const e = E(id); if (e) { try { e.innerHTML = v; } catch { /* detached */ } } };
  const show = (id, on) => { const e = E(id); if (e) { try { e.hidden = !on; } catch { /* detached */ } } };

  // core.js normally provides esc. Fall back to a local escaper rather than to
  // String(): launcher manifests are untrusted input.
  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escF = (s) => (typeof esc === "function" ? esc(s) : String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]));

  const T = typeof toast === "function" ? toast : () => {};
  const ST = (typeof store === "object" && store) ? store : { get: (_k, d) => d, set: () => false };
  const A = (typeof Act === "object" && Act) ? Act : { log: () => null, update: () => {} };
  const TG = (typeof Tech === "object" && Tech) ? Tech : { add: () => {} };
  const ASK = typeof confirmBox === "function" ? confirmBox : async () => false;
  const mk = (cls, text) => { if (typeof document === "undefined" || typeof document.createElement !== "function") return null; const d = document.createElement("div"); d.className = cls; d.textContent = text; return d; };

  const stop = (ev) => { if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation(); };
const hasBackend = () => typeof invoke === "function";
  const call = (cmd, args) => {
    if (!hasBackend()) return Promise.reject(new Error("STRYV is not connected to its backend."));
    try { return Promise.resolve(invoke(cmd, args)); } catch (e) { return Promise.reject(e); }
  };

  // ---- formatting -------------------------------------------------------------
  const mb = (b) => {
    if (!b) return "—";
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + " GB";
    if (b >= 1048576) return Math.round(b / 1048576) + " MB";
    return Math.max(1, Math.round(b / 1024)) + " KB";
  };
  const dur = (s) => {
    if (s === null || s === undefined) return "Not measured";
    const n = Number(s);
    if (!isFinite(n) || n < 60) return n > 0 ? Math.max(1, Math.round(n)) + "s" : "—";
    const m = Math.floor(n / 60);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
  };
  const day = (unix) => {
    if (!unix) return "Never";
    const d = new Date(unix * 1000);
    if (isNaN(d.getTime()) || d.getFullYear() < 2000) return "Never";
    return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  };
  const when = (unix) => {
    if (!unix) return "Never";
    const d = new Date(unix * 1000);
    if (isNaN(d.getTime())) return "Never";
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  // ---- state ------------------------------------------------------------------
  let games = [], sessions = [], busy = false, launching = false;
  let editingId = null, detailId = null;
  // Set when a scan fails, so the page can say why instead of showing an empty library.
  let scanError = null;
  // The last scan's per-source report, so the page can say what was read and
  // what could not be. Null when the backend answered with a bare list.
  let sourceReport = null;
  // Single source of truth for the toolbar, so the page and the code cannot drift.
  const SORTS = ["recent", "lastLaunch", "name", "plays", "size"];
  const filters = { favOnly: false, missingOnly: false, kind: "", source: "" };
  // One store-API lookup per app id, for the life of the session. A grid of forty
  // games must not make forty requests, and a miss must never be retried.
  const artCache = new Map();
  const ART_PENDING = "…";

  // ---- artwork ----------------------------------------------------------------
  // Priority: the user's own image, then Valve's legacy CDN (fast, no API), then
  // the store API for titles the legacy path does not carry, then a placeholder.
  // Both remote requests go to Valve.
  const digits = (v) => typeof v === "string" && /^\d{1,12}$/.test(v);
  const localSrc = (p) => {
    if (typeof window !== "undefined" && typeof window.__TAURI__ === "object" && window.__TAURI__ && typeof window.__TAURI__.path === "object") {
      try { return window.__TAURI__.path.convertFileSrc(p, "asset"); } catch { /* fall through */ }
    }
    return null;
  };

  function storeArt(id) {
    if (!digits(id)) return Promise.resolve(null);
    if (artCache.has(id)) return Promise.resolve(artCache.get(id));
    if (typeof fetch !== "function") return Promise.resolve(null);
    const url = "https://store.steampowered.com/api/appdetails?appids=" + encodeURIComponent(id);
    return fetch(url, { credentials: "omit" })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((j) => {
        const d = j && j[id] && j[id].success ? j[id].data : null;
        const img = d && d.header_image ? d.header_image : null;
        artCache.set(id, img);
        return img;
      })
      .catch(() => { artCache.set(id, null); return null; });
  }

  // Returns the markup for one artwork slot.
  function art(g, cls) {
    const frame = cls || "at-covw";
    if (g.art_path) {
      const src = localSrc(g.art_path);
      if (src) return `<div class="${frame}"><img class="at-cov" src="${escF(src)}" alt="" loading="lazy" decoding="async" data-cover="1" data-local="1"></div>`;
    }
    if (/steam/i.test(g.launcher) && digits(g.app_id)) {
      const url = "https://cdn.cloudflare.steamstatic.com/steam/apps/" + g.app_id + "/header.jpg";
      return `<div class="${frame}"><img class="at-cov" src="${escF(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-cover="1" data-cdn="1"></div>`;
    }
    return `<div class="${frame}"><div class="at-covf">No cover art</div></div>`;
  }

  // Valve's legacy path 404s on newer titles. Ask the store once, then let the
  // placeholder take over if that fails too.
  function wireArt(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll("[data-cover]").forEach((img) => {
      const done = () => {
        const slot = img.parentElement || img.parentNode;
        const ph = mk("at-covf", "No cover art");
        if (ph && slot && typeof slot.replaceChild === "function") slot.replaceChild(ph, img);
        else if (slot && ph && typeof slot.appendChild === "function") { slot.appendChild(ph); }
        else if (img.style) img.style.display = "none";
      };
      img.onerror = () => {
        const id = img.getAttribute("data-cdn") ? img.getAttribute("src").match(/apps\/(\d+)\//) : null;
        const appId = id ? id[1] : null;
        if (!appId || artCache.get(appId) !== ART_PENDING) { if (!appId) return done(); }
        if (!appId) return done();
        if (artCache.get(appId)) { img.src = artCache.get(appId); return; }
        artCache.set(appId, ART_PENDING);
        storeArt(appId).then((real) => {
          if (real && real !== ART_PENDING) img.src = real; else done();
        });
      };
    });
  }

  // ---- filtering and sorting ---------------------------------------------------
  const visible = () => {
    const qtext = (E("atlasQ") && E("atlasQ").value || "").trim().toLowerCase();
    return games.filter((g) => {
      if (filters.favOnly && !g.favorite) return false;
      if (filters.missingOnly && g.available !== false) return false;
      if (filters.kind && String(g.kind || "game") !== filters.kind) return false;
      if (filters.source && !(Array.isArray(g.sources) && g.sources.includes(filters.source))) return false;
      if (!qtext) return true;
      return [g.name, g.launcher, g.install_dir, g.exe_path].some((v) => String(v || "").toLowerCase().includes(qtext));
    });
  };

  function sorted(list) {
    const key = (E("atlasSort") && E("atlasSort").value) || "recent";
    const out = list.slice();
    out.sort((a, b) => {
      if (!!b.favorite !== !!a.favorite) return b.favorite ? 1 : -1;
      if (key === "name") return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      if (key === "plays") return (b.plays || 0) - (a.plays || 0);
      if (key === "size") return (b.size_bytes || 0) - (a.size_bytes || 0);
      if (key === "lastLaunch") return (b.last_launch || 0) - (a.last_launch || 0);
      return (b.last_played || 0) - (a.last_played || 0);
    });
    return out;
  }

  // ---- featured ---------------------------------------------------------------
  // Deterministic on purpose: most recently played, else the favourite, else
  // nothing. It must not shuffle between launches.
  function featured() {
    const played = games.filter((g) => g.last_played > 0);
    if (played.length) return played.slice().sort((a, b) => b.last_played - a.last_played)[0];
    const fav = games.filter((g) => g.favorite);
    if (fav.length) return fav[0];
    return null;
  }

  function renderFeature() {
    const g = featured();
    const host = E("atlasFeature");
    if (!host) return;
    if (!g) { host.innerHTML = ""; show("atlasFeature", false); return; }
    host.innerHTML = `
      ${art(g, "at-covw")}
      <div class="at-fbody">
        <span class="at-badge at-${escF(badgeCls(g))}">${escF(g.launcher)}</span>
        <h2>${escF(g.name)}</h2>
        <div class="at-facts at-facts-lg">
          <span class="at-fact" title="Last played">${escF(day(g.last_played))}</span>
          <span class="at-fact" title="Launches from ATLAS">${escF(launchesWord(g.plays))}</span>
          <span class="at-fact" title="Install size">${escF(mb(g.size_bytes))}</span>
        </div>
        ${heroWhy(g)}
        <div class="at-cbtns">
          <button class="btn" data-fplay="${escF(g.id)}"${g.available === false ? " disabled" : ""}>Play</button>
          <button class="btn ghost at-fav" data-fav="${escF(g.id)}" aria-pressed="${g.favorite ? "true" : "false"}" title="${g.favorite ? "Remove from favourites" : "Add to favourites"}" aria-label="Favourite">${g.favorite ? "★" : "☆"}</button>
        </div>
      </div>`;
    show("atlasFeature", true);
    wireArt(host);
    const pb = typeof host.querySelector === "function" ? host.querySelector("[data-fplay]") : null;
    if (pb) pb.onclick = (ev) => { stop(ev); launch(byId(g.id)); };
    const fb = typeof host.querySelector === "function" ? host.querySelector("[data-fav]") : null;
    if (fb) fb.onclick = (ev) => { stop(ev); toggleFav(g.id); };
    host.onclick = () => openDetail(g.id);
  }

const byId = (id) => games.find((g) => g.id === id);

  // Which source owns the headline install. This used to be a test for
  // /steam/i, which painted Epic, GOG, EA and Store in the hand-added colour
  // because none of them are Steam.
  const srcOf = (g) => {
    if (g && Array.isArray(g.sources) && g.sources.length) return g.sources[0];
    if (g && g.source === "manual") return "standalone";
    if (g && /manual|standalone|hand/i.test(String(g.launcher || ""))) return "standalone";
    return "steam";
  };

  // The badge class, kept separate from the id so hand-added entries keep the
  // class the stylesheet and the rest of the UI already use.
  const badgeCls = (g) => (srcOf(g) === "standalone" ? "manual" : srcOf(g));

  // Launchability is worked out here, from the data already on the game, rather
  // than trusting a flag the backend computed. The backend does compute one, but
  // a store written before that field existed - or any scan that skips it - would
  // leave the button live on a game that cannot start, and a dead button that
  // looks fine is worse than an honest disabled one.
  // Returns null when it can launch, otherwise the reason it cannot.
function cannotLaunch(g) {
      if (!g) return "That game is no longer in your library.";
      // An entry with no id cannot be launched by id, and sending one to the
      // backend would be asking it to act on nothing.
      if (!g.id) return "That game is no longer in your library.";
      if (g.available === false) {
      return "Executable not found at " + (g.exe_path || g.install_dir || "its recorded location") + ".";
    }
    if (/steam/i.test(g.launcher)) {
      if (!g.app_id || !/^\d+$/.test(String(g.app_id))) return "Steam has no app id for this entry.";
      return null;
    }
    // Detected from a launcher, but not hand-added, and not Steam. ATLAS reads
    // the launcher but does not start through it yet, and says so rather than
    // offering a button that may launch the wrong thing.
    if (g.source !== "manual" && srcOf(g) !== "standalone") {
      return "ATLAS can see this on " + (g.launcher || "its launcher") + " but cannot start games through it yet. Open the launcher to play.";
    }
    if (!g.exe_path) return "No executable is recorded for this entry.";
    return null;
  }

  // One wording for why a game cannot be started, so the card, the hero and the
  // detail panel cannot drift into saying three different things about the same
  // entry. A missing file and an unlaunchable launcher are not the same problem.
  const heroWhy = (g) => {
    const why = cannotLaunch(g);
    return why ? `<p class="at-why">${escF(why)}</p>` : "";
  };

  const detailWhy = (g) => {
    const why = cannotLaunch(g);
    if (!why) return "";
    return `<p class="at-why">${escF(why)}</p>`;
  };

  // "0 launches" is accurate but reads like a database. ATLAS says what it means,
  // and is explicit that the number only covers games launched from here.
  function launchesWord(n) {
    const c = Number(n) || 0;
    return c === 0 ? "None from ATLAS" : c === 1 ? "1 launch" : c + " launches";
  }

  // ---- grid -------------------------------------------------------------------
  function card(g) {
    const blocked = cannotLaunch(g);
    const why = blocked ? `<p class="at-why">${escF(blocked)}</p>` : "";
    return `<article class="at-card" data-open="${escF(g.id)}">
      ${art(g)}
      <div class="at-cbody">
        <div class="at-ch">
          <h4>${escF(g.name)}</h4>
          <span class="at-badge at-${escF(badgeCls(g))}">${escF(g.launcher)}</span>
          ${g.kind && g.kind !== "game" ? `<span class="at-kind" title="Not a game">${escF(g.kind)}</span>` : ""}
        </div>
        <div class="at-facts">
          <span class="at-fact" title="Install size">${escF(mb(g.size_bytes))}</span>
          <span class="at-fact" title="Last played">${escF(day(g.last_played))}</span>
          ${g.multi_install ? `<span class="at-fact at-fact-x" title="This game is installed more than once">${g.installs.length} copies</span>` : ""}
        </div>
        ${g.install_dir ? `<small class="at-path" title="${escF(g.install_dir)}">${escF(g.install_dir)}</small>` : ""}
        ${why}
        <div class="at-cbtns">
          <button class="btn" data-play="${escF(g.id)}"${blocked ? " disabled" : ""}>Play</button>
          <button class="btn ghost at-fav" data-fav="${escF(g.id)}" aria-pressed="${g.favorite ? "true" : "false"}" title="${g.favorite ? "Remove from favourites" : "Add to favourites"}" aria-label="Favourite">${g.favorite ? "★" : "☆"}</button>
          <button class="btn ghost at-del" data-del="${escF(g.id)}">Remove</button>
        </div>
      </div>
    </article>`;
  }

  function renderGrid() {
    const list = sorted(visible());
    const grid = E("atlasGrid");
    const empty = E("atlasEmpty");
    if (grid) grid.innerHTML = list.map(card).join("");
    if (grid) wireArt(grid);

    if (grid) {
      grid.querySelectorAll("[data-play]").forEach((b) => { b.onclick = (ev) => { stop(ev); launch(byId(b.dataset.play)); }; });
      grid.querySelectorAll("[data-fav]").forEach((b) => { b.onclick = (ev) => { stop(ev); toggleFav(b.dataset.fav); }; });
      grid.querySelectorAll("[data-del]").forEach((b) => { b.onclick = (ev) => { stop(ev); remove(b.dataset.del, false); }; });
      grid.querySelectorAll("[data-open]").forEach((c) => { c.onclick = () => openDetail(c.dataset.open); });
    }

    // Four distinct empty states, never one generic message.
    let state = "";
    if (scanError) {
      state = `<b>Could not read the library.</b><p>${escF(scanError)}</p>`;
    } else if (!hasBackend()) {
      state = `<b>STRYV is not connected to its backend.</b><p>The library cannot be read until the backend is running.</p>`;
    } else if (!games.length) {
      state = `<b>No games found yet.</b>
        <p>STRYV reads the library files your launchers have already written. If a game is not listed, add it yourself and ATLAS will launch it directly.</p>
        <button class="btn" data-emptyadd="1">Add a game</button>`;
} else if (!list.length) {
      const term = ((E("atlasQ") && E("atlasQ").value) || "").trim();
      const filtered = filters.favOnly || filters.missingOnly || term;
      // Echoes what was searched for and how big the library actually is, so a
      // wrong search reads as a wrong search rather than as an empty library.
      state = filtered
        ? `<b>Nothing matches${term ? ` &ldquo;${escF(term)}&rdquo;` : ""}.</b>
           <p>None of the ${games.length} ${games.length === 1 ? "game" : "games"} in your library match the current search or filters.</p>
           <button class="btn ghost" data-reset="1">Clear search and filters</button>`
        : `<b>No games found yet.</b><p>Add a game and ATLAS will keep it, launch it, and record how long it runs.</p>
           <button class="btn" data-emptyadd="1">Add a game</button>`;
    }
    if (empty) { empty.innerHTML = state; show("atlasEmpty", !!state); }
    const ea = empty && typeof empty.querySelector === "function" ? empty.querySelector("[data-emptyadd]") : null;
    if (ea) ea.onclick = () => openAdd();
    const rs = empty && typeof empty.querySelector === "function" ? empty.querySelector("[data-reset]") : null;
    if (rs) rs.onclick = () => resetAll();
  }

  function renderHero() {
    const host = E("atlasHeroStat");
    if (!host) return;
    if (scanError) { host.innerHTML = '<span class="at-loading">Library unavailable</span>'; return; }
    if (!games.length && !hasBackend()) { host.innerHTML = '<span class="at-loading">Backend unavailable</span>'; return; }
    const total = games.reduce((a, g) => a + (g.size_bytes || 0), 0);
    const plays = games.reduce((a, g) => a + (g.plays || 0), 0);
    const secs = games.reduce((a, g) => a + (g.total_secs || 0), 0);
const launchers = [...new Set(games.map((g) => g.launcher))].filter(Boolean);
    // When a search or filter is narrowing the grid, the first figure counts what
    // is on screen and says so, rather than always quoting the whole library.
    const term = ((E("atlasQ") && E("atlasQ").value) || "").trim();
    const shownList = visible();
    const narrowed = shownList.length !== games.length;
    const shown = shownList.length === 1 ? "1 game shown" : `${shownList.length} games shown`;
    const of = narrowed ? ` of ${games.length}` : "";
    host.innerHTML = `
      <div><b>${escF(narrowed ? String(shownList.length) : String(games.length))}</b><small>${narrowed ? shown + of : games.length === 1 ? "game" : "games"}${launchers.length ? " · " + escF(launchers.join(", ")) : ""}</small></div>
      <div><b>${escF(mb(total))}</b><small>reported install size</small></div>
      <div><b>${escF(String(plays))}</b><small>launches from ATLAS</small></div>
      <div><b>${escF(secs ? dur(secs) : "Not measured")}</b><small>measured play time</small></div>`;
  }

  // ---- source status ----
  // Says what ATLAS actually read. A launcher that is not installed, one that is
  // turned off, and one whose files could not be read are three different things,
  // and each is stated in its own words rather than folded into one number.
  const SRC_WORD = {
    ok: "Read",
    notinstalled: "Not installed",
    disabled: "Off",
    unreadable: "Could not read",
    failed: "Failed",
  };
  function renderSources() {
    const host = E("atlasSources");
    if (!host) return;
    const rep = sourceReport;
    if (!rep || !Array.isArray(rep.sources)) { show("atlasSources", false); return; }
    const rows = rep.sources.map((s) => {
      const word = SRC_WORD[String(s.status || "").toLowerCase()] || String(s.status || "Unknown");
      const n = Number(s.found) || 0;
      const what = s.status === "ok" ? (n === 1 ? "1 game" : n + " games") : (s.detail || "");
      const slow = Number(s.ms) || 0;
      return `<div class="at-src at-src-${escF(String(s.status || "ok"))}">
        <b>${escF(s.name)}</b>
        <span class="at-srcw">${escF(word)}</span>
        <small>${escF(what)}${s.status === "ok" && slow > 0 ? " · " + slow + " ms" : ""}</small>
      </div>`;
    });
    // Launchers ATLAS has not built support for are named, so the gap is stated
    // instead of leaving the user to wonder why Epic is empty.
    const missing = Array.isArray(rep.not_supported) && rep.not_supported.length
      ? `<p class="at-srcnote">Not read yet: ${escF(rep.not_supported.join(", "))}. ATLAS does not pretend to see these.</p>`
      : "";
    const ms = Number(rep.ms) || 0;
    const head = `<p class="at-srch">${escF(String(ms) + " ms")} to read everything below.</p>`;
    host.innerHTML = head + `<div class="at-srcrow">${rows.join("")}</div>` + missing;
    show("atlasSources", true);
  }
  function renderSessions() {
    const host = E("atlasSess");
    if (!host) return;
    if (!sessions.length) { host.innerHTML = '<p class="at-empty">No sessions recorded yet. Play a game from ATLAS and it will appear here.</p>'; return; }
    host.innerHTML = sessions.map((s) => `
      <div class="at-srow">
        <i class="st ${s.measured ? "done" : "running"}"></i>
        <div>
          <b>${escF(s.name)}</b>
          <small>${escF(when(s.started))} · ${escF(s.launcher)} · ${escF(dur(s.duration_secs))}${s.measured ? "" : " · duration not measured"}</small>
        </div>
        <span class="at-sx">${s.measured ? [s.cpu_pct !== null && s.cpu_pct !== undefined ? "peak " + Math.round(s.cpu_pct) + "% cpu" : "", s.mem_bytes ? mb(s.mem_bytes) + " peak" : ""].filter(Boolean).join(" · ") : "duration not measured"}</span>
      </div>`).join("");
  }

  function render() {
    renderHero();
    renderFeature();
    renderGrid();
    renderSessions();
    renderSources();
    renderFacets();
    const restored = ST.get("atlas.removed", false);
    show("atlasRestore", !!restored);
    const active = filters.favOnly || filters.missingOnly || filters.kind || filters.source || ((E("atlasQ") && E("atlasQ").value || "").trim());
    show("atlasReset", !!active);
  }

  // ---- actions ----------------------------------------------------------------
  async function scan(manual) {
if (busy) return;
      // Renders before bailing, so the sessions panel can explain that it cannot
      // read rather than quietly claiming there is nothing recorded.
      if (!hasBackend()) { render(); loadSessions(); return; }
busy = true;
    const btn = E("atlasScan");
    if (btn) { btn.disabled = true; if (manual) btn.textContent = "Scanning…"; }
    try {
      // The backend answers with a report, not a bare list, so the page can say
      // which sources were read and which could not be.
      const res = await call("atlas_scan");
      games = Array.isArray(res) ? res : (res && Array.isArray(res.games) ? res.games : []);
      sourceReport = Array.isArray(res) ? null : (res || null);
      scanError = null;
      loadSessions();
      A.log({ text: "ATLAS library rescan", status: "done", detail: JSON.stringify({ found: games.length }) });
      if (manual) T("Library rescanned — " + games.length + (games.length === 1 ? " game" : " games"));
} catch (e) {
        TG.add("atlas.scan", e);
        scanError = String(e.message || e);
        // A background refresh that fails still has to say so: the grid on screen
        // is now older than the library, and silence would read as "up to date".
        if (manual) T("Could not read the library: " + e, true);
        else T("Could not refresh the library: " + e + " Showing the last known list.", true);
      } finally {
      busy = false;
      if (btn) { btn.disabled = false; btn.textContent = "Rescan"; }
      render();
    }
  }

async function loadSessions() {
      const host = E("atlasSess");
      // Says "none recorded" only when it was actually able to look. A panel that
      // claims an empty history while the backend is unreachable is telling the
      // user their data is gone when really STRYV just cannot see it.
      if (!hasBackend()) {
        if (host) host.innerHTML = `<p class="at-empty">Sessions are not connected in this window, so STRYV cannot read your history. Nothing has been lost.</p>`;
        return;
      }
      try { sessions = await call("atlas_sessions"); renderSessions(); }
      catch (e) {
        TG.add("atlas.sessions", e);
        if (host) host.innerHTML = `<p class="at-empty">STRYV could not read your session history. The games in your library are untouched.</p>`;
      }
    }

  // Sends only a library id. The executable is resolved by the backend.
async function launch(g) {
      if (launching) return;
      const blocked = cannotLaunch(g);
      if (blocked) { T(blocked + " Edit or remove the entry.", true); return; }
      launching = true;
    const id = A.log({ text: "Launching from ATLAS: " + g.name, status: "running" });
    try {
      const msg = await call("atlas_launch_id", { id: g.id });
      A.update(id, { status: "done", detail: String(msg) });
      T(String(msg));
      setTimeout(() => { loadSessions(); scan(false); }, 2500);
    } catch (e) {
      A.update(id, { status: "failed", detail: String(e) });
      TG.add("atlas.launch", e);
      T("Could not launch: " + e, true);
    } finally { launching = false; }
  }

  async function toggleFav(id) {
    const g = byId(id);
    if (!g) return;
    const next = !g.favorite;
    g.favorite = next;
    render();
    try { await call("atlas_set_favorite", { id, favorite: next }); }
    catch (e) { g.favorite = !next; render(); TG.add("atlas.favorite", e); T("Could not save that: " + e, true); }
  }

  async function remove(id, forget) {
    const g = byId(id);
    if (!g) return;
    const ok = await ASK({
      title: "Remove from ATLAS",
      body: /steam/i.test(g.launcher)
          ? "Take \"" + g.name + "\" out of your ATLAS library?\n\nNothing in the Steam install is deleted. Nothing is uninstalled, no save is touched, and the launcher is not changed. ATLAS only stops listing it."
          : "Take \"" + g.name + "\" out of your ATLAS library?\n\nThis removes the ATLAS entry only. The game, its files and its save data are not touched, and nothing is deleted from disk.",
      yes: "Remove from ATLAS",
      danger: true,
    });
if (!ok) return;
    ST.set("atlas.removed", true);
    const act = A.log({ text: "Removed from ATLAS: " + g.name, status: "running" });
    try {
      await call("atlas_remove", { id, forget: !!forget });
      games = games.filter((x) => x.id !== id);
      A.update(act, { status: "done", detail: "ATLAS entry removed. Nothing on disk was deleted." });
      render();
      await scan(false);
      T("Removed from ATLAS. The game itself is untouched.");
    } catch (e) {
      A.update(act, { status: "failed", detail: String(e.message || e) });
      TG.add("atlas.remove", e);
      T("Could not remove that: " + e, true);
    }
  }

  // Every copy of one game, listed separately. A card can merge the same title
  // from more than one launcher, and showing a single install folder for it
  // would be describing only the first - so each copy is named here with the
  // source that reported it and whether it is still on disk.
  function installList(g) {
    const list = Array.isArray(g.installs) ? g.installs : [];
    if (!list.length) return "";
    const rows = list.map((i) => `
      <li class="at-inst${i.available === false ? " at-inst-off" : ""}">
        <b>${escF(i.source_name)}</b>
        <span class="at-inst-p" title="${escF(i.install_dir || i.exe_path || "")}">${escF(i.install_dir || i.exe_path || "no path recorded")}</span>
        <span class="at-inst-s">${i.available === false ? "missing" : escF(mb(i.size_bytes))}</span>
      </li>`).join("");
    const many = list.length > 1
      ? `<p class="at-inst-n">${list.length} copies of this game, counted separately on disk. ATLAS launches whichever one is still present.</p>`
      : "";
    return `<div class="at-insts"><h4>${many ? "Installs" : "Install"}</h4>${many}<ul>${rows}</ul></div>`;
  }

  // ---- details ----------------------------------------------------------------
  function openDetail(id) {
    const g = byId(id);
    const wrap = E("atlasDetailWrap");
    const host = E("atlasDetail");
    if (!g || !host || !wrap) return;
    detailId = id;
    host.innerHTML = `
      ${art(g, "at-covw")}
      <div class="at-dbody">
        <div class="at-ch">
          <h3>${escF(g.name)}</h3>
          <span class="at-badge at-${escF(badgeCls(g))}">${escF(g.launcher)}</span>
        </div>
        ${detailWhy(g)}
        <dl class="at-meta">
          <div><dt>Status</dt><dd>${g.available === false ? "Unavailable" : "Ready to launch"}</dd></div>
          <div><dt>Kind</dt><dd>${escF(g.kind || "game")}</dd></div>
          <div><dt>Install size</dt><dd>${escF(mb(g.size_bytes))}</dd></div>
          <div><dt>Last played</dt><dd>${escF(day(g.last_played))}</dd></div>
          <div><dt>Last launched</dt><dd>${escF(when(g.last_launch))}</dd></div>
          <div><dt>Launches</dt><dd>${escF(launchesWord(g.plays))}</dd></div>
          <div><dt>Last session</dt><dd>${escF(dur(g.last_session_secs))}</dd></div>
          <div><dt>Total measured</dt><dd>${escF(g.total_secs ? dur(g.total_secs) : "Not measured")}</dd></div>
          ${g.art_path ? `<div><dt>Cover image</dt><dd>${escF(g.art_path)}</dd></div>` : ""}
        </dl>
        ${installList(g)}
        <div class="at-cbtns">
          <button class="btn" data-play="${escF(g.id)}"${cannotLaunch(g) ? " disabled" : ""}>Play</button>
          <button class="btn ghost at-fav" data-fav="${escF(g.id)}" aria-pressed="${g.favorite ? "true" : "false"}" title="${g.favorite ? "Remove from favourites" : "Add to favourites"}" aria-label="Favourite">${g.favorite ? "★" : "☆"}</button>
          <button class="btn ghost" data-edit="${escF(g.id)}">Edit</button>
          <button class="btn ghost at-del" data-del="${escF(g.id)}">Remove</button>
          <button class="btn ghost" data-close="1">Close</button>
        </div>
      </div>`;
    show("atlasDetailWrap", true);
    wireArt(host);
    const pb = typeof host.querySelector === "function" ? host.querySelector("[data-play]") : null;
    if (pb) pb.onclick = () => launch(g);
    const fb = typeof host.querySelector === "function" ? host.querySelector("[data-fav]") : null;
    if (fb) fb.onclick = () => { toggleFav(g.id); openDetail(g.id); };
    const eb = typeof host.querySelector === "function" ? host.querySelector("[data-edit]") : null;
    if (eb) eb.onclick = () => { closeDetail(); openEdit(g.id); };
    const db = typeof host.querySelector === "function" ? host.querySelector("[data-del]") : null;
    if (db) db.onclick = () => { closeDetail(); remove(g.id, false); };
    const cb = typeof host.querySelector === "function" ? host.querySelector("[data-close]") : null;
    if (cb) cb.onclick = () => closeDetail();
    const first = typeof host.querySelector === "function" ? host.querySelector("button") : null;
    if (first && first.focus) first.focus();
  }

  function closeDetail() {
    show("atlasDetailWrap", false);
    const host = E("atlasDetail");
    if (host) host.innerHTML = "";
    detailId = null;
  }

  // ---- add / edit -------------------------------------------------------------
  function openAdd() {
    ["atlasName", "atlasExe", "atlasArt"].forEach((id) => { const e = E(id); if (e) e.value = ""; });
    const t = E("atlasAddTitle"); if (t) t.textContent = "Add a game";
    show("atlasAddBox", true);
    const f = E("atlasExe"); if (f && f.focus) f.focus();
  }
  function closeAdd() {
    show("atlasAddBox", false);
    ["atlasName", "atlasExe", "atlasArt"].forEach((id) => { const e = E(id); if (e) e.value = ""; });
  }
  function openEdit(id) {
    const g = byId(id);
    if (!g) return;
    if (g.source !== "manual") {
      T("Detected games are read from " + g.launcher + ". Remove it from the launcher to clear it from ATLAS.", true);
      return;
    }
    editingId = id;
    const n = E("atlasEditName"), x = E("atlasEditExe"), a = E("atlasEditArt"), ti = E("atlasEditTitle");
    if (n) n.value = g.name;
    if (x) x.value = g.exe_path;
    if (a) a.value = g.art_path || "";
    if (ti) ti.textContent = "Edit " + g.name;
    show("atlasEditBox", true);
    if (n && n.focus) n.focus();
  }
  function closeEdit() {
    show("atlasEditBox", false);
    editingId = null;
    ["atlasEditName", "atlasEditExe", "atlasEditArt"].forEach((id) => { const e = E(id); if (e) e.value = ""; });
  }

  async function pickInto(targetId, filters) {
    try {
      const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
      if (!tauri || !tauri.dialog || typeof tauri.dialog.open !== "function") {
        T("The file picker needs the Tauri dialog plugin, which is not available here. Type the path instead.", true);
        return;
      }
      const picked = await tauri.dialog.open({ multiple: false, directory: false, filters: filters || [{ name: "Executable", extensions: ["exe"] }] });
      if (!picked || typeof picked !== "string") return;
      const e = E(targetId);
      if (e) e.value = picked;
    } catch (e) {
      TG.add("atlas.pick", e);
      T("Could not open the file picker: " + e, true);
    }
  }

async function submitAdd() {
    const exe = (E("atlasExe") && E("atlasExe").value || "").trim();
    if (!exe) { T("Choose the game's .exe file first.", true); return; }
    const name = (E("atlasName") && E("atlasName").value || "").trim() || null;
    const artPath = (E("atlasArt") && E("atlasArt").value || "").trim() || null;
    // Adding is a change to the user's library, so it lands in the activity feed
    // like everything else that alters what ATLAS knows.
    const act = A.log({ text: "Adding a game: " + (name || exe), status: "running" });
    try {
      const g = await call("atlas_add_manual", { name, exe_path: exe, art_path: artPath });
      A.update(act, { status: "done", detail: g.name });
      closeAdd();
      await scan(false);
      T("Added " + g.name);
    } catch (e) {
      A.update(act, { status: "failed", detail: String(e.message || e) });
      TG.add("atlas.add_manual", e);
      T(String(e.message || e), true);
    }
  }

  async function submitEdit() {
    if (!editingId) return;
    const name = (E("atlasEditName") && E("atlasEditName").value || "").trim() || null;
    const exe = (E("atlasEditExe") && E("atlasEditExe").value || "").trim() || null;
    try {
      await call("atlas_update", { id: editingId, name, exe_path: exe });
      const artPath = (E("atlasEditArt") && E("atlasEditArt").value || "").trim();
      await call("atlas_set_art", { id: editingId, art_path: artPath || null });
      closeEdit();
      await scan(false);
      T("Saved.");
    } catch (e) { TG.add("atlas.edit", e); T(String(e.message || e), true); }
  }

  function resetAll() {
    filters.favOnly = false; filters.missingOnly = false; filters.kind = ""; filters.source = "";
    const qe = E("atlasQ"); if (qe) qe.value = "";
    ST.set("atlas.q", "");
    syncChips();
    render();
  }

  // Chips are built from the data rather than hardcoded, so they cannot offer
  // to filter by a source that is not installed, and cannot drift from the
  // launchers the backend actually reports.
  function renderFacets() {
    const host = E("atlasFacets");
    if (!host) return;
    const kinds = [...new Set(games.map((g) => String(g.kind || "game")))];
    const srcs = [...new Set(games.flatMap((g) => (Array.isArray(g.sources) ? g.sources : [])))];
    const chip = (dim, val, label, on) =>
      `<button class="at-chip" data-facet="${escF(dim)}" data-val="${escF(val)}" aria-pressed="${on ? "true" : "false"}">${escF(label)}</button>`;
    let h = "";
    if (srcs.length > 1) {
      h += `<div class="at-facetset"><span class="at-facetl">Source</span>`;
      for (const s of srcs) {
        const name = (games.find((g) => (g.sources || []).includes(s)) || {}).launcher || s;
        h += chip("source", s, name, filters.source === s);
      }
      h += `</div>`;
    }
    if (kinds.length > 1) {
      h += `<div class="at-facetset"><span class="at-facetl">Kind</span>`;
      for (const k of kinds) h += chip("kind", k, k, filters.kind === k);
      h += `</div>`;
    }
    host.innerHTML = h;
    show("atlasFacets", !!h);
  }

  function syncChips() {
    const f = E("atlasFavOnly"); if (f) f.setAttribute("aria-pressed", filters.favOnly ? "true" : "false");
    const m = E("atlasMissingOnly"); if (m) m.setAttribute("aria-pressed", filters.missingOnly ? "true" : "false");
  }

  // ---- wiring -----------------------------------------------------------------
  // Clicks are assigned straight to onclick so a single handler replaces any previous
  // one on re-render; everything else goes through addEventListener.
  const on = (id, ev, fn) => {
    const e = E(id);
    if (!e) return;
    if (ev === "click" && "onclick" in e) { e.onclick = fn; return; }
    if (typeof e.addEventListener === "function") e.addEventListener(ev, fn);
  };

  on("atlasScan", "click", () => scan(true));
  on("atlasAdd", "click", () => openAdd());
  on("atlasAddNo", "click", () => closeAdd());
  on("atlasAddNo2", "click", () => closeAdd());
  on("atlasAddGo", "click", () => submitAdd());
  on("atlasEditNo", "click", () => closeEdit());
  on("atlasEditNo2", "click", () => closeEdit());
  on("atlasEditSave", "click", () => submitEdit());
  on("atlasPickExe", "click", () => pickInto("atlasExe"));
  on("atlasPickArt", "click", () => pickInto("atlasArt", [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }]));
  on("atlasPickExe2", "click", () => pickInto("atlasEditExe"));
  on("atlasPickArt2", "click", () => pickInto("atlasEditArt", [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }]));
  on("atlasClearArt", "click", async () => {
    if (!editingId) return;
    const e = E("atlasEditArt"); if (e) e.value = "";
    try { await call("atlas_set_art", { id: editingId, art_path: null }); T("Cover image cleared."); } catch (err) { T(String(err.message || err), true); }
  });

  on("atlasQ", "input", () => {
      ST.set("atlas.q", E("atlasQ").value);
      // The headline count and the featured game both depend on what is showing.
      // Rerendering only the grid left them quoting the whole library while you
      // were looking at one result.
      renderHero(); renderFeature(); renderGrid(); renderFacets();
      const a = filters.favOnly || filters.missingOnly || (E("atlasQ").value || "").trim();
      show("atlasReset", !!a);
    });
  on("atlasSort", "change", () => { ST.set("atlas.sort", E("atlasSort").value); renderGrid(); renderFeature(); });
  on("atlasFavOnly", "click", () => { filters.favOnly = !filters.favOnly; syncChips(); render(); });

  // Facet chips are rebuilt on every render, so the click is delegated to the
  // container rather than bound per chip.
  on("atlasFacets", "click", (ev) => {
    const b = ev && ev.target && ev.target.closest ? ev.target.closest("[data-facet]") : null;
    if (!b) return;
    const dim = b.dataset.facet, val = b.dataset.val;
    if (dim !== "kind" && dim !== "source") return;
    filters[dim] = filters[dim] === val ? "" : val;
    syncChips();
    render();
  });
  on("atlasMissingOnly", "click", () => { filters.missingOnly = !filters.missingOnly; syncChips(); render(); });
  on("atlasReset", "click", () => resetAll());

on("atlasRestore", "click", async () => {
      // Putting games back is harmless, but it is still a change to the library,
      // so it asks first and says plainly what it is not doing.
      const ok = await ASK({
        title: "Restore removed games",
        body: "Put every game you removed back into your ATLAS library?\n\nNothing is reinstalled and nothing is re-downloaded. ATLAS is only forgetting what it deleted from its own list.",
        yes: "Restore them", danger: false,
      });
      if (!ok) return;
      const act = A.log({ text: "Restored removed ATLAS games", status: "running" });
      try {
        await call("atlas_restore"); ST.set("atlas.removed", false);
        A.update(act, { status: "done", detail: "ATLAS entries restored. Nothing was reinstalled." });
        await scan(false); T("Removed games restored.");
      } catch (e) {
        A.update(act, { status: "failed", detail: String(e.message || e) });
        TG.add("atlas.restore", e); T(String(e.message || e), true);
      }
    });

  on("atlasSessClr", "click", async () => {
      // Refuses before calling the backend, rather than asking it to delete nothing.
      if (!sessions.length) { T("There are no sessions to clear."); return; }
      const ok = await ASK({
        title: "Clear session history",
        body: "Delete every recorded launch?\n\nOnly the measured play time is lost, and it cannot be recovered afterwards. Games stay in your library with their covers, paths and favourites exactly as they are.",
        yes: "Clear history", danger: true,
      });
      if (!ok) return;
      const act = A.log({ text: "Cleared ATLAS session history", status: "running" });
      try {
        await call("atlas_clear_sessions"); sessions = [];
        A.update(act, { status: "done", detail: "Play time cleared. Games were not touched." });
        renderSessions();
        T("Session history cleared.");
      } catch (e) {
        A.update(act, { status: "failed", detail: String(e.message || e) });
        TG.add("atlas.sessions.clear", e); T(String(e.message || e), true);
      }
    });

  on("atlasExe", "keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); submitAdd(); } });
  on("atlasName", "keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); submitAdd(); } });
  on("atlasEditName", "keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); submitEdit(); } });
  on("atlasEditExe", "keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); submitEdit(); } });
  on("atlasDetailWrap", "click", (ev) => { if (ev.target === ev.currentTarget) closeDetail(); });
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (detailId) { closeDetail(); return; }
      if (E("atlasEditBox") && !E("atlasEditBox").hidden) { closeEdit(); return; }
      if (E("atlasAddBox") && !E("atlasAddBox").hidden) closeAdd();
    });
  }

  // Restore the persisted view preferences once the DOM is ready.
  const boot = () => {
    const qe = E("atlasQ"); if (qe) qe.value = ST.get("atlas.q", "");
    const se = E("atlasSort"); if (se) se.value = ST.get("atlas.sort", "recent");
  };
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }

  return { scan, launch, render, openDetail, closeDetail, openAdd, openEdit, resetAll };
})();
