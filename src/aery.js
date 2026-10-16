// ============================================================================
// AERY - the vault workspace
//
// Notes live as Markdown files the user owns. This file never rewrites a note
// behind their back: it renders what is there, and it only saves when asked or
// after the user pauses typing.
// ============================================================================

const Atlas = (() => {
  const E = (id) => document.getElementById(id);
  const ST = (typeof store === "object" && store) ? store : { get: (_k, d) => d, set: () => false };
  const T = typeof toast === "function" ? toast : () => {};
  const A = (typeof Act === "object" && Act) ? Act : { log: () => null, update: () => {} };
  const TG = (typeof Tech === "object" && Tech) ? Tech : { add: () => {} };

  let notes = [], tags = [], folders = [], counts = { notes: 0 };
  let cur = null;              // the open note
  let content = "";            // the editor buffer
  let dirty = false;
  let saveTimer = null;
  let saving = false;
  let vaultPath = "";

  // Deliberately not named "invoke": a local of that name would shadow the global
  // one, and `typeof invoke` on the right-hand side would then read its own
  // uninitialised binding instead of finding the backend.
  async function call(cmd, args) {
    const send = (typeof window !== "undefined" && window.__TAURI__ && window.__TAURI__.core)
      ? window.__TAURI__.core.invoke
      : (typeof invoke === "function" ? invoke : null);
    if (!send) throw new Error("STRYV is not connected to its backend.");
    return send(cmd, args);
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const when = (sec) => {
    if (!sec) return "Never";
    const d = Math.floor(Date.now() / 1000) - sec;
    if (d < 60) return "Just now";
    if (d < 3600) return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    if (d < 604800) return Math.floor(d / 86400) + "d ago";
    return new Date(sec * 1000).toLocaleDateString();
  };

  // ---- loading ------------------------------------------------------------
  async function refresh(opts) {
    const q = (E("aeryQ") && E("aeryQ").value || "").trim();
    const tag = (E("aeryTag") && E("aeryTag").value || "").trim();
    try {
      const [list, c] = await Promise.all([call("aery_list", { q: q || null, tag: tag || null }), call("aery_counts")]);
      notes = list || [];
      counts = c || { notes: 0, tags: [], folders: [] };
      tags = counts.tags || [];
      folders = counts.folders || [];
      vaultPath = await call("aery_vault_path").catch(() => "");
    } catch (e) {
      TG.add("aery.list", e);
      renderRail();
      return;
    }
    renderRail();
    if (opts && opts.open) await open(opts.open);
    else if (!cur) markVisible();
  }

  function markVisible() {
    // Open the first note when nothing is open yet, so the workspace is never
    // a dead panel on first run.
    if (!notes.length) { showEmpty(); return; }
    open(notes[0].id);
  }

  function showEmpty() {
    cur = null; content = ""; dirty = false;
    const host = E("aeryEditor");
    if (host) host.hidden = true;
    const ph = E("aeryPlaceholder");
    if (ph) {
      ph.hidden = false;
      ph.innerHTML = notes.length
        ? ""
        : `<b>The vault is empty.</b><p>Aery keeps your notes as Markdown files in a folder you own. Nothing here is locked inside STRYV.</p>
           <button class="btn" data-aerynew="1">Write the first note</button>`;
    }
    renderContext();
    renderStatus();
  }

  // ---- sidebar ------------------------------------------------------------
  function renderRail() {
    const list = E("aeryList");
    if (list) {
      list.innerHTML = notes.length
        ? notes.map((n) => `<button class="anote${cur === n.id ? " on" : ""}" data-aeryopen="${esc(n.id)}">
            <span class="anote-t">${n.pinned ? '<b class="pin">*</b>' : ""}${esc(n.title)}</span>
            <span class="anote-m">${esc(n.folder || "Vault root")} &middot; ${esc(when(n.modified))}</span>
          </button>`).join("")
        : '<p class="aempty">Nothing matches. Try a different search, or write something new.</p>';
    }
    const tagSel = E("aeryTag");
    if (tagSel) {
      const keep = tagSel.value;
      tagSel.innerHTML = `<option value="">All tags</option>` + tags.map((t) => `<option value="${esc(t)}">#${esc(t)}</option>`).join("");
      tagSel.value = keep;
    }
    const head = E("aeryCounts");
    if (head) {
      head.innerHTML = `<b>${counts.notes || 0}</b><small>${counts.notes === 1 ? "note" : "notes"}</small>`;
    }
    const vp = E("aeryVaultPath");
    if (vp) vp.textContent = vaultPath ? vaultPath : "";
  }

  // ---- opening ------------------------------------------------------------
  async function open(id) {
    if (dirty && cur && cur !== id) { await flush(); }
    clearTimeout(saveTimer);
    let r;
    try { r = await call("aery_read", { id }); }
    catch (e) { T(String(e.message || e), true); return; }
    // A read that returns nothing is a failure, not an empty note.
    if (!r || typeof r !== "object") { T("That note could not be read. Nothing was opened.", true); return; }
    cur = id;
    content = r.content || "";
    dirty = false;
    const ed = E("aeryEditor");
    if (ed) { ed.value = content; ed.hidden = false; }
    const ph = E("aeryPlaceholder");
    if (ph) ph.hidden = true;
    const ti = E("aeryTitle");
    if (ti) ti.value = (r.note && r.note.title) || "";
    renderContext(r);
    renderRail();
    renderStatus();
    focusBody();
  }

  function focusBody() {
    const ed = E("aeryEditor");
    if (!ed || ed.hidden) return;
    try { ed.focus(); } catch (e) { /* not focusable in this shell */ }
  }

  // ---- saving -------------------------------------------------------------
  function touch() {
    dirty = true;
    renderStatus();
    clearTimeout(saveTimer);
    // Autosave only once typing has paused, so a burst of keystrokes is one write.
    saveTimer = setTimeout(() => { flush(); }, 1200);
  }

  async function flush() {
    clearTimeout(saveTimer);
    if (!dirty || !cur || saving) return;
    saving = true;
    renderStatus();
    const id = cur;
    const sent = content;
    try {
      await call("aery_save", { id, content: sent });
      // Only call it saved if what is on screen is what was written. If the user
      // typed during the write, this save is stale and the note is still dirty.
      if (id === cur && content === sent) dirty = false;
    } catch (e) {
      TG.add("aery.save", e);
      T("Could not save: " + (e.message || e), true);
    } finally {
      saving = false;
      renderStatus();
      if (dirty && id === cur) { saveTimer = setTimeout(() => { flush(); }, 1500); }
      else await refresh();
    }
  }

  function renderStatus() {
    const el = E("aerySave");
    if (!el) return;
    el.textContent = saving ? "Saving" : dirty ? "Unsaved" : "Saved";
    el.className = "a-save " + (saving ? "saving" : dirty ? "dirty" : "clean");
  }

  // ---- context panel ------------------------------------------------------
  function renderContext(r) {
    const host = E("aeryContext");
    if (!host) return;
    if (!r) { host.innerHTML = ""; return; }
    const out = r.outgoing || [];
    const back = r.backlinks || [];
    const links = out.map((l) => l.resolved
      ? `<button class="alink" data-aeryopen="${esc(l.resolved)}">${esc(l.title)}</button>`
      : `<span class="alink unresolved" title="No note with this title yet">${esc(l.title)} &middot; unresolved</span>`).join("");

    host.innerHTML = `
      <div class="actx">
        <h4>Links out <span class="n">${out.length}</span></h4>
        ${links ? links : '<p class="anone">No links yet. Type <code>[[another note]]</code> to connect this one.</p>'}
      </div>
      <div class="actx">
        <h4>Backlinks <span class="n">${back.length}</span></h4>
        ${back.length
          ? back.map((b) => `<button class="alink" data-aeryopen="${esc(b.id)}">${esc(b.title)}</button>`).join("")
          : '<p class="anone">Nothing links here yet.</p>'}
      </div>
      <div class="actx">
        <h4>Tags</h4>
        ${(r.tags || []).length
          ? (r.tags || []).map((t) => `<button class="atag" data-aerytag="${esc(t)}">#${esc(t)}</button>`).join("")
          : '<p class="anone">No tags yet.</p>'}
      </div>`;
  }

  // ---- creating -----------------------------------------------------------
  async function create() {
    clearTimeout(saveTimer);
    if (dirty) await flush();
    const act = A.log({ text: "New Aery note", status: "running" });
    try {
      const n = await call("aery_create", { title: "Untitled", folder: null });
      A.update(act, { status: "done", detail: n.path });
      await refresh({ open: n.id });
      T("Note created.");
    } catch (e) {
      A.update(act, { status: "failed", detail: String(e.message || e) });
      TG.add("aery.create", e);
      T(String(e.message || e), true);
    }
  }

  async function rename(title) {
    if (!cur) return;
    const t = (title || "").trim();
    if (!t) { T("A note needs a title.", true); return; }
    try {
      await call("aery_rename", { id: cur, title: t });
      await refresh({ open: cur });
      T("Renamed.");
    } catch (e) { T(String(e.message || e), true); }
  }

  async function togglePin() {
    if (!cur) return;
    const n = notes.find((x) => x.id === cur);
    if (!n) return;
    try {
      await call("aery_set_pinned", { id: cur, pinned: !n.pinned });
      await refresh({ open: cur });
    } catch (e) { T(String(e.message || e), true); }
  }

  async function remove() {
    if (!cur) return;
    const n = notes.find((x) => x.id === cur);
    if (!n) return;
    clearTimeout(saveTimer);
    const ok = await (typeof confirmBox === "function"
      ? confirmBox({ title: "Move note to trash", body: 'Move "' + n.title + '" out of the vault?\n\nThe file is moved, not deleted, and can be restored from the trash.', yes: "Move to trash", danger: true })
      : Promise.resolve(true));
    if (!ok) return;
    const act = A.log({ text: "Moved Aery note to trash", status: "running" });
    try {
      await call("aery_delete", { id: cur });
      A.update(act, { status: "done", detail: n.path + " moved to the vault trash" });
      cur = null;
      await refresh();
      T("Moved to trash. Nothing was erased.");
    } catch (e) {
      A.update(act, { status: "failed", detail: String(e.message || e) });
      T(String(e.message || e), true);
    }
  }

  async function restore() {
    clearTimeout(saveTimer);
    if (dirty) await flush();
    const ok = await (typeof confirmBox === "function"
      ? confirmBox({ title: "Restore trashed notes", body: "Put every note in the vault trash back where it was?\n\nNothing is downloaded or recreated. Aery only moves its own files back.", yes: "Restore", danger: false })
      : Promise.resolve(true));
    if (!ok) return;
    try {
      const n = await call("aery_restore");
      await refresh();
      T(n ? (n + " note" + (n === 1 ? "" : "s") + " restored.") : "There was nothing in the trash.");
    } catch (e) { T(String(e.message || e), true); }
  }

  // ---- wiring -------------------------------------------------------------
  function on(id, ev, fn) {
    const el = E(id);
    if (el) el.addEventListener(ev, fn);
  }

  function wire() {
    on("aeryQ", "input", () => { refresh(); });
    on("aeryTag", "change", () => { refresh(); });
    on("aeryNew", "click", () => { create(); });
    on("aeryRestore", "click", () => { restore(); });
    on("aeryPin", "click", () => { togglePin(); });
    on("aeryDel", "click", () => { remove(); });

    const ed = E("aeryEditor");
    if (ed) ed.addEventListener("input", () => { content = ed.value; touch(); });
    if (ed) ed.addEventListener("keydown", (ev) => {
      // Ctrl/Cmd+S saves immediately, which is what people actually reach for.
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === "s" || ev.key === "S")) { ev.preventDefault(); flush(); }
      if (ev.key === "Tab" && !ev.shiftKey) {
        ev.preventDefault();
        const s = ed.selectionStart, e = ed.selectionEnd;
        ed.value = ed.value.slice(0, s) + "  " + ed.value.slice(e);
        ed.selectionStart = ed.selectionEnd = s + 2;
        content = ed.value; touch();
      }
    });
    // Leaving the page with unsaved work is the one thing worth a prompt.
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", (ev) => {
        if (!dirty) return;
        flush();
        ev.preventDefault();
        ev.returnValue = "";
      });
    }

    const ti = E("aeryTitle");
    if (ti) ti.addEventListener("change", () => { rename(ti.value); });

    // Delegated: the rail and the context panel are re-rendered constantly.
    const host = E("aeryList");
    if (host) host.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-aeryopen]");
      if (b) open(b.getAttribute("data-aeryopen"));
    });
    const ctx = E("aeryContext");
    if (ctx) ctx.addEventListener("click", (ev) => {
      const o = ev.target.closest("[data-aeryopen]");
      if (o) { open(o.getAttribute("data-aeryopen")); return; }
      const t = ev.target.closest("[data-aerytag]");
      if (t) {
        const sel = E("aeryTag");
        if (sel) { sel.value = t.getAttribute("data-aerytag"); refresh(); }
      }
    });
    const ph = E("aeryPlaceholder");
    if (ph) ph.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-aerynew]")) create();
    });
  }

  function render() { renderRail(); renderContext(); renderStatus(); }
  function active() { return !!cur; }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { wire(); refresh(); });
    else { wire(); refresh(); }
  }

  return { refresh, open, create, flush, render, active, current: () => cur };
})();

if (typeof window !== "undefined") window.Aery = Atlas;