// AERY frontend tests.
// The point of these is the same as ATLAS's: the vault must never claim to hold
// something it does not, must never lose an edit, and must never escape the
// folder it was given.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const R = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(R, "src", "aery.js"), "utf8");
const HTML = fs.readFileSync(path.join(R, "src", "index.html"), "utf8");

let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  PASS  " + name); } else { fail++; console.log("  FAIL  " + name); } };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- the same minimal DOM the ATLAS suite uses ---------------------------
const IDS = ["aeryQ", "aeryTag", "aeryNew", "aeryPin", "aeryRestore", "aeryDel", "aeryList",
  "aeryCounts", "aeryVaultPath", "aeryTitle", "aerySave", "aeryPlaceholder", "aeryEditor", "aeryContext"];

function makeEl() {
  const el = { dataset: {}, disabled: false, hidden: false, value: "", textContent: "", innerHTML: "",
    _attrs: {}, _listeners: {} };
  el.setAttribute = (k, v) => { el._attrs[k] = String(v); };
  el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null);
  el.addEventListener = (ev, fn) => { (el._listeners[ev] = el._listeners[ev] || []).push(fn); };
  el.focus = () => { el.focused = true; };
  el.closest = () => null;
  return el;
}
const fire = (el, ev, e) => (el._listeners[ev] || []).forEach((fn) => fn(e || {}));

function env(invokeImpl) {
  const els = {};
  for (const id of IDS) els[id] = makeEl();
  els.aeryEditor.hidden = true;
  const log = [];
  const act = new Map();
  let seq = 0;
  const sandbox = {
    document: {
      getElementById: (id) => els[id] || null,
      createElement: (tag) => makeEl({ tag }),
      readyState: "complete",
      addEventListener: (ev, fn) => { if (ev === "DOMContentLoaded") fn(); },
    },
    store: { get: (k, d) => d, set: () => true },
    toast: (m, bad) => log.push({ kind: "toast", m, bad: !!bad }),
    Act: {
      log: (x) => { const e = Object.assign({ id: "a" + ++seq, status: "done" }, x); act.set(e.id, e); log.push({ kind: "act", id: e.id, m: e.text, status: e.status, detail: e.detail }); return e.id; },
      update: (id, p) => log.push({ kind: "actupdate", id, of: (act.get(id) || {}).text, m: p.status, detail: p.detail }),
    },
    Tech: { add: (c, e) => log.push({ kind: "tech", m: c, err: String(e && e.message || e) }) },
    confirmBox: (d) => { log.push({ kind: "confirm", title: d.title, body: d.body }); return Promise.resolve(true); },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    window: { addEventListener: () => {} },
  };
  if (invokeImpl !== undefined) sandbox.invoke = invokeImpl;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  // aery.js hands itself to window, so the harness reads it from there
  const Aery = sandbox.window.Aery;
  return { Aery, els, log };
}

const NOTE = (o) => Object.assign({
  id: "a0000000000000001", title: "Ideas", path: "Ideas.md", folder: "",
  pinned: false, created: 100, modified: 200, size: 20,
  excerpt: "some text", tags: [], links: [], backlinks: [],
}, o);

function backend(over) {
  const calls = [];
  const impl = async (n, a) => {
    calls.push({ n, a });
    if (over && over[n]) return over[n](a);
    if (n === "aery_list") return [];
    if (n === "aery_counts") return { notes: 0, tags: [], folders: [] };
    if (n === "aery_vault_path") return "C:\\Users\\you\\STRYV\\vault";
    return null;
  };
  impl.calls = calls;
  return impl;
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

// ============================================================================
(async () => {
console.log("AERY frontend tests\n");

// ---- page contract --------------------------------------------------------
console.log("page contract");
{
  const used = [...new Set([...SRC.matchAll(/E\("(aery[A-Za-z0-9]+)"\)/g)].map((m) => m[1]))];
  check("Aery touches the elements it declares", used.length >= 10);
  check("every element id Aery uses exists in the page", used.every((id) => HTML.includes('id="' + id + '"')));
  check("the page is a section like every other", /<section id="aery"/.test(HTML));
  check("the editor is a textarea, not a contenteditable blob", /<textarea id="aeryEditor"/.test(HTML));
  check("the editor has no autofocus", !/autofocus/.test(HTML));
  check("Aery is routed as a page", /const PAGES = \[[^\]]*"aery"/.test(fs.readFileSync(path.join(R, "src", "core.js"), "utf8")));
  check("the nav has an Aery entry", /data-p="aery"/.test(HTML));
}

// ---- no backend -----------------------------------------------------------
console.log("\nno backend");
{
  const { Aery, els, log } = env(undefined);
  await Aery.refresh();
  await flush();
  check("it does not throw without a backend", true);
  check("and it logs the failure rather than swallowing it", log.some((l) => l.kind === "tech" && l.m === "aery.list"));
  check("the rail does not pretend to hold notes", !/>\s*\d+\s*<\//.test(els.aeryList.innerHTML));
}

// ---- listing --------------------------------------------------------------
console.log("\nlisting");
{
  const notes = [NOTE({}), NOTE({ id: "a2", title: "<img src=x onerror=alert(1)>", modified: 50, pinned: true, folder: "work" })];
  const { Aery, els } = env(backend({ aery_list: () => notes, aery_counts: () => ({ notes: 2, tags: ["idea"], folders: ["work"] }) }));
  await Aery.refresh();
  await flush();
  check("every note gets a row", (els.aeryList.innerHTML.match(/class="anote/g) || []).length >= 2);
  check("a note title carrying markup is escaped", els.aeryList.innerHTML.includes(esc("<img src=x onerror=alert(1)>")));
  check("the raw payload never reaches the page", !els.aeryList.innerHTML.includes("<img src=x"));
  check("a pinned note is marked", /class="pin"/.test(els.aeryList.innerHTML));
  check("the folder is shown, not just the title", /work/.test(els.aeryList.innerHTML));
  check("the count comes from the backend, not from the row length", /<b>2<\/b>/.test(els.aeryCounts.innerHTML));
  check("the vault path is shown so the user knows where their files are", els.aeryVaultPath.textContent.includes("vault"));
}

// ---- search and tags ------------------------------------------------------
console.log("\nsearch and tags");
{
  const inv = backend({ aery_list: () => [], aery_counts: () => ({ notes: 0, tags: ["deep-work"], folders: [] }) });
  const { Aery, els } = env(inv);
  await Aery.refresh();
  await flush();
  els.aeryQ.value = "  rust  ";
  await Aery.refresh();
  const s = inv.calls.filter((c) => c.n === "aery_list").pop();
  check("a search is sent trimmed", s.a.q === "rust");
  check("no tag filter is sent when none is chosen", s.a.tag === null);
  els.aeryTag.value = "deep-work";
  await Aery.refresh();
  const t = inv.calls.filter((c) => c.n === "aery_list").pop();
  check("a tag filter is sent", t.a.tag === "deep-work");
  check("tags from the vault populate the filter", /deep-work/.test(els.aeryTag.innerHTML));
  check("the tag list offers an all-tags escape", /value="">All tags</.test(els.aeryTag.innerHTML));
}

// ---- opening --------------------------------------------------------------
console.log("\nopening a note");
{
  const note = NOTE({});
  const { Aery, els } = env(backend({
    aery_list: () => [note],
    aery_read: () => ({
      note, content: "---\ntitle: Ideas\n---\n\nsee [[Other note|that one]]\n",
      outgoing: [{ title: "Other note", resolved: "a2", path: "Other note.md" }, { title: "Missing", resolved: null, path: null }],
      backlinks: [NOTE({ id: "a3", title: "Journal" })],
      tags: ["idea"],
    }),
  }));
  await Aery.refresh();
  await flush();
  check("the editor is revealed", els.aeryEditor.hidden === false);
  check("the body is put in the editor", els.aeryEditor.value.includes("[[Other note|that one]]"));
  check("the title goes in the title field", els.aeryTitle.value === "Ideas");
  check("a resolved link is navigable", /data-aeryopen="a2"/.test(els.aeryContext.innerHTML));
  check("an unresolved link is shown as unresolved, not dropped", /unresolved/.test(els.aeryContext.innerHTML));
  check("an unresolved link offers no fake target", !/>Missing<\/span><\/a>|Missing<\/button>/.test(els.aeryContext.innerHTML));
  check("a backlink is listed and navigable", /data-aeryopen="a3"/.test(els.aeryContext.innerHTML));
  check("tags are offered from what the note actually has", /#idea/.test(els.aeryContext.innerHTML));
}

// ---- saving ---------------------------------------------------------------
console.log("\nsaving");
{
  const note = NOTE({});
  const inv = backend({ aery_list: () => [note], aery_read: () => ({ note, content: "one", outgoing: [], backlinks: [], tags: [] }) });
  const { Aery, els, log } = env(inv);
  await Aery.refresh();
  await flush();

  check("a clean note says saved, not unsaved", els.aerySave.textContent === "Saved");

  els.aeryEditor.value = "two";
  fire(els.aeryEditor, "input", {});
  check("typing marks the note dirty immediately", els.aerySave.textContent === "Unsaved");
  check("a dirty note is never labelled saved", els.aerySave.textContent !== "Saved");

  // The autosave timer is real; wait past it.
  await new Promise((r) => setTimeout(r, 1500));
  await flush();
  const w = inv.calls.filter((c) => c.n === "aery_save").pop();
  check("a pause in typing saves on its own", !!w);
  check("what is saved is what was typed", w && w.a.content === "two");
  check("a save carries the note id and nothing else", w && Object.keys(w.a).sort().join(",") === "content,id");
  check("no path or filename is ever sent from the browser", !JSON.stringify(inv.calls).match(/C:\\\\Users/));

  els.aeryEditor.value = "three";
  fire(els.aeryEditor, "input", {});
  await Aery.flush();
  check("an explicit flush saves immediately", inv.calls.filter((c) => c.n === "aery_save").length >= 2);
  check("and the status returns to saved once the write returns", els.aerySave.textContent === "Saved" || els.aerySave.textContent === "Saving");
}

// ---- a save that fails ----------------------------------------------------
console.log("\na save that fails");
{
  const note = NOTE({});
  let failNext = true;
  const inv = backend({
    aery_list: () => [note],
    aery_read: () => ({ note, content: "one", outgoing: [], backlinks: [], tags: [] }),
    aery_save: () => { if (failNext) { failNext = false; throw new Error("the disk is full"); } return null; },
  });
  const { Aery, els, log } = env(inv);
  await Aery.refresh();
  await flush();
  els.aeryEditor.value = "precious unsaved text";
  fire(els.aeryEditor, "input", {});
  await Aery.flush();
  check("a failed save is reported to the user", log.some((l) => l.kind === "toast" && l.bad && /disk is full/.test(l.m)));
  check("a failed save is logged technically", log.some((l) => l.kind === "tech" && l.m === "aery.save"));
  check("a failed save does not claim to be saved", els.aerySave.textContent !== "Saved");
  check("the text is still in the editor, not discarded", els.aeryEditor.value === "precious unsaved text");
}

// ---- creating -------------------------------------------------------------
console.log("\ncreating");
{
  const inv = backend({ aery_create: () => NOTE({ id: "anew", title: "Untitled", path: "Untitled.md" }) });
  const { Aery, log } = env(inv);
  await Aery.create();
  const c = inv.calls.filter((x) => x.n === "aery_create").pop();
  check("a new note is asked for with a title", !!c);
  check("creating is recorded in the activity feed", log.some((l) => l.kind === "act" && /New Aery note/.test(l.m)));
  check("the user is told it worked", log.some((l) => l.kind === "toast" && !l.bad && /created/i.test(l.m)));
}
{
  const inv = backend({ aery_create: () => { throw new Error("cannot write there"); } });
  const { Aery, log } = env(inv);
  await Aery.create();
  check("a failed create is reported", log.some((l) => l.kind === "toast" && l.bad && /cannot write there/.test(l.m)));
  check("a failed create is logged", log.some((l) => l.kind === "tech" && l.m === "aery.create"));
  check("a failed create is marked failed in the feed", log.some((l) => l.kind === "actupdate" && l.m === "failed"));
}

// ---- rename, pin, delete --------------------------------------------------
console.log("\nrenaming, pinning, deleting");
{
  const note = NOTE({});
  const inv = backend({ aery_list: () => [note], aery_read: () => ({ note, content: "x", outgoing: [], backlinks: [], tags: [] }) });
  const { Aery, els } = env(inv);
  await Aery.refresh();
  await flush();
  els.aeryTitle.value = "  Better name  ";
  fire(els.aeryTitle, "change", {});
  await flush();
  const r = inv.calls.filter((c) => c.n === "aery_rename").pop();
  check("a rename sends the trimmed title", r && r.a.title === "Better name");
  check("a rename sends only the id and the title", r && Object.keys(r.a).sort().join(",") === "id,title");
}
{
  const note = NOTE({});
  const inv = backend({
    aery_list: () => [note],
    aery_read: () => ({ note, content: "x", outgoing: [], backlinks: [], tags: [] }),
    aery_rename: () => { throw new Error("a note with that name already exists"); },
  });
  const { Aery, els, log } = env(inv);
  await Aery.refresh();
  await flush();
  els.aeryTitle.value = "Taken";
  fire(els.aeryTitle, "change", {});
  await flush();
  check("a refused rename is reported", log.some((l) => l.kind === "toast" && l.bad && /already exists/.test(l.m)));
}
{
  const inv = backend({ aery_set_pinned: () => null });
  const { Aery } = env(inv);
  await Aery.refresh();
  await flush();
  await Aery.open && null;
  const before = inv.calls.filter((c) => c.n === "aery_set_pinned").length;
  check("pinning starts from what the note actually says", before === 0);
}
{
  const note = NOTE({});
  const inv = backend({
    aery_list: () => [note],
    aery_read: () => ({ note, content: "x", outgoing: [], backlinks: [], tags: [] }),
    aery_delete: () => null,
  });
  const { Aery, els, log } = env(inv);
  await Aery.refresh();
  await flush();
  fire(els.aeryDel, "click", { preventDefault() {}, stopPropagation() {} });
  await flush();
  check("deleting asks first", log.some((l) => l.kind === "confirm"));
  check("the confirmation says it is a move, not an erase", /not deleted|moved/i.test(log.find((l) => l.kind === "confirm").body));
  check("the user is told nothing was erased", log.some((l) => l.kind === "toast" && /trash/i.test(l.m)));
  check("the activity entry says what happened", log.some((l) => l.kind === "actupdate" && /trash/i.test(l.detail || "")));
}

// ---- restoring ------------------------------------------------------------
console.log("\nrestoring");
{
  const inv = backend({ aery_restore: () => 3 });
  const { Aery, els, log } = env(inv);
  await Aery.refresh();
  await flush();
  fire(els.aeryRestore, "click", { preventDefault() {}, stopPropagation() {} });
  await flush();
  check("restore asks first", log.some((l) => l.kind === "confirm"));
  const c = log.find((l) => l.kind === "confirm");
  check("restore says nothing is downloaded or recreated", /Nothing is downloaded or recreated/i.test(c.body));
  check("a restore that worked says how many came back", log.some((l) => l.kind === "toast" && /3 notes restored/.test(l.m)));
}
{
  const inv = backend({ aery_restore: () => 0 });
  const { Aery, els, log } = env(inv);
  await Aery.refresh();
  await flush();
  fire(els.aeryRestore, "click", { preventDefault() {}, stopPropagation() {} });
  await flush();
  check("an empty trash says there was nothing to restore", log.some((l) => l.kind === "toast" && /nothing in the trash/i.test(l.m)));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
})();