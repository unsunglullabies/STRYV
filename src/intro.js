"use strict";
const Intro = (() => {
  // Defined here rather than borrowed from core.js. A launch screen that
  // silently depends on another file loading first is one refactor away from
  // being a black screen again, and these shadow any global of the same name
  // without colliding with it.
  const q = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TL = { appear: 260, lid: 300, ign: 720, launch: 520, cover0: 900, cover1: 1750, clr0: 1700, clr1: 3050, end: 3400 };
  const SP = 128, K = 0.65;
  let st = null, shown = false;

// Startup timeline. Mirrors boot_mark on the Rust side into
// %TEMP%\stryv-startup.log so a slow start can be traced, not guessed at.
const mark = (label) => {
  try {
    const t = window.__TAURI__;
    if (t && t.core && t.core.invoke)
      t.core.invoke("boot_mark", { label: "JS  " + label + " (page time " + Math.round(performance.now()) + " ms)" }).catch(() => {});
  } catch (e) { /* diagnostics only */ }
};
mark("scripts running (intro.js loaded)");
  const c01 = (v) => Math.min(1, Math.max(0, v));
  const cl = (v, a, b) => Math.min(b, Math.max(a, v));
  const sm = (a, b, v) => { const t = c01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const hash = (x, y) => { let h = Math.imul(x, 374761393) + Math.imul(y, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
  const vn = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf); return hash(xi, yi) * (1 - u) * (1 - v) + hash(xi + 1, yi) * u * (1 - v) + hash(xi, yi + 1) * (1 - u) * v + hash(xi + 1, yi + 1) * u * v; };
  const fbm = (x, y) => { let s = 0, a = .5, f = 1; for (let i = 0; i < 3; i++) { s += a * vn(x * f, y * f); f *= 2; a *= .5; } return s / .875; };

  const HTML = `<canvas id="icv"></canvas><div class="iback"><div class="iglow"></div></div>
<svg class="irk" viewBox="0 0 40 120" overflow="visible"><defs>
<linearGradient id="ig1" x1="0" x2="1"><stop offset="0" stop-color="#4a4f5e"/><stop offset=".38" stop-color="#e8eaf2"/><stop offset=".62" stop-color="#8a90a4"/><stop offset="1" stop-color="#2a2d38"/></linearGradient>
<linearGradient id="ig3" x1="0" x2="1"><stop offset="0" stop-color="#2d303b"/><stop offset="1" stop-color="#5a5f70"/></linearGradient>
<linearGradient id="ig2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".25" style="stop-color:var(--v)"/><stop offset="1" style="stop-color:var(--v);stop-opacity:0"/></linearGradient>
<clipPath id="igc"><path d="M20 2C27 18 29 40 28 96H12C11 40 13 18 20 2Z"/></clipPath></defs>
<g id="ifl" style="transform-origin:20px 106px;transform:scaleY(0)"><path d="M15 106Q16 138 20 172Q24 138 25 106Z" fill="url(#ig2)"/><path d="M17.2 106Q18 126 20 146Q22 126 22.8 106Z" fill="#fff" opacity=".85"/></g>
<path d="M12 80L2 106L12 101Z" fill="url(#ig3)"/><path d="M28 80L38 106L28 101Z" fill="url(#ig3)"/>
<path d="M20 2C27 18 29 40 28 96H12C11 40 13 18 20 2Z" fill="url(#ig1)"/>
<rect x="10" y="60" width="20" height="6" style="fill:var(--v)" clip-path="url(#igc)"/>
<path d="M13 96H27L25 107H15Z" fill="#1c1f29" stroke="#3a3e4c" stroke-width=".6"/></svg>
<div class="ilid l"></div><div class="ilid r"></div><div class="ifront"></div>
<div class="iwait"></div><div class="ifoot"><span class="iv">STRYV</span><button class="iskip" type="button">Skip</button></div><div class="imsg" role="status" aria-live="polite"></div><div class="isweep"></div>`;

  // Geometry without a live state object, so launch() can size the smoke
  // field before the first frame runs.
  function g0() { return geom(); }

  function geom() {

    const vw = innerWidth, vh = innerHeight, bh = cl(vh * .4, 200, 460), bw = bh * .74, rh = bh * .56, cx = vw / 2, cy = vh / 2, boxBot = cy + bh / 2, rkBottom = boxBot - bh * .14;
    return { vw, vh, bh, bw, rh, cx, cy, boxTop: cy - bh / 2, rkBottom, D: rkBottom + rh * .6 + 40, maxD: Math.hypot(cx, cy) };
  }
  function setVars() {
    const g = geom(), s = st.root.style;
    s.setProperty("--bh", g.bh + "px"); s.setProperty("--bw", g.bw + "px"); s.setProperty("--rh", g.rh + "px");
    st.cv.width = Math.round(g.vw * K); st.cv.height = Math.round(g.vh * K);
    if (st.field) st.field.resize(g.vw, g.vh, st.spread);
  }

  function msg(text, btns = []) {
    const m = st.root.querySelector(".imsg"); m.innerHTML = `<p>${esc(text)}</p><div class="ibtn"></div>`;
    btns.forEach(([t, f], i) => { const b = document.createElement("button"); b.className = "btn" + (i ? " ghost" : ""); b.textContent = t; b.onclick = f; m.querySelector(".ibtn").appendChild(b); });
    const b0 = m.querySelector("button"); if (b0) b0.focus();
  }
  // Screenshots cannot answer this: WebView2 windows do not composite into
  // PrintWindow, and a screen grab records whatever happens to be in front. The
  // app reporting its own DOM is the only trustworthy evidence that nothing is
  // left painting over the interface.
  function audit() {
    setTimeout(() => {
      const cv = document.getElementById("icv");
      const intro = document.getElementById("intro");
      let lit = "n/a";
      if (cv) {
        try {
          const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
          let n = 0;
          for (let k = 3; k < d.length; k += 4) if (d[k] > 4) n++;
          lit = n + "px";
        } catch (e) { lit = "unreadable"; }
      }
      mark("audit+3s: intro=" + (intro ? "PRESENT" : "gone") +
           " canvas=" + (cv ? "PRESENT " + cv.width + "x" + cv.height + " lit=" + lit : "gone") +
           " st=" + (st ? "live" : "null"));
    }, 3000);
  }
  function finish() {
    if (!st) return;
    mark("finish(): field=" + (st.field ? st.field.fw + "x" + st.field.fh : "none") + " wisps=" + (st.wisp ? st.wisp.length : "?") + " sparks=" + (st.spark ? st.spark.length : "?"));
    st.timers.forEach(clearTimeout); cancelAnimationFrame(st.raf); removeEventListener("resize", st.onR);
    // Free the field buffers now rather than waiting for GC. The launch screen
    // allocates a Float32Array and a canvas every run; an earlier attempt to
    // add this silently failed to apply and the leak shipped.
    if (st.field) { st.field.dispose(); st.field = null; }
    st.wisp = null; st.spark = null; st.ctx = null;
    st.root.remove(); st = null;
    audit();
  }
  function quick() { if (!st) return; st.root.classList.add("nopt", "fade"); st.timers.push(setTimeout(() => { finish(); }, 220)); }

  async function begin(readyFn) {
    const s = st;
    s.root.classList.remove("err");
    s.root.querySelector(".imsg").innerHTML = "";
    s.backend = null; s.animDone = false;
    const slow = setTimeout(() => { if (st === s) msg("Still starting…", [["Open STRYV anyway", quick]]); }, 8000);
    s.timers.push(slow);

    const motion = s.force
      ? !(matchMedia("(prefers-reduced-motion: reduce)").matches || (Cfg && Cfg.v && Cfg.v.reduceMotion))
      : !((Cfg && Cfg.v && (Cfg.v.reduceMotion || Cfg.v.intro === false)) || matchMedia("(prefers-reduced-motion: reduce)").matches);

    // The rocket lights now, not once the backend answers. A screen that is
    // moving reads as starting; an empty one reads as hung.
    mark("backend requested, motion=" + motion);
    if (motion) launch(); else s.animDone = true;

    let res;
    try { res = await readyFn(); } catch (e) { res = { ok: false, reason: String(e) }; }
    clearTimeout(slow);
    mark("backend answered, ok=" + !!(res && res.ok));
    if (st !== s) return;
    s.backend = res;
    s.root.querySelector(".imsg").innerHTML = "";

    if (!res.ok) {
      Tech.add("startup", res.reason || "Startup failed");
      s.root.classList.add("err");
      return msg("STRYV couldn't finish starting. " + (res.reason || ""), [["Retry", () => begin(readyFn)], ["Open STRYV anyway", quick]]);
    }
    try {
      if (typeof Act !== "undefined" && Act.log)
        Act.log({ text: "Launch timing: backend ready at " + Math.round(performance.now()) + " ms" });
    } catch (e) { /* logging only */ }
    maybeFinish();
  }

  // Close only when the backend has actually answered AND the rocket has
  // finished: a fast backend never cuts the animation short, and a slow one
  // never leaves a blank window.
  function maybeFinish() {
    const s = st;
    if (!s || !s.backend || !s.animDone) return;
    if (s.backend.ok) finish();
  }
  function launch() {
    const s = st;
    s.root.classList.add("fire");
    s.field = new SmokeField(0.34);
    s.field.resize(g0().vw, g0().vh);
    s.ctx = s.cv.getContext("2d"); s.wisp = []; s.spark = [];
    s.rk = s.root.querySelector(".irk"); s.fl = s.root.querySelector("#ifl");
    s.t0 = performance.now(); s.last = s.t0; s.raf = requestAnimationFrame(frame);
    mark("rocket sequence started");
    s.timers.push(setTimeout(() => {
      if (st !== s) return;
      s.animDone = true;
      mark("rocket sequence finished");
      maybeFinish();
    }, TL.end));
  }
  function frame() {
    if (!st) return;
    const now = performance.now();
    const T = Math.max(0, now - st.t0), dt = Math.min(.05, Math.max(.001, (now - st.last) / 1000));
    st.last = now;

    const g = geom(), ctx = st.ctx, root = st.root, field = st.field;
    const p = c01(T / TL.ign), u = c01((T - TL.ign) / TL.launch);
    const lift = T < TL.ign ? 0 : g.D * Math.pow(u, 2.4), vib = T < TL.ign ? p * p * 2.6 : 0;

    // --- rocket ------------------------------------------------------------
    st.rk.style.transform = `translate(${(Math.random() - .5) * vib * 2}px,${(Math.random() - .5) * vib * 2 - lift}px) rotate(${(Math.random() - .5) * vib * .3}deg)`;
    st.rk.style.visibility = u >= 1 ? "hidden" : "visible";
    const fl = T < TL.ign ? .12 + p * 1.05 : 1.2 + u * .75;
    st.fl.style.transform = `scaleY(${fl * (.92 + Math.random() * .16)})`;
    const rs = root.style;
    rs.setProperty("--glow", T < TL.ign ? .12 + .88 * p * p : 1.2 * (1 - sm(TL.ign, TL.ign + 700, T)));
    rs.setProperty("--lid", sm(0, TL.lid, T));
    const sh = T >= TL.ign ? 5 * (1 - c01((T - TL.ign) / 320)) : 0;
    rs.setProperty("--sx", (Math.random() - .5) * sh * 2 + "px");
    rs.setProperty("--sy", (Math.random() - .5) * sh * 2 + "px");
    if (T > TL.ign + 380) root.classList.add("boxout");

    // --- smoke phases ------------------------------------------------------
    // plume: builds while the rocket holds on the pad
    // ground: the pad cloud, released at ignition
    // spread: how far the cloud has rolled outward
    // fill: the final full-screen wash that carries the reveal
    const ph = {
      plume: sm(0, TL.ign * 0.85, T),
      ground: sm(TL.ign * 0.55, TL.ign + 260, T),
      spread: sm(TL.ign, TL.clr0 + 220, T),
      fill: sm(TL.clr0 - 420, TL.clr1 - 260, T),
    };
    const nozY = g.rkBottom - 13 / 120 * g.rh - lift;

    // --- wisps and sparks --------------------------------------------------
    // The field carries the mass of the smoke. These are the small, fast,
    // short-lived details it cannot resolve at field resolution: wisps tearing
    // off the plume, and sparks from ignition.
    const W = st.wisp, S = st.spark;
    const spawn = (arr, cap, x, y, vx, vy, life, w) => { if (arr.length < cap) arr.push({ x, y, vx, vy, life, born: T, w }); };
    if (T < TL.ign && Math.random() < p * .5) spawn(S, 90, g.cx + rnd(-8, 8), g.rkBottom - g.rh * .2, rnd(-160, 160), rnd(-120, 40), .5, 1);
    if (!st.burst && T >= TL.ign) {
      st.burst = true;
      for (let i = 0; i < 30; i++) spawn(S, 90, g.cx + rnd(-g.bw * .34, g.bw * .34), g.boxTop, rnd(-420, 420), rnd(-980, -280), rnd(.35, .8), 1);
    }
    // wisps peel off the nozzle and curl upward - this is the "fine detail"
    if (T >= TL.ign && T < TL.ign + TL.launch + 700) {
      const n = T < TL.ign + TL.launch ? 4 : 2;
      for (let i = 0; i < n; i++) spawn(W, 150, g.cx + rnd(-g.bh * .12, g.bh * .12), nozY - rnd(0, g.bh * .2),
        rnd(-150, 150), rnd(-260, -60), rnd(.9, 1.8), rnd(.6, 1.8));
    }
    if (T >= TL.clr0) for (let i = 0; i < 2; i++) spawn(W, 150, g.cx + rnd(-g.bw * .5, g.bw * .5), g.cy + rnd(-g.bh * .4, g.bh * .5),
      rnd(-120, 120), rnd(-180, -40), rnd(1.2, 2.2), rnd(1.2, 2.6));

    // --- render ------------------------------------------------------------
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, st.cv.width, st.cv.height);

    // The reveal is carried by the smoke itself rather than a flat vignette:
    // the cloud expands past the viewport and thins as it goes, so the app is
    // uncovered from the centre outward.
    // The smoke IS the reveal, so it has to start fading the moment the reveal
    // starts. It used to hold full opacity until expand>0.55 (2082ms) while
    // .clr went transparent at 1750ms, which put a full-strength smoke layer
    // over the fully visible app for a third of a second and then over a
    // fading app for another second. That is what it looked like.
    const expand = c01((T - TL.cover0) / (TL.clr1 - TL.cover0));
    const alpha = 1 - sm(0, 1, expand);

    st.spread = ph.spread;
    // geom() cannot carry nozY: it changes every frame as the rocket lifts, and
    // passing g without it made the entire density field NaN, which is why the
    // smoke rendered as nothing in the app while looking correct in isolation.
    const rg = { vw: g.vw, vh: g.vh, cx: g.cx, cy: g.cy, bh: g.bh, rh: g.rh, nozY: nozY };
    field.resize(g.vw, g.vh, ph.spread);
    field.render(T, rg, ph);
    field.blit(ctx, g, alpha, st.cv.width, st.cv.height);

    // flame core, additive, sits over the smoke rather than inside it
    const coreI = (1 - sm(TL.ign + 200, TL.clr0, T)) * (u < 1 ? 1 : .35);
    field.core(ctx, rg, g.cx * K, nozY * K, g.rh * (1.1 + p * .5) * K, coreI * .55);
    field.core(ctx, rg, g.cx * K, (g.cy - g.bh * .05) * K, g.bh * (1.2 + spreadScale(ph.spread) * 1.6) * K, .16 * (1 - expand * .5));

    // --- wisps -------------------------------------------------------------
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.setTransform(K, 0, 0, K, 0, 0);
    for (let i = W.length - 1; i >= 0; i--) {
      const w = W[i], age = (T - w.born) / 1000, f = age / w.life;
      if (f >= 1) { W.splice(i, 1); continue; }
      w.vy -= 26 * dt; w.vx += Math.sin(age * 3 + w.w) * 34 * dt;
      w.x += w.vx * dt; w.y += w.vy * dt;
      const a = (1 - f) * .16 * sm(0, .18, f);
      if (a < .004) continue;
      const rr = w.w * (10 + f * 46);
      const g2 = ctx.createRadialGradient(w.x, w.y, 0, w.x, w.y, rr);
      g2.addColorStop(0, `rgba(150,140,175,${a})`);
      g2.addColorStop(1, "rgba(120,110,150,0)");
      ctx.fillStyle = g2;
      ctx.fillRect(w.x - rr, w.y - rr, rr * 2, rr * 2);
    }
    ctx.restore();

    // --- sparks ------------------------------------------------------------
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.setTransform(K, 0, 0, K, 0, 0);
    ctx.lineWidth = 1.6 * K; ctx.lineCap = "round";
    for (let i = S.length - 1; i >= 0; i--) {
      const s = S[i], age = (T - s.born) / 1000; if (age >= s.life) { S.splice(i, 1); continue; }
      s.vy += 700 * dt; s.x += s.vx * dt; s.y += s.vy * dt;
      ctx.strokeStyle = `rgba(${i % 3 ? "245,166,35" : "235,230,255"},${(1 - age / s.life) * .85})`;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * .03, s.y - s.vy * .03); ctx.stroke();
    }
    ctx.restore();

    // Tie the backdrop clear to the smoke alpha instead of a fixed time, so the
    // two can never drift apart again.
    if (alpha < 0.45 && !st.clr) { st.clr = 1; root.classList.add("clr"); }
    if (T >= TL.clr0 && !st.pe) { st.pe = 1; root.classList.add("nopt"); }
    if (T >= TL.clr1 && !st.sw) { st.sw = 1; root.classList.add("sw"); }
    if (T >= TL.end) { finish(); return; }

    st.raf = requestAnimationFrame(frame);
  }

  function spreadScale(v) { return v * v * (3 - 2 * v); }
  function run(readyFn, o = {}) {
    if (st) return;
    let root = q("intro");
    if (!root) { root = document.createElement("div"); root.id = "intro"; document.body.appendChild(root); }
    // index.html paints a plain splash before any script runs. Hand over to the
    // rocket on top of it, so the window is never blank while scripts load.
    const pre = root.querySelector(".ipre");
    root.className = ""; root.style.cssText = ""; root.innerHTML = HTML;
    document.body.appendChild(root);
    if (pre) {
      root.appendChild(pre);
      requestAnimationFrame(() => { pre.style.transition = "opacity .3s"; pre.style.opacity = "0"; setTimeout(() => pre.remove(), 320); });
    }
    st = {
      root, cv: root.querySelector("#icv"), timers: [], raf: 0, force: !!o.force,
      jsAt: Math.round(performance.now()), backend: null, animDone: false,
      ac: rgb(getComputedStyle(document.documentElement).getPropertyValue("--v").trim() || "#F5A623")
    };
    st.onR = setVars; addEventListener("resize", st.onR); setVars();
    root.classList.add("in");

    // requestAnimationFrame can stay paused while the window is hidden, so the
    // reveal must not wait on it. Show now, retry briefly if the window API is
    // not attached yet.
    const reveal = () => {
      try {
        const t = window.__TAURI__;
        const w = t && t.window && t.window.getCurrentWindow ? t.window.getCurrentWindow() : null;
        if (w && typeof w.show === "function") {
          mark("calling window.show()");
          Promise.resolve(w.show()).then(() => mark("window shown"), () => mark("window.show() FAILED"));
          return true;
        }
      } catch (e) { /* not under Tauri */ }
      return false;
    };
    if (!shown) {
      shown = true;
      if (!reveal()) { let n = 0; const iv = setInterval(() => { if (reveal() || ++n > 40) clearInterval(iv); }, 50); }
    }

    st.timers.push(setTimeout(() => { if (st && !st.sprites) st.sprites = makeSprites(st.ac); }, 60));
    begin(readyFn);
  }
  return { run, active: () => !!st };
})();
