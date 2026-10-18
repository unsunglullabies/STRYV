"use strict";
// Dashboard and shell polish. Additive and decoupled: it reads what the app already shows on
// screen (so it can never disagree with it) and needs no changes to the app's own scripts.
const DashX = (() => {
  const N = 60;                                    // about 2 minutes at the default 2 s interval
  const get = (id) => document.getElementById(id);
  const all = (s, r = document) => [...r.querySelectorAll(s)];
  const toNum = (t) => { const m = /-?\d+(?:[.,]\d+)?/.exec(t || ""); return m ? parseFloat(m[0].replace(",", ".")) : null; };
  const toMbps = (t) => {                          // "1.43 Mbps", "980 Kbps", "2 MB/s" -> Mbps
    const m = /(\d+(?:[.,]\d+)?)\s*([KMG])?(bps|B\/s)/i.exec(t || ""); if (!m) return toNum(t);
    const v = parseFloat(m[1].replace(",", ".")), u = (m[2] || "").toUpperCase();
    const mult = u === "G" ? 1000 : u === "K" ? .001 : u === "M" ? 1 : 1e-6;
    return v * mult * (m[3] === "B/s" ? 8 : 1);
  };
  let last = Date.now();

  // ---- sparklines: only real readings, drawn from what the tiles already display ----
  function path(vals, lo, hi) {
    const w = 100, h = 30, n = vals.length; if (n < 2) return "";
    const step = w / (N - 1), x0 = w - (n - 1) * step;               // newest sample at the right edge
    const y = (v) => h - 2 - ((v - lo) / Math.max(hi - lo, 1e-6)) * (h - 4);
    const pts = vals.map((v, i) => [x0 + i * step, y(v)]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="a" d="${line} L${pts[n - 1][0].toFixed(1)} ${h} L${x0.toFixed(1)} ${h} Z"/><path class="l" d="${line}"/></svg>`;
  }
  const SRC = [
    { id: "cpu", parse: toNum, lo: () => 0, hi: () => 100, title: "CPU, last 2 minutes" },
    { id: "mem", parse: toNum, lo: () => 0, hi: () => 100, title: "Memory, last 2 minutes" },
    { id: "tempB", parse: toNum, lo: (v) => Math.min(...v) - 4, hi: (v) => Math.max(...v) + 4, title: "Temperature, last 2 minutes" },
    { id: "net", parse: toMbps, lo: () => 0, hi: (v) => Math.max(...v, .1) * 1.15, title: "Download, last 2 minutes" },
  ];
  function sparks() {
    SRC.forEach((s) => {
      const el = get(s.id), host = el && el.closest(".card"); if (!host) return;
      host.classList.add("dx-stat");
      const box = document.createElement("div"); box.className = "spark"; box.title = s.title; host.appendChild(box);
      const arr = [];
      new MutationObserver(() => {
        const v = s.parse(el.textContent);
        if (v == null || !isFinite(v)) { arr.length = 0; box.innerHTML = ""; return; }   // never show stale data for a sensor that stopped reporting
        arr.push(v); if (arr.length > N) arr.shift(); last = Date.now();
        box.innerHTML = path(arr, s.lo(arr), s.hi(arr));
      }).observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  // ---- storage: a used-space bar under each drive ----
  function disks() {
    const box = get("disks"); if (!box) return;
    const obs = new MutationObserver(() => {
      obs.disconnect();
      all(".disk", box).forEach((row) => {
        if (row.querySelector(".dbar")) return;
        const m = /(\d+(?:[.,]\d+)?)\s*GB free of\s*(\d+(?:[.,]\d+)?)\s*GB/i.exec(row.textContent); if (!m) return;
        const free = parseFloat(m[1].replace(",", ".")), tot = parseFloat(m[2].replace(",", "."));
        if (!(tot > 0)) return;
        const used = Math.min(100, Math.max(0, (1 - free / tot) * 100));
        const bar = document.createElement("div"); bar.className = "dbar"; bar.title = used.toFixed(0) + "% used";
        bar.innerHTML = `<i style="width:${used.toFixed(1)}%"></i>`; row.appendChild(bar);
      });
      obs.observe(box, { childList: true });
    });
    obs.observe(box, { childList: true });
  }

  // ---- dashboard header: freshness + refresh ----
  function header() {
    const host = get("dashboard"); if (!host) return;
    const t = document.createElement("div"); t.className = "ptools";
    t.innerHTML = '<span class="live"></span><span id="dxAge">Live</span><button class="btn ghost" id="dxRef" type="button">Refresh</button>';
    host.appendChild(t);
    // tick() only covers CPU, memory, uptime and disks. Network and
    // temperature are read on their own intervals, so without these two the
    // button refreshed half the page and the header still read "Live".
    get("dxRef").onclick = () => {
      if (typeof tick === "function") tick();
      if (typeof net === "function") net();
      if (typeof Sensors !== "undefined" && typeof Sensors.poll === "function") Sensors.poll();
    };
    setInterval(() => { const s = Math.round((Date.now() - last) / 1000); get("dxAge").textContent = s < 5 ? "Live" : "Updated " + s + " s ago"; }, 1000);
  }

  // ---- sidebar: a search button and collapsible groups ----
  function nav() {
    const side = document.querySelector(".side"), navEl = get("nav"); if (!side || !navEl) return;
    const sb = document.createElement("button"); sb.type = "button"; sb.className = "nx-search"; sb.setAttribute("aria-label", "Search or run a command");
    sb.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/></svg><span>Search</span><kbd>Ctrl K</kbd>';
    sb.onclick = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    side.insertBefore(sb, navEl);

    const KEY = "stryv.nav.shut"; let shut;
    try { shut = new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch (e) { shut = new Set(); }
    const groups = all(".grp", navEl);
    const members = (g) => { const out = []; for (let n = g.nextElementSibling; n && !n.classList.contains("grp"); n = n.nextElementSibling) out.push(n); return out; };
    const apply = () => groups.forEach((g) => {
      const closed = shut.has(g.textContent.trim());
      g.classList.toggle("nx-shut", closed);
      members(g).forEach((b) => b.classList.toggle("nx-hide", closed && !b.classList.contains("on")));
    });
    groups.forEach((g, i) => {
      if (i === 0) return;                          // the three main tabs always stay visible
      g.classList.add("nx-btn"); g.tabIndex = 0; g.setAttribute("role", "button");
      const flip = () => { const k = g.textContent.trim(); if (shut.has(k)) shut.delete(k); else shut.add(k); try { localStorage.setItem(KEY, JSON.stringify([...shut])); } catch (e) { /* not fatal */ } apply(); };
      g.onclick = flip; g.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } };
    });
    new MutationObserver(apply).observe(navEl, { subtree: true, attributes: true, attributeFilter: ["class"] });
    apply();
  }

  sparks(); disks(); header(); nav();
  return {};
})();
