"use strict";
// Tests the shipped frontend file src/atlas.js in a minimal fake DOM.
//
// The JS is the contract. These tests drive the real card grid (#atlasGrid), the
// real empty-state div (#atlasEmpty) and the real buttons the renderer emits --
// the Play / star / Remove handlers are clicked, not called around -- and assert
// on what it actually does: discovery, search, the five sort keys, favourites
// floating to the top, cover art and its fallback, manual add, remove/restore,
// sessions and the empty states.
//
// What is asserted here:
//   - every element id atlas.js touches exists in src/index.html, the page offers
//     exactly the sort keys ATLAS implements, and ATLAS never rewrites the
//     static page note
//   - escaping: a game name and an app id carrying <img src=x onerror=alert(1)>
//     render as text, no live tag survives, and only a bare decimal app id can
//     ever reach the cover-art URL
//   - launching sends only { id } to atlas_launch_id; no path, executable or
//     command line is ever sent to the backend
//   - activity and technical logging, and error toasts that keep the backend's
//     own message
//   - honest nulls: size_bytes 0 renders a dash, last_session_secs null renders
//     "not measured", and 0 plays never implies play time
//   - the three empty states (nothing found / backend not connected / search
//     matched nothing), and that a missing backend does not throw
//   - a failed launch and a failed background refresh leave the grid on screen
//
// What still needs `cargo test`, which cannot run until a Rust toolchain exists:
//   - the Valve-KeyValues parser: read_vdf, vdf_obj, vdf_val, vdf_u64
//   - the Rust-side launch validation in steam_start: the numeric parse and
//     round-trip, the steam:// handler registration check, the allowlist against
//     the library this scan found, and the steam://rungameid/<id> construction
//   - merge_library's hidden/favourite/play-time bookkeeping, atlas_add_manual's
//     file and .exe checks, and push_session's duration measurement
//
// Run: npm test
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "src", "atlas.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "src", "index.html"), "utf8");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "atlas-games.json"), "utf8"));
// The page's own note, read from the shipped markup, so the assertion below is
// about the text that actually ships rather than a copy of it.
const NOTE = (/<small id="atlasNote">([\s\S]*?)<\/small>/.exec(HTML) || [, ""])[1];

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name); }
}

// Same escaping core.js applies; used here to build the strings the renderer is
// expected to contain, not to reimplement it.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// --- minimal DOM ------------------------------------------------------------
// Every id the ATLAS page declares in src/index.html. A missing one here means
// the test is checking less than the real page has.
const IDS = ["atlasQ", "atlasSort", "atlasAdd", "atlasAddBox", "atlasExe", "atlasName", "atlasAddNo", "atlasAddGo",
             "atlasScan", "atlasRestore", "atlasSessClr", "atlasGrid", "atlasEmpty", "atlasSess",
             "atlasN", "atlasSum", "atlasSize", "atlasPlays", "atlasTime", "atlasNote"];

function makeEl(dataset) {
  const el = {
    dataset: dataset || {}, disabled: false, hidden: false, value: "",
    textContent: "", innerHTML: "", onclick: null, title: "",
    style: {}, parentNode: null, focused: false, _attrs: {}, _listeners: {},
  };
  el.setAttribute = (k, v) => { el._attrs[k] = String(v); };
  el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null);
  el.addEventListener = (ev, fn) => { (el._listeners[ev] = el._listeners[ev] || []).push(fn); };
  el.focus = () => { el.focused = true; };
  return el;
}
// Fire a listener the way a user event would.
function fire(el, ev, e) { (el._listeners[ev] || []).forEach((fn) => fn(e || {})); }

// The grid must answer querySelectorAll for the four data attributes the
// renderer binds handlers to, so the markup is actually parsed here rather than
// the tests reaching past it. A real Element returns the same node objects on
// repeated queries and throws the old ones away when innerHTML is reassigned, so
// the cache is keyed on the current markup generation.
function gridEl() {
  const el = makeEl();
  el._html = "";
  el._cache = {};
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html; },
    set(v) { this._html = String(v); this._cache = {}; },
    enumerable: true,
  });
  el.querySelectorAll = (sel) => {
    const m = /^\[data-([a-z-]+)\]$/.exec(sel);
    if (!m) return [];
    const attr = m[1];
    const tags = el._html.match(/<[^>]*>/g) || [];
    const seen = {}, out = [];
    for (const t of tags) {
      const a = /data-([a-z-]+)="([^"]*)"/.exec(t);
      if (!a || a[1] !== attr) continue;
      const key = attr + "|" + a[2];
      seen[key] = (seen[key] || 0) + 1;                    // same value can repeat (data-cover)
      const k = key + "#" + seen[key];
      if (!el._cache[k]) el._cache[k] = makeEl({ [attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]: a[2] });
      out.push(el._cache[k]);
    }
    return out;
  };
  return el;
}

function makeEnv(games, invokeImpl, opts) {
  const o = opts || {};
  const els = {};
  for (const id of IDS) els[id] = id === "atlasGrid" ? gridEl() : makeEl();
  els.atlasNote.textContent = NOTE;
  // Anything the page ships with the hidden attribute starts hidden, so the fake
  // DOM never starts more open than the real one.
  for (const id of IDS) if (new RegExp('id="' + id + '"[^>]*\\shidden').test(HTML)) els[id].hidden = true;

  const log = [];
  const act = new Map();
  let seq = 0;
  const saved = new Map();
  const store = { get: (k, d) => (saved.has(k) ? saved.get(k) : d), set: (k, v) => { saved.set(k, v); return true; } };

  const sandbox = {
    q: (id) => els[id] || null,
    esc,
    store,
    toast: (m, bad) => log.push({ kind: "toast", m, bad: !!bad }),
    Act: {
      log: (x) => {
        const e = Object.assign({ id: "act" + ++seq, status: "done" }, x);
        act.set(e.id, e);
        log.push({ kind: "act", id: e.id, m: e.text, status: e.status, detail: e.detail });
        return e.id;                                       // atlas.js threads this into Act.update
      },
      update: (id, p) => log.push({ kind: "actupdate", id, of: (act.get(id) || {}).text, m: p.status, detail: p.detail }),
    },
    Tech: { add: (ctx, err) => log.push({ kind: "tech", m: ctx, err: (err && err.message) || String(err) }) },
    confirmBox: (d) => { log.push({ kind: "confirm", title: d.title, body: d.body }); return Promise.resolve(!(o.confirm && !o.confirm())); },
    console,
    document: { createElement: (tag) => makeEl({ tag }) },
  };
  if (o.noDoc) delete sandbox.document;
  // Left off entirely when no invoke is passed, so "backend missing" is real.
  if (invokeImpl !== undefined) sandbox.invoke = invokeImpl;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  sandbox.Atlas = vm.runInContext("Atlas", sandbox);
  return { Atlas: sandbox.Atlas, els, log, store: saved };
}

// A backend that answers what every test needs and records every call, so the
// tests can assert on what was sent and not merely on what came back.
function backend(over) {
  const calls = [];
  const impl = async (n, a) => {
    calls.push({ n, a });
    if (over && over[n]) return over[n](a);
    if (n === "atlas_scan") return JSON.parse(JSON.stringify(FIXTURE.games));
    if (n === "atlas_sessions") return [];
    throw new Error("unexpected invoke: " + n);
  };
  impl.calls = calls;
  return impl;
}

// --- markup helpers ---------------------------------------------------------
const cards = (html) => html.split('<article class="at-card">').slice(1);
const head = (c) => (/<h4>([\s\S]*?)<\/h4>/.exec(c) || [, ""])[1];
const names = (html) => cards(html).map(head);
const cardFor = (html, name) => cards(html).find((c) => head(c) === name) || "";
const imgs = (html) => html.match(/<img[^>]*>/g) || [];
const srcs = (html) => imgs(html).map((t) => (/src="([^"]*)"/.exec(t) || [, ""])[1]);
const tags = (html) => html.match(/<[a-zA-Z\/!][^>]*>/g) || [];
const tagName = (t) => (/^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(t) || [, ""])[1];
const gbid = (b) => (b / 1073741824).toFixed(1) + " GB";
// Drains the promise chains atlas.js fires without awaiting (sessions, the
// background rescan after a launch).
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };

const EVIL_NAME = FIXTURE.games.find((g) => /[<>]/.test(g.name));
const POISON = FIXTURE.games.find((g) => /[<>]/.test(g.app_id));

(async () => {
  console.log("ATLAS frontend tests\n");

  // ================= page contract =================
  console.log("page contract");
  {
    // Element ids are camelCase; command names are snake_case, so this only ever
    // picks up ids the page actually has to declare.
    const used = [...new Set([...SRC.matchAll(/["'](atlas[A-Z][A-Za-z0-9]*)["']/g)].map((m) => m[1]))];
    check("ATLAS touches the elements it declares", used.length >= 15);
    check("every element id ATLAS uses exists in the page", used.every((id) => HTML.includes('id="' + id + '"')));
    check("the markup is the card grid, not the old table", /id="atlasGrid"/.test(HTML) && /id="atlasEmpty"/.test(HTML));
    check("the old table is gone", !/id="atlasT"/.test(HTML));

    const sorts = ((/const SORTS = \[([^\]]*)\]/.exec(SRC) || [, ""])[1].match(/"[^"]+"/g) || []).map((s) => s.slice(1, -1));
    const sel = (/<select id="atlasSort"[\s\S]*?<\/select>/.exec(HTML) || [""])[0];
    const offered = [...sel.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
    check("the page offers exactly five sorts", sorts.length === 5 && offered.length === 5);
    check("every sort the page offers is one ATLAS implements", offered.every((o) => sorts.includes(o)));

    check("ATLAS never rewrites the static page note", !used.includes("atlasNote"));
    check("the shipped note still explains the link handler", /link handler/.test(NOTE));
    check("the shipped note still explains hand-added games", /add yourself are launched directly/.test(NOTE));
  }

  // ================= discovery rendering =================
  console.log("\ndiscovery rendering");
  {
    const { Atlas, els } = makeEnv(FIXTURE.games, backend());
    await Atlas.scan(false);
    await flush();
    const grid = els.atlasGrid.innerHTML;

    check("counts the games", els.atlasN.textContent === FIXTURE.games.length + " games");
    check("names the launchers it found", /Steam/.test(els.atlasSum.textContent) && /Manual/.test(els.atlasSum.textContent));
    check("renders one card per game", cards(grid).length === FIXTURE.games.length);
    check("one Play button per card", els.atlasGrid.querySelectorAll("[data-play]").length === FIXTURE.games.length);
    check("one star per card", els.atlasGrid.querySelectorAll("[data-fav]").length === FIXTURE.games.length);
    check("one Remove per card", els.atlasGrid.querySelectorAll("[data-del]").length === FIXTURE.games.length);

    check("total size matches the sum", els.atlasSize.textContent === gbid(FIXTURE.games.reduce((a, g) => a + g.size_bytes, 0)));
    check("large sizes use GB", /GB$/.test(els.atlasSize.textContent));
    check("a small install reads in MB", /<dd>214 MB<\/dd>/.test(cardFor(grid, "Steamworks Common Redistributables")));
    check("a large install reads in GB", /<dd>49\.4 GB<\/dd>/.test(cardFor(grid, "Tom Clancy's Rainbow Six Siege")));
    check("total launches are summed", els.atlasPlays.textContent === String(FIXTURE.games.reduce((a, g) => a + g.plays, 0)));
    check("total play time is summed", els.atlasTime.textContent === "1h 27m");

    check("a never-played entry says Never", /<dd>Never<\/dd>/.test(cardFor(grid, "Steamworks Common Redistributables")));
    check("Steam entries are badged as Steam", /at-badge at-steam/.test(grid));
    check("hand-added entries are badged as manual", /at-badge at-manual/.test(grid));
    check("the install path is shown", /steamapps\\common/.test(grid));
    check("the page note is left exactly as the page ships it", els.atlasNote.textContent === NOTE);
    check("the restore link starts hidden", els.atlasRestore.hidden === true);
    check("the empty state stays hidden while there is content", els.atlasEmpty.hidden === true);
    check("the sort control starts on recently played", els.atlasSort.value === "recent");
  }

  // ================= escaping =================
  console.log("\nescaping");
  {
    const { Atlas, els } = makeEnv(FIXTURE.games, backend());
    await Atlas.scan(false);
    const grid = els.atlasGrid.innerHTML;
    const evil = cardFor(grid, esc(EVIL_NAME.name));
    const poison = cardFor(grid, "Entry with a poisoned app id");

    check("a name carrying markup renders escaped", evil.includes(esc(EVIL_NAME.name)));
    check("the payload appears as text, not as a tag", /&lt;img src=x onerror=alert\(1\)&gt;/.test(grid));
    check("the raw payload never appears unescaped", !grid.includes("<img src=x"));
    check("no <script> tag survives", !/<script/i.test(grid));
    check("the only <img> on the card is the Steam cover", imgs(evil).length === 1 && /^<img class="at-cov"/.test(imgs(evil)[0]));
    check("every tag on the grid is markup atlas.js emits",
      tags(grid).every((t) => "article div h4 span dl dt dd small button img p i b".split(" ").includes(tagName(t))));
    check("no tag carries an event handler attribute", tags(grid).every((t) => !/\son\w+\s*=/.test(t)));

    check("only a Steam entry with a decimal app id gets a cover", srcs(grid).length === 3);
    check("every cover src is a plain Steam CDN url",
      srcs(grid).every((s) => /^https:\/\/cdn\.cloudflare\.steamstatic\.com\/steam\/apps\/\d{1,12}\/header\.jpg$/.test(s)));
    check("no cover src carries a quote or angle bracket", !srcs(grid).some((s) => /[<>"']/.test(s)));
    check("a poisoned app id gets no cover at all", imgs(poison).length === 0 && /at-covf/.test(poison));
    check("a poisoned app id is told it is not a Steam entry", /Not a Steam entry/.test(poison));
    check("a poisoned app id is still shown, escaped", poison.includes(esc(POISON.app_id)));
    check("a quote in the path cannot break out of the title attribute", poison.includes('title="' + esc(POISON.install_dir) + '"'));
    check("the grid has balanced quotes", (grid.match(/"/g) || []).length % 2 === 0);
  }

  // ================= cover art =================
  console.log("\ncover art");
  {
    const { Atlas, els } = makeEnv(FIXTURE.games, backend());
    await Atlas.scan(false);
    await flush();
    const covers = els.atlasGrid.querySelectorAll("[data-cover]");
    check("three Steam entries get a cover", covers.length === 3);
    check("every cover has an error handler", covers.every((i) => typeof i.onerror === "function"));
    check("a hand-added entry says it has no cover art", /No cover art/.test(cardFor(els.atlasGrid.innerHTML, "Hollow Knight")));
    check("a cover is lazy and sends no referrer", /loading="lazy"/.test(els.atlasGrid.innerHTML) && /referrerpolicy="no-referrer"/.test(els.atlasGrid.innerHTML));

    const replaced = [];
    covers[0].parentNode = { replaceChild: (n, o) => replaced.push([n, o]) };
    covers[0].onerror();
    check("a broken cover is replaced by a placeholder", replaced.length === 1 && replaced[0][0].className === "at-covf");
    check("the placeholder says there is no cover art", replaced.length === 1 && replaced[0][0].textContent === "No cover art");
    check("what it replaced was the cover", replaced.length === 1 && replaced[0][1] === covers[0]);
  }
  {
    // The other branch of the same fallback: with nothing to build a node out of
    // it must still not throw on the way to hiding the image.
    const { Atlas, els } = makeEnv(FIXTURE.games, backend(), { noDoc: true });
    await Atlas.scan(false);
    await flush();
    const covers = els.atlasGrid.querySelectorAll("[data-cover]");
    covers[0].parentNode = { replaceChild: () => { throw new Error("should not be reached"); } };
    covers[0].onerror();
    check("a broken cover with no document hides the image instead", covers[0].style.display === "none");
  }

  // ================= launching =================
  console.log("\nlaunching");
  {
    const inv = backend({ atlas_launch_id: () => "Steam was asked to launch this game (app 359550)." });
    const { Atlas, els, log } = makeEnv(FIXTURE.games, inv);
    await Atlas.scan(false);
    await flush();

    check("the favourite card is rendered first", names(els.atlasGrid.innerHTML)[0] === "Tom Clancy's Rainbow Six Siege");
    const plays = els.atlasGrid.querySelectorAll("[data-play]");
    check("every Play button has a handler", plays.every((b) => typeof b.onclick === "function"));

    log.length = 0;
    // Click the real button on the card we mean, exactly as a user would.
    plays[names(els.atlasGrid.innerHTML).indexOf("Tom Clancy's Rainbow Six Siege")].onclick();
    await flush();

    const L = inv.calls.filter((c) => c.n === "atlas_launch_id");
    check("calls atlas_launch_id exactly once", L.length === 1);
    check("sends only the library id", JSON.stringify(L[0].a) === JSON.stringify({ id: "steam:359550" }));
    check("sends no path, executable or command line", !JSON.stringify(L[0].a).match(/install_dir|exe_path|\\\\|steam\.exe|rungameid|cmd|\.exe/i));
    check("never uses the legacy appid command", !inv.calls.some((c) => c.n === "atlas_launch"));
    check("no invoke in the whole flow ever carries a path", !JSON.stringify(inv.calls).match(/install_dir|exe_path|steamapps|rungameid|hollow_knight/i));
    check("records a running activity entry", log.some((l) => l.kind === "act" && l.status === "running" && /Launching from ATLAS/.test(l.m)));
    check("marks that same entry done", log.some((l) => l.kind === "actupdate" && /Launching from ATLAS/.test(l.of || "") && l.m === "done"));
    check("keeps the backend's own success text", log.some((l) => l.kind === "toast" && !l.bad && /app 359550/.test(l.m)));
    check("re-reads sessions after a launch", inv.calls.some((c) => c.n === "atlas_sessions"));
    check("refreshes the library in the background", inv.calls.filter((c) => c.n === "atlas_scan").length === 2);
    check("the grid survives the refresh", cards(els.atlasGrid.innerHTML).length === FIXTURE.games.length);
  }

  // ================= launch failure =================
  console.log("\nlaunch failure");
  {
    const inv = backend({ atlas_launch_id: () => { throw new Error("That game is not in the Steam library STRYV can see."); } });
    const { Atlas, els, log } = makeEnv(FIXTURE.games, inv);
    await Atlas.scan(false);
    await flush();
    const before = els.atlasGrid.innerHTML;

    log.length = 0;
    // A hand-added game is launchable too; the backend is what refuses it here.
    els.atlasGrid.querySelectorAll("[data-play]")[names(before).indexOf("Hollow Knight")].onclick();
    await flush();

    check("marks the activity failed", log.some((l) => l.kind === "actupdate" && /Launching from ATLAS/.test(l.of || "") && l.m === "failed"));
    check("keeps the backend error text in the activity detail", log.some((l) => l.kind === "actupdate" && /not in the Steam library/.test(l.detail || "")));
    check("raises an error toast", log.some((l) => l.kind === "toast" && l.bad));
    check("and the toast keeps the backend's wording", log.some((l) => l.kind === "toast" && /not in the Steam library/.test(l.m)));
    check("sends the failure to the technical log", log.some((l) => l.kind === "tech" && l.m === "atlas.launch" && /not in the Steam library/.test(l.err)));
    check("a failed launch does not blank the grid", cards(els.atlasGrid.innerHTML).length === FIXTURE.games.length);
    check("a failed launch changes nothing on screen", els.atlasGrid.innerHTML === before);
    check("a failed launch triggers no rescan", inv.calls.filter((c) => c.n === "atlas_scan").length === 1);
  }

  // ================= guards =================
  console.log("\nguards");
  {
    const inv = backend();
    const { Atlas, els, log } = makeEnv(FIXTURE.games, inv);
    await Atlas.scan(false);
    await flush();
    const grid = els.atlasGrid.innerHTML;
    const orphan = cards(grid)[names(grid).indexOf("Steam entry with no app id")];

    check("an unlaunchable card disables its Play button", /data-play="\d+" disabled/.test(orphan));
    check("a launchable card does not disable it", /data-play="\d+">Play</.test(cardFor(grid, "Hollow Knight")));
    check("a Steam entry with no app id says why on the card", /Steam has no app id for this entry/.test(orphan));
    check("a hand-added entry with no executable says why too", /No executable is recorded/.test(grid));

    log.length = 0;
    els.atlasGrid.querySelectorAll("[data-play]")[names(grid).indexOf("Steam entry with no app id")].onclick();
    await flush();
    check("a disabled card still never reaches the backend", !inv.calls.some((c) => c.n === "atlas_launch_id"));
    check("and explains why", log.some((l) => l.kind === "toast" && l.bad && /cannot be launched/.test(l.m)));

    log.length = 0;
    inv.calls.length = 0;
    await Atlas.launch({ id: "steam:x", launcher: "Steam", app_id: "", name: "no app id" });
    check("refuses a Steam entry with no app id", inv.calls.length === 0 && log.some((l) => l.kind === "toast" && l.bad && /no app id/.test(l.m)));
    await Atlas.launch({ id: "manual:x", launcher: "Manual", app_id: "", name: "no exe", exe_path: "" });
    check("refuses a hand-added entry with no executable", inv.calls.length === 0 && log.some((l) => l.kind === "toast" && l.bad && /No executable is recorded/.test(l.m)));
    await Atlas.launch({ id: "", launcher: "Manual", app_id: "", name: "no id", exe_path: "C:\\a.exe" });
    check("refuses an entry with no library id", inv.calls.length === 0 && log.some((l) => l.kind === "toast" && l.bad && /cannot be launched/.test(l.m)));
    let threw = null;
    try { await Atlas.launch(null); } catch (e) { threw = e; }
    check("refuses a missing game object without throwing", threw === null && inv.calls.length === 0);
  }

  // ================= honest nulls =================
  console.log("\nhonest nulls");
  {
    const { Atlas, els } = makeEnv(FIXTURE.games, backend());
    await Atlas.scan(false);
    await flush();
    const grid = els.atlasGrid.innerHTML;
    const never = cardFor(grid, "Steamworks Common Redistributables");

    check("a reported size reads in MB", /<dt>Size<\/dt><dd>214 MB<\/dd>/.test(never));
    check("an unreported size renders a dash", /<dt>Size<\/dt><dd>—<\/dd>/.test(cardFor(grid, "Hollow Knight")));
    check("an unreported size never reads as a number", !/<dt>Size<\/dt><dd>0/.test(grid));
    check("an unreported size never reads 0 MB", !/<dd>0 MB<\/dd>/.test(grid));
    check("an unreported size never reads 0 GB", !/<dd>0 GB<\/dd>/.test(grid));
    check("a null session length reads not measured", /<dt>Last session<\/dt><dd>not measured<\/dd>/.test(never));
    check("a null session length never prints a number", !/<dt>Last session<\/dt><dd>\d/.test(never));
    check("zero launches is stated as none, not as zero", /<dd>None from ATLAS<\/dd>/.test(never));
    check("one launch is singular", /<dd>1 launch<\/dd>/.test(grid));
    check("several launches are plural", /<dd>3 launches<\/dd>/.test(grid));
    check("a real session reads in minutes", /<dd>10m<\/dd>/.test(cardFor(grid, "Hollow Knight")));
    check("a long session reads in hours and minutes", /<dd>1h 15m<\/dd>/.test(cardFor(grid, "Tom Clancy's Rainbow Six Siege")));
    check("a short session is not rounded to zero", /<dd>1m<\/dd>/.test(cardFor(grid, esc(EVIL_NAME.name))));
  }
  {
    // One game that has never been launched, on its own, so nothing else in the
    // library can contribute play time to the totals.
    const g = [{ id: "steam:1", launcher: "Steam", app_id: "1", name: "Never launched", install_dir: "C:\\S\\N", exe_path: "",
                size_bytes: 1073741824, last_played: 0, source: "detected", favorite: false, hidden: false,
                plays: 0, last_launch: 0, last_session_secs: null, total_secs: 0 }];
    const { Atlas, els } = makeEnv(g, backend({ atlas_scan: () => JSON.parse(JSON.stringify(g)) }));
    await Atlas.scan(false);
    await flush();
    check("a game with no plays contributes no play time", els.atlasTime.textContent === "Not measured");
    check("a game with no plays shows zero launches", els.atlasPlays.textContent === "0");
    check("and says it was never launched from ATLAS", /<dd>None from ATLAS<\/dd>/.test(els.atlasGrid.innerHTML));
    check("and has no measured session", /<dd>not measured<\/dd>/.test(els.atlasGrid.innerHTML));
    check("and was never played", /<dd>Never<\/dd>/.test(els.atlasGrid.innerHTML));
    check("but its reported size is still shown", /<dd>1\.0 GB<\/dd>/.test(els.atlasGrid.innerHTML));
  }

  // ================= empty states =================
  console.log("\nempty states");
  {
    const { Atlas, els } = makeEnv([], backend({ atlas_scan: () => [] }));
    await Atlas.scan(false);
    await flush();
    check("nothing found: the count says none", els.atlasN.textContent === "None found");
    check("nothing found: the summary explains it", /No launcher library files/.test(els.atlasSum.textContent));
    check("nothing found: the empty state is shown", els.atlasEmpty.hidden === false);
    check("nothing found: it says so in its own words", /<b>No games found\.<\/b>/.test(els.atlasEmpty.innerHTML));
    check("nothing found: it points at adding a game by hand", /add it by hand/.test(els.atlasEmpty.innerHTML));
    check("nothing found: no cards and no buttons", cards(els.atlasGrid.innerHTML).length === 0 && els.atlasGrid.querySelectorAll("[data-play]").length === 0);
    check("nothing found: no size total is invented", els.atlasSize.textContent === "—");
    check("nothing found: no play time is invented", els.atlasTime.textContent === "Not measured");
  }
  {
    // invoke is not defined at all, which is the shape a window without the
    // backend actually has. scan() must return quietly.
    const { Atlas, els, log } = makeEnv(FIXTURE.games);
    await Atlas.scan(false);
    await flush();
    check("no backend: the count is a dash, not zero", els.atlasN.textContent === "—");
    check("no backend: the empty state names the cause", els.atlasEmpty.hidden === false && /<b>Backend not connected\.<\/b>/.test(els.atlasEmpty.innerHTML));
    check("no backend: it says nothing can be discovered here", /no connection to it/.test(els.atlasEmpty.innerHTML));
    check("no backend: the summary says the same", /needs the STRYV backend/.test(els.atlasSum.textContent));
    check("no backend: the sessions panel says the same", /not connected in this window/.test(els.atlasSess.innerHTML));
    check("no backend: nothing is logged or toasted", log.length === 0);
    check("no backend: no cards are invented", cards(els.atlasGrid.innerHTML).length === 0);
  }
  {
    const { Atlas, els } = makeEnv(FIXTURE.games, backend());
    await Atlas.scan(false);
    await flush();
    els.atlasQ.value = "zzzz-nothing";
    fire(els.atlasQ, "input");
    await flush();
    check("search matched nothing: the empty state says so", els.atlasEmpty.hidden === false && /Nothing matches/.test(els.atlasEmpty.innerHTML));
    check("search matched nothing: it echoes the term", /zzzz-nothing/.test(els.atlasEmpty.innerHTML));
    check("search matched nothing: it says how many are in the library", new RegExp(FIXTURE.games.length + " games are in the library").test(els.atlasEmpty.innerHTML));
    check("search matched nothing: it says how to clear the search", /Clear the search/.test(els.atlasEmpty.innerHTML));
    check("search matched nothing: the grid is empty", cards(els.atlasGrid.innerHTML).length === 0);
    check("search matched nothing: the count drops to none", els.atlasN.textContent === "None found");
  }

  // ================= search =================
  console.log("\nsearch");
  {
    const inv = backend();
    const { Atlas, els, store } = makeEnv(FIXTURE.games, inv);
    await Atlas.scan(false);
    await flush();
    const now = () => names(els.atlasGrid.innerHTML);
    const type = async (v) => { els.atlasQ.value = v; fire(els.atlasQ, "input"); await flush(); };

    await type("siege");
    check("filters by name", now().join() === "Tom Clancy's Rainbow Six Siege");
    check("the count follows the filter", els.atlasN.textContent === "1 game");
    check("the summary reports how many of how many are shown", new RegExp("1 of " + FIXTURE.games.length + " shown").test(els.atlasSum.textContent));
    check("the search is remembered for the next visit", store.get("atlas.q") === "siege");

await type("manual");
    check("filters by launcher", now().length === 2 && now().sort().join() === "Hand-added entry with no executable,Hollow Knight");
    await type("steamapps");
    check("filters by install path", now().length === 4 && now().every((n) => /Siege|Redistributables|quoted|no app id/.test(n)));
    await type("  SIEGE  ");
    check("the search is trimmed and case-insensitive", now().length === 1);
    check("a single result is counted in the singular", els.atlasN.textContent === "1 game");

    await type("");
    check("clearing the search restores every card", now().length === FIXTURE.games.length);
    check("clearing the search restores the count", els.atlasN.textContent === FIXTURE.games.length + " games");
    check("the empty state hides again", els.atlasEmpty.hidden === true);
    check("searching never hits the backend", inv.calls.filter((c) => c.n === "atlas_scan").length === 1);
  }

  // ================= sort =================
  console.log("\nsort");
  {
    // Four entries with deliberately independent rankings, so each key produces a
    // different order and none of them can pass by accident.
    const g = [
      { id: "steam:1", launcher: "Steam", app_id: "1", name: "Alpha",   install_dir: "C:\\S\\Alpha",   exe_path: "", size_bytes: 2000000000, last_played: 100, plays: 2, last_launch: 300, favorite: false, last_session_secs: null, total_secs: 0 },
      { id: "steam:2", launcher: "Steam", app_id: "2", name: "Bravo",   install_dir: "C:\\S\\Bravo",   exe_path: "", size_bytes: 3000000000, last_played: 50,  plays: 3, last_launch: 50,  favorite: true,  last_session_secs: null, total_secs: 0 },
      { id: "steam:3", launcher: "Steam", app_id: "3", name: "Charlie", install_dir: "C:\\S\\Charlie", exe_path: "", size_bytes: 4000000000, last_played: 300, plays: 1, last_launch: 100, favorite: false, last_session_secs: null, total_secs: 0 },
      { id: "steam:4", launcher: "Steam", app_id: "4", name: "Delta",   install_dir: "C:\\S\\Delta",   exe_path: "", size_bytes: 1000000000, last_played: 200, plays: 4, last_launch: 200, favorite: false, last_session_secs: null, total_secs: 0 },
    ];
    const EXPECT = {
      recent:     "Bravo,Charlie,Delta,Alpha",
      lastLaunch: "Bravo,Alpha,Delta,Charlie",
      name:       "Bravo,Alpha,Charlie,Delta",
      plays:      "Bravo,Delta,Alpha,Charlie",
      size:       "Bravo,Charlie,Alpha,Delta",
    };
    check("each sort key yields a different order", new Set(Object.values(EXPECT)).size === 5);

    const { Atlas, els, store } = makeEnv(g, backend({ atlas_scan: () => JSON.parse(JSON.stringify(g)) }));
    await Atlas.scan(false);
    await flush();
    for (const k of Object.keys(EXPECT)) {
      els.atlasSort.value = k;
      fire(els.atlasSort, "change");
      await flush();
      check("sort by " + k + " orders the grid as documented", names(els.atlasGrid.innerHTML).join() === EXPECT[k]);
      check("sort by " + k + " keeps the favourite on top", names(els.atlasGrid.innerHTML)[0] === "Bravo");
      check("sort by " + k + " is remembered", store.get("atlas.sort") === k);
    }

    // The same library with nothing favourited. Under every key the favourite
    // sits somewhere other than first, so its new first place can only come
    // from the pin -- which is what these two tables are there to show.
    const PLAIN = {
      recent:     "Charlie,Delta,Alpha,Bravo",
      lastLaunch: "Alpha,Delta,Charlie,Bravo",
      name:       "Alpha,Bravo,Charlie,Delta",
      plays:      "Delta,Bravo,Alpha,Charlie",
      size:       "Charlie,Bravo,Alpha,Delta",
    };
    const plain = g.map((x) => Object.assign({}, x, { favorite: false }));
    const p = makeEnv(plain, backend({ atlas_scan: () => JSON.parse(JSON.stringify(plain)) }));
    await p.Atlas.scan(false);
    await flush();
    for (const k of Object.keys(PLAIN)) {
      p.els.atlasSort.value = k;
      fire(p.els.atlasSort, "change");
      await flush();
      check("sort by " + k + " with no favourites drops the pin", names(p.els.atlasGrid.innerHTML).join() === PLAIN[k]);
    }
  }

  // ================= favourites =================
  console.log("\nfavourites");
  {
    const inv = backend({ atlas_set_favorite: () => null });
    const { Atlas, els, log } = makeEnv(FIXTURE.games, inv);
    await Atlas.scan(false);
    await flush();
    const order = () => names(els.atlasGrid.innerHTML);
    check("the favourite card starts starred", /data-fav="\d+" aria-pressed="true" title="Remove from favourites">★</.test(cardFor(els.atlasGrid.innerHTML, "Tom Clancy's Rainbow Six Siege")));
    check("every other card starts unstarred", /aria-pressed="false"/.test(els.atlasGrid.innerHTML));

    const stars = els.atlasGrid.querySelectorAll("[data-fav]");
    check("every star has a handler", stars.every((s) => typeof s.onclick === "function"));
    // The fixture already has one favourite, and it is the most recently played,
    // so this card cannot reach the top by favouriting it -- it must rise above
    // every non-favourite, which is the part the pin is responsible for.
    const was = order().indexOf("Hollow Knight");
    log.length = 0;
    stars[was].onclick();
    await flush();

    const F = inv.calls.filter((c) => c.n === "atlas_set_favorite");
    check("calls atlas_set_favorite exactly once", F.length === 1);
    check("sends the id and the new state", JSON.stringify(F[0].a) === JSON.stringify({ id: "manual:9f2c1a7b", favorite: true }));
    check("the star flips immediately, before the backend answers", stars[was].textContent === "★" && stars[was].getAttribute("aria-pressed") === "true");
    check("the card rises above every non-favourite", order()[1] === "Hollow Knight" && order().indexOf("Hollow Knight") < was);
    check("the already-favourited card stays ahead of it on play date", order()[0] === "Tom Clancy's Rainbow Six Siege");
    check("the re-rendered star is filled and pressed", /data-fav="1" aria-pressed="true" title="Remove from favourites">★</.test(cardFor(els.atlasGrid.innerHTML, "Hollow Knight")));

    // Un-star it again, this time through the freshly rendered button.
    inv.calls.length = 0;
    els.atlasGrid.querySelectorAll("[data-fav]")[1].onclick();
    await flush();
    const U = inv.calls.filter((c) => c.n === "atlas_set_favorite");
    check("un-starring sends the opposite state", U.length === 1 && JSON.stringify(U[0].a) === JSON.stringify({ id: "manual:9f2c1a7b", favorite: false }));
    check("and the card goes back to where it was", order().indexOf("Hollow Knight") === was);
    check("and is unstarred again in the re-render", /data-fav="\d+" aria-pressed="false" title="Add to favourites">☆</.test(cardFor(els.atlasGrid.innerHTML, "Hollow Knight")));
  }
  {
    const inv = backend({ atlas_set_favorite: (a) => { if (a.favorite) throw new Error("the ATLAS store is read-only"); return null; } });
    const { Atlas, els, log } = makeEnv(FIXTURE.games, inv);
    await Atlas.scan(false);
    await flush();
    const i = names(els.atlasGrid.innerHTML).indexOf("Hollow Knight");
    log.length = 0;
    els.atlasGrid.querySelectorAll("[data-fav]")[i].onclick();
    await flush();
    check("a rejected favourite is put back", /aria-pressed="false"/.test(cardFor(els.atlasGrid.innerHTML, "Hollow Knight")));
    check("and the card returns to its old place", names(els.atlasGrid.innerHTML)[0] === "Tom Clancy's Rainbow Six Siege");
    check("and the user is told why", log.some((l) => l.kind === "toast" && l.bad && /read-only/.test(l.m)));
    check("and the failure is logged technically", log.some((l) => l.kind === "tech" && l.m === "atlas.favorite"));
  }

  // ================= adding a game by hand =================
  console.log("\nadding a game by hand");
  {
    const inv = backend({ atlas_add_manual: (a) => ({ id: "manual:new", launcher: "Manual", app_id: "", name: a.name || "thing", install_dir: "C:\\Games\\Thing", exe_path: a.exe_path, size_bytes: 0, last_played: 0, source: "manual" }) });
    const { Atlas, els, log } = makeEnv(FIXTURE.games, inv);
    await Atlas.scan(false);
    await flush();

    check("the add box starts closed", els.atlasAddBox.hidden === true);
    els.atlasAdd.onclick();
    check("Add game opens it", els.atlasAddBox.hidden === false);
    check("and focuses the path field", els.atlasExe.focused === true);
    els.atlasAddNo.onclick();
    check("Cancel closes it", els.atlasAddBox.hidden === true);

    log.length = 0;
    els.atlasAddGo.onclick();
    await flush();
    check("refuses to add without a path", !inv.calls.some((c) => c.n === "atlas_add_manual"));
    check("and says which field is missing", log.some((l) => l.kind === "toast" && l.bad && /\.exe file first/.test(l.m)));

    els.atlasAdd.onclick();
    els.atlasExe.value = "  C:\\Games\\Thing\\thing.exe  ";
    els.atlasName.value = "  Thing  ";
    log.length = 0;
    els.atlasAddGo.onclick();
    await flush();
    const A = inv.calls.filter((c) => c.n === "atlas_add_manual");
    check("calls atlas_add_manual exactly once", A.length === 1);
    check("sends the name and the exe path, trimmed", JSON.stringify(A[0].a) === JSON.stringify({ name: "Thing", exe_path: "C:\\Games\\Thing\\thing.exe" }));
    check("records a running activity entry", log.some((l) => l.kind === "act" && l.status === "running" && /Adding a game/.test(l.m)));
    check("marks it done with the name the backend chose", log.some((l) => l.kind === "actupdate" && /Adding a game/.test(l.of || "") && l.m === "done" && /Thing/.test(l.detail || "")));
    check("tells the user it was added", log.some((l) => l.kind === "toast" && !l.bad && l.m === "Added Thing"));
    check("closes the box", els.atlasAddBox.hidden === true);
    check("clears both fields", els.atlasExe.value === "" && els.atlasName.value === "");
    check("re-reads the library", inv.calls.filter((c) => c.n === "atlas_scan").length === 2);

    els.atlasExe.value = "C:\\Games\\Other\\other.exe";
    els.atlasName.value = "";
    inv.calls.length = 0;
    els.atlasAddGo.onclick();
    await flush();
    const A2 = inv.calls.filter((c) => c.n === "atlas_add_manual");
    check("an empty display name is sent as null", A2.length === 1 && A2[0].a.name === null);
    check("so the backend can fall back to the file name", A2[0].a.exe_path === "C:\\Games\\Other\\other.exe");

    let prevented = 0;
    els.atlasExe.value = "C:\\Games\\Enter\\enter.exe";
    inv.calls.length = 0;
    fire(els.atlasExe, "keydown", { key: "Enter", preventDefault: () => prevented++ });
    await flush();
    check("Enter in the path field submits", inv.calls.some((c) => c.n === "atlas_add_manual"));
    check("and suppresses the browser default", prevented === 1);
    inv.calls.length = 0;
    fire(els.atlasName, "keydown", { key: "a", preventDefault: () => prevented++ });
    await flush();
    check("other keys are left alone", inv.calls.length === 0 && prevented === 1);
  }
  {
    const inv = backend({ atlas_add_manual: () => { throw new Error("C:\\Games\\Thing\\thing.exe is not a file on this PC."); } });
    const { Atlas, els, log } = makeEnv(FIXTURE.games, inv);
    await Atlas.scan(false);
    await flush();
    els.atlasAdd.onclick();
    els.atlasExe.value = "C:\\Games\\Thing\\thing.exe";
    log.length = 0;
    els.atlasAddGo.onclick();
    await flush();
    check("a rejected add keeps the box open", els.atlasAddBox.hidden === false);
    check("a rejected add keeps what you typed", els.atlasExe.value === "C:\\Games\\Thing\\thing.exe");
    check("and shows the backend's own reason", log.some((l) => l.kind === "toast" && l.bad && /is not a file on this PC/.test(l.m)));
    check("and marks the activity failed", log.some((l) => l.kind === "actupdate" && /Adding a game/.test(l.of || "") && l.m === "failed"));
    check("and logs it technically", log.some((l) => l.kind === "tech" && l.m === "atlas.add_manual"));
  }

  // ================= removing and restoring =================
  console.log("\nremoving and restoring");
  {
    let yes = false;
    const inv = backend({ atlas_remove: () => null, atlas_restore: () => null });
    const { Atlas, els, log, store } = makeEnv(FIXTURE.games, inv, { confirm: () => yes });
    await Atlas.scan(false);
    await flush();

    check("the restore link is hidden while nothing is removed", els.atlasRestore.hidden === true);
    check("one Remove per card", els.atlasGrid.querySelectorAll("[data-del]").length === FIXTURE.games.length);

    const dels = els.atlasGrid.querySelectorAll("[data-del]");
    const i = names(els.atlasGrid.innerHTML).indexOf("Steamworks Common Redistributables");
    log.length = 0;
    inv.calls.length = 0;
    dels[i].onclick();
    await flush();
    check("asking first: saying No removes nothing", !inv.calls.some((c) => c.n === "atlas_remove"));
    check("the confirmation names the game", log.some((l) => l.kind === "confirm" && /Steamworks/.test(l.body)));
    check("and warns that nothing is deleted", log.some((l) => l.kind === "confirm" && /Nothing in the Steam install is deleted/.test(l.body)));
    check("a refusal changes nothing on screen", names(els.atlasGrid.innerHTML).length === FIXTURE.games.length);

    yes = true;
    dels[i].onclick();
    await flush();
    const R = inv.calls.filter((c) => c.n === "atlas_remove");
    check("saying Yes calls atlas_remove exactly once", R.length === 1);
    check("sends the id and forget:false, so it stays reversible", JSON.stringify(R[0].a) === JSON.stringify({ id: "steam:228980", forget: false }));
    check("records the removal in the activity feed", log.some((l) => l.kind === "act" && /Removed from ATLAS/.test(l.m)));
    check("tells the user what happened", log.some((l) => l.kind === "toast" && !l.bad && /^Removed /.test(l.m)));
    check("the restore link appears", els.atlasRestore.hidden === false);
    check("and the fact something is hidden is remembered", store.get("atlas.removed") === true);
    check("the library is re-read afterwards", inv.calls.filter((c) => c.n === "atlas_scan").length === 1);

    const j = names(els.atlasGrid.innerHTML).indexOf("Hollow Knight");
    log.length = 0;
    els.atlasGrid.querySelectorAll("[data-del]")[j].onclick();
    await flush();
    check("a hand-added removal says it leaves the ATLAS library", log.some((l) => l.kind === "confirm" && /taken out of your ATLAS library/.test(l.body)));
    check("and carries the hand-added id", inv.calls.filter((c) => c.n === "atlas_remove").slice(-1)[0].a.id === "manual:9f2c1a7b");

    inv.calls.length = 0;
    log.length = 0;
    els.atlasRestore.onclick();
    await flush();
    check("restore calls atlas_restore once", inv.calls.filter((c) => c.n === "atlas_restore").length === 1);
    check("restore sends no arguments at all", inv.calls.find((c) => c.n === "atlas_restore").a === undefined);
    check("restore says nothing is reinstalled", log.some((l) => l.kind === "confirm" && /Nothing is reinstalled/.test(l.body)));
    check("restore clears the remembered flag", store.get("atlas.removed") === false);
    check("and the restore link hides again", els.atlasRestore.hidden === true);
    check("and records the restore", log.some((l) => l.kind === "act" && /Restored removed ATLAS games/.test(l.m)));
  }
  {
    const inv = backend({ atlas_restore: () => { throw new Error("the ATLAS store could not be written"); } });
    const { Atlas, els, log } = makeEnv(FIXTURE.games, inv, { confirm: () => true });
    await Atlas.scan(false);
    await flush();
    els.atlasRestore.hidden = false;
    log.length = 0;
    els.atlasRestore.onclick();
    await flush();
    check("a failed restore reports the error", log.some((l) => l.kind === "toast" && l.bad && /could not be written/.test(l.m)));
    check("and logs it technically", log.some((l) => l.kind === "tech" && l.m === "atlas.restore"));
  }

  // ================= sessions =================
  console.log("\nsessions");
  {
    const sess = [
      { id: "steam:359550:1792033900", game_id: "steam:359550", name: "Tom Clancy's Rainbow Six Siege", launcher: "Steam", started: 1792033900, ended: 0, duration_secs: null, cpu_pct: null, mem_bytes: null, measured: false },
      { id: "manual:9f2c1a7b:1790000000", game_id: "manual:9f2c1a7b", name: "Hollow Knight", launcher: "Manual", started: 1790000000, ended: 1790000610, duration_secs: 610, cpu_pct: 18.5, mem_bytes: 3221225472, measured: true },
    ];
    const inv = backend({ atlas_sessions: () => sess, atlas_clear_sessions: () => null });
    const { Atlas, els, log } = makeEnv(FIXTURE.games, inv);
    await Atlas.scan(false);
    await flush();

    const s = els.atlasSess.innerHTML;
    check("one row per session", (s.match(/class="at-srow"/g) || []).length === 2);
    check("the newest session is first", s.indexOf("Rainbow Six") < s.indexOf("Hollow Knight"));
    const row = s.split('class="at-srow"').slice(1);
    check("an unmeasured session is still marked running", /class="st running"/.test(row[0]));
    check("an unmeasured session says its duration was not measured", /duration not measured/.test(row[0]));
    check("an unmeasured session shows no memory peak", !/peak/.test(row[0]));
    check("an unmeasured session prints no duration at all", !/\d+[sm]\b/.test(row[0]));
    check("a measured session is marked done", /class="st done"/.test(row[1]));
    check("a measured session prints its duration", /10m/.test(row[1]));
    check("a measured session prints its peak memory", /3\.0 GB peak/.test(row[1]));
    check("the launcher is shown with the session", /Steam ·/.test(row[0]) && /Manual ·/.test(row[1]));

    log.length = 0;
    els.atlasSessClr.onclick();
    await flush();
    check("clearing asks first", log.some((l) => l.kind === "confirm" && /Clear session history/.test(l.title)));
    check("and says only play time is lost", log.some((l) => l.kind === "confirm" && /only the measured play time is lost/.test(l.body)));
    check("and that games stay in the library", log.some((l) => l.kind === "confirm" && /Games stay in your library/.test(l.body)));
    check("clearing calls atlas_clear_sessions", inv.calls.filter((c) => c.n === "atlas_clear_sessions").length === 1);
    check("and empties the list", /No sessions recorded yet/.test(els.atlasSess.innerHTML));
    check("and records the clear", log.some((l) => l.kind === "act" && /Cleared ATLAS session history/.test(l.m)));
  }
  {
    const { Atlas, els } = makeEnv(FIXTURE.games, backend());
    await Atlas.scan(false);
    await flush();
    check("with no sessions it says so", /No sessions recorded yet/.test(els.atlasSess.innerHTML));

    const inv = backend();
    const env = makeEnv(FIXTURE.games, inv);
    await env.Atlas.scan(false);
    await flush();
    env.log.length = 0;
    env.els.atlasSessClr.onclick();
    await flush();
    check("clearing an empty history never calls the backend", !inv.calls.some((c) => c.n === "atlas_clear_sessions"));
    check("and says there is nothing to clear", env.log.some((l) => l.kind === "toast" && /no sessions to clear/.test(l.m)));
  }

  // ================= backend failures =================
  console.log("\nbackend failures");
  {
    const inv = backend({ atlas_scan: () => { throw new Error("Could not read the launcher files (access denied)."); } });
    const { Atlas, els, log } = makeEnv(FIXTURE.games, inv);
    await Atlas.scan(false);
    await flush();
    check("a failed first scan reports itself on the page", /<b>Could not read the library\.<\/b>/.test(els.atlasEmpty.innerHTML));
    check("and keeps the backend's own message", /access denied/.test(els.atlasEmpty.innerHTML));
    check("and the message is escaped", !/<img/i.test(els.atlasEmpty.innerHTML));
    check("the count is a dash, not zero", els.atlasN.textContent === "—");
    check("the size total is a dash, not zero", els.atlasSize.textContent === "—");
    check("the failure is in the technical log", log.some((l) => l.kind === "tech" && l.m === "atlas.scan"));
    check("a background failure raises no toast", !log.some((l) => l.kind === "toast"));
    check("no cards are invented", cards(els.atlasGrid.innerHTML).length === 0);

    log.length = 0;
    els.atlasScan.onclick();
    await flush();
    check("a manual failure raises an error toast", log.some((l) => l.kind === "toast" && l.bad && /Could not read the library/.test(l.m)));
    check("and keeps the backend's wording in it", log.some((l) => l.kind === "toast" && /access denied/.test(l.m)));
    check("and leaves the button usable", els.atlasScan.disabled === false && els.atlasScan.textContent === "Rescan");
  }
  {
    // A library the user is already reading must survive a refresh that fails. The
    // launch itself still succeeds; only the rescan it triggers afterwards fails.
    let failScan = false;
    const inv = backend({
      atlas_launch_id: () => "Steam was asked to launch this game.",
      atlas_scan: () => { if (failScan) throw new Error("the launcher files have become unreadable"); return JSON.parse(JSON.stringify(FIXTURE.games)); },
    });
    const { Atlas, els, log } = makeEnv(FIXTURE.games, inv);
    await Atlas.scan(false);
    await flush();
    check("the library is on screen to begin with", cards(els.atlasGrid.innerHTML).length === FIXTURE.games.length);
    failScan = true;
    log.length = 0;
    els.atlasGrid.querySelectorAll("[data-play]")[0].onclick();
    await flush();
    check("the launch still succeeded", log.some((l) => l.kind === "toast" && !l.bad && /Steam was asked/.test(l.m)));
    check("a failed background refresh does not blank the grid", cards(els.atlasGrid.innerHTML).length === FIXTURE.games.length);
    check("it says the refresh failed, not that the library is empty",
      log.some((l) => l.kind === "toast" && l.bad && /Could not refresh the library/.test(l.m)));
    check("and the failure is logged technically", log.some((l) => l.kind === "tech" && l.m === "atlas.scan"));
    check("and the page does not fall back to the no-backend state", !/Backend not connected/.test(els.atlasEmpty.innerHTML));
  }

  // ================= manual rescan =================
  console.log("\nmanual rescan");
  {
    const inv = backend();
    const { Atlas, els, log } = makeEnv(FIXTURE.games, inv);
    await Atlas.scan(false);
    await flush();
    log.length = 0;
    els.atlasScan.onclick();
    await flush();
    check("records the rescan in the activity feed", log.some((l) => l.kind === "act" && /ATLAS library rescan/.test(l.m)));
    check("and reports how many games it found", log.some((l) => l.kind === "act" && new RegExp('"found":' + FIXTURE.games.length).test(l.detail || "")));
    check("tells the user it rescanned", log.some((l) => l.kind === "toast" && !l.bad && l.m === "Library rescanned"));
    check("restores the button label", els.atlasScan.textContent === "Rescan");
    check("re-enables the button", els.atlasScan.disabled === false);
    check("the grid survives a rescan", cards(els.atlasGrid.innerHTML).length === FIXTURE.games.length);
  }

  // ================= changelog =================
  console.log("\nwhat's new log");
  {
    // core.js cannot be loaded wholesale here (it wires the whole UI at parse
    // time), so evaluate just the CHANGELOG literal. That still proves the
    // literal parses and carries the content the What's New page renders.
    const src = fs.readFileSync(path.join(ROOT, "src", "core.js"), "utf8");
    const marker = "const CHANGELOG = ";
    const start = src.indexOf(marker) + marker.length;
    const endIdx = src.indexOf("}];", start);
    if (start < marker.length || endIdx < 0) throw new Error("could not locate the CHANGELOG literal in src/core.js");
    const log = vm.runInNewContext("(" + src.slice(start, endIdx + 2) + ")");
    const VERSION = (src.match(/const VERSION = "([^"]+)"/) || [])[1];

    check("log parses as an array", Array.isArray(log) && log.length > 0);
    const entry = log[0];
    check("entry has a version, date and tag", !!(entry && entry.v && entry.date && entry.tag));
    check("groups is a plain object", !!(entry && entry.groups && typeof entry.groups === "object"));
    check("newest entry is the current version", entry.v === VERSION);
    check("every entry is well formed", log.every((e) => e && e.v && e.date && e.tag && e.groups && typeof e.groups === "object"));
    check("versions run newest first", log.every((e, i) => i === 0 || log[i - 1].v !== e.v));

    const groups = log.map((e) => Object.entries(e.groups));
    check("every group has entries", groups.flat().every(([, items]) => Array.isArray(items) && items.length > 0));
    check("every item is a non-empty string", groups.flat().every(([, items]) => items.every((i) => typeof i === "string" && i.trim().length > 0)));

    // Content assertions search the whole history, not just the newest entry.
    const flat = groups.flat().map(([g, items]) => items.map((i) => g + ": " + i).join("\n")).join("\n");
    check("mentions ATLAS", /ATLAS/.test(flat));
    check("mentions game discovery", /finds installed games/i.test(flat));
    check("mentions launching a game", /Launch a discovered Steam game/i.test(flat));
    check("states Steam-only for ATLAS", /Steam libraries only/.test(flat));
    check("lists the launchers ATLAS does not read yet", /Battle\.net/.test(flat));
    check("records the power-plan rollback fix", /Roll back button/.test(flat));
    check("keeps the Administrator limit", /Administrator rights/.test(flat));
    check("announces signed updates", /signature/i.test(Object.values(entry.groups).flat().join(" ")));

    // The What's New page renders group names as-is; make sure none carry markup.
    check("group names are plain text", groups.flat().every(([g]) => !/[<>]/.test(g)));
    console.log("        entries: " + log.map((e) => e.v).join(", "));
    console.log("        newest groups: " + groups[0].map(([g, i]) => g + "(" + i.length + ")").join(", "));
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();