"use strict";
// Tasks: a task manager for this PC. Everything shown is what Windows reports right now.
// Self-contained: it adds its own page, sidebar button and palette commands, so it does not
// depend on edits to the rest of the markup.
const Tasks = (() => {
  const $ = (id) => document.getElementById(id);
  const call = (cmd, args) => { try { return Promise.resolve(window.__TAURI__.core.invoke(cmd, args)); } catch (e) { return Promise.reject(e); } };
  const S = { rows: [], q: "", sort: "cpu", dir: -1, grouped: true, warm: false, timer: 0, busy: false, err: "" };
  const els = new Map();
  const fmtMem = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.max(1, Math.round(b / 1048576)) + " MB";
  const clean = (n) => n.replace(/\.exe$/i, "");
  const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/><path d="M18 15l3 3-3 3" opacity="0"/><circle cx="19" cy="18" r="2"/></svg>';

  // ---- data: one row per program (grouped) or per process (flat) ----
  function groups() {
    const q = S.q.trim().toLowerCase();
    const rows = q ? S.rows.filter((r) => r.name.toLowerCase().includes(q) || String(r.pid) === q) : S.rows;
    let list;
    if (!S.grouped) {
      list = rows.map((r) => ({ key: "p" + r.pid, name: r.name, items: [r], cpu: r.cpu, mem: r.mem, pid: r.pid, protected: r.protected, caution: r.caution, exe: r.exe }));
    } else {
      const m = new Map();
      for (const r of rows) {
        const k = r.name.toLowerCase();
        let g = m.get(k);
        if (!g) { g = { key: "g" + k, name: r.name, items: [], cpu: 0, mem: 0, pid: r.pid, protected: false, caution: false, exe: r.exe }; m.set(k, g); }
        g.items.push(r); g.cpu += r.cpu; g.mem += r.mem; g.protected = g.protected || r.protected; g.caution = g.caution || r.caution;
      }
      list = [...m.values()];
    }
    const by = { cpu: (a, b) => a.cpu - b.cpu, mem: (a, b) => a.mem - b.mem, name: (a, b) => a.name.localeCompare(b.name), pid: (a, b) => (a.pid || 0) - (b.pid || 0) }[S.sort];
    list.sort((a, b) => S.dir * by(a, b) || a.name.localeCompare(b.name));
    return list;
  }

  // ---- rendering: rows are kept and updated in place so clicks and hover are never lost ----
  function mkRow(g) {
    const tr = document.createElement("tr"); tr.dataset.k = g.key;
    tr.innerHTML = '<td class="tk-n"><div class="tk-nw"><i class="tk-ic"></i><div class="tk-nt"><b></b><small></small></div></div></td><td class="tk-c"><div class="tk-cb"><i></i></div><span></span></td><td class="tk-m"></td><td class="tk-a"></td>';
    tr._c = { ic: tr.querySelector(".tk-ic"), nm: tr.querySelector("b"), sub: tr.querySelector("small"), bar: tr.querySelector(".tk-cb i"), cpu: tr.querySelector(".tk-c span"), mem: tr.querySelector(".tk-m"), act: tr.querySelector(".tk-a"), p: null };
    return tr;
  }
  function fill(tr, g) {
    const c = tr._c, n = g.items.length, nm = clean(g.name);
    const set = (el, t) => { if (el.textContent !== t) el.textContent = t; };
    set(c.nm, nm); c.nm.title = g.exe || g.name;
    set(c.ic, nm.charAt(0).toUpperCase()); c.ic.style.setProperty("--h", hue(g.name));
    set(c.sub, (n > 1 ? n + " processes" : "PID " + g.items[0].pid) + (g.caution ? " \u00B7 desktop shell" : ""));
    set(c.cpu, S.warm ? g.cpu.toFixed(1) + "%" : "\u2026");
    c.bar.style.width = S.warm ? Math.min(100, g.cpu > 0.05 ? Math.max(3, g.cpu) : 0) + "%" : "0%";
    set(c.mem, fmtMem(g.mem));
    if (c.p !== g.protected) {
      c.p = g.protected;
      c.act.innerHTML = g.protected ? '<span class="tk-lock" title="Part of Windows or STRYV. STRYV will not end it.">Protected</span>' : '<button class="btn ghost tk-end" type="button">End task</button>';
    }
  }
  function paint(list) {
    const body = $("tkB"); const seen = new Set(); let ref = body.firstElementChild;
    for (const g of list) {
      let tr = els.get(g.key);
      if (!tr) { tr = mkRow(g); els.set(g.key, tr); }
      fill(tr, g); seen.add(g.key);
      if (tr === ref) ref = ref.nextElementSibling; else body.insertBefore(tr, ref);
    }
    for (const [k, tr] of els) if (!seen.has(k)) { tr.remove(); els.delete(k); }
  }
  function render() {
    if (!$("tkB")) return;
    const list = groups();
    paint(list);
    const total = S.rows.length, cpu = S.rows.reduce((a, r) => a + r.cpu, 0), mem = S.rows.reduce((a, r) => a + r.mem, 0);
    $("tkN").textContent = String(total);
    $("tkCpu").textContent = S.warm ? Math.min(100, cpu).toFixed(0) + "%" : "\u2026";
    $("tkMem").textContent = fmtMem(mem);
    const e = $("tkEmpty");
    e.hidden = !(S.err || (!list.length && !S.busy));
    e.textContent = S.err ? "STRYV couldn't read the program list. " + S.err : S.q ? "No programs match \u201C" + S.q + "\u201D." : "Reading programs\u2026";
    document.querySelectorAll("#tasks th[data-k]").forEach((th) => th.setAttribute("aria-sort", th.dataset.k === S.sort ? (S.dir > 0 ? "ascending" : "descending") : "none"));
  }

  // ---- polling only while the page is on screen ----
  async function refresh() {
    if (S.busy) return; S.busy = true;
    try { S.rows = await call("task_list"); S.err = ""; } catch (e) { S.err = String(e && e.message || e); }
    S.busy = false; render();
  }
  function start() { if (S.timer) return; S.warm = false; refresh(); setTimeout(() => { S.warm = true; refresh(); }, 700); S.timer = setInterval(refresh, 2000); }
  function stop() { clearInterval(S.timer); S.timer = 0; }

  // ---- ending a task ----
  async function end(key) {
    const g = groups().find((x) => x.key === key); if (!g || g.protected) return;
    const n = g.items.length, nm = clean(g.name);
    const ok = await confirmBox({
      title: "End " + nm + "?",
      body: (n > 1 ? "This ends all " + n + " " + g.name + " processes" : "This ends " + g.name + " (process " + g.items[0].pid + ")") + ", which use " + fmtMem(g.mem) + " of memory. Unsaved work in " + (n > 1 ? "them" : "it") + " will be lost." + (g.caution ? " Ending explorer.exe closes the taskbar and desktop until Windows restarts it." : ""),
      yes: "End task", danger: true,
    });
    if (!ok) return;
    try {
      const msg = n > 1 ? await call("task_end_many", { items: g.items.map((p) => ({ pid: p.pid, name: p.name })) }) : await call("task_end", { pid: g.items[0].pid, name: g.items[0].name });
      toast(String(msg));
    } catch (e) { toast(String(e && e.message || e), true); }
    setTimeout(refresh, 400);
  }

  // ---- page, navigation and palette ----
  function mount() {
    const main = document.querySelector("main"); if (!main || $("tasks")) return;
    const sec = document.createElement("section"); sec.id = "tasks"; sec.className = "page";
    sec.innerHTML = `<h1>Tasks</h1><p class="sub">Every program running on this PC, as Windows reports it right now.</p>
<div class="tk-top"><div class="card"><label>Processes</label><b id="tkN">\u2014</b></div><div class="card"><label>CPU used by programs</label><b id="tkCpu">\u2014</b></div><div class="card"><label>Memory used by programs</label><b id="tkMem">\u2014</b></div></div>
<div class="card tk-tools"><input id="tkQ" type="search" placeholder="Search programs or a process ID" aria-label="Search programs"><div class="tk-seg" role="group" aria-label="View"><button type="button" id="tkG" class="on">Grouped</button><button type="button" id="tkF">All processes</button></div></div>
<div class="card tk-wrap"><div class="tk-scroll"><table class="tk"><thead><tr><th data-k="name">Name</th><th data-k="cpu">CPU</th><th data-k="mem">Memory</th><th></th></tr></thead><tbody id="tkB"></tbody></table><p class="tk-empty" id="tkEmpty" hidden></p></div></div>
<p class="tk-note">STRYV will not end Windows system programs or itself. Ending a program closes it immediately, so unsaved work in it is lost.</p>`;
    main.appendChild(sec);

    $("tkQ").oninput = (e) => { S.q = e.target.value; render(); };
    const view = (grouped) => { S.grouped = grouped; $("tkG").classList.toggle("on", grouped); $("tkF").classList.toggle("on", !grouped); render(); };
    $("tkG").onclick = () => view(true); $("tkF").onclick = () => view(false);
    sec.querySelectorAll("th[data-k]").forEach((th) => th.onclick = () => { const k = th.dataset.k; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = k === "name" ? 1 : -1; } render(); });
    $("tkB").onclick = (e) => { const b = e.target.closest(".tk-end"); if (b) end(b.closest("tr").dataset.k); };

    const anchor = document.querySelector('#nav button[data-p="system"]') || document.querySelector('#nav button[data-p="network"]');
    if (anchor) {
      const b = document.createElement("button"); b.dataset.p = "tasks"; b.innerHTML = ICON + "<span>Tasks</span>"; b.onclick = () => go("tasks"); anchor.after(b);
    }
    if (!PAGES.includes("tasks")) PAGES.push("tasks");
    COMMANDS.push(["Go to Tasks", "Ctrl+6", () => go("tasks")], ["End a task\u2026", "", () => { go("tasks"); setTimeout(() => $("tkQ").focus(), 50); }]);
    document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "6") { e.preventDefault(); go("tasks"); } });
    new MutationObserver(() => (sec.classList.contains("on") && !document.hidden) ? start() : stop()).observe(sec, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else if (sec.classList.contains("on")) start(); });
  }
  mount();
  return { refresh };
})();
