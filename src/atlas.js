"use strict";
// ATLAS - game discovery and launching.
// Discovery is read-only: it reads the files the launcher has already written.
// Launching is a separate, explicit action the user takes per game, and it only
// ever passes an app id back to the backend, never a path or a command.
const Atlas = (() => {
  let games = [], busy = false, launching = false;
  const mb = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : (b / 1048576).toFixed(0) + " MB";
  const when = (s) => {
    if (!s) return "Never played";
    const d = new Date(s * 1000);
    if (isNaN(d.getTime()) || d.getFullYear() < 2000) return "Never played";
    return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  };
  const playable = (g) => g.launcher === "Steam" && !!g.app_id;

  function render() {
    const total = games.reduce((a, g) => a + (g.size_bytes || 0), 0);
    const launchers = [...new Set(games.map((g) => g.launcher))];
    q("atlasN").textContent = games.length ? games.length + (games.length === 1 ? " game" : " games") : "None found";
    q("atlasSum").textContent = games.length
      ? "Found via " + launchers.join(", ") + "."
      : "No launcher library files were found on this PC.";
    q("atlasSize").textContent = total ? mb(total) : "—";
    q("atlasT").innerHTML = games.length
      ? games.map((g, i) => `<tr><td style="color:var(--t)">${esc(g.name)}<br><small style="color:var(--m)">${esc(g.launcher)}${g.app_id ? " · " + esc(g.app_id) : ""} · ${esc(g.install_dir)}</small></td><td class="n">${g.size_bytes ? mb(g.size_bytes) : "—"}</td><td class="n">${when(g.last_played)}</td><td class="n">${playable(g) ? `<button class="btn" data-play="${i}">Play</button>` : `<small style="color:var(--m)">—</small>`}</td></tr>`).join("")
      : '<tr><td>Nothing to show yet.</td></tr>';
    q("atlasT").querySelectorAll("[data-play]").forEach((b) => { b.onclick = () => launch(games[+b.dataset.play]); });
    q("atlasNote").innerHTML = "STRYV reads only what the launcher wrote. Launching asks Steam to start a game through Steam's own link handler; STRYV never runs the game's files directly. Epic, Riot, Battle.net and GOG libraries are not read yet.";
  }

  async function scan(manual) {
    if (busy || typeof invoke === "undefined" || !invoke) {
      if (typeof invoke === "undefined" || !invoke) { q("atlasT").innerHTML = "<tr><td>Unavailable: the STRYV backend is not connected.</td></tr>"; }
      return;
    }
    busy = true;
    const btn = q("atlasScan");
    btn.disabled = true;
    if (manual) btn.textContent = "Scanning…";
    try {
      games = await invoke("atlas_scan");
      render();
      if (manual) { toast("Library rescanned"); Act.log({ text: "ATLAS library rescan", detail: JSON.stringify({ found: games.length }) }); }
    } catch (e) {
      Tech.add("atlas.scan", e);
      q("atlasT").innerHTML = '<tr><td>Could not read the library: ' + esc(e) + "</td></tr>";
      q("atlasNote").textContent = "";
    } finally {
      busy = false;
      btn.disabled = false;
      if (manual) btn.textContent = "Rescan library";
    }
  }

  // Sends only the numeric app id. The backend re-checks it against the scanned
  // library and builds the Steam link itself.
  async function launch(g) {
    if (!g || launching) return;
    if (!playable(g)) { toast("That game cannot be launched yet.", true); return; }
    launching = true;
    const btn = q("atlasT").querySelector("[data-play='" + games.indexOf(g) + "']");
    if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }
    const aid = Act.log({ text: "Launching from ATLAS: " + g.name, status: "running" });
    try {
      const msg = await invoke("atlas_launch", { appid: g.app_id });
      Act.update(aid, { status: "done", detail: String(msg) });
      toast(msg);
    } catch (e) {
      Act.update(aid, { status: "failed", detail: String(e) });
      Tech.add("atlas.launch", e);
      toast("Could not launch: " + e, true);
    } finally {
      launching = false;
      if (btn) { btn.disabled = false; btn.textContent = "Play"; }
    }
  }

  q("atlasScan").onclick = () => scan(true);
  return { scan, launch };
})();
