"use strict";
const q = (id) => document.getElementById(id);
const PAGES = ["dashboard", "performance", "network", "atlas", "optimizations", "system", "syn", "activity", "settings", "whatsnew", "help"];
const ACCENTS = { Amber: "#F5A623", Cyan: "#38BDF8", Violet: "#8B5CF6" };
const VERSION = "0.2.1";
const CHANGELOG = [{
  v: "0.2.1", date: "2026-10-16", tag: "ATLAS library",
  groups: {
    New: [
      "ATLAS is now a proper library instead of a table. Search by name, launcher or install path, sort by recently played, last launched, name, most played or install size, and mark favourites to pin them to the top.",
      "Cover art for Steam games, loaded from Valve's public CDN. Games you add yourself have no art and show a plain placeholder rather than a broken image.",
      "Add any game manually by pointing STRYV at its .exe. The file is checked before it is added, launched directly, and watched until it closes.",
      "Session tracking. ATLAS records each launch and, for games it started itself, measures how long it ran along with peak CPU and memory use.",
      "Your library persists. Favourites, hidden entries, hand-added games and session history are saved and restored the next time STRYV opens."
    ],
    Changed: [
      "New design system. Amber is now the STRYV accent, the sidebar is grouped into Monitor, Tools and STRYV, and the dashboard leads with CPU and memory instead of giving every statistic equal weight.",
      "Installations update in place. A new release is downloaded, checked against the signature key built into the app, and installed without leaving STRYV."
    ],
    Fixed: [
      "A game name, app id or install path read from a launcher file is now escaped before it reaches the page. Launchers write those files, so that text is treated as untrusted input rather than markup.",
      "The release workflow can publish again. It was missing a checkout step, and it tried to upload the artifact directories instead of the files inside them.",
      "The updater now points at the repository's current address rather than relying on GitHub redirecting the old one."
    ],
    "Known limits": [
      "Only Steam is detected automatically. Games from other stores are still added by hand, which launches them directly because there is no launcher for STRYV to ask.",
      "Play time is only measured for games ATLAS started itself. A Steam game is launched by Steam, so STRYV never sees the process and reports the launch without a duration rather than guessing one.",
      "Atlas reads Steam libraries only, and launch requests are checked against the library it found on this PC.",
      "Epic, Battle.net and GOG libraries are not read yet."
    ]
  }
}, {  v: "0.2.0", date: "2026-10-15", tag: "Signed updates",
  groups: {
    New: ["Signed in-app updates. STRYV checks the published release feed, downloads the installer and verifies its signature against the key built into the app before running it. An update that does not verify is discarded.", "Updates can be checked manually from Settings, and STRYV also looks quietly in the background and tells you when a newer version exists."],
    "Known limits": ["Updates are only offered once a signed release has been published. Until then, Check now reports that you are up to date."]
  }
}, {
  v: "0.1.0", date: "2026-10-15", tag: "Development build",
  groups: {
    New: ["Dashboard with live CPU, memory, uptime and storage readings.", "Performance page with 2-minute CPU and memory graphs and a top-processes list.", "Network page with live throughput, adapter list, TCP latency and DNS tests.", "System page with hardware and OS details and a copy-diagnostics button.", "Optimizations page with power-plan switching (reversible) and old temp-file cleanup, both with review and confirmation. Startup apps list with reversible enable/disable.", "GPU load, memory, temperature and clock (NVIDIA only), temperature sensors where Windows exposes them, and adapter link speed.", "Dashboard system-health summary (memory, sustained CPU, storage space, uptime) with data-quality labels.", "ATLAS page that finds installed games by reading the library files the launcher has already written, showing each game's launcher, app id, install path, size and last-played date.", "Launch a discovered Steam game from the ATLAS library. STRYV asks Steam to start it through Steam's own link handler and never runs a game's files itself.", "Settings, activity feed, technical log, command palette (Ctrl+K), data export and reset."],
    Fixed: ["A power-plan change that fails no longer leaves a Roll back button behind for a change that did not happen."],
    "Known limits": ["AMD and Intel GPU readings are not supported yet, and many PCs do not expose CPU temperature.", "Switching the Windows power plan needs Administrator rights, so STRYV must be started with Run as administrator for that action.", "ATLAS reads Steam libraries only. Epic, Riot, Battle.net and GOG are not read yet, and only Steam games can be launched from the library.", "SYN Assistant is not connected.", "There is no update mechanism yet; install new builds manually."]
  }
}];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const redact = (s) => String(s).replace(/((key|token|secret|password|authorization)["']?\s*[:=]\s*)\S+/gi, "$1[redacted]");
const store = {
  get(k, d) { try { const v = localStorage.getItem("stryv." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("stryv." + k, JSON.stringify(v)); return true; } catch { return false; } },
};

function toast(msg, bad) {
  const t = document.createElement("div"); t.className = "toast" + (bad ? " bad" : ""); t.setAttribute("role", bad ? "alert" : "status");
  t.innerHTML = `<span>${esc(msg)}</span>` + (bad ? '<button aria-label="Dismiss">✕</button>' : "");
  const kill = () => { t.classList.remove("in"); setTimeout(() => t.remove(), 200); };
  if (bad) t.querySelector("button").onclick = kill; else setTimeout(kill, 2400);
  q("toasts").appendChild(t); requestAnimationFrame(() => t.classList.add("in"));
}

function confirmBox({ title, body, yes = "Confirm", danger = false }) {
  return new Promise((res) => {
    const y = q("dYes"), n = q("dNo"), d = q("dlg");
    q("dT").textContent = title; q("dB").textContent = body; y.textContent = yes; y.classList.toggle("danger", danger);
    const done = (v) => { d.classList.remove("on"); y.onclick = n.onclick = null; d._cancel = null; res(v); };
    y.onclick = () => done(true); n.onclick = () => done(false); d._cancel = () => done(false);
    d.classList.add("on"); (danger ? n : y).focus();
  });
}

const Tech = {
  list: store.get("tech", []),
  add(ctx, err) {
    this.list.push({ t: Date.now(), ctx, msg: redact(err && err.stack || err) });
    if (this.list.length > 100) this.list.shift();
    store.set("tech", this.list); renderActivity();
  },
};
addEventListener("error", (e) => Tech.add("window.error", e.error || e.message));
addEventListener("unhandledrejection", (e) => Tech.add("unhandledrejection", e.reason));

const Cfg = {
  d: { accent: "#F5A623", compact: false, reduceMotion: false, interval: 2, startPage: "dashboard", keepActivity: true, intro: true }, v: {},
  load() {
    const s = store.get("settings", {}), v = { ...this.d };
    if (Object.values(ACCENTS).includes(s.accent)) v.accent = s.accent;
    for (const k of ["compact", "reduceMotion", "keepActivity", "intro"]) if (typeof s[k] === "boolean") v[k] = s[k];
    if ([1, 2, 5].includes(s.interval)) v.interval = s.interval;
    if (["dashboard", "performance", "network", "system", "activity"].includes(s.startPage)) v.startPage = s.startPage;
    this.v = v;
  },
  set(k, val, label) {
    this.v[k] = val; store.set("settings", this.v); this.apply();
    if (k === "keepActivity") { if (!val) localStorage.removeItem("stryv.act"); else Act.save(); }
    if (k === "interval" && window.startTimers) startTimers();
    Act.log({ text: "Setting changed: " + label }); toast("Saved");
  },
  apply() {
    document.documentElement.style.setProperty("--v", this.v.accent);
    q("app").classList.toggle("compact", this.v.compact); document.body.classList.toggle("rm", this.v.reduceMotion);
    document.querySelectorAll("[data-set]").forEach((b) => b.setAttribute("aria-pressed", !!this.v[b.dataset.set]));
    document.querySelectorAll("[data-accent]").forEach((b) => b.setAttribute("aria-pressed", ACCENTS[b.dataset.accent] === this.v.accent));
    document.querySelectorAll("[data-sel]").forEach((s) => s.value = this.v[s.dataset.sel]);
  },
};

const Act = {
  list: [],
  init() { this.list = (Cfg.v.keepActivity ? store.get("act", []) : []).map((a) => a.status === "running" ? { ...a, status: "failed", detail: "Interrupted: the app closed before this finished." } : a); },
  log(o) { const a = { id: Date.now() + Math.random(), t: Date.now(), status: "done", ...o }; this.list.unshift(a); this.list.length = Math.min(this.list.length, 200); this.save(); renderActivity(); return a.id; },
  update(id, p) { const a = this.list.find((x) => x.id === id); if (a) { Object.assign(a, p); this.save(); renderActivity(); } },
  save() { if (Cfg.v.keepActivity) store.set("act", this.list); },
};

let actTab = "feed";
function renderActivity() {
  const el = q("actList"); if (!el) return;
  document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === actTab));
  const time = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  if (actTab === "feed") {
    el.innerHTML = Act.list.length ? Act.list.map((a, i) => `<div class="arow"><i class="st ${a.status}"></i><div><b>${esc(a.text)}</b><small>${a.status === "running" ? "Running…" : a.status === "failed" ? "Failed" : "Done"} · ${time(a.t)}</small></div>${a.detail ? `<button class="lnk" data-copy="${i}">Copy details</button>` : ""}</div>`).join("") : '<p class="empty">No activity yet. Actions you take in STRYV appear here.</p>';
    el.querySelectorAll("[data-copy]").forEach((b) => b.onclick = () => copyText(Act.list[b.dataset.copy].detail));
  } else {
    el.innerHTML = Tech.list.length ? [...Tech.list].reverse().map((e) => `<div class="arow"><i class="st failed"></i><div><b>${esc(e.ctx)}</b><small>${time(e.t)}</small><pre>${esc(e.msg)}</pre></div></div>`).join("") + '<button class="btn ghost" id="copyTech">Copy technical log</button>' : '<p class="empty">No technical errors recorded.</p>';
    const c = q("copyTech"); if (c) c.onclick = () => copyText(Tech.list.map((e) => `${new Date(e.t).toISOString()} ${e.ctx}\n${e.msg}`).join("\n\n"));
  }
}
async function copyText(t) { try { await navigator.clipboard.writeText(redact(t)); toast("Copied"); } catch (e) { toast("Copy failed", true); Tech.add("clipboard", e); } }

function renderNews() {
  const unseen = store.get("seen", "") !== CHANGELOG[0].v;
  q("newsList").innerHTML = CHANGELOG.map((r) => `<article class="rel"><div class="relh"><b>v${r.v}</b><span>${r.date} · ${r.tag}</span></div>` + Object.entries(r.groups).map(([g, l]) => `<h4>${g}</h4><ul>${l.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`).join("") + "</article>").join("");
  q("markSeen").style.display = unseen ? "" : "none";
}
function updateDot() { document.querySelector('[data-p="whatsnew"]').classList.toggle("unseen", store.get("seen", "") !== CHANGELOG[0].v); }

function go(p) {
  if (!PAGES.includes(p)) return;
  document.querySelectorAll("[data-p]").forEach((b) => b.classList.toggle("on", b.dataset.p === p));
  document.querySelectorAll(".page").forEach((s) => s.classList.toggle("on", s.id === p));
  if (p === "whatsnew") renderNews(); if (p === "activity") renderActivity(); if (p === "optimizations" && typeof Opt !== "undefined") Opt.load();
  if (p === "atlas" && typeof Atlas !== "undefined") Atlas.scan();
  if (typeof Sensors !== "undefined") { if (p === "network") Sensors.poll(); else setTimeout(Sensors.poll, 0); }
  document.querySelector("main").scrollTop = 0;
}

function exportData() { return { app: "STRYV", version: VERSION, exported: new Date().toISOString(), settings: Cfg.v, activity: Act.list }; }

const COMMANDS = [
  ["Go to Dashboard", "Ctrl+1", () => go("dashboard")], ["Go to Performance", "Ctrl+2", () => go("performance")],
  ["Go to Network", "Ctrl+3", () => go("network")], ["Go to ATLAS", "", () => go("atlas")], ["Go to Optimizations", "", () => go("optimizations")], ["Go to System", "Ctrl+4", () => go("system")],
  ["Go to Activity", "Ctrl+5", () => go("activity")], ["Go to Settings", "Ctrl+,", () => go("settings")],
  ["Go to What's New", "", () => go("whatsnew")], ["Go to Help & About", "", () => go("help")],
  ["Run network connection tests", "", () => { go("network"); q("runT").click(); }],
  ["Copy system diagnostics", "", () => { go("system"); q("copy").click(); }],
  ["Toggle compact sidebar", "", () => Cfg.set("compact", !Cfg.v.compact, "Compact sidebar")],
  ["Replay launch animation", "", () => Intro.run(async () => ({ ok: true }), { force: true })],
  ["Export app data as JSON", "", () => q("expFile").click()],
];
let palSel = 0, palList = COMMANDS;
const palOpen = () => q("pal").classList.contains("on");
function renderPal() {
  const t = q("pin").value.toLowerCase().split(/\s+/).filter(Boolean);
  palList = COMMANDS.filter((c) => t.every((w) => c[0].toLowerCase().includes(w))); palSel = Math.min(palSel, Math.max(0, palList.length - 1));
  q("plist").innerHTML = palList.length ? palList.map((c, i) => `<div class="pit${i === palSel ? " sel" : ""}" data-i="${i}"><span>${c[0]}</span><kbd>${c[1]}</kbd></div>`).join("") : '<p class="empty">No matching commands.</p>';
  q("plist").querySelectorAll(".pit").forEach((e) => e.onclick = () => runPal(+e.dataset.i));
}
function runPal(i) { const c = palList[i]; closePal(); if (c) c[2](); }
function openPal() { q("pin").value = ""; palSel = 0; renderPal(); q("pal").classList.add("on"); q("pin").focus(); }
function closePal() { q("pal").classList.remove("on"); }
q("pin").oninput = () => { palSel = 0; renderPal(); };
q("pin").onkeydown = (e) => {
  if (e.key === "ArrowDown") { palSel = Math.min(palSel + 1, palList.length - 1); renderPal(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { palSel = Math.max(palSel - 1, 0); renderPal(); e.preventDefault(); }
  else if (e.key === "Enter") runPal(palSel);
};
q("pal").onmousedown = (e) => { if (e.target === q("pal")) closePal(); };
addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (q("dlg").classList.contains("on")) q("dlg")._cancel(); else if (q("rv").classList.contains("on")) Opt.close(); else if (palOpen()) closePal(); return; }
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "k") { e.preventDefault(); palOpen() ? closePal() : openPal(); }
  else if (k === ",") { e.preventDefault(); go("settings"); }
  else if (/^[1-5]$/.test(k)) { e.preventDefault(); go(["dashboard", "performance", "network", "system", "activity"][+k - 1]); }
});

document.querySelectorAll("[data-p]").forEach((b) => b.onclick = () => go(b.dataset.p));
document.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { actTab = b.dataset.tab; renderActivity(); });
document.querySelectorAll("[data-set]").forEach((b) => b.onclick = () => Cfg.set(b.dataset.set, !Cfg.v[b.dataset.set], b.dataset.label));
document.querySelectorAll("[data-accent]").forEach((b) => b.onclick = () => Cfg.set("accent", ACCENTS[b.dataset.accent], "Accent color"));
document.querySelectorAll("[data-sel]").forEach((s) => s.onchange = () => Cfg.set(s.dataset.sel, isNaN(s.value) ? s.value : +s.value, s.dataset.label));
q("markSeen").onclick = () => { store.set("seen", CHANGELOG[0].v); updateDot(); renderNews(); toast("Marked as viewed"); };
q("expFile").onclick = () => {
  try {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(exportData(), null, 2)], { type: "application/json" }));
    a.download = "stryv-export.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    Act.log({ text: "Exported app data" }); toast("Export started");
  } catch (e) { Tech.add("export", e); toast("Export failed. Use Copy as JSON instead.", true); }
};
q("replay").onclick = () => Intro.run(async () => ({ ok: true }), { force: true });
q("expCopy").onclick = () => copyText(JSON.stringify(exportData(), null, 2));
q("clrAct").onclick = async () => { if (await confirmBox({ title: "Clear activity history?", body: "This removes the activity feed on this PC. Settings are kept.", yes: "Clear", danger: true })) { Act.list = []; Act.save(); renderActivity(); toast("Activity cleared"); } };
q("rstSet").onclick = async () => { if (await confirmBox({ title: "Reset settings?", body: "Accent, sidebar, motion, startup and monitoring options return to defaults. Your activity history is kept.", yes: "Reset", danger: true })) { Cfg.v = { ...Cfg.d }; store.set("settings", Cfg.v); Cfg.apply(); if (window.startTimers) startTimers(); Act.log({ text: "Settings reset to defaults" }); toast("Settings reset"); } };
q("delAll").onclick = async () => { if (await confirmBox({ title: "Delete all STRYV data?", body: "This permanently deletes settings, activity history and the technical log stored by STRYV on this PC, then restarts the interface. It cannot be undone.", yes: "Delete everything", danger: true })) { Object.keys(localStorage).filter((k) => k.startsWith("stryv.")).forEach((k) => localStorage.removeItem(k)); location.reload(); } };
q("ver").textContent = "v" + VERSION; q("aboutV").textContent = "Version " + VERSION;

Cfg.load(); Act.init(); Cfg.apply(); updateDot(); go(Cfg.v.startPage);
