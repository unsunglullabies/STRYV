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
function sequence() {
  const list = st.root.querySelector(".ilist");
  const rule = st.root.querySelector(".irule i");
  let i = 0;
  const step = () => {
    if (!st) return;
    if (i >= STEPS.length) {
      st.root.classList.add("ready");
      st.timers.push(setTimeout(finish, TL.end));
      return;
    }
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
  if (st !== s) return;

  s.root.querySelector(".imsg").innerHTML = "";

  if (!res.ok) {
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

  // Motion off, or intro disabled: skip the walk, keep the reveal.
  const wantMotion = s.force
    ? !matchMedia("(prefers-reduced-motion: reduce)").matches && !(Cfg && Cfg.v && Cfg.v.reduceMotion)
    : !(Cfg && Cfg.v && (Cfg.v.reduceMotion || Cfg.v.intro === false)) &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!wantMotion || reduced()) return instant();
  sequence();
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
      if (w && typeof w.show === "function") { Promise.resolve(w.show()).catch(() => {}); return true; }
    } catch (e) { /* not running under Tauri, or no window API */ }
    return false;
  }

  function run(backendFn, o = {}) {
    if (st) return;
    const root = q("#intro") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "intro" }));
    root.className = "";
    root.style.cssText = "";
    root.innerHTML = HTML;
    document.body.appendChild(root);

    st = { root, timers: [], raf: 0, force: !!o.force };
    const v = st.root.querySelector(".iv");
    if (v && typeof VERSION !== "undefined") v.textContent = "STRYV " + VERSION;

    // Reveal on the next frame, once the first paint is genuinely on screen.
    requestAnimationFrame(() => { if (!reveal()) setTimeout(reveal, 60); });

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