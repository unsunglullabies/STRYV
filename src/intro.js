"use strict";
// The launch screen.
//
// Wrapped in an IIFE for the same reason the other pages are: a bare
// <script> tag shares one global scope with every other file on the page,
// and this one deliberately reuses ordinary names like st, msg and finish.
const Intro = (() => {
// STRYV launch screen.
// A machine coming up and reporting that it is awake — no rocket, no confetti.
// Honest: it says what is PREPARING. It never claims readings it does not have.

let st = null;

// Startup timeline: lines land in %TEMP%\stryv-startup.log (written by the Rust side).
const mark = (label) => {
  try {
    const t = window.__TAURI__;
    if (t && t.core && t.core.invoke) t.core.invoke("boot_mark", { label: "JS  " + label + " (page time " + Math.round(performance.now()) + " ms)" }).catch(() => {});
  } catch (e) { /* diagnostics only */ }
};
mark("scripts running (intro.js loaded)");

const q = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const TL = { appear: 220, step: 130, hold: 190, end: 260, out: 200 };

// Order matters: hardware before sensors, sensors before anything that reads them.
const STEPS = [
  ["Hardware", "inventory"],
  ["Sensors", "cpu · gpu · memory"],
  ["Telemetry", "collector online"],
  ["Library", "game detection"],
  ["Interface", "rendering"],
];

const HTML = `<div class="iback"></div>
<div class="iframe">
  <div class="imark"><img src="assets/stryv-wordmark.png" alt="STRYV"></div>
  <div class="itag">PUSH YOUR PERFORMANCE.</div>
  <div class="ilist" role="status" aria-live="polite"></div>
  <div class="irule"><i></i></div>
  <div class="ifoot"><span class="iv">STRYV</span><span class="ihint">Esc to skip</span></div>
  <div class="imsg"></div>
</div>
<div class="ifront"></div>`;

const reduced = () =>
  document.body.classList.contains("rm") ||
  matchMedia("(prefers-reduced-motion: reduce)").matches ||
  (Cfg && Cfg.v && Cfg.v.reduceMotion);

function msg(text, btns = []) {
  if (!st) return;
  const m = st.root.querySelector(".imsg");
  m.innerHTML = `<p>${esc(text)}</p><div class="ibtn"></div>`;
  btns.forEach(([t, f], i) => {
    const b = document.createElement("button");
    b.className = "btn" + (i ? " ghost" : "");
    b.textContent = t;
    b.onclick = f;
    m.querySelector(".ibtn").appendChild(b);
  });
  const b0 = m.querySelector("button");
  if (b0) b0.focus();
}

function finish() {
  if (!st) return;
  mark("launch screen finished");
  st.timers.forEach(clearTimeout);
  cancelAnimationFrame(st.raf);
  removeEventListener("keydown", st.onK);
  st.root.remove();
  st = null;
}

function quick() {
  if (!st) return;
  st.root.classList.add("out");
  st.timers.push(setTimeout(finish, TL.out));
}

// Walk the list one line at a time. Each line lands, then the next one starts.
function sequence(onDone) {
  const list = st.root.querySelector(".ilist");
  const rule = st.root.querySelector(".irule i");
  let i = 0;
  const step = () => {
    if (!st || st.stop) return;
    if (i >= STEPS.length) { if (onDone) onDone(); return; }
    const [name, note] = STEPS[i];
    const row = document.createElement("div");
    row.className = "irow";
    row.innerHTML = `<i class="idot"></i><b>${esc(name)}</b><small>${esc(note)}</small>`;
    list.appendChild(row);
    // force layout so the entry transition actually plays
    void row.offsetWidth;
    row.classList.add("on");
    i++;
    if (rule) rule.style.width = `${(i / STEPS.length) * 100}%`;
    st.timers.push(setTimeout(step, TL.step + (reduced() ? 0 : TL.hold)));
  };
  step();
}

// Reduced motion, or the user turned the intro off: show the finished state, leave fast.
function instant() {
  const list = st.root.querySelector(".ilist");
  list.innerHTML = STEPS.map(([name, note]) =>
    `<div class="irow on"><i class="idot"></i><b>${esc(name)}</b><small>${esc(note)}</small></div>`).join("");
  const rule = st.root.querySelector(".irule i");
  if (rule) rule.style.width = "100%";
  st.root.classList.add("ready");
  st.timers.push(setTimeout(finish, TL.end));
}

async function begin(readyFn) {
  const s = st;
  s.root.classList.remove("err");
  s.root.querySelector(".imsg").innerHTML = "";
  s.stop = false;
  s.root.querySelector(".ilist").innerHTML = "";
  const rule0 = s.root.querySelector(".irule i");
  if (rule0) rule0.style.width = "0%";

  // Decide motion up front so the boot list can play WHILE the backend starts,
  // instead of sitting blank until it answers.
  const wantMotion = s.force
    ? !matchMedia("(prefers-reduced-motion: reduce)").matches && !(Cfg && Cfg.v && Cfg.v.reduceMotion)
    : !(Cfg && Cfg.v && (Cfg.v.reduceMotion || Cfg.v.intro === false)) &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animate = wantMotion && !reduced();
  const animDone = animate ? new Promise((r) => sequence(r)) : Promise.resolve();

  const slow = setTimeout(() => {
    if (st === s) msg("Still starting…", [["Open STRYV anyway", quick]]);
  }, 8000);
  s.timers.push(slow);

  let res;
  try {
    res = await readyFn();
  } catch (e) {
    res = { ok: false, reason: String(e) };
  }
  clearTimeout(slow);
  mark("backend startup finished, ok=" + (res && res.ok));
  // Timing, readable on the Activity page: shows whether a slow launch is the page
  // starting late (scripts ran late) or the backend answering late.
  try { if (typeof Act !== "undefined" && Act.log) Act.log({ text: `Launch timing: scripts started at ${s.jsAt} ms, backend ready at ${Math.round(performance.now())} ms` }); } catch (e) { /* logging only */ }
  if (st !== s) return;

  s.root.querySelector(".imsg").innerHTML = "";

  if (!res.ok) {
    s.stop = true;
    Tech.add("startup", res.reason || "Startup failed");
    s.root.classList.add("err");
    // Say what broke. Don't dress a failure up as progress.
    const shown = STEPS.filter((_, n) => s.root.querySelectorAll(".irow").length <= n).map(([n2]) => n2);
    msg(
      "STRYV couldn't finish starting" + (shown.length ? " — stopped at " + shown[0] + "." : ".") +
      (res.reason ? " " + res.reason : ""),
      [["Retry", () => begin(readyFn)], ["Open STRYV anyway", quick]]
    );
    return;
  }

  if (!animate) return instant();
  await animDone;
  if (st !== s) return;
  s.root.classList.add("ready");
  s.timers.push(setTimeout(finish, TL.end));
}

// The window is created hidden so the launch screen is the first thing painted.
  // That means something has to reveal it, and it should happen on the very next
  // frame - otherwise the user stares at nothing while this screen sits behind an
  // invisible window. Rust keeps a long safety net for the case where this never
  // runs, but the honest reveal is here, immediately.
  function reveal() {
    try {
      const t = typeof window !== "undefined" ? window.__TAURI__ : null;
      const w = t && t.window && t.window.getCurrentWindow ? t.window.getCurrentWindow() : null;
      if (w && typeof w.show === "function") { mark("calling window.show()"); Promise.resolve(w.show()).then(() => mark("window.show() done"), () => mark("window.show() FAILED")); return true; }
    } catch (e) { /* not running under Tauri, or no window API */ }
    return false;
  }

  function run(backendFn, o = {}) {
    if (st) return;
    const root = q("#intro") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "intro" }));
    // Keep the static splash painted by index.html and fade it out over the animated one.
    const pre = root.querySelector(".ipre");
    root.className = "";
    root.style.cssText = "";
    root.innerHTML = HTML;
    document.body.appendChild(root);
    if (pre) {
      root.appendChild(pre);
      setTimeout(() => { pre.style.transition = "opacity .25s"; pre.style.opacity = "0"; setTimeout(() => pre.remove(), 300); }, 60);
    }

    st = { root, timers: [], raf: 0, force: !!o.force, jsAt: Math.round(performance.now()) };
    const v = st.root.querySelector(".iv");
    if (v && typeof VERSION !== "undefined") v.textContent = "STRYV " + VERSION;

    // Reveal on the next frame, once the first paint is genuinely on screen.
    // requestAnimationFrame can be paused while the window is still hidden, so the
    // reveal must not wait on it. Show immediately; retry briefly if the window API
    // is not attached yet.
    if (!reveal()) { let n = 0; const t = setInterval(() => { if (reveal() || ++n > 40) clearInterval(t); }, 50); }

  // Esc always gets you in. Don't trap anyone in here.
  st.onK = (e) => {
    if (e.key === "Escape" && st) {
      e.preventDefault();
      quick();
    }
  };
  addEventListener("keydown", st.onK);

  const ready = o.ready || backendFn;
  st.timers.push(setTimeout(() => begin(ready), TL.appear));
}

return { run, active: () => !!st };

})();