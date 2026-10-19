"use strict";
const Intro = (() => {
  // The window itself is the stage: a dark rectangle (the menu), a rocket on a pad, GPU smoke.
  const TL = { appear: 300, ign: 650, launch: 520, cover0: 850, cover1: 1900, clr0: 1950, clr1: 3400, end: 3550 };
  const KG = 0.5, K2 = 0.75;   // smoke renders at half size (it is soft); sparks at 3/4
  let st = null, shown = false;

  // Startup timeline: lines land in %TEMP%\stryv-startup.log (written by the Rust side).
  const mark = (label) => {
    try {
      const t = window.__TAURI__;
      if (t && t.core && t.core.invoke) t.core.invoke("boot_mark", { label: "JS  " + label + " (page time " + Math.round(performance.now()) + " ms)" }).catch(() => {});
    } catch (e) { /* diagnostics only */ }
  };
  mark("scripts running (intro.js loaded)");

  // Show the window now. requestAnimationFrame can be paused while the window is hidden,
  // so the reveal must not wait for a frame. Returns false if the window API is not there yet.
  function reveal() {
    try {
      const w = window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow && window.__TAURI__.window.getCurrentWindow();
      if (w && typeof w.show === "function") {
        mark("calling window.show()");
        Promise.resolve(w.show()).then(() => mark("window.show() done"), () => mark("window.show() FAILED"));
        return true;
      }
    } catch (e) { /* retried below */ }
    return false;
  }
  const c01 = (v) => Math.min(1, Math.max(0, v));
  const cl = (v, a, b) => Math.min(b, Math.max(a, v));
  const sm = (a, b, v) => { const t = c01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };

  const HTML = `<canvas id="icv"></canvas><div class="iback"></div>
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
<div class="ipad"></div><canvas id="ics"></canvas>
<div class="iwait"></div><div class="ifoot"><span class="iv">STRYV</span><button class="iskip" type="button">Skip</button></div><div class="imsg" role="status" aria-live="polite"></div>`;

  // ---- smoke: a domain-warped fractal density field, lit by the engine flame -----------
  const VS = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";
  const FS = `precision highp float;
uniform vec2 uRes,uPad;uniform vec3 uAc;
uniform float uT,uRy,uBlast,uPlume,uCover,uClear,uFire;
float h21(vec2 p){p=fract(p*vec2(233.34,851.73));p+=dot(p,p+23.45);return fract(p.x*p.y);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1.,0.)),f.x),mix(h21(i+vec2(0.,1.)),h21(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*vn(p);p=p*2.02+vec2(31.7,17.3);a*=.5;}return s;}
float sm(float a,float b,float x){x=clamp((x-a)/(b-a),0.,1.);return x*x*(3.-2.*x);}
void main(){
  vec2 R=uRes;
  vec2 p=(gl_FragCoord.xy-.5*R)/R.y;
  vec2 pad=(vec2(uPad.x,R.y-uPad.y)-.5*R)/R.y;
  vec2 nz=(vec2(uPad.x,R.y-uRy)-.5*R)/R.y;
  float t=uT;
  // puffy density: a gently warped fractal field
  vec2 q=vec2(fbm(p*1.4+vec2(0.,-t*.10)),fbm(p*1.4+vec2(5.2+t*.07,1.3)));
  vec2 pw=p*1.9+1.35*q+vec2(0.,-t*.07);
  float d0=fbm(pw);
  float dx=fbm(pw+vec2(.10,0.))-d0,dy=fbm(pw+vec2(0.,.10))-d0;
  float dd=mix(d0,.5,.25);
  // ground blast: a wide cloud rolling out from the pad
  vec2 b=(p-pad)*vec2(.62,1.35);
  float Rb=.06+uBlast*1.0;
  float blast=sm(Rb,Rb*.2,length(b)+(dd-.5)*.6*Rb);
  // exhaust column from the pad up to the nozzle, with soft ends
  float span=max(nz.y-pad.y,.002);
  float along=clamp((p.y-pad.y)/span,0.,1.);
  float inCol=sm(pad.y-.10,pad.y+.03,p.y)*(1.-sm(nz.y-.03,nz.y+.14,p.y));
  float w=mix(.13,.05,along)*(1.+.9*uBlast)*(.7+.9*dd);
  float sway=(q.x-.5)*.22*along;
  float col=sm(w,w*.10,abs(p.x-pad.x-sway))*inCol*uPlume;
  float rho=clamp(max(blast,col*.92)*(.35+1.1*dd),0.,1.);
  // the veil that fills the window (reaches full opacity at uCover=1)
  rho=max(rho,sm(0.,1.,uCover*1.25-(1.-dd)*.25));
  // wispy fine detail on the thin parts
  float fine=fbm(p*5.5+q*2.-vec2(0.,t*.2));
  rho=clamp(rho*mix(.6+.8*fine,1.,uCover),0.,1.);
  // soft, wrapped lighting from the engine flame; dense cores sit a little darker
  vec3 n3=normalize(vec3(-dx*2.2,-dy*2.2,.35));
  vec3 L=normalize(vec3(nz-p,.45));
  float dif=clamp(dot(n3,L)*.5+.5,0.,1.);
  vec2 dn=p-nz;vec2 dp=p-pad;
  float fire=uFire/(1.+24.*dot(dn,dn))+uFire*.5/(1.+18.*dot(dp,dp));
  vec3 base=mix(vec3(.11,.12,.16),vec3(.60,.62,.70),clamp(dif*.8+.25*dd,0.,1.));
  base*=1.1-.35*rho*rho;
  base=mix(base,uAc*.9,.07);
  vec3 c=base+vec3(1.,.55,.2)*fire*(.30+.9*dif)+vec3(.9,.95,1.)*(1.-rho)*rho*.10;
  // clearing: the smoke thins from the centre outward with a ragged edge
  float fld=length(p*vec2(.62,1.))*1.15+(dd-.5)*.5-p.y*.12;
  float rev=mix(1.,sm(uClear-.24,uClear,fld),step(.001,uClear));
  float a=rho*rev;
  gl_FragColor=vec4(c*a,a);
}`;
  function initGL(cv) {
    try {
      const gl = cv.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });
      if (!gl) throw new Error("WebGL is not available");
      const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader failed"); return s; };
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr) || "link failed");
      gl.useProgram(pr);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, "a"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const U = {};
      ["uRes", "uPad", "uAc", "uT", "uRy", "uBlast", "uPlume", "uCover", "uClear", "uFire"].forEach((n) => { U[n] = gl.getUniformLocation(pr, n); });
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      return { gl, U };
    } catch (e) { console.warn("launch smoke unavailable:", e); if (typeof Tech !== "undefined") Tech.add("launch smoke", String(e)); return null; }
  }
  function drawGL(G, cv, v) {
    const gl = G.gl, U = G.U;
    gl.viewport(0, 0, cv.width, cv.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(U.uRes, cv.width, cv.height); gl.uniform2f(U.uPad, v.px * KG, v.py * KG);
    gl.uniform3f(U.uAc, v.ac[0] / 255, v.ac[1] / 255, v.ac[2] / 255);
    gl.uniform1f(U.uT, v.t); gl.uniform1f(U.uRy, v.ry * KG); gl.uniform1f(U.uBlast, v.blast); gl.uniform1f(U.uPlume, v.plume);
    gl.uniform1f(U.uCover, v.cover); gl.uniform1f(U.uClear, v.clear); gl.uniform1f(U.uFire, v.fire);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function geom() {
    const vw = innerWidth, vh = innerHeight, rh = cl(vh * .30, 170, 340), padY = vh * .74;
    return { vw, vh, rh, cx: vw / 2, padY, nozBase: padY - 13 / 120 * rh, D: padY + rh * .5 + 80 };
  }
  function setVars() {
    const g = geom(), s = st.root.style;
    s.setProperty("--rh", g.rh + "px"); s.setProperty("--pad", g.padY + "px");
    st.cv.width = Math.round(g.vw * KG); st.cv.height = Math.round(g.vh * KG);
    st.c2.width = Math.round(g.vw * K2); st.c2.height = Math.round(g.vh * K2);
  }

  function msg(text, btns = []) {
    const m = st.root.querySelector(".imsg"); m.innerHTML = `<p>${esc(text)}</p><div class="ibtn"></div>`;
    btns.forEach(([t, f], i) => { const b = document.createElement("button"); b.className = "btn" + (i ? " ghost" : ""); b.textContent = t; b.onclick = f; m.querySelector(".ibtn").appendChild(b); });
    const b0 = m.querySelector("button"); if (b0) b0.focus();
  }
  function finish() {
    if (!st) return;
    mark("launch screen finished");
    st.timers.forEach(clearTimeout); cancelAnimationFrame(st.raf); removeEventListener("resize", st.onR);
    try { const e = st.G && st.G.gl.getExtension("WEBGL_lose_context"); if (e) e.loseContext(); } catch (e) { /* freeing early is optional */ }
    st.root.remove(); st = null;
    audit();
  }

  // A screenshot cannot answer this: WebView2 windows do not composite into
  // PrintWindow, and a screen grab records whatever happens to be in front of
  // them. The app reporting its own DOM is the only trustworthy evidence that
  // the launch screen took itself down and left nothing painting over the UI.
  function audit() {
    setTimeout(() => {
      const intro = document.getElementById("intro");
      const cv = document.getElementById("icv");
      let lit = "n/a";
      if (cv) {
        try {
          const gl = cv.getContext("webgl") || cv.getContext("webgl2");
          if (gl) {
            const px = new Uint8Array(4);
            gl.readPixels(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            lit = px[3] > 4 ? "lit" : "cleared";
          } else { lit = "no-context"; }
        } catch (e) { lit = "unreadable"; }
      }
      mark("audit+3s: intro=" + (intro ? "PRESENT" : "gone") +
           " canvas=" + (cv ? "PRESENT " + cv.width + "x" + cv.height + " " + lit : "gone") +
           " st=" + (st ? "live" : "null"));
    }, 3000);
  }
  function quick() { if (!st) return; st.root.classList.add("nopt", "fade"); st.timers.push(setTimeout(finish, 220)); }

  // Skip must be reachable by pointer and keyboard. 0.2.6 shipped this and a
  // rewrite of the smoke renderer dropped it, which left a launch screen you
  // could only wait out - including for anyone who cannot tolerate 3.5 seconds
  // of animation on every launch. A launch screen you cannot get past is a
  // launch screen that hangs the app.
  function bindSkip(root) {
    const go = (e) => { if (e) e.preventDefault(); quick(); };
    const b = root.querySelector(".iskip");
    if (b) {
      b.addEventListener("click", go);
      // Focus it so Enter and Space work without a click, and so the control is
      // reachable by keyboard on first paint.
      try { setTimeout(() => b.focus(), 0); } catch (e) { /* not focusable yet */ }
    }
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") go(e);
    });
  }

  async function begin(readyFn) {
    const s = st; s.root.classList.remove("err"); s.root.querySelector(".imsg").innerHTML = "";
    const appear = new Promise((r) => s.timers.push(setTimeout(r, TL.appear)));
    const slow = setTimeout(() => { if (st === s) msg("Still starting…", [["Open STRYV anyway", quick]]); }, 8000); s.timers.push(slow);
      // Startup is raced against a hard cap. Without it, a backend call that never
      // returns leaves the launch screen up indefinitely: the 8s message offers a
      // button, but a button is only an escape hatch if someone presses it.
      const HARD_CAP = 12000;
      let timedOut = false;
      let res;
      try {
        res = await Promise.race([
          Promise.resolve(readyFn()),
          new Promise((r) => s.timers.push(setTimeout(() => { timedOut = true; r(null); }, HARD_CAP))),
        ]);
      } catch (e) {
        res = { ok: false, reason: String(e && e.message ? e.message : e) };
      }
      await appear; clearTimeout(slow);
      mark("backend startup finished, ok=" + !!(res && res.ok) + (timedOut ? " (HARD CAP)" : ""));
      if (st !== s) return;
      s.root.querySelector(".imsg").innerHTML = "";

      if (timedOut) {
        // Recorded, not swallowed - then the app opens anyway. A dashboard that
        // cannot read one figure yet is still worth showing. A window that never
        // opens is not.
        Tech.add("startup", "Startup did not finish within " + (HARD_CAP / 1000) + "s; opening anyway.");
        return quick();
      }

      // Falsy, missing, or an object without ok all mean the same thing here.
      if (!res || res.ok !== true) {
        res = res && typeof res === "object" ? res : { reason: "Startup returned nothing usable." };
      Tech.add("startup", res.reason || "Startup failed"); s.root.classList.add("err");
      return msg("STRYV couldn't finish starting. " + (res.reason || ""), [["Retry", () => begin(readyFn)], ["Open STRYV anyway", quick]]);
    }
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches || Cfg.v.reduceMotion;
    if (s.force ? calm : (calm || Cfg.v.intro === false)) return quick();
    if (!s.G) return quick();   // no GPU smoke available: skip the show rather than fake it
    launch();
  }

  function launch() {
    st.root.classList.add("fire");
    st.rk = st.root.querySelector(".irk"); st.fl = st.root.querySelector("#ifl");
    if (st.fl) st.fl.style.opacity = "1";
    st.ctx = st.c2.getContext("2d"); st.S = [];
    st.t0 = performance.now(); st.last = st.t0; st.raf = requestAnimationFrame(frame);
  }

  function frame() {
    if (!st) return;
    const now = performance.now();
    const T = Math.max(0, now - st.t0), dt = Math.min(.05, Math.max(.001, (now - st.last) / 1000)); st.last = now;
    const g = geom(), ctx = st.ctx, S = st.S, root = st.root, ac = st.ac;
    const p = c01(T / TL.ign), u = c01((T - TL.ign) / TL.launch);
    const lift = T < TL.ign ? 0 : g.D * Math.pow(u, 2.2), vib = T < TL.ign ? p * p * 2.8 : 0;
    st.rk.style.transform = `translate(${(Math.random() - .5) * vib * 2}px,${(Math.random() - .5) * vib * 2 - lift}px) rotate(${(Math.random() - .5) * vib * .3}deg)`;
    st.rk.style.visibility = u >= 1 ? "hidden" : "visible";
    const fl = T < TL.ign ? .12 + p * 1.05 : 1.2 + u * .75; st.fl.style.transform = `scaleY(${fl * (.92 + Math.random() * .16)})`;
    const rs = root.style; rs.setProperty("--glow", T < TL.ign ? .12 + .88 * p * p : 1.2 * (1 - sm(TL.ign, TL.ign + 900, T)));
    const sh = T >= TL.ign ? 6 * (1 - c01((T - TL.ign) / 420)) : 0;
    rs.setProperty("--sx", (Math.random() - .5) * sh * 2 + "px"); rs.setProperty("--sy", (Math.random() - .5) * sh * 2 + "px");
    const nozY = g.nozBase - lift;

    drawGL(st.G, st.cv, {
      px: g.cx, py: g.nozBase, ry: nozY, t: T / 1000, ac,
      blast: sm(TL.ign, TL.ign + 1500, T),
      plume: sm(TL.ign, TL.ign + 160, T) * (1 - sm(TL.cover1 - 300, TL.clr0 + 300, T)),
      cover: sm(TL.cover0, TL.cover1, T),
      clear: T >= TL.clr0 ? Math.max(.002, c01((T - TL.clr0) / (TL.clr1 - TL.clr0)) * 1.35) : 0,
      fire: T < TL.ign ? .1 + .5 * p * p : 1.1 * (1 - sm(TL.ign + 450, TL.ign + 1300, T)),
    });

    // glows and sparks, drawn on top of the rocket
    const spark = (x, y, vx, vy, life) => S.push({ x, y, vx, vy, life, born: T });
    if (T < TL.ign && Math.random() < p * .7) spark(g.cx + rnd(-10, 10), g.nozBase, rnd(-180, 180), rnd(-140, 30), .5);
    if (!st.burst && T >= TL.ign) { st.burst = true; for (let i = 0; i < 60; i++) spark(g.cx + rnd(-g.rh * .3, g.rh * .3), g.nozBase, rnd(-520, 520), rnd(-950, -150), rnd(.4, .9)); }
    if (T >= TL.ign && u < 1) for (let i = 0; i < 2; i++) spark(g.cx + rnd(-6, 6), nozY, rnd(-160, 160), rnd(80, 300), rnd(.35, .7));
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, st.c2.width, st.c2.height);
    ctx.setTransform(K2, 0, 0, K2, 0, 0); ctx.globalCompositeOperation = "lighter";
    const ga = .17 * sm(TL.ign, TL.ign + 120, T) * (1 - sm(TL.ign + 300, TL.ign + 1000, T));
    if (ga > .01) { const rg = ctx.createRadialGradient(g.cx, g.nozBase, 0, g.cx, g.nozBase, g.vh * .6); rg.addColorStop(0, `rgba(${ac},${ga * 2})`); rg.addColorStop(1, `rgba(${ac},0)`); ctx.fillStyle = rg; ctx.fillRect(0, 0, g.vw, g.vh); }
    if (u < 1) { const na = .34 * Math.min(1, fl), rg = ctx.createRadialGradient(g.cx, nozY, 0, g.cx, nozY, g.rh * .8); rg.addColorStop(0, `rgba(${ac},${na})`); rg.addColorStop(1, `rgba(${ac},0)`); ctx.fillStyle = rg; ctx.fillRect(g.cx - g.rh, nozY - g.rh, g.rh * 2, g.rh * 2); }
    ctx.lineWidth = 1.6; ctx.lineCap = "round";
    for (let i = S.length - 1; i >= 0; i--) {
      const q = S[i], age = (T - q.born) / 1000; if (age >= q.life) { S.splice(i, 1); continue; }
      q.vy += 700 * dt; q.x += q.vx * dt; q.y += q.vy * dt;
      ctx.strokeStyle = `rgba(${i % 3 ? ac : "235,230,255"},${1 - age / q.life})`; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - q.vx * .03, q.y - q.vy * .03); ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    if (T >= TL.cover1 && !st.clr) { st.clr = 1; root.classList.add("clr"); }
    if (T >= TL.clr0 && !st.pe) { st.pe = 1; root.classList.add("nopt"); }
    if (T >= TL.end) return finish();
    st.raf = requestAnimationFrame(frame);
  }

  function run(readyFn, o = {}) {
    if (st) return;
    let root = q("intro"); if (!root) { root = document.createElement("div"); root.id = "intro"; document.body.appendChild(root); }
    // keep the static splash that index.html painted, and fade it out over the stage
    const pre = root.querySelector(".ipre");
    root.className = ""; root.style.cssText = ""; root.innerHTML = HTML;
    if (pre) { root.appendChild(pre); setTimeout(() => { pre.style.transition = "opacity .3s"; pre.style.opacity = "0"; setTimeout(() => pre.remove(), 340); }, 80); }
    st = { root, cv: root.querySelector("#icv"), c2: root.querySelector("#ics"), timers: [], force: !!o.force, ac: rgb(getComputedStyle(document.documentElement).getPropertyValue("--v").trim() || "#F5A623") };
    const f0 = root.querySelector("#ifl"); if (f0) f0.style.opacity = "0";
    st.onR = setVars; addEventListener("resize", st.onR); setVars();
    // Show the window first, so the static splash is on screen while the shader compiles.
    if (!shown) { shown = true; if (!reveal()) { let n = 0; const t = setInterval(() => { if (reveal() || ++n > 40) clearInterval(t); }, 50); } }
    setTimeout(() => root.classList.add("in"), 0);
    const s0 = st;
    st.timers.push(setTimeout(() => {
      if (st !== s0) return;
      st.G = initGL(st.cv);
      if (st.G) { try { drawGL(st.G, st.cv, { px: 0, py: 0, ry: 0, t: 0, ac: st.ac, blast: 0, plume: 0, cover: 0, clear: 0, fire: 0 }); } catch (e) { /* warm-up only */ } }
    }, 30));
    bindSkip(root);
    begin(o.ready || readyFn);
  }
  return { run, active: () => !!st };
})();
