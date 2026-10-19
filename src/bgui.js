"use strict";
// Background mode and alerts (the rules run in the Rust side, so they keep working when the
// window is closed), plus glass strength controls. Adds its own Settings controls, so it does not
// depend on edits to the rest of the markup.
const BgUI = (() => {
  const $ = (id) => document.getElementById(id);
  const call = (cmd, args) => { try { return Promise.resolve(window.__TAURI__.core.invoke(cmd, args)); } catch (e) { return Promise.reject(e); } };
  const secs = (v) => v < 60 ? v + " seconds" : v === 60 ? "1 minute" : v / 60 + " minutes";
  const mins = (v) => v < 60 ? v + " minutes" : v === 60 ? "1 hour" : v / 60 + " hours";
  const OPT = {
    cpu_pct: [[80, 85, 90, 95], (v) => v + "%"], cpu_secs: [[30, 60, 120, 300], secs],
    mem_pct: [[85, 90, 92, 95], (v) => v + "%"], mem_secs: [[30, 60, 120, 300], secs],
    disk_free_pct: [[5, 8, 10, 15], (v) => v + "% free"], temp_c: [[80, 85, 90, 95], (v) => v + " \u00B0C"],
    cooldown_mins: [[5, 15, 60, 240], mins],
  };
  let cfg = null, saveT = 0;

  // ---------------------------------------------------------------- alerts card
  const rule = (k, title, desc, ctl) => `<div class="set"><div><b>${title}</b><small>${desc}</small></div><div class="bgctl"><button class="tog" type="button" data-k="${k}" aria-label="${title}" aria-pressed="false"></button>${ctl}</div></div>`;
  const sel = (k) => `<select data-k="${k}" aria-label="${k}"></select>`;
  function card() {
    const settings = $("settings"); if (!settings || $("bgSec")) return;
    const sec = document.createElement("div"); sec.className = "sec"; sec.id = "bgSec";
    sec.innerHTML = `<h3>Background and alerts</h3>
<div class="set"><div><b>Keep STRYV running in the background</b><small>Closing the window hides STRYV to the system tray so it keeps watching your PC. Right-click the tray icon to quit.</small></div><button class="tog" type="button" data-k="background" aria-label="Keep STRYV running in the background" aria-pressed="false"></button></div>
<div class="set"><div><b>Notify me when something looks wrong</b><small>Sends a Windows notification, even when the window is closed. Alerts say what was measured, never a guess.</small></div><button class="tog" type="button" data-k="enabled" aria-label="Notify me when something looks wrong" aria-pressed="false"></button></div>
${rule("cpu", "CPU stays busy", "Names the program using the most CPU.", "<span>above</span>" + sel("cpu_pct") + "<span>for</span>" + sel("cpu_secs"))}
${rule("mem", "Memory runs low", "Names the program using the most memory.", "<span>above</span>" + sel("mem_pct") + "<span>for</span>" + sel("mem_secs"))}
${rule("disk", "A drive is nearly full", "Checks fixed drives of 8 GB or more.", "<span>below</span>" + sel("disk_free_pct"))}
${rule("temp", "Something runs hot", "Uses the sensors STRYV can read on this PC.", "<span>at</span>" + sel("temp_c"))}
<div class="set"><div><b>Don\u2019t repeat the same alert for</b><small>If the problem is still there afterwards, you are told once more.</small></div>${sel("cooldown_mins")}</div>
<div class="set"><div><b>Try it</b><small>Sends a test notification right now.</small></div><button class="btn ghost" type="button" id="bgTest">Send test</button></div>
<div class="bgfeed"><div class="bgfh"><b>Recent alerts</b><button class="btn ghost" type="button" id="bgClr">Clear</button></div><div id="bgList"><p class="tk-empty">No alerts yet.</p></div></div>`;
    settings.appendChild(sec);

    Object.keys(OPT).forEach((k) => {
      const s = sec.querySelector(`select[data-k="${k}"]`); if (!s) return;
      s.onchange = () => { cfg[k] = Number(s.value); queueSave(); };
    });
    sec.querySelectorAll("button.tog[data-k]").forEach((b) => b.onclick = () => { const k = b.dataset.k; cfg[k] = !cfg[k]; b.setAttribute("aria-pressed", String(cfg[k])); queueSave(); });
    $("bgTest").onclick = () => call("alerts_test").then(() => toast("Test notification sent.")).catch((e) => toast(String(e && e.message || e), true));
    $("bgClr").onclick = () => call("alerts_clear").then(() => feed([])).catch(() => {});
    return sec;
  }
  function paintCfg() {
    const sec = $("bgSec"); if (!sec || !cfg) return;
    sec.querySelectorAll("button.tog[data-k]").forEach((b) => b.setAttribute("aria-pressed", String(!!cfg[b.dataset.k])));
    Object.entries(OPT).forEach(([k, [vals, fmt]]) => {
      const s = sec.querySelector(`select[data-k="${k}"]`); if (!s) return;
      const all = vals.includes(cfg[k]) ? vals : [...vals, cfg[k]].sort((a, b) => a - b);
      s.innerHTML = all.map((v) => `<option value="${v}">${fmt(v)}</option>`).join(""); s.value = String(cfg[k]);
    });
  }
  function queueSave() { clearTimeout(saveT); saveT = setTimeout(() => call("alerts_set", { cfg }).catch((e) => toast("Couldn\u2019t save: " + String(e && e.message || e), true)), 250); }

  function feed(list) {
    const box = $("bgList"); if (!box) return;
    box.innerHTML = list.length ? list.slice(0, 20).map((a) => {
      const t = new Date(a.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return `<div class="bgf"><i class="k k-${esc(a.kind)}"></i><div><b>${esc(a.title)}</b><small>${esc(a.body)} \u00B7 ${t}</small></div></div>`;
    }).join("") : '<p class="tk-empty">No alerts yet.</p>';
  }
  function init() {
    const sec = card(); if (!sec) return;
    call("alerts_get").then((c) => { cfg = c; paintCfg(); return call("alerts_recent"); }).then(feed).catch(() => {
      sec.querySelector("h3").insertAdjacentHTML("afterend", '<p class="tk-empty">Background alerts need the STRYV desktop app.</p>');
      sec.querySelectorAll("button,select").forEach((x) => { x.disabled = true; });
    });
    try {
      window.__TAURI__.event.listen("stryv-alert", (e) => {
        const a = e.payload; if (!a) return;
        toast(a.title + ". " + a.body, a.kind !== "test");
        call("alerts_recent").then(feed).catch(() => {});
      });
    } catch (e) { /* no event bridge outside the desktop app */ }
  }

  // ---------------------------------------------------------------- glass strength
  const KEY = "stryv.gfx";
  const G = (() => { try { return Object.assign({ blur: 22, tint: 100, lite: false }, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) { return { blur: 22, tint: 100, lite: false }; } })();
  function applyGlass() {
    const r = document.documentElement;
    r.style.setProperty("--blur", G.blur + "px"); r.style.setProperty("--tint", String(G.tint / 100));
    r.classList.toggle("lite", !!G.lite);
    try { localStorage.setItem(KEY, JSON.stringify(G)); } catch (e) { /* not fatal */ }
  }
  function glassRows() {
    const anchor = $("gfx") && $("gfx").closest(".set"); if (!anchor || $("gBlur")) return;
    const row = (title, desc, ctl) => `<div class="set"><div><b>${title}</b><small>${desc}</small></div>${ctl}</div>`;
    anchor.insertAdjacentHTML("afterend",
      row("Glass blur", "How frosted the panels look.", '<div class="bgctl"><input type="range" id="gBlur" min="0" max="40" step="2" aria-label="Glass blur"><span id="gBlurV"></span></div>') +
      row("Glass brightness", "How light the glass panels are.", '<div class="bgctl"><input type="range" id="gTint" min="40" max="160" step="5" aria-label="Glass brightness"><span id="gTintV"></span></div>') +
      row("Reduce effects", "Turns off blur, grain and entrance motion. Helps on older PCs.", '<button class="tog" type="button" id="gLite" aria-label="Reduce effects" aria-pressed="false"></button>'));
    const sync = () => { $("gBlur").value = G.blur; $("gTint").value = G.tint; $("gBlurV").textContent = G.blur + " px"; $("gTintV").textContent = G.tint + "%"; $("gLite").setAttribute("aria-pressed", String(!!G.lite)); };
    $("gBlur").oninput = (e) => { G.blur = +e.target.value; applyGlass(); sync(); };
    $("gTint").oninput = (e) => { G.tint = +e.target.value; applyGlass(); sync(); };
    $("gLite").onclick = () => { G.lite = !G.lite; applyGlass(); sync(); };
    sync();
  }

  applyGlass(); glassRows(); init();
  return {};
})();
