// ============================================================================
// AERY - the vault workspace
//
// Notes live as Markdown files the user owns. This file never rewrites a note
// behind their back: it renders what is there, and it only saves when asked or
// after the user pauses typing.
// ============================================================================

const Aery = (() => {
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
  // Consecutive save attempts against one note, so a vault that cannot be
  // written to stops asking instead of retrying for as long as it stays open.
  const saves = { retries: 0 };
  let saving = false;
  let vaultPath = "";
  // Open notes, in the order they were opened. Only the active one has a live
  // buffer: switching flushes first, so a tab can never hide unsaved text.
  let tabs = [];
  let view = "notes";          // "notes" or "graph"
  let reading = false;         // edit vs read, for the note view
  let curFolder = "";          // the open note's folder, independent of the filter

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
    else if (!cur && view !== "study") markVisible();
  }

  function markVisible() {
    // Open the first note when nothing is open yet, so the workspace is never
    // a dead panel on first run.
    if (!notes.length) { showEmpty(); return; }
    open(notes[0].id);
  }

  function showEmpty() {
    cur = null; content = ""; dirty = false; curFolder = "";
    const host = E("aeryEditor");
    if (host) host.hidden = true;
    const pv = E("aeryPreview");
    if (pv) pv.hidden = true;
    const rb = E("aeryRead");
    if (rb) rb.hidden = true;
    const ph = E("aeryPlaceholder");
    if (ph) {
      // The graph has its own empty state; showing both would stack two
      // different explanations of the same empty vault.
      ph.hidden = view === "graph" || view === "study";
      ph.innerHTML = notes.length
        ? ""
        : `<b>The vault is empty.</b><p>Aery keeps your notes as Markdown files in a folder you own. Nothing here is locked inside STRYV.</p>
           <button class="btn" data-aerynew="1">Write the first note</button>`;
    }
    renderContext();
    renderStatus();
    renderTabs();
  }

  // ---- tabs ---------------------------------------------------------------
  function renderTabs() {
    const host = E("aeryTabs");
    if (!host) return;
    host.innerHTML = tabs.map((id) => {
      const n = notes.find((x) => x.id === id);
      const title = n ? n.title : "Note";
      // The rail is filtered by search, so a tab whose note is not in the
      // current list still has to render, and still has to be closable.
      const on = id === cur;
      const dot = on && dirty ? '<span class="dot" title="Unsaved"></span>' : "";
      return `<div class="atab${on ? " on" : ""}" role="tab" aria-selected="${on}">
        <span class="atab-t" data-aeryopen="${esc(id)}" title="${esc(title)}">${esc(title)}</span>
        ${dot}
        <button class="atab-x" data-aeryclose="${esc(id)}" title="Close ${esc(title)}" aria-label="Close ${esc(title)}">&times;</button>
      </div>`;
    }).join("");
  }

  async function closeTab(id) {
    if (id === cur) {
      clearTimeout(saveTimer);
      if (dirty) {
        await flush();
        // Closing a tab with a failed save would discard the only copy.
        if (dirty) { T("Could not save this note, so it was not closed. Nothing was lost.", true); return; }
      }
    }
    tabs = tabs.filter((x) => x !== id);
    if (id !== cur) { renderTabs(); return; }
    clearTimeout(saveTimer);
    cur = null; content = ""; dirty = false;
    if (tabs.length) await open(tabs[tabs.length - 1]);
    else { showEmpty(); renderTabs(); }
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
      head.innerHTML = view === "study"
        ? `<b>${studyStore.cards.length}</b><small>${studyStore.cards.length === 1 ? "card" : "cards"}</small>`
        : `<b>${counts.notes || 0}</b><small>${counts.notes === 1 ? "note" : "notes"}</small>`;
    }
    const vp = E("aeryVaultPath");
    if (vp) vp.textContent = vaultPath ? vaultPath : "";
    // The move target is part of the note chrome, so it follows the note, not
    // the filtered list. A folder with no notes still appears, so a folder you
    // just made is somewhere you can actually put something.
    const fs = E("aeryFolderSel");
    if (fs) {
      const here = curFolder;
      const known = folders.includes(here);
      fs.innerHTML = `<option value="">Vault root</option>` +
        folders.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("") +
        (here && !known ? `<option value="${esc(here)}">${esc(here)}</option>` : "");
      fs.value = here;
      fs.disabled = !cur;
    }
    renderFolders();
    renderStudyRail();
    const ex = E("aeryExportNote");
    if (ex) ex.disabled = !cur;
  }

  // ---- folders ------------------------------------------------------------
  async function newFolder() {
    const form = E("aeryFolderForm"), input = E("aeryFolderName");
    if (!form || !input) return;
    form.hidden = false;
    input.value = "";
    try { input.focus(); } catch (e) { /* not focusable in this shell */ }
  }

  function hideFolderForm() {
    const form = E("aeryFolderForm"), input = E("aeryFolderName");
    if (form) form.hidden = true;
    if (input) input.value = "";
  }

  async function addFolder() {
    const input = E("aeryFolderName");
    const name = ((input && input.value) || "").trim();
    if (!name) { T("A folder needs a name.", true); return; }
    try {
      const made = await call("aery_mkdir", { path: name });
      hideFolderForm();
      await refresh();
      T("Created " + (made || name) + ".");
    } catch (e) {
      // Deliberately leave the form open: the name is still there to correct.
      T(String(e.message || e), true);
    }
  }

  async function moveTo(folder) {
    if (!cur) return;
    // The backend renames the file on disk. Anything still in the buffer has to
    // be written first, or the move races the autosave and the edit is lost.
    clearTimeout(saveTimer);
    if (dirty) {
      await flush();
      if (dirty) { T("Could not save this note, so it was not moved.", true); renderRail(); return; }
    }
    try {
      await call("aery_set_folder", { id: cur, folder: folder || "" });
      // Same id, new path: the tab and the open note survive the move because
      // the id lives in the note's own front matter, not in its filename.
      await refresh({ open: cur });
      T(folder ? "Moved to " + folder + "." : "Moved to the vault root.");
    } catch (e) {
      T(String(e.message || e), true);
      renderRail();
    }
  }

  // ---- opening ------------------------------------------------------------
  async function open(id) {
    // Flush even when the note is already open. refresh({ open: cur }) reopens
    // the current note after a rename or a pin, and the read used to overwrite
    // the editor with the on-disk text while the status still said Saved.
    if (dirty) {
      await flush();
      // A save that failed leaves the buffer dirty. Opening now would throw away
      // text that exists nowhere else, so stay where we are and say why.
      if (dirty) { T("Could not save this note, so it was not reopened. Nothing was lost.", true); return; }
    }
    clearTimeout(saveTimer);
    let r;
    try { r = await call("aery_read", { id }); }
    catch (e) { T(String(e.message || e), true); return; }
    // A read that returns nothing is a failure, not an empty note.
    if (!r || typeof r !== "object") { T("That note could not be read. Nothing was opened.", true); return; }
    cur = id;
    curFolder = (r.note && r.note.folder) || "";
    if (!tabs.includes(id)) tabs.push(id);
    // Opening a note always returns to the editor, even from the graph, so a
    // click on a node does what it looks like it does.
    if (view !== "notes") { view = "notes"; applyView(); }
    content = r.content || "";
    dirty = false;
    const ed = E("aeryEditor");
    if (ed) ed.value = content;
    const ph = E("aeryPlaceholder");
    if (ph) ph.hidden = true;
    const ti = E("aeryTitle");
    if (ti) ti.value = (r.note && r.note.title) || "";
    renderContext(r);
    renderRail();
    renderStatus();
    renderTabs();
    applyView();
    if (!reading) focusBody();
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
      if (id === cur && content === sent) { dirty = false; saves.retries = 0; }
    } catch (e) {
      TG.add("aery.save", e);
      T("Could not save: " + (e.message || e), true);
    } finally {
      saving = false;
      renderStatus();
      // Retry a bounded number of times, and only for a note that is still the
      // one being edited. Retrying forever turns one persistent failure into a
      // stream of identical toasts and floods Tech.list, which is capped - so
      // the failure evicts the real errors needed to diagnose it.
      if (dirty && id === cur && saves.retries < 3) {
        saves.retries++;
        saveTimer = setTimeout(() => { flush(); }, 1500);
      } else await refresh();
    }
  }

  function renderStatus() {
    const el = E("aerySave");
    if (!el) return;
    el.textContent = saving ? "Saving" : dirty ? "Unsaved" : "Saved";
    el.className = "a-save " + (saving ? "saving" : dirty ? "dirty" : "clean");
    // The tab carries the only sign that a background note has unsaved text.
    renderTabs();
    const ex = E("aeryExportNote");
    if (ex) ex.disabled = !cur;
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

  // ---- markdown -----------------------------------------------------------
  // A small renderer, not a Markdown library: the subset Aery documents in its
  // own help panel, rendered from escaped text so a note can never inject HTML.
  // Wikilinks resolve against the same title rule the backend uses.
  function md(src, list) {
    let text = String(src == null ? "" : src);
    // Front matter is machine metadata, not prose.
    if (text.startsWith("---\n")) {
      const end = text.indexOf("\n---", 3);
      if (end !== -1) {
        const after = text.indexOf("\n", end + 4);
        text = after === -1 ? "" : text.slice(after + 1);
      }
    }
    const links = list || notes;
    const find = (title) => {
      const want = title.trim().toLowerCase();
      return links.find((n) => esc(n.title).toLowerCase() === want);
    };
    const inline = (raw) => {
      // Escape before any inline rule, so a note's own HTML can never be live.
      // Block detection happens on the raw line, which is why this is not done
      // to the whole document: escaping first turns ">" into "&gt;" and quotes
      // stop being quotes.
      const codes = [];
      let s = esc(raw).replace(/`([^`\n]+)`/g, (m, c) => {
        codes.push(c);
        return "\u0000" + (codes.length - 1) + "\u0000";
      });
      s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, tRaw, label) => {
        const t = tRaw.trim();
        const shown = (label || tRaw).trim();
        const n = find(t);
        return n
          ? `<a class="md-link" data-aeryopen="${esc(n.id)}" title="${esc(n.title)}">${shown}</a>`
          : `<span class="md-link unresolved" title="No note with this title yet">${shown}</span>`;
      });
      // Only schemes a local notes app should ever emit. Anything else is shown
      // as text rather than becoming a live link.
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, url) =>
        /^(https?:|mailto:)/i.test(url)
          ? `<a class="md-url" href="${url}" rel="noreferrer noopener" target="_blank">${t}</a>`
          : `<span class="md-url blocked" title="Only http, https and mailto links are opened">${t}</span>`);
      s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
      s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
      return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[+i]}</code>`);
    };

    const lines = text.split(/\r?\n/);
    const out = [];
    let para = [];
    const flushPara = () => {
      if (!para.length) return;
      out.push("<p>" + inline(para.join(" ")) + "</p>");
      para = [];
    };

    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (/^```/.test(line)) {
        flushPara();
        const lang = line.slice(3).trim();
        const buf = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
        i++;
        out.push(`<pre class="md-code"><code${lang ? ` data-lang="${esc(lang)}"` : ""}>${esc(buf.join("\n"))}</code></pre>`);
        continue;
      }
      if (/^\s*$/.test(line)) { flushPara(); i++; continue; }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flushPara(); out.push("<hr>"); i++; continue; }
      if (/^>\s?/.test(line)) {
        flushPara();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
        out.push("<blockquote>" + inline(buf.join(" ")) + "</blockquote>");
        continue;
      }
      if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
        flushPara();
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])) {
          let body = lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
          let box = "";
          const task = body.match(/^\[([ xX])\]\s+(.*)$/);
          if (task) {
            box = `<input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""}> `;
            body = task[2];
          }
          items.push("<li>" + box + inline(body) + "</li>");
          i++;
        }
        out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
        continue;
      }
      para.push(line);
      i++;
    }
    flushPara();
    return out.join("\n");
  }

  function renderPreview() {
    const pv = E("aeryPreview");
    if (!pv) return;
    if (!content.trim()) {
      pv.innerHTML = '<p class="md-empty">Nothing written yet. Switch back to Edit and start typing.</p>';
      return;
    }
    const html = md(content, notes);
    pv.innerHTML = html || '<p class="md-empty">Nothing to read yet.</p>';
  }

  function setReading(on) {
    reading = !!on;
    applyView();
    if (reading) { renderPreview(); E("aeryPreview") && E("aeryPreview").scrollTo && E("aeryPreview").scrollTo(0, 0); }
    else focusBody();
  }

  // ---- graph --------------------------------------------------------------
  function applyView() {
    const g = E("aeryGraph"), bar = E("aeryBar"), ed = E("aeryEditor"), ph = E("aeryPlaceholder");
    const isGraph = view === "graph";
    const isStudy = view === "study";
    const nb = E("aeryViewNotes"), gb = E("aeryViewGraph"), sb = E("aeryViewStudy");
    if (nb) {
      const on = !isGraph && !isStudy;
      nb.className = "aery-view" + (on ? " on" : "");
      nb.setAttribute("aria-selected", String(on));
    }
    if (gb) {
      gb.className = "aery-view" + (isGraph ? " on" : "");
      gb.setAttribute("aria-selected", String(isGraph));
    }
    if (sb) {
      sb.className = "aery-view" + (isStudy ? " on" : "");
      sb.setAttribute("aria-selected", String(isStudy));
    }
    const readNow = !isGraph && !isStudy && reading && !!cur;
    const pv = E("aeryPreview");
    if (g) g.hidden = !isGraph;
    if (bar) bar.hidden = isGraph || isStudy;
    if (ed) ed.hidden = isGraph || isStudy || !cur || readNow;
    if (pv) pv.hidden = isStudy || !readNow;
    if (ph) ph.hidden = isGraph || isStudy || !!cur;
    const tabs = E("aeryTabs");
    if (tabs) tabs.hidden = isStudy;
    const tools = E("aeryTools"), list = E("aeryList"), folderHost = E("aeryFolders");
    if (tools) tools.hidden = isStudy;
    if (list) list.hidden = isStudy;
    if (folderHost) folderHost.hidden = isStudy;
    const rb = E("aeryRead");
    if (rb) {
      rb.hidden = !cur || isGraph || isStudy;
      rb.textContent = reading ? "Edit" : "Read";
      rb.setAttribute("aria-pressed", String(reading));
      rb.title = reading ? "Back to editing (Ctrl+E)" : "Read this note (Ctrl+E)";
    }
    const cb = E("aeryCardSel");
    if (cb) cb.hidden = !cur || isGraph || isStudy;
    if (isStudy) renderStudy();
    else if (isGraph) graph();
    else if (readNow) renderPreview();
  }

  async function graph() {
    const host = E("aeryGraph");
    if (!host) return;
    host.innerHTML = '<p class="ag-empty">Reading the links...</p>';
    let g;
    try { g = await call("aery_graph"); }
    catch (e) {
      TG.add("aery.graph", e);
      host.innerHTML = '<p class="ag-empty"><b>The link graph could not be read.</b>' + esc(e.message || e) + "</p>";
      return;
    }
    renderGraph(g);
  }

  function renderGraph(g) {
    const host = E("aeryGraph");
    if (!host) return;
    const nodes = (g && g.nodes) || [];
    const edges = (g && g.edges) || [];
    if (!nodes.length) {
      host.innerHTML = `<p class="ag-empty"><b>No notes yet.</b>Write a note, and link another with [[double brackets]], to see them connected.</p>`;
      return;
    }

    // A ring, not a force layout: it is deterministic, it is calm to look at,
    // and the same vault cannot rearrange itself every time the view is opened.
    const W = 760, H = 520, cx = W / 2, cy = H / 2;
    const pos = new Map();
    nodes.forEach((node, i) => {
      const a = (Math.PI * 2 * i) / nodes.length - Math.PI / 2;
      // Enough room that two notes are not a dot in the middle of the pane, but
      // bounded so a large vault still fits without scrolling.
      const rx = nodes.length > 1 ? Math.min(W * 0.40, Math.max(220, 90 + nodes.length * 20)) : 0;
      const ry = nodes.length > 1 ? Math.min(H * 0.36, Math.max(155, 70 + nodes.length * 14)) : 0;
      pos.set(node.id, { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
    });

    // Two notes that link to each other would otherwise draw one line on top of
    // the other, so the map would undercount what it just reported. Reciprocal
    // edges curve apart instead.
    const reciprocal = (f, t) => edges.some((e) => e.from === t && e.to === f);
    const lines = edges.map((e) => {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) return "";
      if (reciprocal(e.from, e.to)) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ox = (-dy / len) * 20, oy = (dx / len) * 20;
        return `<path class="ag-edge" d="M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${(mx + ox).toFixed(1)} ${(my + oy).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}"/>`;
      }
      return `<line class="ag-edge" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`;
    }).join("");

    const dots = nodes.map((node) => {
      const p = pos.get(node.id);
      const cls = "ag-node" + (node.pinned ? " pin" : "") + (node.id === cur ? " on" : "");
      // Labels sit on the outside of the ring so they never cross it, and never
      // run off the right-hand edge.
      const left = p.x >= cx;
      const tx = left ? -14 : 14;
      const anchor = left ? "end" : "start";
      return `<g class="${cls}" data-aeryopen="${esc(node.id)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" role="button" tabindex="0">
        <circle r="9"></circle>
        <text x="${tx}" y="4" text-anchor="${anchor}">${esc(node.title)}</text>
      </g>`;
    }).join("");

    // The count is in the accessible name, so the map is not just a picture.
    host.innerHTML = `<p class="ag-meta"><b>${nodes.length}</b> note${nodes.length === 1 ? "" : "s"} &middot; <b>${edges.length}</b> link${edges.length === 1 ? "" : "s"}<span>Click a note to open it.</span></p>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Aery link graph: ${nodes.length} notes, ${edges.length} links">
      <g class="ag-lines">${lines}</g>
      <g class="ag-nodes">${dots}</g>
    </svg>`;
  }

  // ---- creating -----------------------------------------------------------
  async function create() {
    clearTimeout(saveTimer);
    if (dirty) await flush();
    // A new note is for writing, even if the last thing you read was in Read.
    reading = false;
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
    // The backend rewrites the file it finds on disk, so anything still in the
    // editor has to be written first. Without this a rename inside the autosave
    // window silently discards the edit and races the pending save.
    clearTimeout(saveTimer);
    if (dirty) {
      await flush();
      if (dirty) { T("Could not save this note, so it was not renamed.", true); return; }
    }
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
    // Flush before touching the vault. Without this the pending autosave is
    // cancelled and aery_delete then moves the *pre-edit* file into the trash,
    // so anything typed inside the autosave window is lost silently.
    clearTimeout(saveTimer);
    if (dirty) await flush();
    const ok = await (typeof confirmBox === "function"
      ? confirmBox({ title: "Move note to trash", body: 'Move "' + n.title + '" out of the vault?\n\nThe file is moved, not deleted, and can be restored from the trash.', yes: "Move to trash", danger: true })
      : Promise.resolve(true));
    if (!ok) return;
    const act = A.log({ text: "Moved Aery note to trash", status: "running" });
    try {
      await call("aery_delete", { id: cur });
      A.update(act, { status: "done", detail: n.path + " moved to the vault trash" });
      const gone = cur;
      tabs = tabs.filter((x) => x !== gone);
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
  // ---- folders: rename and delete -----------------------------------------
  let renameFolderFrom = "";
  let delFolder = "";
  let folderMenu = "";

  function folderCount(name) {
    return notes.filter((n) => (n.folder || "") === name).length;
  }

  function renderFolders() {
    const host = E("aeryFolders");
    if (!host) return;
    if (view === "study" || !folders.length) { host.innerHTML = ""; return; }
    if (delFolder) {
      const n = folderCount(delFolder);
      host.innerHTML = `<div class="aery-folderconfirm" role="group" aria-label="Confirm deleting ${esc(delFolder)}">
        <p>${n ? `Delete ${esc(delFolder)}? Its ${n} note${n === 1 ? "" : "s"} move to the vault root first. Nothing is erased.` : `Delete the empty folder ${esc(delFolder)}?`}</p>
        <button class="btn" data-afdelok="${esc(delFolder)}">${n ? "Move notes & delete" : "Delete folder"}</button>
        <button class="btn ghost" data-afcancel="1">Keep it</button>
      </div>`;
      return;
    }
    if (renameFolderFrom) {
      host.innerHTML = `<div class="aery-folderconfirm" style="border-color:var(--line);background:var(--p1)">
        <p>Rename ${esc(renameFolderFrom)}</p>
        <input id="aeryFolderRename" value="${esc(renameFolderFrom)}" aria-label="New folder name" autocomplete="off" style="flex:1 1 100%;background:var(--p2);border:1px solid var(--line);color:var(--t);border-radius:6px;padding:5px 8px;font:inherit;font-size:12px">
        <button class="btn" data-afrenameok="1">Rename</button>
        <button class="btn ghost" data-afcancel="1">Cancel</button>
      </div>`;
      try { E("aeryFolderRename").focus(); E("aeryFolderRename").select(); } catch (e) { /* not focusable */ }
      return;
    }
    host.innerHTML = folders.map((f) => `<div class="aery-folderrow">
      <b title="${esc(f)}">${esc(f)}</b><small>${folderCount(f)}</small>
      <button class="aery-fbtn" data-afmenu="${esc(f)}" title="Folder actions for ${esc(f)}" aria-label="Folder actions for ${esc(f)}">&middot;&middot;&middot;</button>
      ${folderMenu === f ? `<div class="aery-folderactions"><button class="btn ghost" data-afrename="${esc(f)}">Rename</button><button class="btn ghost" data-afdel="${esc(f)}">Delete</button></div>` : ""}
    </div>`).join("");
  }

  async function renameFolder() {
    const input = E("aeryFolderRename");
    const to = ((input && input.value) || "").trim();
    const from = renameFolderFrom;
    if (!to) { T("A folder needs a name.", true); return; }
    if (to === from) { renameFolderFrom = ""; renderFolders(); return; }
    try {
      const made = await call("aery_rename_folder", { from, to });
      renameFolderFrom = "";
      // Paths changed but note ids did not, so the open note can be reopened by
      // id and its tab survives the rename.
      await refresh(cur ? { open: cur } : undefined);
      T("Renamed to " + (made || to) + ".");
    } catch (e) {
      T(String(e.message || e), true);
    }
  }

  async function deleteFolder(name) {
    const n = folderCount(name);
    try {
      const r = await call("aery_delete_folder", { folder: name, moveTo: n ? "" : null });
      delFolder = "";
      await refresh(cur ? { open: cur } : undefined);
      const moved = (r && r.moved) || 0;
      T(moved ? `Deleted ${name} and moved ${moved} file${moved === 1 ? "" : "s"} to the vault root.` : `Deleted ${name}.`);
    } catch (e) {
      T(String(e.message || e), true);
    }
  }

  // ---- import and export ---------------------------------------------------
  function picker() {
    const t = (typeof window !== "undefined" && window.__TAURI__) ? window.__TAURI__ : null;
    return t && t.dialog ? t.dialog : null;
  }

  function ioNote(text, kind) {
    const el = E("aeryIoMsg");
    if (!el) return;
    el.className = "aery-iomsg" + (kind ? " " + kind : "");
    el.innerHTML = text || "";
  }

  async function exportNote() {
    if (!cur) { T("Open a note first.", true); return; }
    const d = picker();
    if (!d || typeof d.save !== "function") { T("The save dialog is not available in this build.", true); return; }
    const n = notes.find((x) => x.id === cur);
    const name = ((n && n.title) || "note").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || "note";
    let dest;
    try { dest = await d.save({ title: "Export note", defaultPath: name + ".md", filters: [{ name: "Markdown", extensions: ["md"] }] }); }
    catch (e) { T(String(e.message || e), true); return; }
    if (!dest) return;
    try {
      await call("aery_export_note", { id: cur, dest });
      ioNote("Exported <b>" + esc(name) + ".md</b>.");
      T("Exported " + name + ".md.");
    } catch (e) { T(String(e.message || e), true); }
  }

  let pendingExport = null;

  async function exportVault(overwrite) {
    let dest = pendingExport;
    if (!dest) {
      const d = picker();
      if (!d || typeof d.open !== "function") { T("The folder picker is not available in this build.", true); return; }
      try { dest = await d.open({ title: "Export the vault into a folder", directory: true, multiple: false }); }
      catch (e) { T(String(e.message || e), true); return; }
      if (!dest) return;
    }
    try {
      const r = await call("aery_export_vault", { dest, overwrite: !!overwrite });
      const skipped = (r && r.skipped) || 0;
      if (skipped && !overwrite) {
        pendingExport = dest;
        ioNote(`Exported ${r.copied}. <b>${skipped}</b> file${skipped === 1 ? "" : "s"} already exist in that folder and were left alone. <button class="btn" data-aeryio="force">Overwrite them</button>`, "warn");
        return;
      }
      pendingExport = null;
      ioNote(`Exported <b>${r.copied}</b> note${r.copied === 1 ? "" : "s"}${skipped ? `, overwrote ${skipped}` : ""}.`);
      T("Vault exported.");
    } catch (e) {
      ioNote(esc(String(e.message || e)), "bad");
      T(String(e.message || e), true);
    }
  }

  function importSummary(r) {
    const bits = [`Imported <b>${r.imported}</b> note${r.imported === 1 ? "" : "s"}`];
    if (r.renamed) bits.push(`${r.renamed} kept a new name so nothing was overwritten`);
    if (r.skipped) bits.push(`${r.skipped} skipped`);
    if (r.unresolved_links) bits.push(`${r.unresolved_links} link${r.unresolved_links === 1 ? "" : "s"} point at no note yet`);
    let html = bits.join(" &middot; ") + ".";
    const errors = r.errors || [];
    if (errors.length) html += `<br>${esc(errors.slice(0, 3).join("; "))}${errors.length > 3 ? " &hellip;" : ""}`;
    return html;
  }

  async function importInto(folderMode) {
    const d = picker();
    if (!d || typeof d.open !== "function") { T("The file picker is not available in this build.", true); return; }
    let picked;
    try {
      picked = folderMode
        ? await d.open({ title: "Import a folder of Markdown", directory: true, multiple: false })
        : await d.open({ title: "Import Markdown", multiple: true, directory: false, filters: [{ name: "Markdown", extensions: ["md"] }] });
    } catch (e) { T(String(e.message || e), true); return; }
    const paths = Array.isArray(picked) ? picked.filter(Boolean) : (picked ? [picked] : []);
    if (!paths.length) return;
    try {
      const r = await call("aery_import", { paths, folder: null });
      ioNote(importSummary(r), r.skipped ? "warn" : "");
      await refresh();
      if (r.imported) T(`Imported ${r.imported} note${r.imported === 1 ? "" : "s"}.`);
      else T("Nothing was imported. Only Markdown files are read.", true);
    } catch (e) {
      ioNote(esc(String(e.message || e)), "bad");
      T(String(e.message || e), true);
    }
  }

  // ---- study ---------------------------------------------------------------
  let studyStore = { decks: [], cards: [], reviews: [], quizzes: [], sessions: [] };
  let studyReady = false;
  let studyPane = "dash";        // dash | deck | review | quiz
  let studyDeck = "";
  let deckForm = false;
  let renameDeck = false;
  let confirmDeck = false;
  let editCard = "";
  let confirmCard = "";
  let prefill = null;            // question text carried over from a note selection
  let review = null;             // { ids, i, shown, answered, remembered, deck }
  let quiz = null;               // { qs, i, answers, result }
  let sessionId = "";

  const nowSec = () => Math.floor(Date.now() / 1000);
  const dueOf = (c) => !c.last_review || (c.due || 0) <= nowSec();
  const deckCards = (id) => studyStore.cards.filter((c) => c.deck_id === id);
  const dueCards = (id) => studyStore.cards.filter((c) => (!id || c.deck_id === id) && dueOf(c));
  const cardDue = (c) => {
    if (!c.last_review) return "New";
    if (dueOf(c)) return "Due now";
    const d = Math.max(0, Math.ceil(((c.due || 0) - nowSec()) / 86400));
    return "in " + d + "d";
  };

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function stats() {
    const revs = studyStore.reviews || [];
    const remembered = revs.filter((r) => r.remembered).length;
    const accuracy = revs.length ? Math.round((100 * remembered) / revs.length) : null;
    const mins = Math.round((studyStore.sessions || []).reduce((a, s) => a + Math.max(0, (s.ended || nowSec()) - s.started), 0) / 60);
    const qs = (studyStore.quizzes || []).slice(-10);
    const quizPct = qs.length ? Math.round((100 * qs.reduce((a, q) => a + (q.total ? q.correct / q.total : 0), 0)) / qs.length) : null;
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const start = Math.floor(d.getTime() / 1000), end = start + 86400;
      days.push({ label: "SMTWTFS"[d.getDay()], n: revs.filter((r) => r.t >= start && r.t < end).length });
    }
    return {
      due: dueCards("").length, cards: studyStore.cards.length, decks: studyStore.decks.length,
      accuracy, mins, quizPct, days, max: Math.max(1, ...days.map((d) => d.n)), reviews: revs.length,
    };
  }

  /// Builds up to five multiple-choice questions from a deck. Distractors are
  /// other answers from the same deck, so a quiz never tests a card against
  /// something from an unrelated subject.
  function questionsFor(deckId) {
    const pool = deckCards(deckId).filter((c) => c.question.trim() && c.answer.trim());
    if (pool.length < 2) return null;
    return shuffle(pool.slice()).slice(0, Math.min(5, pool.length)).map((c) => {
      const others = shuffle(pool.filter((x) => x.id !== c.id && x.answer !== c.answer));
      return {
        card_id: c.id,
        q: c.question,
        answer: c.answer,
        choices: shuffle([c.answer, ...others.slice(0, 3).map((x) => x.answer)]),
        pick: -1,
      };
    });
  }

  async function ensureStudy() {
    if (studyReady) return;
    try {
      studyStore = await call("study_load");
      studyReady = true;
    } catch (e) {
      TG.add("study.load", e);
      T("Study data could not be loaded.", true);
    }
  }

  function renderStudyPane() {
    const host = E("aeryStudy");
    if (!host) return;
    if (view !== "study") { host.hidden = true; return; }
    host.hidden = false;
    if (studyPane === "review" && review) return renderReview(host);
    if (studyPane === "quiz" && quiz) return renderQuiz(host);
    if (studyPane === "deck" && studyDeck) return renderDeck(host);
    studyPane = "dash";
    renderDash(host);
  }

  function deckRow(d) {
    const cards = deckCards(d.id).length;
    const due = dueCards(d.id).length;
    return `<button class="st-row" data-st-deck="${esc(d.id)}" style="text-align:left;cursor:pointer;width:100%;font:inherit">
      <div class="st-row-main"><b>${esc(d.name)}</b><small>${cards} card${cards === 1 ? "" : "s"}${d.subject ? " &middot; " + esc(d.subject) : ""}</small></div>
      <span class="st-badge ${due ? "due" : ""}">${due ? due + " due" : "Clear"}</span>
    </button>`;
  }

  function renderDash(host) {
    const s = stats();
    const recent = (studyStore.sessions || []).filter((x) => x.ended).slice(-5).reverse();
    const sessions = recent.length ? recent.map((x) => {
      const mins = Math.max(0, Math.round((x.ended - x.started) / 60));
      const pct = x.cards ? Math.round((100 * x.remembered) / x.cards) : null;
      return `<div class="st-row"><div class="st-row-main"><b>${new Date(x.started * 1000).toLocaleDateString()} &middot; ${x.cards} card${x.cards === 1 ? "" : "s"}${pct != null ? " &middot; " + pct + "% remembered" : ""}</b>
        <small>${mins < 1 ? "under a minute" : mins + " min"}</small></div></div>`;
    }).join("") : '<p class="st-empty">No sessions yet. Review some cards and this fills in.</p>';

    host.innerHTML = `<div class="st-head"><div>
        <h2 class="st-title">Study</h2>
        <p class="st-sub">Spaced repetition over your own cards. Cards can point back at the note they came from.</p>
      </div><div class="st-actions">
        <button class="btn" data-st-act="reviewall" ${s.due ? "" : "disabled"}>Review ${s.due} due</button>
        <button class="btn ghost" data-st-act="newdeck">New deck</button>
      </div></div>

      <div class="st-grid">
        <div class="st-card"><b>${s.due}</b><small>Due now</small></div>
        <div class="st-card"><b>${s.cards}</b><small>Cards</small></div>
        <div class="st-card"><b>${s.accuracy == null ? "-" : s.accuracy + "%"}</b><small>Recall accuracy</small></div>
        <div class="st-card"><b>${s.mins}<span style="font-size:12px;color:var(--m)">m</span></b><small>Time studied</small></div>
        <div class="st-card"><b>${s.quizPct == null ? "-" : s.quizPct + "%"}</b><small>Quiz average</small></div>
      </div>

      <div class="st-sec"><h3>Last 7 days</h3>
        <div class="st-barsrow"><div class="st-bars">${s.days.map((d) => `<i class="${d.n ? "on" : ""}" style="height:${Math.round((d.n / s.max) * 100)}%" title="${d.n} review${d.n === 1 ? "" : "s"}"><span>${d.label}</span></i>`).join("")}</div></div>
      </div>

      <div class="st-sec"><h3>Decks</h3>
        ${studyStore.decks.length ? `<div class="st-list">${studyStore.decks.map(deckRow).join("")}</div>` : '<p class="st-empty"><b>No decks yet.</b>Make one, then add cards by hand or from a note selection.</p>'}
      </div>

      <div class="st-sec"><h3>Recent sessions</h3>${sessions}</div>
      ${deckForm ? `<div class="st-form"><h4>New deck</h4><input id="stDeckName" placeholder="Deck name" aria-label="New deck name"><input id="stDeckSubject" placeholder="Subject (optional)" aria-label="Deck subject"><div class="st-formrow"><button class="btn" data-st-act="mkdeck">Create deck</button><button class="btn ghost" data-st-act="canceldeck">Cancel</button></div></div>` : ""}`;
  }

  function renderDeck(host) {
    const d = studyStore.decks.find((x) => x.id === studyDeck);
    if (!d) { studyPane = "dash"; return renderDash(host); }
    const cards = deckCards(d.id);
    const due = dueCards(d.id).length;
    const pre = prefill;
    prefill = null;
    let head = `<div class="st-head"><div>
        <h2 class="st-title">${esc(d.name)}</h2>
        <p class="st-sub">${cards.length} card${cards.length === 1 ? "" : "s"} &middot; ${due} due${d.subject ? " &middot; " + esc(d.subject) : ""}</p>
      </div><div class="st-actions">
        <button class="btn" data-st-act="review" ${due ? "" : "disabled"}>Review due</button>
        <button class="btn ghost" data-st-act="quiz" ${cards.length >= 2 ? "" : "disabled"}>Quiz</button>
        <button class="btn ghost" data-st-act="renamedeck">Rename</button>
        <button class="btn ghost" data-st-act="deldeck">Delete</button>
      </div></div>`;
    if (renameDeck) {
      head += `<div class="st-form"><h4>Rename deck</h4><input id="stDeckRename" value="${esc(d.name)}" aria-label="Deck name"><input id="stDeckSubject2" value="${esc(d.subject || "")}" placeholder="Subject (optional)" aria-label="Deck subject"><div class="st-formrow"><button class="btn" data-st-act="savedeck">Save</button><button class="btn ghost" data-st-act="cancelrename">Cancel</button></div></div>`;
    }
    if (confirmDeck) {
      head += `<div class="aery-folderconfirm"><p>Delete ${esc(d.name)} and its ${cards.length} card${cards.length === 1 ? "" : "s"}? This cannot be undone.</p><button class="btn" data-st-act="deldeckok">Delete deck</button><button class="btn ghost" data-st-act="cancelrename">Cancel</button></div>`;
    }

    const rows = cards.map((c) => `<div class="st-row">
      <div class="st-row-main"><b>${esc(c.question)}</b><small>${esc(c.answer)}</small></div>
      ${c.source_note_id ? `<button class="st-src" data-st-note="${esc(c.source_note_id)}" style="border:0;background:none;color:var(--v);cursor:pointer;font:inherit;font-size:11px">Source</button>` : ""}
      <span class="st-badge ${dueOf(c) ? "due" : ""}">${cardDue(c)}</span>
      ${confirmCard === c.id
        ? `<span style="font-size:11px;color:#e2695e">Delete?</span><button class="btn ghost" data-st-delok="${esc(c.id)}" style="padding:3px 8px;font-size:11px">Yes</button><button class="btn ghost" data-st-delno="1" style="padding:3px 8px;font-size:11px">No</button>`
        : `<button class="btn ghost" data-st-edit="${esc(c.id)}" style="padding:3px 8px;font-size:11px">Edit</button><button class="btn ghost" data-st-del="${esc(c.id)}" style="padding:3px 8px;font-size:11px">Delete</button>`}
    </div>`).join("");

    const preSrc = (pre && pre.src) || "";
    const edit = editCard ? studyStore.cards.find((x) => x.id === editCard) : null;
    const q = edit ? edit.question : (pre ? pre.q : "");
    const a = edit ? edit.answer : "";
    const srcNow = edit ? edit.source_note_id : preSrc;
    const opts = `<option value="">No source note</option>` + notes.map((n) => `<option value="${esc(n.id)}"${n.id === srcNow ? " selected" : ""}>${esc(n.title)}</option>`).join("");

    host.innerHTML = head +
      (cards.length ? `<div class="st-list">${rows}</div>` : '<p class="st-empty"><b>No cards yet.</b>Add one below, or select text in a note and press + Card.</p>') +
      `<div class="st-form"><h4>${edit ? "Edit card" : "New card"}</h4>
        <textarea id="stQ" placeholder="Question" aria-label="Card question">${esc(q)}</textarea>
        <textarea id="stA" placeholder="Answer" aria-label="Card answer">${esc(a)}</textarea>
        <select id="stSrc" aria-label="Source note">${opts}</select>
        <div class="st-formrow"><button class="btn" data-st-act="savecard">${edit ? "Save card" : "Add card"}</button>${edit ? '<button class="btn ghost" data-st-act="cancelcard">Cancel</button>' : ""}<small>${notes.length ? "Link the note this came from." : "No notes to link yet."}</small></div>
      </div>`;
  }

  function startReview(deckId, ids) {
    const pool = ids || dueCards(deckId).map((c) => c.id);
    if (!pool.length) { T("Nothing is due here right now.", true); return; }
    review = { ids: shuffle(pool.slice()).slice(0, 20), i: 0, shown: false, answered: 0, remembered: 0, deck: deckId || "", started: nowSec() };
    studyPane = "review";
    renderStudyPane();
  }

  async function beginSession(deckId) {
    try {
      studyStore = await call("study_session_start", { deck: deckId || null });
      const open = (studyStore.sessions || []).filter((s) => !s.ended);
      sessionId = open.length ? open[open.length - 1].id : "";
    } catch (e) { TG.add("study.session", e); sessionId = ""; }
  }

  function renderReview(host) {
    if (review.i >= review.ids.length) {
      const mins = Math.max(0, Math.round((nowSec() - review.started) / 60));
      const pct = review.answered ? Math.round((100 * review.remembered) / review.answered) : 0;
      const done = review;
      host.innerHTML = `<div class="st-review">
        <div class="st-head"><div><h2 class="st-title">Session complete</h2><p class="st-sub">${done.answered} card${done.answered === 1 ? "" : "s"} &middot; ${mins < 1 ? "under a minute" : mins + " min"}</p></div></div>
        <div class="st-grid"><div class="st-card"><b>${pct}%</b><small>Remembered</small></div><div class="st-card"><b>${done.answered}</b><small>Reviewed</small></div></div>
        <div class="st-actions"><button class="btn" data-st-act="dash">Back to study</button><button class="btn ghost" data-st-deck="${esc(done.deck)}">Open deck</button></div>
      </div>`;
      if (sessionId) {
        const sid = sessionId; sessionId = "";
        call("study_session_end", { id: sid }).then((s) => { studyStore = s; }).catch(() => {});
      }
      return;
    }
    const c = studyStore.cards.find((x) => x.id === review.ids[review.i]);
    if (!c) { review.i++; return renderReview(host); }
    const pct = Math.round((review.i / review.ids.length) * 100);
    host.innerHTML = `<div class="st-review">
      <div class="st-reviewmeta"><span>${review.i + 1} / ${review.ids.length}</span><div class="st-progress" style="flex:1"><i style="width:${pct}%"></i></div><span>${esc((studyStore.decks.find((d) => d.id === c.deck_id) || {}).name || "Deck")}</span></div>
      <div class="st-qcard"><span class="st-label">Question</span><q>${esc(c.question)}</q>
        ${review.shown ? `<div class="st-answer">${esc(c.answer)}</div>` : ""}
      </div>
      ${review.shown
        ? `<div class="st-grades">
            <button class="btn ghost" data-st-grade="again">Again</button>
            <button class="btn ghost" data-st-grade="hard">Hard</button>
            <button class="btn" data-st-grade="good">Good</button>
            <button class="btn ghost" data-st-grade="easy">Easy</button>
          </div>
          <p class="st-src">${c.source_note_id ? `<button data-st-note="${esc(c.source_note_id)}">Open the source note</button>` : "No source note."}</p>`
        : `<div class="st-actions"><button class="btn" data-st-act="reveal">Show answer</button></div>`}
    </div>`;
  }

  function renderQuiz(host) {
    if (quiz.result) {
      const r = quiz.result;
      const wrong = r.wrong || [];
      host.innerHTML = `<div class="st-review">
        <div class="st-head"><div><h2 class="st-title">Quiz result</h2><p class="st-sub">${esc(r.title)}</p></div></div>
        <div class="st-score"><b>${r.correct}</b><span>of ${r.total} correct</span></div>
        ${wrong.length ? `<div class="st-sec"><h3>What to revisit</h3><div class="st-list">${wrong.map((w) => `<div class="st-row"><div class="st-row-main"><b>${esc(w.question)}</b><small>You chose: ${esc(w.chosen)}<br>Correct: ${esc(w.answer)}</small></div></div>`).join("")}</div></div>` : '<p class="st-empty"><b>Clean sweep.</b>Every answer was right.</p>'}
        <div class="st-actions"><button class="btn" data-st-act="newquiz">New quiz</button>${wrong.length ? '<button class="btn ghost" data-st-act="reviewwrong">Review the ones I missed</button>' : ""}<button class="btn ghost" data-st-act="dash">Back to study</button></div>
      </div>`;
      return;
    }
    const q = quiz.qs[quiz.i];
    const picked = quiz.answers[quiz.i];
    host.innerHTML = `<div class="st-review">
      <div class="st-reviewmeta"><span>${quiz.i + 1} / ${quiz.qs.length}</span><div class="st-progress" style="flex:1"><i style="width:${Math.round((quiz.i / quiz.qs.length) * 100)}%"></i></div></div>
      <div class="st-qcard"><span class="st-label">Question</span><q>${esc(q.q)}</q></div>
      <div class="st-choices">${q.choices.map((c, i) => `<button class="st-choice ${picked === i ? "on" : ""}" data-st-pick="${i}"><i>${"ABCD"[i]}</i><span>${esc(c)}</span></button>`).join("")}</div>
      <div class="st-actions"><button class="btn" data-st-act="${quiz.i === quiz.qs.length - 1 ? "submitquiz" : "nextq"}" ${picked == null || picked < 0 ? "disabled" : ""}>${quiz.i === quiz.qs.length - 1 ? "Finish quiz" : "Next"}</button><button class="btn ghost" data-st-act="dash">Leave</button></div>
    </div>`;
  }

  function renderStudy() {
    renderStudyRail();
    renderStudyPane();
    if (!studyReady) ensureStudy().then(() => { if (view === "study") { renderRail(); renderStudyPane(); } });
  }

  function renderStudyRail() {
    const host = E("aeryStudyRail");
    if (!host) return;
    if (view !== "study") { host.hidden = true; return; }
    host.hidden = false;
    const due = dueCards("").length;
    const decks = studyStore.decks.map((d) => {
      const n = dueCards(d.id).length;
      return `<button class="st-railbtn ${studyPane !== "dash" && studyDeck === d.id ? "on" : ""}" data-st-deck="${esc(d.id)}"><span>${esc(d.name)}</span><em class="${n ? "due" : ""}">${n}</em></button>`;
    }).join("");
    host.innerHTML = `<div class="st-railtop"><b>${due}</b><small>due now</small></div>
      <button class="st-railbtn ${studyPane === "dash" ? "on" : ""}" data-st-act="dash"><span>Overview</span><em>${studyStore.cards.length}</em></button>
      <div class="st-raildecks"><h4>Decks</h4>${decks || '<p class="st-empty" style="padding:10px;font-size:11px">No decks yet.</p>'}</div>
      ${deckForm ? `<div class="st-form"><input id="stDeckName" placeholder="Deck name" aria-label="New deck name"><div class="st-formrow"><button class="btn" data-st-act="mkdeck">Create</button><button class="btn ghost" data-st-act="canceldeck">Cancel</button></div></div>` : `<button class="btn ghost" data-st-act="newdeck">+ Deck</button>`}`;
  }

  async function saveDeck() {
    const nameEl = E("stDeckName"), subEl = E("stDeckSubject");
    const name = ((nameEl && nameEl.value) || "").trim();
    if (!name) { T("A deck needs a name.", true); return; }
    try {
      const before = new Set(studyStore.decks.map((d) => d.id));
      studyStore = await call("study_deck_save", { deck: { id: "", name, subject: (subEl && subEl.value) || "" } });
      const made = studyStore.decks.find((d) => !before.has(d.id));
      deckForm = false;
      studyDeck = made ? made.id : studyDeck;
      studyPane = "deck";
      renderStudy();
      T("Deck created.");
    } catch (e) { T(String(e.message || e), true); }
  }

  async function saveCard() {
    const q = ((E("stQ") && E("stQ").value) || "").trim();
    const a = ((E("stA") && E("stA").value) || "").trim();
    const src = (E("stSrc") && E("stSrc").value) || "";
    if (!q || !a) { T("A card needs a question and an answer.", true); return; }
    try {
      studyStore = await call("study_card_save", { card: { id: editCard, deck_id: studyDeck, question: q, answer: a, source_note_id: src } });
      editCard = "";
      prefill = null;
      renderStudy();
      T("Card saved.");
    } catch (e) { T(String(e.message || e), true); }
  }

  async function gradeCard(grade) {
    const c = studyStore.cards.find((x) => x.id === review.ids[review.i]);
    if (!c) { review.i++; return renderStudyPane(); }
    try {
      studyStore = await call("study_review", { id: c.id, grade, session: sessionId || null });
    } catch (e) { TG.add("study.review", e); T(String(e.message || e), true); return; }
    review.answered++;
    if (grade !== "again") review.remembered++;
    review.i++;
    review.shown = false;
    renderStudyPane();
    renderStudyRail();
  }

  function startQuiz(deckId) {
    const qs = questionsFor(deckId);
    if (!qs) { T("A quiz needs at least two cards with answers.", true); return; }
    quiz = { qs, i: 0, answers: new Array(qs.length).fill(-1), result: null };
    studyPane = "quiz";
    renderStudyPane();
  }

  async function submitQuiz() {
    const correct = quiz.qs.reduce((n, q, i) => n + (quiz.answers[i] === q.choices.indexOf(q.answer) ? 1 : 0), 0);
    const d = studyStore.decks.find((x) => x.id === studyDeck);
    const result = {
      deck_id: studyDeck || "",
      title: (d ? d.name : "Quiz") + " quiz",
      total: quiz.qs.length,
      correct,
      wrong: quiz.qs.map((q, i) => ({ q, i, pick: quiz.answers[i] })).filter((x) => x.pick !== x.q.choices.indexOf(x.q.answer))
        .map((x) => ({ card_id: x.q.card_id, question: x.q.q, chosen: x.pick >= 0 ? x.q.choices[x.pick] : "(no answer)", answer: x.q.answer })),
    };
    try {
      studyStore = await call("study_quiz_save", { quiz: result });
      quiz.result = result;
      renderStudyPane();
      renderStudyRail();
    } catch (e) { T(String(e.message || e), true); }
  }

  function openSourceNote(id) {
    const n = notes.find((x) => x.id === id);
    view = "notes";
    applyView();
    if (!n) { T("That source note is no longer in the vault.", true); return; }
    open(id);
  }

  async function makeCardFromSelection() {
    if (!cur) return;
    const ed = E("aeryEditor");
    let sel = "";
    if (ed && typeof ed.selectionStart === "number" && ed.selectionEnd > ed.selectionStart) {
      sel = ed.value.slice(ed.selectionStart, ed.selectionEnd).trim();
    }
    await ensureStudy();
    prefill = { q: sel.slice(0, 600), src: cur };
    editCard = "";
    view = "study";
    if (studyStore.decks.length) {
      studyDeck = studyStore.decks.some((d) => d.id === studyDeck) ? studyDeck : studyStore.decks[0].id;
      studyPane = "deck";
    } else {
      studyPane = "dash";
      deckForm = true;
    }
    applyView();
    if (studyPane === "deck") {
      const qEl = E("stQ");
      if (qEl) { try { qEl.focus(); } catch (e) { /* not focusable */ } }
    }
  }

  async function studyAction(act) {
    if (act === "dash") { studyPane = "dash"; studyDeck = studyDeck || ""; renderStudy(); return; }
    if (act === "newdeck") { deckForm = true; renderStudyRail(); renderStudyPane(); return; }
    if (act === "canceldeck") { deckForm = false; renderStudyRail(); renderStudyPane(); return; }
    if (act === "mkdeck") { await saveDeck(); return; }
    if (act === "reviewall") {
      await beginSession("");
      startReview("", dueCards("").map((c) => c.id));
      return;
    }
    if (act === "review") { await beginSession(studyDeck); startReview(studyDeck); return; }
    if (act === "quiz") { startQuiz(studyDeck); return; }
    if (act === "reviewwrong") {
      const ids = quiz && quiz.result ? (quiz.result.wrong || []).map((w) => w.card_id).filter(Boolean) : [];
      if (!ids.length) { T("Nothing to revisit from that quiz.", true); return; }
      await beginSession(studyDeck);
      quiz = null;
      startReview(studyDeck, ids);
      return;
    }
    if (act === "newquiz") { startQuiz(studyDeck); return; }
    if (act === "renamedeck") { renameDeck = true; confirmDeck = false; renderStudyPane(); return; }
    if (act === "cancelrename") { renameDeck = false; confirmDeck = false; renderStudyPane(); return; }
    if (act === "savedeck") {
      const name = ((E("stDeckRename") && E("stDeckRename").value) || "").trim();
      const subject = (E("stDeckSubject2") && E("stDeckSubject2").value) || "";
      const d = studyStore.decks.find((x) => x.id === studyDeck);
      if (!d) return;
      if (!name) { T("A deck needs a name.", true); return; }
      try {
        studyStore = await call("study_deck_save", { deck: { id: d.id, name, subject } });
        renameDeck = false;
        renderStudy();
      } catch (e) { T(String(e.message || e), true); }
      return;
    }
    if (act === "deldeck") { confirmDeck = true; renameDeck = false; renderStudyPane(); return; }
    if (act === "deldeckok") {
      try {
        studyStore = await call("study_deck_delete", { id: studyDeck, deleteCards: true });
        confirmDeck = false;
        studyPane = "dash"; studyDeck = ""; editCard = "";
        renderStudy();
        T("Deck deleted.");
      } catch (e) { T(String(e.message || e), true); }
      return;
    }
    if (act === "reveal") { if (review) { review.shown = true; renderStudyPane(); } return; }
    if (act === "savecard") { await saveCard(); return; }
    if (act === "cancelcard") { editCard = ""; renderStudyPane(); return; }
    if (act === "nextq") { if (quiz && quiz.i < quiz.qs.length - 1) { quiz.i++; renderStudyPane(); } return; }
    if (act === "submitquiz") { await submitQuiz(); return; }
  }

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
    on("aeryViewNotes", "click", () => { view = "notes"; applyView(); });
    on("aeryViewGraph", "click", () => { view = "graph"; applyView(); });
    on("aeryViewStudy", "click", () => { view = "study"; applyView(); });
    on("aeryRead", "click", () => { if (cur) setReading(!reading); });
    on("aeryCardSel", "click", () => { makeCardFromSelection(); });
    on("aeryExportNote", "click", () => { exportNote(); });
    on("aeryExportVault", "click", () => { exportVault(false); });
    on("aeryImport", "click", () => { importInto(false); });
    on("aeryImportFolder", "click", () => { importInto(true); });
    on("aeryFolderNew", "click", () => { newFolder(); });
    on("aeryFolderAdd", "click", () => { addFolder(); });
    on("aeryFolderCancel", "click", () => { hideFolderForm(); });
    on("aeryFolderSel", "change", () => {
      const fs = E("aeryFolderSel");
      if (fs) moveTo(fs.value);
    });
    on("aeryFolderName", "keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); addFolder(); }
      if (ev.key === "Escape") { ev.preventDefault(); hideFolderForm(); }
    });

    const fold = E("aeryFolders");
    if (fold) {
      fold.addEventListener("click", (ev) => {
        const t = ev.target.closest("[data-afmenu],[data-afrename],[data-afdel],[data-afrenameok],[data-afdelok],[data-afcancel]");
        if (!t) return;
        if (t.hasAttribute("data-afcancel")) { renameFolderFrom = ""; delFolder = ""; folderMenu = ""; renderFolders(); return; }
        if (t.hasAttribute("data-afmenu")) { folderMenu = folderMenu === t.getAttribute("data-afmenu") ? "" : t.getAttribute("data-afmenu"); renderFolders(); return; }
        if (t.hasAttribute("data-afrename")) { renameFolderFrom = t.getAttribute("data-afrename"); delFolder = ""; folderMenu = ""; renderFolders(); return; }
        if (t.hasAttribute("data-afdel")) { delFolder = t.getAttribute("data-afdel"); renameFolderFrom = ""; folderMenu = ""; renderFolders(); return; }
        if (t.hasAttribute("data-afrenameok")) { renameFolder(); return; }
        if (t.hasAttribute("data-afdelok")) { deleteFolder(t.getAttribute("data-afdelok")); }
      });
      fold.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && E("aeryFolderRename")) { ev.preventDefault(); renameFolder(); }
        if (ev.key === "Escape") { ev.preventDefault(); renameFolderFrom = ""; renderFolders(); }
      });
    }

    const srail = E("aeryStudyRail");
    if (srail) srail.addEventListener("click", (ev) => {
      const d = ev.target.closest("[data-st-deck]");
      if (d) {
        studyDeck = d.getAttribute("data-st-deck");
        studyPane = "deck"; renameDeck = false; confirmDeck = false; confirmCard = ""; editCard = "";
        renderStudy();
        return;
      }
      const a = ev.target.closest("[data-st-act]");
      if (a) studyAction(a.getAttribute("data-st-act"));
    });

    const spane = E("aeryStudy");
    if (spane) spane.addEventListener("click", (ev) => {
      const note = ev.target.closest("[data-st-note]");
      if (note) { openSourceNote(note.getAttribute("data-st-note")); return; }
      const grade = ev.target.closest("[data-st-grade]");
      if (grade && review) { gradeCard(grade.getAttribute("data-st-grade")); return; }
      const pick = ev.target.closest("[data-st-pick]");
      if (pick && quiz) {
        const i = Number(pick.getAttribute("data-st-pick"));
        if (quiz.answers[quiz.i] === i) quiz.answers[quiz.i] = -1;
        else quiz.answers[quiz.i] = i;
        renderQuiz(E("aeryStudy"));
        return;
      }
      const deck = ev.target.closest("[data-st-deck]");
      if (deck) {
        studyDeck = deck.getAttribute("data-st-deck");
        studyPane = "deck"; renameDeck = false; confirmDeck = false; confirmCard = ""; editCard = "";
        renderStudy();
        return;
      }
      const edit = ev.target.closest("[data-st-edit]");
      if (edit) { editCard = edit.getAttribute("data-st-edit"); prefill = null; studyPane = "deck"; renderStudyPane(); return; }
      const del = ev.target.closest("[data-st-del]");
      if (del) { confirmCard = del.getAttribute("data-st-del"); renderStudyPane(); return; }
      const delok = ev.target.closest("[data-st-delok]");
      if (delok) {
        const id = delok.getAttribute("data-st-delok");
        confirmCard = "";
        call("study_card_delete", { id }).then((s) => {
          studyStore = s;
          if (editCard === id) editCard = "";
          renderStudy();
          T("Card deleted.");
        }).catch((e) => T(String(e.message || e), true));
        return;
      }
      if (ev.target.closest("[data-st-delno]")) { confirmCard = ""; renderStudyPane(); return; }
      const a = ev.target.closest("[data-st-act]");
      if (a) studyAction(a.getAttribute("data-st-act"));
    });

    const iom = E("aeryIoMsg");
    if (iom) iom.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-aeryio=force]")) exportVault(true);
    });

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
        // Deliberately not calling flush() here. flush() is async: it clears the
        // pending autosave and then awaits IPC, which cannot complete once the
        // document is going away. Blocking the close is right; swapping a timer
        // that would have finished the save for a write that cannot is not.
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
    // Both the tab strip and the graph are re-rendered, so clicks are delegated.
    const tabHost = E("aeryTabs");
    if (tabHost) tabHost.addEventListener("click", (ev) => {
      const x = ev.target.closest("[data-aeryclose]");
      if (x) { closeTab(x.getAttribute("data-aeryclose")); return; }
      const o = ev.target.closest("[data-aeryopen]");
      if (o) open(o.getAttribute("data-aeryopen"));
    });
    const graphHost = E("aeryGraph");
    if (graphHost) graphHost.addEventListener("click", (ev) => {
      const o = ev.target.closest("[data-aeryopen]");
      if (o) open(o.getAttribute("data-aeryopen"));
    });
    const previewHost = E("aeryPreview");
    if (previewHost) previewHost.addEventListener("click", (ev) => {
      const o = ev.target.closest("[data-aeryopen]");
      if (o) open(o.getAttribute("data-aeryopen"));
    });
    // Ctrl/Cmd+E is the convention for swapping between writing and reading.
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("keydown", (ev) => {
        if (!(ev.ctrlKey || ev.metaKey) || (ev.key !== "e" && ev.key !== "E")) return;
        const page = E("aery");
        if (!cur || view !== "notes" || (page && page.hidden)) return;
        ev.preventDefault();
        setReading(!reading);
      });
    }
    const ph = E("aeryPlaceholder");
    if (ph) ph.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-aerynew]")) create();
    });
  }

  function render() { renderRail(); renderContext(); renderStatus(); renderTabs(); }
  function active() { return !!cur; }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { wire(); refresh(); });
    else { wire(); refresh(); }
  }

  return {
    refresh, open, create, flush, render, active, current: () => cur,
    closeTab, graph, tabs: () => tabs.slice(), view: () => view,
    md, setReading, reading: () => reading,
    // Read-only hooks for the test harness; they do not drive the UI.
    study: () => ({ studyStore, pane: studyPane, deck: studyDeck, stats: stats(), questions: questionsFor }),
  };
})();

if (typeof window !== "undefined") window.Aery = Aery;
