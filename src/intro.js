"use strict";
const Intro = (() => {
  // Defined here rather than borrowed from core.js. A launch screen that
  // silently depends on another file loading first is one refactor away from
  // being a black screen again, and these shadow any global of the same name
  // without colliding with it.
  const q = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TL = { appear: 300, lid: 280, ign: 700, launch: 450, cover0: 800, cover1: 1450, clr0: 1500, clr1: 2500, end: 2820 };
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

  function makeSprites(ac) {
    const out = [];
    for (let k = 0; k < 6; k++) {
      const c = document.createElement("canvas"); c.width = c.height = SP;
      const g = c.getContext("2d"), img = g.createImageData(SP, SP), d = img.data, o = k * 37.7, tint = k >= 4;
      const n = (x, y) => fbm(x * .024 + o, y * .024 + o * .6);
      for (let y = 0; y < SP; y++) for (let x = 0; x < SP; x++) {
        const dx = (x - SP / 2) / (SP / 2), dy = (y - SP / 2) / (SP / 2), r = Math.hypot(dx, dy);
        if (r >= 1) continue;
        // A plume lights the smoke it makes. The first cut topped out near
        // rgb(104,108,120) at a soft alpha, which is indistinguishable from the
        // pad behind it - so the smoke was technically there and visually not.
        const e = 1 - r, fall = e * e * (3 - 2 * e), a = c01(n(x, y) * 2.3 - .34) * fall;
        const lit = c01(.42 + ((n(x - 2, y) - n(x + 2, y)) * .8 + (n(x, y - 2) - n(x, y + 2))) * 3.5), t = tint ? .55 * lit : 0, i = (y * SP + x) * 4;
        const base = [38 + 148 * lit, 40 + 150 * lit, 48 + 158 * lit];
        d[i] = base[0] + (ac[0] - base[0]) * t; d[i + 1] = base[1] + (ac[1] - base[1]) * t; d[i + 2] = base[2] + (ac[2] - base[2]) * t; d[i + 3] = a * 255;
      }
      g.putImageData(img, 0, 0); out.push(c);
    }
    return out;
  }

  function geom() {
    const vw = innerWidth, vh = innerHeight, bh = cl(vh * .4, 200, 460), bw = bh * .74, rh = bh * .56, cx = vw / 2, cy = vh / 2, boxBot = cy + bh / 2, rkBottom = boxBot - bh * .14;
    return { vw, vh, bh, bw, rh, cx, cy, boxTop: cy - bh / 2, rkBottom, D: rkBottom + rh * .6 + 40, maxD: Math.hypot(cx, cy) };
  }
  function setVars() {
    const g = geom(), s = st.root.style;
    s.setProperty("--bh", g.bh + "px"); s.setProperty("--bw", g.bw + "px"); s.setProperty("--rh", g.rh + "px");
    st.cv.width = Math.round(g.vw * K); st.cv.height = Math.round(g.vh * K);
  }

  function msg(text, btns = []) {
    const m = st.root.querySelector(".imsg"); m.innerHTML = `<p>${esc(text)}</p><div class="ibtn"></div>`;
    btns.forEach(([t, f], i) => { const b = document.createElement("button"); b.className = "btn" + (i ? " ghost" : ""); b.textContent = t; b.onclick = f; m.querySelector(".ibtn").appendChild(b); });
    const b0 = m.querySelector("button"); if (b0) b0.focus();
  }
  function finish() {
    if (!st) return;
    st.timers.forEach(clearTimeout); cancelAnimationFrame(st.raf); removeEventListener("resize", st.onR);
    st.root.remove(); st = null;
  }
  function quick() { if (!st) return; st.root.classList.add("nopt", "fade"); st.timers.push(setTimeout(finish, 220)); }

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
    if (!s.sprites) s.sprites = makeSprites(s.ac);
    s.ctx = s.cv.getContext("2d"); s.P = []; s.S = [];
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
    const T = Math.max(0, now - st.t0), dt = Math.min(.05, Math.max(.001, (now - st.last) / 1000)); st.last = now;
    const g = geom(), ctx = st.ctx, P = st.P, S = st.S, root = st.root, ac = st.ac;
    const p = c01(T / TL.ign), u = c01((T - TL.ign) / TL.launch);
    const lift = T < TL.ign ? 0 : g.D * Math.pow(u, 2.4), vib = T < TL.ign ? p * p * 2.6 : 0;
    st.rk.style.transform = `translate(${(Math.random() - .5) * vib * 2}px,${(Math.random() - .5) * vib * 2 - lift}px) rotate(${(Math.random() - .5) * vib * .3}deg)`;
    st.rk.style.visibility = u >= 1 ? "hidden" : "visible";
    const fl = T < TL.ign ? .12 + p * 1.05 : 1.2 + u * .75; st.fl.style.transform = `scaleY(${fl * (.92 + Math.random() * .16)})`;
    const rs = root.style; rs.setProperty("--glow", T < TL.ign ? .12 + .88 * p * p : 1.2 * (1 - sm(TL.ign, TL.ign + 700, T)));
    rs.setProperty("--lid", sm(0, TL.lid, T));
    const sh = T >= TL.ign ? 5 * (1 - c01((T - TL.ign) / 320)) : 0; rs.setProperty("--sx", (Math.random() - .5) * sh * 2 + "px"); rs.setProperty("--sy", (Math.random() - .5) * sh * 2 + "px");
    if (T > TL.ign + 350) root.classList.add("boxout");

    const nozY = g.rkBottom - 13 / 120 * g.rh - lift, ox = g.cx, oy = g.cy - g.bh * .1;
    const puff = (x, y, vx, vy, s0, s1, life, peak, tint, curl) => { if (P.length < 340) P.push({ x, y, vx, vy, s0, s1, life, peak, k: tint ? 4 + (Math.random() * 2 | 0) : Math.random() * 4 | 0, r: Math.random() * 6.28, vr: rnd(-.4, .4), curl, ph: rnd(0, 6.28), born: T }); };
    const spark = (x, y, vx, vy, life) => S.push({ x, y, vx, vy, life, born: T });
    if (T < TL.ign && Math.random() < p * .6) spark(g.cx + rnd(-8, 8), g.rkBottom - g.rh * .2, rnd(-160, 160), rnd(-120, 40), .5);
    if (!st.burst && T >= TL.ign) {
      st.burst = true;
      for (let i = 0; i < 120; i++) { const a = rnd(0, 6.28), sp = rnd(340, 1700); puff(ox, oy + rnd(-g.bh * .22, g.bh * .3), Math.cos(a) * sp, Math.sin(a) * sp * .8, rnd(70, 140), rnd(300, 520), rnd(1.8, 2.6), rnd(.8, 1), Math.random() < .3, rnd(-1.5, 1.5)); }
      for (let i = 0; i < 26; i++) spark(g.cx + rnd(-g.bw * .3, g.bw * .3), g.boxTop, rnd(-380, 380), rnd(-900, -250), rnd(.35, .7));
    }
    if (T >= TL.ign && T < TL.ign + TL.launch + 60) {
      for (let i = 0; i < 5; i++) puff(g.cx + rnd(-6, 6), nozY, rnd(-110, 110), rnd(120, 320), rnd(40, 72), rnd(170, 260), rnd(1.1, 1.6), rnd(.7, .95), Math.random() < .55, rnd(-1, 1));
      puff(g.cx, nozY, rnd(-650, 650), rnd(-60, 80), rnd(60, 95), rnd(290, 440), rnd(1.3, 1.9), rnd(.72, .95), Math.random() < .45, rnd(-1.5, 1.5));
    }
    if (T >= TL.ign + TL.launch && T < TL.ign + TL.launch + 450) for (let i = 0; i < 7; i++) { const a = rnd(0, 6.28), sp = rnd(280, 1250); puff(ox, oy + g.bh * .2, Math.cos(a) * sp, Math.sin(a) * sp * .8, rnd(80, 140), rnd(330, 560), rnd(1.5, 2.2), rnd(.8, 1), Math.random() < .35, rnd(-1.5, 1.5)); }

    const F = .45 * g.maxD, R = c01((T - TL.clr0) / (TL.clr1 - TL.clr0)) * (g.maxD + F), cover = sm(TL.cover0, TL.cover1, T);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, st.cv.width, st.cv.height); ctx.globalCompositeOperation = "source-over";
    const gr = ctx.createRadialGradient(g.cx * K, g.cy * K, Math.max(0, R - F) * K, g.cx * K, g.cy * K, (R + 1) * K);
    gr.addColorStop(0, "rgba(12,13,20,0)"); gr.addColorStop(1, `rgba(12,13,20,${cover})`);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, st.cv.width, st.cv.height);
    for (let i = P.length - 1; i >= 0; i--) {
      const q = P[i], age = (T - q.born) / 1000, f = age / q.life;
      if (f >= 1) { P.splice(i, 1); continue; }
      const dr = Math.exp(-1.5 * dt), an = q.curl * Math.sin(age * 2 + q.ph) * dt, ca = Math.cos(an), sa = Math.sin(an);
      let vx = q.vx * dr, vy = q.vy * dr - 50 * dt; const dist = Math.hypot(q.x - g.cx, q.y - g.cy);
      if (T >= TL.clr0) { vx += (q.x - g.cx) / Math.max(dist, 1) * 320 * dt; vy += (q.y - g.cy) / Math.max(dist, 1) * 320 * dt; }
      q.vx = vx * ca - vy * sa; q.vy = vx * sa + vy * ca; q.x += q.vx * dt; q.y += q.vy * dt; q.r += q.vr * dt;
      const size = q.s0 + (q.s1 - q.s0) * (1 - Math.pow(1 - c01(f * 1.3), 2));
      const al = q.peak * sm(0, .12, f) * (1 - sm(.55, 1, f)) * (T < TL.clr0 ? 1 : sm(R - F, R, dist));
      if (al < .01) continue;
      const sc = size / SP * K, c = Math.cos(q.r) * sc, s = Math.sin(q.r) * sc;
      ctx.globalAlpha = al; ctx.setTransform(c, s, -s, c, q.x * K, q.y * K); ctx.drawImage(st.sprites[q.k], -SP / 2, -SP / 2);
    }
    ctx.globalAlpha = 1; ctx.setTransform(K, 0, 0, K, 0, 0); ctx.globalCompositeOperation = "lighter";
    const ga = .14 * sm(TL.ign, TL.ign + 120, T) * (1 - sm(TL.ign + 350, TL.ign + 1100, T));
    if (ga > .01) { const rg = ctx.createRadialGradient(ox, oy, 0, ox, oy, g.maxD * .5); rg.addColorStop(0, `rgba(${ac},${ga})`); rg.addColorStop(1, `rgba(${ac},0)`); ctx.fillStyle = rg; ctx.fillRect(0, 0, g.vw, g.vh); }
    if (u < 1) { const na = .3 * Math.min(1, fl), rg = ctx.createRadialGradient(g.cx, nozY, 0, g.cx, nozY, g.rh * .7); rg.addColorStop(0, `rgba(${ac},${na})`); rg.addColorStop(1, `rgba(${ac},0)`); ctx.fillStyle = rg; ctx.fillRect(g.cx - g.rh, nozY - g.rh, g.rh * 2, g.rh * 2); }
    ctx.lineWidth = 1.6; ctx.lineCap = "round";
    for (let i = S.length - 1; i >= 0; i--) {
      const q = S[i], age = (T - q.born) / 1000; if (age >= q.life) { S.splice(i, 1); continue; }
      q.vy += 700 * dt; q.x += q.vx * dt; q.y += q.vy * dt;
      ctx.strokeStyle = `rgba(${i % 3 ? ac : "235,230,255"},${1 - age / q.life})`; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - q.vx * .03, q.y - q.vy * .03); ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    if (T >= TL.cover1 && !st.clr) { st.clr = 1; root.classList.add("clr"); }
    if (T >= TL.clr0 && !st.pe) { st.pe = 1; root.classList.add("nopt"); }
    if (T >= TL.clr1 && !st.sw) { st.sw = 1; root.classList.add("sw"); }
    if (T >= TL.end) return finish();
    st.raf = requestAnimationFrame(frame);
  }

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
