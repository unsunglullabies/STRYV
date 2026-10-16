"use strict";
// Tests the shipped frontend file src/atlas.js in a minimal fake DOM.
//
// Covers discovery rendering and the launch request the frontend makes. It does
// NOT cover the Rust Valve-KeyValues parser or the Rust-side launch validation
// (numeric parse, allowlist against the scanned library, steam:// construction).
// Those need `cargo test`, which cannot run until a Rust toolchain exists.
//
// Run: npm test
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "atlas-games.json"), "utf8"));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name); }
}

// --- minimal DOM ------------------------------------------------------------
const IDS = ["atlasN", "atlasSum", "atlasSize", "atlasT", "atlasNote", "atlasScan"];

function tableEl() {
  const el = { textContent: "", _html: "", _cache: {} };
  // A real Element returns the same node objects on repeated querySelectorAll,
  // and throws the old ones away when innerHTML is reassigned. Mirror that so
  // onclick handlers bound at render time survive until the next render.
  Object.defineProperty(el, "innerHTML", {
    get() { return this._html; },
    set(v) { this._html = v; this._cache = {}; },
    enumerable: true,
  });
  const nodes = () => {
    const re = /data-play="([^"]*)"/g;
    const found = [];
    let m;
    while ((m = re.exec(el._html))) found.push(m[1]);
    return found;
  };
  el.querySelectorAll = (sel) => {
    if (!/data-play/.test(sel)) return [];
    return nodes().map((i) => (el._cache[i] = el._cache[i] || makeEl(i)));
  };
  el.querySelector = (sel) => {
    const want = /data-play="([^"]*)"/.exec(sel);
    if (!want) return null;
    return el._cache[want[1]] || null;
  };
  return el;
}
function makeEl(datasetPlay) {
  return { dataset: datasetPlay === undefined ? {} : { play: datasetPlay }, disabled: false, textContent: "", innerHTML: "", onclick: null };
}

function makeEnv(games, invokeImpl) {
  const els = {};
  for (const id of IDS) els[id] = id === "atlasT" ? tableEl() : makeEl();
  const log = [];
  const sandbox = {
    q: (id) => els[id] || null,
    esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
    toast: (m, bad) => log.push({ kind: "toast", m, bad: !!bad }),
    Act: {
      log: (o) => { const e = Object.assign({ status: "done" }, o); log.push({ kind: "act", m: e.text, status: e.status }); return e.id; },
      update: (id, p) => log.push({ kind: "actupdate", m: p.status, detail: p.detail }),
    },
    Tech: { add: (c) => log.push({ kind: "tech", m: c }) },
    invoke: invokeImpl,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "atlas.js"), "utf8"), sandbox);
  sandbox.Atlas = vm.runInContext("Atlas", sandbox);
  return { Atlas: sandbox.Atlas, els, log, games };
}

const rows = (html) => (html.match(/<tr>/g) || []).length;
const gbid = (b) => (b / 1073741824).toFixed(1) + " GB";
const okInvoke = (games) => async (n) => {
  if (n === "atlas_scan") return JSON.parse(JSON.stringify(games));
  throw new Error("unexpected invoke: " + n);
};

(async () => {
  console.log("ATLAS frontend tests\n");

  // ================= discovery rendering =================
  console.log("discovery rendering");
  {
    const { Atlas, els, log } = makeEnv(FIXTURE.games, okInvoke(FIXTURE.games));
    await Atlas.scan(false);

    const total = FIXTURE.games.reduce((a, g) => a + g.size_bytes, 0);
    check("counts the games", els.atlasN.textContent === FIXTURE.games.length + " games");
    check("names the launchers it found", /Steam/.test(els.atlasSum.textContent) && /Epic/.test(els.atlasSum.textContent));
    check("renders one row per game", rows(els.atlasT.innerHTML) === FIXTURE.games.length);
    check("total size matches the sum", els.atlasSize.textContent === gbid(total));
    check("large sizes use GB", /GB$/.test(els.atlasSize.textContent));
    check("never-played is labelled", els.atlasT.innerHTML.includes("Never played"));
    check("empty size renders a dash", els.atlasT.innerHTML.includes("—"));
    check("note explains launching goes through Steam", /link handler/.test(els.atlasNote.innerHTML));
    check("note lists launchers not yet read", /Battle\.net/.test(els.atlasNote.innerHTML));

    // escaping
    check("markup is escaped to an entity, not a tag", /&lt;img/.test(els.atlasT.innerHTML));
    check("no live <img> tag survives", !/<img/i.test(els.atlasT.innerHTML));
    check("no <script> tag survives", !/<script/i.test(els.atlasT.innerHTML));

    log.length = 0;
    els.atlasScan.onclick();
    await new Promise((r) => setTimeout(r, 20));
    check("manual rescan records activity", log.some((l) => l.kind === "act"));
    check("manual rescan restores button label", els.atlasScan.textContent === "Rescan library");
    check("manual rescan re-enables button", els.atlasScan.disabled === false);
  }

  // ================= launch affordance =================
  console.log("\nlaunch affordance");
  {
    const { Atlas, els } = makeEnv(FIXTURE.games, okInvoke(FIXTURE.games));
    await Atlas.scan(false);
    const buttons = els.atlasT.querySelectorAll("[data-play]");
    check("Play appears only for launchable games", buttons.length === 3);
    check("Play is offered for the first Steam game", els.atlasT.innerHTML.includes('data-play="0"'));
    check("no Play for the non-Steam game", !els.atlasT.innerHTML.includes('data-play="3"'));
    check("every Play button has an onclick", buttons.every((b) => typeof b.onclick === "function"));
  }

  // ================= launching =================
  console.log("\nlaunching");
  {
    const calls = [];
    const { Atlas, els, log } = makeEnv(FIXTURE.games, async (n, args) => {
      calls.push({ n, args });
      if (n === "atlas_scan") return JSON.parse(JSON.stringify(FIXTURE.games));
      if (n === "atlas_launch") return "Steam was asked to launch this game (app " + args.appid + ").";
      throw new Error("unexpected invoke: " + n);
    });
    await Atlas.scan(false);
    log.length = 0;
    // Click the real button, exactly as a user would.
    els.atlasT.querySelectorAll("[data-play]")[0].onclick();
    await new Promise((r) => setTimeout(r, 20));

    check("calls atlas_launch exactly once", calls.filter((c) => c.n === "atlas_launch").length === 1);
    check("sends only the app id", JSON.stringify(calls.find((c) => c.n === "atlas_launch").args) === '{"appid":"359550"}');
    check("sends no path or command", !JSON.stringify(calls.find((c) => c.n === "atlas_launch").args).match(/install_dir|\\\\|steam\.exe|cmd/i));
    check("records a running activity entry", log.some((l) => l.kind === "act" && l.status === "running"));
    check("marks the activity done", log.some((l) => l.kind === "actupdate" && l.m === "done"));
    check("shows a success toast", log.some((l) => l.kind === "toast" && !l.bad));
  }

  // ================= launch failure =================
  console.log("\nlaunch failure");
  {
    const { Atlas, els, log } = makeEnv(FIXTURE.games, async (n) => {
      if (n === "atlas_scan") return JSON.parse(JSON.stringify(FIXTURE.games));
      if (n === "atlas_launch") throw new Error("That game is not in the Steam library STRYV can see.");
      throw new Error("unexpected invoke: " + n);
    });
    await Atlas.scan(false);
    log.length = 0;
    await Atlas.launch(JSON.parse(JSON.stringify(FIXTURE.games))[1]);

    check("marks the activity failed", log.some((l) => l.kind === "actupdate" && l.m === "failed"));
    check("keeps the backend error text", log.some((l) => l.kind === "actupdate" && /not in the Steam library/.test(l.detail || "")));
    check("raises an error toast", log.some((l) => l.kind === "toast" && l.bad));
    check("sends the failure to the technical log", log.some((l) => l.kind === "tech" && l.m === "atlas.launch"));
  }

  // ================= refuses to launch an unlaunchable game =================
  console.log("\nguards");
  {
    const calls = [];
    const { Atlas, log } = makeEnv(FIXTURE.games, async (n) => {
      calls.push(n);
      if (n === "atlas_scan") return JSON.parse(JSON.stringify(FIXTURE.games));
      throw new Error("should not be reached");
    });
    await Atlas.scan(false);
    log.length = 0;
    const epic = JSON.parse(JSON.stringify(FIXTURE.games))[3];
    await Atlas.launch(epic);
    check("does not invoke the backend for a non-Steam game", calls.filter((n) => n === "atlas_launch").length === 0);
    check("explains why it cannot launch it", log.some((l) => l.kind === "toast" && l.bad && /cannot be launched/.test(l.m)));

    const noId = { launcher: "Steam", app_id: "", name: "x" };
    await Atlas.launch(noId);
    check("refuses a Steam entry with no app id", calls.filter((n) => n === "atlas_launch").length === 0);
    await Atlas.launch(null);
    check("refuses a missing game object", calls.filter((n) => n === "atlas_launch").length === 0);
  }

  // ================= empty library =================
  console.log("\nempty library");
  {
    const { Atlas, els } = makeEnv([], async () => []);
    await Atlas.scan(false);
    check("says none found", els.atlasN.textContent === "None found");
    check("explains why", /No launcher library files/.test(els.atlasSum.textContent));
    check("no size total", els.atlasSize.textContent === "—");
    check("placeholder row shown", rows(els.atlasT.innerHTML) === 1);
    check("no Play buttons", els.atlasT.querySelectorAll("[data-play]").length === 0);
  }

  // ================= backend unavailable =================
  console.log("\nbackend failures");
  {
    const { Atlas, els, log } = makeEnv(FIXTURE.games, async () => { throw new Error("backend missing"); });
    await Atlas.scan(false);
    check("scan failure reported to the user", /Could not read the library/.test(els.atlasT.innerHTML));
    check("scan failure logged", log.some((l) => l.kind === "tech" && l.m === "atlas.scan"));
    check("scan failure clears the stale note", els.atlasNote.textContent === "");
  }
  {
    const { Atlas, els } = makeEnv([], null); // no invoke at all
    await Atlas.scan(false);
    check("missing backend reported", /backend is not connected/.test(els.atlasT.innerHTML));
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
