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
  "aeryCounts", "aeryVaultPath", "aeryTitle", "aerySave", "aeryPlaceholder", "aeryEditor", "aeryContext",
  "aeryTabs", "aeryBar", "aeryGraph", "aeryViewNotes", "aeryViewGraph", "aeryPreview", "aeryRead",
  "aeryFolderSel", "aeryFolderNew", "aeryFolderForm", "aeryFolderName", "aeryFolderAdd", "aeryFolderCancel",
  "aeryFolders", "aeryFolderRename", "aeryViewStudy", "aeryStudy", "aeryStudyRail", "aeryCardSel",
  "aeryExportNote", "aeryExportVault", "aeryImport", "aeryImportFolder", "aeryIoMsg", "aeryTools"];

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
  check("every element id Aery uses exists in the page", used.filter((id) => !id.startsWith("st") && id !== "aeryFolderRename").every((id) => HTML.includes('id="' + id + '"')));
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
// ---- unsaved edits and refreshes -----------------------------------------
// Pinning and renaming both reopen the current note. Reopening used to read the
// on-disk text over a dirty buffer and then report "Saved", so anything typed
// inside the autosave window vanished.
console.log("\nunsaved edits survive a refresh");
{
  const note = NOTE({});
  let disk = "one";
  const inv = backend({
    aery_list: () => [note],
    aery_read: () => ({ note, content: disk, outgoing: [], backlinks: [], tags: [] }),
    aery_save: (a) => { disk = a.content; return null; },
    aery_set_pinned: () => null,
  });
  const { Aery, els } = env(inv);
  await Aery.refresh();
  await flush();
  els.aeryEditor.value = "typed, not yet autosaved";
  fire(els.aeryEditor, "input", {});
  fire(els.aeryPin, "click", { preventDefault() {}, stopPropagation() {} });
  await flush();
  check("pinning writes the pending edit first",
    inv.calls.some((c) => c.n === "aery_save" && c.a.content === "typed, not yet autosaved"));
  check("the edited text is not replaced by stale on-disk text",
    els.aeryEditor.value === "typed, not yet autosaved");
  check("the note is not left labelled Unsaved after its save landed",
    els.aerySave.textContent === "Saved");
}
{
  const note = NOTE({});
  let disk = "old body";
  const order = [];
  const inv = backend({
    aery_list: () => [note],
    aery_read: () => ({ note, content: disk, outgoing: [], backlinks: [], tags: [] }),
    aery_save: (a) => { order.push("save"); disk = a.content; return null; },
    aery_rename: () => { order.push("rename"); return null; },
  });
  const { Aery, els } = env(inv);
  await Aery.refresh();
  await flush();
  els.aeryEditor.value = "unsaved before rename";
  fire(els.aeryEditor, "input", {});
  els.aeryTitle.value = "Better title";
  fire(els.aeryTitle, "change", {});
  await flush();
  check("renaming writes the pending edit first",
    order.indexOf("save") >= 0 && order.indexOf("save") < order.indexOf("rename"));
}
{
  const note = NOTE({});
  const inv = backend({
    aery_list: () => [note],
    aery_read: () => ({ note, content: "one", outgoing: [], backlinks: [], tags: [] }),
    aery_save: () => { throw new Error("the disk is full"); },
    aery_set_pinned: () => null,
  });
  const { Aery, els, log } = env(inv);
  await Aery.refresh();
  await flush();
  els.aeryEditor.value = "precious";
  fire(els.aeryEditor, "input", {});
  fire(els.aeryPin, "click", { preventDefault() {}, stopPropagation() {} });
  await flush();
  check("a refresh that cannot save refuses to reopen the note",
    log.some((l) => l.kind === "toast" && l.bad && /not reopened/i.test(l.m)));
  check("and the unsaved text stays in the editor", els.aeryEditor.value === "precious");
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

// ---- tabs -----------------------------------------------------------------
console.log("\ntabs");
{
  const a = NOTE({ id: "idA", title: "Alpha" });
  const b = NOTE({ id: "idB", title: "Beta" });
  const inv = backend({
    aery_list: () => [a, b],
    aery_read: (x) => ({
      note: x.id === "idA" ? a : b,
      content: "text " + x.id, outgoing: [], backlinks: [], tags: [],
    }),
  });
  const { Aery, els } = env(inv);
  await Aery.refresh();
  await flush();
  await Aery.open("idB");
  await flush();
  check("opening a second note adds a tab", Aery.tabs().length === 2);
  check("both titles are in the tab strip", els.aeryTabs.innerHTML.includes("Alpha") && els.aeryTabs.innerHTML.includes("Beta"));
  check("the active tab is the one just opened", /atab on[\s\S]*Beta/.test(els.aeryTabs.innerHTML));
  await Aery.closeTab("idB");
  await flush();
  check("closing the active tab falls back to the one before it", Aery.current() === "idA");
  check("the closed note is gone from the strip", !els.aeryTabs.innerHTML.includes("Beta"));
  check("and its text is not left on screen", els.aeryEditor.value === "text idA");
}
{
  const a = NOTE({ id: "idA", title: "Alpha" });
  const inv = backend({
    aery_list: () => [a],
    aery_read: () => ({ note: a, content: "x", outgoing: [], backlinks: [], tags: [] }),
    aery_save: () => { throw new Error("disk full"); },
  });
  const { Aery, els, log } = env(inv);
  await Aery.refresh();
  await flush();
  els.aeryEditor.value = "edited";
  fire(els.aeryEditor, "input");
  await Aery.closeTab("idA");
  await flush();
  check("a tab holding an unsaved edit refuses to close", Aery.tabs().includes("idA"));
  check("and says the text was not lost", log.some((l) => l.kind === "toast" && /Nothing was lost/.test(l.m)));
}

// ---- graph ----------------------------------------------------------------
console.log("\ngraph");
{
  const inv = backend({
    aery_list: () => [NOTE({})],
    aery_read: () => ({ note: NOTE({}), content: "", outgoing: [], backlinks: [], tags: [] }),
    aery_graph: () => ({
      nodes: [
        { id: "a", title: "One", folder: "" },
        { id: "b", title: "Two <script>", folder: "ideas", pinned: true },
      ],
      edges: [{ from: "a", to: "b" }],
    }),
  });
  const { Aery, els } = env(inv);
  await Aery.graph();
  await flush();
  check("the graph asks the backend for links", inv.calls.some((c) => c.n === "aery_graph"));
  check("one edge is drawn as one line", (els.aeryGraph.innerHTML.match(/<line /g) || []).length === 1);
  check("every note is a node", (els.aeryGraph.innerHTML.match(/<circle /g) || []).length === 2);
  check("a title is escaped, never live markup", !/<script>/.test(els.aeryGraph.innerHTML) && els.aeryGraph.innerHTML.includes("Two &lt;script&gt;"));
  check("a pinned note is marked", /ag-node pin/.test(els.aeryGraph.innerHTML));
  check("the accessible name carries the counts", /2 notes, 1 links/.test(els.aeryGraph.innerHTML));
}
{
  const inv = backend({
    aery_graph: () => ({
      nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    }),
  });
  const { Aery, els } = env(inv);
  await Aery.graph();
  await flush();
  check("reciprocal links are drawn apart, not stacked on one line", (els.aeryGraph.innerHTML.match(/<path class="ag-edge"/g) || []).length === 2);
}
{
  const inv = backend({ aery_graph: () => ({ nodes: [], edges: [] }) });
  const { Aery, els } = env(inv);
  await Aery.graph();
  await flush();
  check("an empty vault says so instead of drawing nothing", /No notes yet/.test(els.aeryGraph.innerHTML));
}
{
  const inv = backend({ aery_graph: () => { throw new Error("vault unreadable"); } });
  const { Aery, els, log } = env(inv);
  await Aery.graph();
  await flush();
  check("a failed graph read says the graph could not be read", /could not be read/.test(els.aeryGraph.innerHTML));
  check("and the failure is logged, not swallowed", log.some((l) => l.kind === "tech" && l.m === "aery.graph"));
}

// ---- markdown preview -----------------------------------------------------
console.log("\nmarkdown preview");
{
  const { Aery } = env(backend());
  const notes = [NOTE({ id: "n2", title: "Other note" })];
  const html = (s) => Aery.md(s, notes);

  check("a heading becomes a heading, not a paragraph with hashes", /<h2>Plan<\/h2>/.test(html("## Plan")));
  check("paragraphs are separated", /<p>one<\/p>[\s\S]*<p>two<\/p>/.test(html("one\n\ntwo")));
  check("bold and italic are rendered", /<b>loud<\/b>/.test(html("**loud**")) && /<i>soft<\/i>/.test(html("*soft*")));
  check("a fenced block is code, and its markup is not interpreted",
    /<pre class="md-code"><code data-lang="js">/.test(html("```js\nif (a < b) **no**\n```")) &&
    html("```js\nif (a < b)\n```").includes("a &lt; b") &&
    !/<b>no<\/b>/.test(html("```js\n**no**\n```")));
  check("inline code is not turned into emphasis", /<code>\*not italic\*<\/code>/.test(html("`*not italic*`")));
  check("lists become lists", /<ul><li>one<\/li><li>two<\/li><\/ul>/.test(html("- one\n- two")));
  check("ordered lists keep their order", /<ol><li>one<\/li><li>two<\/li><\/ol>/.test(html("1. one\n2. two")));
  check("task lists render a disabled checkbox", /<input type="checkbox" disabled checked>/.test(html("- [x] done")));
  check("quotes become blockquotes", /<blockquote>said<\/blockquote>/.test(html("> said")));
  check("a horizontal rule is a rule", /<hr>/.test(html("---")));

  check("raw HTML in a note is escaped, never live", !/<script>/.test(html("<script>alert(1)</script>")) && html("<script>").includes("&lt;script&gt;"));
  check("a javascript: link is shown as text, not made clickable",
    !/href="javascript:/.test(html("[click](javascript:alert(1))")) && /blocked/.test(html("[click](javascript:alert(1))")));
  check("a https link is clickable", /href="https:\/\/example.com"/.test(html("[site](https://example.com)")));

  check("a wikilink to a real note is navigable", /<a class="md-link" data-aeryopen="n2"[^>]*>Other note<\/a>/.test(html("[[Other note]]")));
  check("a wikilink with an alias keeps the shown text but the real target", /data-aeryopen="n2"[^>]*>that one<\/a>/.test(html("[[Other note|that one]]")));
  check("an unresolved wikilink is marked, not invented", /unresolved/.test(html("[[Nope]]")) && !/data-aeryopen/.test(html("[[Nope]]")));
  check("wikilink matching ignores case", /data-aeryopen="n2"/.test(html("[[other NOTE]]")));
  check("front matter is not rendered as prose", !html("---\ntitle: Ideas\n---\n\nbody").includes("title: Ideas"));

  const empty = html("");
  check("an empty note renders nothing rather than a broken tag", empty === "");
}

// ---- reading mode ----------------------------------------------------------
console.log("\nreading mode");
{
  const note = NOTE({ id: "n1" });
  const body = "---\ntitle: Ideas\n---\n\n# Ideas\n\nsee [[n2]]\n";
  const other = NOTE({ id: "n2", title: "n2" });
  const inv = backend({
    aery_list: () => [note, other],
    aery_read: () => ({ note, content: body, outgoing: [], backlinks: [], tags: [] }),
  });
  const { Aery, els } = env(inv);
  await Aery.refresh();
  await flush();

  check("opening a note starts in edit mode", els.aeryEditor.hidden === false && els.aeryPreview.hidden === true);
  check("the read control appears with a note open", els.aeryRead.hidden === false);

  Aery.setReading(true);
  check("reading hides the editor", els.aeryEditor.hidden === true);
  check("reading shows the rendered pane", els.aeryPreview.hidden === false);
  check("the pane contains rendered Markdown, not the raw buffer", /<h1>Ideas<\/h1>/.test(els.aeryPreview.innerHTML));
  check("a wikilink in the body is clickable", /data-aeryopen=/.test(els.aeryPreview.innerHTML));
  check("the toggle now offers editing", els.aeryRead.textContent === "Edit");

  Aery.setReading(false);
  check("going back reveals the editor again", els.aeryEditor.hidden === false && els.aeryPreview.hidden === true);
  check("and the buffer was never changed by reading", els.aeryEditor.value === body);
}

// ---- folders ---------------------------------------------------------------
console.log("\nfolders");
{
  const note = NOTE({ id: "f1", folder: "work" });
  const inv = backend({
    aery_list: () => [note],
    aery_counts: () => ({ notes: 1, tags: [], folders: ["work", "empty"] }),
    aery_read: () => ({ note, content: "", outgoing: [], backlinks: [], tags: [] }),
    aery_set_folder: () => null,
    aery_mkdir: (a) => a.path,
  });
  const { Aery, els, log } = env(inv);
  await Aery.refresh();
  await flush();

  check("the folder picker offers the vault root", /<option value="">Vault root<\/option>/.test(els.aeryFolderSel.innerHTML));
  check("the picker includes a folder with no notes in it", /empty/.test(els.aeryFolderSel.innerHTML));
  check("the open note's own folder is selected", els.aeryFolderSel.value === "work");

  els.aeryFolderSel.value = "empty";
  fire(els.aeryFolderSel, "change", {});
  await flush();
  const m = inv.calls.filter((c) => c.n === "aery_set_folder").pop();
  check("moving sends the note id and the chosen folder", m && m.a.id === "f1" && m.a.folder === "empty");
  check("the note is re-read after the move, not closed", inv.calls.filter((c) => c.n === "aery_read").length >= 2);

  fire(els.aeryFolderNew, "click", {});
  check("the new-folder form opens", els.aeryFolderForm.hidden === false);
  els.aeryFolderName.value = "  ideas  ";
  fire(els.aeryFolderAdd, "click", {});
  await flush();
  const mk = inv.calls.filter((c) => c.n === "aery_mkdir").pop();
  check("a new folder is created with a trimmed name", mk && mk.a.path === "ideas");
  check("the form closes after a successful create", els.aeryFolderForm.hidden === true);

  fire(els.aeryFolderNew, "click", {});
  els.aeryFolderName.value = "   ";
  const before = inv.calls.filter((c) => c.n === "aery_mkdir").length;
  fire(els.aeryFolderAdd, "click", {});
  await flush();
  check("an empty folder name never reaches the backend", inv.calls.filter((c) => c.n === "aery_mkdir").length === before);
  check("and the refusal says why", log.some((l) => l.kind === "toast" && l.bad && /needs a name/.test(l.m)));
}

// ---- folder rename and delete ---------------------------------------------
console.log("\nfolder management");
{
  const note = { id: "f1", title: "One", path: "work/a.md", folder: "work", pinned: false, created: 1, modified: 1, size: 3, excerpt: "", tags: [], links: [], backlinks: [] };
  const inv = backend({
    aery_list: () => [note],
    aery_counts: () => ({ notes: 1, tags: [], folders: ["work"] }),
    aery_read: () => ({ note, content: "", outgoing: [], backlinks: [], tags: [] }),
    aery_rename_folder: (a) => a.to,
    aery_delete_folder: () => ({ deleted: true, moved: 1, notes: 1 }),
  });
  const { Aery, els } = env(inv);
  await Aery.refresh();
  await flush();

  const target = (map) => ({
    closest: (sel) => {
      for (const k of Object.keys(map)) {
        if (sel.includes("[" + k)) {
          return { hasAttribute: (a) => a === k, getAttribute: (a) => (a === k ? map[k] : null) };
        }
      }
      return null;
    },
  });

  check("the folder list names every folder", /work/.test(els.aeryFolders.innerHTML));
  check("and offers folder actions", /data-afmenu="work"/.test(els.aeryFolders.innerHTML));
  fire(els.aeryFolders, "click", { target: target({ "data-afmenu": "work" }) });
  check("the menu offers rename and delete", /data-afrename="work"/.test(els.aeryFolders.innerHTML) && /data-afdel="work"/.test(els.aeryFolders.innerHTML));

  fire(els.aeryFolders, "click", { target: target({ "data-afrename": "work" }) });
  check("rename opens with the current name", /aeryFolderRename/.test(els.aeryFolders.innerHTML));
  els.aeryFolderRename.value = "projects";
  fire(els.aeryFolders, "click", { target: target({ "data-afrenameok": "work" }) });
  await flush();
  const rn = inv.calls.filter((c) => c.n === "aery_rename_folder").pop();
  check("rename sends both names to the backend", rn && rn.a.from === "work" && rn.a.to === "projects");

  fire(els.aeryFolders, "click", { target: target({ "data-afdel": "work" }) });
  check("delete asks before touching anything", /Delete work\?/.test(els.aeryFolders.innerHTML));
  check("and says where the notes will go", /vault root/.test(els.aeryFolders.innerHTML));
  const callsBefore = inv.calls.filter((c) => c.n === "aery_delete_folder").length;
  check("the first click alone deletes nothing", callsBefore === 0);

  fire(els.aeryFolders, "click", { target: target({ "data-afdelok": "work" }) });
  await flush();
  const del = inv.calls.filter((c) => c.n === "aery_delete_folder").pop();
  check("confirming moves the notes out instead of erasing them", del && del.a.folder === "work" && del.a.moveTo === "");
}

// ---- study ----------------------------------------------------------------
console.log("\nstudy");
{
  const now = Math.floor(Date.now() / 1000);
  const cards = [
    { id: "c1", deck_id: "d1", question: "Q1", answer: "A1", due: 0, last_review: 0 },
    { id: "c2", deck_id: "d1", question: "Q2", answer: "A2", due: 0, last_review: 0 },
    { id: "c3", deck_id: "d1", question: "Q3", answer: "A3", due: now + 86400, last_review: now - 60 },
    { id: "c4", deck_id: "d2", question: "Q4", answer: "A4", due: 0, last_review: 0 },
  ];
  const store = {
    decks: [{ id: "d1", name: "Biology", subject: "Cells" }, { id: "d2", name: "Systems", subject: "" }],
    cards,
    reviews: [{ t: now - 30, card_id: "c3", grade: "good", remembered: true }],
    quizzes: [{ id: "q1", deck_id: "d1", total: 4, correct: 3, t: now - 60 }],
    sessions: [{ id: "s1", deck_id: "d1", started: now - 300, ended: now - 60, cards: 3, remembered: 2 }],
  };
  const inv = backend({ study_load: () => store });
  const { Aery, els } = env(inv);
  await Aery.refresh();
  await flush();

  fire(els.aeryViewStudy, "click", {});
  await flush();

  check("the study view opens", els.aeryStudy.hidden === false && Aery.view() === "study");
  check("note tools step aside while studying", els.aeryTools.hidden === true && els.aeryList.hidden === true);
  check("the sidebar lists the decks", /Biology/.test(els.aeryStudyRail.innerHTML) && /Systems/.test(els.aeryStudyRail.innerHTML));
  check("the sidebar counts what is due", /<b>3<\/b><small>due now<\/small>/.test(els.aeryStudyRail.innerHTML));
  check("the overview shows due, cards and accuracy", /3/.test(els.aeryStudy.innerHTML) && /100%/.test(els.aeryStudy.innerHTML));

  const s = Aery.study().stats;
  check("stats count only cards that are due", s.due === 3 && s.cards === 4 && s.decks === 2);
  check("stats subtract session time", s.mins === 4);
  check("the quiz average comes from stored results", s.quizPct === 75);

  const qs = Aery.study().questions("d1");
  check("a quiz caps at the deck's cards", qs && qs.length === 3);
  check("every question offers its own answer", qs.every((q) => q.choices.includes(q.answer)));
  check("distractors come from the same deck", qs.every((q) => q.choices.every((c) => ["A1", "A2", "A3"].includes(c))));
  check("a second deck cannot be quizzed on its own", Aery.study().questions("d2") === null);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
})();